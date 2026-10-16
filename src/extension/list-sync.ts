import { isServiceNowUrl, readTabContext } from './browser-bridge';

// Update an already-open panel; never inject a panel or reopen a closed one.
export function registerListSync(isApplying: (tabId: number) => boolean) {
  const epochs = new Map<string, number>();
  const isList = (url: string) => {
    try { return isServiceNowUrl(url) && /\/[A-Za-z0-9_]+_list\.do$/.test(new URL(url).pathname); }
    catch { return false; }
  };
  async function allowed(tabId: number, url: string) {
    const tab = await chrome.tabs.get(tabId);
    return !!tab.url && isServiceNowUrl(tab.url) && new URL(tab.url).origin === new URL(url).origin;
  }
  chrome.webNavigation.onBeforeNavigate.addListener(event => {
    const key = `${event.tabId}:${event.frameId}`;
    const epoch = (epochs.get(key) ?? 0) + 1;
    epochs.set(key, epoch);
    if (!isList(event.url) || isApplying(event.tabId)) return;
    void (async () => {
      if (!await allowed(event.tabId, event.url) || epochs.get(key) !== epoch) return;
      await chrome.tabs.sendMessage(event.tabId, { type: 'SN_EXPORT_LIST_LOADING', frameId: event.frameId });
    })().catch(() => {});
  });
  chrome.webNavigation.onCompleted.addListener(event => {
    if (!isList(event.url) || isApplying(event.tabId)) return;
    const key = `${event.tabId}:${event.frameId}`;
    const epoch = epochs.get(key) ?? 0;
    void (async () => {
      if (!await allowed(event.tabId, event.url)) return;
      for (let attempt = 0; attempt < 20; attempt++) {
        if ((epochs.get(key) ?? 0) !== epoch || isApplying(event.tabId)) return;
        const context = await readTabContext(event.tabId, event.frameId);
        if ((epochs.get(key) ?? 0) !== epoch) return;
        if (context?.table && context.rowCount !== null) {
          await chrome.tabs.sendMessage(event.tabId, { type: 'SN_EXPORT_LIST_CONTEXT', context });
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      await chrome.tabs.sendMessage(event.tabId, { type: 'SN_EXPORT_LIST_SYNC_ERROR', frameId: event.frameId,
        message: 'The list loaded, but its updated row count is unavailable. Reopen Export after the list is ready.' });
    })().catch(() => {});
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    for (const key of epochs.keys()) if (key.startsWith(`${tabId}:`)) epochs.delete(key);
  });
}
