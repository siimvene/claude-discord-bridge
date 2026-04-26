// Pure helpers shared between bridge.mjs and the unit tests.
// Anything in here MUST be safe to import without side effects (no Discord
// client boot, no network, no env-coupled config). Move things into bridge.mjs
// the moment they need runtime state.

import fs from 'node:fs';

export const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;

export function buildContent(text, attachments) {
  let contentText = text || '';

  const failed = [];
  const savedPaths = [];
  for (const att of attachments) {
    if (att.error) {
      failed.push(`${att.name ?? 'unnamed'} (failed: ${att.error})`);
      continue;
    }
    if (att.data) {
      // Write to /tmp and inject path so agent can Read it
      const safe = (att.name || 'unnamed').replace(/[^a-zA-Z0-9._-]/g, '_');
      const dest = `/tmp/discord-${Date.now()}-${safe}`;
      fs.writeFileSync(dest, att.data);
      savedPaths.push(`${dest} (${att.type ?? 'unknown'}, ${att.size}b)`);
    }
  }
  if (savedPaths.length || failed.length) {
    let note = '';
    if (savedPaths.length) note += `\n\n[attachments: ${savedPaths.join(', ')}]`;
    if (failed.length) note += `\n\n[failed: ${failed.join(', ')}]`;
    if (!contentText) contentText = '(attachment)';
    contentText += note;
  }

  return contentText || null;
}

export function splitMessage(text, maxLen = 2000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= maxLen) { chunks.push(text); break; }
    let idx = text.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = text.lastIndexOf(' ', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;
    chunks.push(text.slice(0, idx));
    text = text.slice(idx).trimStart();
  }
  return chunks;
}
