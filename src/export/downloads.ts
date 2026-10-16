import { FILE_TYPES, type ExportRun } from './types';

export function attachmentUrl(origin: string, attachmentId: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.service-now.com') || url.origin !== origin || !/^[a-f0-9]{32}$/i.test(attachmentId)) {
    throw new Error('A valid ServiceNow instance and attachment sys_id are required.');
  }
  return `${origin}/sys_attachment.do?sys_id=${attachmentId}`;
}

export function normalizeFilenamePrefix(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
      /[. ]$/.test(name) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('Enter a filename prefix of 1–120 characters without path separators or special filename characters.');
  }
  return name;
}

export function exportFilename(run: ExportRun, jobId: number): string {
  if (!FILE_TYPES.includes(run.settings.fileType) || !Number.isSafeInteger(jobId) || jobId < 1) {
    throw new Error('A valid export format and chunk number are required.');
  }
  const prefix = normalizeFilenamePrefix(run.settings.filenamePrefix ?? run.settings.table);
  return `${prefix}-${String(jobId).padStart(3, '0')}.${run.settings.fileType}`;
}

export function downloadCounts(run: ExportRun) {
  const ready = run.jobs.filter(job => job.status === 'completed' && job.attachmentId);
  return {
    completed: ready.filter(job => job.downloadState === 'complete').length,
    inProgress: ready.filter(job => job.downloadState === 'in_progress').length,
    failed: ready.filter(job => job.downloadState === 'interrupted' || !!job.downloadError).length,
    remaining: ready.filter(job => job.downloadId === undefined && !job.downloadError).length,
  };
}

export type DownloadSelection = { mode: 'all' | 'failed' } | { mode: 'job'; jobId: number };

// Request only completed attachments. Successful requests are recorded so a
// retry after a partial batch failure does not duplicate those downloads.
export async function downloadCompleted(
  run: ExportRun,
  download: (url: string, filename: string) => Promise<number>,
  publish: (run: ExportRun) => Promise<void>,
  selection: DownloadSelection = { mode: 'all' },
): Promise<{ requested: number; failed: number }> {
  if (selection.mode === 'job' && !run.jobs.some(job => job.id === selection.jobId && job.status === 'completed' && job.attachmentId)) {
    throw new Error('This completed file is unavailable.');
  }
  let requested = 0, failed = 0;
  for (const job of run.jobs) {
    if (selection.mode === 'job' && job.id !== selection.jobId) continue;
    if (selection.mode === 'failed' && job.downloadState !== 'interrupted' && !job.downloadError) continue;
    if (job.status !== 'completed' || !job.attachmentId || (job.downloadId !== undefined && job.downloadState !== 'interrupted')) continue;
    try {
      job.downloadId = await download(attachmentUrl(run.origin, job.attachmentId), exportFilename(run, job.id));
      job.downloadState = 'in_progress';
      delete job.downloadError;
      requested++;
    } catch (error) {
      job.downloadError = error instanceof Error ? error.message : 'Download could not be started.';
      failed++;
    }
    await publish(run);
  }
  return { requested, failed };
}
