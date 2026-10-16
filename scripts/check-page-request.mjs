import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const { outputText } = ts.transpileModule(readFileSync('src/servicenow/page/processor-request.ts','utf8'), {
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
});
async function execute(page, response, verify=()=>{}, body='sys_action=init&sysparm_query=a%26b') {
  const scope={exports:{},window:{location:{origin:'https://example.service-now.com'},...page}, URL, AbortController,setTimeout,clearTimeout,
    fetch:async(url, options)=>{verify(url,options); return response;}};
  vm.runInNewContext(outputText,scope);
  return scope.exports.pageProcessorRequest(body);
}
const fakeSessionToken='test-only-session-token';
const jobId='a'.repeat(32);
const response={ok:true,text:async()=>jobId};
assert.equal(await execute({g_ck:fakeSessionToken},response,(url,options)=>{
  assert.equal(url.href,'https://example.service-now.com/poll_processor.do');
  assert.equal(options.credentials,'same-origin');
  assert.equal(options.redirect,'error');
  assert.equal(options.method,'POST');
  assert.equal(options.headers['X-UserToken'],fakeSessionToken);
  assert.equal(options.body,'sys_action=init&sysparm_query=a%26b');
}),jobId);
assert.equal(await execute({parent:{g_ck:fakeSessionToken}},response),jobId);
assert.equal(await execute({g_ck:fakeSessionToken},{ok:true,status:200,text:async()=>''},(url,options)=>{
  assert.equal(options.body,'sys_action=cancel&job_id='+jobId);
},'sys_action=cancel&job_id='+jobId),'','Cancel accepts HTTP 200 with an empty response');
await assert.rejects(execute({},response),/session token is unavailable/);
await assert.rejects(execute({g_ck:fakeSessionToken},{ok:false,status:403}),/HTTP 403/);
console.log('Page-request checks passed: same-origin endpoint/session, CSRF header, parent-token fallback, missing session, and HTTP failure');

const attachmentScope={exports:{},window:{location:{origin:'https://example.service-now.com'}},URL,AbortController,setTimeout,clearTimeout,Uint8Array,TextDecoder,
  fetch:async(url,options)=>{
    assert.equal(url.href,'https://example.service-now.com/sys_attachment.do?sys_id='+jobId);
    assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');
    return {ok:true,headers:{get:()=> 'text/csv'},arrayBuffer:async()=>new TextEncoder().encode('number\r\nINC1\r\n').buffer};
  }};
vm.runInNewContext(ts.transpileModule(readFileSync('src/servicenow/page/attachment.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,attachmentScope);
assert.equal(await attachmentScope.exports.pageCsvAttachment(jobId),'number\r\nINC1\r\n');
await assert.rejects(attachmentScope.exports.pageCsvAttachment('../bad'),/Invalid attachment/);
attachmentScope.fetch=async()=>({ok:true,headers:{get:()=> 'text/html'}});
await assert.rejects(attachmentScope.exports.pageCsvAttachment(jobId),/instead of a CSV/);
attachmentScope.fetch=async()=>({ok:false,status:403});
await assert.rejects(attachmentScope.exports.pageCsvAttachment(jobId),/HTTP 403/);
