// main-rsi-guards.test.js: REGRESSION GUARD (2026-06-22, RSI)
//
// Locks four main-process fixes from the RSI audit: three IPC handlers that
// could reject the renderer promise unhandled on a malformed brand / disk /
// network error, and the get-brands hot-path memo. Pure source-scan.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('get-decrypted-config-path brand branch is wrapped in try/catch', () => {
  const i = main.indexOf("ipcMain.handle('get-decrypted-config-path'");
  assert.ok(i >= 0, 'handler not found');
  const block = main.slice(i, i + 1300);
  const rb = block.indexOf('readBrandConfig(brandName)');
  assert.ok(rb >= 0, 'readBrandConfig call not found');
  assert.match(block.slice(0, rb), /try\s*\{/, 'readBrandConfig (throws on bad brand) must sit inside a try');
  assert.ok(block.includes('return null'), 'returns null on failure instead of rejecting');
});

test('get-wisdom guards readBrandConfig against a malformed brand', () => {
  const i = main.indexOf("ipcMain.handle('get-wisdom'");
  assert.ok(i >= 0, 'handler not found');
  const block = main.slice(i, i + 600);
  assert.match(block, /try\s*\{\s*cfg\s*=\s*brandName\s*\?\s*readBrandConfig/,
    'readBrandConfig must be wrapped in a try with a config fallback');
});

test('rotate-relay-pairing wraps its awaits and returns a structured error', () => {
  const i = main.indexOf("ipcMain.handle('rotate-relay-pairing'");
  assert.ok(i >= 0, 'handler not found');
  const block = main.slice(i, i + 600);
  assert.match(block, /try\s*\{/, 'awaits must be wrapped in try');
  assert.match(block, /catch[\s\S]*?error:/, 'must return a structured error on failure');
});

test('get-brands has a short-TTL, mtime-keyed memo on the hot path', () => {
  const i = main.indexOf("ipcMain.handle('get-brands'");
  assert.ok(i >= 0, 'handler not found');
  const block = main.slice(i, i + 500);
  assert.ok(block.includes('_brandsMemo'), 'get-brands must consult a memo');
  assert.ok(block.includes('_brandsMemoDirMtime'), 'memo must be keyed on the brands-dir mtime (so add/remove refreshes instantly)');
});
