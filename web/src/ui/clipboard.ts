// Copy text to the clipboard — also where navigator.clipboard is missing (a phone on plain http is not a secure
// context): a hidden textarea and execCommand('copy'). Rejects when neither worked.
export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  return new Promise((resolve, reject) => { try { legacyCopy(text); resolve(); } catch (e) { reject(e); } });
}

function legacyCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } finally { ta.remove(); }
  if (!ok) throw new Error('copy failed');
}
