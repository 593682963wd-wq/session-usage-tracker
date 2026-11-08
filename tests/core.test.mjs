import test from 'node:test';
import assert from 'node:assert/strict';
import {recordsFromSession,replaySession,aggregate,parseQuota} from '../tracker.mjs';
const request=(more={})=>({id:'synthetic',timestamp:Date.parse('2030-01-01T20:00:00Z'),modelId:'synthetic-model',result:{metadata:{promptTokens:100,outputTokens:50,reasoningTokens:10}},...more});
const content=(requests)=>JSON.stringify({kind:0,v:{sessionId:'synthetic-session',requests}});
const opts={reasoningMode:'included'};
test('snapshot and append preserve usage fields',()=>{
 const text=content([])+'\n'+JSON.stringify({kind:2,k:['requests'],v:[request()]});
 assert.equal(replaySession(text).requests.length,1);
 const record=recordsFromSession(text,{...opts,rates:{'synthetic-model':{input:1,output:2}}})[0];
 assert.equal(record.totalTokens,150);assert.equal(record.estimatedCost,0.0002);assert.equal(record.weightedTokens,null);
 assert.equal(recordsFromSession(text,{reasoningMode:'additional'})[0].totalTokens,160);
});
test('zero and missing remain distinct',()=>{
 const zero=recordsFromSession(content([request({result:{metadata:{promptTokens:0,outputTokens:0}}})]),opts)[0];
 assert.equal(zero.totalTokens,0);assert.equal(zero.reasoningTokens,null);
 const missing=recordsFromSession(content([request({result:{metadata:{outputTokens:4}}})]),opts)[0];
 assert.equal(missing.totalTokens,null);assert.equal(missing.estimatedCost,null);
 assert.equal(aggregate([missing],{now:'2030-01-02T00:00:00Z'}).all.totalTokens.missing,1);
});
test('unsafe counters and ambiguous reasoning reject',()=>{
 assert.throws(()=>recordsFromSession(content([request()]),{}));
 assert.throws(()=>recordsFromSession(content([request({result:{metadata:{promptTokens:-1}}})]),opts));
 assert.throws(()=>recordsFromSession(content([request({result:{metadata:{promptTokens:1,outputTokens:1,reasoningTokens:2}}})]),opts));
 assert.throws(()=>recordsFromSession(content([request({result:{metadata:{promptTokens:Number.MAX_SAFE_INTEGER,outputTokens:1}}})]),opts));
});
test('prototype mutation and huge array indices reject',()=>{
 for(const k of [['__proto__','probe'],['requests',1000000000,'x'],['constructor','prototype','probe']]){
  assert.throws(()=>replaySession(content([])+'\n'+JSON.stringify({kind:1,k,v:1})));
 }
 assert.equal({}.probe,undefined);
});
test('dedup and conflicting identities',()=>{
 assert.equal(recordsFromSession(content([request(),request()]),opts).length,1);
 assert.throws(()=>recordsFromSession(content([request(),request({timestamp:1})]),opts));
});
test('raw identities and content excluded',()=>{
 const raw='SYNTHETIC_PRIVATE_MARKER';
 const text=JSON.stringify({kind:0,v:{sessionId:raw,requests:[request({id:raw,modelId:raw,prompt:raw,response:raw})]}});
 assert.ok(!JSON.stringify(recordsFromSession(text,opts)).includes(raw));
});
test('fixed offset controls every bucket',()=>{
 const rows=recordsFromSession(content([request()]),opts);
 assert.equal(aggregate(rows,{now:'2030-01-02T01:00:00Z',offsetMinutes:480}).today.turnCount,1);
 assert.equal(aggregate(rows,{now:'2030-01-02T01:00:00Z',offsetMinutes:0}).today.turnCount,0);
 assert.equal(aggregate(rows,{now:'2029-01-01T00:00:00Z'}).futureRecords,1);
});
test('explicit quota and freshness',()=>{
 const data={quota_snapshots:{premium_interactions:{percent_remaining:40}},quota_reset_date:'2030-02-01T00:00:00Z'};
 const quota=parseQuota(data,{observedAt:'2030-01-01T00:00:00Z',now:'2030-01-01T01:00:00Z'});
 assert.equal(quota.percentUsed,60);assert.equal(quota.entitlement,null);assert.equal(quota.state,'stale');
 assert.equal(parseQuota(data,{observedAt:'2030-01-02T00:00:00Z',now:'2030-01-01T00:00:00Z'}).state,'future_observation');
 assert.throws(()=>parseQuota({},{}));
});
test('strict time and explicit array contracts',()=>{
 for(const timestamp of ['1','2030-02-30T00:00:00Z','2030-01-02T00:30:00','2030-01-02T25:00:00Z','2030-01-02T00:30:00+14:01']) {
  assert.throws(()=>recordsFromSession(content([request({timestamp})]),opts));
 }
 const rows=recordsFromSession(content([request({timestamp:'2030-01-02T00:30:00+08:00'})]),opts);
 assert.equal(rows[0].timestamp,Date.parse('2030-01-01T16:30:00Z'));
 for(const value of [null,{},'invalid']) {
  assert.throws(()=>replaySession(JSON.stringify({kind:0,v:{requests:value}})));
  assert.throws(()=>replaySession(content([])+'\n'+JSON.stringify({kind:1,k:['requests'],v:value})));
 }
 assert.deepEqual(replaySession(JSON.stringify({kind:0,v:{}})).requests,[]);
});
