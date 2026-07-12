// main-rsi-guards.test.js: REGRESSION GUARD (2026-06-22, RSI)
//
// Locks main-process fixes from the RSI audit: IPC handlers that could
// reject the renderer promise unhandled on a malformed brand / disk /
// network error, the get-brands hot-path memo, and (since the 2026-07
// audit) the removal of the get-decrypted-config-path leak primitive.
// Pure source-scan.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('get-decrypted-config-path handler stays removed (2026-07 audit)', () => {
  // Updated 2026-07 audit: the handler was a dead leak primitive (no preload
  // bridge, no invoker) hardened in place on 2026-06-30 and then fully
  // removed. Absence is the strongest form of the 2026-06-30 guard. If it
  // ever comes back it must strict-scope via buildStrictBrandConfig and
  // write only under .claude/tools/; see the removal comment in main.js.
  assert.ok(!main.includes("ipcMain.handle('get-decrypted-config-path'"),
    'get-decrypted-config-path must stay deleted; see main.js removal comment');
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
