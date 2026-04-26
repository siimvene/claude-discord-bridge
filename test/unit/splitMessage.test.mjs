// Unit tests for splitMessage().
//
// Importable surface: `splitMessage` is exported from ../../lib.mjs (a small
// companion file we factored out of bridge.mjs so tests can run offline
// without booting the Discord client). bridge.mjs re-imports it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage } from '../../lib.mjs';

test('short text passes through as a single chunk', () => {
  assert.deepEqual(splitMessage('hello world', 2000), ['hello world']);
});

test('exact-length text passes through as a single chunk', () => {
  const s = 'a'.repeat(2000);
  assert.deepEqual(splitMessage(s, 2000), [s]);
});

test('one-over-limit text splits into two chunks', () => {
  const s = 'a'.repeat(2001);
  const chunks = splitMessage(s, 2000);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join(''), s);
});

test('long text with newlines splits at the last newline before maxLen', () => {
  // Build a string where there's a newline well past the 30% threshold but
  // before maxLen, so splitMessage prefers the newline boundary.
  const head = 'line one is here\n' + 'x'.repeat(50) + '\n'; // newline near end
  const tail = 'y'.repeat(80);
  const text = head + tail;
  const chunks = splitMessage(text, 100);
  assert.ok(chunks.length >= 2, 'should split into multiple chunks');
  // The first chunk should END at a newline boundary (no trailing newline kept
  // by splitMessage — it slices up to idx, then trimStart()s the rest).
  assert.ok(!chunks[0].includes(tail), 'first chunk should not contain tail');
  assert.equal(chunks.join('').replace(/\n/g, '').length, text.replace(/\n/g, '').length - 0);
});

test('text with no newlines splits at the last space before maxLen', () => {
  const words = Array(100).fill('word').join(' '); // 'word word word ...'
  const chunks = splitMessage(words, 50);
  assert.ok(chunks.length > 1);
  // No chunk should split a word in half — every chunk start must be a 'word'
  // since trimStart removes the leading space we cut on.
  for (const c of chunks) {
    assert.match(c, /^word/, `chunk should start at a word boundary, got: ${JSON.stringify(c.slice(0, 20))}`);
  }
});

test('text with no newlines and no spaces falls back to a hard cut', () => {
  const s = 'a'.repeat(250);
  const chunks = splitMessage(s, 100);
  // First chunk hard-cut at exactly maxLen, remaining text continues.
  assert.equal(chunks[0].length, 100);
  assert.equal(chunks.join(''), s);
  assert.ok(chunks.length >= 3);
});

test('empty string returns a single empty chunk', () => {
  // length 0 <= maxLen, so the function returns [text] without entering the loop.
  assert.deepEqual(splitMessage('', 2000), ['']);
});

test('default maxLen is 2000', () => {
  const s = 'a'.repeat(2001);
  const chunks = splitMessage(s);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].length <= 2000);
});

test('a newline that lands before the 30% threshold is ignored in favour of space', () => {
  // maxLen=100, threshold=30. Put a newline at position 5 (well below 30) and
  // a space at position 80 (above 30). splitMessage should pick the space.
  const text = 'abcd\n' + 'x'.repeat(74) + ' ' + 'y'.repeat(200);
  const chunks = splitMessage(text, 100);
  // First chunk should end at the space, not the newline near the start.
  assert.ok(chunks[0].length > 30, `first chunk too short — fell into newline trap: ${chunks[0].length}`);
  assert.equal(chunks.join('').replace(/ /g, ''), text.replace(/ /g, ''));
});
