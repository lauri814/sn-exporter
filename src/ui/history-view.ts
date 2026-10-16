import { html } from 'lit';
import { activity } from './activity';
import type { HistoryBatch, HistoryView, PollRecord } from '../history/types';

export function canCombineBatch(history: HistoryView, batch: HistoryBatch): boolean {
  return batch.settings.fileType === 'csv' && batch.jobs.length === batch.plannedJobs && batch.jobs.every(job => {
    const record = history.records.find(record => record.jobId === job.jobId);
    const files = history.attachments.filter(file => file.pollId === record?.sysId);
    return record?.state.toLowerCase() === 'complete' && files.length === 1 && /\.csv$/i.test(files[0].fileName);
  });
}

export function historyView(history: HistoryView | null, busy: boolean, actionBusy: boolean, message: string,
  refresh: () => void, download: (id: string) => void, combine: (batch: HistoryBatch) => void, rerun: (batch: HistoryBatch) => void, openList: (batch: HistoryBatch) => void, remove: (selection: { all?: boolean; batchId?: string; pollId?: string }) => void) {
  const grouped = new Set(history?.batches.flatMap(batch => batch.jobs.map(job => job.jobId)) ?? []);
  const others = history?.records.filter(record => !grouped.has(record.jobId)) ?? [];
  const recordView = (record: PollRecord, removable = false) => html`<div class="space-y-1 border-t border-slate-200 dark:border-slate-700 py-2 text-xs">
    <p class="flex flex-wrap justify-between gap-2"><strong>Export ${record.sysId.slice(0, 8)}</strong><span>${record.state || 'Unknown'}</span></p>
    ${removable ? html`<button class="rounded border border-slate-300 dark:border-slate-600 px-2 py-1 disabled:opacity-50" ?disabled=${busy || actionBusy} @click=${() => remove({ pollId: record.sysId })}>Remove</button>` : ''}
    <p class="text-slate-500 dark:text-slate-400">${record.createdOn}${record.max !== null ? ` · ${record.current ?? '?'}/${record.max} rows` : ''}</p>
    ${record.message ? html`<p class="break-words">${record.message}</p>` : ''}
    ${history?.attachments.filter(file => file.pollId === record.sysId).map(file => html`<div class="flex items-center justify-between gap-2">
      <span class="min-w-0 break-all">${file.fileName}</span>
      <button class="shrink-0 rounded border border-slate-300 dark:border-slate-600 px-2 py-1 hover:bg-white dark:hover:bg-slate-700 disabled:opacity-50" ?disabled=${actionBusy || busy || record.state.toLowerCase() !== 'complete'} @click=${() => download(file.sysId)}>Download</button>
    </div>`)}
  </div>`;
  return html`<div class="space-y-4">
    <div class="flex items-center justify-between gap-3"><h3 class="text-base font-semibold">Export history</h3>
      <div class="flex gap-2"><button id="clear-history" class="rounded-md border border-slate-300 dark:border-slate-600 px-3 py-2 disabled:opacity-50" ?disabled=${busy || actionBusy || !history || (!history.batches.length && !history.records.length)} @click=${() => remove({ all: true })}>Clear history</button>
      <button id="refresh-history" class="rounded-md border border-slate-300 dark:border-slate-600 px-3 py-2 font-medium disabled:opacity-50" ?disabled=${busy || actionBusy} @click=${refresh}>${busy ? 'Refreshing…' : 'Refresh'}</button></div></div>
    <p class="text-xs text-slate-500 dark:text-slate-400">Current session records from the last 24 hours. Availability is checked with ServiceNow. Removing history only hides it locally for 24 hours; records and files stay in ServiceNow.</p>
    ${activity(message || (busy ? 'Reading export history…' : actionBusy ? 'Processing…' : ''), busy || actionBusy, 'history-activity')}
    ${history ? html`
      ${history.batches.map(batch => {
        const records = batch.jobs.map(job => history.records.find(record => record.jobId === job.jobId)).filter((record): record is PollRecord => !!record);
        const complete = records.filter(record => record.state.toLowerCase() === 'complete').length;
        return html`<details class="rounded-lg border border-slate-200 dark:border-slate-700" data-history-batch=${batch.id}>
          <summary class="cursor-pointer px-3 py-2"><strong>${batch.settings.table} · ${batch.settings.fileType.toUpperCase()}</strong>
            <span class="ml-2 text-xs text-slate-500 dark:text-slate-400">${complete}/${batch.plannedJobs} complete · ${new Date(batch.createdAt).toLocaleString()}</span></summary>
          <div class="space-y-2 px-3 pb-3">
            <p class="break-all font-mono text-xs">${batch.settings.query || '(no filter)'}</p>
            ${batch.jobs.length !== batch.plannedJobs ? html`<p class="text-xs text-amber-800 dark:text-amber-300">${batch.jobs.length} of ${batch.plannedJobs} job IDs were recorded. History does not submit remaining jobs.</p>` : ''}
            <div class="flex flex-wrap gap-2"><button class="rounded border border-slate-300 dark:border-slate-600 px-3 py-1 text-sm disabled:opacity-50" ?disabled=${actionBusy || busy} @click=${() => remove({ batchId: batch.id })}>Remove batch</button><button class="rounded border border-slate-300 dark:border-slate-600 px-3 py-1 text-sm disabled:opacity-50" ?disabled=${actionBusy || busy} @click=${() => rerun(batch)}>Rerun</button><button class="rounded border border-slate-300 dark:border-slate-600 px-3 py-1 text-sm disabled:opacity-50" ?disabled=${actionBusy || busy} @click=${() => openList(batch)}>Open list with filter</button>
              ${canCombineBatch(history, batch) ? html`<button class="rounded border border-blue-600 px-3 py-1 text-sm text-blue-700 dark:text-blue-300 disabled:opacity-50" ?disabled=${actionBusy || busy} @click=${() => combine(batch)}>Download combined CSV</button>` : ''}</div>
            ${batch.jobs.map(job => {
              const record = history.records.find(record => record.jobId === job.jobId);
              return record ? recordView(record) : html`<p class="text-xs text-slate-500 dark:text-slate-400">Job ${job.number}: no longer available in this session.</p>`;
            })}
          </div>
        </details>`;
      })}
      ${others.length ? html`<h3 class="text-base font-semibold">Other user exports</h3><div class="rounded-lg border border-slate-200 dark:border-slate-700 px-3">${others.sort((a,b) => b.createdOn.localeCompare(a.createdOn)).map(record => recordView(record, true))}</div>` : ''}
      ${!history.batches.length && !others.length ? html`<p>No exports are available in this session from the last 24 hours.</p>` : ''}
    ` : !busy ? html`<p>Refresh to read exports available in your current ServiceNow session.</p>` : ''}
  </div>`;
}
