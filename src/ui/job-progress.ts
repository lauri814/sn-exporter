import { html, nothing, svg } from 'lit';
import type { ExportJob } from '../export/types';

export function jobProgress(job: ExportJob) {
  const active = job.status === 'running' || job.status === 'submitting';
  const value = job.status === 'completed' ? 100 : active && job.totalRows && job.exportedRows !== undefined
    ? Math.max(0, Math.min(100, Math.floor(job.exportedRows / job.totalRows * 100))) : undefined;
  const colour = job.status === 'completed' ? 'text-emerald-600 dark:text-emerald-400' :
    job.status === 'failed' || job.status === 'submission_unknown' ? 'text-red-600 dark:text-red-400' :
    active ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400';
  return html`<span class=${`relative inline-flex h-10 w-10 shrink-0 items-center justify-center ${colour}`}
    role=${active || job.status === 'completed' ? 'progressbar' : 'img'} aria-label=${`Job ${job.id}: ${job.status.replaceAll('_', ' ')}`}
    aria-valuemin=${active || job.status === 'completed' ? 0 : nothing} aria-valuemax=${active || job.status === 'completed' ? 100 : nothing}
    aria-valuenow=${value ?? nothing}>
    <svg aria-hidden="true" viewBox="0 0 40 40" class="absolute inset-0 h-10 w-10 -rotate-90 fill-none" stroke="currentColor" stroke-width="3">
      <circle cx="20" cy="20" r="17" class="opacity-20"></circle>
      ${value !== undefined || active ? svg`<circle cx="20" cy="20" r="17" pathLength="100" stroke-linecap="round"
        stroke-dasharray=${`${value ?? 25} 100`} class=${active && value === undefined ? 'origin-center animate-spin motion-reduce:animate-none' : ''}></circle>` : ''}
    </svg>
    <span aria-hidden="true" class="text-[10px] font-semibold">${job.status === 'completed' ? '✓' : value !== undefined ? `${value}%` : job.status === 'failed' || job.status === 'submission_unknown' ? '!' : job.status === 'cancelled' ? '×' : '…'}</span>
  </span>`;
}
