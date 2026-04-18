// rollout-flag.test.js — Phase 12 gate tests.
//
// Verifies that the renderer's module-level `factBindingEnabled` resolves
// correctly from the two supported switches:
//   (a) window.__merlinFactBindingForceOn (main.js → renderer IPC push)
//   (b) globalThis.MERLIN_FACT_BINDING === '1' (dev env override)
//
// We can't load renderer.js directly (it touches DOM globals), so this
// test re-implements the exact resolution stanza and asserts the matrix
// of inputs → output. The real renderer.js stanza MUST stay in lockstep
// with this copy — if the lines diverge, rollout can silently stay off.
//
// A secondary test validates version.json shape: the new `featureFlags`
// block must parse clean, `factBinding` must default false, and the
// `_doc` string must not be empty (if it lands empty, future devs will
// think the block is vestigial and delete it).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Mirror of renderer.js lines 13–21 (see Phase 12 rollout block). If these
// lines change in renderer.js, update them here too and re-run the test.
function resolveFactBindingEnabled({ windowForceOn, globalEnv }) {
  const fakeWindow = windowForceOn !== undefined ? { __merlinFactBindingForceOn: windowForceOn } : undefined;
  const fakeGlobal = globalEnv !== undefined ? { MERLIN_FACT_BINDING: globalEnv } : undefined;
  try {
    if (typeof fakeWindow !== 'undefined' && fakeWindow && fakeWindow.__merlinFactBindingForceOn === true) return true;
    if (typeof fakeGlobal !== 'undefined' && fakeGlobal && fakeGlobal.MERLIN_FACT_BINDING === '1') return true;
  } catch { /* isolation — stay off */ }
  return false;
}

test('Phase 12: default off when neither switch set', () => {
  assert.equal(resolveFactBindingEnabled({}), false);
});

test('Phase 12: window.__merlinFactBindingForceOn=true turns on', () => {
  assert.equal(resolveFactBindingEnabled({ windowForceOn: true }), true);
});

test('Phase 12: window.__merlinFactBindingForceOn=false stays off', () => {
  // A non-strict "truthy" value must NOT flip the flag — we insist on === true
  // to avoid an accidental `window.__merlinFactBindingForceOn = 1` turning
  // fact-binding on without intent.
  assert.equal(resolveFactBindingEnabled({ windowForceOn: false }), false);
  assert.equal(resolveFactBindingEnabled({ windowForceOn: 1 }), false);
  assert.equal(resolveFactBindingEnabled({ windowForceOn: 'true' }), false);
});

test('Phase 12: MERLIN_FACT_BINDING="1" turns on', () => {
  assert.equal(resolveFactBindingEnabled({ globalEnv: '1' }), true);
});

test('Phase 12: MERLIN_FACT_BINDING="0" / missing / other values stay off', () => {
  assert.equal(resolveFactBindingEnabled({ globalEnv: '0' }), false);
  assert.equal(resolveFactBindingEnabled({ globalEnv: undefined }), false);
  assert.equal(resolveFactBindingEnabled({ globalEnv: 'true' }), false);
  assert.equal(resolveFactBindingEnabled({ globalEnv: 1 }), false); // not the string "1"
});

test('Phase 12: window force-on beats missing env', () => {
  assert.equal(resolveFactBindingEnabled({ windowForceOn: true, globalEnv: undefined }), true);
});

test('Phase 12: version.json featureFlags block is present and default-off', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'version.json'), 'utf8');
  const v = JSON.parse(raw);
  assert.ok(v.featureFlags, 'version.json is missing featureFlags block');
  assert.equal(v.featureFlags.factBinding, false,
    'factBinding must default to false until explicit rollout');
  assert.ok(typeof v.featureFlags._doc === 'string' && v.featureFlags._doc.length > 20,
    '_doc must be non-empty so the block survives future refactors');
});
