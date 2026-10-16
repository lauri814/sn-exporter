import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const {outputText}=ts.transpileModule(readFileSync('src/export/downloads.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
const types={exports:{}};
vm.runInNewContext(ts.transpileModule(readFileSync('src/export/types.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,types);
const scope={exports:{},URL,Error,require:id=>{assert.equal(id,'./types');return types.exports}};
vm.runInNewContext(outputText,scope);
const {attachmentUrl,downloadCompleted,exportFilename,normalizeFilenamePrefix,downloadCounts}=scope.exports;
assert.throws(()=>attachmentUrl('https://other.example','a'.repeat(32)),/valid ServiceNow/);
assert.throws(()=>attachmentUrl('https://example.service-now.com','../../x'),/valid ServiceNow/);
const run={settings:{table:'incident',fileType:'csv',filenamePrefix:'My incidents'},origin:'https://example.service-now.com',jobs:[
  {id:1,status:'completed',attachmentId:'a'.repeat(32)},
  {id:2,status:'completed',attachmentId:'b'.repeat(32)},
  {id:3,status:'running'},
]};
for(const fileType of types.exports.FILE_TYPES) {
  assert.equal(exportFilename({...run,settings:{...run.settings,fileType}},1),`My incidents-001.${fileType}`);
}
assert.equal(exportFilename(run,1001),'My incidents-1001.csv');
assert.equal(exportFilename({...run,settings:{table:'incident',fileType:'csv'}},2),'incident-002.csv');
for(const prefix of ['','../escape','a/b','a\\b','name.','CON','test:bad'])assert.throws(()=>normalizeFilenamePrefix(prefix),/filename prefix/);
assert.equal(normalizeFilenamePrefix('  My incidents  '),'My incidents');
let calls=0;const publish=async()=>{};
let result=await downloadCompleted(run,async(url,filename)=>{calls++;assert.equal(filename,url.includes('b'.repeat(32))?'My incidents-002.csv':'My incidents-001.csv');if(url.includes('b'.repeat(32)))throw new Error('download denied');return 10},publish);
assert.equal(result.requested,1);assert.equal(result.failed,1);
assert.equal(run.jobs[0].downloadId,10);assert.equal(run.jobs[1].downloadError,'download denied');
result=await downloadCompleted(run,async()=>{calls++;return 11},publish);
assert.equal(calls,3,'Retry only failed requests');assert.equal(result.requested,1);assert.equal(result.failed,0);
assert.equal(run.jobs[1].downloadId,11);assert.equal(run.jobs[1].downloadError,undefined);
const retryRun={...run,jobs:[
  {id:1,status:'completed',attachmentId:'a'.repeat(32),downloadError:'denied'},
  {id:2,status:'completed',attachmentId:'b'.repeat(32)},
  {id:3,status:'completed',attachmentId:'c'.repeat(32),downloadId:22,downloadState:'complete'},
  {id:4,status:'completed',attachmentId:'d'.repeat(32),downloadId:23,downloadState:'interrupted'},
]};
assert.equal(downloadCounts(retryRun).failed,2);assert.equal(downloadCounts(retryRun).remaining,1);
const retried=[];
await downloadCompleted(retryRun,async url=>{retried.push(url);return 30+retried.length},publish,{mode:'failed'});
assert.equal(retried.length,2,'Retry excludes files never requested and saved files');
assert.equal(downloadCounts(retryRun).inProgress,2);assert.equal(downloadCounts(retryRun).completed,1);
assert.equal(downloadCounts(retryRun).failed,0);
const individual=[];
await downloadCompleted(retryRun,async url=>{individual.push(url);return 40},publish,{mode:'job',jobId:2});
assert.equal(individual.length,1);assert.ok(individual[0].includes('b'.repeat(32)));
await assert.rejects(downloadCompleted(retryRun,async()=>99,publish,{mode:'job',jobId:99}),/unavailable/);
await downloadCompleted(retryRun,async()=>{throw new Error('Must not duplicate saved file')},publish,{mode:'job',jobId:3});
assert.equal(downloadCounts(retryRun).completed,1);
console.log('Download checks passed: validated attachment URLs, completed jobs only, partial failure, and duplicate-free retry');
