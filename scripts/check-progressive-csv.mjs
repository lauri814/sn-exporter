import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
function load(file) {
  const exports={};
  vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
    {exports,Blob,Error,require:id=>load(path.resolve(path.dirname(file),id+'.ts'))});
  return exports;
}
const {ProgressiveCsv}=load('src/export/progressive-csv.ts');
const job=id=>({id,status:'completed',attachmentId:String(id).repeat(32)});
const run={id:'batch',status:'running',revision:1,jobs:[{...job(1),status:'running'},job(2),job(3)]};
let downloaded,failures=[];const reads=[],counts=[],progress=[];
const combine=new ProgressiveCsv(run,{
  read:async id=>{reads.push(id);return 'number,description\r\nINC'+id+',"line one\nline two"\r\n'},
  record:async(id,rows)=>counts.push({id,rows}),progress:(rows,files,total)=>progress.push({rows,files,total}),
  complete:file=>{downloaded=file},failed:message=>failures.push(message),
});
await combine.update(run);
assert.deepEqual(reads,[2,3],'Read completed files without waiting for earlier chunk');
assert.equal(combine.rows,2);assert.equal(combine.files,2);
assert.equal(downloaded,undefined,'No partial automatic download');
assert.deepEqual(progress.at(-1),{rows:2,files:2,total:3},'Live row totals respect multiline CSV');
await combine.update(run);assert.deepEqual(reads,[2,3],'Repeated snapshots do not refetch files');
await combine.update({...run,revision:2,status:'completed',jobs:[job(1),job(2),job(3)]});
assert.equal(await downloaded.text(),'number,description\r\nINC1,"line one\nline two"\r\nINC2,"line one\nline two"\r\nINC3,"line one\nline two"\r\n','Download in chunk order with one header');
assert.equal(counts.length,3);assert.equal(failures.length,0);
await combine.update({...run,revision:3});assert.equal(reads.length,3,'Finished session cannot start another download');

let release;const gate=new Promise(resolve=>{release=resolve});let waitingDownload=false;
const waiting=new ProgressiveCsv(run,{read:async()=>gate,record:async()=>{},progress:()=>{},complete:()=>{waitingDownload=true},failed:message=>failures.push(message)});
const reading=waiting.update(run);
waiting.stop();release('number\r\nINC1\r\n');await reading;
assert.equal(waitingDownload,false,'Navigation invalidates in-flight reads');
assert.equal(waiting.rows,0);

let cancelDownload=false;const cancelErrors=[];
const cancelled=new ProgressiveCsv(run,{read:async()=> 'number\r\nINC1\r\n',record:async()=>{},progress:()=>{},complete:()=>{cancelDownload=true},failed:message=>cancelErrors.push(message)});
await cancelled.update({...run,revision:2,cancelRequested:true});
assert.equal(cancelDownload,false);assert.equal(cancelErrors.length,1,'Cancelled batches cannot emit partial CSV');

let mismatchDownload=false;const mismatchErrors=[];
const mismatch=new ProgressiveCsv(run,{read:async id=>id===2?'number\r\nINC2\r\n':'description\r\ntext\r\n',record:async()=>{},progress:()=>{},complete:()=>{mismatchDownload=true},failed:message=>mismatchErrors.push(message)});
await mismatch.update(run);
assert.equal(mismatchDownload,false);assert.match(mismatchErrors[0],/headers differ/);

const concurrentReads=[];let resolveFirst;
const firstRead=new Promise(resolve=>{resolveFirst=resolve});
const concurrent=new ProgressiveCsv(run,{read:async id=>{concurrentReads.push(id);return id===2?firstRead:'number\r\nINC'+id+'\r\n'},record:async()=>{},progress:()=>{},complete:()=>{},failed:message=>{throw new Error(message)}});
const firstUpdate=concurrent.update(run);
await concurrent.update({...run,status:'completed',revision:2,jobs:[job(1),job(2),job(3)]});
resolveFirst('number\r\nINC2\r\n');await firstUpdate;
assert.deepEqual(concurrentReads,[2,1,3],'New completions during a read are included once');
console.log('Progressive CSV checks passed: live counts, ordered output, incremental arrivals, deduplication, invalidation, cancellation, and header failures');
