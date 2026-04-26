// Unit tests for resolvePermissionMode().
//
// Importable surface: `resolvePermissionMode` is exported from ../../lib.mjs.
// The function was factored out of an IIFE in bridge.mjs so the validation
// logic can be exercised here without booting Discord. bridge.mjs calls it as
// `resolvePermissionMode(process.env.PERMISSION_MODE)` at startup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePermissionMode, PERMISSION_MODES } from '../../lib.mjs';

test('all four valid modes pass through unchanged', () => {
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'plan']) {
    assert.equal(resolvePermissionMode(mode, () => {}), mode);
  }
});

test('PERMISSION_MODES exports the same set the SDK supports', () => {
  assert.deepEqual(PERMISSION_MODES, ['default', 'acceptEdits', 'bypassPermissions', 'plan']);
});

test('invalid string falls back to bypassPermissions and warns', () => {
  const warnings = [];
  const got = resolvePermissionMode('rootMode', (m) => warnings.push(m));
  assert.equal(got, 'bypassPermissions');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invalid PERMISSION_MODE='rootMode'/);
  assert.match(warnings[0], /falling back to 'bypassPermissions'/);
});

test('typo "bypass" (without Permissions) falls back', () => {
  const warnings = [];
  const got = resolvePermissionMode('bypass', (m) => warnings.push(m));
  assert.equal(got, 'bypassPermissions');
  assert.equal(warnings.length, 1);
});

test('case-sensitive: "BypassPermissions" is rejected', () => {
  // The allow-list is exact-match. Be strict so config typos surface loudly.
  const got = resolvePermissionMode('BypassPermissions', () => {});
  assert.equal(got, 'bypassPermissions');
});

test('undefined defaults to bypassPermissions without warning', () => {
  const warnings = [];
  const got = resolvePermissionMode(undefined, (m) => warnings.push(m));
  assert.equal(got, 'bypassPermissions');
  assert.equal(warnings.length, 0, 'unset env is the documented default — no warning');
});

test('empty string defaults to bypassPermissions without warning', () => {
  // process.env.PERMISSION_MODE === '' is what you get from `PERMISSION_MODE=` in
  // a .env file. Treat it as unset, matching the `raw || 'bypassPermissions'` guard.
  const warnings = [];
  const got = resolvePermissionMode('', (m) => warnings.push(m));
  assert.equal(got, 'bypassPermissions');
  assert.equal(warnings.length, 0);
});

test('null defaults to bypassPermissions without warning', () => {
  const warnings = [];
  const got = resolvePermissionMode(null, (m) => warnings.push(m));
  assert.equal(got, 'bypassPermissions');
  assert.equal(warnings.length, 0);
});

test('default logger is console.error (smoke check — does not throw)', () => {
  // We can't easily assert console.error was called without monkeypatching,
  // but we can at least verify the default-arg code path doesn't crash.
  const got = resolvePermissionMode('default');
  assert.equal(got, 'default');
});
