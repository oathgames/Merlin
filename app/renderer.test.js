// Tests for RSI renderer.js tasks (Cluster-M, 11 tasks across 5 groups).
//
// Covers:
//   3.6  — brand_scrape progress pill (mcp-progress subscription)
//   3.11 — /update slash-command replaced with clickable chip sentinels
//   3.12 — Meta 1885183 dead-end banner + waitlist chip, once-per-session
//   3.14 — starter chips rephrased to user voice + goal-indexed presets
//   4.2/5.2 — incremental streaming render (stable prefix cache)
//   4.4  — factBindingEnabled top-level gate (no helper entry when off)
//   4.5  — MAX_VISIBLE_MESSAGES cap 120 + reactive eviction (no setInterval scan)
//   4.8  — optimistic preseed on known-brand rehydrate
//   4.9  — rAF-backed ticker with pause during streaming
//   5.3  — Set-backed _turnImageArtifacts dedup (no O(n²) indexOf)
//   5    — post-crash-reload toast subscription
//
// Most assertions are source-scan against renderer.js — the renderer can't
// be exercised end-to-end without an Electron BrowserWindow + preload. The
// scans are intentionally strict: they lock in wording + structure so a
// future edit that regresses a guard trips the test rather than silently
// shipping. This mirrors the ws-server source-scan pattern (Rule 11).
//
// Run with: node --test app/renderer.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = __dirname;
const RENDERER_JS = fs.readFileSync(path.join(APP_DIR, 'renderer.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────
// Group 1 — Onboarding flow (§3.14 + progress bar goal step)
// ─────────────────────────────────────────────────────────────────────

test('§3.14 — STARTER_CHIPS_BY_GOAL covers all five goal keys', () => {
  assert.ok(
    RENDERER_JS.includes('const STARTER_CHIPS_BY_GOAL'),
    'STARTER_CHIPS_BY_GOAL map is declared',
  );
  for (const goal of ['first-ad', 'blog-post', 'seo-audit', 'shopify-review', 'explore']) {
    assert.ok(
      RENDERER_JS.includes(`'${goal}'`),
      `goal preset "${goal}" is present in the map`,
    );
  }
});

test('§3.14 — starter chip copy is user-voice, not CMO-voice', () => {
  // Sampling: the first-ad preset opens with an imperative "Let's" in the
  // user's voice. The old stub was third-person ("Push your first ad").
  const idx = RENDERER_JS.indexOf("'first-ad'");
  assert.ok(idx >= 0, 'first-ad key present');
  const firstAdSlice = RENDERER_JS.slice(idx, idx + 600);
  assert.ok(
    /Let'?s set up my brand/i.test(firstAdSlice),
    'first-ad chip copy reads in first-person user voice',
  );
});

test('§3.14 — renderStarterChips accepts (hostBubble, mode, goal)', () => {
  assert.ok(
    /function renderStarterChips\(hostBubble,\s*mode,\s*goal\)/.test(RENDERER_JS),
    'signature accepts goal parameter',
  );
});

test('§3.14 — init() reads checkpoint and passes goal into renderStarterChips', () => {
  // The new-user branch must resolve the goal from the checkpoint store.
  assert.ok(
    /_readOnboardingCheckpointSafe\(\)[\s\S]{0,200}renderStarterChips\(welcomeBubble, 'new', checkpoint/.test(RENDERER_JS),
    'init() fetches checkpoint and hands the goal to the chip renderer',
  );
});

test('§3.14 — _readOnboardingCheckpointSafe gracefully handles missing bridge', () => {
  const fnStart = RENDERER_JS.indexOf('async function _readOnboardingCheckpointSafe');
  assert.ok(fnStart >= 0, '_readOnboardingCheckpointSafe defined');
  // End at the next function declaration (which follows immediately).
  const fnEnd = RENDERER_JS.indexOf('async function _writeOnboardingCheckpointSafe', fnStart);
  assert.ok(fnEnd > fnStart, 'next function declaration found as boundary');
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  assert.ok(body.includes("typeof window.merlin.readOnboardingCheckpoint === 'function'"),
    'checks function-exists on the bridge before calling');
  assert.ok(/return\s*\{\s*\}\s*;/.test(body), 'returns empty object as safe fallback');
});

test('§3.13 — three-screen onboarding flow (ToS → referral → goal) wired', () => {
  // The wiring must reference the Cluster-O overlay IDs verbatim — the
  // DOM contract between clusters is a string match.
  assert.ok(RENDERER_JS.includes('referral-capture-overlay'),
    'referral overlay ID wired');
  assert.ok(RENDERER_JS.includes('referral-capture-continue'),
    'referral continue button ID wired');
  assert.ok(RENDERER_JS.includes('referral-capture-skip'),
    'referral skip button ID wired');
  assert.ok(RENDERER_JS.includes('goal-overlay'),
    'goal overlay ID wired');
  assert.ok(RENDERER_JS.includes('goal-chip'),
    'goal chip class wired');
});

test('§3.13 — onboarding flow persists setup_step on each transition (Codex audit #7)', () => {
  // REGRESSION GUARD: a user who accepts ToS and exits before the
  // referral or goal screens must resume mid-flow on next launch.
  // Before this fix, checkToS() keyed solely on tosAccepted and
  // dropped the user straight into init() — silently skipping the
  // remaining two onboarding screens. The fix is two-part:
  //   (a) every transition writes the NEXT setup_step to the checkpoint
  //   (b) checkToS() reads that step on relaunch and routes to the
  //       matching overlay
  // Both halves MUST be present — without (a) the resume path has no
  // signal to route on; without (b) the writes are dead weight.

  // Part (a): three writes, one per transition. Each MUST be awaited
  // — Gitar review on PR #160 caught the original fire-and-forget
  // shape: comment promised "BEFORE showing the next overlay" but the
  // code raced the IPC against a 300ms fadeOut, so a force-quit during
  // the fade dropped the user back at the previous step. The matchers
  // below all anchor on `await ` so a future revert to the unawaited
  // form fails the source-scan.
  assert.ok(
    /await\s+_writeOnboardingCheckpointSafe\(\{\s*setup_step:\s*'referral'\s*\}\)/.test(RENDERER_JS),
    'ToS accept awaits setup_step: referral write',
  );
  // The two referral exits (continue + skip) both bump to 'goal'.
  const goalWrites = (RENDERER_JS.match(/await\s+_writeOnboardingCheckpointSafe\(\{\s*setup_step:\s*'goal'\s*\}\)/g) || []).length;
  assert.ok(goalWrites >= 2,
    `referral continue + skip must each AWAIT setup_step: goal (found ${goalWrites})`);
  // Goal completion writes 'done', folded into the same partial as the
  // user's chosen goal so a single awaited IPC carries both.
  assert.ok(
    /partial\s*=\s*\{\s*setup_step:\s*'done'\s*\}/.test(RENDERER_JS),
    'goal-finish writes setup_step: done',
  );
  assert.ok(
    /await\s+_writeOnboardingCheckpointSafe\(partial\)/.test(RENDERER_JS),
    'goal-finish awaits the partial write',
  );
  // No fire-and-forget shape allowed at any of the four transition sites.
  assert.ok(
    !/try\s*\{\s*_writeOnboardingCheckpointSafe\(/.test(RENDERER_JS),
    'no fire-and-forget try { _writeOnboardingCheckpointSafe(...) } pattern (Gitar PR #160 finding)',
  );

  // Part (b): the resume router. checkToS() must read setup_step and
  // route 'referral' / 'goal' to their respective overlays without
  // touching init() or the ToS overlay show.
  // The function is an IIFE: `(async function checkToS() { ... })();`
  const checkToSStart = RENDERER_JS.indexOf('(async function checkToS()');
  assert.ok(checkToSStart > 0, 'checkToS IIFE defined');
  // Bound the slice generously — the resume routing lives inside the
  // if(accepted) branch which sits AFTER the shared helper functions
  // (_fadeHideOverlay, _showOverlay, _wireOnboardingOverlayHandlers).
  // 12000 covers helpers + resume + start of cold-start with comfort.
  const checkToSBody = RENDERER_JS.slice(checkToSStart, checkToSStart + 12000);
  assert.ok(
    /step\s*===\s*'referral'\s*\|\|\s*step\s*===\s*'goal'/.test(checkToSBody),
    'resume branch tests setup_step against the two mid-flow values',
  );
  assert.ok(
    checkToSBody.includes("_showOverlay('referral-capture-overlay')") ||
      checkToSBody.includes("'referral-capture-overlay').classList.remove('hidden')"),
    'resume branch surfaces referral overlay on step==referral',
  );
  assert.ok(
    checkToSBody.includes("_showOverlay('goal-overlay')") ||
      checkToSBody.includes("'goal-overlay').classList.remove('hidden')"),
    'resume branch surfaces goal overlay on step==goal',
  );
});

test('§3.14 — progress bar has goal step between products and sales', () => {
  // Find the steps array in updateProgressBar.
  const barStart = RENDERER_JS.indexOf('async function updateProgressBar');
  assert.ok(barStart >= 0, 'updateProgressBar defined');
  const arrStart = RENDERER_JS.indexOf('const steps = [', barStart);
  assert.ok(arrStart >= 0, 'steps array present');
  const arrEnd = RENDERER_JS.indexOf('];', arrStart);
  const arr = RENDERER_JS.slice(arrStart, arrEnd);
  const productsIdx = arr.indexOf("'products'");
  const goalIdx = arr.indexOf("'goal'");
  const salesIdx = arr.indexOf("'sales'");
  assert.ok(productsIdx > 0 && goalIdx > productsIdx && salesIdx > goalIdx,
    'goal step sits between products and sales');
  assert.ok(arr.includes('!!(checkpoint && checkpoint.goal)'),
    'goal done-flag reads the checkpoint');

  // nextLabels must carry the goal entry.
  assert.ok(
    /goal:\s*'Next:\s*tell Merlin what to tee up first\./.test(RENDERER_JS),
    'nextLabels.goal advertises the right next step',
  );
});

// ─────────────────────────────────────────────────────────────────────
// Group 2 — brand_scrape progress pill (§3.6)
// ─────────────────────────────────────────────────────────────────────

test('§3.6 — onMcpProgress subscription exists and filters brand_scrape', () => {
  assert.ok(
    /window\.merlin\.onMcpProgress\(/.test(RENDERER_JS),
    'onMcpProgress listener registered',
  );
  assert.ok(
    /payload\.tool !== 'brand_scrape'/.test(RENDERER_JS),
    'handler filters by tool === brand_scrape',
  );
});

test('§3.6 — progress pill keyed by scrapeId; start/done/error stages handled', () => {
  // _mcpProgressPills Map keyed by scrapeId.
  assert.ok(RENDERER_JS.includes('_mcpProgressPills = new Map()'),
    'Map-backed pill registry');
  assert.ok(/stage === 'start'/.test(RENDERER_JS), 'start stage handled');
  assert.ok(/stage === 'done'/.test(RENDERER_JS), 'done stage handled');
  assert.ok(/stage === 'error'/.test(RENDERER_JS), 'error stage handled');
});

test('§3.6 — rAF-batched pill updates (no per-event innerHTML thrash)', () => {
  assert.ok(RENDERER_JS.includes('_scheduleMcpProgressFlush'),
    'rAF batcher present');
  const flushStart = RENDERER_JS.indexOf('function _scheduleMcpProgressFlush');
  assert.ok(flushStart > 0, '_scheduleMcpProgressFlush defined');
  const flushEnd = RENDERER_JS.indexOf('\n}\n', flushStart);
  const body = RENDERER_JS.slice(flushStart, flushEnd);
  assert.ok(/requestAnimationFrame/.test(body),
    'flush scheduled via requestAnimationFrame, not setTimeout');
});

test('§3.6 — error pill routes label through friendlyError', () => {
  const block = RENDERER_JS.slice(
    RENDERER_JS.indexOf("stage === 'error'"),
    RENDERER_JS.indexOf("stage === 'error'") + 1000,
  );
  assert.ok(block.includes('friendlyError('),
    'error stage classifies raw error via friendlyError');
});

// ─────────────────────────────────────────────────────────────────────
// Group 3 — Error chips (§3.11 /update, §3.12 Meta 1885183)
// ─────────────────────────────────────────────────────────────────────

test('§3.11 — friendlyError no longer emits raw "/update" slash strings', () => {
  // Grep for any "/update" inside the friendlyError body.
  const fnStart = RENDERER_JS.indexOf('function friendlyError(');
  assert.ok(fnStart > 0, 'friendlyError defined');
  // The function ends at the next matching top-level closing brace. A
  // cheap heuristic: take until the next "function humanizeUpdateError".
  const fnEnd = RENDERER_JS.indexOf('function humanizeUpdateError', fnStart);
  assert.ok(fnEnd > fnStart, 'end marker found');
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  // The word "/update" as a user-facing slash command MUST NOT appear —
  // it should have been replaced with a chip sentinel.
  assert.ok(
    !/Type\s+\/update/i.test(body),
    '"Type /update" prose has been replaced with chip sentinels',
  );
  // Positive assertion: the update chip sentinel is present.
  assert.ok(
    body.includes('[[chip:Update Merlin:update]]'),
    'update chip sentinel emitted',
  );
});

test('§3.11 — reconnect chip sentinels emitted per platform', () => {
  const reconnectChipCount = (RENDERER_JS.match(/\[\[chip:Reconnect [A-Za-z ]+:reconnect:/g) || []).length;
  assert.ok(reconnectChipCount >= 4,
    `at least 4 reconnect chip sentinels present (got ${reconnectChipCount})`);
});

test('§3.12 — Meta 1885183 emits deadend sentinel, not generic contact-support text', () => {
  const fnStart = RENDERER_JS.indexOf('function friendlyError(');
  const fnEnd = RENDERER_JS.indexOf('function humanizeUpdateError', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  // Old copy said "Contact support." — must be gone.
  assert.ok(
    !/Contact support\./.test(body),
    '"Contact support" placeholder replaced with deadend sentinel',
  );
  // Source uses a template literal `[[deadend:${DEAD_END_META_DEV_MODE}]]`.
  // Either the resolved code OR the template expression is acceptable.
  const hasResolvedCode = body.includes('[[deadend:meta_dev_mode_1885183]]');
  const hasTemplate = body.includes('[[deadend:${DEAD_END_META_DEV_MODE}]]');
  assert.ok(
    hasResolvedCode || hasTemplate,
    'deadend sentinel emitted for 1885183 (literal or template)',
  );
  // And the constant must exist and match the expected code.
  assert.ok(
    /const DEAD_END_META_DEV_MODE\s*=\s*'meta_dev_mode_1885183'/.test(RENDERER_JS),
    'DEAD_END_META_DEV_MODE constant holds the canonical code',
  );
});

test('§3.12 — dead-end banner is session-deduped', () => {
  assert.ok(RENDERER_JS.includes('_deadEndShownThisSession'),
    'session dedup set declared');
  // Ensure the dedup guard actually gates banner creation.
  assert.ok(
    /_deadEndShownThisSession\.has\(code\)/.test(RENDERER_JS),
    'banner renders only when code not already shown this session',
  );
  assert.ok(
    /_deadEndShownThisSession\.add\(code\)/.test(RENDERER_JS),
    'banner marks code as shown after first render',
  );
});

test('§3.11/§3.12 — renderErrorToBubble parses sentinels into DOM chips', () => {
  assert.ok(RENDERER_JS.includes('function renderErrorToBubble'),
    'renderErrorToBubble defined');
  // Waitlist + dismiss buttons both wired with chipAction datasets.
  assert.ok(RENDERER_JS.includes("data-chip-action") ||
            /dataset\.chipAction/.test(RENDERER_JS),
    'chip buttons carry action datasets');
});

test('§3.11 — chip dispatch handles update, reconnect:, open-url:, waitlist:', () => {
  const fnStart = RENDERER_JS.indexOf('function _dispatchErrorChipAction');
  assert.ok(fnStart > 0, '_dispatchErrorChipAction defined');
  const fnEnd = RENDERER_JS.indexOf('\n}\n', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  assert.ok(/action === 'update'/.test(body), 'update action dispatched');
  assert.ok(/action\.startsWith\('reconnect:'\)/.test(body),
    'reconnect: action dispatched');
  assert.ok(/action\.startsWith\('open-url:'\)/.test(body),
    'open-url: action dispatched');
  assert.ok(/action\.startsWith\('waitlist:'\)/.test(body),
    'waitlist: action dispatched');
});

// ─────────────────────────────────────────────────────────────────────
// Group 4 — Streaming/render perf (§4.2/5.2, 4.4, 4.5, 4.8, 4.9, 5.3)
// ─────────────────────────────────────────────────────────────────────

test('§4.2/5.2 — incremental streaming cache declared and reset on new bubble', () => {
  assert.ok(RENDERER_JS.includes('let _streamRenderState = null'),
    'stream render cache declared');
  // appendText reuses the cache on paragraph-boundary extensions.
  const appendStart = RENDERER_JS.indexOf('function appendText(text)');
  assert.ok(appendStart > 0, 'appendText defined');
  const appendEnd = RENDERER_JS.indexOf('\n}\n', appendStart);
  const body = RENDERER_JS.slice(appendStart, appendEnd);
  assert.ok(/cleaned\.lastIndexOf\('\\n\\n'\)/.test(body),
    'paragraph boundary used to split stable prefix from tail');
  assert.ok(/_streamRenderState\s*=\s*\{\s*prefixText/.test(body),
    'cache is seeded / extended with prefix text');
  // New bubble resets the cache.
  const claudeStart = RENDERER_JS.indexOf('function addClaudeBubble');
  const claudeEnd = RENDERER_JS.indexOf('\n}\n', claudeStart);
  const claudeBody = RENDERER_JS.slice(claudeStart, claudeEnd);
  assert.ok(/_streamRenderState\s*=\s*null/.test(claudeBody),
    'addClaudeBubble resets the stream cache');
});

test('§4.4 — factBindingEnabled gated top-level in appendText and finalizeBubble', () => {
  const appendStart = RENDERER_JS.indexOf('function appendText(text)');
  const appendEnd = RENDERER_JS.indexOf('\n}\n', appendStart);
  const appendBody = RENDERER_JS.slice(appendStart, appendEnd);
  // The helper calls must be wrapped in an explicit if(factBindingEnabled).
  assert.ok(
    /if\s*\(\s*factBindingEnabled\s*\)\s*\{[\s\S]*?_factApplyAndMount/.test(appendBody),
    'appendText gates _factApplyAndMount behind factBindingEnabled',
  );
  const finalStart = RENDERER_JS.indexOf('function finalizeBubble()');
  const finalEnd = RENDERER_JS.indexOf('\n}\n', finalStart);
  const finalBody = RENDERER_JS.slice(finalStart, finalEnd);
  assert.ok(
    /if\s*\(\s*factBindingEnabled\s*\)\s*\{[\s\S]*?_factApplyAndMount/.test(finalBody),
    'finalizeBubble gates _factApplyAndMount behind factBindingEnabled',
  );
});

test('§4.5 — MAX_VISIBLE_MESSAGES dropped from 200 to 120; no setInterval scanner', () => {
  assert.ok(
    /const MAX_VISIBLE_MESSAGES\s*=\s*120\s*;/.test(RENDERER_JS),
    'cap set to 120',
  );
  // setInterval(pruneOldMessages, ...) must be gone.
  assert.ok(
    !/setInterval\(pruneOldMessages/.test(RENDERER_JS),
    'no setInterval scanner wraps pruneOldMessages',
  );
  // Reactive eviction: addUserBubble / addClaudeBubble call pruneOldMessages.
  const userStart = RENDERER_JS.indexOf('function addUserBubble(text)');
  const userEnd = RENDERER_JS.indexOf('\n}\n', userStart);
  const userBody = RENDERER_JS.slice(userStart, userEnd);
  assert.ok(/pruneOldMessages\(\)/.test(userBody),
    'addUserBubble triggers eviction on insert');
  const claudeStart = RENDERER_JS.indexOf('function addClaudeBubble()');
  const claudeEnd = RENDERER_JS.indexOf('\n}\n', claudeStart);
  const claudeBody = RENDERER_JS.slice(claudeStart, claudeEnd);
  assert.ok(/pruneOldMessages\(\)/.test(claudeBody),
    'addClaudeBubble triggers eviction on insert');
});

test('§4.8 — preseedBrandSwitch drops a placeholder before the await', () => {
  assert.ok(RENDERER_JS.includes('function preseedBrandSwitch'),
    'preseedBrandSwitch defined');
  const fnStart = RENDERER_JS.indexOf('function preseedBrandSwitch');
  const fnEnd = RENDERER_JS.indexOf('\n}\n', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  assert.ok(body.includes('brand-preseed'),
    'placeholder tagged with brand-preseed class');
  assert.ok(/Switching to/.test(body),
    'placeholder tells the user the switch is in progress');
  // Preseed is invoked BEFORE merlin.switchBrand in the switch handler.
  const handlerIdx = RENDERER_JS.indexOf('const swapResult = await merlin.switchBrand');
  // (Also allow the let form.)
  const handlerIdxAlt = RENDERER_JS.indexOf('swapResult = await merlin.switchBrand');
  const markerIdx = handlerIdx > 0 ? handlerIdx : handlerIdxAlt;
  assert.ok(markerIdx > 0, 'switchBrand await found');
  const preseedCallIdx = RENDERER_JS.lastIndexOf('preseedBrandSwitch(', markerIdx);
  assert.ok(
    preseedCallIdx > 0 && preseedCallIdx < markerIdx,
    'preseedBrandSwitch runs before merlin.switchBrand await',
  );
});

test('§4.9 — ticker uses requestAnimationFrame, not setInterval', () => {
  const startIdx = RENDERER_JS.indexOf('function startTickingTimer()');
  assert.ok(startIdx > 0, 'startTickingTimer defined');
  const endIdx = RENDERER_JS.indexOf('function stopTickingTimer', startIdx);
  const body = RENDERER_JS.slice(startIdx, endIdx);
  assert.ok(/requestAnimationFrame\(_tickerLoop\)/.test(body),
    'ticker drives the loop via requestAnimationFrame');
  assert.ok(
    !/setInterval\(/.test(body),
    'no setInterval in startTickingTimer',
  );
  // Pause during streaming bursts — _tickerLoop checks isStreaming.
  const loopStart = RENDERER_JS.indexOf('function _tickerLoop()');
  const loopEnd = RENDERER_JS.indexOf('\n}\n', loopStart);
  const loopBody = RENDERER_JS.slice(loopStart, loopEnd);
  assert.ok(/!isStreaming/.test(loopBody),
    'ticker pauses paint during streaming');
});

test('§5.3 — _turnImageArtifacts is a Set-backed collection (no indexOf scans)', () => {
  assert.ok(
    RENDERER_JS.includes('const _turnImageArtifactsSet = new Set()'),
    'backing Set declared',
  );
  // No remaining indexOf / push on the wrapper.
  assert.ok(
    !/_turnImageArtifacts\.indexOf\(/.test(RENDERER_JS),
    'no .indexOf on _turnImageArtifacts',
  );
  assert.ok(
    !/_turnImageArtifacts\.push\(/.test(RENDERER_JS),
    'no .push on _turnImageArtifacts',
  );
  // The add() call from the tool_use extraction loop uses Set.add semantics.
  assert.ok(
    /for \(const p of paths\) _turnImageArtifacts\.add\(p\)/.test(RENDERER_JS),
    'tool_use extractor routes through .add() for O(1) dedup',
  );
});

// ─────────────────────────────────────────────────────────────────────
// Group 5 — post-crash-reload toast
// ─────────────────────────────────────────────────────────────────────

test('post-crash-reload — toast subscribes to onPostCrashReload bridge', () => {
  assert.ok(
    /typeof window\.merlin\.onPostCrashReload === 'function'/.test(RENDERER_JS),
    'subscription guarded on bridge presence (graceful degrade)',
  );
  assert.ok(
    /window\.merlin\.onPostCrashReload\(/.test(RENDERER_JS),
    'onPostCrashReload subscription present',
  );
  assert.ok(
    /Merlin recovered from a hiccup/.test(RENDERER_JS),
    'user-facing copy matches the product spec',
  );
  assert.ok(
    /your last turn is saved\./i.test(RENDERER_JS),
    'reassures the user their work is intact',
  );
});

// ─────────────────────────────────────────────────────────────────────
// Cross-cutting — REGRESSION GUARD comments are present per rule
// ─────────────────────────────────────────────────────────────────────

test('regression guards — every group has a dated comment block', () => {
  // Every major change above ships with a 2026-04-23 guard block so a
  // future edit that removes one of them lights up the corresponding
  // test and forces the editor to read the rationale.
  const guardMatches = RENDERER_JS.match(/REGRESSION GUARD \(2026-04-23/g) || [];
  assert.ok(
    guardMatches.length >= 8,
    `expected ≥8 dated regression guard blocks, found ${guardMatches.length}`,
  );
});
