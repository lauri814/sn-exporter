import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=ts.transpileModule(readFileSync('src/servicenow/page/history.ts','utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
const userId='a'.repeat(32), sysId='b'.repeat(32),queries=[],displayFields=[],calls=[];let pollAvailable=true;
class GlideRecord {
  constructor(table) {assert.ok(['sys_poll','sys_attachment'].includes(table));this.table=table;this.index=-1;this.conditions=[];}
  setDisplayFields(fields) {displayFields.push({table:this.table,fields:Array.from(fields)});}
  addQuery(...args) {queries.push(args);this.conditions.push(args);}
  query(callback) {calls.push({table:this.table,conditions:this.conditions});queueMicrotask(()=>callback(this));}
  next() {
    if(++this.index>0 || (this.table==='sys_poll' && !pollAvailable))return false;
    const id = sysId;
    if (this.conditions.some(([field,operator,value]) => ['sys_id','job_id'].includes(field) &&
      ((operator==='IN' && !value.split(',').includes(field==='job_id'?'c'.repeat(32):id)) || (operator==='NOT IN' && value.split(',').includes(field==='job_id'?'c'.repeat(32):id))))) return false;
    if(this.table==='sys_attachment'){Object.assign(this,{sys_id:'d'.repeat(32),table_sys_id:sysId,file_name:'export.csv',content_type:'text/csv'});return true;}
    Object.assign(this,{sys_id:sysId,job_id:'c'.repeat(32),state:'complete',current:'7036',max:'7036',message:'',sys_created_on:'2026-10-14 23:09:14',sys_updated_on:'2026-10-14 23:09:32'});
    return true;
  }
}
const context={exports:{},window:{GlideRecord,g_user:{userID:userId}},setTimeout,clearTimeout};
vm.runInNewContext(source,context);
const result=await context.exports.pagePollHistory();
assert.equal(result.userId,userId);assert.equal(result.records[0].sysId,sysId);assert.equal(result.records[0].current,7036);
assert.equal(result.attachments[0].pollId,sysId);
assert.deepEqual(displayFields,[{table:'sys_poll',fields:['sys_id','job_id','state','current','max','message','sys_created_on','sys_updated_on']},{table:'sys_attachment',fields:['sys_id','table_sys_id','file_name','content_type']}], 'Request only the fields consumed by history');
assert.deepEqual(queries,[['sys_created_on','RELATIVEGT','@hour@ago@24'],['session_user',userId],['table_name','sys_poll'],['table_sys_id','IN',sysId]],'Only current-user records from the last 24 hours');
const cached = [{...result,knownJobIds:['c'.repeat(32)],hiddenPollIds:[]}];
calls.length=0;
const unchanged = await context.exports.pagePollHistory(cached);
assert.equal(unchanged.attachments.length,1,'Unchanged jobs retain cached metadata');
assert.deepEqual(calls.map(call=>call.table),['sys_poll','sys_poll'],'Unchanged cached jobs do not query attachments');
assert.ok(calls[0].conditions.some(([field,op])=>field==='job_id' && op==='IN'),'Cached jobs queried first');
assert.ok(calls[1].conditions.some(([field,op])=>field==='job_id' && op==='NOT IN'),'Other exports queried after cached jobs');
calls.length=0;
const changedCache=structuredClone(cached);changedCache[0].records[0].updatedOn='old timestamp';
await context.exports.pagePollHistory(changedCache);
assert.deepEqual(calls.map(call=>call.table),['sys_poll','sys_poll','sys_attachment'],'Changed poll fetches matching attachment metadata');
assert.ok(calls[2].conditions.some(([field,op,value])=>field==='table_sys_id' && op==='IN' && value===sysId),'Attachment delta is constrained to changed poll IDs');
calls.length=0;
const hiddenCache=structuredClone(cached);hiddenCache[0].hiddenPollIds=[sysId];hiddenCache[0].knownJobIds=[];
const excluded = await context.exports.pagePollHistory(hiddenCache);
assert.equal(excluded.records.length,0);assert.equal(excluded.attachments.length,0);
assert.deepEqual(calls.map(call=>call.table),['sys_poll'],'Excluded jobs never cause cached poll or attachment queries');
calls.length=0;
const missingFiles=structuredClone(cached);missingFiles[0].attachments=[];
await context.exports.pagePollHistory(missingFiles);
assert.equal(calls.at(-1).table,'sys_attachment','Missing attachments are retried even if poll did not change');
const foreignCache=structuredClone(cached);foreignCache[0].userId='f'.repeat(32);
calls.length=0;await context.exports.pagePollHistory(foreignCache);
assert.equal(calls.at(-1).table,'sys_attachment','Another user cache is not reused');
calls.length=0;
await context.exports.pagePollHistory([{userId,records:[],attachments:[],knownJobIds:['e'.repeat(32)],hiddenPollIds:[]}]);
assert.deepEqual(calls.map(call=>call.table),['sys_poll','sys_poll','sys_attachment'],'Uncached exports are discovered after cached jobs');
pollAvailable=false;calls.length=0;
const deleted = await context.exports.pagePollHistory(cached);
assert.equal(deleted.records.length,0);assert.equal(deleted.attachments.length,0,'Deleted polls discard cached attachments');
assert.ok(!calls.some(call=>call.table==='sys_attachment'),'Deleted polls never cause attachment queries');
pollAvailable=true;
const topContext={exports:{},window:{top:{gsft_main:{GlideRecord,g_user:{userID:userId}}}},setTimeout,clearTimeout};
vm.runInNewContext(source,topContext);assert.equal((await topContext.exports.pagePollHistory()).records.length,1,'Use gsft_main context');
const unavailable={exports:{},window:{},setTimeout,clearTimeout};vm.runInNewContext(source,unavailable);
await assert.rejects(unavailable.exports.pagePollHistory(),/client GlideRecord/);
console.log('History query checks passed: client GlideRecord, gsft_main fallback, current-user scope, 24-hour filter, and missing session');

calls.length=0;
const hiddenJobCache=structuredClone(cached);hiddenJobCache[0].hiddenJobIds=['c'.repeat(32)];
const hiddenByJob=await context.exports.pagePollHistory(hiddenJobCache);
assert.equal(hiddenByJob.records.length,0,'Cancelled job IDs are excluded before attachment lookups');
assert.ok(!calls.some(call=>call.table==='sys_attachment'));
assert.ok(calls[0].conditions.some(([field,op,value])=>field==='job_id' && op==='NOT IN' && value==='c'.repeat(32)));
