/** 只处理命令行显式指定的JSON，不扫描应用或会话目录。 */
import {readFileSync,statSync} from 'node:fs';
import {recordsFromSession,aggregate,parseQuota} from './tracker.mjs';
try {
  if(process.argv.length!==3)throw Error('用法: node cli.mjs example.json');
  if(statSync(process.argv[2]).size>5000000)throw Error('输入超过5MB预算');
  const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
  if(!Array.isArray(input.events))throw Error('events须为事件数组');
  const records=recordsFromSession(input.events.map(event=>JSON.stringify(event)).join('\n'),input);
  const result={records,summary:aggregate(records,input),notice:'仅本地记录投影与显式报价估算，不代表平台账单或实时额度。'};
  if(input.quota)result.quota=parseQuota(input.quota,{observedAt:input.quotaObservedAt,now:input.now,maxAgeMs:input.maxAgeMs});
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error(JSON.stringify({error:error instanceof SyntaxError?'输入JSON无效':error.message}));process.exitCode=2}
