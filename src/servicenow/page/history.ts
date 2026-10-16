import type { PollHistory, HistoryQueryCache } from '../../history/types';

// Serialized into the ServiceNow MAIN world. Use its supported client API;
// identity comes from that page, never from a message-supplied user filter.
export async function pagePollHistory(caches: HistoryQueryCache[] = []): Promise<PollHistory> {
  type ClientRecord = {
    [field: string]: unknown;
    addQuery(field: string, operator: string, value?: string): void;
    setDisplayFields(fields: string[]): void;
    query(callback: (records: ClientRecord) => void): void;
    next(): boolean;
  };
  type Page = Window & {
    GlideRecord?: new (table: string) => ClientRecord;
    g_user?: { userID?: string };
    gsft_main?: Page;
  };
  let page = window as Page;
  try {
    const main = (window.top as Page)?.gsft_main;
    if (main?.g_user?.userID) page = main;
  } catch { /* Foreign parent; use the current content frame. */ }
  const Record = page.GlideRecord;
  const userId = page.g_user?.userID;
  if (!Record || !userId || !/^[a-f0-9]{32}$/i.test(userId)) {
    throw new Error('Open a logged-in ServiceNow content frame with client GlideRecord and g_user available.');
  }
  async function query(table: string, prepare: (record: ClientRecord) => void): Promise<ClientRecord[]> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error('Export history did not respond within 30 seconds. Try refreshing history.'));
      }, 30_000);
      try {
        const gr = new Record!(table);
        const fields = table === 'sys_poll'
          ? ['sys_id','job_id','state','current','max','message','sys_created_on','sys_updated_on']
          : ['sys_id','table_sys_id','file_name','content_type'];
        gr.setDisplayFields(fields);
        prepare(gr);
        gr.query(records => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          try {
            const result: ClientRecord[] = [];
            while (records.next()) {
              // Client GlideRecord reuses its current row; copy fields now.
              const row = {} as ClientRecord;
              for (const field of fields) row[field] = String(records[field] ?? '');
              result.push(row);
            }
            resolve(result);
          } catch (error) { reject(error); }
        });
      } catch (error) { settled = true; clearTimeout(timer); reject(error); }
    });
  }
  const cached = caches.find(item => item.userId.toLowerCase() === userId.toLowerCase());
  const validId = (id: string) => /^[a-f0-9]{32}$/.test(id);
  const hidden = new Set((cached?.hiddenPollIds ?? []).filter(validId));
  const hiddenJobs = new Set((cached?.hiddenJobIds ?? []).filter(validId));
  const known = [...new Set(cached?.knownJobIds ?? [])].filter(id => validId(id) && !hiddenJobs.has(id));
  const scope = (gr: ClientRecord) => {
    gr.addQuery('sys_created_on', 'RELATIVEGT', '@hour@ago@24');
    gr.addQuery('session_user', userId);
    for (let offset = 0; offset < hiddenJobs.size; offset += 100) gr.addQuery('job_id', 'NOT IN', [...hiddenJobs].slice(offset, offset + 100).join(','));
    for (let offset = 0; offset < hidden.size; offset += 100) gr.addQuery('sys_id', 'NOT IN', [...hidden].slice(offset, offset + 100).join(','));
  };
  const rows: ClientRecord[] = [];
  // Refresh cached jobs first. Discover other jobs only after those checks finish.
  for (let offset = 0; offset < known.length; offset += 100) {
    rows.push(...await query('sys_poll', gr => {
      scope(gr); gr.addQuery('job_id', 'IN', known.slice(offset, offset + 100).join(','));
    }));
  }
  rows.push(...await query('sys_poll', gr => {
    scope(gr);
    const excluded = known;
    for (let offset = 0; offset < excluded.length; offset += 100) gr.addQuery('job_id', 'NOT IN', excluded.slice(offset, offset + 100).join(','));
  }));
  const number = (value: unknown) => {
    const text = String(value ?? '');
    const parsed = /^\d+$/.test(text) ? Number(text) : NaN;
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const records = rows.filter(row => /^[a-f0-9]{32}$/i.test(String(row.sys_id)) && !hidden.has(String(row.sys_id).toLowerCase()) && !hiddenJobs.has(String(row.job_id).toLowerCase())).map(row => ({
    sysId: String(row.sys_id).toLowerCase(), jobId: String(row.job_id).toLowerCase(),
    state: String(row.state), current: number(row.current), max: number(row.max),
    message: String(row.message), createdOn: String(row.sys_created_on), updatedOn: String(row.sys_updated_on),
  }));
  const attachments: PollHistory['attachments'] = [];
  const delta = records.filter(record => {
    const previous = cached?.records.find(item => item.sysId === record.sysId);
    const files = cached?.attachments.filter(file => file.pollId === record.sysId) ?? [];
    if (previous && previous.updatedOn === record.updatedOn && previous.state === record.state &&
        previous.current === record.current && previous.max === record.max && files.length) {
      attachments.push(...files); return false;
    }
    return true;
  });
  // Only changed/new polls or polls still missing files need attachment metadata.
  for (let offset = 0; offset < delta.length; offset += 100) {
    const ids = delta.slice(offset, offset + 100).map(row => row.sysId);
    const files = await query('sys_attachment', gr => {
      gr.addQuery('table_name', 'sys_poll');
      gr.addQuery('table_sys_id', 'IN', ids.join(','));
    });
    for (const file of files) {
      const sysId = String(file.sys_id).toLowerCase(), pollId = String(file.table_sys_id).toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(sysId) || !ids.includes(pollId)) continue;
      attachments.push({ sysId, pollId, fileName: String(file.file_name), contentType: String(file.content_type) });
    }
  }
  return { userId: userId.toLowerCase(), records, attachments };
}
