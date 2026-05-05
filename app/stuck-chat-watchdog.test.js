// stuck-chat-watchdog.test.js — pins the dual-layer recovery contract
// for the stuck-chat-no-result-event incident (2026-05-04).
//
// Live incident: user sent a message, the model started streaming a
// response, and mid-sentence the stream went silent ("fetching their
// back-image URLs in parallel.|" with a blinking cursor). The renderer
// stayed wedged — input disabled, status pill stuck, even switching
// brands did not reset the streaming state. Customer churned.
//
// Two failure modes, two layers of recovery:
//
//   (a) For-await loop ENDS naturally without emitting `result`
//       — Anthropic API closed stream mid-turn, network truncation,
//       MCP tool returned EOF before the model finished its turn.
//       main.js detects this with the _sawTerminalResult flag and
//       synthesizes a {type:'result', subtype:'truncated',
//       _synthetic:true} terminal so the renderer's existing
//       result-handler path runs.
//
//   (b) For-await loop is BLOCKED indefinitely
//       — MCP tool hung past the SDK's internal timeout but didn't
//       bubble, network connection dropped silently. The for-await
//       loop is alive but starved of events; main.js can't help us
//       (it's also blocked on `await` inside the iterator). Renderer-
//       side stream watchdog: STREAM_STALL_MS without an event during
//       an active turn → force-recover the UI directly + abortActiveQuery.
//
// Plus: brand-switch is the user's escape hatch when the chat is
// wedged. It MUST clear ALL turn-state flags (not just isStreaming).

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

// ── Layer (a) — main.js synthesizes a terminal on iterator-natural-end ──

test('main.js for-await tracks _sawTerminalResult', () => {
  // The flag MUST be declared before the for-await and set inside it.
  assert.match(mainSrc, /let\s+_sawTerminalResult\s*=\s*false/,
    'main.js must declare _sawTerminalResult flag');
  assert.match(mainSrc, /if\s*\(\s*msg\s*&&\s*msg\.type\s*===\s*['"]result['"]\s*\)\s*_sawTerminalResult\s*=\s*true/,
    'main.js must flip _sawTerminalResult inside the for-await loop on every result message');
});

test('main.js synthesizes a truncated result when iterator ends without one', () => {
  // After the for-await closes (BEFORE the catch), main.js must check
  // _sawTerminalResult and emit a synthetic result on the IPC + ws bus
  // so the renderer cleans up its UI.
  assert.match(mainSrc, /if\s*\(\s*!_sawTerminalResult\s*&&\s*win/,
    'main.js must guard the synthetic-result emission on !_sawTerminalResult');
  // Synthetic shape contract — renderer keys on _synthetic + subtype.
  assert.match(mainSrc, /subtype:\s*['"]truncated['"]/, 'synthetic result must use subtype:"truncated"');
  assert.match(mainSrc, /_synthetic:\s*true/, 'synthetic result must carry _synthetic:true');
  assert.match(mainSrc, /win\.webContents\.send\(\s*['"]sdk-message['"]\s*,\s*synthetic\s*\)/,
    'synthetic result must be broadcast via win.webContents.send to the renderer');
});

// ── Layer (b) — renderer.js stream watchdog ────────────────────────

test('renderer.js declares STREAM_STALL_MS + bumpStreamWatchdog + stopStreamWatchdog', () => {
  assert.match(rendererSrc, /const\s+STREAM_STALL_MS\s*=\s*\d+/,
    'renderer.js must declare STREAM_STALL_MS constant');
  assert.match(rendererSrc, /function\s+bumpStreamWatchdog\s*\(/,
    'renderer.js must export bumpStreamWatchdog');
  assert.match(rendererSrc, /function\s+stopStreamWatchdog\s*\(/,
    'renderer.js must export stopStreamWatchdog');
});

test('renderer.js arms the watchdog on user send and bumps it on every SDK message', () => {
  // sendMessage MUST arm the watchdog before merlin.sendMessage(text).
  const sendBlock = rendererSrc.match(/sessionActive\s*=\s*true;\s*\n\s*startTickingTimer\(\);[\s\S]{0,200}?merlin\.sendMessage\(text\)/);
  assert.ok(sendBlock, 'sendMessage block must exist');
  assert.match(sendBlock[0], /bumpStreamWatchdog\(\)/,
    'sendMessage MUST call bumpStreamWatchdog before merlin.sendMessage to arm the stall detector');

  // onSdkMessage MUST bump on every non-_synthetic message.
  const onSdkIdx = rendererSrc.indexOf('merlin.onSdkMessage((msg) => {');
  assert.ok(onSdkIdx > 0, 'onSdkMessage handler block must exist');
  const onSdkRegion = rendererSrc.slice(onSdkIdx, onSdkIdx + 1500);
  assert.match(onSdkRegion, /bumpStreamWatchdog\(\)/,
    'onSdkMessage MUST call bumpStreamWatchdog on every message so the timer resets while the stream is alive');
  assert.match(onSdkRegion, /!msg\._synthetic/,
    'onSdkMessage must skip the bump on _synthetic messages (those signal end-of-turn, not progress)');
});

test('renderer.js stops the watchdog on result (real or synthetic)', () => {
  // Anchor on the case directly + scan a generous window forward.
  const startIdx = rendererSrc.indexOf("case 'result':");
  assert.ok(startIdx > 0, "result case must exist");
  const region = rendererSrc.slice(startIdx, startIdx + 4000);
  assert.match(region, /stopStreamWatchdog\(\)/,
    'result handler MUST call stopStreamWatchdog so a successful turn doesn\'t leave the watchdog armed for the next idle period');
});

test('renderer.js result-handler renders a visible truncation marker', () => {
  const startIdx = rendererSrc.indexOf("case 'result':");
  assert.ok(startIdx > 0, "result case must exist");
  const region = rendererSrc.slice(startIdx, startIdx + 4000);
  assert.match(region, /msg\._synthetic\s*&&\s*msg\.subtype\s*===\s*['"]truncated['"]/,
    'result handler must detect the synthetic-truncated terminal');
  assert.match(region, /textBuffer\s*\+=\s*['"]⚠/,
    'truncated terminal must append a ⚠️ marker so the user sees the response was incomplete');
});

// ── Brand-switch full reset (defense-in-depth) ─────────────────────

test('paintBrandThread clears ALL turn-state flags, not just isStreaming', () => {
  // Pre-fix only isStreaming was reset, so a hung turn could leave
  // sessionActive / input-disabled / status pill / typing indicator
  // hanging across a brand switch. The full reset is the user's
  // escape hatch.
  const fn = rendererSrc.match(/function\s+paintBrandThread\([^)]*\)\s*\{[\s\S]{0,1500}?\n\}/);
  assert.ok(fn, 'paintBrandThread function must exist');
  for (const required of [
    'sessionActive = false',
    'setInputDisabled(false)',
    'removeTypingIndicator()',
    'clearStatusLabel()',
    'stopTickingTimer()',
    'stopStreamWatchdog()',
  ]) {
    assert.ok(fn[0].includes(required),
      `paintBrandThread must call ${required} (defense-in-depth on stuck-chat-brand-switch-no-reset incident)`);
  }
});

test('preseedBrandSwitch mirrors paintBrandThread full-reset', () => {
  // The preseed runs synchronously at brand-switch start; the full
  // paint runs ~150-450ms later. If the chat is hung BEFORE the
  // swap, only the preseed's reset is what actually unsticks the
  // input bar within the user's reaction window.
  const fn = rendererSrc.match(/function\s+preseedBrandSwitch\([^)]*\)\s*\{[\s\S]{0,2000}?\n\}/);
  assert.ok(fn, 'preseedBrandSwitch function must exist');
  for (const required of [
    'sessionActive = false',
    'setInputDisabled(false)',
    'stopStreamWatchdog()',
  ]) {
    assert.ok(fn[0].includes(required),
      `preseedBrandSwitch must call ${required}`);
  }
});

test('REGRESSION GUARD comment anchors the 2026-05-04 incident in renderer.js', () => {
  assert.match(rendererSrc, /stuck-chat-no-result-event/,
    'renderer.js must carry the stuck-chat-no-result-event REGRESSION GUARD anchor');
  assert.match(rendererSrc, /stuck-chat-brand-switch-no-reset/,
    'renderer.js must carry the stuck-chat-brand-switch-no-reset REGRESSION GUARD anchor');
});

test('REGRESSION GUARD comment anchors the 2026-05-04 incident in main.js', () => {
  assert.match(mainSrc, /stuck-chat-no-result-event/,
    'main.js must carry the stuck-chat-no-result-event REGRESSION GUARD anchor');
});
