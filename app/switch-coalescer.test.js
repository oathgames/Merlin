// Tests for switch-coalescer.js and its main.js/renderer.js wiring.
// Fix for the 2026-07-11 "sometimes I have to click a brand twice" report:
// the switch-brand handler used to REJECT a mid-switch click ("switch
// already in progress") and bail after 2s of SDK-loop unwind ("try again"),
// both of which punted the retry to the user.
//
// Run with: node --test app/switch-coalescer.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { createSwitchCoalescer } = require('./switch-coalescer');
const MAIN_JS = readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const RENDERER_JS = readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('a single switch executes with its target', async () => {
  const c = createSwitchCoalescer();
  const out = await c.run('brandA', async (t) => ({ success: true, brand: t }));
  assert.deepEqual(out, { success: true, brand: 'brandA' });
});

test('a click landing mid-switch queues and runs after it, never rejected', async () => {
  const c = createSwitchCoalescer();
  const gate = deferred();
  const order = [];
  const first = c.run('brandA', async (t) => { order.push(`start:${t}`); await gate.promise; order.push(`end:${t}`); return { success: true, brand: t }; });
  // Let brandA's body actually START (real clicks are hundreds of ms apart;
  // a click that arrives before the prior one even begins is legitimately
  // superseded, covered by the last-click-wins test below).
  await new Promise((r) => setImmediate(r));
  const second = c.run('brandB', async (t) => { order.push(`start:${t}`); return { success: true, brand: t }; });
  // First is in-flight, second is queued behind it (not rejected).
  gate.resolve();
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.success, true);
  assert.equal(r1.brand, 'brandA');
  assert.equal(r2.success, true);
  assert.equal(r2.brand, 'brandB');
  assert.deepEqual(order, ['start:brandA', 'end:brandA', 'start:brandB']);
});

test('last click wins: intermediate queued switches resolve superseded and never execute', async () => {
  const c = createSwitchCoalescer();
  const gate = deferred();
  const executed = [];
  const doSwitch = async (t) => { executed.push(t); if (t === 'brandA') await gate.promise; return { success: true, brand: t }; };
  const pA = c.run('brandA', doSwitch); // in-flight (given a tick to start)
  await new Promise((r) => setImmediate(r));
  const pB = c.run('brandB', doSwitch); // queued, then superseded by C
  const pC = c.run('brandC', doSwitch); // newest: the one that runs
  gate.resolve();
  const [rA, rB, rC] = await Promise.all([pA, pB, pC]);
  assert.equal(rA.success, true, 'in-flight switch completes normally');
  assert.equal(rB.success, false);
  assert.equal(rB.superseded, true, 'stale queued click resolves superseded');
  assert.equal(rC.success, true);
  assert.equal(rC.brand, 'brandC');
  assert.deepEqual(executed, ['brandA', 'brandC'], 'superseded target never executes');
});

test('a throwing switch surfaces as a failure result and never wedges the queue', async () => {
  const c = createSwitchCoalescer();
  const bad = await c.run('brandA', async () => { throw new Error('boom'); });
  assert.equal(bad.success, false);
  assert.equal(bad.error, 'boom');
  const next = await c.run('brandB', async (t) => ({ success: true, brand: t }));
  assert.equal(next.success, true, 'queue keeps working after a failure');
});

test('a switch returning a failure result does not block later switches', async () => {
  const c = createSwitchCoalescer();
  const fail = await c.run('brandA', async () => ({ success: false, error: 'brand not found' }));
  assert.equal(fail.success, false);
  const ok = await c.run('brandB', async (t) => ({ success: true, brand: t }));
  assert.equal(ok.success, true);
});

// ── main.js wiring locks ────────────────────────────────────────────────

test('switch-brand routes through the coalescer and the reject-guard is gone', () => {
  assert.ok(MAIN_JS.includes("require('./switch-coalescer')"), 'module imported');
  assert.ok(MAIN_JS.includes('_brandSwitchCoalescer.run(targetBrand, doSwitchBrand)'),
    'handler enqueues through the coalescer');
  assert.ok(!MAIN_JS.includes('switch already in progress'),
    'the old reject-with-retry-punt string must stay deleted');
  assert.ok(!MAIN_JS.includes('did not stop in time'),
    'the old 2s "try again" bail must stay deleted');
});

test('_switchInProgress still guards queue-drain session boots (2026-07-04 guard)', () => {
  // The boolean is no longer a reject-guard but startSessionForQueuedMessage
  // still depends on it; doSwitchBrand must set and clear it.
  assert.ok(/function startSessionForQueuedMessage\(\)\s*\{\s*\n?\s*if \(activeQuery \|\| _switchInProgress\) return;/.test(MAIN_JS),
    'queue-drain guard still consults _switchInProgress');
  const fnStart = MAIN_JS.indexOf('async function doSwitchBrand(');
  assert.ok(fnStart > 0, 'doSwitchBrand extracted');
  const fn = MAIN_JS.slice(fnStart, MAIN_JS.indexOf('\nipcMain.handle(', fnStart) > 0
    ? MAIN_JS.indexOf('\nipcMain.handle(', fnStart)
    : fnStart + 8000);
  assert.ok(fn.includes('_switchInProgress = true'), 'body sets the in-flight flag');
  assert.ok(fn.includes('_switchInProgress = false'), 'finally clears the in-flight flag');
});

test('the interrupt await is bounded and the unwind wait uses the extended constant', () => {
  assert.ok(MAIN_JS.includes('SWITCH_INTERRUPT_TIMEOUT_MS'), 'interrupt timeout constant exists');
  assert.ok(/Promise\.race\(\[\s*\n?\s*activeQuery\.interrupt\(\)/.test(MAIN_JS),
    'interrupt is raced against a timeout, never awaited unbounded');
  assert.ok(MAIN_JS.includes('const SWITCH_UNWIND_TIMEOUT_MS = 10000'),
    'unwind patience extended past the old 2s');
  assert.ok(MAIN_JS.includes('Date.now() + SWITCH_UNWIND_TIMEOUT_MS'),
    'unwind deadline uses the named constant');
});

// ── renderer.js wiring locks ────────────────────────────────────────────

test('renderer handles superseded before the success/failure branches', () => {
  // 2026-07-23: this used to assert a bare `superseded) return;` silent no-op.
  // That was correct only when a newer USER switch was actually pending. The
  // main process bumps its coalescer sequence on every switch-brand call
  // (including the failure-recovery re-switch, which no click produced), so a
  // superseded reply could arrive with nothing newer behind it, and the bare
  // return left sel.value advanced past the confirmed brand. See the
  // brand-switch-stuck-on-previous guard in renderer.js. The ordering
  // invariant this test was really protecting still holds.
  const supIdx = RENDERER_JS.indexOf('swapResult.superseded');
  assert.ok(supIdx > 0, 'superseded branch present');
  const successIdx = RENDERER_JS.indexOf('swapResult && swapResult.success');
  assert.ok(supIdx < successIdx, 'superseded check runs before the success/failure branches');
});

test('superseded only leaves the UI untouched when a NEWER renderer switch is pending', () => {
  // The reconcile is what stops sel.value from drifting past the confirmed
  // brand and bricking the next click on that brand.
  assert.match(RENDERER_JS, /let\s+_brandSwitchSeq\s*=\s*0/,
    'renderer must keep its own switch ticket; the main-process coalescer sequence cannot tell a user click from an internal re-switch');
  assert.match(RENDERER_JS, /const\s+mySwitchSeq\s*=\s*\+\+_brandSwitchSeq/,
    'the change handler must capture a ticket before awaiting the swap');
  const supIdx = RENDERER_JS.indexOf('swapResult.superseded');
  const branch = RENDERER_JS.slice(supIdx, supIdx + 700);
  assert.match(branch, /mySwitchSeq\s*===\s*_brandSwitchSeq/,
    'superseded must check whether a newer renderer-initiated switch actually exists');
  assert.match(branch, /e\.target\.value\s*=\s*prevBrand/,
    'with nothing newer pending, superseded must put the select back on the confirmed brand');
});

test('the takeover re-click guard compares against the CONFIRMED brand', () => {
  // REGRESSION GUARD (2026-07-23, brand-switch-stuck-on-previous): guarding on
  // sel.value (optimistic, advanced before confirmation) made a re-click on the
  // brand you were trying to reach a permanent silent no-op whenever a prior
  // attempt left the value advanced. dataset.lastValue only advances on a
  // confirmed success, so it is the only safe thing to compare against.
  const idx = RENDERER_JS.indexOf('function chooseBrandFromTakeover');
  assert.ok(idx > 0, 'chooseBrandFromTakeover must exist');
  const fn = RENDERER_JS.slice(idx, idx + 1600);
  assert.match(fn, /dataset\.lastValue/,
    'the guard must read dataset.lastValue (the confirmed brand)');
  assert.doesNotMatch(fn, /if\s*\(name === getActiveBrandSelection\(\)\)\s*return/,
    'the guard must NOT compare against getActiveBrandSelection() / sel.value: that is the optimistic value and re-clicking the target brand would silently do nothing');
});

test('renderer escalates the placeholder to honest progress copy past 800ms', () => {
  assert.ok(RENDERER_JS.includes('Still switching to ${preseedLabel}'),
    'progress copy present');
  assert.ok(/stillSwitchingTimer = setTimeout\(/.test(RENDERER_JS), 'timer armed');
  assert.ok(RENDERER_JS.includes('if (stillSwitchingTimer) clearTimeout(stillSwitchingTimer);'),
    'timer cleared once the swap resolves');
});
