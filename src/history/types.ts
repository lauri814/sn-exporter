import type { ExportSettings } from '../export/types';
export interface PollRecord {
  sysId: string;
  jobId: string;
  state: string;
  current: number | null;
  max: number | null;
  message: string;
  createdOn: string;
  updatedOn: string;
}

export interface HistoryAttachment {
  sysId: string;
  pollId: string;
  fileName: string;
  contentType: string;
}

export interface HistoryBatch {
  id: string;
  origin: string;
  userId: string;
  createdAt: number;
  updatedAt: number;
  settings: ExportSettings;
  plannedJobs: number;
  jobs: { number: number; jobId: string }[];
}

export interface HistoryView extends PollHistory {
  origin: string;
  batches: HistoryBatch[];
}

export interface PollHistory {
  userId: string;
  records: PollRecord[];
  attachments: HistoryAttachment[];
}

export interface HistoryQueryCache extends PollHistory {
  knownJobIds: string[];
  hiddenPollIds: string[];
  hiddenJobIds?: string[];
}
