// Unit tests for buildContent() and the IMAGE_MIME regex.
//
// Importable surface: `buildContent` and `IMAGE_MIME` come from ../../lib.mjs,
// the pure-helpers module we factored out of bridge.mjs so tests don't boot
// the Discord client.
//
// Cleanup: buildContent writes non-image attachments to /tmp/discord-* — the
// `after` hook below removes anything this file creates.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildContent, IMAGE_MIME } from '../../lib.mjs';

const createdPaths = new Set();

// Wrap fs.writeFileSync with a tracker so we can clean up everything we wrote.
// We snapshot /tmp before each test instead — simpler and side-effect-free.
function trackTmp(fn) {
  const before = new Set(fs.readdirSync('/tmp').filter(f => f.startsWith('discord-')));
  fn();
  const after = fs.readdirSync('/tmp').filter(f => f.startsWith('discord-'));
  for (const f of after) if (!before.has(f)) createdPaths.add(`/tmp/${f}`);
}

after(() => {
  for (const p of createdPaths) {
    try { fs.unlinkSync(p); } catch {}
  }
});

// ---------- IMAGE_MIME regex ----------

test('IMAGE_MIME matches png, jpeg, jpg, gif, webp', () => {
  for (const t of ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']) {
    assert.ok(IMAGE_MIME.test(t), `should match ${t}`);
  }
});

test('IMAGE_MIME is case-insensitive', () => {
  for (const t of ['IMAGE/PNG', 'Image/Jpeg', 'image/GIF', 'IMAGE/webp']) {
    assert.ok(IMAGE_MIME.test(t), `should match ${t}`);
  }
});

test('IMAGE_MIME rejects non-image MIME types', () => {
  for (const t of [
    'video/mp4', 'audio/mpeg', 'text/plain', 'application/pdf',
    'image/svg+xml', 'image/bmp', 'image/tiff', 'image/heic',
    '', 'image/', 'png', 'image/png; charset=utf-8',
  ]) {
    assert.ok(!IMAGE_MIME.test(t), `should NOT match ${t}`);
  }
});

// ---------- buildContent ----------

test('text-only with no attachments returns the raw string', () => {
  const out = buildContent('hello', []);
  assert.equal(out, 'hello');
});

test('empty text and no attachments returns null', () => {
  const out = buildContent('', []);
  assert.equal(out, null);
});

test('image attachment returns a blocks array with type:image and base64 data', () => {
  const data = Buffer.from([1, 2, 3, 4, 5]);
  const out = buildContent('check this', [
    { name: 'pic.png', type: 'image/png', size: data.length, data },
  ]);
  assert.ok(Array.isArray(out), 'expected blocks array');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { type: 'text', text: 'check this' });
  assert.equal(out[1].type, 'image');
  assert.equal(out[1].source.type, 'base64');
  assert.equal(out[1].source.media_type, 'image/png');
  assert.equal(out[1].source.data, data.toString('base64'));
});

test('image MIME variants (jpeg, JPG, webp) all produce image blocks', () => {
  for (const type of ['image/jpeg', 'IMAGE/JPG', 'image/webp', 'image/gif']) {
    const data = Buffer.from('xyz');
    const out = buildContent('hi', [{ name: 'f', type, size: 3, data }]);
    assert.ok(Array.isArray(out), `${type} should produce blocks`);
    assert.equal(out[1].type, 'image');
    assert.equal(out[1].source.media_type, type);
  }
});

test('non-image attachment is written to /tmp and noted in the text', () => {
  const data = Buffer.from('hello pdf bytes');
  let out;
  trackTmp(() => {
    out = buildContent('look at this', [
      { name: 'doc.pdf', type: 'application/pdf', size: data.length, data },
    ]);
  });
  // text-only result: blocks collapses to the string when only block 0 (text) survives.
  assert.equal(typeof out, 'string');
  assert.match(out, /^look at this/);
  assert.match(out, /\[attachments: \/tmp\/discord-\d+-doc\.pdf \(application\/pdf, 15b\)\]/);

  // Verify the file was actually written and contents match.
  const match = out.match(/\/tmp\/discord-\d+-doc\.pdf/);
  assert.ok(match, 'should have written a /tmp path');
  const written = fs.readFileSync(match[0]);
  assert.deepEqual(written, data);
});

test('non-image attachment with no name uses "unnamed" placeholder', () => {
  let out;
  trackTmp(() => {
    out = buildContent('hi', [
      { type: 'application/octet-stream', size: 4, data: Buffer.from('test') },
    ]);
  });
  assert.match(out, /\/tmp\/discord-\d+-unnamed/);
});

test('attachment name is sanitised of unsafe characters', () => {
  let out;
  trackTmp(() => {
    out = buildContent('hi', [
      { name: '../../etc/passwd', type: 'text/plain', size: 4, data: Buffer.from('test') },
    ]);
  });
  // All slashes/dots-as-traversal collapsed to underscores; only safe chars remain.
  const match = out.match(/\/tmp\/discord-\d+-([^ ]+)/);
  assert.ok(match);
  assert.equal(match[1], '.._.._etc_passwd');
});

test('failed attachment shows error note and is omitted from the path list', () => {
  const out = buildContent('hi', [
    { name: 'broken.png', type: 'image/png', size: 0, error: 'HTTP 500' },
  ]);
  assert.equal(typeof out, 'string');
  assert.match(out, /\[failed: broken\.png \(failed: HTTP 500\)\]/);
  assert.ok(!/attachments:/.test(out), 'should not have a saved-attachments note');
});

test('failed attachment with no name says "unnamed"', () => {
  const out = buildContent('hi', [{ error: 'boom' }]);
  assert.match(out, /\[failed: unnamed \(failed: boom\)\]/);
});

test('attachments-only with no text gets a (attachment) placeholder', () => {
  let out;
  trackTmp(() => {
    out = buildContent('', [
      { name: 'doc.pdf', type: 'application/pdf', size: 3, data: Buffer.from('pdf') },
    ]);
  });
  assert.equal(typeof out, 'string');
  assert.match(out, /^\(attachment\)/);
  assert.match(out, /\[attachments: \/tmp\/discord-\d+-doc\.pdf/);
});

test('image-only with no text returns just the image block (no placeholder)', () => {
  // Image-only path doesn't trigger the savedPaths/failed placeholder branch
  // — blocks already has the image, and there's no text block to inject into.
  const data = Buffer.from('img');
  const out = buildContent('', [
    { name: 'p.png', type: 'image/png', size: 3, data },
  ]);
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'image');
});

test('mixed: text + image + non-image + failed all combine correctly', () => {
  let out;
  trackTmp(() => {
    out = buildContent('hello', [
      { name: 'a.png', type: 'image/png', size: 1, data: Buffer.from('A') },
      { name: 'b.pdf', type: 'application/pdf', size: 1, data: Buffer.from('B') },
      { name: 'c.png', type: 'image/png', size: 0, error: 'HTTP 404' },
    ]);
  });
  assert.ok(Array.isArray(out));
  assert.equal(out[0].type, 'text');
  assert.match(out[0].text, /^hello/);
  assert.match(out[0].text, /\[attachments: \/tmp\/discord-\d+-b\.pdf/);
  assert.match(out[0].text, /\[failed: c\.png \(failed: HTTP 404\)\]/);
  assert.equal(out[1].type, 'image');
  assert.equal(out[1].source.media_type, 'image/png');
});

test('attachment with data but no type is treated as non-image', () => {
  let out;
  trackTmp(() => {
    out = buildContent('hi', [
      { name: 'f.bin', size: 4, data: Buffer.from('data') },
    ]);
  });
  assert.match(out, /\[attachments: \/tmp\/discord-\d+-f\.bin \(unknown, 4b\)\]/);
});
