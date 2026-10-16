import type { ExportJob, ExportRun } from './types';
import type { PollStatus } from '../servicenow/processor';

export interface ExportAdapter {
  submit(run: ExportRun, job: ExportJob): Promise<string>;
  poll(run: ExportRun, job: ExportJob): Promise<PollStatus>;
  publish(run: ExportRun): Promise<void>;
  cancel?(run: ExportRun, job: ExportJob): Promise<void>;
}

function endRun(run: ExportRun, status: 'completed' | 'failed' | 'cancelled') {
  if (['running', 'paused', 'cancelling'].includes(run.status)) run.finishedAt ??= Date.now();
  run.status = status;
}

export function finishRun(run: ExportRun): void {
  if (run.cancelRequested) {
    if (run.jobs.some(job => ['running', 'submitting', 'submission_unknown'].includes(job.status))) run.status = 'paused';
    else endRun(run, 'cancelled');
    return;
  }
  if (run.needsReview) { run.status = 'paused'; return; }
  if (run.jobs.some(job => ['queued', 'submitting', 'running'].includes(job.status))) return;
  endRun(run, run.jobs.every(job => job.status === 'completed') ? 'completed' : 'failed');
}

// Submission is not idempotent. A worker interruption after sending init can
// leave a server job without a known ID; never silently submit that chunk again.
export function recoverInterruptedSubmissions(run: ExportRun): void {
  for (const job of run.jobs) {
    if (job.status === 'submitting') {
      job.status = 'submission_unknown';
      job.message = 'Submission was interrupted. A server job may exist, but its ID was not received. This chunk was not resubmitted.';
      run.needsReview = true;
      run.message = 'A submission outcome is unknown. Queued jobs will not launch automatically. Check the instance before starting another export.';
    }
  }
  finishRun(run);
}

export class ExportController {
  private busy = new Set<string>();
  private idle = new Map<string, Promise<void>>();
  constructor(private adapter: ExportAdapter) {}

  async cancel(run: ExportRun): Promise<void> {
    if (!this.adapter.cancel) throw new Error('Cancellation is unavailable.');
    run.cancelRequested = true; run.status = 'cancelling';
    for (const job of run.jobs) if (job.status === 'queued') {
      job.status = 'cancelled'; job.message = 'Cancelled before submission';
    }
    await this.adapter.publish(run);
    await this.idle.get(run.id);
    // An intent saved before cancellation may never have reached init.
    for (const job of run.jobs) if (job.status === 'submitting' && !job.jobId) {
      job.status = 'cancelled'; job.message = 'Cancelled before submission';
    }
    run.status = 'cancelling';
    await this.adapter.publish(run);
    await Promise.all(run.jobs.filter(job => job.status === 'running' && job.jobId).map(async job => {
      try {
        await this.adapter.cancel!(run, job);
        job.status = 'cancelled'; job.message = 'Cancellation requested';
      } catch (error) {
        job.message = `Cancellation failed: ${error instanceof Error ? error.message : 'Request unavailable'}. Retry cancellation.`;
      }
    }));
    finishRun(run);
    run.message = run.jobs.every(job => ['completed', 'failed', 'cancelled'].includes(job.status)) ? 'Export cancelled. Completed files remain available.' :
      'Some jobs could not be cancelled. Retry cancellation for known jobs; inspect ServiceNow for any unknown submission outcomes.';
    await this.adapter.publish(run);
  }

  async tick(run: ExportRun, options: { pollOnly?: boolean } = {}): Promise<void> {
    if (run.status !== 'running' || this.busy.has(run.id)) return;
    this.busy.add(run.id);
    let release!: () => void;
    this.idle.set(run.id, new Promise<void>(resolve => { release = resolve; }));
    try {
      // Poll submitted jobs first so finished/failed jobs release concurrency.
      const running = run.jobs.filter(job => job.status === 'running');
      let connectionError: string | undefined;
      await Promise.all(running.map(async job => {
        try {
          const response = await this.adapter.poll(run, job);
          if (response.status === 'completed') {
            job.status = 'completed'; job.attachmentId = response.attachmentId;
            job.message = 'Completed';
          } else if (response.status === 'failed') {
            job.status = 'failed'; job.message = response.message;
          } else if (response.status === 'unknown') {
            connectionError = response.message;
          } else {
            if (response.exportedRows !== undefined) job.exportedRows = response.exportedRows;
            if (response.totalRows !== undefined) job.totalRows = response.totalRows;
            job.message = response.message;
          }
        } catch (error) {
          // Keep a known server job ID for a later poll instead of resubmitting.
          connectionError = error instanceof Error ? error.message : 'Processor connection unavailable.';
        }
      }));
      if (connectionError) {
        run.status = 'paused';
        run.message = `Polling paused: ${connectionError} Check your session, then use Resume status checks. Submitted jobs may still run on ServiceNow.`;
        await this.adapter.publish(run);
        return;
      }
      if (run.status !== 'running') { await this.adapter.publish(run); return; }
      const occupied = run.jobs.filter(job => job.status === 'running' || job.status === 'submitting').length;
      const pending = run.jobs.filter(job => job.status === 'queued').slice(0, run.settings.concurrency - occupied);
      if (pending.length && !options.pollOnly && !run.cancelRequested) {
        for (const job of pending) job.status = 'submitting';
        // Persist intent before the non-idempotent request.
        await this.adapter.publish(run);
        if (run.status !== 'running') return;
        await Promise.all(pending.map(async job => {
          try {
            job.jobId = await this.adapter.submit(run, job);
            job.status = 'running'; job.message = 'Submitted';
          } catch (error) {
            job.status = 'submission_unknown';
            const reason = error instanceof Error ? error.message : 'Processor submission failed.';
            job.message = `${reason} A server job may have been created; this chunk will not be resubmitted automatically.`;
            run.needsReview = true;
            run.message = 'A submission outcome is unknown. Queued jobs will not launch automatically. Check the instance before starting another export.';
          }
          await this.adapter.publish(run);
        }));
      }
      finishRun(run);
      await this.adapter.publish(run);
    } finally { this.busy.delete(run.id); this.idle.delete(run.id); release(); }
  }
}
