export interface ListContext {
  table: string | null;
  filter: string | null;
  rowCount: number | null;
  frameId?: number;
  userId?: string;
  view?: string;
}

// This function runs in the page's MAIN world. Keep it self-contained and
// return only list metadata; session cookies and g_ck stay in the page.
export function readListContext(frameOnly = false): ListContext {
  type List = { tableName?: string; filter?: string; grandTotalRows?: number | string; getTableName?: () => string; getQuery?: () => string };
  type Page = Window & { g_list?: List; g_user?: { userID?: string }; gsft_main?: Page };
  const page = window as Page;
  let list = page.g_list;
  try {
    const frame = document.querySelector<HTMLIFrameElement>('iframe#gsft_main');
    if (!frameOnly) list ??= page.gsft_main?.g_list ?? (frame?.contentWindow as Page | null)?.g_list;
  } catch { /* A cross-origin frame cannot supply list metadata. */ }
  const rawRows = list?.grandTotalRows;
  const rows = typeof rawRows === 'number' ? rawRows
    : typeof rawRows === 'string' && /^\d+$/.test(rawRows) ? Number(rawRows) : null;
  const view = window.location?.href ? new URL(window.location.href).searchParams.get('sysparm_view') : null;
  const userId = page.g_user?.userID;
  return {
    ...(typeof userId === 'string' && /^[a-f0-9]{32}$/i.test(userId) ? { userId: userId.toLowerCase() } : {}),
    table: list?.getTableName?.() ?? list?.tableName ?? null,
    filter: list?.getQuery?.() ?? list?.filter ?? null,
    rowCount: rows !== null && Number.isSafeInteger(rows) && rows >= 0 ? rows : null,
    ...(view !== null ? { view } : {}),
  };
}
