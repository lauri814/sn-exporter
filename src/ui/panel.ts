import { elapsedTime } from '../export/timing';
import { jobProgress } from './job-progress';
import { activity } from './activity';
import { historyView, canCombineBatch } from './history-view';
import type { HistoryView, HistoryBatch } from '../history/types';
import { exportSummary } from '../export/summary';
import { html, render } from 'lit';
import styles from 'virtual:panel-styles';
import { DEFAULT_POLL_INTERVAL_SECONDS, pollingInterval } from '../export/polling';
import { downloadCounts, normalizeFilenamePrefix } from '../export/downloads';
import type { ListContext } from '../servicenow/page/list-context';
import { ASSUMED_EXPORT_LIMIT, DEFAULT_CHUNK_SIZE, chunkCount, normalizeFields } from '../export/plan';
import { supportsFieldSelection, FILE_TYPES, type FileType, type ExportRun, type ExportSettings } from '../export/types';

export class ExportPanel {
  static properties = {
    clockNow: { state: true }, csvCombining: { state: true }, csvRows: { state: true }, csvFiles: { state: true }, csvMessage: { state: true }, cancelConfirmation: { state: true }, cancelling: { state: true }, darkMode: { state: true }, activeTab: { state: true }, history: { state: true }, historyBusy: { state: true }, historyActionBusy: { state: true }, historyMessage: { state: true }, minimized: { state: true },
    listContext: { state: true }, listRefreshing: { state: true }, context: { state: true }, query: { state: true }, fileType: { state: true }, fields: { state: true }, filenamePrefix: { state: true },
    displayValues: { state: true }, targetChunkSize: { state: true }, concurrency: { state: true },
    applying: { state: true }, message: { state: true }, run: { state: true }, confirmation: { state: true },
    pollingIntervalSeconds: { state: true }, resuming: { state: true }, starting: { state: true }, loadingRun: { state: true }, downloading: { state: true },
  };
  declare clockNow: number;
  private clockTimer?: ReturnType<typeof setInterval>;
  declare csvCombining: boolean;
  declare csvRows: number;
  declare csvFiles: number;
  declare csvMessage: string;
  declare cancelConfirmation: string | null;
  declare cancelling: boolean;
  declare darkMode: boolean;
  declare activeTab: 'export' | 'history';
  declare history: HistoryView | null;
  declare historyBusy: boolean;
  declare historyActionBusy: boolean;
  declare historyMessage: string;
  declare minimized: boolean;
  declare context: ListContext | null;
  declare listContext: ListContext | null;
  declare listRefreshing: boolean;
  declare query: string;
  declare fileType: FileType;
  declare fields: string;
  declare filenamePrefix: string;
  declare displayValues: boolean;
  declare targetChunkSize: string;
  declare concurrency: string;
  declare pollingIntervalSeconds: string;
  declare applying: boolean;
  declare message: string;
  declare run: ExportRun | null;
  declare confirmation: ExportSettings | null;
  declare starting: boolean;
  declare resuming: boolean;
  declare loadingRun: boolean;
  declare downloading: boolean;

  readonly element = document.createElement('div');
  readonly shadowRoot = this.element.attachShadow({ mode: 'open' });
  private pendingUpdate = false;
  updateComplete: Promise<boolean> = Promise.resolve(true);
  get isConnected() { return this.element.isConnected; }
  remove() { clearInterval(this.clockTimer); this.clockTimer = undefined; this.themeMedia.removeEventListener('change', this.systemThemeChanged); this.element.remove(); }
  addEventListener: HTMLElement['addEventListener'] = this.element.addEventListener.bind(this.element);
  dispatchEvent(event: Event) { return this.element.dispatchEvent(event); }

  private requestUpdate() {
    if (this.pendingUpdate) return;
    this.pendingUpdate = true;
    this.updateComplete = Promise.resolve().then(() => {
      this.pendingUpdate = false;
      render(html`<style>${styles}</style><div class=${this.darkMode ? 'dark [color-scheme:dark]' : '[color-scheme:light]'}>${this.render()}</div>`, this.shadowRoot, { host: this });
      return true;
    });
  }

  constructor() {
    this.element.setAttribute('data-sn-export-panel', '');
    // Reactive state stays in the content-script realm, outside Firefox DOM wrappers.
    for (const key of Object.keys(ExportPanel.properties)) {
      let value: unknown;
      Object.defineProperty(this, key, {
        get: () => value,
        set: next => { if (value !== next) { value = next; this.requestUpdate(); } },
      });
    }
    this.themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    this.darkMode = this.themeMedia.matches;
    this.themeMedia.addEventListener('change', this.systemThemeChanged);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      void chrome.storage.local.get('sn-export-theme').then(stored => {
        const preference = stored['sn-export-theme'];
        if (!this.themePreferenceSet && (preference === 'dark' || preference === 'light')) {
          this.themePreferenceSet = true; this.darkMode = preference === 'dark';
        }
      }).catch(() => {});
    }
    this.activeTab = 'export'; this.history = null; this.historyBusy = false; this.historyActionBusy = false; this.historyMessage = '';
    this.minimized = false;
    this.listContext = null; this.listRefreshing = false;
    this.csvCombining = false; this.csvRows = 0; this.csvFiles = 0; this.csvMessage = '';
    this.clockNow = Date.now();
    this.cancelConfirmation = null; this.cancelling = false;
    this.context = null; this.query = ''; this.fileType = 'csv'; this.fields = ''; this.filenamePrefix = '';
    this.pollingIntervalSeconds = String(DEFAULT_POLL_INTERVAL_SECONDS);
    this.displayValues = true; this.targetChunkSize = String(DEFAULT_CHUNK_SIZE); this.concurrency = '';
    this.applying = false; this.message = ''; this.run = null; this.confirmation = null;
    this.resuming = false; this.starting = false; this.loadingRun = true; this.downloading = false;
  }

  receiveContext(context: ListContext | null, message = '') {
    this.minimized = false;
    this.listContext = context; this.listRefreshing = false;
    this.csvCombining = false; this.csvRows = 0; this.csvFiles = 0; this.csvMessage = '';
    this.context = context; this.query = context?.filter ?? ''; this.fileType = 'csv'; this.fields = ''; this.filenamePrefix = context?.table ?? '';
    this.pollingIntervalSeconds = String(DEFAULT_POLL_INTERVAL_SECONDS);
    this.displayValues = true; this.targetChunkSize = String(DEFAULT_CHUNK_SIZE);
    const chunks = chunkCount(context?.rowCount ?? null);
    this.concurrency = chunks ? String(chunks) : '';
    this.run = null; this.updateClock(); this.confirmation = null; this.applying = false;
    this.resuming = false; this.starting = false; this.loadingRun = true; this.downloading = false; this.message = message;
  }

  listLoading() {
    const hadRun = !!this.run;
    this.csvCombining = false; this.csvMessage = '';
    this.listRefreshing = true; this.confirmation = null; this.run = null; this.updateClock(); this.resuming = false;
    this.starting = false; this.downloading = false;
    this.message = hadRun ? 'List reloading. Export tracking was cleared; submitted server jobs continue.' : '';
  }

  syncListContext(context: ListContext) {
    this.listContext = context; this.listRefreshing = false; this.confirmation = null;
    this.message = '';
  }

  private refreshFromList() {
    if (this.listRefreshing || this.active || this.applying || this.starting || this.downloading || this.csvCombining) return;
    this.listRefreshing = true; this.confirmation = null;
    this.dispatchEvent(new CustomEvent('sn-export-refresh-list', { detail: { frameId: this.context?.table ? this.listContext?.frameId : undefined }, bubbles: true, composed: true }));
  }

  importListContext(context: ListContext) {
    const previous = this.chunks;
    if (!this.context?.table) this.filenamePrefix = context.table ?? '';
    this.context = context; this.listContext = context; this.query = context.filter ?? '';
    this.listRefreshing = false; this.confirmation = null; this.loadingRun = false;
    const chunks = this.chunks;
    if (chunks && (!this.concurrency || Number(this.concurrency) === previous || Number(this.concurrency) > chunks)) this.concurrency = String(chunks);
    this.message = 'Filter and row count refreshed from the list.';
  }

  private updateClock() {
    this.clockNow = Date.now();
    if (this.isConnected && this.active) {
      this.clockTimer ??= setInterval(() => { this.clockNow = Date.now(); }, 1000);
    } else { clearInterval(this.clockTimer); this.clockTimer = undefined; }
  }

  receiveRun(run: ExportRun | null) {
    this.loadingRun = false;
    if (run && this.run?.id === run.id && (run.revision ?? 0) < (this.run.revision ?? 0)) return;
    if (run && this.run?.id !== run.id) this.filenamePrefix = run.settings.filenamePrefix ?? run.settings.table;
    if (this.run?.id !== run?.id) {
      this.cancelConfirmation = null; this.csvCombining = false; this.csvRows = 0; this.csvFiles = 0; this.csvMessage = '';
    }
    this.cancelling = run?.status === 'cancelling';
    this.run = run; this.resuming = false; this.starting = false; this.updateClock();
    if (run && ['running', 'paused', 'cancelling'].includes(run.status)) {
      this.query = run.settings.query; this.fileType = run.settings.fileType;
      this.fields = run.settings.fields; this.displayValues = run.settings.displayValues;
      this.pollingIntervalSeconds = String(pollingInterval(run.settings.pollingIntervalSeconds));
      this.targetChunkSize = String(run.settings.targetChunkSize); this.concurrency = String(run.settings.concurrency);
      this.confirmation = null;
    }
  }

  operationFailed(message: string) {
    this.cancelling = false;
    this.listRefreshing = false; this.applying = false; this.resuming = false; this.starting = false; this.loadingRun = false;
    this.downloading = false; this.message = message;
  }
  applyFailed(message: string) { this.operationFailed(message); }
  downloadsRequested(requested: number, failed: number) {
    this.downloading = false;
    this.message = `Requested ${requested} file download${requested === 1 ? '' : 's'}.${failed ? ` ${failed} could not be started; use Retry failed downloads to retry those files.` : ''}`;
  }
  combinedRequested(files: number) {
    this.csvCombining = false;
    this.csvMessage = `Combined CSV download requested (${files} files).`;
  }
  csvProgress(rows: number, files: number, total: number) {
    this.csvCombining = true; this.csvRows = rows; this.csvFiles = files;
    this.csvMessage = `Combining CSV files: ${files} of ${total}.`;
  }
  csvFailed(message: string) { this.csvCombining = false; this.csvMessage = message; }
  private get canCombine() {
    return this.run?.settings.fileType === 'csv' && (this.allFilesReady || this.run.jobs.filter(job => job.status === 'completed' && job.attachmentId).length >= 2) &&
      !this.run.cancelRequested && !this.run.jobs.some(job => ['failed', 'cancelled', 'submission_unknown'].includes(job.status));
  }
  private get allFilesReady() {
    return !!this.run?.jobs.length && this.run.jobs.every(job => job.status === 'completed' && !!job.attachmentId);
  }
  private get active() { return !!this.run && ['running', 'paused', 'cancelling'].includes(this.run.status); }
  private get chunks() { return chunkCount(this.context?.rowCount ?? null, Number(this.targetChunkSize)); }
  private get dirty() { return this.query !== (this.context?.filter ?? ''); }
  private get chunkError() {
    const value = Number(this.targetChunkSize);
    return !this.targetChunkSize.trim() || !Number.isSafeInteger(value) || value < 1
      ? 'Enter a positive whole-number target.' : '';
  }
  private get fieldsSupported() { return supportsFieldSelection(this.fileType); }
  private get fieldsError() {
    if (!this.fieldsSupported) return '';
    try { normalizeFields(this.fields); return ''; } catch (error) { return (error as Error).message; }
  }
  private get filenameError() {
    try { normalizeFilenamePrefix(this.filenamePrefix); return ''; } catch (error) { return (error as Error).message; }
  }
  private get concurrencyError() {
    if (!this.chunks) return '';
    const value = Number(this.concurrency);
    return !this.concurrency.trim() || !Number.isSafeInteger(value) || value < 1 || value > this.chunks
      ? `Enter a whole number from 1 to ${this.chunks}.` : '';
  }
  private get pollingError() {
    try { pollingInterval(Number(this.pollingIntervalSeconds)); return ''; } catch (error) { return (error as Error).message; }
  }
  private get cannotStart() {
    return !this.context?.table || this.context.frameId === undefined || this.active || this.applying || this.starting ||
      this.loadingRun || this.listRefreshing || this.downloading || this.csvCombining || !this.chunks || !!this.chunkError || !!this.concurrencyError || !!this.fieldsError || !!this.pollingError;
  }
  private changeChunkSize(value: string) {
    const previousMax = this.chunks;
    this.targetChunkSize = value;
    const nextMax = this.chunks;
    if (nextMax && (Number(this.concurrency) === previousMax || Number(this.concurrency) > nextMax || !this.concurrency)) {
      this.concurrency = String(nextMax);
    }
  }
  private get chunkIncrement() {
    const rows = this.context?.rowCount ?? 0;
    return rows > 10_000 ? 1_000 : rows > 1_000 ? 100 : rows > 100 ? 10 : 1;
  }
  private numberControl(id: string, label: string, value: string, max: number | undefined,
    help: string, error: string, change: (value: string) => void, disabled = false, increment = 1) {
    const number = Number(value);
    const adjust = (delta: number) => change(String(Math.min(max ?? Number.MAX_SAFE_INTEGER,
      Math.max(1, (Number.isSafeInteger(number) ? number : 1) + delta * increment))));
    const buttonClass = 'px-4 py-2 text-lg hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40';
    return html`<div class="space-y-1">
      <label class="block font-medium" for=${id}>${label}</label>
      <div class="inline-flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900">
        <button type="button" class=${buttonClass} aria-label=${`Decrease ${label}`} ?disabled=${disabled || number <= 1} @click=${() => adjust(-1)}>−</button>
        <input id=${id} class="w-16 min-w-0 border-x border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-2 text-center focus:outline-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          type="number" min="1" max=${max === undefined ? '' : max} step="1" .value=${value} ?disabled=${disabled}
          aria-describedby=${`${id}-help`} aria-invalid=${error ? 'true' : 'false'} @input=${(event: Event) => change((event.target as HTMLInputElement).value)}>
        <button type="button" class=${buttonClass} aria-label=${`Increase ${label}`} ?disabled=${disabled || number >= (max ?? Number.MAX_SAFE_INTEGER)} @click=${() => adjust(1)}>+</button>
      </div>
      <p id=${`${id}-help`} class=${error ? 'text-xs text-red-700 dark:text-red-400' : 'text-xs text-slate-500 dark:text-slate-400'}>${error || help}</p>
    </div>`;
  }
  private applyQuery() {
    if (!this.context?.table || this.active || this.applying || this.starting || this.loadingRun || this.downloading || this.csvCombining) return;
    this.applying = true; this.message = ''; this.confirmation = null;
    this.dispatchEvent(new CustomEvent('sn-export-apply', { detail: { query: this.query }, bubbles: true, composed: true }));
  }
  private reviewExport() {
    if (this.cannotStart) return;
    this.message = '';
    this.confirmation = {
      table: this.context!.table!, query: this.query, fileType: this.fileType,
      fields: this.fieldsSupported ? normalizeFields(this.fields) : '', displayValues: this.displayValues,
      pollingIntervalSeconds: pollingInterval(Number(this.pollingIntervalSeconds)),
      rowCount: this.context!.rowCount!, targetChunkSize: Number(this.targetChunkSize), concurrency: Number(this.concurrency),
      ...(this.context!.view !== undefined ? { view: this.context!.view } : {}),
    };
  }
  private confirmExport() {
    if (!this.confirmation || this.cannotStart) return;
    const settings = this.confirmation;
    this.starting = true;
    this.dispatchEvent(new CustomEvent('sn-export-start', { bubbles: true, composed: true, detail: {
      confirmed: true, frameId: this.context!.frameId,
      query: settings.query, fileType: settings.fileType, fields: settings.fields, displayValues: settings.displayValues,
      pollingIntervalSeconds: settings.pollingIntervalSeconds, targetChunkSize: settings.targetChunkSize, concurrency: settings.concurrency,
      reviewedListQuery: this.listContext?.filter ?? this.context?.filter ?? '',
      expectedTable: settings.table, expectedRowCount: settings.rowCount, expectedView: settings.view,
    } }));
    this.confirmation = null;
  }
  private confirmCancel() {
    if (!this.run || this.cancelConfirmation !== this.run.id || this.cancelling || !this.active) return;
    this.cancelConfirmation = null; this.cancelling = true;
    this.dispatchEvent(new CustomEvent('sn-export-cancel', { detail: { runId: this.run.id, confirmed: true }, bubbles: true, composed: true }));
  }
  private resumeChecks() {
    if (!this.run || this.run.status !== 'paused' || this.run.needsReview || this.resuming) return;
    this.resuming = true; this.message = '';
    this.dispatchEvent(new CustomEvent('sn-export-resume', { detail: { runId: this.run.id }, bubbles: true, composed: true }));
  }

  private downloadAll() {
    if (!this.run || this.run.status === 'running' || this.downloading || this.filenameError) return;
    this.downloading = true; this.message = '';
    this.dispatchEvent(new CustomEvent('sn-export-download-all', { detail: { runId: this.run.id, filenamePrefix: normalizeFilenamePrefix(this.filenamePrefix) }, bubbles: true, composed: true }));
  }

  private downloadJob(jobId: number) {
    const job = this.run?.jobs.find(job => job.id === jobId);
    if (!this.run || !job || job.status !== 'completed' || !job.attachmentId || this.downloading || this.filenameError ||
        (job.downloadId !== undefined && job.downloadState !== 'interrupted')) return;
    this.downloading = true; this.message = '';
    this.dispatchEvent(new CustomEvent('sn-export-download-job', {
      detail: { runId: this.run.id, jobId, filenamePrefix: normalizeFilenamePrefix(this.filenamePrefix) }, bubbles: true, composed: true,
    }));
  }

  private retryDownloads() {
    if (!this.run || this.run.status === 'running' || this.downloading || this.filenameError) return;
    this.downloading = true; this.message = '';
    this.dispatchEvent(new CustomEvent('sn-export-retry-downloads', {
      detail: { runId: this.run.id, filenamePrefix: normalizeFilenamePrefix(this.filenamePrefix) }, bubbles: true, composed: true,
    }));
  }

  private downloadCombined() {
    if (!this.run || !this.canCombine || this.csvCombining || this.filenameError) return;
    this.csvCombining = true; this.csvMessage = 'Reading CSV attachments…';
    this.dispatchEvent(new CustomEvent('sn-export-download-combined', {
      detail: { runId: this.run.id, filenamePrefix: normalizeFilenamePrefix(this.filenamePrefix) }, bubbles: true, composed: true,
    }));
  }

  private tabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tab = event.key === 'Home' ? 'export' : event.key === 'End' ? 'history' : this.activeTab === 'export' ? 'history' : 'export';
    this.selectTab(tab);
    void this.updateComplete.then(() => this.shadowRoot.querySelector<HTMLButtonElement>('#tab-' + tab)?.focus());
  }

  private selectTab(tab: 'export' | 'history') {
    this.activeTab = tab;
    if (tab === 'history') this.refreshHistory();
  }

  private refreshHistory() {
    if (this.historyBusy || this.historyActionBusy) return;
    this.historyBusy = true; this.historyMessage = '';
    this.dispatchEvent(new CustomEvent('sn-export-history', { bubbles: true, composed: true }));
  }
  receiveHistory(history: HistoryView) { this.history = history; this.historyBusy = false; this.historyMessage = ''; }
  historyFailed(message: string) { this.historyBusy = false; this.historyActionBusy = false; this.historyMessage = message; }
  historyActionFinished(message: string) { this.historyActionBusy = false; this.historyMessage = message; }
  historyProgress(message: string) { this.historyMessage = message; }

  private removeHistory(selection: { all?: boolean; batchId?: string; pollId?: string }) {
    if (this.historyBusy || this.historyActionBusy) return;
    this.historyActionBusy = true;
    this.dispatchEvent(new CustomEvent('sn-export-history-remove', { detail: selection, bubbles: true, composed: true }));
  }
  private downloadHistoryFile(attachmentId: string) {
    if (this.historyBusy || this.historyActionBusy) return;
    this.historyActionBusy = true; this.historyMessage = 'Requesting file download…';
    this.dispatchEvent(new CustomEvent('sn-export-history-download', { detail: { attachmentId }, bubbles: true, composed: true }));
  }
  private combineHistoryBatch(batch: HistoryBatch) {
    if (!this.history || !canCombineBatch(this.history, batch) || this.historyActionBusy || this.historyBusy) return;
    this.historyActionBusy = true; this.historyMessage = 'Reading CSV files…';
    this.dispatchEvent(new CustomEvent('sn-export-history-combine', { detail: { batchId: batch.id }, bubbles: true, composed: true }));
  }
  private openHistoryList(batch: HistoryBatch) {
    if (this.active || this.starting || this.downloading) {
      this.historyMessage = 'Finish the current export before navigating away.'; return;
    }
    if (this.historyBusy || this.historyActionBusy) return;
    this.historyActionBusy = true;
    this.dispatchEvent(new CustomEvent('sn-export-history-open-list', { detail: { batchId: batch.id }, bubbles: true, composed: true }));
  }

  private rerunHistoryBatch(batch: HistoryBatch) {
    if (this.active || this.starting || this.downloading) {
      this.historyMessage = 'Finish the current export before loading another batch.'; return;
    }
    if (this.listContext?.frameId === undefined || this.listRefreshing || this.listContext.table !== batch.settings.table || this.listContext.view !== batch.settings.view) {
      this.historyMessage = `Open the saved table/view using Open list with filter, then load this batch again.`; return;
    }
    const settings = batch.settings;
    const rowCount = this.listContext!.filter === settings.query ? this.listContext!.rowCount : settings.rowCount;
    this.context = { ...this.listContext!, table: settings.table, filter: settings.query, rowCount, view: settings.view };
    this.query = settings.query; this.fileType = settings.fileType; this.fields = settings.fields;
    this.displayValues = settings.displayValues; this.targetChunkSize = String(settings.targetChunkSize);
    this.concurrency = String(Math.min(settings.concurrency, chunkCount(rowCount, settings.targetChunkSize) || settings.concurrency)); this.pollingIntervalSeconds = String(pollingInterval(settings.pollingIntervalSeconds));
    this.filenamePrefix = settings.filenamePrefix ?? settings.table;
    this.run = null; this.confirmation = null; this.loadingRun = false; this.activeTab = 'export';
    this.message = 'Saved settings loaded. Review and Confirm are required to start a new batch.';
  }

  private themeMedia: MediaQueryList;
  private themePreferenceSet = false;
  private themeWrites: Promise<void> = Promise.resolve();
  private systemThemeChanged = (event: MediaQueryListEvent) => {
    if (!this.themePreferenceSet) this.darkMode = event.matches;
  };

  private toggleTheme() {
    this.themePreferenceSet = true;
    this.darkMode = !this.darkMode;
    const preference = this.darkMode ? 'dark' : 'light';
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      this.themeWrites = this.themeWrites.then(() => chrome.storage.local.set({ 'sn-export-theme': preference })).catch(() => {
        const message = 'Theme changed for this panel, but the preference could not be saved.';
        if (this.activeTab === 'history') this.historyMessage = message; else this.message = message;
      });
    }
  }

  private async setMinimized(minimized: boolean) {
    this.minimized = minimized;
    await this.updateComplete;
    this.shadowRoot.querySelector<HTMLButtonElement>(minimized ? '#restore-export' : '#minimize-export')?.focus();
  }

  render() {
    const summary = this.run ? exportSummary(this.run) : null;
    const downloads = this.run ? downloadCounts(this.run) : null;
    const completed = this.run?.jobs.filter(job => job.status === 'completed').length ?? 0;
    const cancelled = this.run?.jobs.filter(job => job.status === 'cancelled').length ?? 0;
    const failed = this.run?.jobs.filter(job => job.status === 'failed').length ?? 0;
    const unknown = this.run?.jobs.filter(job => job.status === 'submission_unknown').length ?? 0;
    const available = this.run?.jobs.filter(job => job.status === 'completed' && job.attachmentId &&
      (job.downloadId === undefined || job.downloadState === 'interrupted')).length ?? 0;
    const listDiffers = !!this.listContext && (this.listContext.table !== this.context?.table || (this.listContext.filter ?? '') !== this.query);
    const locked = this.active || this.applying || this.starting || this.loadingRun || !!this.confirmation;
    return html`${this.minimized ? html`<button id="restore-export" type="button" aria-label="Restore export panel" aria-expanded="false"
      class="fixed bottom-6 right-6 z-[2147483647] flex max-w-[calc(100vw-32px)] items-center gap-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 font-sans text-sm font-semibold text-slate-900 dark:text-slate-100 shadow-lg hover:bg-slate-50 dark:hover:bg-slate-800 focus-visible:outline-blue-600"
      @click=${() => this.setMinimized(false)}>Export
      ${this.run ? html`<span class="text-xs font-normal text-slate-600 dark:text-slate-300" role="status">${completed}/${this.run.jobs.length} jobs completed</span>` : ''}
      </button>` : ''}
      <section aria-label="ServiceNow export panel" aria-hidden=${this.minimized ? 'true' : 'false'} class="fixed bottom-6 right-6 z-[2147483647] ${this.minimized ? 'hidden' : 'flex'} max-h-[80vh] w-[640px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-sans text-sm leading-6 text-slate-900 dark:text-slate-100 shadow-2xl">

      <header class="flex shrink-0 items-center justify-between border-b border-slate-200 dark:border-slate-700 px-6 py-4"><h2 class="text-lg font-semibold">Export</h2><div class="flex items-center gap-1"><button id="toggle-dark-mode" type="button" title=${this.darkMode ? 'Switch to light mode' : 'Switch to dark mode'} aria-label=${this.darkMode ? 'Switch to light mode' : 'Switch to dark mode'} aria-pressed=${this.darkMode ? 'true' : 'false'}
        class="rounded-md px-3 py-1 text-xl text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 focus-visible:outline-blue-600" @click=${this.toggleTheme}>${this.darkMode ? '☀' : '☾'}</button><button id="minimize-export" type="button" title="Minimize" aria-label="Minimize export panel" aria-expanded="true"
        class="rounded-md px-3 py-1 text-xl text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 focus-visible:outline-blue-600" @click=${() => this.setMinimized(true)}>−</button><button class="rounded-md px-3 py-1 text-xl text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 focus-visible:outline-blue-600" aria-label="Close export panel" @click=${() => this.remove()}>×</button></div></header>
      <nav class="flex shrink-0 gap-1 border-b border-slate-200 dark:border-slate-700 px-6 py-2" role="tablist" aria-label="Export views" @keydown=${this.tabKey}>
        <button id="tab-export" role="tab" tabindex=${this.activeTab === 'export' ? '0' : '-1'} aria-selected=${this.activeTab === 'export' ? 'true' : 'false'} aria-controls="export-body" class=${this.activeTab === 'export' ? 'rounded-md bg-blue-50 dark:bg-blue-950 px-4 py-2 font-semibold text-blue-700 dark:text-blue-300' : 'rounded-md px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'} @click=${() => this.selectTab('export')}>Export</button>
        <button id="tab-history" role="tab" tabindex=${this.activeTab === 'history' ? '0' : '-1'} aria-selected=${this.activeTab === 'history' ? 'true' : 'false'} aria-controls="history-body" class=${this.activeTab === 'history' ? 'rounded-md bg-blue-50 dark:bg-blue-950 px-4 py-2 font-semibold text-blue-700 dark:text-blue-300' : 'rounded-md px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'} @click=${() => this.selectTab('history')}>History</button>
      </nav>
      <div id="export-body" role="tabpanel" aria-labelledby="tab-export" ?hidden=${this.activeTab !== 'export'} class="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
      ${this.context?.table ? html`
        <p class="rounded-lg bg-slate-50 dark:bg-slate-800 p-3"><strong>Table:</strong> ${this.context.table}<br><strong>List rows:</strong> ${this.context.rowCount ?? 'Unknown'}<br>
          <strong>View:</strong> ${this.context.view || '(default)'}</p>
        <fieldset class="space-y-3 disabled:opacity-60" ?disabled=${locked}>
          <legend class="mb-3 text-base font-semibold">Export options</legend>
          <div class="grid grid-cols-2 items-end gap-4"><div class="space-y-1"><label class="block font-medium" for="file-type">File type</label>
          <select class="block w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 focus:border-blue-500 focus:outline-blue-500" id="file-type" .value=${this.fileType}
            @change=${(event: Event) => { this.fileType = (event.target as HTMLSelectElement).value as FileType; }}>
            ${FILE_TYPES.map(type => html`<option value=${type}>${type.toUpperCase()}</option>`)}</select>
          </div>
          <label class="flex items-center gap-2 py-2 font-medium"><input class="h-4 w-4 rounded border-slate-300 dark:border-slate-600 accent-blue-600" id="display-values" type="checkbox" ?disabled=${!this.fieldsSupported} .checked=${this.displayValues}
            @change=${(event: Event) => { this.displayValues = (event.target as HTMLInputElement).checked; }}>Use display values</label>
          </div>
          <label class="block font-medium" for="fields">Fields (optional)</label>
          <input class="block w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 focus:border-blue-500 focus:outline-blue-500" id="fields" ?disabled=${!this.fieldsSupported} type="text" placeholder="number,caller_id,priority,state" .value=${this.fields}
            aria-describedby="fields-help" aria-invalid=${this.fieldsError ? 'true' : 'false'}
            @input=${(event: Event) => { this.fields = (event.target as HTMLInputElement).value; }}>
          <p id="fields-help" class=${this.fieldsError ? 'text-xs text-red-700 dark:text-red-400' : 'text-xs text-slate-500 dark:text-slate-400'}>${!this.fieldsSupported ? 'Field selection is not supported for this file type.' : this.fieldsError || 'Leave empty to use the list view’s export fields.'}</p>

        </fieldset>
        <fieldset class="space-y-3 disabled:opacity-60" ?disabled=${locked}><legend class="mb-3 text-base font-semibold">List filter</legend>
          <label class="block font-medium" for="query">Encoded query</label>
          <textarea class="block min-h-24 w-full resize-y rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 font-mono text-xs focus:border-blue-500 focus:outline-blue-500" id="query" spellcheck="false" .value=${this.query}
            @input=${(event: Event) => { this.query = (event.target as HTMLTextAreaElement).value; this.message = ''; }}></textarea>
          <div class="flex flex-wrap items-center gap-2"><button class="apply rounded-md border border-slate-300 dark:border-slate-600 px-3 py-2 font-medium hover:bg-slate-50 dark:hover:bg-slate-800 disabled:cursor-default disabled:opacity-50" ?disabled=${this.downloading || this.csvCombining} @click=${this.applyQuery}>${this.applying ? 'Applying…' : 'Apply to list'}</button>
          ${listDiffers ? html`<button class="rounded-md border border-slate-300 dark:border-slate-600 px-3 py-2 font-medium hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50" id="refresh-from-list" ?disabled=${this.listRefreshing || this.downloading || this.csvCombining} @click=${this.refreshFromList}>${this.listRefreshing ? 'Refreshing…' : 'Refresh from list'}</button>` : ''}</div>
          ${this.dirty ? html`<p class="text-xs text-slate-500 dark:text-slate-400">Editing the query keeps the panel’s captured row count. Apply to list to recapture its matching count.</p>` : ''}
        </fieldset>
        <fieldset class="space-y-3 disabled:opacity-60" ?disabled=${locked}>
          <legend class="mb-3 text-base font-semibold">Chunking</legend>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          ${this.numberControl('chunk-size', 'Target rows per chunk', this.targetChunkSize, undefined,
            `${this.chunks === null ? 'Chunk count unavailable.' : `${this.chunks} approximate chunk${this.chunks === 1 ? '' : 's'}.`} Instance export limit applies (default 10k).`,
            this.chunkError, value => this.changeChunkSize(value), false, this.chunkIncrement)}
          ${this.numberControl('concurrency', 'Concurrent jobs', this.concurrency, this.chunks ?? 0,
            this.chunks ? `Maximum: ${this.chunks} (all chunks).` : 'A positive list row count is needed.',
            this.concurrencyError, value => { this.concurrency = value; }, !this.chunks)}
          ${this.numberControl('poll-interval', 'Status check interval (seconds)', this.pollingIntervalSeconds, 60,
            'Wait between status checks.', this.pollingError, value => { this.pollingIntervalSeconds = value; })}
          </div>
        </fieldset>
        ${this.chunks === 0 ? html`<p>No matching rows. There are no jobs to run.</p>` : ''}
      ` : html`<div class="space-y-3"><p>Unable to read list details. Open a list view or refresh to try again.</p>
          <button class="rounded-md border border-blue-600 px-3 py-2 font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950 disabled:opacity-50" id="refresh-from-page"
            ?disabled=${this.listRefreshing} @click=${this.refreshFromList}>${this.listRefreshing ? 'Refreshing…' : 'Refresh page'}</button></div>`}
      ${this.confirmation ? html`<div class="space-y-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950 p-4" role="group" aria-label="Confirm export">
        <h3 class="text-base font-semibold">Confirm export</h3>
        ${this.confirmation.query !== (this.listContext?.filter ?? this.context?.filter ?? '') ? html`<p id="query-mismatch-warning" class="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 p-3 text-amber-900 dark:text-amber-200" role="alert">The export query differs from the visible list. This export will use the query shown below and the panel’s captured count of ${this.confirmation.rowCount.toLocaleString()} rows. You can continue without changing the list.</p>` : ''}<p>${chunkCount(this.confirmation.rowCount, this.confirmation.targetChunkSize)} jobs for
          ${this.confirmation.rowCount.toLocaleString()} list rows, with ${this.confirmation.concurrency} concurrent jobs.</p>
        <p><strong>Table:</strong> ${this.confirmation.table}<br><strong>Format:</strong> ${this.confirmation.fileType.toUpperCase()}<br>
          ${supportsFieldSelection(this.confirmation.fileType) ? html`<strong>View:</strong> ${this.confirmation.view || '(default)'}<br><strong>Fields:</strong> ${this.confirmation.fields || '(from view)'}<br>` : html`<strong>Fields:</strong> All accessible record fields<br>`}
          ${supportsFieldSelection(this.confirmation.fileType) ? html`<strong>Values:</strong> ${this.confirmation.displayValues ? 'Display' : 'Internal'}<br>` : ''}
          <strong>Status checks:</strong> every ${this.confirmation.pollingIntervalSeconds} seconds<br>
          <strong>Chunk target:</strong> ${this.confirmation.targetChunkSize.toLocaleString()}<br><strong>Query:</strong> ${this.confirmation.query || '(none)'}</p>
        <p class="text-xs text-slate-500 dark:text-slate-400">Chunks are approximate. This starts real ServiceNow export jobs. Closing this panel keeps tracking;
          reloading the page or list forgets tracking. Submitted server jobs continue.</p>
      </div>` : ''}
      <p class="break-words text-sm text-slate-600 dark:text-slate-300" role="status">${this.message}</p>
      ${this.run ? html`<h3 class="text-base font-semibold">Export ${this.run.status}</h3>
        ${this.active || this.run.finishedAt !== undefined ? html`<p id="export-elapsed" class="text-xs text-slate-500 dark:text-slate-400">Elapsed: ${elapsedTime(this.run.createdAt, this.run.finishedAt, this.clockNow)}</p>` : ''}
        <p class="text-xs text-slate-500 dark:text-slate-400">${this.run.settings.table} · ${this.run.settings.fileType.toUpperCase()} · concurrency ${this.run.settings.concurrency}</p>
        ${this.run.message ? html`<p class="text-sm text-red-700 dark:text-red-400" role="status">${this.run.message}</p>` : ''}
        ${this.run.status === 'paused' ? this.run.needsReview
          ? html`<p class="text-xs text-amber-800 dark:text-amber-300">A server job may exist without a known ID. Inspect ServiceNow before starting another export; no submission is retried.</p>`
          : html`<button class="rounded-md border border-blue-600 px-3 py-2 font-semibold text-blue-700 dark:text-blue-300 disabled:opacity-50" id="resume-checks" ?disabled=${this.resuming} @click=${this.resumeChecks}>${this.resuming ? 'Resuming…' : 'Resume status checks'}</button>` : ''}
        ${this.active ? html`<button id="cancel-export" class="rounded-md border border-red-500 px-3 py-2 font-semibold text-red-700 dark:text-red-400 disabled:opacity-50" ?disabled=${this.cancelling || this.run.status === 'cancelling'} @click=${() => { this.cancelConfirmation = this.run!.id; }}>${this.cancelling || this.run.status === 'cancelling' ? 'Cancelling…' : 'Cancel export'}</button>` : ''}
        ${this.cancelConfirmation === this.run.id && this.active ? html`<div role="alertdialog" aria-modal="false" aria-labelledby="cancel-title" class="space-y-3 rounded-lg border border-red-300 dark:border-red-700 p-4">
          <h4 id="cancel-title" class="font-semibold">Cancel this export?</h4>
          <p>Stop queued chunks and cancel running jobs in this batch. Cancelled jobs will be hidden from History. Completed files remain available.</p>
          <div class="flex gap-2"><button id="confirm-cancel-export" class="rounded-md bg-red-700 px-3 py-2 text-white" @click=${this.confirmCancel}>Confirm cancellation</button>
          <button id="keep-export" class="rounded-md border border-slate-300 dark:border-slate-600 px-3 py-2" @click=${() => { this.cancelConfirmation = null; }}>Keep exporting</button></div>
        </div>` : ''}
        <p role="status">${completed} of ${this.run.jobs.length} jobs completed${failed ? ` · ${failed} failed` : ''}${cancelled ? ` · ${cancelled} cancelled` : ''}${unknown ? ` · ${unknown} submission outcomes unknown` : ''}</p>
        ${completed && completed < this.run.jobs.length && this.run.status !== 'running' ? html`<p class="text-xs text-slate-500 dark:text-slate-400">Download all includes the ${completed} completed jobs. Pending or failed jobs have no file available yet.</p>` : ''}
        ${this.allFilesReady ? html`<div class="space-y-2">
          <label class="block font-medium" for="filename-prefix">Filename prefix</label>
          <input class="block w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 focus:outline-blue-500" id="filename-prefix" ?disabled=${this.downloading} type="text" maxlength="120" .value=${this.filenamePrefix}
            aria-describedby="filename-help" aria-invalid=${this.filenameError ? 'true' : 'false'}
            @input=${(event: Event) => { this.filenamePrefix = (event.target as HTMLInputElement).value; }}>
          <p id="filename-help" class=${this.filenameError ? 'text-xs text-red-700 dark:text-red-400' : 'text-xs text-slate-500 dark:text-slate-400'}>${this.filenameError || `Files: ${this.filenamePrefix}-001.${this.run.settings.fileType}, ${this.filenamePrefix}-002.${this.run.settings.fileType}, …${this.run.settings.fileType === 'csv' ? ` Combined: ${this.filenamePrefix}.csv` : ''}`}</p>
        </div>` : ''}
        <div id="completeness-summary" class="space-y-1 rounded-lg bg-slate-50 dark:bg-slate-800 p-3 text-xs">
          <p><strong>Starting list:</strong> ${this.run.settings.rowCount.toLocaleString()} rows</p>
          <p><strong>Processor totals:</strong> ${summary?.reportedJobs ? `${summary.reportedRows.toLocaleString()} rows across ${summary.reportedJobs}/${this.run.jobs.length} jobs` : 'Not reported yet'}</p>
          ${this.run.settings.fileType === 'csv' ? html`<p><strong>CSV file rows:</strong> ${summary?.allVerified ? `${summary.verifiedRows.toLocaleString()} data rows (verified while combining)` : this.csvCombining ? `${this.csvRows.toLocaleString()} data rows across ${this.csvFiles}/${this.run.jobs.length} files` : summary?.verifiedJobs ? `${summary.verifiedRows.toLocaleString()} data rows across ${summary.verifiedJobs}/${this.run.jobs.length} files` : 'Combine CSV files to verify'}</p>` : ''}
          ${this.run.settings.fileType === 'csv' && summary?.allVerified && summary.verifiedRows === this.run.settings.rowCount ? html`<p class="text-emerald-700 dark:text-emerald-400">CSV row counts match the starting list count.</p>` : ''}
          ${summary?.warnings.map(warning => html`<p class="text-amber-800 dark:text-amber-300" role="status">${warning}</p>`)}
        </div>
        <p id="download-counts" class="text-xs text-slate-500 dark:text-slate-400" role="status">Downloads: ${downloads?.completed} saved · ${downloads?.inProgress} in progress · ${downloads?.failed} failed · ${downloads?.remaining} ready, not requested</p>
        <progress class="block h-2 w-full accent-blue-600" aria-label="Overall jobs completed" max=${this.run.jobs.length} value=${completed}></progress>
        <details class="rounded-lg border border-slate-200 dark:border-slate-700">
          <summary class="cursor-pointer px-3 py-2 font-medium hover:bg-slate-50 dark:hover:bg-slate-800">Job details (${this.run.jobs.length})</summary>
          <ul class="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto border-t border-slate-200 dark:border-slate-700 p-2 sm:grid-cols-2">${this.run.jobs.map(job => html`<li data-job-card=${job.id} class="min-w-0 space-y-1 rounded-md bg-slate-50 dark:bg-slate-800 p-2 text-xs">
          <div class="flex items-center gap-2">${jobProgress(job)}<div class="min-w-0 flex-1"><strong>Job ${job.id}</strong>
            <p class="text-slate-500 dark:text-slate-400">${job.status.replaceAll('_', ' ')}</p>
          </div></div>
          ${job.message && !['Completed', 'Submitted'].includes(job.message) ? html`<p class=${job.status === 'failed' || job.status === 'submission_unknown' ? 'break-words text-red-700 dark:text-red-400' : 'break-words text-slate-500 dark:text-slate-400'}>${job.message}</p>` : ''}
          ${(job.totalRows ?? 0) > ASSUMED_EXPORT_LIMIT ? html`<p class="text-sm text-red-700 dark:text-red-400">Instance export limit may truncate this file.</p>` : ''}
          ${this.run?.settings.fileType === 'csv' && job.fileRowCount !== undefined ? html`<p class="text-xs text-slate-500 dark:text-slate-400">Verified CSV rows: ${job.fileRowCount.toLocaleString()}</p>` : ''}
          ${job.status === 'completed' && job.attachmentId ? html`<button class="rounded border border-slate-300 dark:border-slate-600 px-2 py-1 text-xs font-medium hover:bg-white dark:hover:bg-slate-700 disabled:opacity-50" data-download-job=${job.id}
            ?disabled=${this.downloading || !!this.filenameError || (job.downloadId !== undefined && job.downloadState !== 'interrupted')}
            @click=${() => this.downloadJob(job.id)}>${job.downloadState === 'complete' ? 'Downloaded' : job.downloadState === 'in_progress' ? 'Downloading…' : job.downloadState === 'interrupted' || job.downloadError ? 'Retry download' : 'Download'}</button>` : ''}
          ${job.downloadError ? html`<p class="text-sm text-red-700 dark:text-red-400">${job.downloadError}</p>` : ''}
        </li>`)}</ul></details>` : ''}
      </div>
      <div id="history-body" role="tabpanel" aria-labelledby="tab-history" ?hidden=${this.activeTab !== 'history'} class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        ${historyView(this.history, this.historyBusy, this.historyActionBusy, this.historyMessage, () => this.refreshHistory(), id => this.downloadHistoryFile(id), batch => this.combineHistoryBatch(batch), batch => this.rerunHistoryBatch(batch), batch => this.openHistoryList(batch), selection => this.removeHistory(selection))}
      </div>
      <footer ?hidden=${this.activeTab !== 'export'} class="${this.activeTab === 'export' ? 'flex' : 'hidden'} shrink-0 flex-wrap items-center gap-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-6 py-4">
        ${this.downloading || downloads && (downloads.inProgress || downloads.completed || downloads.failed)
          ? activity(this.downloading ? 'Requesting file downloads…' : `${downloads!.inProgress} downloading · ${downloads!.completed} saved${downloads!.failed ? ` · ${downloads!.failed} failed` : ''}`,
            this.downloading || !!downloads?.inProgress, 'file-download-activity') : ''}
        ${this.csvMessage ? activity(this.csvCombining ? `${this.csvMessage} ${this.csvRows.toLocaleString()} rows verified.` : this.csvMessage,
          this.csvCombining, 'csv-combine-status') : ''}
        ${this.context?.table && !this.confirmation ? html`<button class="rounded-md bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:cursor-default disabled:opacity-50" id="review-export" ?disabled=${this.cannotStart} @click=${this.reviewExport}>
          ${this.starting ? 'Starting…' : 'Review export'}</button>` : ''}
        ${this.confirmation ? html`<div class="flex flex-wrap gap-2"><button class="rounded-md bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-50" id="confirm-export" ?disabled=${this.starting} @click=${this.confirmExport}>Confirm and start export</button>
          <button class="rounded-md border border-slate-300 dark:border-slate-600 px-4 py-2 hover:bg-white dark:hover:bg-slate-700" @click=${() => { this.confirmation = null; }}>Back</button></div>` : ''}
        ${this.run ? html`<button class="rounded-md border border-blue-600 px-4 py-2 font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950 disabled:opacity-50" id="download-all" ?disabled=${this.run.status === 'running' || this.downloading || !!this.filenameError || !available} @click=${this.downloadAll}>
          ${this.downloading ? 'Preparing downloads…' : 'Download all files'}</button>` : ''}
        ${downloads?.failed ? html`<button class="rounded-md border border-slate-300 dark:border-slate-600 px-4 py-2 font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50" id="retry-downloads"
          ?disabled=${this.run?.status === 'running' || this.downloading || !!this.filenameError} @click=${this.retryDownloads}>Retry failed downloads (${downloads.failed})</button>` : ''}
        ${this.canCombine ? html`
          <button class="rounded-md border border-blue-600 px-4 py-2 font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950 disabled:opacity-50" id="download-combined"
            ?disabled=${this.csvCombining || !!this.filenameError} @click=${this.downloadCombined}>${this.csvCombining ? 'Combining CSV…' : this.allFilesReady ? 'Download combined CSV' : 'Start combining CSV'}</button>` : ''}
      </footer>
    </section>`;
  }
}
