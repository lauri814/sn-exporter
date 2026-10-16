import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const scope={exports:{},Blob,Error};
vm.runInNewContext(ts.transpileModule(readFileSync('src/export/csv-combiner.ts','utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText,scope);
const {CsvCombiner}=scope.exports;
const combined=new CsvCombiner();
combined.append('\uFEFF"number","description"\r\n"0001","comma, and a ""quote"""\r\n');
combined.append('\uFEFFnumber,description\n"0002","line one\nline two"');
combined.append('number,description\r\n'); // Header-only chunk.
assert.equal(combined.rowCount,2,'Headers and quoted line breaks do not inflate row counts');
const bytes=new Uint8Array(await combined.finish().arrayBuffer());
assert.deepEqual([...bytes.slice(0,3)],[239,187,191],'Preserve one UTF-8 BOM');
assert.equal(await combined.finish().text(),'"number","description"\r\n"0001","comma, and a ""quote"""\r\n"0002","line one\nline two"\r\n');
assert.throws(()=>combined.append('description,number\nx,y'),/headers differ/);
for(const text of ['a,b\n1,2,3','a,b\n"unclosed,x','a,b\n"closed"bad,x','a,b\nun"expected,x','']) {
  assert.throws(()=>new CsvCombiner().append(text),/CSV|empty/);
}
assert.throws(()=>new CsvCombiner().finish(),/No CSV/);
const emptyValues=new CsvCombiner();emptyValues.append('a,b\n,\n');
assert.equal(await emptyValues.finish().text(),'a,b\r\n,\r\n');
const singleColumn=new CsvCombiner();singleColumn.append('description\n\n');
assert.equal(singleColumn.rowCount,1,'Empty single-column value counts as a data row');
assert.equal(await singleColumn.finish().text(),'description\r\n\r\n','Preserve an empty value in a single-column export');
console.log('CSV checks passed: one matching header, BOM, commas/quotes, multiline values, empty chunks, and malformed/mismatched rejection');
