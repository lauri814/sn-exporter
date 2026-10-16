import { normalizeFields } from '../export/plan';
import { supportsFieldSelection, type ExportMappings, type ExportSettings } from '../export/types';

export type PollStatus =
  | { status: 'running'; exportedRows?: number; totalRows?: number; message: string }
  | { status: 'completed'; attachmentId: string }
  | { status: 'failed'; message: string }
  | { status: 'unknown'; message: string };
const SYS_ID = /^[a-f0-9]{32}$/i;

export function initPayload(settings: ExportSettings, query: string, mappings: ExportMappings): string {
  const params = new URLSearchParams({
    sys_action: 'init', sysparm_target: settings.table, sysparm_query: query,
    sysparm_export: mappings[settings.fileType],
  });
  if (supportsFieldSelection(settings.fileType)) params.set('sysparm_display_value', String(settings.displayValues));
  const fields = supportsFieldSelection(settings.fileType) ? normalizeFields(settings.fields) : '';
  if (fields) params.set('sysparm_fields', fields);
  else if (supportsFieldSelection(settings.fileType) && settings.view !== undefined) params.set('sysparm_view', settings.view);
  return params.toString();
}
export function pollPayload(jobId: string): string {
  if (!SYS_ID.test(jobId)) throw new Error('Invalid processor job ID.');
  return new URLSearchParams({ sys_action: 'poll', job_id: jobId }).toString();
}
export function cancelPayload(jobId: string): string {
  if (!SYS_ID.test(jobId)) throw new Error('Invalid processor job ID.');
  return new URLSearchParams({ sys_action: 'cancel', job_id: jobId }).toString();
}
export function parseInitResponse(text: string): string {
  const value = text.trim();
  if (!SYS_ID.test(value)) throw new Error('The export processor did not return a job_id. Check the session and export permissions.');
  return value.toLowerCase();
}
export function parsePollResponse(text: string): PollStatus {
  const value = text.trim();
  const complete = /^complete\s*,\s*([a-f0-9]{32})$/i.exec(value);
  if (complete) return { status: 'completed', attachmentId: complete[1].toLowerCase() };
  if (/^Querying your data$/i.test(value)) return { status: 'running', message: value };
  const running = /^exported\s+(\d+)\s+of\s+(\d+)\s+rows\.?$/i.exec(value);
  if (running) {
    const exportedRows = Number(running[1]), totalRows = Number(running[2]);
    if (Number.isSafeInteger(exportedRows) && Number.isSafeInteger(totalRows) && exportedRows <= totalRows) {
      return { status: 'running', exportedRows, totalRows, message: value };
    }
  }
  if (/^(?:error|failed|failure|exception)(?:[\s,:]|$)/i.test(value)) {
    return { status: 'failed', message: value.slice(0, 500) };
  }
  return { status: 'unknown', message: 'Unexpected processor status. The job may still be running on ServiceNow. Check the session and processor response.' };
}
