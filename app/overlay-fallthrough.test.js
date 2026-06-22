// overlay-fallthrough.test.js — REGRESSION GUARD (2026-06-22, RSI)
//
// Bug: the brand-switcher button lives INSIDE #perf-bar, whose click handler
// opens the Revenue (stats) overlay. Clicking the button to open the brand
// switcher ALSO bubbled to the perf-bar handler and opened the Revenue window
// BEHIND the takeover; clicking a brand tile then closed the takeover and
// revealed it ("brand selection closes and the Revenue Performance window is
// open"). Root cause: missing stopPropagation + missing guard.
//
// Locks the three-part fix: (1) the button stops propagation, (2) the perf-bar
// opener excludes the button AND bails while a modal takeover is open, (3) a
// shared anyModalTakeoverOpen() helper covers every full-window takeover.
// Pure source-scan — no DOM, no Electron.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

test('brand-switcher button stops propagation so it cannot open the Revenue window', () => {
  const i = renderer.indexOf("getElementById('brand-switcher-btn')?.addEventListener('click'");
  assert.ok(i >= 0, 'brand-switcher-btn click handler not found');
  const block = renderer.slice(i, i + 600);
  assert.match(block, /addEventListener\('click',\s*\(e\)\s*=>/, 'handler must receive the event arg to stop propagation');
  assert.ok(block.includes('e.stopPropagation()'), 'brand-switcher-btn handler must call e.stopPropagation() (it is a child of #perf-bar)');
});

test('perf-bar Revenue opener ignores the brand-switcher button and bails under a takeover', () => {
  const i = renderer.indexOf("getElementById('perf-bar').addEventListener('click'");
  assert.ok(i >= 0, 'perf-bar click handler not found');
  const block = renderer.slice(i, i + 1000);
  assert.ok(block.includes("closest('#brand-switcher-btn')"), 'perf-bar guard must exclude #brand-switcher-btn');
  assert.ok(block.includes('anyModalTakeoverOpen()'), 'perf-bar handler must bail when a modal takeover is open');
});

test('anyModalTakeoverOpen covers every full-window takeover', () => {
  const i = renderer.indexOf('function anyModalTakeoverOpen()');
  assert.ok(i >= 0, 'anyModalTakeoverOpen() not defined');
  const block = renderer.slice(i, i + 400);
  for (const id of ['brand-switcher-overlay', 'wisdom-overlay', 'palantir-panel', 'agency-overlay']) {
    assert.ok(block.includes(`'${id}'`), `anyModalTakeoverOpen missing ${id}`);
  }
});
