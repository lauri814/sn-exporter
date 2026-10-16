import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=ts.transpileModule(readFileSync('src/servicenow/page/session-user.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function read(window){const scope={exports:{},window};vm.runInNewContext(source,scope);return scope.exports.pageSessionUser();}
const id='A'.repeat(32);
assert.equal(read({g_user:{userID:id}}),id.toLowerCase());
assert.equal(read({top:{gsft_main:{g_user:{userID:id}}}}),id.toLowerCase(),'Resolve the user from gsft_main even without a list-frame g_user');
assert.equal(read({parent:{g_user:{userID:id}}}),id.toLowerCase());
assert.equal(read({g_user:{userID:'invalid'}}),null);
assert.equal(read({get top(){throw new Error('foreign')},g_user:{userID:id}}),id.toLowerCase());
console.log('Session identity checks passed: content frame, gsft_main, parent fallback, and unavailable identity');
