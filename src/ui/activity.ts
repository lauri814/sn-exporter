import { html } from 'lit';

export function activity(message: string, busy: boolean, id: string) {
  return html`<p id=${id} role="status" class="flex w-full items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
    ${busy ? html`<span aria-hidden="true" class="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"></span>` : ''}
    <span>${message}</span>
  </p>`;
}
