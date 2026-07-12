// REGRESSION GUARD (2026-07-11 audit fix): approval-card id collision.
//
// pendingApprovals in main.js used to key cards with Date.now().toString().
// Two cards created in the same millisecond (parallel tool calls in one SDK
// turn) collided: the second setPendingApproval overwrote the first map
// entry, so the first card's promise never resolved and that tool call hung
// forever (until the 15-min auto-expiry denied the SURVIVING entry, which
// was the wrong one anyway). Fix: newApprovalId() returns
// crypto.randomUUID(), which is collision-free and fits ws-server.js's
// 64-char toolUseID bound (UUIDs are 36 chars).
//
// main.js requires electron, so the wiring is pinned by source scan; the
// uniqueness property is exercised directly against the same generator the
// helper delegates to.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function mainSrc() {
  return fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
}

test('no approval card is keyed by Date.now().toString()', () => {
  const src = mainSrc();
  const noComments = src.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(
    noComments,
    /toolUseID = Date\.now\(\)\.toString\(\)/,
    'approval cards must use newApprovalId() (crypto.randomUUID): millisecond keys collide under parallel tool calls and hang the losing promise forever',
  );
});

test('newApprovalId delegates to crypto.randomUUID and every card site uses it', () => {
  const src = mainSrc();
  const fnMatch = src.match(/function newApprovalId\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'newApprovalId() not found in main.js');
  assert.match(fnMatch[0], /randomUUID\(\)/, 'newApprovalId must return crypto.randomUUID()');
  const sites = src.match(/const toolUseID = newApprovalId\(\);/g) || [];
  assert.ok(sites.length >= 7,
    `expected at least 7 approval/question card sites keyed by newApprovalId(), found ${sites.length}`);
});

test('two cards created back-to-back get distinct ids', () => {
  // Exercises the exact generator newApprovalId delegates to, in the same
  // same-millisecond regime that broke the old Date.now() key.
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  assert.notEqual(a, b, 'same-tick ids must differ');
  // And the id must satisfy the ws-server.js transport bound (<= 64 chars,
  // string), so PWA-relayed approvals keep validating.
  for (const id of [a, b]) {
    assert.equal(typeof id, 'string');
    assert.ok(id.length <= 64, 'toolUseID must stay within the ws-server 64-char validation bound');
  }
  // Burst check: a whole same-millisecond batch stays collision-free.
  const burst = new Set();
  for (let i = 0; i < 1000; i++) burst.add(crypto.randomUUID());
  assert.equal(burst.size, 1000, 'no collisions across a 1000-card burst');
});
