import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const source = await readFile('src/servicenow/page/list-context.ts', 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
function read(window, document = { querySelector: () => null }, frameOnly = false) {
  const sandbox = { exports: {}, window, document, URL };
  vm.runInNewContext(outputText, sandbox);
  return JSON.parse(JSON.stringify(sandbox.exports.readListContext(frameOnly)));
}
assert.deepEqual(read({ g_list: { getTableName: () => 'incident', getQuery: () => 'active=true', grandTotalRows: 42 } }),
  { table: 'incident', filter: 'active=true', rowCount: 42 });
assert.deepEqual(read({}, { querySelector: () => ({ contentWindow: { g_list: { tableName: 'cmdb_ci', filter: '', grandTotalRows: 0 } } }) }),
  { table: 'cmdb_ci', filter: '', rowCount: 0 });
assert.deepEqual(read({}), { table: null, filter: null, rowCount: null });
assert.equal(read({ g_list: { grandTotalRows: '10001' } }).rowCount, 10001);
assert.equal(read({ location: { href: 'https://example.service-now.com/incident_list.do?sysparm_view=ess' }, g_list: { tableName: 'incident' } }).view, 'ess');
assert.equal(read({ g_list: { grandTotalRows: '' } }).rowCount, null);
assert.equal(read({ g_list: { grandTotalRows: -1 } }).rowCount, null);
assert.deepEqual(read({}, { querySelector: () => ({ contentWindow: { g_list: { tableName: 'incident', grandTotalRows: 9 } } }) }, true),
  { table: null, filter: null, rowCount: null }, 'Frame-only mode must not attribute a child list to its parent frame');
assert.deepEqual(read({}, { querySelector: () => ({ get contentWindow() { throw new Error('cross-origin'); } }) }),
  { table: null, filter: null, rowCount: null });
console.log('List context: top-level, iframe, absent-list, and inaccessible-frame checks passed');
