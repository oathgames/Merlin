// renderer-ux.test.js: source-scan locks for the 2026-07-04 renderer UX
// hardening sweep. renderer.js is not requireable (it runs inside the
// Electron renderer against a live DOM), so each fix is pinned the same
// way the other renderer guards are: by scanning the source text for the
// shape that makes the fix true, and for the anti-pattern that made the
// bug possible.
//
// Fixes pinned here:
//   1. beginAgentTurn single-assignment rule (stuck-chat-unarmed-watchdog):
//      `sessionActive = true` exists exactly once, inside beginAgentTurn,
//      which also arms the stream watchdog. Any second assignment is the
//      "panel send path wedges the chat forever" bug class returning.
//   2. Auth-code dialog Escape listener is removed on EVERY dismiss path
//      (Cancel, Escape, CLI-exit), not just when Escape itself fires. A
//      leaked handler called merlin.cancelClaudeLogin() on every future
//      Escape press and could kill an unrelated in-flight sign-in.
//   3. Activity feed renders with an initial cap + idle-time chunks and a
//      debounced search box (mirrors the archive grid pattern).
//   4. Escape closes the QR modal and the revenue/stats overlay, matching
//      every other overlay's keyboard affordance.
//   5. #wisdom-info-btn has a click handler (privacy disclosure must be
//      reachable by touch/keyboard, not hover-only).
//   6. The refresh-thumbnail flow calls the real archive reloader
//      (loadArchive); the phantom populateArchivePanel reference is gone.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

// Strip full-line comments so doc blocks that MENTION the patterns under
// test (like the beginAgentTurn REGRESSION GUARD) don't count as hits.
const codeOnly = rendererSrc.replace(/^[ \t]*\/\/.*$/gm, '');

// ── Fix 1: beginAgentTurn single-assignment rule ───────────────────

test('sessionActive = true appears exactly once, inside beginAgentTurn', () => {
  const assignments = codeOnly.match(/sessionActive\s*=\s*true/g) || [];
  assert.strictEqual(assignments.length, 1,
    `Found ${assignments.length} \`sessionActive = true\` assignments in renderer.js; ` +
    'the ONLY authorized site is inside beginAgentTurn. A direct assignment ' +
    'sets the turn flag without arming the stream watchdog: if the SDK then ' +
    'emits zero events, sessionActive never clears and the chat wedges ' +
    'forever (stuck-chat-unarmed-watchdog, 2026-07-04). Route your call ' +
    'site through beginAgentTurn(reason) or beginAgentTurn(reason, { quiet: true }).');

  const helper = codeOnly.match(/function\s+beginAgentTurn\s*\([\s\S]{0,1500}?\n\}/);
  assert.ok(helper, 'beginAgentTurn helper must exist in renderer.js');
  assert.match(helper[0], /sessionActive\s*=\s*true/,
    'the single sessionActive = true assignment must live inside beginAgentTurn');
  assert.match(helper[0], /bumpStreamWatchdog\(\)/,
    'beginAgentTurn must arm the stream watchdog atomically with the flag');
  assert.match(helper[0], /startTickingTimer\(\)/,
    'beginAgentTurn must start the ticker for non-quiet turns');
  assert.match(helper[0], /showTypingIndicator\(\)/,
    'beginAgentTurn must show the typing indicator for non-quiet turns');
});

test('beginAgentTurn carries its REGRESSION GUARD anchor', () => {
  assert.match(rendererSrc, /REGRESSION GUARD \(2026-07-04, stuck-chat-unarmed-watchdog/,
    'the helper must keep its incident-anchored guard comment');
});

test('every send/restart surface routes through beginAgentTurn', () => {
  // Spot-check the call sites that were the original bug: each previously
  // set sessionActive by hand without arming the watchdog.
  for (const reason of [
    'brand-setup', 'panel-chat', 'custom-spell', 'spell-first-run',
    'palantir-generate', 'archive-pause-ad', 'archive-resume-ad',
    'archive-copy-all', 'archive-copy-platform', 'archive-merge',
    'send-message',
  ]) {
    assert.ok(rendererSrc.includes(`beginAgentTurn('${reason}')`),
      `beginAgentTurn('${reason}') call site must exist`);
  }
});

// ── Fix 2: auth-code dialog Escape listener hygiene ────────────────

test('auth-code dialog removes its Escape listener on every dismiss path', () => {
  assert.match(rendererSrc, /function\s+removeAuthCodeEscHandler\s*\(/,
    'module-scope removeAuthCodeEscHandler must exist');
  // Cancel path: dismissDialog removes the listener FIRST.
  assert.match(rendererSrc, /async function dismissDialog\(\)\s*\{\s*\n\s*removeAuthCodeEscHandler\(\);/,
    'dismissDialog must call removeAuthCodeEscHandler so the Cancel button does not leak the listener');
  // CLI-exit path: onAuthCodeDismiss removes the listener too.
  const dismissIdx = rendererSrc.indexOf('merlin.onAuthCodeDismiss(() => {');
  assert.ok(dismissIdx > 0, 'onAuthCodeDismiss handler must exist');
  assert.match(rendererSrc.slice(dismissIdx, dismissIdx + 400), /removeAuthCodeEscHandler\(\)/,
    'onAuthCodeDismiss must call removeAuthCodeEscHandler so a CLI exit does not leak the listener');
  // The handler is stored at module scope (removable from any path).
  assert.match(rendererSrc, /_authCodeEscHandler\s*=\s*\(e\)\s*=>/,
    'the Escape handler must be stored in _authCodeEscHandler');
  assert.match(rendererSrc, /document\.addEventListener\('keydown',\s*_authCodeEscHandler\)/,
    'the stored handler must be the one registered on document');
  // Anti-pattern: the old inline self-removing handler, which only
  // detached itself when Escape fired. Cancel/CLI-exit leaked it, and the
  // leaked handler killed unrelated future sign-ins on any Escape press.
  assert.doesNotMatch(rendererSrc, /addEventListener\(\s*'keydown',\s*function escHandler/,
    'the inline self-removing auth-code escHandler pattern must not return');
});

// ── Fix 3: activity feed render cap + chunking + debounced search ──

test('activity feed uses an initial render cap with idle-time chunking', () => {
  assert.match(rendererSrc, /INITIAL_VISIBLE_ACTIVITY_ROWS\s*=\s*300/,
    'activity initial chunk size must be a named constant (300)');
  assert.match(rendererSrc, /ACTIVITY_CHUNK_SIZE\s*=\s*200/,
    'activity idle-time chunk size must be a named constant (200)');
  // The tail must schedule via requestIdleCallback and consult the render
  // token so stale passes cancel themselves (search keystroke mid-build).
  assert.match(rendererSrc, /renderNextActivityChunk[\s\S]{0,400}?_activityRenderToken/,
    'activity idle-chunk callback must consult _activityRenderToken to drop stale passes');
});

test('activity search input is debounced (300ms), export stays on the full set', () => {
  const searchIdx = rendererSrc.indexOf("#activity-search').addEventListener('input'");
  assert.ok(searchIdx > 0, 'activity search input listener must exist');
  const region = rendererSrc.slice(searchIdx, searchIdx + 600);
  assert.match(region, /_activitySearchTimeout/,
    'activity search must clear/set a debounce timeout instead of re-rendering per keystroke');
  assert.match(region, /setTimeout\([\s\S]{0,400}?,\s*300\)/,
    'activity search debounce must be 300ms, matching the archive search box');
  // Export must read the full filtered data set, not the rendered subset.
  const exportIdx = rendererSrc.indexOf("#activity-export').addEventListener('click'");
  assert.ok(exportIdx > 0, 'activity export button listener must exist');
  assert.match(rendererSrc.slice(exportIdx, exportIdx + 300), /filterActivity\(_activityState\.items\)/,
    'export must serialize filterActivity(_activityState.items), never the DOM subset');
});

// ── Fix 4: Escape coverage for QR modal + revenue/stats overlay ────

test('Escape closes the QR modal', () => {
  assert.match(rendererSrc,
    /if \(e\.key !== 'Escape'\) return;\s*\n\s*const modal = document\.getElementById\('qr-modal'\);\s*\n\s*if \(!modal \|\| modal\.classList\.contains\('hidden'\)\) return;\s*\n\s*e\.preventDefault\(\);/,
    'a visibility-gated Escape handler must close #qr-modal like every other overlay');
});

test('Escape closes the revenue/stats overlay', () => {
  assert.match(rendererSrc,
    /if \(e\.key !== 'Escape'\) return;\s*\n\s*const overlay = document\.getElementById\('stats-overlay'\);\s*\n\s*if \(!overlay \|\| overlay\.classList\.contains\('hidden'\)\) return;\s*\n\s*e\.preventDefault\(\);/,
    'a visibility-gated Escape handler must close #stats-overlay like every other overlay');
});

// ── Fix 5: wisdom info button is clickable ─────────────────────────

test('#wisdom-info-btn has a click handler that opens the standard modal', () => {
  const idx = rendererSrc.indexOf("getElementById('wisdom-info-btn').addEventListener('click'");
  assert.ok(idx > 0,
    '#wisdom-info-btn must have a click handler: the privacy disclosure was hover-only, unreachable for touch/keyboard users');
  assert.match(rendererSrc.slice(idx, idx + 700), /showModal\(/,
    'the wisdom info click handler must surface the disclosure via showModal');
});

// ── Fix 6: refresh-thumbnail reloads via the real archive renderer ─

test('populateArchivePanel (phantom function) is gone from renderer.js', () => {
  assert.ok(!rendererSrc.includes('populateArchivePanel'),
    'populateArchivePanel does not exist; the typeof-guarded call was a silent no-op, so the refresh-thumbnail flow never reloaded the grid. Use loadArchive().');
});

test('refresh-thumbnail flow awaits loadArchive after refreshLiveAds', () => {
  assert.match(rendererSrc, /preview-refresh-btn[\s\S]{0,900}?await loadArchive\(\)/,
    'the preview refresh button must reload the grid via loadArchive() after merlin.refreshLiveAds settles');
});

// ── Fix 7: Activity/Gallery toggle preserves the styled span ───────

test('activity-btn label updates via setActivityBtnLabel, never bare textContent', () => {
  assert.match(rendererSrc, /function setActivityBtnLabel\(/,
    'setActivityBtnLabel helper must exist');
  assert.doesNotMatch(rendererSrc, /getElementById\('activity-btn'\)\.textContent\s*=/,
    'assigning activity-btn.textContent wipes the inner <span class="subscribe-cta"> and permanently kills its gradient styling after one toggle');
});

// ── Fix 8: live-ads staleness chip resolves its "refreshing" state ─

test('staleness chip updates after the auto-refresh settles', () => {
  assert.match(rendererSrc, /chip\.isConnected/,
    'the auto-refresh continuation must check the chip is still mounted before touching it');
  assert.match(rendererSrc, /couldn't refresh, showing saved data/,
    'a failed auto-refresh must tell the user the data shown is the saved copy');
  assert.match(rendererSrc, /Live ad data: refreshed just now/,
    'a successful auto-refresh must flip the chip to a fresh timestamp');
});

// ── Fix 10: approval-card key handler removed on resolution ────────

test('clearApproval removes the Enter/Escape key handler', () => {
  const idx = rendererSrc.indexOf('const clearApproval = () => {');
  assert.ok(idx > 0, 'clearApproval must exist');
  const region = rendererSrc.slice(idx, idx + 900);
  assert.match(region, /removeEventListener\('keydown',\s*keyHandler\)/,
    'clearApproval must removeEventListener the approval keyHandler so a resolved card stops intercepting Enter/Escape');
  assert.match(region, /_approvalKeyHandler/,
    'clearApproval must clear the window._approvalKeyHandler bookkeeping so the replace-on-next-request path stays consistent');
});
