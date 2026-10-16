import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const { outputText } = ts.transpileModule(readFileSync('src/export/controller.ts','utf8'), {
  compilerOptions:{ target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS },
});
const sandbox={exports:{},Error};
vm.runInNewContext(outputText,sandbox);
const {ExportController,recoverInterruptedSubmissions}=sandbox.exports;
function run() { return {id:'run',status:'running',settings:{concurrency:2},jobs:[1,2,3].map(id=>({id,query:'active=true',status:'queued'}))}; }
const state=run(); const calls=[]; let publishedIntent=false;
const controller=new ExportController({
  publish:async state=>{ if(state.jobs.some(job=>job.status==='submitting')) publishedIntent=true; },
  submit:async (state,job)=>{ assert.ok(publishedIntent); calls.push(job.id); return String(job.id).repeat(32); },
  poll:async (state,job)=>({status:'completed',attachmentId:'a'.repeat(32)}),
});
await Promise.all([controller.tick(state),controller.tick(state)]);
assert.deepEqual(calls,[1,2]);
assert.equal(state.jobs[2].status,'queued');
await controller.tick(state);
assert.deepEqual(calls,[1,2,3]);
assert.equal(state.jobs[2].status,'running');
await controller.tick(state);
assert.equal(state.status,'completed');
assert.ok(Number.isFinite(state.finishedAt),'Batch completion records its end time');
const finishedTime=state.finishedAt;recoverInterruptedSubmissions(state);
assert.equal(state.finishedAt,finishedTime,'Recovery preserves the completion timestamp');
assert.ok(state.jobs.every(job=>job.attachmentId==='a'.repeat(32)));
const recovering=run(); recovering.jobs[0].status='submitting';
recoverInterruptedSubmissions(recovering);
assert.equal(recovering.jobs[0].status,'submission_unknown');
assert.match(recovering.jobs[0].message,/not resubmitted/);
const failed=run();
const failing=new ExportController({publish:async()=>{}, submit:async()=>{throw new Error('Connection lost')}, poll:async()=>{throw new Error('should not poll')}});
await failing.tick(failed); await failing.tick(failed);
assert.equal(failed.status,'paused');
assert.equal(failed.needsReview,true);
assert.equal(failed.jobs.filter(job=>job.status==='submission_unknown').length,2);
assert.equal(failed.jobs[2].status,'queued');
const paused=run(); paused.jobs[0]={id:1,status:'running',jobId:'b'.repeat(32)};
let submitted=0;
await new ExportController({publish:async()=>{},submit:async()=>{submitted++;return 'c'.repeat(32)},poll:async()=>{throw new Error('session expired')}}).tick(paused);
assert.equal(paused.status,'paused');
assert.equal(submitted,0);
assert.equal(paused.jobs[0].jobId,'b'.repeat(32));
assert.equal(paused.jobs[1].status,'queued');
const unknownStatus=run();unknownStatus.jobs[0]={id:1,status:'running',jobId:'d'.repeat(32)};
let unexpectedSubmissions=0;
await new ExportController({publish:async()=>{},submit:async()=>{unexpectedSubmissions++;return 'e'.repeat(32)},poll:async()=>({status:'unknown',message:'Unrecognized status'})}).tick(unknownStatus);
assert.equal(unknownStatus.status,'paused');assert.equal(unknownStatus.jobs[0].status,'running');
assert.equal(unexpectedSubmissions,0,'Unknown status cannot free a concurrency slot');
const navigationDuringSave=run();let submissionsAfterReload=0;
await new ExportController({publish:async state=>{if(state.jobs.some(job=>job.status==='submitting'))state.status='paused'},
 submit:async()=>{submissionsAfterReload++;return 'f'.repeat(32)},poll:async()=>({status:'completed',attachmentId:'a'.repeat(32)})}).tick(navigationDuringSave);
assert.equal(submissionsAfterReload,0,'Navigation during intent persistence stops queued submissions');

const querying=run();querying.settings.concurrency=1;querying.jobs=querying.jobs.slice(0,1);
let querySubmissions=0,polls=0;
const earlyPoll=new ExportController({publish:async()=>{},submit:async()=>{querySubmissions++;return 'a'.repeat(32)},
 poll:async()=>++polls===1?{status:'running',message:'Querying your data'}:{status:'completed',attachmentId:'b'.repeat(32)}});
await earlyPoll.tick(querying);await earlyPoll.tick(querying);
assert.equal(querying.status,'running');assert.equal(querying.jobs[0].message,'Querying your data');
assert.equal(querying.jobs[0].totalRows,undefined,'Querying does not invent a row count');
await earlyPoll.tick(querying);
assert.equal(querying.status,'completed');assert.equal(querySubmissions,1,'Early polling must not resubmit the job');

console.log('Controller checks passed: concurrent submissions, queue refill, uncertain outcomes, unknown statuses, and navigation during persistence');

const cancelState=run();
cancelState.jobs[0]={id:1,status:'completed',attachmentId:'a'.repeat(32)};
cancelState.jobs[1]={id:2,status:'running',jobId:'b'.repeat(32)};
const cancelledIds=[];
const cancelController=new ExportController({publish:async()=>{},submit:async()=>{throw new Error('No new init after cancel')},
  poll:async()=>{throw new Error('No polling after cancel')},cancel:async(state,job)=>{cancelledIds.push(job.jobId)}});
await cancelController.cancel(cancelState);
assert.equal(cancelState.status,'cancelled');
assert.ok(Number.isFinite(cancelState.finishedAt),'Batch cancellation records its end time');
assert.equal(cancelState.jobs[0].attachmentId,'a'.repeat(32),'Completed files survive cancellation');
assert.equal(cancelState.jobs[2].status,'cancelled','Queued chunks stop locally');
assert.deepEqual(cancelledIds,['b'.repeat(32)],'Only running jobs are cancelled');
await cancelController.tick(cancelState);

const race=run();let resolveInit,initStarted;
const startedInit=new Promise(resolve=>{initStarted=resolve});
const lateCancel=[];
const racingController=new ExportController({publish:async()=>{},poll:async()=>({status:'running',message:'Querying your data'}),
  submit:async(state,job)=>{initStarted();return await new Promise(resolve=>{resolveInit=resolve})},
  cancel:async(state,job)=>{lateCancel.push(job.jobId)}});
race.settings.concurrency=1;
const ticking=racingController.tick(race);await startedInit;
const cancelling=racingController.cancel(race);
resolveInit('c'.repeat(32));await Promise.all([ticking,cancelling]);
assert.deepEqual(lateCancel,['c'.repeat(32)],'Cancellation waits for init and cancels the returned job ID');
assert.ok(race.jobs.every(job=>job.status==='cancelled'));

const retryCancel=run();retryCancel.jobs=[{id:1,status:'running',jobId:'d'.repeat(32)}];let failCancel=true;
const retryController=new ExportController({publish:async()=>{},submit:async()=>'',poll:async()=>({status:'running',message:'running'}),
  cancel:async()=>{if(failCancel)throw new Error('HTTP 503')}});
await retryController.cancel(retryCancel);
assert.equal(retryCancel.status,'paused');assert.equal(retryCancel.jobs[0].status,'running','Failed cancel retains known job');
failCancel=false;await retryController.cancel(retryCancel);assert.equal(retryCancel.status,'cancelled');

const terminalFailure=run();terminalFailure.jobs=[{id:1,status:'running',jobId:'a'.repeat(32)}];
await new ExportController({publish:async()=>{},submit:async()=>'',poll:async()=>({status:'failed',message:'Error'})}).tick(terminalFailure);
assert.equal(terminalFailure.status,'failed');assert.ok(Number.isFinite(terminalFailure.finishedAt));
const oldCompleted=run();oldCompleted.status='completed';oldCompleted.jobs=[{id:1,status:'completed'}];
recoverInterruptedSubmissions(oldCompleted);assert.equal(oldCompleted.finishedAt,undefined,'Do not invent elapsed time for historical runs without a recorded end');
