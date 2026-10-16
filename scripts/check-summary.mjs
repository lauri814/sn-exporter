import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
function load(file) {
  const exports={};
  vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
    {exports,require:id=>load(path.resolve(path.dirname(file),id+'.ts'))});
  return exports;
}
const {exportSummary}=load('src/export/summary.ts');
const run={settings:{rowCount:200},jobs:[{totalRows:100},{totalRows:100}]};
let summary=exportSummary(run);assert.equal(summary.allReported,true);assert.equal(summary.allVerified,false);assert.equal(summary.warnings.length,0);
summary=exportSummary({...run,jobs:[{}, {totalRows:100}]});assert.equal(summary.allReported,false);assert.equal(summary.reportedRows,100);assert.equal(summary.warnings.length,0);
summary=exportSummary({...run,jobs:[{totalRows:100,fileRowCount:100},{totalRows:100,fileRowCount:99}]});assert.equal(summary.verifiedRows,199);assert.equal(summary.warnings.length,2);
summary=exportSummary({...run,jobs:[{totalRows:12000,fileRowCount:10000}]});assert.ok(summary.warnings.some(text=>text.includes('truncated')));
summary=exportSummary({settings:{rowCount:0},jobs:[{totalRows:0,fileRowCount:0}]});assert.equal(summary.allVerified,true);assert.equal(summary.verifiedRows,0);assert.equal(summary.warnings.length,0);
console.log('Completeness checks passed: unknown totals, count mismatches, truncation risk, and verified empty files');

const {elapsedTime}=load('src/export/timing.ts');
assert.equal(elapsedTime(1000,undefined,6000),'5s');
assert.equal(elapsedTime(1000,63000,999999),'1m 02s','Completed batch timing stays fixed');
assert.equal(elapsedTime(0,3661000,9999999),'1h 01m 01s');
assert.equal(elapsedTime(1000,undefined,9000,true),'Unavailable');
assert.equal(elapsedTime(1000,undefined,0),'0s','Clamp backwards clock adjustments');
