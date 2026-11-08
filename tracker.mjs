/** 显式会话事件重放与用量统计；移植通用算法，所有文件/报价/时区由调用方给出。 */
import {createHash} from 'node:crypto';
const forbidden = new Set(['__proto__','prototype','constructor']);
const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0,20);
const own = (object, key) => Object.hasOwn(object ?? {}, key);
const DAY = 86400000;
function stamp(value) {
  if(typeof value==='string') {
    const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if(!match)throw Error('时间须为epoch毫秒或带时区的完整ISO时间');
    const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number);
    const leap=year%4===0&&(year%100!==0||year%400===0);
    const limits=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
    if(month<1||month>12||day<1||day>limits[month-1]||hour>23||minute>59||second>59||Number(match[10]??0)>14||Number(match[11]??0)>59||(Number(match[10])===14&&Number(match[11])!==0))throw Error('日历日期或时区偏移无效');
  }else if(typeof value!=='number')throw Error('时间类型无效');
  const number = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(number) || Math.abs(number)>8640000000000000) throw Error('时间无效');
  return number;
}
function counter(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw Error('计数必须是非负安全整数');
    return value;
  }
  return null;
}
function sumKnown(values) {
  const value=values.reduce((sum,n)=>sum+(n??0),0);
  if (!Number.isSafeInteger(value)) throw Error('汇总超出安全整数范围');
  return value;
}
function normalizeModelKey(value) {
  return typeof value === 'string' ? value.split('/').at(-1).trim().toLowerCase().replaceAll('_','-') : 'unknown';
}
function applyUpdate(state, keys, value) {
  if (!keys.length || keys.length>32 || keys.some(k=>forbidden.has(k)||!(typeof k==='string'||Number.isSafeInteger(k)))) throw Error('更新路径无效');
  if (keys.length===1 && keys[0]==='requests' && Array.isArray(value)) {
    if (!Array.isArray(state.requests)) state.requests=[];
    if (state.requests.length+value.length>10000) throw Error('请求数超出预算');
    state.requests.push(...value);return;
  }
  let current=state;
  for(let index=0; index<keys.length; index++) {
    const key=keys[index];
    if (Array.isArray(current) && (!Number.isInteger(key)||key<0||key>=10000)) throw Error('数组位置无效');
    if (index===keys.length-1) {current[key]=value;return}
    if (!own(current,key)||current[key]===null) current[key]=typeof keys[index+1]==='number'?[]:{};
    if (typeof current[key]!=='object') throw Error('更新路径容器无效');
    current=current[key];
  }
}
export function replaySession(content) {
  if (typeof content!=='string'||Buffer.byteLength(content)>5000000) throw Error('事件输入超过5MB预算');
  let state={requests:[]};const lines=content.split('\n');
  if(lines.length>20000)throw Error('事件数超出预算');
  for (const [index,line] of lines.entries()) {
    if (!line.trim()) continue;
    let event;try{event=JSON.parse(line)}catch{throw Error(`第${index+1}行不是有效JSON`)}
    if (event.kind===0) {
      if (!event.v||typeof event.v!=='object'||Array.isArray(event.v)) throw Error('初始状态无效');
      state={...event.v};if(!own(state,'requests'))state.requests=[];
    } else if ((event.kind===1||event.kind===2)&&Array.isArray(event.k)) applyUpdate(state,event.k,event.v);
    else throw Error('不支持的事件类型');
    if(!Array.isArray(state.requests))throw Error('requests须为数组');
    if (state.requests.length>10000) throw Error('请求数超出预算');
  }
  return state;
}
export function recordsFromSession(content, {reasoningMode, rates={}, multipliers={}}={}) {
  if(!['included','additional'].includes(reasoningMode))throw Error('须显式指定推理计数included或additional');
  const state=replaySession(content), records=new Map();
  const sessionId=digest(state.sessionId??'explicit-input');
  for(const [index,request] of state.requests.entries()) {
    if(!request||typeof request!=='object'||Array.isArray(request))throw Error('请求记录无效');
    if(request.timestamp===undefined)throw Error('请求缺少时间');
    const timestamp=stamp(request.timestamp),md=request.result?.metadata??{},usage=md.usage??request.usage??{};
    const inputTokens=counter(md.promptTokens,md.inputTokens,md.prompt_tokens,md.input_tokens,usage.promptTokens,usage.inputTokens,usage.prompt_tokens,usage.input_tokens,request.promptTokens,request.inputTokens);
    const outputTokens=counter(md.outputTokens,md.completionTokens,md.completion_tokens,md.output_tokens,usage.outputTokens,usage.completionTokens,usage.completion_tokens,usage.output_tokens,request.outputTokens,request.completionTokens);
    let reasoningTokens=counter(md.reasoningTokens,md.thinkingTokens,md.reasoning_tokens,md.thinking_tokens,usage.reasoningTokens,usage.thinkingTokens,usage.reasoning_tokens,usage.thinking_tokens,request.reasoningTokens,request.thinkingTokens);
    if(reasoningTokens===null&&Array.isArray(md.toolCallRounds)) {
      const values=md.toolCallRounds.map(round=>counter(round?.thinking?.tokens));
      reasoningTokens=values.some(v=>v===null)?null:sumKnown(values);
    }
    if(reasoningMode==='included'&&outputTokens!==null&&reasoningTokens!==null&&reasoningTokens>outputTokens)throw Error('包含口径下推理计数不能超过输出计数');
    const quantities=[inputTokens,outputTokens,...(reasoningMode==='additional'?[reasoningTokens]:[])];
    const totalTokens=quantities.some(v=>v===null)?null:sumKnown(quantities);
    const rawModel=normalizeModelKey(request.modelId??state.inputState?.selectedModel?.identifier),model=`model-${digest(rawModel)}`;
    const multiplier=own(multipliers,rawModel)?multipliers[rawModel]:null;
    if(multiplier!==null&&(!Number.isFinite(multiplier)||multiplier<0))throw Error('显式权重无效');
    const weightedTokens=multiplier===null||totalTokens===null?null:Math.ceil(totalTokens*multiplier);
    if(weightedTokens!==null&&!Number.isSafeInteger(weightedTokens))throw Error('加权计数超出范围');
    let estimatedCost=null;
    const price=own(rates,rawModel)?rates[rawModel]:null;
    if(price) {
      if(!Number.isFinite(price.input)||!Number.isFinite(price.output)||price.input<0||price.output<0)throw Error('显式报价无效');
      if(totalTokens!==null)estimatedCost=(inputTokens*price.input+(outputTokens+(reasoningMode==='additional'?reasoningTokens:0))*price.output)/1000000;
      if(estimatedCost!==null&&!Number.isFinite(estimatedCost))throw Error('估算超出数值范围');
    }
    const explicitId=request.requestId??request.id;
    const id=digest(JSON.stringify([sessionId,explicitId===undefined?'index':'explicit',explicitId??index]));
    const record={id,sessionId,model,timestamp,inputTokens,outputTokens,reasoningTokens,totalTokens,weightedTokens,estimatedCost};
    if(records.has(id)&&JSON.stringify(records.get(id))!==JSON.stringify(record))throw Error('同一请求标识出现冲突用量');
    records.set(id,record);
  }
  return [...records.values()];
}
function summarize(records) {
  const result={turnCount:records.length,sessionCount:new Set(records.map(r=>r.sessionId)).size,modelBreakdown:{}};
  for(const field of ['inputTokens','outputTokens','reasoningTokens','totalTokens','weightedTokens','estimatedCost']) {
    const values=records.map(record=>record[field]);
    const known=field==='estimatedCost'?values.reduce((sum,v)=>sum+(v??0),0):sumKnown(values);
    if(!Number.isFinite(known))throw Error('金额汇总超出范围');
    result[field]={known,missing:values.filter(v=>v===null).length};
  }
  for(const record of records) {
    const bucket=result.modelBreakdown[record.model]??={turns:0,knownTokens:0,missingTokens:0};
    bucket.turns++;bucket.knownTokens=sumKnown([bucket.knownTokens,record.totalTokens]);bucket.missingTokens+=record.totalTokens===null?1:0;
  }
  return result;
}
export function aggregate(records,{now,offsetMinutes=0,days=7}={}) {
  if(!Number.isInteger(offsetMinutes)||Math.abs(offsetMinutes)>840||!Number.isInteger(days)||days<1||days>3660)throw Error('日历参数无效');
  const offset=offsetMinutes*60000,instant=stamp(now),today=Math.floor((instant+offset)/DAY),date=new Date(instant+offset);
  const dayIndex=record=>Math.floor((record.timestamp+offset)/DAY);
  const range=(start,end)=>summarize(records.filter(record=>record.timestamp<=instant&&dayIndex(record)>=start&&dayIndex(record)<=end));
  const weekday=((today+4)%7+7)%7,monday=today-(weekday===0?6:weekday-1);
  const boundary=month=>{const start=new Date(0);start.setUTCFullYear(date.getUTCFullYear(),month,1);start.setUTCHours(0,0,0,0);return Math.floor(start.getTime()/DAY)};
  const monthStart=boundary(date.getUTCMonth()),yearStart=boundary(0);
  return {all:summarize(records.filter(record=>record.timestamp<=instant)),today:range(today,today),week:range(monday,today),month:range(monthStart,today),year:range(yearStart,today),
    futureRecords:records.filter(record=>record.timestamp>instant).length,offsetMinutes,
    daily:Array.from({length:days},(_,i)=>{const index=today-days+1+i;return {date:new Date(index*DAY).toISOString().slice(0,10),...range(index,index)}})};
}
export function parseQuota(data,{observedAt,now,maxAgeMs=300000}={}) {
  const observed=stamp(observedAt),instant=stamp(now),snapshot=data?.quota_snapshots?.premium_interactions;
  if(!snapshot||data.quota_reset_date===undefined||data.quota_reset_date===null)throw Error('额度快照缺少必要字段');
  if(!Number.isFinite(maxAgeMs)||maxAgeMs<0)throw Error('新鲜度预算无效');
  const remaining=snapshot.percent_remaining;
  if(typeof remaining!=='number'||!Number.isFinite(remaining)||remaining<0||remaining>100)throw Error('额度百分比无效');
  const reset=stamp(data.quota_reset_date);
  return {percentRemaining:remaining,percentUsed:100-remaining,entitlement:counter(snapshot.entitlement),overageUsed:counter(snapshot.overage_count),
    overagePermitted:typeof snapshot.overage_permitted==='boolean'?snapshot.overage_permitted:null,unlimited:typeof snapshot.unlimited==='boolean'?snapshot.unlimited:null,
    resetDate:new Date(reset).toISOString(),observedAt:new Date(observed).toISOString(),state:observed>instant?'future_observation':instant-observed>maxAgeMs?'stale':'fresh'};
}
