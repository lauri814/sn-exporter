import { CsvCombiner } from './csv-combiner';
import type { ExportRun } from './types';

interface CombineAdapter {
  read(jobId: number): Promise<string>;
  record(jobId: number, rows: number): Promise<void>;
  progress(rows: number, files: number, total: number): void;
  complete(file: Blob, files: number): void;
  failed(message: string): void;
}

export class ProgressiveCsv {
  private run: ExportRun;
  private combined = new CsvCombiner();
  private processed = new Map<number, string>();
  private busy = false;
  private stopped = false;
  constructor(run: ExportRun, private adapter: CombineAdapter) { this.run = run; }
  get runId() { return this.run.id; }
  get active() { return !this.stopped; }
  get rows() { return this.combined.rowCount; }
  get files() { return this.processed.size; }
  stop() { this.stopped = true; }

  async update(run: ExportRun): Promise<void> {
    if (this.stopped) return;
    if (run.id !== this.run.id) { this.stop(); return; }
    if ((run.revision ?? 0) < (this.run.revision ?? 0)) return;
    this.run = run;
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.stopped) {
        if (this.run.cancelRequested || ['cancelled', 'failed'].includes(this.run.status) ||
            this.run.jobs.some(job => ['failed', 'submission_unknown', 'cancelled'].includes(job.status))) {
          throw new Error('Combining stopped because the batch did not complete. No partial combined file was downloaded.');
        }
        if ([...this.processed].some(([id, attachmentId]) => !this.run.jobs.some(job => job.id === id && job.attachmentId === attachmentId))) {
          throw new Error('The export attachments changed while combining files.');
        }
        const job = [...this.run.jobs].sort((a, b) => a.id - b.id)
          .find(job => job.status === 'completed' && job.attachmentId && !this.processed.has(job.id));
        if (!job) break;
        const text = await this.adapter.read(job.id);
        if (this.stopped) return;
        if (this.run.cancelRequested) throw new Error('Combining stopped because the export was cancelled.');
        const previous = this.combined.rowCount;
        this.combined.append(text, job.id);
        this.processed.set(job.id, job.attachmentId!);
        this.adapter.progress(this.rows, this.files, this.run.jobs.length);
        await this.adapter.record(job.id, this.rows - previous);
      }
      if (!this.stopped && this.files === this.run.jobs.length && this.run.jobs.every(job => job.status === 'completed')) {
        this.stopped = true;
        this.adapter.complete(this.combined.finish(), this.files);
      }
    } catch (error) {
      this.stop();
      this.adapter.failed(error instanceof Error ? error.message : 'Unable to combine CSV files.');
    } finally { this.busy = false; }
  }
}
