import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function event() {
  const listeners = new Set();
  return { addListener: callback => listeners.add(callback), removeListener: callback => listeners.delete(callback),
    emit: (...args) => [...listeners].forEach(callback => callback(...args)) };
}
async function flush() { for(let i=0;i<250;i++) await Promise.resolve(); }
function environment(initialStore = {}) {
  const stored = structuredClone(initialStore);
  const timers = new Map(); let timerId = 0, now = 1000;
  class Clock extends Date { static now() { return now; } }
  const localStore={},historyNavigations=[];
  const historyResponse={userId:'a'.repeat(32),records:[],attachments:[]};
  let historyError=false, identityAvailable=true;
  const requests = [], messages = [], downloads = [], polls = new Map();
  const onBeforeNavigate = event(), onChanged = event(), onAlarm = event(), onMessage = event();
  const context = {table:'incident',filter:'active=true',rowCount:17000,frameId:7,view:'ess'};
  const chrome = {
    runtime:{id:'test-extension',onMessage},
    storage:{local:{get:async()=>structuredClone(localStore),set:async values=>Object.assign(localStore,structuredClone(values))},session:{get:async()=>structuredClone(stored),set:async values=>{Object.assign(stored,structuredClone(values))},remove:async key=>{delete stored[key]}}},
    alarms:{create:async()=>{},onAlarm},
    webNavigation:{onBeforeNavigate,getAllFrames:async()=>[{frameId:7,url:'https://example.service-now.com/incident_list.do?sysparm_view=ess'}]},
    tabs:{onRemoved:event(),get:async()=>({id:1,url:'https://example.service-now.com/nav_to.do'}),sendMessage:async(tabId,message)=>{messages.push(structuredClone(message));return {accepted:true}}},
    downloads:{onChanged,download:async options=>{downloads.push(options);return 100+downloads.length}},
    scripting:{executeScript:async details=>{
      assert.equal(details.target.tabId,1);
      if(details.func.name==='pageSessionUser')return [{frameId:7,result:identityAvailable ? context.userId ?? 'a'.repeat(32) : null}];
      if(typeof details.args?.[0]==='string' && details.args[0].startsWith('https://')){historyNavigations.push(details.args[0]);return [{frameId:0,result:true}]};
      if(details.func.name==='pagePollHistory'){if(historyError)throw new Error('History query failed');return [{frameId:0,result:structuredClone(historyResponse)}]};
      if(details.func.name==='pageCsvAttachment'){return [{frameId:7,result:'number,description\r\nINC1,test\r\n'}]};
      if(details.args[0]===true)return [{frameId:7,result:structuredClone(context)}];
      const params = new URLSearchParams(details.args[0]);
      requests.push(params);
      let result;
      if(params.get('sys_action')==='init') {
        assert.ok(stored['sn-export-run:1'].jobs.some(job=>job.status==='submitting'),'Save intent before POST init');
        result=requests.filter(request=>request.get('sys_action')==='init').length.toString(16).padStart(32,'0');
      } else if(params.get('sys_action')==='cancel') { result='';
      } else {
        const id=params.get('job_id'); const count=(polls.get(id)||0)+1; polls.set(id,count);
        result=count===1?'exported 100 of 300 rows':`complete,b${id.slice(1)}`;
      }
      return [{frameId:7,result}];
    }},
  };
  const cache=new Map();
  function load(file) {
    const full=path.resolve(file);if(cache.has(full))return cache.get(full);
    const exports={};cache.set(full,exports);
    const {outputText}=ts.transpileModule(readFileSync(full,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
    vm.runInNewContext(outputText,{exports,chrome,URL,URLSearchParams,Error,structuredClone,crypto,Date:Clock,
      setTimeout:(callback,ms)=>{const id=++timerId;timers.set(id,{callback,ms});return id},clearTimeout:id=>timers.delete(id),
      require:id=>load(path.resolve(path.dirname(full),`${id}.ts`))});
    return exports;
  }
  const runtime=load('src/export/runtime.ts').registerExports({csv:'unload_csv',xlsx:'unload_excel_xlsx',xml:'unload_xml',json:'unload_json'});
  return {runtime,requests,stored,localStore,historyResponse,historyNavigations,setIdentityAvailable:value=>{identityAvailable=value},setHistoryError:value=>{historyError=value},messages,downloads,context,timers,onAlarm,onBeforeNavigate,onChanged,onMessage,
    async tick() {const item=[...timers][0];assert.ok(item,'Expected a scheduled polling tick');timers.delete(item[0]);now+=item[1].ms;item[1].callback();await flush();}};
}
const input={filenamePrefix:'Quarterly incidents',confirmed:true,frameId:7,query:'active=true',fileType:'csv',fields:'number, caller_id',displayValues:true,targetChunkSize:8000,concurrency:2,expectedTable:'incident',expectedRowCount:17000,expectedView:'ess'};
const env=environment();
assert.equal(await env.runtime.getRun(1),null);
assert.equal(env.requests.length,0,'Opening cannot submit jobs');
await assert.rejects(env.runtime.startRun(1,{...input,confirmed:false}),/invalid/);
await assert.rejects(env.runtime.startRun(1,{...input,expectedRowCount:-1}),/captured panel row count/);
await assert.rejects(env.runtime.startRun(1,{...input,reviewedListQuery:'state=2'}),/filter changed after review/);
await assert.rejects(env.runtime.startRun(1,{...input,pollingIntervalSeconds:0}),/1 to 60/);
await assert.rejects(env.runtime.startRun(1,{...input,pollingIntervalSeconds:61}),/1 to 60/);
const started=await env.runtime.startRun(1,input);
assert.equal(started.jobs.length,3);
await assert.rejects(env.runtime.readCsvAttachment(1,started.id,1),/completed attachment is unavailable/);
assert.equal(env.requests.length,0,'Scheduler must not have run during review');
await assert.rejects(env.runtime.startRun(1,input),/already has an active/);
await env.tick();
assert.equal([...env.timers.values()][0].ms,2000,'Default interval is 2 seconds after the polling round');
assert.equal(env.requests.filter(request=>request.get('sys_action')==='init').length,2);
let hiddenRun=await env.runtime.getRun(1);
assert.equal(hiddenRun.id,started.id,'Retain state when panel reopens');
assert.equal(hiddenRun.jobs[2].status,'queued');
for(const request of env.requests){
 assert.equal(request.has('sysparm_view'),false,'Explicit fields suppress the view');assert.equal(request.get('sysparm_fields'),'number,caller_id');
 assert.equal(request.get('sysparm_display_value'),'true');assert.equal(request.get('sysparm_export'),'unload_csv');
 assert.ok(request.get('sysparm_query').includes('active=true'));assert.equal(request.has('proxyparm'),false);
}
await env.tick();
hiddenRun=await env.runtime.getRun(1);
assert.equal(hiddenRun.jobs[0].exportedRows,100);
assert.equal(env.requests.filter(request=>request.get('sys_action')==='init').length,2);
await env.tick();await env.tick();await env.tick();
const complete=await env.runtime.getRun(1);
assert.equal(complete.status,'completed');assert.equal(complete.jobs.filter(job=>job.status==='completed').length,3);
assert.equal(env.requests.filter(request=>request.get('sys_action')==='init').length,3);
assert.equal(await env.runtime.readCsvAttachment(1,complete.id,1),'number,description\r\nINC1,test\r\n');
await assert.rejects(env.runtime.readCsvAttachment(1,complete.id,99),/unavailable/);
await assert.rejects(env.runtime.readCsvAttachment(1,'stale-run',1),/no longer available/);
assert.equal((await env.runtime.recordCsvCounts(1,complete.id,[{jobId:1,rows:1}])).jobs[0].fileRowCount,1,'Accept incremental CSV row verification');
await assert.rejects(env.runtime.recordCsvCounts(1,complete.id,[{jobId:1,rows:1},{jobId:1,rows:1},{jobId:3,rows:1}]),/unique, valid row counts/);
await env.runtime.recordCsvCounts(1,complete.id,complete.jobs.map(job=>({jobId:job.id,rows:1})));
assert.equal((await env.runtime.getRun(1)).jobs[0].fileRowCount,1,'Retain attachment counts in the run snapshot');
let result=await env.runtime.downloadAll(1,complete.id,'Download name');
assert.equal(result.requested,3);assert.equal(env.downloads.length,3);
assert.deepEqual(env.downloads.map(item=>item.filename),['Download name-001.csv','Download name-002.csv','Download name-003.csv']);
assert.ok(env.downloads.every(item=>item.url.startsWith('https://example.service-now.com/sys_attachment.do?sys_id=')));
result=await env.runtime.downloadAll(1,complete.id);assert.equal(result.requested,0,'Do not request the same downloads again');
env.onChanged.emit({id:101,state:{current:'interrupted'},error:{current:'NETWORK_FAILED'}});await flush();
result=await env.runtime.downloadAll(1,complete.id,undefined,{mode:'failed'});assert.equal(result.requested,1,'Retry an interrupted download only');
await assert.rejects(env.runtime.downloadAll(1,'stale-run'),/no longer available/);
let foreignResponded=false;
env.onMessage.emit({type:'SN_EXPORT_START',options:input},{id:'other-extension',tab:{id:1}},()=>{foreignResponded=true});
assert.equal(foreignResponded,false);
const reloading=environment();await reloading.runtime.startRun(1,input);await reloading.tick();
reloading.onBeforeNavigate.emit({tabId:1,frameId:7});await flush();
assert.equal(await reloading.runtime.getRun(1),null,'Reload forgets tracked runs');
assert.equal(reloading.stored['sn-export-run:1'],undefined);
if(reloading.timers.size)await reloading.tick();
assert.equal(reloading.requests.filter(request=>request.get('sys_action')==='init').length,2,'Reload does not submit queued chunks');
const interrupted=structuredClone(started);interrupted.jobs[0].status='submitting';interrupted.jobs[1].status='running';interrupted.jobs[1].jobId='a'.repeat(32);
const restored=environment({'sn-export-run:1':interrupted});
const recovered=await restored.runtime.getRun(1);
await assert.rejects(restored.runtime.resumeRun(1,interrupted.id),/outcome is unknown/);
assert.equal(recovered.jobs[0].status,'submission_unknown','Unknown submission is never silently retried');
assert.equal(recovered.jobs[1].jobId,'a'.repeat(32),'Retain known IDs across worker restart');
const slower=environment();await slower.runtime.startRun(1,{...input,pollingIntervalSeconds:5});await slower.tick();
assert.equal([...slower.timers.values()][0].ms,5000,'Custom interval is applied per run');
slower.onAlarm.emit({name:'sn-export-poll'});await flush();
assert.equal(slower.requests.filter(request=>request.get('sys_action')==='poll').length,0,'Alarm cannot poll before the configured interval');
const pausedRun=structuredClone(started);pausedRun.status='paused';pausedRun.jobs[0]={id:1,status:'running',jobId:'a'.repeat(32)};
const resumable=environment({'sn-export-run:1':pausedRun});
assert.equal((await resumable.runtime.getRun(1)).status,'paused','Opening the panel does not silently resume tracking');
await resumable.runtime.resumeRun(1,pausedRun.id);
assert.equal(resumable.requests.filter(request=>request.get('sys_action')==='init').length,0,'Resume only polls known jobs');
assert.equal(resumable.requests.filter(request=>request.get('sys_action')==='poll').length,1);
assert.equal((await resumable.runtime.getRun(1)).status,'running');
const differentQuery=environment();
const exportSnapshot=await differentQuery.runtime.startRun(1,{...input,query:'priority=1',expectedRowCount:9000,reviewedListQuery:'active=true'});
assert.equal(exportSnapshot.settings.query,'priority=1','Allow an export query different from the visible list');
assert.equal(exportSnapshot.settings.rowCount,9000,'Use the panel snapshot count, not the current list count');
assert.equal(exportSnapshot.jobs.length,2);
await differentQuery.tick();assert.equal(differentQuery.requests[0].get('sysparm_query').startsWith('priority=1'),true);
const historic=environment(); // No userId in list context: identity must be read independently.
const historyRun=await historic.runtime.startRun(1,input);await historic.tick();
const pollId=historic.stored['sn-export-run:1'].jobs[0].jobId;
historic.historyResponse.records.push({sysId:'2'.repeat(32),jobId:pollId,state:'complete'});
historic.historyResponse.attachments.push({sysId:'f'.repeat(32),pollId:'2'.repeat(32),fileName:'incident.csv',contentType:'text/csv'});
let historyView=await historic.runtime.getHistory(1);
assert.equal(historyView.batches.length,1,'Archive records the batch even when list context omits user identity');
historic.onBeforeNavigate.emit({tabId:1,frameId:7});await flush();
assert.equal(await historic.runtime.getRun(1),null);
assert.equal((await historic.runtime.getHistory(1)).batches.length,1,'List reload clears active tracking but preserves history');
await historic.runtime.openHistoryList(1,historyRun.id);
assert.equal(new URL(historic.historyNavigations[0]).searchParams.get('sysparm_query'),'active=true','Explicit Open list uses the saved query');
assert.equal(new URL(historic.historyNavigations[0]).searchParams.get('sysparm_view'),'ess');
await historic.runtime.downloadHistoryFile(1,'f'.repeat(32));
assert.equal(historic.downloads[0].filename,'incident.csv');
assert.equal((await historic.runtime.readHistoryCsv(1,'f'.repeat(32))).text,'number,description\r\nINC1,test\r\n');
historic.setHistoryError(true);await assert.rejects(historic.runtime.getHistory(1),/History query failed/);
assert.equal(historic.localStore['sn-export-history-v1'].length,1,'A failed history read never deletes stored batches');
historic.setHistoryError(false);historic.historyResponse.records=[];historic.historyResponse.attachments=[];
assert.equal((await historic.runtime.getHistory(1)).batches.length,0,'Deleted native jobs remove the archived batch');
await assert.rejects(historic.runtime.downloadHistoryFile(1,'f'.repeat(32)),/no longer available/);
const noIdentity=environment();noIdentity.setIdentityAvailable(false);
await assert.rejects(noIdentity.runtime.startRun(1,input),/could not be identified/);
assert.equal(noIdentity.requests.length,0,'Do not start untracked jobs when browser identity is unavailable');
const repairable=environment();const repairRun=await repairable.runtime.startRun(1,input);await repairable.tick();
const repairSnapshot=await repairable.runtime.getRun(1);
assert.equal((await repairable.runtime.getHistory(1)).batches.length,0,'An empty result prunes absent mappings');
repairable.historyResponse.records=repairSnapshot.jobs.filter(job=>job.jobId).map(job=>({sysId:job.jobId.split('').reverse().join(''),jobId:job.jobId,state:'complete'}));
const repairedHistory=await repairable.runtime.getHistory(1);
assert.equal(repairedHistory.batches.length,1,'A later refresh groups newly visible jobs instead of leaving them as other exports');
assert.equal(repairedHistory.batches[0].id,repairRun.id);
const nextBatch=await env.runtime.startRun(1,input);await env.tick();
const nextSnapshot=await env.runtime.getRun(1);
env.historyResponse.records=[...complete.jobs,...nextSnapshot.jobs].filter(job=>job.jobId).map(job=>({sysId:job.jobId.split('').reverse().join(''),jobId:job.jobId,state:'complete'}));
const multiBatch=await env.runtime.getHistory(1);
assert.equal(multiBatch.batches.length,2,'Starting another batch in the same panel preserves both history groups');
env.setHistoryError(true); // Any accidental native history query must fail this test.
let localHistory = await env.runtime.removeHistory(1, multiBatch, {batchId: multiBatch.batches[0].id});
assert.equal(localHistory.batches.length, 1, 'Batch removal returns updated local history without querying ServiceNow');
const otherId = '9'.repeat(32);
localHistory.records.push({sysId:otherId,state:'complete'});
localHistory.attachments.push({sysId:'8'.repeat(32),pollId:otherId});
localHistory = await env.runtime.removeHistory(1, localHistory, {pollId:otherId});
assert.ok(!localHistory.records.some(record=>record.sysId===otherId), 'Individual removal updates displayed records locally');
assert.ok(!localHistory.attachments.some(file=>file.pollId===otherId), 'Individual removal updates displayed attachments locally');
localHistory = await env.runtime.removeHistory(1, localHistory, {all:true});
assert.equal(localHistory.records.length, 0, 'Clear history does not query ServiceNow');
assert.equal(localHistory.batches.length, 0);
env.setHistoryError(false);
assert.equal((await env.runtime.getHistory(1)).batches.length, 0, 'Explicit refresh respects local removal exclusions');

assert.ok(multiBatch.batches.some(batch=>batch.id===complete.id));assert.ok(multiBatch.batches.some(batch=>batch.id===nextBatch.id));
const legacyRun=structuredClone(complete);delete legacyRun.userId;
const legacy=environment({'sn-export-run:1':legacyRun});
legacy.historyResponse.records=legacyRun.jobs.map(job=>({sysId:job.jobId.split('').reverse().join(''),jobId:job.jobId,state:'complete'}));
assert.equal((await legacy.runtime.getHistory(1)).batches.length,1,'Recover the latest unarchived legacy run using session-readable poll IDs');
console.log('Runtime checks passed: confirmation gate, fresh list snapshot, bounded session requests, restored state, progress, download batching/retry, reload cleanup, and worker recovery');

const cancelEnv=environment();
const cancelRun=await cancelEnv.runtime.startRun(1,input);await cancelEnv.tick();
const cancelSnapshot=cancelEnv.stored['sn-export-run:1'];
cancelEnv.historyResponse.records=cancelSnapshot.jobs.filter(job=>job.jobId).map((job,index)=>({sysId:String(index+5).repeat(32),jobId:job.jobId,state:'cancelled'}));
await assert.rejects(cancelEnv.runtime.cancelRun(1,cancelRun.id,false),/Confirm cancellation/);
assert.equal(cancelEnv.requests.filter(request=>request.get('sys_action')==='cancel').length,0);
const cancelled=await cancelEnv.runtime.cancelRun(1,cancelRun.id,true);
assert.equal(cancelled.status,'cancelled');
assert.equal(cancelEnv.requests.filter(request=>request.get('sys_action')==='cancel').length,2,'Cancel each submitted running job');
assert.equal(cancelEnv.requests.filter(request=>request.get('sys_action')==='init').length,2,'Do not launch remaining queued chunks');
const cancelHistory=await cancelEnv.runtime.getHistory(1);
assert.equal(cancelHistory.records.length,0,'Cancelled job IDs are hidden from History');
assert.equal(cancelHistory.batches.length,0,'Fully cancelled batches do not become other exports');

const partialCancel=environment();
const partialRun=await partialCancel.runtime.startRun(1,input);
await partialCancel.tick();await partialCancel.tick();await partialCancel.tick();
const partialSnapshot=partialCancel.stored['sn-export-run:1'];
assert.equal(partialSnapshot.jobs.filter(job=>job.status==='completed').length,2);
partialCancel.historyResponse.records=partialSnapshot.jobs.map((job,index)=>({sysId:String(index+5).repeat(32),jobId:job.jobId,state:job.status==='completed'?'complete':'cancelled'}));
const partialCancelled=await partialCancel.runtime.cancelRun(1,partialRun.id,true);
assert.equal(partialCancelled.jobs.filter(job=>job.status==='completed').length,2);
assert.equal(partialCancel.requests.filter(request=>request.get('sys_action')==='cancel').length,1,'Only remaining running job gets cancellation');
const partialHistory=await partialCancel.runtime.getHistory(1);
assert.equal(partialHistory.records.length,2,'Completed records remain in History');
assert.equal(partialHistory.batches.length,1);
assert.equal(partialHistory.batches[0].jobs.length,2,'Cancelled chunks are excluded from the batch history');
await partialCancel.runtime.downloadAll(1,partialRun.id);
assert.equal(partialCancel.downloads.length,2,'Completed files can be downloaded after cancellation');

const progressive=environment();
const progressiveRun=await progressive.runtime.startRun(1,input);
await progressive.tick();await progressive.tick();await progressive.tick();
assert.equal(progressive.stored['sn-export-run:1'].jobs[2].status,'running');
assert.equal(typeof await progressive.runtime.readCsvAttachment(1,progressiveRun.id,1),'string','Read completed CSV while another chunk runs');
let incremental=await progressive.runtime.recordCsvCounts(1,progressiveRun.id,[{jobId:1,rows:1}]);
assert.equal(incremental.jobs[0].fileRowCount,1);
assert.equal(incremental.jobs[1].fileRowCount,undefined);
incremental=await progressive.runtime.recordCsvCounts(1,progressiveRun.id,[{jobId:2,rows:2}]);
assert.equal(incremental.jobs[0].fileRowCount,1,'Later counts preserve previous chunk verification');
assert.equal(incremental.jobs[1].fileRowCount,2);
await assert.rejects(progressive.runtime.recordCsvCounts(1,progressiveRun.id,[{jobId:3,rows:0}]),/completed attachments/);
