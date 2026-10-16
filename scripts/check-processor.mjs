import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const cache = new Map();
function load(file) {
  const full = path.resolve(file);
  if (cache.has(full)) return cache.get(full);
  const exports = {}; cache.set(full, exports);
  const { outputText } = ts.transpileModule(readFileSync(full, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  vm.runInNewContext(outputText, { exports, URLSearchParams,
    require: id => load(path.resolve(path.dirname(full), `${id}.ts`)),
  });
  return exports;
}
const { planExport, constrainQuery, chunkCount } = load('src/export/plan.ts');
const { initPayload, cancelPayload, pollPayload, parseInitResponse, parsePollResponse } = load('src/servicenow/processor.ts');
const settings = { table:'incident', query:'active=true^priority=1', rowCount:16000,
  targetChunkSize:8000, concurrency:2, fileType:'xlsx', displayValues:false, fields:'number, caller_id,number' };
assert.equal(chunkCount(8000), 1);
assert.equal(chunkCount(8001), 2);
assert.equal(chunkCount(0), 0);
assert.equal(chunkCount(null), null);
assert.equal(chunkCount(16000, 10000), 2);
assert.equal(planExport({...settings,targetChunkSize:16001,concurrency:1}).length,1,'Allow targets above the default instance limit');
assert.throws(()=>planExport({...settings,targetChunkSize:0}),/positive whole-number/);
const jobs = planExport(settings);
assert.equal(jobs.length, 2);
assert.equal(jobs[0].query, 'active=true^priority=1^sys_id<80000000000000000000000000000000^ORDERBYsys_id');
assert.equal(jobs[1].query, 'active=true^priority=1^sys_id>=80000000000000000000000000000000^ORDERBYsys_id');
const three = planExport({ ...settings, rowCount:24000, concurrency:3 });
assert.equal(three[1].query, 'active=true^priority=1^sys_id>=55555555555555555555555555555555^sys_id<aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa^ORDERBYsys_id');
assert.equal(constrainQuery('active=true^ORpriority=1^NQstate=2^EQ^ORDERBYnumber', ['sys_id<abc']),
  'active=true^ORpriority=1^sys_id<abc^NQstate=2^sys_id<abc^ORDERBYsys_id');
assert.equal(constrainQuery('RLQUERYtask.parent,>=1^active=true^NQstate=2^ENDRLQUERY^EQ', ['sys_id<abc']),
  'RLQUERYtask.parent,>=1^active=true^NQstate=2^ENDRLQUERY^sys_id<abc^ORDERBYsys_id');
assert.throws(() => constrainQuery('RLQUERYtask.parent,>=1', []), /incomplete/);
assert.throws(() => planExport({ ...settings, concurrency:3 }), /Concurrency/);
const params = new URLSearchParams(initPayload({ ...settings, view:'special view', query:'x' }, 'nameLIKEa&b+c^priority=1', { xlsx:'unload_excel_xlsx' }));
assert.equal(params.get('sysparm_query'), 'nameLIKEa&b+c^priority=1');
assert.equal(params.has('sysparm_view'), false, 'Explicit fields must not be overridden by the view');
assert.equal(params.get('sysparm_fields'), 'number,caller_id');
assert.equal(params.get('sysparm_display_value'), 'false');
assert.equal(params.get('sysparm_export'), 'unload_excel_xlsx');
assert.equal(params.has('proxyparm'), false);
const defaults = new URLSearchParams(initPayload({ ...settings, fields:'' }, 'x', { xlsx:'unload_excel_xlsx' }));
assert.equal(defaults.has('sysparm_view'), false);
assert.equal(defaults.has('sysparm_fields'), false);
const viewOnly=new URLSearchParams(initPayload({...settings,fields:'  ',view:'special view'},'x',{xlsx:'unload_excel_xlsx'}));
assert.equal(viewOnly.get('sysparm_view'),'special view');assert.equal(viewOnly.has('sysparm_fields'),false);
const jobId='a'.repeat(32), attachmentId='b'.repeat(32);
assert.equal(parseInitResponse(`\n${jobId}\n`), jobId);
assert.throws(() => parseInitResponse('<html>login</html>'), /did not return/);
assert.equal(new URLSearchParams(pollPayload(jobId)).get('job_id'), jobId);
assert.equal(parsePollResponse('exported 80 of 100 rows').exportedRows,80);
assert.equal(parsePollResponse('exported 0 of 0 rows').totalRows,0);
const querying=parsePollResponse('  Querying your data\n');
assert.equal(querying.status,'running');
assert.equal(querying.message,'Querying your data');
assert.equal(querying.exportedRows,undefined);assert.equal(querying.totalRows,undefined);
assert.equal(parsePollResponse(`complete,${attachmentId}`).attachmentId,attachmentId);
assert.equal(parsePollResponse('incomplete,'+attachmentId).status,'unknown');
assert.equal(parsePollResponse('exported 101 of 100 rows').status,'unknown');
assert.equal(parsePollResponse('error,export denied').message,'error,export denied');
assert.equal(parsePollResponse('<html>login</html>').status,'unknown');
assert.equal(parsePollResponse('complete,').status,'unknown');
console.log('Processor/planning checks passed: filtered ranges, NQ branches, nested queries, payload encoding, view/fields/values, and response parsing');

for (const fileType of ['json','xml']) {
  for (const fields of ['number,caller_id','']) {
    const payload = new URLSearchParams(initPayload({...settings,fileType,fields,view:'special'},'active=true',{json:'unload_json',xml:'unload_xml'}));
    assert.equal(payload.has('sysparm_fields'),false);
    assert.equal(payload.has('sysparm_view'),false);
    assert.equal(payload.has('sysparm_display_value'),false);
  }
}

assert.equal(new URLSearchParams(cancelPayload(jobId)).get('sys_action'),'cancel');
assert.equal(new URLSearchParams(cancelPayload(jobId)).get('job_id'),jobId);
assert.throws(()=>cancelPayload('invalid'),/Invalid processor job ID/);
