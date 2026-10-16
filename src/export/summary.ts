import type { ExportRun } from './types';
import { ASSUMED_EXPORT_LIMIT } from './plan';

export function exportSummary(run: ExportRun) {
  const valid = (value: number | undefined): value is number => Number.isSafeInteger(value) && value! >= 0;
  const reported = run.jobs.filter(job => valid(job.totalRows));
  const reportedRows = reported.reduce((sum, job) => sum + job.totalRows!, 0);
  const verified = run.jobs.filter(job => valid(job.fileRowCount));
  const verifiedRows = verified.reduce((sum, job) => sum + job.fileRowCount!, 0);
  const allReported = !!run.jobs.length && reported.length === run.jobs.length;
  const allVerified = !!run.jobs.length && verified.length === run.jobs.length;
  const warnings: string[] = [];
  if (allReported && reportedRows !== run.settings.rowCount) warnings.push(`Processor totals (${reportedRows.toLocaleString()}) differ from the starting list count (${run.settings.rowCount.toLocaleString()}).`);
  if (run.jobs.some(job => (job.totalRows ?? 0) > ASSUMED_EXPORT_LIMIT)) warnings.push('A chunk exceeds the assumed 10k instance export limit; its file may be truncated.');
  if (allVerified && verifiedRows !== run.settings.rowCount) warnings.push(`CSV files contain ${verifiedRows.toLocaleString()} data rows; the starting list count was ${run.settings.rowCount.toLocaleString()}.`);
  if (allVerified && run.jobs.some(job => valid(job.totalRows) && job.fileRowCount !== job.totalRows)) warnings.push('A CSV file count differs from its processor-reported total.');
  return { reportedRows, reportedJobs: reported.length, allReported, verifiedJobs: verified.length, verifiedRows, allVerified, warnings };
}
