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
  // Since the 2026-07-04 stuck-chat-unarmed-watchdog fix, the arming is
  // centralized in beginAgentTurn (sessionActive + ticker + watchdog in
  // one helper) and sendMessage routes through it. The contract is the
  // same: the stall detector is armed before the message leaves.
  const sendBlock = rendererSrc.match(/beginAgentTurn\([^)]*\);[^\n]*\n\s*merlin\.sendMessage\(text\)/);
  assert.ok(sendBlock, 'sendMessage must call beginAgentTurn immediately before merlin.sendMessage(text)');
  const helper = rendererSrc.match(/function\s+beginAgentTurn\s*\([\s\S]{0,1500}?\n\}/);
  assert.ok(helper, 'beginAgentTurn helper must exist');
  assert.match(helper[0], /sessionActive\s*=\s*true/,
    'beginAgentTurn must set sessionActive = true (single authorized assignment, see renderer-ux.test.js)');
  assert.match(helper[0], /startTickingTimer\(\)/,
    'beginAgentTurn must start the live ticker for non-quiet turns');
  assert.match(helper[0], /bumpStreamWatchdog\(\)/,
    'beginAgentTurn MUST call bumpStreamWatchdog so every turn start arms the stall detector');

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

// ── Tool-aware watchdog (2026-05-04 v2 false-positive incident) ────
//
// Live incident: v1 watchdog fired at flat 90s and force-recovered the UI
// mid-turn while a legitimate competitor scan / brand scrape was still
// running. Brand scrape ships with a 90s overall timeout (Hard-Won Rule
// 13) — exactly at the watchdog threshold. The fix: tool-aware rolling
// extensions. When at least one tool_use is in flight, the watchdog
// uses TOOL_STALL_MS (10 min) instead of TEXT_STALL_MS (90s). A hard
// ceiling at 15 min still catches forever-hung tools.

test('renderer.js declares the three-tier watchdog timeouts (TEXT/TOOL/HARD_MAX)', () => {
  assert.match(rendererSrc, /const\s+TEXT_STALL_MS\s*=/,
    'TEXT_STALL_MS must exist (90s no-tool stall)');
  assert.match(rendererSrc, /const\s+TOOL_STALL_MS\s*=\s*600000/,
    'TOOL_STALL_MS must equal 600000 (10 min — rolling extension while tool is in flight)');
  assert.match(rendererSrc, /const\s+HARD_MAX_STALL_MS\s*=\s*900000/,
    'HARD_MAX_STALL_MS must equal 900000 (15 min absolute ceiling)');
});

test('renderer.js exports noteToolUseStarted that increments _pendingToolCount', () => {
  // The tool-use content_block_start handler must call this so the
  // watchdog knows a tool is in flight. Source-scan only (the renderer
  // module has no public API; we lock the wiring contract via the
  // textual presence of the function definition + its single call site
  // inside the tool_use content_block_start branch).
  assert.match(rendererSrc, /function\s+noteToolUseStarted\s*\(/,
    'noteToolUseStarted helper must be defined');
  assert.match(rendererSrc, /_pendingToolCount\s*\+=\s*1/,
    'noteToolUseStarted must increment _pendingToolCount');
  // Wiring: must be called inside the content_block_start tool_use branch.
  // Anchor on the surrounding "type === 'tool_use'" check + the noteToolUseStarted
  // call within that block.
  const toolUseBranchIdx = rendererSrc.indexOf("event.content_block.type === 'tool_use'");
  assert.ok(toolUseBranchIdx > 0, "tool_use content_block_start branch must exist");
  const region = rendererSrc.slice(toolUseBranchIdx, toolUseBranchIdx + 1500);
  assert.match(region, /noteToolUseStarted\(\)/,
    'noteToolUseStarted() MUST be called inside the tool_use content_block_start branch (otherwise the watchdog uses the short timeout for legitimate long tools and false-positives)');
});

test('renderer.js watchdog uses tool-aware timeout selection', () => {
  // The fire path must check _pendingToolCount and either re-arm with
  // TOOL_STALL_MS (rolling extension) or fire recovery (when no tool
  // is in flight OR the hard ceiling is crossed).
  assert.match(rendererSrc, /_pendingToolCount\s*>\s*0/,
    'watchdog fire path must branch on _pendingToolCount > 0');
  assert.match(rendererSrc, /sinceTurnStart\s*<\s*HARD_MAX_STALL_MS/,
    'watchdog fire path must check sinceTurnStart < HARD_MAX_STALL_MS for the hard ceiling');
  // The bumpStreamWatchdog timeout selection must use the tool-aware
  // helper (returns TOOL_STALL_MS or TEXT_STALL_MS based on count).
  assert.match(rendererSrc, /function\s+_watchdogTimeoutMs\s*\(/,
    '_watchdogTimeoutMs helper must exist for tool-aware timeout selection');
});

test('renderer.js stopStreamWatchdog resets _pendingToolCount', () => {
  // Without the reset, a turn that starts a tool, ends, and then a new
  // turn starts would inherit the stale tool-in-flight count and use
  // the long timeout for the new turn's text-streaming phase. Defense
  // against per-turn state bleed.
  const startIdx = rendererSrc.indexOf('function stopStreamWatchdog(');
  assert.ok(startIdx > 0, 'stopStreamWatchdog must exist');
  const region = rendererSrc.slice(startIdx, startIdx + 500);
  assert.match(region, /_pendingToolCount\s*=\s*0/,
    'stopStreamWatchdog MUST reset _pendingToolCount = 0 so the next turn starts on the short text-stall timeout');
});

test('REGRESSION GUARD comment anchors the watchdog-false-positive-on-long-tool incident', () => {
  assert.match(rendererSrc, /watchdog-false-positive-on-long-tool/,
    'renderer.js must carry the watchdog-false-positive-on-long-tool REGRESSION GUARD anchor');
});
