// Pure helpers shared between bridge.mjs and the unit tests.
// Anything in here MUST be safe to import without side effects (no Discord
// client boot, no network, no env-coupled config). Move things into bridge.mjs
// the moment they need runtime state.

import fs from 'node:fs';

export const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;

export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

// Resolve a permission-mode string against the SDK's allowed set, falling back
// to 'bypassPermissions' (with a warning) for invalid values. Pulled out of
// bridge.mjs so we can unit-test the validation without booting Discord.
export function resolvePermissionMode(raw, logger = console.error) {
  const value = raw || 'bypassPermissions';
  if (!PERMISSION_MODES.includes(value)) {
    logger(`[config] invalid PERMISSION_MODE='${raw}', falling back to 'bypassPermissions'`);
    return 'bypassPermissions';
  }
  return value;
}

export function buildContent(text, attachments) {
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });

  const failed = [];
  const savedPaths = [];
  for (const att of attachments) {
    if (att.error) {
      failed.push(`${att.name ?? 'unnamed'} (failed: ${att.error})`);
      continue;
    }
    if (att.data && att.type && IMAGE_MIME.test(att.type)) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: att.type, data: att.data.toString('base64') },
      });
    } else if (att.data) {
      // Non-image: write to /tmp and inject path so Claude can Read it
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
    if (blocks.length === 0) blocks.push({ type: 'text', text: '(attachment)' });
    blocks[0].text = (blocks[0].text || '') + note;
  }

  if (blocks.length === 0) return null;
  if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text;
  return blocks;
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
