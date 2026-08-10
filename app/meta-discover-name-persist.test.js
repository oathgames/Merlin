'use strict';

// REGRESSION GUARD (2026-08-07): Meta auto-discovery must persist each display
// NAME in lockstep with its id.
//
// History: the `meta-discover` IPC handler in main.js built its config patch as
//
//     const updates = { metaAdAccountId: d.adAccountId };
//     if (d.pageId) updates.metaPageId = d.pageId;
//     if (d.pixelId) updates.metaPixelId = d.pixelId;
//
// The names came back from the engine and were returned to the renderer, but
// were never written to disk. writeBrandTokens merges with Object.assign over
// the existing file, so any name already on disk survived untouched.
//
// Observed live on 2026-08-07: brand `clientco` had been seeded from Wellco's
// config. Once ClientCo's assets were shared, discovery correctly repointed the
// ids to act_100000000000002 / 200000004 / 200000003, but the
// file still read adAccountName "Wellco", pageName "Wellco Health", pixelName
// "Wellco Pixel". Every surface rendering those labels called ClientCo's ad
// account "Wellco" while it was configured to spend on ClientCo.
//
// These are source-scan tests rather than handler invocations because the block
// lives inside an execFile callback inside an ipcMain.handle registration in a
// ~10k-line main.js, with no seam to import. The invariant being protected is
// structural and reads cleanly off the source, which is the same approach taken
// by ws-server.test.js and mcp-approval-policy.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

/** Pull the `const updates = ...` patch block out of the meta-discover handler. */
function discoverUpdatesBlock() {
  const anchor = MAIN.indexOf("const updates = { metaAdAccountId:");
  assert.notStrictEqual(anchor, -1,
    'could not locate the meta-discover updates block — if it was renamed, retarget this test rather than deleting it');
  // The patch is assembled over the following few lines, before writeBrandTokens.
  const end = MAIN.indexOf('writeBrandTokens', anchor);
  assert.ok(end > anchor, 'updates block should be followed by writeBrandTokens');
  return MAIN.slice(anchor, end);
}

test('discovery persists adAccountName alongside metaAdAccountId', () => {
  const block = discoverUpdatesBlock();
  assert.match(block, /metaAdAccountId:\s*d\.adAccountId/,
    'the ad account id must still be persisted');
  assert.match(block, /adAccountName:\s*d\.adAccountName\s*\|\|\s*''/,
    'adAccountName must be persisted unconditionally with a || \'\' fallback, so a stale name cannot outlive the id it describes');
});

test('discovery persists pageName in the same branch that persists metaPageId', () => {
  const block = discoverUpdatesBlock();
  const line = block.split('\n').find((l) => l.includes('metaPageId'));
  assert.ok(line, 'expected a line assigning metaPageId');
  assert.match(line, /pageName\s*=\s*d\.pageName\s*\|\|\s*''/,
    'pageName must be written in the SAME branch as metaPageId — a separate `if (d.pageName)` would let the id update while the name goes stale');
});

test('discovery persists pixelName in the same branch that persists metaPixelId', () => {
  const block = discoverUpdatesBlock();
  const line = block.split('\n').find((l) => l.includes('metaPixelId'));
  assert.ok(line, 'expected a line assigning metaPixelId');
  assert.match(line, /pixelName\s*=\s*d\.pixelName\s*\|\|\s*''/,
    'pixelName must be written in the SAME branch as metaPixelId');
});

test('no name field is written behind its own truthiness guard', () => {
  const block = discoverUpdatesBlock();
  // `if (d.adAccountName)` / `if (d.pageName)` / `if (d.pixelName)` are exactly
  // the shape that reintroduces the bug: discovery resolves an id but not a
  // name, the assign is skipped, and the previous brand's name persists.
  for (const field of ['adAccountName', 'pageName', 'pixelName']) {
    assert.ok(!new RegExp(`if\\s*\\(\\s*d\\.${field}\\s*\\)`).test(block),
      `${field} must not be guarded on its own truthiness — write '' instead so the name always tracks the id`);
  }
});

test('every persisted meta id in the block has a name written beside it', () => {
  const block = discoverUpdatesBlock();
  const pairs = [
    ['metaAdAccountId', 'adAccountName'],
    ['metaPageId', 'pageName'],
    ['metaPixelId', 'pixelName'],
  ];
  for (const [idField, nameField] of pairs) {
    assert.ok(block.includes(idField), `${idField} should be persisted`);
    assert.ok(block.includes(nameField),
      `${idField} is persisted but ${nameField} is not — that is the exact drift this guard exists to prevent`);
  }
});

test('writeBrandTokens still merges rather than replaces (why the guard is needed)', () => {
  // This is the property that makes a missing name silently survive. If this
  // ever becomes a full replace, the lockstep requirement above gets weaker,
  // but the tests should be revisited deliberately rather than by surprise.
  const fn = MAIN.slice(MAIN.indexOf('function writeBrandTokens'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /Object\.assign\(existing,\s*tokens\)/,
    'writeBrandTokens is expected to merge onto existing config; if that changed, re-read the lockstep guards in this file');
});
