import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function event() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => [...listeners].forEach(listener => listener(...args)),
    get size() { return listeners.size; },
  };
}

function environment({ frameId = 7, rows = 12001, navigationError = false, unknownCount = false } = {}) {
  const onCompleted = event();
  const onErrorOccurred = event();
  const onRemoved = event();
  const onMessage = event();
  const messages = [];
  let navigated = false;
  let destination;
  const chrome = {
    runtime: { id: 'test-extension', onMessage },
    action: { onClicked: event(), setBadgeText: async () => {}, setTitle: async () => {} },
    storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    alarms: { create: async () => {}, onAlarm: event() },
    downloads: { onChanged: event() },
    webNavigation: {
      onCompleted, onErrorOccurred, onBeforeNavigate: event(),
      getAllFrames: async () => [
        { frameId, url: 'https://example.service-now.com/incident_list.do?sysparm_view=ess&sysparm_first_row=101' },
        { frameId: 99, url: 'https://embedded.example/widget' },
      ],
    },
    tabs: {
      onRemoved, get: async () => ({ id: 1, url: 'https://example.service-now.com/nav_to.do' }),
      sendMessage: async (tabId, message) => { messages.push({ tabId, message }); return { opened: true }; },
    },
    scripting: {
      executeScript: async details => {
        if (details.files) return [];
        assert.equal(details.target.tabId, 1);
        assert.equal(details.target.frameIds[0], frameId);
        assert.equal(details.target.frameIds.length, 1, 'Do not target foreign-origin embedded frames');
        if (details.args[0] === true) return [{ frameId, result: {
          table: 'incident', filter: navigated ? new URL(destination).searchParams.get('sysparm_query') : 'active=true',
          rowCount: navigated ? (unknownCount ? null : rows) : 50001,
        } }];
        destination = details.args[0];
        navigated = true;
        onCompleted.emit({ tabId: 2, frameId }); // Ignore unrelated navigation.
        onCompleted.emit({ tabId: 1, frameId: frameId + 1 });
        if (navigationError) onErrorOccurred.emit({ tabId: 1, frameId });
        else onCompleted.emit({ tabId: 1, frameId });
        return [];
      },
    },
  };
  const cache = new Map();
  const globals = {
    chrome, URL, Set, Promise, clearTimeout,
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds === 250 ? 0 : milliseconds),
  };
  function load(file) {
    const fullPath = path.resolve(file);
    if (cache.has(fullPath)) return cache.get(fullPath);
    const exports = {};
    cache.set(fullPath, exports);
    const { outputText } = ts.transpileModule(readFileSync(fullPath, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    });
    vm.runInNewContext(outputText, {
      ...globals, exports,
      require: id => load(path.resolve(path.dirname(fullPath), `${id}.ts`)),
    }, { filename: fullPath });
    return exports;
  }
  return { background: load('src/extension/background.ts'), bridge: load('src/extension/browser-bridge.ts'), messages,
    onCompleted, onErrorOccurred, onRemoved, onMessage, action: chrome.action, get destination() { return destination; } };
}

for (const frameId of [0, 7]) {
  const env = environment({ frameId });
  assert.equal((await env.bridge.readTabContext(1)).frameId, frameId);
  const query = 'active=true^short_descriptionLIKEa&b+c#d^ORpriority=1';
  const refreshed = await env.background.applyQueryToTab(1, frameId, query);
  const destination = new URL(env.destination);
  assert.equal(destination.searchParams.get('sysparm_query'), query, 'Encode the query losslessly');
  assert.equal(destination.searchParams.get('sysparm_first_row'), '1', 'Reset pagination');
  assert.equal(destination.searchParams.get('sysparm_view'), 'ess', 'Preserve list view');
  assert.equal(refreshed.rowCount, 12001, 'Use the refreshed count, not the pre-navigation count');
  assert.equal(refreshed.frameId, frameId);
  assert.equal(env.messages[0].message.type, 'SN_EXPORT_OPEN');
  assert.equal(env.messages[0].message.context.filter, query);
  assert.equal(env.messages[0].message.context.rowCount, 12001);
  assert.equal(env.onCompleted.size + env.onErrorOccurred.size + env.onRemoved.size, 3, 'Clean temporary navigation listeners; retain the exporter tab-close listener');
}
const empty = environment({ rows: 0 });
assert.equal((await empty.background.applyQueryToTab(1, 7, 'sys_id=-1')).rowCount, 0);
const failed = environment({ navigationError: true });
await assert.rejects(failed.background.applyQueryToTab(1, 7, ''), /navigation failed/);
assert.equal(failed.onCompleted.size + failed.onErrorOccurred.size + failed.onRemoved.size, 3);
const unknown = environment({ unknownCount: true });
await assert.rejects(unknown.background.applyQueryToTab(1, 7, ''), /row count is unavailable/);
assert.equal(unknown.messages.length, 0, 'Do not claim a refreshed count when unavailable');
assert.throws(() => unknown.bridge.listNavigationUrl('https://other.example/incident_list.do', 'incident', ''), /valid ServiceNow/);
assert.throws(() => unknown.bridge.listNavigationUrl('https://example.service-now.com/incident_list.do', '../other', ''), /valid ServiceNow/);
let foreignResponded = false;
unknown.onMessage.emit({ type: 'SN_EXPORT_APPLY', query: '', frameId: 7 },
  { id: 'other-extension', tab: { id: 1 } }, () => { foreignResponded = true; });
assert.equal(foreignResponded, false, 'Ignore requests from another extension');
let invalidResponse;
unknown.onMessage.emit({ type: 'SN_EXPORT_APPLY', query: '', frameId: -1 },
  { id: 'test-extension', tab: { id: 1 } }, response => { invalidResponse = response; });
assert.match(invalidResponse.error, /required/);
const explicitRefresh=environment();
assert.equal((await explicitRefresh.background.refreshPanelFromList(1,7)).rowCount,50001);
assert.equal((await explicitRefresh.background.refreshPanelFromList(1)).frameId,7,'Missing-list refresh scans the current tab for a valid list');
assert.equal(explicitRefresh.destination,undefined,'Refresh from list never navigates');
const toolbar=environment();
toolbar.action.onClicked.emit({id:1,url:'https://example.service-now.com/incident_list.do'});
for(let i=0;i<100;i++)await Promise.resolve();
assert.equal(toolbar.messages[0].message.type,'SN_EXPORT_OPEN','Toolbar click opens the panel without an intermediate popup');
console.log('Apply checks passed: top-level/frame navigation, query encoding, fresh/zero counts, failures, and listener cleanup');
