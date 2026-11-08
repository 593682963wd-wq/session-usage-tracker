import test from 'node:test';
import assert from 'node:assert/strict';
import {recordsFromSession,aggregate,parseQuota} from '../tracker.mjs';
const request=more=>({timestamp:0,modelId:'m',result:{metadata:{promptTokens:1,outputTokens:1}},...more});
const content=requests=>JSON.stringify({kind:0,v:{sessionId:'s',requests}});
test('fallback index cannot collide with explicit request identifier',()=>{
 const rows=recordsFromSession(content([request({id:'index-1'}),request({})]),{reasoningMode:'included'});
 assert.equal(rows.length,2);assert.notEqual(rows[0].id,rows[1].id);
});
test('years below one hundred retain month and year buckets',()=>{
 const rows=recordsFromSession(content([request({id:'x',timestamp:'0099-01-01T12:00:00Z'})]),{reasoningMode:'included'});
 const result=aggregate(rows,{now:'0099-01-01T13:00:00Z'});
 assert.equal(result.today.turnCount,1);assert.equal(result.month.turnCount,1);assert.equal(result.year.turnCount,1);
});
test('epoch zero is a valid explicit reset time',()=>{
 assert.equal(parseQuota({quota_snapshots:{premium_interactions:{percent_remaining:40}},quota_reset_date:0},{observedAt:0,now:1}).resetDate,'1970-01-01T00:00:00.000Z');
});
