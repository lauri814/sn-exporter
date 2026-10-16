import { pageSessionUser } from '../servicenow/page/session-user';
import { HistoryStore } from '../history/store';
import { pagePollHistory } from '../servicenow/page/history';
import type { HistoryView } from '../history/types';
import { pollingInterval } from './polling';
import { isServiceNowUrl, listNavigationUrl, readTabContext } from '../extension/browser-bridge';
import { ExportController, recoverInterruptedSubmissions } from './controller';
import { normalizeFields, planExport } from './plan';
import { FILE_TYPES, type ExportMappings, type ExportRun, type ExportSettings } from './types';
import { cancelPayload, initPayload, parseInitResponse, parsePollResponse, pollPayload } from '../servicenow/processor';
import { pageCsvAttachment } from '../servicenow/page/attachment';
import { pageProcessorRequest } from '../servicenow/page/processor-request';
import { downloadCompleted, normalizeFilenamePrefix, type DownloadSelection } from './downloads';

const STORAGE_PREFIX = 'sn-export-run:';
const ALARM = 'sn-export-poll';

export function registerExports(mappings: ExportMappings) {
  const historyStore = new HistoryStore();
  const runs = new Map<number, ExportRun>();
  const starting = new Set<number>();
  const resuming = new Set<string>();
  const downloading = new Set<string>();
  const navigationEpochs = new Map<number, number>();
  let saveChain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function publish(run: ExportRun) {
    run.revision = (run.revision ?? 0) + 1;
    const snapshot = structuredClone(run);
    const write = saveChain.then(async () => {
      if (runs.get(run.tabId)?.id !== run.id) return;
      await chrome.storage.session.set({ [STORAGE_PREFIX + run.tabId]: snapshot });
      if (snapshot.cancelRequested && snapshot.userId) await historyStore.excludeJobs(snapshot.origin, snapshot.userId,
        snapshot.jobs.filter(job => job.jobId && job.status === 'cancelled').map(job => job.jobId!));
      await historyStore.record(snapshot);
      try { await chrome.tabs.sendMessage(run.tabId, { type: 'SN_EXPORT_RUN', run: snapshot }); } catch { /* Hidden panel or navigating tab. */ }
    });
    saveChain = write.catch(() => {});
    await write;
  }

  async function request(run: ExportRun, body: string): Promise<string> {
    const tab = await chrome.tabs.get(run.tabId);
    if (!tab.url || new URL(tab.url).origin !== run.origin) {
      throw new Error('The original tab is no longer on the export instance.');
    }
    const frames = await chrome.webNavigation.getAllFrames({ tabId: run.tabId });
    const existing = frames?.find(frame => frame.frameId === run.frameId && new URL(frame.url).origin === run.origin);
    // After a top-level reload the original list frame ID may change. The root
    // page can provide the same session token while the new list frame loads.
    const frameId = existing ? run.frameId : 0;
    if (runs.get(run.tabId)?.id !== run.id || (run.status !== 'running' &&
        !(run.status === 'cancelling' && new URLSearchParams(body).get('sys_action') === 'cancel'))) throw new Error('Tracking ended after page navigation.');
    const result = await chrome.scripting.executeScript({
      target: { tabId: run.tabId, frameIds: [frameId] }, world: 'MAIN',
      func: pageProcessorRequest, args: [body],
    });
    const text = result[0]?.result;
    if (typeof text !== 'string') throw new Error('The processor response was unavailable after page navigation.');
    if (/<(?:html|!doctype|form)\b/i.test(text)) throw new Error('ServiceNow returned a page instead of processor status. Check the logged-in session.');
    return text;
  }

  const controller = new ExportController({
    submit: async (run, job) => parseInitResponse(await request(run, initPayload(run.settings, job.query, mappings))),
    poll: async (run, job) => parsePollResponse(await request(run, pollPayload(job.jobId!))),
    cancel: async (run, job) => { await request(run, cancelPayload(job.jobId!)); },
    publish,
  });

  let working = false;
  function schedule() {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    const running = [...runs.values()].filter(run => run.status === 'running');
    if (!running.length || working) return;
    const due = Math.min(...running.map(run => run.nextPollAt ?? 0));
    timer = setTimeout(() => { timer = undefined; void work(); }, Math.max(0, due - Date.now()));
  }
  async function work() {
    await ready;
    if (working) return;
    working = true;
    try {
      await Promise.all([...runs.values()].filter(run => run.status === 'running' && (run.nextPollAt ?? 0) <= Date.now()).map(async run => {
        try {
          await controller.tick(run, { pollOnly: !!run.cancelRequested });
          if (run.status === 'running' && runs.get(run.tabId)?.id === run.id) {
            run.nextPollAt = Date.now() + pollingInterval(run.settings.pollingIntervalSeconds) * 1000;
            await publish(run);
          }
        } catch (error) {
          run.status = 'paused';
          run.message = error instanceof Error ? error.message : 'Export state could not be saved. Reopen the extension to resume.';
          try { await publish(run); } catch { /* Storage failure must not trigger new submissions. */ }
        }
      }));
    } finally { working = false; schedule(); }
  }

  const ready = (async () => {
    const stored = await chrome.storage.session.get(null);
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(STORAGE_PREFIX) || !value || typeof value !== 'object' || !('jobs' in value) || !Array.isArray(value.jobs)) continue;
      const run = value as ExportRun;
      runs.set(run.tabId, run);
      recoverInterruptedSubmissions(run);
      await publish(run);
    }
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    schedule();
  })();
  // Also attach a rejection handler so a storage failure is surfaced by message
  // responses without producing an unhandled initialization rejection.
  void ready.catch(() => {});

  async function getRun(tabId: number): Promise<ExportRun | null> {
    await ready;
    const run = runs.get(tabId);
    if (!run) return null;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || new URL(tab.url).origin !== run.origin) return null;
    return structuredClone(run);
  }

  const cancelling = new Set<string>();
  async function cancelRun(tabId: number, runId: string, confirmed: boolean): Promise<ExportRun> {
    await ready;
    if (confirmed !== true) throw new Error('Confirm cancellation before cancelling export jobs.');
    const run = runs.get(tabId);
    if (!run || run.id !== runId) throw new Error('This export run is no longer available.');
    if (!['running', 'paused', 'cancelling'].includes(run.status)) return structuredClone(run);
    if (cancelling.has(runId)) throw new Error('Cancellation is already in progress.');
    cancelling.add(runId);
    try {
      await controller.cancel(run);
      schedule();
      return structuredClone(run);
    } finally { cancelling.delete(runId); }
  }

  async function resumeRun(tabId: number, runId: string): Promise<ExportRun> {
    await ready;
    const run = runs.get(tabId);
    if (!run || run.id !== runId) throw new Error('This export run is no longer available.');
    if (run.needsReview || run.jobs.some(job => job.status === 'submission_unknown' || job.status === 'submitting')) {
      throw new Error('A submission outcome is unknown. Inspect the instance; no job will be resubmitted.');
    }
    if (cancelling.has(runId)) throw new Error('Cancellation is still in progress.');
    if (resuming.has(runId)) throw new Error('Status checks are already resuming.');
    if (run.status !== 'paused') return structuredClone(run);
    if (run.jobs.some(job => job.status === 'running' && !job.jobId)) throw new Error('A running job has no known server ID. Inspect the instance.');
    resuming.add(runId);
    try {
      const [tab, frames] = await Promise.all([chrome.tabs.get(tabId), chrome.webNavigation.getAllFrames({ tabId })]);
      if (!tab.url || new URL(tab.url).origin !== run.origin ||
          !frames?.some(frame => frame.frameId === run.frameId && new URL(frame.url).origin === run.origin) || runs.get(tabId)?.id !== runId) {
        throw new Error('Return to the original logged-in list to resume status checks.');
      }
      run.status = 'running'; delete run.message;
      await publish(run);
      try { await controller.tick(run, { pollOnly: true }); }
      catch (error) {
        run.status = 'paused';
        run.message = error instanceof Error ? error.message : 'Unable to resume status checks.';
      }
      if (run.status === 'running') run.nextPollAt = Date.now() + pollingInterval(run.settings.pollingIntervalSeconds) * 1000;
      await publish(run);
      schedule();
      return structuredClone(run);
    } finally { resuming.delete(runId); }
  }

  async function startRun(tabId: number, input: Record<string, unknown>): Promise<ExportRun> {
    await ready;
    if (starting.has(tabId) || ['running', 'paused', 'cancelling'].includes(runs.get(tabId)?.status ?? '')) {
      throw new Error('This tab already has an active export. Reopen its progress panel.');
    }
    starting.add(tabId);
    const epoch = navigationEpochs.get(tabId) ?? 0;
    try {
      if (input.confirmed !== true || !Number.isInteger(input.frameId) || (input.frameId as number) < 0 ||
          !FILE_TYPES.includes(input.fileType as typeof FILE_TYPES[number]) || typeof input.fields !== 'string' ||
          typeof input.displayValues !== 'boolean' || typeof input.query !== 'string' ||
          typeof input.targetChunkSize !== 'number' || typeof input.concurrency !== 'number') {
        throw new Error('Export options are invalid.');
      }
      const [tab, context, frames] = await Promise.all([
        chrome.tabs.get(tabId), readTabContext(tabId, input.frameId as number), chrome.webNavigation.getAllFrames({ tabId }),
      ]);
      const frame = frames?.find(frame => frame.frameId === input.frameId);
      if ((navigationEpochs.get(tabId) ?? 0) !== epoch) throw new Error('The list navigated after confirmation. Reopen the panel and review again.');
      if (!tab.url || !isServiceNowUrl(tab.url) || !frame || !context?.table || context.rowCount === null ||
          new URL(frame.url).origin !== new URL(tab.url).origin) throw new Error('A logged-in ServiceNow list and row count are required.');
      if (!Number.isSafeInteger(input.expectedRowCount) || (input.expectedRowCount as number) < 0) throw new Error('A valid captured panel row count is required.');
      if (typeof input.reviewedListQuery === 'string' && input.reviewedListQuery !== (context.filter ?? '')) {
        throw new Error('The visible list filter changed after review. Review the export again.');
      }
      const url = new URL(frame.url);
      const view = url.searchParams.has('sysparm_view') ? url.searchParams.get('sysparm_view')! : undefined;
      if (input.expectedTable !== context.table || input.expectedView !== view) {
        throw new Error('The list table or view changed after confirmation. Reopen the panel and review the export again.');
      }
      const identities = await chrome.scripting.executeScript({ target: { tabId, frameIds: [input.frameId as number] }, world: 'MAIN', func: pageSessionUser });
      const userId = identities[0]?.result;
      if (typeof userId !== 'string' || !/^[a-f0-9]{32}$/i.test(userId)) {
        throw new Error('The current ServiceNow user could not be identified for batch history. Reopen a logged-in list and try again.');
      }
      if ((navigationEpochs.get(tabId) ?? 0) !== epoch) throw new Error('The list navigated after confirmation. Review the export again.');
      const settings: ExportSettings = {
        table: context.table, query: input.query,
        fileType: input.fileType as ExportSettings['fileType'], fields: normalizeFields(input.fields),
        filenamePrefix: normalizeFilenamePrefix(typeof input.filenamePrefix === 'string' ? input.filenamePrefix : context.table),
        displayValues: input.displayValues, rowCount: input.expectedRowCount as number,
        targetChunkSize: input.targetChunkSize, concurrency: input.concurrency,
        pollingIntervalSeconds: pollingInterval(input.pollingIntervalSeconds),
        ...(view !== undefined ? { view } : {}),
      };
      const run: ExportRun = {
        id: crypto.randomUUID(), tabId, userId: userId.toLowerCase(), frameId: input.frameId as number, origin: new URL(tab.url).origin,
        settings, jobs: planExport(settings), status: 'running', createdAt: Date.now(),
      };
      runs.set(tabId, run);
      await publish(run);
      schedule();
      return structuredClone(run);
    } finally { starting.delete(tabId); }
  }

  async function downloadAll(tabId: number, runId: string, filenamePrefix?: string, selection: DownloadSelection = { mode: 'all' }) {
    await ready;
    const run = runs.get(tabId);
    if (!run || run.id !== runId) throw new Error('This export run is no longer available.');
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || new URL(tab.url).origin !== run.origin) throw new Error('Return to the original ServiceNow instance to download its attachments.');
    if (downloading.has(run.id)) throw new Error('Downloads are already being requested.');
    const prefix = normalizeFilenamePrefix(filenamePrefix ?? run.settings.filenamePrefix ?? run.settings.table);
    downloading.add(run.id);
    try {
      run.settings.filenamePrefix = prefix;
      await publish(run);
      return await downloadCompleted(run, (url, filename) => chrome.downloads.download({ url, filename, conflictAction: 'uniquify' }), publish, selection);
    } finally { downloading.delete(run.id); }
  }

  async function readCsvAttachment(tabId: number, runId: string, jobId: number): Promise<string> {
    await ready;
    const run = runs.get(tabId);
    if (!run || run.id !== runId) throw new Error('This export run is no longer available.');
    if (run.settings.fileType !== 'csv') throw new Error('Only CSV attachments can be combined.');
    const job = run.jobs.find(job => job.id === jobId);
    if (job?.status !== 'completed' || !job.attachmentId) throw new Error('This completed attachment is unavailable.');
    const [tab, frames] = await Promise.all([chrome.tabs.get(tabId), chrome.webNavigation.getAllFrames({ tabId })]);
    if (!tab.url || new URL(tab.url).origin !== run.origin) throw new Error('Return to the original ServiceNow instance.');
    const frame = frames?.find(frame => frame.frameId === run.frameId && new URL(frame.url).origin === run.origin);
    if (!frame || runs.get(tabId)?.id !== runId) throw new Error('The original list is no longer available.');
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [run.frameId] }, world: 'MAIN',
      func: pageCsvAttachment, args: [job.attachmentId],
    });
    if (runs.get(tabId)?.id !== runId) throw new Error('The list changed while combining files.');
    const text = results[0]?.result;
    if (typeof text !== 'string') throw new Error('The CSV attachment could not be read.');
    return text;
  }

  async function removeHistory(tabId: number, history: HistoryView, selection: { all?: boolean; batchId?: string; pollId?: string }) {
    await ready;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !isServiceNowUrl(tab.url) || !history || history.origin !== new URL(tab.url).origin ||
        !/^[a-f0-9]{32}$/i.test(history.userId) || !Array.isArray(history.batches) ||
        !Array.isArray(history.records) || !Array.isArray(history.attachments)) throw new Error('Refresh history on the current instance before removing items.');
    if (!selection || (selection.all !== true && typeof selection.batchId !== 'string' && typeof selection.pollId !== 'string')) throw new Error('Choose a history item to remove.');
    // Removal only needs the displayed snapshot and extension storage, not a native query.
    return historyStore.remove(history, selection);
  }

  async function getHistory(tabId: number): Promise<HistoryView> {
    await ready;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !isServiceNowUrl(tab.url)) throw new Error('Open a logged-in ServiceNow instance.');
    const origin = new URL(tab.url).origin, fetchedAt = Date.now();
    const result = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN', func: pagePollHistory, args: [await historyStore.queryCache(origin)] });
    const history = result[0]?.result;
    const currentTab = await chrome.tabs.get(tabId);
    if (!currentTab.url || new URL(currentTab.url).origin !== origin) throw new Error('The instance changed while reading history.');
    if (!history?.userId || !Array.isArray(history.records) || !Array.isArray(history.attachments)) throw new Error('History is unavailable in this session.');
    // Server-readable poll IDs prove ownership. Refresh must repair available
    // live/session snapshots even if their archive cache says "already saved".
    const readable = new Set(history.records.map(record => record.jobId));
    for (const run of runs.values()) {
      if (run.origin !== origin || !run.jobs.some(job => job.jobId && readable.has(job.jobId))) continue;
      if (run.userId !== history.userId) { run.userId = history.userId; await publish(run); }
      await historyStore.record(run, { force: true });
    }
    return historyStore.reconcile(origin, history, fetchedAt);
  }

  async function openHistoryList(tabId: number, batchId: string) {
    const history = await getHistory(tabId);
    const batch = history.batches.find(batch => batch.id === batchId);
    if (!batch) throw new Error('This batch is no longer available in the current session.');
    const url = new URL(listNavigationUrl(`${history.origin}/${batch.settings.table}_list.do`, batch.settings.table, batch.settings.query));
    if (batch.settings.view !== undefined) url.searchParams.set('sysparm_view', batch.settings.view);
    const result = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN',
      func: (destination: string) => {
        const frame = document.querySelector<HTMLIFrameElement>('iframe#gsft_main');
        if (!frame) return false;
        frame.src = destination;
        return true;
      }, args: [url.href] });
    if (result[0]?.result !== true) await chrome.tabs.update(tabId, { url: url.href });
    return { opened: true };
  }

  async function historyFile(tabId: number, attachmentId: string) {
    const history = await getHistory(tabId);
    const attachment = history.attachments.find(file => file.sysId === attachmentId);
    const record = attachment && history.records.find(record => record.sysId === attachment.pollId);
    if (!attachment || record?.state.toLowerCase() !== 'complete') throw new Error('This completed file is no longer available in the current session.');
    return { history, attachment };
  }

  async function downloadHistoryFile(tabId: number, attachmentId: string) {
    const { history, attachment } = await historyFile(tabId, attachmentId);
    // Reject path components rather than allowing attachment metadata to select folders.
    const filename = attachment.fileName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'export';
    await chrome.downloads.download({ url: new URL('/sys_attachment.do?sys_id=' + attachment.sysId, history.origin).href,
      filename, conflictAction: 'uniquify' });
    return { requested: 1 };
  }

  async function readHistoryCsv(tabId: number, attachmentId: string) {
    const { attachment } = await historyFile(tabId, attachmentId);
    if (!/\.csv$/i.test(attachment.fileName)) throw new Error('Only CSV attachments can be combined.');
    const result = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN',
      func: pageCsvAttachment, args: [attachment.sysId] });
    if (typeof result[0]?.result !== 'string') throw new Error('The CSV attachment could not be read.');
    return { text: result[0].result };
  }

  async function recordCsvCounts(tabId: number, runId: string, counts: { jobId: number; rows: number }[]): Promise<ExportRun> {
    await ready;
    const run = runs.get(tabId);
    if (!run || run.id !== runId) throw new Error('This export run is no longer available.');
    if (run.settings.fileType !== 'csv' || !Array.isArray(counts) || !counts.length ||
        new Set(counts.map(item => item?.jobId)).size !== counts.length ||
        !counts.every(item => item && Number.isSafeInteger(item.rows) && item.rows >= 0 &&
          run.jobs.some(job => job.id === item.jobId && job.status === 'completed' && job.attachmentId))) {
      throw new Error('CSV verification requires unique, valid row counts for completed attachments.');
    }
    for (const item of counts) run.jobs.find(job => job.id === item.jobId)!.fileRowCount = item.rows;
    run.csvVerifiedAt = Date.now();
    await publish(run);
    return structuredClone(run);
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return;
    const tabId = sender.tab.id;
    let action: Promise<unknown>;
    if (message?.type === 'SN_EXPORT_GET_RUN') action = getRun(tabId).then(run => ({ run }));
    else if (message?.type === 'SN_EXPORT_HISTORY') action = getHistory(tabId).then(history => ({ history }));
    else if (message?.type === 'SN_EXPORT_HISTORY_REMOVE') action = removeHistory(tabId, message.history, message.selection).then(history => ({ history }));
    else if (message?.type === 'SN_EXPORT_HISTORY_OPEN_LIST') action = openHistoryList(tabId, message.batchId);
    else if (message?.type === 'SN_EXPORT_HISTORY_DOWNLOAD') action = downloadHistoryFile(tabId, message.attachmentId);
    else if (message?.type === 'SN_EXPORT_HISTORY_CSV') action = readHistoryCsv(tabId, message.attachmentId);
    else if (message?.type === 'SN_EXPORT_CANCEL') action = cancelRun(tabId, message.runId, message.confirmed).then(run => ({ run }));
    else if (message?.type === 'SN_EXPORT_RESUME') action = resumeRun(tabId, message.runId).then(run => ({ run }));
    else if (message?.type === 'SN_EXPORT_START') action = startRun(tabId, message.options ?? {}).then(run => ({ run }));
    else if (message?.type === 'SN_EXPORT_DOWNLOAD_ALL') action = downloadAll(tabId, message.runId, message.filenamePrefix);
    else if (message?.type === 'SN_EXPORT_RETRY_DOWNLOADS') action = downloadAll(tabId, message.runId, message.filenamePrefix, { mode: 'failed' });
    else if (message?.type === 'SN_EXPORT_DOWNLOAD_JOB') action = downloadAll(tabId, message.runId, message.filenamePrefix, { mode: 'job', jobId: message.jobId });
    else if (message?.type === 'SN_EXPORT_CSV_COUNTS') action = recordCsvCounts(tabId, message.runId, message.counts).then(run => ({ run }));
    else if (message?.type === 'SN_EXPORT_READ_CSV') action = readCsvAttachment(tabId, message.runId, message.jobId).then(text => ({ text }));
    else if (message?.type === 'SN_EXPORT_PANEL_CLOSED') {
      respond({ accepted: true }); return;
    } else return;
    void action.then(respond, error => respond({ error: error instanceof Error ? error.message : 'The export operation failed.' }));
    return true;
  });

  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void work(); });
  async function forgetRun(tabId: number, frameId?: number) {
      await ready;
      const run = runs.get(tabId);
      if (!run || (frameId !== undefined && frameId !== 0 && frameId !== run.frameId)) return;
      run.status = 'paused'; // Prevent the current tick from filling more slots.
      runs.delete(tabId);
      const removal = saveChain.then(async () => {
        if (!runs.has(tabId)) await chrome.storage.session.remove(STORAGE_PREFIX + tabId);
      });
      saveChain = removal.catch(() => {});
      await removal;
  }
  chrome.webNavigation.onBeforeNavigate.addListener(event => {
    navigationEpochs.set(event.tabId, (navigationEpochs.get(event.tabId) ?? 0) + 1);
    void forgetRun(event.tabId, event.frameId).catch(() => {});
  });
  chrome.downloads.onChanged.addListener(change => {
    void ready.then(async () => {
      for (const run of runs.values()) {
        const job = run.jobs.find(job => job.downloadId === change.id);
        if (!job || !change.state) continue;
        job.downloadState = change.state.current as typeof job.downloadState;
        if (change.state.current === 'interrupted') job.downloadError = change.error?.current ?? 'Download interrupted.';
        if (change.state.current === 'complete') delete job.downloadError;
        await publish(run);
      }
    }).catch(() => {});
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    void forgetRun(tabId).catch(() => {});
  });
  return { getHistory, removeHistory, openHistoryList, downloadHistoryFile, readHistoryCsv, getRun, cancelRun, resumeRun, startRun, downloadAll, readCsvAttachment, recordCsvCounts };
}
