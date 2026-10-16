import { isServiceNowUrl, listNavigationUrl, openPanelOnTab, readTabContext } from './browser-bridge';
import type { ListContext } from '../servicenow/page/list-context';
import { registerListSync } from './list-sync';
import { registerExports } from '../export/runtime';

// XLSX comes from the working POC. Other mappings are the user's unverified
// values and still need validation on a real instance.
registerExports({ csv: 'unload_csv', xlsx: 'unload_excel_xlsx', xml: 'unload_xml', json: 'unload_json' });

// Own navigation here because the panel's document can be replaced.
const applyingTabs = new Set<number>();
registerListSync(tabId => applyingTabs.has(tabId));

chrome.action.onClicked.addListener(tab => {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  void (async () => {
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: 'ServiceNow exporter' });
    try {
      if (!tab.url || !isServiceNowUrl(tab.url)) throw new Error('Open an HTTPS ServiceNow instance tab.');
      await openPanelOnTab(tabId, await readTabContext(tabId));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to open the export panel.';
      await chrome.action.setBadgeText({ tabId, text: '!' });
      await chrome.action.setTitle({ tabId, title: message });
    }
  })().catch(() => {});
});

async function reloadListFrame(tabId: number, frameId: number, url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanUp = () => {
      clearTimeout(timer);
      chrome.webNavigation.onCompleted.removeListener(completed);
      chrome.webNavigation.onErrorOccurred.removeListener(failed);
      chrome.tabs.onRemoved.removeListener(removed);
    };
    const completed = (event: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (event.tabId !== tabId || event.frameId !== frameId) return;
      cleanUp();
      resolve();
    };
    const failed = (event: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
      if (event.tabId !== tabId || event.frameId !== frameId) return;
      cleanUp();
      reject(new Error('The ServiceNow list navigation failed. Reload the list and try again.'));
    };
    const removed = (removedTabId: number) => {
      if (removedTabId !== tabId) return;
      cleanUp();
      reject(new Error('The ServiceNow tab was closed.'));
    };
    const timer = setTimeout(() => {
      cleanUp();
      reject(new Error('The list refresh did not finish within 30 seconds. Reopen the panel after it loads.'));
    }, 30_000);
    chrome.webNavigation.onCompleted.addListener(completed);
    chrome.webNavigation.onErrorOccurred.addListener(failed);
    chrome.tabs.onRemoved.addListener(removed);
    // Navigation can destroy the executeScript result channel. Navigation
    // completion/error events, rather than its return value, decide success.
    void chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] }, world: 'MAIN',
      func: (destination: string) => { window.location.assign(destination); }, args: [url],
    }).catch(() => { /* Wait for the navigation event or timeout. */ });
  });
}

export async function applyQueryToTab(tabId: number, frameId: number, query: string): Promise<ListContext> {
  const [tab, frames, context] = await Promise.all([
    chrome.tabs.get(tabId), chrome.webNavigation.getAllFrames({ tabId }), readTabContext(tabId, frameId),
  ]);
  const frame = frames?.find(item => item.frameId === frameId);
  if (!tab.url || !isServiceNowUrl(tab.url) || !frame || !context?.table) {
    throw new Error('The original ServiceNow list is no longer available. Reopen the panel on a list.');
  }
  const destination = listNavigationUrl(frame.url, context.table, query);
  await reloadListFrame(tabId, frameId, destination);
  for (let attempt = 0; attempt < 20; attempt++) {
    const refreshed = await readTabContext(tabId, frameId);
    if (refreshed?.table && refreshed.rowCount !== null) {
      await openPanelOnTab(tabId, refreshed, 'List refreshed. Row count and chunk count updated.');
      return refreshed;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('The page loaded, but its list row count is unavailable. Check your session and reopen the panel.');
}

export async function refreshPanelFromList(tabId: number, frameId?: number): Promise<ListContext> {
  const [tab, frames] = await Promise.all([chrome.tabs.get(tabId), chrome.webNavigation.getAllFrames({ tabId })]);
  if (frameId === undefined) {
    const context = await readTabContext(tabId);
    if (!context?.table || context.rowCount === null) throw new Error('Unable to read list details. Open a list view or use Refresh page to try again.');
    return context;
  }
  const frame = frames?.find(frame => frame.frameId === frameId);
  if (!tab.url || !isServiceNowUrl(tab.url) || !frame || new URL(frame.url).origin !== new URL(tab.url).origin) {
    throw new Error('A list on the current ServiceNow instance is required.');
  }
  const context = await readTabContext(tabId, frameId);
  if (!context?.table || context.rowCount === null) throw new Error('The current list filter and row count are unavailable.');
  return context;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'SN_EXPORT_REFRESH_LIST') {
    if (sender.tab?.id === undefined || (message.frameId !== undefined && (!Number.isInteger(message.frameId) || message.frameId < 0))) {
      respond({ error: 'A list tab and frame are required.' }); return;
    }
    void refreshPanelFromList(sender.tab.id, message.frameId).then(context => respond({ context }),
      error => respond({ error: error instanceof Error ? error.message : 'Unable to read the list.' }));
    return true;
  }
  if (message?.type !== 'SN_EXPORT_APPLY') return;
  const tabId = sender.tab?.id;
  if (tabId === undefined || typeof message.query !== 'string' || !Number.isInteger(message.frameId) || message.frameId < 0) {
    respond({ error: 'A list tab, frame, and encoded query are required.' });
    return;
  }
  if (applyingTabs.has(tabId)) {
    respond({ error: 'A list refresh is already in progress.' });
    return;
  }
  applyingTabs.add(tabId);
  void applyQueryToTab(tabId, message.frameId, message.query).then(
    () => respond({ completed: true }),
    async error => {
      const text = error instanceof Error ? error.message : 'Unable to refresh the ServiceNow list.';
      try { await openPanelOnTab(tabId, await readTabContext(tabId), text); } catch { /* Tab may have closed or navigated away. */ }
      respond({ error: text });
    },
  ).finally(() => applyingTabs.delete(tabId));
  return true;
});
