export const FILE_TYPES = ['csv', 'xlsx', 'xml', 'json'] as const;
export type FileType = typeof FILE_TYPES[number];
export const supportsFieldSelection = (fileType: FileType) => fileType === 'csv' || fileType === 'xlsx';
export type ExportMappings = Record<FileType, string>;

export interface ExportSettings {
  table: string;
  query: string;
  fileType: FileType;
  fields: string;
  filenamePrefix?: string;
  displayValues: boolean;
  view?: string;
  rowCount: number;
  targetChunkSize: number;
  concurrency: number;
  pollingIntervalSeconds?: number;
}
export interface ExportJob {
  id: number;
  query: string;
  status: 'queued' | 'submitting' | 'submission_unknown' | 'running' | 'completed' | 'failed' | 'cancelled';
  jobId?: string;
  attachmentId?: string;
  exportedRows?: number;
  totalRows?: number;
  message?: string;
  downloadId?: number;
  downloadState?: 'in_progress' | 'complete' | 'interrupted';
  downloadError?: string;
  fileRowCount?: number;
}
export interface ExportRun {
  id: string;
  tabId: number;
  userId?: string;
  frameId: number;
  origin: string;
  settings: ExportSettings;
  jobs: ExportJob[];
  status: 'running' | 'completed' | 'failed' | 'paused' | 'cancelling' | 'cancelled';
  message?: string;
  createdAt: number;
  finishedAt?: number;
  revision?: number;
  needsReview?: boolean;
  cancelRequested?: boolean;
  nextPollAt?: number;
  csvVerifiedAt?: number;
}
