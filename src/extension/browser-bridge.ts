import { readListContext, type ListContext } from '../servicenow/page/list-context';

export function isServiceNowUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.service-now.com');
  } catch { return false; }
}

export async function readTabContext(tabId: number, frameId?: number): Promise<ListContext | null> {
  let frameIds = frameId === undefined ? [] : [frameId];
  if (frameId === undefined) {
    const [tab, frames] = await Promise.all([
      chrome.tabs.get(tabId), chrome.webNavigation.getAllFrames({ tabId }),
    ]);
    if (!tab.url || !isServiceNowUrl(tab.url)) return null;
    const origin = new URL(tab.url).origin;
    // activeTab grants the top-level origin. Do not attempt to inject into
    // embedded pages belonging to a different origin.
    frameIds = (frames ?? []).filter(frame => {
      try { return new URL(frame.url).origin === origin; } catch { return false; }
    }).map(frame => frame.frameId);
    if (!frameIds.length) return null;
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds },
    world: 'MAIN', func: readListContext, args: [true],
  });
  const list = results.find(result => result.result?.table);
  return list?.result ? { ...list.result, frameId: list.frameId } : null;
}

export async function openPanelOnTab(tabId: number, context: ListContext | null, message = '') {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await chrome.tabs.sendMessage(tabId, { type: 'SN_EXPORT_OPEN', context, message });
}

export function listNavigationUrl(currentUrl: string, table: string, query: string): string {
  if (!isServiceNowUrl(currentUrl) || !/^[A-Za-z0-9_]+$/.test(table)) {
    throw new Error('A valid ServiceNow list is required.');
  }
  const url = new URL(currentUrl);
  if (!url.pathname.endsWith(`/${table}_list.do`)) {
    url.pathname = `/${table}_list.do`;
    url.search = '';
  }
  url.searchParams.set('sysparm_query', query);
  url.searchParams.set('sysparm_first_row', '1');
  url.searchParams.delete('sysparm_offset');
  url.hash = '';
  return url.href;
}
