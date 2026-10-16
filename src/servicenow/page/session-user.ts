// Serialized into MAIN. Read identity from the current browser session only.
export function pageSessionUser(): string | null {
  type Page = Window & { g_user?: { userID?: string }; gsft_main?: Page };
  const current = window as Page;
  const candidates: Page[] = [];
  try { if ((window.top as Page)?.gsft_main) candidates.push((window.top as Page).gsft_main!); } catch { /* Foreign top. */ }
  candidates.push(current);
  try { if (window.parent) candidates.push(window.parent as Page); } catch { /* Foreign parent. */ }
  for (const page of candidates) {
    try {
      const userId = page.g_user?.userID;
      if (typeof userId === 'string' && /^[a-f0-9]{32}$/i.test(userId)) return userId.toLowerCase();
    } catch { /* Inaccessible candidate. */ }
  }
  return null;
}
