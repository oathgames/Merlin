// wedged-ui-teardown.test.js — REGRESSION GUARD (2026-06-30, wedged-UI sweep)
//
// Locks two renderer turn-end paths that previously left a visible progress
// state stuck on screen:
//  - onSdkError never stopped the live "Ns…" ticker or the stream watchdog, so
//    a thrown SDK error left the ticker's rAF loop counting forever.
//  - onInlineMessage (subscription-refused / trial-expired / billing) reset
//    every flag EXCEPT the phase label + watchdog, so "Starting session…" sat
//    frozen behind the inline error bubble.
//
// Pure source-scan.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

function handlerBody(src, anchor, len) {
  const i = src.indexOf(anchor);
  assert.ok(i >= 0, `anchor not found: ${anchor}`);
  return src.slice(i, i + len);
}

test('onSdkError stops the ticking timer AND the stream watchdog', () => {
  const body = handlerBody(R, 'merlin.onSdkError((err) =>', 1300);
  assert.ok(/stopTickingTimer\(\)/.test(body),
    'onSdkError must stopTickingTimer() — else the "Ns…" ticker counts forever');
  assert.ok(/stopStreamWatchdog\(\)/.test(body),
    'onSdkError must stopStreamWatchdog()');
  // and it must still clear the phase label (kept fix)
  assert.ok(/clearStatusLabel\(\)/.test(body), 'onSdkError must clearStatusLabel()');
});

test('onInlineMessage clears the phase label AND stops the watchdog', () => {
  const body = handlerBody(R, 'merlin.onInlineMessage(({ text, kind }) =>', 700);
  assert.ok(/clearStatusLabel\(\)/.test(body),
    'onInlineMessage must clearStatusLabel() — else "Starting session…" freezes behind the bubble');
  assert.ok(/stopStreamWatchdog\(\)/.test(body),
    'onInlineMessage must stopStreamWatchdog()');
  assert.ok(/stopTickingTimer\(\)/.test(body), 'onInlineMessage must stopTickingTimer() (kept)');
});
