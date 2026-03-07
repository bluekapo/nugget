/**
 * Escape HTML special characters for safe embedding in Telegram HTML mode.
 * Order matters: & must be escaped first to avoid double-escaping.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Wrap text in Telegram-compatible <pre> tags, escaping HTML inside.
 * Optionally prepend a bold header line above the <pre> block.
 */
export function wrapPre(text: string, header?: string | null): string {
  const pre = `<pre>${escapeHtml(text)}</pre>`;
  if (header) return `<b>${escapeHtml(header)}</b>\n${pre}`;
  return pre;
}
