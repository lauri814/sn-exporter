// Serialized into the ServiceNow page's MAIN world. Keep this self-contained:
// session credentials and CSRF tokens must never cross the extension boundary.
export async function pageProcessorRequest(body: string): Promise<string> {
  type SessionPage = Window & { g_ck?: string };
  let token = (window as SessionPage).g_ck;
  if (!token) {
    try { token = (window.parent as SessionPage).g_ck; } catch { /* Cross-origin parent. */ }
  }
  if (typeof token !== 'string' || !token) throw new Error('The ServiceNow session token is unavailable. Reopen the list in your logged-in session.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(new URL('/poll_processor.do', window.location.origin), {
      method: 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-UserToken': token },
      body,
    });
    if (!response.ok) throw new Error(`The export processor returned HTTP ${response.status}. Check session and export permissions.`);
    return await response.text();
  } finally { clearTimeout(timer); }
}
