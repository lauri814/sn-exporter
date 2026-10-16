import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const store={};let now=1_000_000_000;
class Clock extends Date {static now(){return now;}}
const scope={exports:{},Date:Clock,structuredClone,chrome:{storage:{local:{get:async()=>structuredClone(store),set:async values=>Object.assign(store,structuredClone(values))}}}};
vm.runInNewContext(ts.transpileModule(readFileSync('src/history/store.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,scope);
const {HistoryStore}=scope.exports;
const run={id:'batch',origin:'https://example.service-now.com',userId:'a'.repeat(32),createdAt:now-1000,settings:{table:'incident',fileType:'csv',query:'active=true'},jobs:[{id:1,jobId:'b'.repeat(32)},{id:2}]};
const history={userId:run.userId,records:[{sysId:'2'.repeat(32),jobId:'b'.repeat(32)}],attachments:[]};
await new HistoryStore().record(run);
store['sn-export-history-v1'][0].jobs = [{number:1,pollId:run.jobs[0].jobId}]; // Old releases mislabeled the init job_id.

let view=await new HistoryStore().reconcile(run.origin,history,now);
assert.equal(view.batches.length,1,'Batch mapping survives worker/browser recreation');
assert.equal(view.batches[0].jobs[0].jobId,run.jobs[0].jobId,'Legacy pollId mappings migrate as init job IDs');
let queryCache=await new HistoryStore().queryCache(run.origin);
assert.equal(queryCache[0].records.length,1,'Poll metadata cache survives worker recreation');
assert.equal(queryCache[0].knownJobIds[0],history.records[0].jobId);
assert.equal((await new HistoryStore().queryCache('https://unrelated.service-now.com')).length,0,'Query cache is instance scoped');
assert.equal(view.batches[0].plannedJobs,2);assert.equal(view.batches[0].jobs.length,1,'Only received poll IDs are linked');
assert.equal((await new HistoryStore().reconcile('https://other.service-now.com',history,now)).batches.length,0,'Instance isolation');
assert.equal((await new HistoryStore().reconcile(run.origin,{...history,userId:'c'.repeat(32)},now)).batches.length,0,'User isolation');
view=await new HistoryStore().reconcile(run.origin,{...history,records:[]},now);
assert.equal(view.batches.length,0,'Successful empty refresh removes deleted batches');
const sameWorker=new HistoryStore();
await sameWorker.record(run);
await sameWorker.reconcile(run.origin,{...history,records:[]},now);
await sameWorker.record(run);
assert.equal((await sameWorker.reconcile(run.origin,history,now)).batches.length,1,'Pruning invalidates the already-saved fingerprint');
store['sn-export-history-v1']=[];
await sameWorker.record(run,{force:true});
assert.equal((await sameWorker.reconcile(run.origin,history,now)).batches.length,1,'Forced repair recreates a mapping even after external storage removal');
// Explicit removal must survive forced repair, worker recreation, and future refreshes.
const otherPoll = 'd'.repeat(32);
const withOther = { ...history, records: [...history.records, { sysId: otherPoll }],
  attachments: [{ sysId: 'e'.repeat(32), pollId: otherPoll }] };
view = await sameWorker.reconcile(run.origin, withOther, now);
await sameWorker.remove(view, { batchId: run.id });
await sameWorker.record(run, { force: true });
view = await new HistoryStore().reconcile(run.origin, withOther, now);
assert.equal(view.batches.length, 0, 'Removed batch cannot be restored by live snapshot repair');
assert.equal(view.records.length, 1, 'Removed batch jobs do not become other exports');
queryCache=await new HistoryStore().queryCache(run.origin);
assert.ok(queryCache[0].hiddenPollIds.includes(history.records[0].sysId),'Exclusions are supplied before native queries');
assert.ok(!queryCache[0].knownJobIds.includes(history.records[0].jobId),'Excluded jobs are omitted from cached poll queries');
assert.ok(!queryCache[0].records.some(record=>record.sysId===history.records[0].sysId),'Removal purges cached poll metadata');

assert.equal(view.records[0].sysId, otherPoll);
assert.equal((await new HistoryStore().reconcile('https://other.service-now.com', withOther, now)).records.length, 2, 'Exclusions are instance scoped');
assert.equal((await new HistoryStore().reconcile(run.origin, {...withOther,userId:'f'.repeat(32)}, now)).records.length, 2, 'Exclusions are user scoped');
await new HistoryStore().remove(view, { pollId: otherPoll });
view = await new HistoryStore().reconcile(run.origin, withOther, now);
assert.equal(view.records.length, 0, 'Individual other export stays hidden');
assert.equal(view.attachments.length, 0, 'Hidden exports omit attachment metadata');
now += 24*60*60*1000+1;
view = await new HistoryStore().reconcile(run.origin, withOther, now);
assert.equal(view.records.length, 2, 'Local exclusions expire after 24 hours');
await new HistoryStore().remove(view, { all: true });
assert.equal((await new HistoryStore().reconcile(run.origin, withOther, now)).records.length, 0, 'Clear history hides all existing exports');
const newer = {...withOther, records: [...withOther.records, {sysId:'1'.repeat(32)}]};
assert.equal((await new HistoryStore().reconcile(run.origin, newer, now)).records.length, 1, 'Clear history allows new exports to appear');
now+=24*60*60*1000+1;
assert.equal((await new HistoryStore().reconcile(run.origin,history,now)).batches.length,0,'24-hour expiry');
console.log('History store checks passed: persistence, submitted IDs, per-instance/user isolation, deleted batches, and expiry');
