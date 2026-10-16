// Executed in the ServiceNow MAIN world so the existing session stays there.
export async function pageCsvAttachment(attachmentId: string): Promise<string> {
  if (!/^[a-f0-9]{32}$/i.test(attachmentId)) throw new Error('Invalid attachment sys_id.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const url = new URL('/sys_attachment.do', window.location.origin);
    url.searchParams.set('sys_id', attachmentId);
    const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error(`Attachment download returned HTTP ${response.status}.`);
    if (/text\/html/i.test(response.headers.get('Content-Type') ?? '')) {
      throw new Error('ServiceNow returned a page instead of a CSV attachment. Check your session.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
    if (/^\s*(?:\uFEFF)?\s*<(?:!doctype\s+html|html|form)\b/i.test(text)) {
      throw new Error('ServiceNow returned a page instead of a CSV attachment. Check your session.');
    }
    return text;
  } finally { clearTimeout(timer); }
}
