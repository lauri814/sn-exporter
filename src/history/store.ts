import type { ExportRun } from '../export/types';
import type { HistoryBatch, HistoryView, PollHistory, HistoryQueryCache } from './types';

const KEY = 'sn-export-history-v1';
const HIDDEN_KEY = 'sn-export-history-hidden-v1';
type HiddenItem = { origin: string; userId: string; batchId?: string; pollId?: string; jobId?: string; expiresAt: number };
const QUERY_KEY = 'sn-export-history-query-v1';
type QuerySnapshot = PollHistory & { origin: string; fetchedAt: number };
const DAY = 24 * 60 * 60 * 1000;

export class HistoryStore {
  private chain: Promise<unknown> = Promise.resolve();
  private fingerprints = new Map<string, string>();

  private update<T>(change: (batches: HistoryBatch[], hidden: HiddenItem[], snapshots: QuerySnapshot[]) => { batches: HistoryBatch[]; result: T }): Promise<T> {
    const write = this.chain.then(async () => {
      const stored = (await chrome.storage.local.get(KEY))[KEY];
      const batches = (Array.isArray(stored) ? stored : []).filter((batch: HistoryBatch) =>
        batch && typeof batch.createdAt === 'number' && batch.createdAt > Date.now() - DAY && Array.isArray(batch.jobs)).map((batch: HistoryBatch) => ({ ...batch,
          jobs: batch.jobs.map(job => ({ number: job.number, jobId: job.jobId ?? (job as unknown as { pollId: string }).pollId })) }));
      const savedHidden = (await chrome.storage.local.get(HIDDEN_KEY))[HIDDEN_KEY];
      const hidden: HiddenItem[] = (Array.isArray(savedHidden) ? savedHidden : []).filter(item => item && item.expiresAt > Date.now());
      const savedSnapshots = (await chrome.storage.local.get(QUERY_KEY))[QUERY_KEY];
      const snapshots: QuerySnapshot[] = (Array.isArray(savedSnapshots) ? savedSnapshots : []).filter(item => item && item.fetchedAt > Date.now() - DAY);
      const updated = change(batches, hidden, snapshots);
      await chrome.storage.local.set({ [KEY]: updated.batches, [HIDDEN_KEY]: hidden, [QUERY_KEY]: snapshots });
      // A removed mapping is no longer saved, even if its run has not changed.
      const retained = new Set(updated.batches.map(batch => batch.id));
      for (const id of this.fingerprints.keys()) if (!retained.has(id)) this.fingerprints.delete(id);
      return updated.result;
    });
    this.chain = write.catch(() => {});
    return write;
  }

  async queryCache(origin: string): Promise<HistoryQueryCache[]> {
    return this.update((batches, hidden, snapshots) => {
      const users = new Set([...batches, ...hidden, ...snapshots].filter(item => item.origin === origin).map(item => item.userId));
      return { batches, result: [...users].map(userId => {
        const snapshot = snapshots.find(item => item.origin === origin && item.userId === userId);
        const hiddenPollIds = hidden.filter(item => item.origin === origin && item.userId === userId && item.pollId).map(item => item.pollId!);
        const hiddenJobIds = hidden.filter(item => item.origin === origin && item.userId === userId && item.jobId).map(item => item.jobId!);
        const excludedJobs = new Set(hiddenJobIds);
        const excluded = new Set(hiddenPollIds);
        const records = (snapshot?.records ?? []).filter(record => !excluded.has(record.sysId) && !excludedJobs.has(record.jobId));
        const knownJobIds = [...new Set([...records.map(record => record.jobId), ...batches.filter(batch => batch.origin === origin && batch.userId === userId).flatMap(batch => batch.jobs.map(job => job.jobId))])].filter(id => typeof id === 'string' && /^[a-f0-9]{32}$/i.test(id) && !excludedJobs.has(id));
        return { userId, records, attachments: (snapshot?.attachments ?? []).filter(file => !excluded.has(file.pollId)), knownJobIds, hiddenPollIds, hiddenJobIds };
      }) };
    });
  }

  async excludeJobs(origin: string, userId: string, jobIds: string[]) {
    await this.update((batches, hidden, snapshots) => {
      const ids = new Set(jobIds);
      const scope = { origin, userId, expiresAt: Date.now() + DAY };
      for (const jobId of ids) if (!hidden.some(item => item.origin === origin && item.userId === userId && item.jobId === jobId)) hidden.push({ ...scope, jobId });
      for (const snapshot of snapshots) if (snapshot.origin === origin && snapshot.userId === userId) {
        const polls = new Set(snapshot.records.filter(record => ids.has(record.jobId)).map(record => record.sysId));
        snapshot.records = snapshot.records.filter(record => !ids.has(record.jobId));
        snapshot.attachments = snapshot.attachments.filter(file => !polls.has(file.pollId));
      }
      return { batches, result: undefined };
    });
  }

  async record(run: ExportRun, options: { force?: boolean } = {}) {
    if (!run.userId || !/^[a-f0-9]{32}$/i.test(run.userId)) return;
    const jobs = run.jobs.filter(job => job.jobId && job.status !== 'cancelled').map(job => ({ number: job.id, jobId: job.jobId! }));
    if (!jobs.length) return;
    const fingerprint = JSON.stringify([run.origin, run.userId, run.settings, jobs]);
    if (!options.force && this.fingerprints.get(run.id) === fingerprint) return;
    await this.update((batches, hidden) => {
      if (hidden.some(item => item.origin === run.origin && item.userId === run.userId && item.batchId === run.id)) return { batches, result: undefined };
      if (run.createdAt > Date.now() - DAY) {
        const batch: HistoryBatch = { id: run.id, origin: run.origin, userId: run.userId!, createdAt: run.createdAt,
          updatedAt: Date.now(), settings: structuredClone(run.settings), plannedJobs: run.jobs.filter(job => job.status !== 'cancelled').length, jobs };
        batches = [...batches.filter(item => item.id !== run.id), batch];
      }
      return { batches, result: undefined };
    });
    this.fingerprints.set(run.id, fingerprint);
  }

  async remove(view: HistoryView, selection: { batchId?: string; pollId?: string; jobId?: string; all?: boolean }) {
    return this.update((batches, hidden, snapshots) => {
      const selected = view.batches.filter(batch => selection.all || batch.id === selection.batchId);
      const pollIds = new Set(selection.all ? view.records.map(record => record.sysId) :
        selection.pollId ? view.records.filter(record => record.sysId === selection.pollId).map(record => record.sysId) : []);
      for (const batch of selected) for (const job of batch.jobs) {
        const record = view.records.find(record => record.jobId === job.jobId);
        if (record) pollIds.add(record.sysId);
      }
      const scope = { origin: view.origin, userId: view.userId, expiresAt: Date.now() + DAY };
      for (const batch of selected) hidden.push({ ...scope, batchId: batch.id });
      for (const pollId of pollIds) hidden.push({ ...scope, pollId });
      for (const snapshot of snapshots) if (snapshot.origin === view.origin && snapshot.userId === view.userId) {
        snapshot.records = snapshot.records.filter(record => !pollIds.has(record.sysId));
        snapshot.attachments = snapshot.attachments.filter(file => !pollIds.has(file.pollId));
      }
      const ids = new Set(selected.map(batch => batch.id));
      return { batches: batches.filter(batch => !(batch.origin === view.origin && batch.userId === view.userId && ids.has(batch.id))), result: {
        ...view, batches: view.batches.filter(batch => !ids.has(batch.id)),
        records: view.records.filter(record => !pollIds.has(record.sysId)),
        attachments: view.attachments.filter(file => !pollIds.has(file.pollId)),
      } };
    });
  }

  async reconcile(origin: string, history: PollHistory, fetchedAt: number): Promise<HistoryView> {
    const readable = new Set(history.records.map(record => record.jobId));
    return this.update((batches, hidden, snapshots) => {
      const exclusions = hidden.filter(item => item.origin === origin && item.userId === history.userId);
      const hiddenPolls = new Set(exclusions.map(item => item.pollId));
      const hiddenJobs = new Set(exclusions.flatMap(item => item.jobId ? [item.jobId] : []));
      const hiddenBatches = new Set(exclusions.map(item => item.batchId));
      history = { ...history, records: history.records.filter(record => !hiddenPolls.has(record.sysId) && !hiddenJobs.has(record.jobId)),
        attachments: history.attachments.filter(file => !hiddenPolls.has(file.pollId) && history.records.some(record => record.sysId === file.pollId && !hiddenJobs.has(record.jobId))) };
      const existing = snapshots.findIndex(item => item.origin === origin && item.userId === history.userId);
      const snapshot = { ...history, origin, fetchedAt };
      if (existing < 0) snapshots.push(snapshot); else snapshots[existing] = snapshot;
      batches = batches.filter(batch => !(batch.origin === origin && batch.userId === history.userId && hiddenBatches.has(batch.id)));
      batches = batches.map(batch => {
        if (batch.origin !== origin || batch.userId !== history.userId) return batch;
        const jobs = batch.jobs.filter(job => !hiddenJobs.has(job.jobId));
        return { ...batch, jobs, plannedJobs: batch.plannedJobs - (batch.jobs.length - jobs.length) };
      });
      batches = batches.filter(batch => batch.origin !== origin || batch.userId !== history.userId ||
        (batch.jobs.length > 0 && (batch.updatedAt > fetchedAt || batch.jobs.some(job => readable.has(job.jobId)))));
      return { batches, result: { ...history, origin,
        batches: batches.filter(batch => batch.origin === origin && batch.userId === history.userId)
          .sort((a, b) => b.createdAt - a.createdAt) } };
    });
  }
}
