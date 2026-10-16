import { canCombineBatch } from '../ui/history-view';
import { ProgressiveCsv } from '../export/progressive-csv';
import { CsvCombiner } from '../export/csv-combiner';
import { normalizeFilenamePrefix } from '../export/downloads';
import { ExportPanel } from '../ui/panel';

export function installContent() {
  const scope = globalThis as typeof globalThis & { __snExporterContentInstalled?: boolean };
  if (scope.__snExporterContentInstalled) return;
  scope.__snExporterContentInstalled = true;
  // Keep the actual class instance. Firefox's DOM Xray wrappers do not expose
  // custom JS methods when an element is retrieved through document APIs.
  let panel: ExportPanel | undefined;
  let progressive: ProgressiveCsv | undefined;
  const updateCombining = () => {
    const run = panel?.run;
    if (!run || !progressive?.active) return;
    if (run.id !== progressive.runId) { progressive.stop(); progressive = undefined; return; }
    panel!.csvProgress(progressive.rows, progressive.files, run.jobs.length);
    void progressive.update(run);
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'SN_EXPORT_RUN') {
      panel?.receiveRun(message.run);
      updateCombining();
      return;
    }
    if (message?.type === 'SN_EXPORT_LIST_LOADING' || message?.type === 'SN_EXPORT_LIST_SYNC_ERROR') {
      if (panel?.isConnected && panel.context?.frameId === message.frameId) {
        if (message.type === 'SN_EXPORT_LIST_LOADING') { progressive?.stop(); progressive = undefined; panel.listLoading(); }
        else panel.operationFailed(message.message);
      }
      return;
    }
    if (message?.type === 'SN_EXPORT_LIST_CONTEXT') {
      if (panel?.isConnected && (!panel.context?.table || panel.context.frameId === message.context?.frameId)) panel.syncListContext(message.context);
      return;
    }
    if (message?.type !== 'SN_EXPORT_OPEN') return;
    if (!panel?.isConnected) {
      panel = new ExportPanel();
      const current = panel;
      current.addEventListener('sn-export-history', async () => {
        try {
          const response = await chrome.runtime.sendMessage({ type: 'SN_EXPORT_HISTORY' });
          if (response?.error) current.historyFailed(response.error);
          else if (response?.history) current.receiveHistory(response.history);
          else current.historyFailed('History is unavailable in this session.');
        } catch { current.historyFailed('Unable to read history. Check your ServiceNow session and refresh.'); }
      });
      current.addEventListener('sn-export-history-remove', async event => {
        try {
          const response = await chrome.runtime.sendMessage({ type: 'SN_EXPORT_HISTORY_REMOVE', selection: (event as CustomEvent).detail, history: current.history });
          if (response?.error) current.historyFailed(response.error);
          else if (response?.history) {
            current.receiveHistory(response.history);
            current.historyActionFinished('Removed from local history. ServiceNow records and files are unchanged.');
          } else current.historyFailed('Unable to update local history.');
        } catch { current.historyFailed('Unable to update local history.'); }
      });
      current.addEventListener('sn-export-history-open-list', async event => {
        try {
          const response = await chrome.runtime.sendMessage({ type: 'SN_EXPORT_HISTORY_OPEN_LIST', batchId: (event as CustomEvent).detail.batchId });
          if (response?.error) current.historyFailed(response.error);
          else current.historyActionFinished('Saved list opened. Once it loads, use Rerun to load the batch settings for review.');
        } catch { current.historyFailed('Unable to open the saved list.'); }
      });
      current.addEventListener('sn-export-history-download', async event => {
        try {
          const response = await chrome.runtime.sendMessage({ type: 'SN_EXPORT_HISTORY_DOWNLOAD', attachmentId: (event as CustomEvent).detail.attachmentId });
          if (response?.error) current.historyFailed(response.error);
          else current.historyActionFinished('File download requested.');
        } catch { current.historyFailed('The history file could not be downloaded. Refresh history to check its availability.'); }
      });
      current.addEventListener('sn-export-history-combine', async event => {
        try {
          const response = await chrome.runtime.sendMessage({ type: 'SN_EXPORT_HISTORY' });
          if (response?.error) throw new Error(response.error);
          const history = response?.history;
          const batch = history?.batches.find((item: { id: string }) => item.id === (event as CustomEvent).detail.batchId);
          if (!history || !batch || !canCombineBatch(history, batch)) throw new Error('All batch CSV attachments must still be available in this session.');
          const combined = new CsvCombiner();
          const jobs = [...batch.jobs].sort((a, b) => a.number - b.number);
          for (let index = 0; index < jobs.length; index++) {
            const record = history.records.find((record: { jobId: string }) => record.jobId === jobs[index].jobId)!;
            const file = history.attachments.find((file: { pollId: string }) => file.pollId === record.sysId)!;
            const response = await chrome.runtime.sendMessage({ type: 'SN_EXPORT_HISTORY_CSV', attachmentId: file.sysId });
            if (response?.error || typeof response?.text !== 'string') throw new Error(response?.error ?? 'A CSV attachment could not be read.');
            combined.append(response.text);
            current.historyProgress(`Combining CSV files: ${index + 1} of ${jobs.length}.`);
          }
          const url = URL.createObjectURL(combined.finish());
          const link = document.createElement('a');
          link.href = url; link.download = normalizeFilenamePrefix(batch.settings.filenamePrefix ?? batch.settings.table) + '.csv';
          document.body.append(link);
          try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
          current.receiveHistory(history);
          current.historyActionFinished(`Combined CSV download requested: ${combined.rowCount.toLocaleString()} data rows; original batch count ${batch.settings.rowCount.toLocaleString()}.${combined.rowCount !== batch.settings.rowCount ? ' Row count differs from the original batch.' : ''}`);
        } catch (error) { current.historyFailed(error instanceof Error ? error.message : 'Unable to combine history files.'); }
      });
      current.addEventListener('sn-export-apply', async event => {
        try {
          const response = await chrome.runtime.sendMessage({
            type: 'SN_EXPORT_APPLY', query: (event as CustomEvent).detail.query, frameId: current.context?.frameId,
          });
          if (response?.error) current.operationFailed(response.error);
        } catch {
          if (current.isConnected && current.applying) current.operationFailed('The refresh handler disconnected. Reopen the panel after the list loads.');
        }
      });
      current.addEventListener('sn-export-refresh-list', async event => {
        try {
          const response = await chrome.runtime.sendMessage({ type: 'SN_EXPORT_REFRESH_LIST', frameId: (event as CustomEvent).detail.frameId });
          if (response?.error) current.operationFailed(response.error);
          else if (response?.context) current.importListContext(response.context);
          else current.operationFailed('The current list filter and count are unavailable.');
        } catch { current.operationFailed('Unable to read the list filter and row count.'); }
      });
      current.addEventListener('sn-export-cancel', async event => {
        try {
          const response = await chrome.runtime.sendMessage({ type: 'SN_EXPORT_CANCEL', ...(event as CustomEvent).detail });
          if (response?.error) current.operationFailed(response.error);
          else current.receiveRun(response.run);
        } catch { current.operationFailed('Unable to cancel export jobs. Check the session and retry cancellation.'); }
      });
      current.addEventListener('sn-export-resume', async event => {
        try {
          const response = await chrome.runtime.sendMessage({ type: 'SN_EXPORT_RESUME', runId: (event as CustomEvent).detail.runId });
          if (response?.error) current.operationFailed(response.error);
          else current.receiveRun(response.run);
        } catch { current.operationFailed('Unable to resume status checks. Check the logged-in session and try again.'); }
      });
      current.addEventListener('sn-export-start', async event => {
        try {
          const response = await chrome.runtime.sendMessage({ type: 'SN_EXPORT_START', options: (event as CustomEvent).detail });
          if (response?.error) current.operationFailed(response.error);
          else current.receiveRun(response.run);
        } catch { current.operationFailed('Unable to start the export. Reopen the panel to check whether a run was recorded before trying again.'); }
      });
      for (const [eventName, type] of [['sn-export-download-all', 'SN_EXPORT_DOWNLOAD_ALL'], ['sn-export-retry-downloads', 'SN_EXPORT_RETRY_DOWNLOADS'], ['sn-export-download-job', 'SN_EXPORT_DOWNLOAD_JOB']]) {
      current.addEventListener(eventName, async event => {
        try {
          const response = await chrome.runtime.sendMessage({ type, runId: (event as CustomEvent).detail.runId, filenamePrefix: (event as CustomEvent).detail.filenamePrefix, jobId: (event as CustomEvent).detail.jobId });
          if (response?.error) current.operationFailed(response.error);
          else current.downloadsRequested(response.requested, response.failed);
        } catch { current.operationFailed('Unable to request downloads.'); }
      });
      }
      current.addEventListener('sn-export-download-combined', event => {
        const { runId, filenamePrefix } = (event as CustomEvent).detail;
        const run = current.run;
        if (!run || run.id !== runId || run.settings.fileType !== 'csv' ||
            (run.jobs.filter(job => job.status === 'completed' && job.attachmentId).length < 2 &&
             !run.jobs.every(job => job.status === 'completed' && job.attachmentId))) {
          current.csvFailed('At least two CSV jobs must complete before starting progressive combining.'); return;
        }
        if (progressive?.active && progressive.runId === runId) return;
        progressive?.stop();
        const session = new ProgressiveCsv(run, {
          read: async jobId => {
            const response = await chrome.runtime.sendMessage({ type: 'SN_EXPORT_READ_CSV', runId, jobId });
            if (response?.error) throw new Error(response.error);
            if (typeof response?.text !== 'string') throw new Error('The CSV attachment could not be read.');
            return response.text;
          },
          record: async (jobId, rows) => {
            const response = await chrome.runtime.sendMessage({ type: 'SN_EXPORT_CSV_COUNTS', runId, counts: [{ jobId, rows }] });
            if (response?.error) throw new Error(response.error);
            if (!session.active) return;
            if (response?.run) {
              if (panel && panel.run?.id === runId) panel.receiveRun(response.run);
              void session.update(panel && panel.run?.id === runId ? panel.run : response.run);
            }
          },
          progress: (rows, files, total) => { if (panel && panel.run?.id === runId) panel.csvProgress(rows, files, total); },
          complete: (file, files) => {
            const prefix = panel && panel.run?.id === runId ? panel.filenamePrefix : filenamePrefix;
            const filename = normalizeFilenamePrefix(prefix) + '.csv';
            const url = URL.createObjectURL(file);
            const link = document.createElement('a');
            link.href = url; link.download = filename;
            document.body.append(link);
            try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
            if (panel && panel.run?.id === runId) panel.combinedRequested(files);
            if (progressive === session) progressive = undefined;
          },
          failed: message => {
            if (panel && panel.run?.id === runId) panel.csvFailed(message);
            if (progressive === session) progressive = undefined;
          },
        });
        progressive = session;
        void session.update(run);
      });
      document.body.append(current.element);
    }
    panel.receiveContext(message.context ?? null, message.message ?? '');
    const current = panel;
    void chrome.runtime.sendMessage({ type: 'SN_EXPORT_GET_RUN' }).then(response => {
      if (response?.error) current.operationFailed(response.error); else { current.receiveRun(response?.run ?? null); updateCombining(); }
    }).catch(() => current.operationFailed('Export tracking is unavailable. Reload the extension and reopen the panel.'));
    respond({ opened: true });
  });
}
