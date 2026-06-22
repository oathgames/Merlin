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

test('Meta "still in review" / "pending approval" / "advanced access" surfaces dead-end (not raw error)', () => {
  // REGRESSION GUARD (2026-05-06, meta-app-review-error live incident):
  // Live user report — paying users tried to OAuth Meta and got
  // "the app is still in review" from Meta's auth dialog. The Merlin
  // Meta app (823058806852722) IS Live, but our OAuth URL passes
  // config_id=1258603313068894 which is a Facebook Login for Business
  // Login Configuration with its OWN approval state in Meta Business
  // Manager. A Live app + a not-yet-approved login-config = users see
  // "in review." Pre-fix only error subcode 1885183 ("Development
  // Mode") was caught; the three other phrasings ("still in review",
  // "pending approval", "advanced access required for X") fell through
  // to the generic "Authorization failed" line or surfaced raw Meta
  // JSON. None are user-fixable — they're operator-side Meta dashboard
  // actions — so they all route to the same dead-end banner that 1885183
  // uses.
  const fnStart = RENDERER_JS.indexOf('function friendlyError(');
  const fnEnd = RENDERER_JS.indexOf('function humanizeUpdateError', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);

  // Source-scan: the regex catching the "still in review" family must exist.
  assert.ok(
    /still in review|pending review|pending approval|under review|app is in review/.test(body),
    'friendlyError must catch the "still in review" / "pending approval" family of Meta errors'
  );
  assert.ok(
    body.includes('advanced access (required|needed)'),
    'friendlyError must catch "advanced access required/needed" — Meta\'s phrasing for scope-level Standard→Advanced gating'
  );
  // Same dead-end target as 1885183 — neither is user-fixable. Find
  // the IF clause (not the prose comment that introduces the branch
  // — both contain "still in review", so we skip past the first match
  // until we find the `.test(sl)` regex check).
  const ifIdx = body.search(/\/still in review\|pending review\|pending approval/);
  assert.ok(ifIdx > 0, 'in-review IF clause must exist with the documented regex');
  const tail = body.slice(ifIdx, ifIdx + 1500);
  assert.ok(
    tail.includes('[[deadend:${DEAD_END_META_DEV_MODE}]]') ||
    tail.includes('[[deadend:meta_dev_mode_1885183]]'),
    'the in-review branch must emit the same dead-end sentinel as 1885183 (both are Meta-side gates the user can\'t resolve)'
  );
});

test('§3.13 — friendlyError chip-renders mcp__merlin__google_analytics scope_missing sentinel', () => {
  // REGRESSION GUARD (2026-05-01, ga-scope-reauth): the Go binary's
  // errAnalyticsScopeMissing sentinel uses the exact prefix
  // "mcp__merlin__google_analytics: scope_missing:". Renderer's
  // friendlyError() must match this prefix and emit a Reconnect-Google
  // chip rather than fall through to the raw HTTP error. Without this
  // hookup, the Go-side sentinel would surface as opaque text and the
  // user would have no actionable signal — the whole point of the
  // sentinel is to render a one-click reconnect chip.
  const fnStart = RENDERER_JS.indexOf('function friendlyError(');
  const fnEnd = RENDERER_JS.indexOf('function humanizeUpdateError', fnStart);
  assert.ok(fnEnd > fnStart, 'friendlyError fn boundary located');
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  assert.ok(
    body.includes("'mcp__merlin__google_analytics: scope_missing:'") ||
    body.includes('"mcp__merlin__google_analytics: scope_missing:"'),
    'friendlyError contains the scope_missing sentinel string literal — the Go binary returns this exact prefix and the renderer must match it before any other branch can swallow it'
  );
  assert.ok(
    /\[\[chip:Reconnect Google:reconnect:google\]\]/.test(body),
    'scope_missing branch emits a [[chip:Reconnect Google:reconnect:google]] sentinel — same chip target as the Google Ads expired-token branch (single Google tile, four scopes)'
  );
  // Match must come before the generic token-expiration branch — otherwise
  // the word "scope" in our sentinel could falsely route via the existing
  // sl.includes('google') branch and lose the GA-specific copy.
  const sentinelIdx = body.search(/mcp__merlin__google_analytics:\s*scope_missing:/);
  const tokenExpiredIdx = body.search(/sl\.includes\('token'\)/);
  assert.ok(
    sentinelIdx > 0 && (tokenExpiredIdx < 0 || sentinelIdx < tokenExpiredIdx),
    'scope_missing sentinel match must appear BEFORE the generic "token expired" branch in friendlyError() so the specific message wins'
  );
});

// ─────────────────────────────────────────────────────────────────────
// REGRESSION GUARD (2026-05-09, friendly-error-platform-priority):
// The "token expired" routing branch in friendlyError MUST prioritize
// the explicit `platformName` arg over substring-matching the error
// string. Pre-fix, a Meta error string containing the substring "google"
// (e.g. mention of Google's auth servers, library traces, redirect-URL
// fragments) silently routed to the Google Ads "Reconnect Google Ads"
// chip — even though the call site KNEW the user clicked Connect Meta.
//
// Live anchor: 2026-05-09 — Connect Meta produced a "Your Google Ads
// token has expired. Reconnect Google Ads" modal because the underlying
// Meta error string contained "google" somewhere.
// ─────────────────────────────────────────────────────────────────────

test('§3.16 — friendlyError token-expired branch prioritizes platformName over error-substring', () => {
  // Source-scan: the platformName-priority block must exist BEFORE the
  // substring-matching fallback inside the token-expired branch.
  const fnStart = RENDERER_JS.indexOf('function friendlyError(');
  const fnEnd = RENDERER_JS.indexOf('function humanizeUpdateError', fnStart);
  assert.ok(fnEnd > fnStart, 'friendlyError fn boundary located');
  const body = RENDERER_JS.slice(fnStart, fnEnd);

  // Locate the token-expired branch.
  const branchIdx = body.search(/sl\.includes\('token'\)\s*&&\s*\(sl\.includes\('expir'/);
  assert.ok(branchIdx > 0, 'token-expired branch must exist in friendlyError');

  // Inside the branch, the platformName-priority block must come first.
  // Recognized by `const pn = (platformName || '').toLowerCase()` followed
  // by `if (pn)` gating per-platform routes.
  const branchSlice = body.slice(branchIdx, branchIdx + 4000);
  const pnConstIdx = branchSlice.search(/const pn\s*=\s*\(platformName\s*\|\|\s*['"]\s*['"]\s*\)\.toLowerCase\(\)/);
  assert.ok(pnConstIdx > 0,
    'token-expired branch must extract platformName into a `pn` local before substring matching');

  // The substring-fallback `sl.includes('meta')` etc. must come AFTER the
  // platformName routing. We can spot this by checking the FIRST occurrence
  // of `sl.includes('google')` inside the branch is AFTER the `if (pn)` body.
  const slGoogleIdx = branchSlice.search(/sl\.includes\(['"]google['"]\)/);
  assert.ok(slGoogleIdx > pnConstIdx,
    'sl.includes(\'google\') substring fallback must come AFTER the platformName-priority block');

  // The platformName branch for Meta must exist — covers the live-anchor
  // case where the error string contains "google" but the platform is Meta.
  assert.ok(
    /pn\s*===\s*['"]meta['"]\s*\|\|\s*pn\s*===\s*['"]facebook['"]\s*\|\|\s*pn\.includes\(['"]meta['"]\)/.test(branchSlice),
    'platformName-priority must explicitly route "meta" / "facebook" before any substring match'
  );

  // Defense-in-depth: assert that EVERY active platform has a platformName
  // route — meta, tiktok, google, shopify, etsy, amazon, reddit, linkedin,
  // stripe, slack. Drift here means a future provider added to the binary
  // but not added to friendlyError's platformName routing → that provider's
  // expired-token errors fall through to substring matching, re-introducing
  // the original cross-platform-misroute risk.
  const requiredPlatforms = ['meta', 'tiktok', 'google', 'shopify', 'etsy', 'amazon', 'reddit', 'linkedin', 'stripe', 'slack'];
  for (const p of requiredPlatforms) {
    const re = new RegExp(`pn\\.(?:includes|startsWith)\\(['"]${p}['"]\\)|pn\\s*===\\s*['"]${p}['"]`);
    assert.ok(re.test(branchSlice),
      `platformName-priority block must route "${p}" — drift = expired-token errors for ${p} fall through to substring matching, re-introducing the 2026-05-09 cross-platform misroute risk`);
  }
});

test('§3.16 — token-expired branch reconnect chip uses lowercased platformName for action key', () => {
  // The fallthrough `[[chip:Reconnect:reconnect:${platformName}]]` was
  // pre-fix passing platformName as-is — if a caller supplied "Meta"
  // (capitalized), the chip action `reconnect:Meta` would not match the
  // dispatcher's lowercase platform-key map, silently breaking the chip.
  // Defense: lowercase BEFORE interpolating into the action key.
  const fnStart = RENDERER_JS.indexOf('function friendlyError(');
  const fnEnd = RENDERER_JS.indexOf('function humanizeUpdateError', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  const branchIdx = body.search(/sl\.includes\('token'\)\s*&&\s*\(sl\.includes\('expir'/);
  const branchSlice = body.slice(branchIdx, branchIdx + 4000);
  // The fallthrough generic-platform line must lowercase the platformName.
  assert.ok(
    /\[\[chip:Reconnect:reconnect:\$\{\(platformName \|\| ['"]['"]\)\.toLowerCase\(\)\}\]\]/.test(branchSlice),
    'token-expired generic fallthrough chip must lowercase platformName before substituting into the action key — capitalized variants break the chip dispatcher'
  );
});

test('SDK ede_diagnostic / error_during_execution surfaces a friendly message, NEVER the raw diagnostic', () => {
  // REGRESSION GUARD (2026-05-05, sdk-ede-diagnostic):
  //
  // The Claude Agent SDK's `error_during_execution` result subtype ships
  // its diagnostic as `[ede_diagnostic] result_type=<X> last_content_type=<Y>
  // stop_reason=<Z>`. Pre-fix, this string surfaced verbatim in chat with
  // the generic 3-attempt retry banner below — three lines of SDK
  // internals to a paying user. Hard-Won Security Rule 6: every
  // user-visible error MUST pass through friendlyError. Match BEFORE
  // the generic JSON / 5xx branches.
  //
  // Source-scan: friendlyError() must contain a literal `ede_diagnostic`
  // or `error_during_execution` match-arm that returns a sentence-style
  // string (no `[`, no `=`, no `result_type`). The match MUST live
  // BEFORE the generic JSON branch (`s.includes('{"')`) because a
  // future SDK version could ship the diagnostic with embedded JSON.
  const fnStart = RENDERER_JS.indexOf('function friendlyError(');
  assert.ok(fnStart > 0, 'friendlyError defined');
  const fnEnd = RENDERER_JS.indexOf('function humanizeUpdateError', fnStart);
  assert.ok(fnEnd > fnStart, 'friendlyError fn boundary located');
  const body = RENDERER_JS.slice(fnStart, fnEnd);

  assert.ok(
    body.includes('ede_diagnostic') || body.includes('error_during_execution'),
    'friendlyError must contain an ede_diagnostic / error_during_execution match-arm so the SDK\'s raw diagnostic never surfaces to chat'
  );

  // Match must come BEFORE the generic JSON branch — otherwise `s.includes("{")`
  // (the JSON-detection branch) would never fire here, but the structural
  // ordering invariant is what we lock: SDK-internal error strings get
  // their own friendly copy, then we fall through to platform-specific
  // matches.
  const sdkMatchIdx = body.search(/ede_diagnostic|error_during_execution/);
  const jsonBranchIdx = body.search(/s\.includes\(['"]\{"['"]\)/);
  assert.ok(
    sdkMatchIdx > 0 && (jsonBranchIdx < 0 || sdkMatchIdx < jsonBranchIdx),
    'ede_diagnostic / error_during_execution match-arm MUST appear BEFORE the generic JSON / HTTP branch — otherwise an SDK diagnostic with embedded JSON would route via the generic path and surface "Something went wrong"'
  );

  // The friendly copy must be a complete sentence — no [, =, or
  // diagnostic-token leakage. Pull the string literal that's returned
  // for the ede_diagnostic branch and assert its shape.
  const branchMatch = body.match(/ede_diagnostic[\s\S]{0,800}?return\s+['"`]([^'"`]+)['"`]/);
  assert.ok(branchMatch, 'ede_diagnostic branch returns a quoted string literal');
  const userCopy = branchMatch[1];
  for (const banned of ['[', ']', '=', 'result_type', 'last_content_type', 'stop_reason', 'ede_diagnostic']) {
    assert.ok(
      !userCopy.includes(banned),
      `ede_diagnostic friendly copy must not contain "${banned}" — that's SDK internals leaking. Got: "${userCopy}"`
    );
  }
  // And it must contain a plain-English actionable next step.
  assert.match(userCopy, /try:?/i,
    'ede_diagnostic friendly copy must contain a "Try:" actionable hint so the user knows what happens next');
});

test('SDK terminal-state errors (max_turns / max_budget / max_structured_output_retries) all friendly', () => {
  // REGRESSION GUARD (2026-05-05, sdk-terminal-states):
  //
  // The SDK ships three other terminal-state error subtypes alongside
  // error_during_execution: error_max_turns, error_max_budget_usd,
  // error_max_structured_output_retries. Each has a distinct user-
  // facing fix (simplify the ask, raise the budget, rephrase). Each
  // gets its own friendly branch so the user sees the right next step
  // instead of a generic "Something went wrong."
  const fnStart = RENDERER_JS.indexOf('function friendlyError(');
  const fnEnd = RENDERER_JS.indexOf('function humanizeUpdateError', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);

  for (const sentinel of ['error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']) {
    assert.ok(body.includes(sentinel),
      `friendlyError must include a branch matching the SDK sentinel "${sentinel}" — without this the user sees "Something went wrong" instead of the actionable fix (simplify / raise budget / rephrase)`);
  }
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
// REGRESSION GUARD (2026-05-09, modal-chip-render-fix):
// showModal() body MUST run chip sentinels through buildErrorChipDom
// when the body string contains [[chip:LABEL:ACTION]] markers — pre-fix
// it set bodyEl.textContent = body which rendered the literal sentinel
// string verbatim in the modal. Live anchor: 2026-05-09 Discord OAuth
// failure on Mac surfaced "[[chip:Update Merlin:update]]" as raw text
// in the Connection Failed modal. Same friendly-error layer feeds the
// chat bubble and the modal — both surfaces must parse chips.
// ─────────────────────────────────────────────────────────────────────

test('§3.15 — buildErrorChipDom is defined as a single source of truth for chip parsing', () => {
  // The DOM-builder logic was previously inlined inside renderErrorToBubble,
  // which meant showModal had no path to chip rendering. This test pins the
  // factored-out helper so future edits don't re-inline.
  assert.ok(
    /function buildErrorChipDom\s*\(/.test(RENDERER_JS),
    'renderer.js must export buildErrorChipDom() as a top-level function',
  );
  // Helper must handle both branches: chip present + no chip.
  const fnStart = RENDERER_JS.indexOf('function buildErrorChipDom(');
  const fnEnd = RENDERER_JS.indexOf('\nfunction ', fnStart + 25);
  const body = fnEnd > 0 ? RENDERER_JS.slice(fnStart, fnEnd) : RENDERER_JS.slice(fnStart);
  // The chip sentinel appears in regex-literal form here (`\[\[chip:`),
  // so we search for the source-code escaped form rather than the raw
  // bracket pair (which doesn't exist in the source).
  assert.ok(/\\\[\\\[chip:/.test(body), 'helper must reference the chip sentinel regex pattern');
  assert.ok(/document\.createElement\(['"]button['"]/.test(body),
    'helper must build button elements for each chip');
  assert.ok(/_dispatchErrorChipAction/.test(body),
    'chip click handlers must wire through _dispatchErrorChipAction');
});

test('§3.15 — showModal pipes chip-bearing body through buildErrorChipDom', () => {
  // The fix path: when body is a string containing [[chip:..., bodyEl
  // gets a chip-parsed DOM tree instead of textContent.
  const fnStart = RENDERER_JS.indexOf('function showModal(');
  const fnEnd = RENDERER_JS.indexOf('\nfunction ', fnStart + 18);
  const body = fnEnd > 0 ? RENDERER_JS.slice(fnStart, fnEnd) : '';
  assert.ok(body, 'showModal function body must be locatable');
  assert.ok(
    /buildErrorChipDom\s*\(\s*body\s*\)/.test(body),
    'showModal must call buildErrorChipDom(body) on chip-bearing strings',
  );
  // The textContent fallback must come AFTER the chip check, so callers
  // who pass a chip-bearing string don't fall through to the literal
  // render path.
  const chipIdx = body.search(/buildErrorChipDom\s*\(\s*body\s*\)/);
  const textContentIdx = body.search(/bodyEl\.textContent\s*=\s*body\s*\|\|\s*''/);
  assert.ok(
    chipIdx > 0 && textContentIdx > chipIdx,
    'the buildErrorChipDom branch must be evaluated BEFORE bodyEl.textContent fallback',
  );
});

test('§3.15 — renderErrorToBubble delegates to buildErrorChipDom (no inline copy)', () => {
  // Prior to this fix, renderErrorToBubble had its own inline copy of
  // the chip-parsing DOM-builder. Pin the delegation so a future edit
  // can't fork the logic and re-introduce drift between the two
  // surfaces.
  const fnStart = RENDERER_JS.indexOf('function renderErrorToBubble(');
  const fnEnd = RENDERER_JS.indexOf('\nfunction ', fnStart + 28);
  const body = fnEnd > 0 ? RENDERER_JS.slice(fnStart, fnEnd) : '';
  assert.ok(body, 'renderErrorToBubble function body must be locatable');
  assert.ok(
    /buildErrorChipDom\s*\(\s*remaining\s*\)/.test(body),
    'renderErrorToBubble must delegate chip parsing to buildErrorChipDom',
  );
  // Also: the inline copy of the chip-build loop must NOT exist twice
  // in this function's body. Anti-assertion — count the loop signature.
  const inlineLoopMatches = body.match(/while\s*\(\s*\(\s*match\s*=\s*chipRe\.exec/g) || [];
  assert.equal(inlineLoopMatches.length, 0,
    'renderErrorToBubble must not contain its own chip-parsing loop — delegate to buildErrorChipDom');
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

// ─────────────────────────────────────────────────────────────────────
// Group 6 — v1.22.0 RSI UX fixes (2026-05-10)
// BUG-F002, F003, F004, F006, F007, F008, F010, H007, H008
// ─────────────────────────────────────────────────────────────────────

test('§F002 — loadConnections paints .loading on tiles before async fetch', () => {
  const fnStart = RENDERER_JS.indexOf('function loadConnections()');
  assert.ok(fnStart > 0, 'loadConnections defined');
  const fnEnd = RENDERER_JS.indexOf('\n}\n', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  assert.ok(
    /_preTiles\.forEach\(t\s*=>\s*t\.classList\.add\(['"]loading['"]\)\)/.test(body),
    'tiles get .loading class before IPC call',
  );
  assert.ok(
    /BUG-F002/.test(body),
    'F002 regression guard comment present',
  );
});

test('§F002 — .magic-tile.loading CSS rule injected with pointer-events suppressed', () => {
  assert.ok(
    /merlin-magic-tile-loading-style/.test(RENDERER_JS),
    'style element id wired',
  );
  assert.ok(
    /\.magic-tile\.loading\s*\{[^}]*opacity:\s*0\.5[^}]*pointer-events:\s*none[^}]*cursor:\s*wait/.test(RENDERER_JS),
    '.magic-tile.loading rule defines opacity, pointer-events:none, cursor:wait',
  );
});

test('§F002 — .loading class cleared after 10s safety timeout', () => {
  const fnStart = RENDERER_JS.indexOf('function loadConnections()');
  const fnEnd = RENDERER_JS.indexOf('\n}\n', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  assert.ok(
    /setTimeout\([\s\S]*?classList\.remove\(['"]loading['"]\)[\s\S]*?\},\s*10000\)/.test(body),
    'safety setTimeout removes .loading after 10s',
  );
});

test('§F003 — getConnectedPlatforms wrapped in Promise.race with 10s timeout', () => {
  const fnStart = RENDERER_JS.indexOf('function loadConnections()');
  const fnEnd = RENDERER_JS.indexOf('\n}\n', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  assert.ok(
    /Promise\.race\(\[fetchPromise,\s*timeoutPromise\]\)/.test(body),
    'Promise.race deadline wraps the IPC',
  );
  assert.ok(
    /connection-status-timeout/.test(body),
    'timeout error tag is "connection-status-timeout"',
  );
  assert.ok(
    /BUG-F003/.test(body),
    'F003 regression guard comment present',
  );
});

test('§F003 — timeout path surfaces a retry toast', () => {
  const fnStart = RENDERER_JS.indexOf('function loadConnections()');
  const fnEnd = RENDERER_JS.indexOf('\n}\n', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  assert.ok(
    /Connection check timed out/.test(body),
    'user-facing copy on timeout',
  );
});

test('§F004 — showSpellToast queues toasts FIFO instead of stacking', () => {
  assert.ok(
    /const _toastQueue\s*=\s*\[\]/.test(RENDERER_JS),
    '_toastQueue array declared',
  );
  assert.ok(
    /let _toastActive\s*=\s*false/.test(RENDERER_JS),
    '_toastActive single-active flag declared',
  );
  // showSpellToast just enqueues + calls _toastShowNext now — the old
  // direct-DOM-append shape is gone.
  const fnStart = RENDERER_JS.indexOf('function showSpellToast(title, detail, type)');
  assert.ok(fnStart > 0, 'showSpellToast defined');
  const fnEnd = RENDERER_JS.indexOf('\n}\n', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  assert.ok(
    /_toastQueue\.push\(\{\s*title,\s*detail,\s*type\s*\}\)/.test(body),
    'showSpellToast enqueues',
  );
  assert.ok(
    /_toastShowNext\(\)/.test(body),
    'showSpellToast triggers next-show',
  );
  assert.ok(
    /BUG-F004/.test(RENDERER_JS),
    'F004 regression guard comment present',
  );
});

test('§F004 — 3+ pending toasts coalesce into "(N) Notifications" summary', () => {
  const fnStart = RENDERER_JS.indexOf('function _toastShowNext');
  assert.ok(fnStart > 0, '_toastShowNext defined');
  const fnEnd = RENDERER_JS.indexOf('\n}\n', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  assert.ok(
    /_toastQueue\.length\s*>=\s*3/.test(body),
    'coalesce threshold at 3+',
  );
  assert.ok(
    /\(\$\{n\}\)\s*Notifications/.test(body),
    'summary copy uses "(N) Notifications" form',
  );
});

test('§F006 — loadPerfBar renders empty-state for unset brand instead of shimmer', () => {
  const fnStart = RENDERER_JS.indexOf('async function loadPerfBar(days, brandOverride)');
  assert.ok(fnStart > 0, 'loadPerfBar defined');
  const fnEnd = RENDERER_JS.indexOf('\n}\n', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  // The empty-brand early-out must come before the cache+fetch path.
  assert.ok(
    /if \(!brand\) \{[\s\S]*?No ad data for this brand[\s\S]*?run a campaign/.test(body),
    'empty-brand branch renders the F006 empty-state copy',
  );
  assert.ok(
    /BUG-F006/.test(body),
    'F006 regression guard comment present',
  );
});

test('§F006 — renderPerfBar treats empty metrics map as no-data', () => {
  const fnStart = RENDERER_JS.indexOf('function renderPerfBar(perf)');
  assert.ok(fnStart > 0, 'renderPerfBar defined');
  const fnEnd = RENDERER_JS.indexOf('\nfunction renderPerfBarSkeleton', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  assert.ok(
    /Object\.keys\(perf\.metrics\)\.length\s*===\s*0/.test(body),
    'empty metrics object check present',
  );
  assert.ok(
    /renderPerfBarEmpty\(text\)/.test(body),
    'empty path delegates to renderPerfBarEmpty',
  );
});

test('§F007 — MutationObserver on archive-panel triggers loadArchive on hidden→visible', () => {
  assert.ok(
    /ensureArchiveAutoRefreshOnVisible/.test(RENDERER_JS),
    'auto-refresh IIFE name present',
  );
  const idx = RENDERER_JS.indexOf('ensureArchiveAutoRefreshOnVisible');
  const slice = RENDERER_JS.slice(idx, idx + 1500);
  assert.ok(
    /new MutationObserver/.test(slice),
    'observer constructed',
  );
  assert.ok(
    /attributeFilter:\s*\[['"]class['"]\]/.test(slice),
    'observes class attribute changes',
  );
  assert.ok(
    /loadArchive\(\)/.test(slice),
    'fires loadArchive() on hidden→visible',
  );
  assert.ok(
    /BUG-F007/.test(RENDERER_JS),
    'F007 regression guard comment present',
  );
});

test('§F008 — pending-restart dismiss is hidden via class + display + disabled + aria', () => {
  const idx = RENDERER_JS.indexOf('merlin.onUpdatePendingRestart');
  assert.ok(idx > 0, 'onUpdatePendingRestart handler present');
  const slice = RENDERER_JS.slice(idx, idx + 2500);
  assert.ok(
    /dismissEl\.style\.display\s*=\s*['"]none['"]/.test(slice),
    'inline display:none applied',
  );
  assert.ok(
    /dismissEl\.disabled\s*=\s*true/.test(slice),
    'dismiss button disabled',
  );
  assert.ok(
    /dismissEl\.setAttribute\(['"]aria-disabled['"],\s*['"]true['"]\)/.test(slice),
    'aria-disabled set',
  );
  assert.ok(
    /dismissEl\.onclick\s*=\s*null/.test(slice),
    'prior onclick handler severed',
  );
  assert.ok(
    /BUG-F008/.test(slice),
    'F008 regression guard comment present',
  );
});

test('§F010 — empty-brand state shows "Set up your first brand" instead of "No brand"', () => {
  const fnStart = RENDERER_JS.indexOf('async function loadBrands()');
  assert.ok(fnStart > 0, 'loadBrands defined');
  const fnEnd = RENDERER_JS.indexOf('\nfunction updateVertical', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  assert.ok(
    /Set up your first brand/.test(body),
    'fresh-user copy present',
  );
  // The new empty-state option uses value=__add__ so the existing
  // change-event router triggers startBrandSetupConversation.
  assert.ok(
    /setupOpt\.value\s*=\s*['"]__add__['"]/.test(body),
    'setup option routes through __add__ for the existing change handler',
  );
  assert.ok(
    /BUG-F010/.test(body),
    'F010 regression guard comment present',
  );
});

test('§F010 — when brands exist but savedBrand is unmatched, first option auto-selected', () => {
  const fnStart = RENDERER_JS.indexOf('async function loadBrands()');
  const fnEnd = RENDERER_JS.indexOf('\nfunction updateVertical', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  assert.ok(
    /let matched\s*=\s*false/.test(body),
    'matched flag tracked',
  );
  assert.ok(
    /if \(!matched\)\s*\{[\s\S]*?firstOpt\.selected\s*=\s*true/.test(body),
    'first option auto-selected when no match',
  );
});

test('§H007 — facts watcher polls at 500ms (down from 120ms)', () => {
  assert.ok(
    /pollMs:\s*500/.test(RENDERER_JS),
    'pollMs is 500',
  );
  assert.ok(
    !/pollMs:\s*120/.test(RENDERER_JS),
    'old pollMs:120 is gone',
  );
  assert.ok(
    /BUG-H007/.test(RENDERER_JS),
    'H007 regression guard comment present',
  );
});

test('§H008 — _factStreamConsume buffers deltas and debounces the bridge tailPush', () => {
  const fnStart = RENDERER_JS.indexOf('function _factStreamConsume(delta)');
  assert.ok(fnStart > 0, '_factStreamConsume defined');
  const fnEnd = RENDERER_JS.indexOf('\n}\n', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  // tailPush must NOT be called inside _factStreamConsume — only the
  // debounced flusher should call it.
  assert.ok(
    !/_factBridge\.tailPush/.test(body),
    'consume path no longer calls tailPush directly',
  );
  assert.ok(
    /_factPushPending\s*\+=\s*delta/.test(body),
    'consume path appends to the debounce buffer',
  );
  assert.ok(
    /setTimeout\(_factStreamFlushPending,\s*FACT_PUSH_DEBOUNCE_MS\)/.test(body),
    'debounce timer scheduled at FACT_PUSH_DEBOUNCE_MS',
  );
  assert.ok(
    /const FACT_PUSH_DEBOUNCE_MS\s*=\s*100/.test(RENDERER_JS),
    'debounce is 100ms',
  );
  assert.ok(
    /BUG-H008/.test(RENDERER_JS),
    'H008 regression guard comment present',
  );
});

test('§H008 — _factStreamFinalize flushes pending buffer before tailFinalize', () => {
  const fnStart = RENDERER_JS.indexOf('function _factStreamFinalize()');
  assert.ok(fnStart > 0, '_factStreamFinalize defined');
  const fnEnd = RENDERER_JS.indexOf('\n}\n', fnStart);
  const body = RENDERER_JS.slice(fnStart, fnEnd);
  // The flush must happen BEFORE tailFinalize so any buffered deltas
  // make it into the quarantine.
  const flushIdx = body.search(/_factStreamFlushPending\(\)/);
  const finalizeIdx = body.search(/_factBridge\.tailFinalize/);
  assert.ok(flushIdx > 0, 'flush call present');
  assert.ok(finalizeIdx > 0, 'tailFinalize call present');
  assert.ok(flushIdx < finalizeIdx, 'flush comes before tailFinalize');
});

// REGRESSION GUARD (2026-05-11, archive-scroll-jumps-on-alt-tab):
// Live user report: alt-tab away from Merlin with the archive sidebar
// open → return → scroll snaps to top. Root cause: alt-tab pauses fs
// watch events; on focus regain the OS delivers queued events; the
// results-watcher fires `archive-changed`; renderer's
// onArchiveChanged handler calls loadArchive() which clears the grid
// via innerHTML = '' and rebuilds, destroying scroll position.
//
// Fix: loadArchive(opts.resetScroll) — defaults to false (preserve).
// Auto-reload paths (archive-changed watcher, live-ads-changed,
// hidden→visible MutationObserver, bulk-flag completion) inherit the
// default. User-initiated content-change paths (filter button click,
// search input, refresh button) pass { resetScroll: true } so the
// rebuild's natural innerHTML wipe sends the panel to the top — the
// correct UX when the content set itself has changed.
//
// These tests source-scan the file because the live behavior depends
// on Chromium scrollTop + MutationObserver, which jsdom doesn't
// model faithfully. The contracts we lock here are:
//   (a) loadArchive accepts opts.resetScroll
//   (b) the preserve path wires up the MutationObserver under the
//       savedScrollTop>0 && !resetScroll gate
//   (c) filter / search / refresh-button callers pass resetScroll:true
//   (d) auto-reload callers (the two `onArchiveChanged`-style
//       handlers) do NOT pass resetScroll (preserve is the default)

test('REGRESSION GUARD 2026-05-11: loadArchive signature accepts opts.resetScroll', () => {
  assert.ok(/async function loadArchive\(opts = \{\}\)/.test(RENDERER_JS),
    'loadArchive must take an opts object — pre-fix it was zero-arg, " +' +
    '"so callers had no way to express preserve-vs-reset intent');
  assert.ok(/const resetScroll = opts\.resetScroll === true/.test(RENDERER_JS),
    'resetScroll must be a strict-true read of opts.resetScroll — ' +
    'truthy coercion (just `opts.resetScroll`) would treat undefined as ' +
    'false but might leak intent across falsy-but-not-explicit cases');
});

test('REGRESSION GUARD 2026-05-11: preserve-scroll path is gated on !resetScroll && (savedScrollTop > 0 || userWasNearBottom)', () => {
  // The observer-wiring guard must short-circuit when the caller asked
  // for a reset (filter click, search change, refresh button). Without
  // !resetScroll in the predicate, a filter click would still restore
  // the OLD filter's scroll position into the NEW filter's content —
  // a worse UX than the original alt-tab bug.
  //
  // 2026-05-12 update: the OR-arm `userWasNearBottom` was added so
  // the follow-new-content convention fires even when savedScrollTop
  // happens to be 0 (the user is at the top AND the bottom of a tiny
  // archive). Both arms must be present.
  const guardPattern = /if \(!resetScroll && \(savedScrollTop > 0 \|\| userWasNearBottom\) && scrollContainer/;
  assert.ok(guardPattern.test(RENDERER_JS),
    'preserve-scroll observer wiring must be gated on ' +
    '`!resetScroll && (savedScrollTop > 0 || userWasNearBottom) && scrollContainer && ...`');
});

test('REGRESSION GUARD 2026-05-11: filter-button + search + refresh-button callers pass resetScroll:true', () => {
  // Filter buttons section
  const filterRegion = RENDERER_JS.slice(
    RENDERER_JS.indexOf('// Archive filter buttons'),
    RENDERER_JS.indexOf('// Archive search')
  );
  assert.ok(/loadArchive\(\{ resetScroll: true \}\)/.test(filterRegion),
    'filter-button click handler must call loadArchive({ resetScroll: true })');

  // Search section
  const searchStart = RENDERER_JS.indexOf('// Archive search (debounced)');
  const searchEnd = RENDERER_JS.indexOf('async function loadArchive', searchStart);
  const searchRegion = RENDERER_JS.slice(searchStart, searchEnd);
  assert.ok(/loadArchive\(\{ resetScroll: true \}\)/.test(searchRegion),
    'search-input handler must call loadArchive({ resetScroll: true }) inside its debounce');

  // Refresh-button section — search for the explicit comment we added.
  assert.ok(/User explicitly clicked the refresh button[\s\S]{0,400}loadArchive\(\{ resetScroll: true \}\)/.test(RENDERER_JS),
    'refresh-button click handler must call loadArchive({ resetScroll: true }) with the rationale comment');
});

test('REGRESSION GUARD 2026-05-11: auto-reload callers (archive-changed, live-ads-changed, hidden→visible) do NOT pass resetScroll', () => {
  // The whole point of this fix is that these three reload paths
  // INHERIT the preserve-scroll default. Adding { resetScroll: true }
  // to any of them would silently re-introduce the alt-tab bug.
  //
  // We pin them by their surrounding identifiers + a window of ~400
  // chars and assert each window contains a bare `loadArchive()` (or
  // `loadArchive();`) call but NOT a `loadArchive({ resetScroll`
  // call.

  // (a) onArchiveChanged handler near the bottom of the file
  const archiveChangedIdx = RENDERER_JS.indexOf('merlin.onArchiveChanged(()');
  assert.ok(archiveChangedIdx > 0, 'onArchiveChanged handler must exist');
  const archiveChangedRegion = RENDERER_JS.slice(archiveChangedIdx, archiveChangedIdx + 2000);
  assert.ok(/loadArchive\(\);/.test(archiveChangedRegion),
    'onArchiveChanged handler must call bare loadArchive() — preserve is the default');
  assert.ok(!/loadArchive\(\{ resetScroll: true/.test(archiveChangedRegion),
    'onArchiveChanged handler MUST NOT pass resetScroll:true — that ' +
    'would re-introduce the original alt-tab regression');

  // (b) onLiveAdsChanged handler in the refresh-button block
  const liveAdsIdx = RENDERER_JS.indexOf('merlin.onLiveAdsChanged(()');
  assert.ok(liveAdsIdx > 0, 'onLiveAdsChanged handler must exist');
  const liveAdsRegion = RENDERER_JS.slice(liveAdsIdx, liveAdsIdx + 600);
  assert.ok(/loadArchive\(\);/.test(liveAdsRegion),
    'onLiveAdsChanged handler must call bare loadArchive() — preserve is the default');
  assert.ok(!/loadArchive\(\{ resetScroll: true/.test(liveAdsRegion),
    'onLiveAdsChanged handler MUST NOT pass resetScroll:true');

  // (c) ensureArchiveAutoRefreshOnVisible MutationObserver (BUG-F007)
  const f007Idx = RENDERER_JS.indexOf('ensureArchiveAutoRefreshOnVisible');
  assert.ok(f007Idx > 0, 'ensureArchiveAutoRefreshOnVisible function must exist (BUG-F007 fix)');
  const f007Region = RENDERER_JS.slice(f007Idx, f007Idx + 800);
  assert.ok(/loadArchive\(\);/.test(f007Region),
    'hidden→visible MutationObserver must call bare loadArchive() — preserve is the default');
  assert.ok(!/loadArchive\(\{ resetScroll: true/.test(f007Region),
    'hidden→visible MutationObserver MUST NOT pass resetScroll:true');
});

// REGRESSION GUARD (2026-05-11, mailchimp-integration + slack/discord move):
// Two coupled UI changes ship in this batch:
//   (a) Slack + Discord tiles move from #universal-tiles to #brand-tiles
//       so they're visually grouped with the other per-brand integrations
//       — each brand's scheduled tasks post to the configured channel
//       for that brand.
//   (b) Mailchimp tile added in #brand-tiles with data-scope="brand".
//       API-key auth via API_KEY_PLATFORMS (same flow as Klaviyo,
//       Postscript, etc.) — no OAuth.
//
// These tests source-scan app/index.html to lock the tile placement +
// app/renderer.js to lock the API_KEY_PLATFORMS entry. They don't
// instantiate the DOM (jsdom doesn't model panels/click handlers
// faithfully) — the contracts are placement + registration only.

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('REGRESSION GUARD 2026-05-11: Slack tile lives in #brand-tiles, not #universal-tiles', () => {
  const universal = sliceBetween(INDEX_HTML, '<div id="universal-tiles"', '</div>');
  const brand = sliceBetween(INDEX_HTML, '<div id="brand-tiles"', '</div>');

  assert.ok(!/data-platform="slack"/.test(universal),
    'Slack tile MUST NOT be inside #universal-tiles (was moved to #brand-tiles in v1.22.x)');
  assert.ok(/data-platform="slack"/.test(brand),
    'Slack tile MUST be inside #brand-tiles');
});

test('REGRESSION GUARD 2026-05-11: Discord tile lives in #brand-tiles, not #universal-tiles', () => {
  const universal = sliceBetween(INDEX_HTML, '<div id="universal-tiles"', '</div>');
  const brand = sliceBetween(INDEX_HTML, '<div id="brand-tiles"', '</div>');

  assert.ok(!/data-platform="discord"/.test(universal),
    'Discord tile MUST NOT be inside #universal-tiles (was moved to #brand-tiles in v1.22.x)');
  assert.ok(/data-platform="discord"/.test(brand),
    'Discord tile MUST be inside #brand-tiles');
});

test('REGRESSION GUARD 2026-05-11: Mailchimp tile exists in #brand-tiles with data-scope="brand"', () => {
  const brand = sliceBetween(INDEX_HTML, '<div id="brand-tiles"', '</div>');
  assert.ok(/data-platform="mailchimp"/.test(brand),
    'Mailchimp tile MUST be inside #brand-tiles');
  // The tile must declare data-scope="brand" so the connection grid
  // shows the "needs-brand" gray state when no brand is selected.
  const tileMatch = brand.match(/<button[^>]*data-platform="mailchimp"[^>]*>/);
  assert.ok(tileMatch, 'Mailchimp tile <button> tag must parse');
  assert.match(tileMatch[0], /data-scope="brand"/,
    'Mailchimp tile MUST declare data-scope="brand" — credentials are per-brand');
});

test('REGRESSION GUARD 2026-05-11: API_KEY_PLATFORMS registers mailchimp with the right config field', () => {
  // The renderer's API-key modal save flow calls saveConfigField with
  // API_KEY_PLATFORMS[platform].key. If the key string here doesn't
  // match the Go binary's struct tag (`mailchimpApiKey`), every save
  // hits "Unknown config field" silently.
  const match = RENDERER_JS.match(/mailchimp:\s*\{\s*key:\s*'mailchimpApiKey'/);
  assert.ok(match,
    'API_KEY_PLATFORMS.mailchimp MUST be registered with key: \'mailchimpApiKey\' — same name as the Go binary struct tag (Config.MailchimpAPIKey json:"mailchimpApiKey")');
  // And the placeholder MUST hint at the dc suffix so the user doesn't
  // paste a bare key (which would fail parseMailchimpKey on the binary
  // side with "must end with -<datacenter>").
  const placeholderMatch = RENDERER_JS.match(/mailchimp:\s*\{[^}]*placeholder:\s*'([^']+)'/);
  assert.ok(placeholderMatch, 'mailchimp entry must declare a placeholder');
  assert.match(placeholderMatch[1], /us\d|-\w+/,
    'Mailchimp placeholder MUST hint at the `-<datacenter>` suffix (e.g. "32-hex-chars-us6") so users include it');
});

test('REGRESSION GUARD 2026-05-12: Mailchimp API-key URL is the universal login.mailchimp.com entry, not a hardcoded datacenter', () => {
  // The pre-fix URL was https://us1.admin.mailchimp.com/account/api/
  // which only works for the us1 datacenter (~10% of users); everyone
  // else lands on a forced-redirect / sign-in loop. login.mailchimp.com
  // auto-detects the user's datacenter post-auth and routes to the
  // right /account/api/ page. Lock the universal URL in.
  const urlMatch = RENDERER_JS.match(/mailchimp:\s*\{[^}]*url:\s*'([^']+)'/);
  assert.ok(urlMatch, 'mailchimp entry must declare a url');
  assert.ok(!/^https:\/\/us\d+\.admin\.mailchimp\.com/.test(urlMatch[1]),
    'Mailchimp URL MUST NOT hardcode a datacenter prefix (us1, us6, eu1, etc.) — landing-page-redirect only works for users on that exact datacenter');
  assert.ok(/^https:\/\/login\.mailchimp\.com/.test(urlMatch[1]),
    'Mailchimp URL MUST use login.mailchimp.com — it auto-routes to the user\'s actual datacenter post-auth');
});

// sliceBetween extracts the substring of `src` covering the <div>
// element whose opening tag matches the `start` prefix, including
// the matching closing </div> tag. Used to scope the tile-placement
// assertions to a specific tiles container (#universal-tiles,
// #brand-tiles). The function is <div>-aware — a naive
// indexOf('</div>') would close at the first nested <div>'s closer
// rather than the container's, mis-scoping every assertion.
//
// `start` must match the opening tag prefix verbatim (e.g.
// '<div id="brand-tiles"'). The depth counter handles arbitrary
// nesting of <div> children.
function sliceBetween(src, start) {
  const sIdx = src.indexOf(start);
  if (sIdx < 0) return '';
  let i = sIdx;
  let depth = 0;
  while (i < src.length) {
    const open = src.indexOf('<div', i);
    const close = src.indexOf('</div>', i);
    if (close < 0) return src.slice(sIdx);
    if (open >= 0 && open < close) {
      depth++;
      i = open + 4;
    } else {
      depth--;
      if (depth === 0) return src.slice(sIdx, close + 6);
      i = close + 6;
    }
  }
  return src.slice(sIdx);
}

test('REGRESSION GUARD 2026-05-12: loadArchive follows-new-content when user was near bottom', () => {
  // Post-audit UX: when an external file appears while the user is
  // scrolled to the bottom of the archive, the rebuild should auto-
  // scroll to the NEW bottom rather than restoring the old scrollTop
  // (which would hide the new content). Matches the Slack/iMessage/
  // Messenger convention.
  //
  // Source-scan the implementation for the three load-bearing pieces:
  //   1. userWasNearBottom captured BEFORE the innerHTML wipe
  //   2. The 100px threshold constant
  //   3. The restore-clamp branch picks `max` instead of
  //      `Math.min(savedScrollTop, max)` when userWasNearBottom is true.
  assert.ok(/FOLLOW_NEW_CONTENT_THRESHOLD_PX\s*=\s*100/.test(RENDERER_JS),
    'follow-new-content threshold (100px) must be a named constant');
  assert.ok(/let\s+userWasNearBottom\s*=\s*false/.test(RENDERER_JS),
    'userWasNearBottom flag must default to false');
  assert.ok(/userWasNearBottom\s*=\s*oldMax\s*>\s*0\s*&&\s*\(oldMax\s*-\s*savedScrollTop\)\s*<=\s*FOLLOW_NEW_CONTENT_THRESHOLD_PX/.test(RENDERER_JS),
    'userWasNearBottom must be computed BEFORE the innerHTML wipe using oldMax');
  // The restore branch must choose `max` (snap-to-bottom) when
  // userWasNearBottom, else `Math.min(savedScrollTop, max)` (preserve).
  assert.ok(/scrollContainer\.scrollTop\s*=\s*userWasNearBottom\s*\?\s*max\s*:\s*Math\.min\(savedScrollTop,\s*max\)/.test(RENDERER_JS),
    'restore branch must snap to new max when userWasNearBottom, else clamp to savedScrollTop');
});

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION GUARD (2026-05-13, copy-button-tooltip-fix)
//
// The data-copy click handler used to silently no-op when
// navigator.clipboard.writeText rejected (Electron unfocused-window, strict
// origin policy, etc.) — paying users clicked the ⧉ icon next to inline
// `<code>` and got nothing: no visible "Copied!" feedback because the
// pre-fix shape only flipped a 12px button glyph for 1.5s. The fix has
// three load-bearing pieces (renderer toast, preload bridge, main IPC
// handler) and these tests pin each so a future refactor can't silently
// regress the feedback contract.
// ─────────────────────────────────────────────────────────────────────────────

test('REGRESSION GUARD 2026-05-13: copy-btn click handler shows toast on success', () => {
  // The handler MUST call showCopyToast('Copied!') on success, not just
  // flip the button text in place. The pre-fix shape ONLY did the in-place
  // flip — users reported clicking and seeing nothing happen.
  assert.ok(/showCopyToast\(['"]Copied!['"]\)/.test(RENDERER_JS),
    'copy-btn success path must call showCopyToast("Copied!")');
});

test('REGRESSION GUARD 2026-05-13: copy-btn click handler shows toast on failure', () => {
  // The failure path MUST also surface user feedback — silent failure is
  // exactly the bug that triggered this fix.
  assert.ok(/showCopyToast\(['"]Copy failed['"]\)/.test(RENDERER_JS),
    'copy-btn failure path must call showCopyToast("Copy failed")');
});

test('REGRESSION GUARD 2026-05-13: copy-btn falls back to Electron clipboard when browser API rejects', () => {
  // When navigator.clipboard.writeText rejects (common in Electron under
  // strict permission policies), the handler must try merlin.copyText
  // before declaring failure. Without this, the click is a silent no-op on
  // every system that rejected the browser API once.
  assert.ok(/merlin\.copyText/.test(RENDERER_JS),
    'copy-btn must call merlin.copyText as Electron fallback');
  // The fallback must be invoked from a catch handler, not the happy path.
  assert.ok(/\.catch\(tryElectronFallback\)|\.catch\([^)]*merlin\.copyText/.test(RENDERER_JS),
    'merlin.copyText must run from the .catch handler, not the success path');
});

test('REGRESSION GUARD 2026-05-13: copy-btn handler defends against corrupt data-copy attribute', () => {
  // decodeURIComponent can throw on a malformed %XX sequence. The pre-fix
  // shape would crash the handler silently (no toast, no feedback). The
  // fix catches and tells the user.
  assert.ok(/try\s*{[\s\S]*?decodeURIComponent\(btn\.dataset\.copy\)[\s\S]*?}\s*catch/.test(RENDERER_JS),
    'decodeURIComponent must be inside a try/catch — malformed data-copy must not silently crash the handler');
});

test('REGRESSION GUARD 2026-05-13: preload exposes merlin.copyText IPC bridge', () => {
  // The Electron fallback path needs the bridge. Without it, the
  // renderer-side fallback would throw on undefined access and the toast
  // would say "Copy failed" 100% of the time on systems where the browser
  // API misbehaves — defeating the whole point of the fix.
  const preloadJs = fs.readFileSync(path.join(APP_DIR, 'preload.js'), 'utf8');
  assert.ok(/copyText:\s*\(text\)\s*=>\s*ipcRenderer\.invoke\(['"]copy-text['"]/.test(preloadJs),
    'preload.js must expose merlin.copyText → ipcRenderer.invoke("copy-text", …)');
  // The bridge must validate the input via assertStr with the same 1 MB
  // cap as the main-side handler so a typo'd payload can't serialize the
  // entire activity feed into the clipboard.
  assert.ok(/copyText:.*assertStr\(text,\s*1024\s*\*\s*1024\)/.test(preloadJs),
    'preload.js copyText must cap the payload at 1 MB via assertStr');
});

test('REGRESSION GUARD 2026-05-13: main.js registers copy-text IPC handler', () => {
  const mainJs = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
  assert.ok(/ipcMain\.handle\(['"]copy-text['"]/.test(mainJs),
    'main.js must register the copy-text IPC handler');
  // The handler must use Electron's clipboard.writeText.
  const handlerMatch = mainJs.match(/ipcMain\.handle\(['"]copy-text['"][\s\S]+?clipboard\.writeText\(text\)/);
  assert.ok(handlerMatch,
    'copy-text handler must call clipboard.writeText(text) from electron.clipboard');
  // And it must cap the payload to defend against runaway payloads.
  assert.ok(/text\.length\s*>\s*1024\s*\*\s*1024/.test(mainJs),
    'copy-text handler must reject payloads larger than 1 MB');
});

// ─────────────────────────────────────────────────────────────────────────────
// RSI-archive-perf iter 1 — performance regression guards
// Goal: bound first-paint, eliminate sync JSON.parse on large files,
// keep archive watcher signal informative, and verify the archive
// in-memory walk cache is wired through the watcher.
// ─────────────────────────────────────────────────────────────────────────────

test("RSI 1-1: archive-scanner exports invalidateScanCache for watcher hookup", () => {
  const scannerJs = fs.readFileSync(path.join(APP_DIR, "archive-scanner.js"), "utf8");
  assert.ok(/function invalidateScanCache\(\)/.test(scannerJs),
    "archive-scanner.js must expose invalidateScanCache() so the watcher can flush the in-memory walk cache");
  assert.ok(/module\.exports\s*=\s*{[^}]*invalidateScanCache/.test(scannerJs),
    "invalidateScanCache must be exported");
  // The FAST PATH must return BEFORE any fs walk happens.
  assert.ok(/if\s*\(_walkCache && _walkCache\.appRoot === appRoot && Array\.isArray\(_walkCache\.items\)\)\s*{\s*return applyFilters/.test(scannerJs),
    "scanArchive must return cached items BEFORE the walk on a cache hit");
});

test("RSI 1-1: main.js wires invalidateScanCache into the results watcher", () => {
  const mainJs = fs.readFileSync(path.join(APP_DIR, "main.js"), "utf8");
  // The watcher onChange MUST invalidate the scan cache so the next IPC
  // call re-walks. Without this, the in-memory cache serves stale data
  // every time results/ changes.
  assert.ok(/onChange:[\s\S]*invalidateScanCache\(\)/.test(mainJs),
    "results-watcher onChange must call invalidateScanCache() so cached walks expire on file change");
});

test("RSI 1-3: archive-changed event carries a path payload (incremental update support)", () => {
  const mainJs = fs.readFileSync(path.join(APP_DIR, "main.js"), "utf8");
  // The watcher broadcast must ship { paths, truncated } so the renderer
  // can decide between incremental and full reload. Bare broadcast is
  // kept as a fallback.
  assert.ok(/win\.webContents\.send\(.archive-changed., \{\s*paths:[^}]*,\s*truncated:/.test(mainJs),
    "archive-changed broadcast must include paths + truncated payload");
  // Payload size cap so a 10k-file burst does not balloon the IPC clone.
  assert.ok(/paths\.slice\(0,\s*200\)/.test(mainJs),
    "path-set payload must be capped at 200 entries");
});

test("RSI 1-3: preload passes archive-changed payload through to the callback", () => {
  const preloadJs = fs.readFileSync(path.join(APP_DIR, "preload.js"), "utf8");
  // The handler must forward the payload — a callback that ignores the
  // arg is back-compat for older sites but new callers can opt in.
  assert.ok(/ipcRenderer\.on\(.archive-changed., h\)/.test(preloadJs),
    "preload must subscribe to archive-changed");
  assert.ok(/cb\(payload && typeof payload === .object. \? payload : null\)/.test(preloadJs),
    "preload must forward the payload object (or null) to the callback");
});

test("RSI 1-2: get-live-ads handler is async and reads per-brand in parallel", () => {
  const mainJs = fs.readFileSync(path.join(APP_DIR, "main.js"), "utf8");
  // Async handler signature is the perf-critical change — sync handler
  // blocked the main event loop on 10-brand workspaces (120-230 ms).
  assert.ok(/ipcMain\.handle\(.get-live-ads., async \(_, brandName\)/.test(mainJs),
    "get-live-ads must be an async ipcMain.handle");
  // Per-brand fetches must run via Promise.all (parallel I/O).
  assert.ok(/Promise\.all\(brands\.map\(b => _readBrandAdsCached\(brandsDir, b\)\)\)/.test(mainJs),
    "all-brands path must fan out via Promise.all over _readBrandAdsCached");
  // Cache must invalidate on mtime+size change.
  assert.ok(/hit && hit\.mtimeMs === st\.mtimeMs && hit\.size === st\.size/.test(mainJs),
    "per-brand cache must check mtimeMs + size before returning a hit");
  // LRU cap so a pathological workspace cannot grow the cache forever.
  assert.ok(/LIVE_ADS_CACHE_MAX\s*=\s*64/.test(mainJs),
    "live-ads cache must be capped at 64 brand entries");
});

test("RSI 1-5: get-activity-feed-full accepts a limit param and defaults to a paginated tail", () => {
  const mainJs = fs.readFileSync(path.join(APP_DIR, "main.js"), "utf8");
  // Handler signature must accept a third arg (limit).
  assert.ok(/ipcMain\.handle\(.get-activity-feed-full., \(_, brandName, limit\)/.test(mainJs),
    "get-activity-feed-full must accept a limit arg");
  // Default cap exists and is bounded.
  assert.ok(/ACTIVITY_FEED_DEFAULT_LIMIT\s*=\s*2000/.test(mainJs),
    "default limit must be 2000 entries (drop from full 10 MB sync parse)");
  assert.ok(/ACTIVITY_FEED_MAX_LIMIT\s*=\s*50000/.test(mainJs),
    "max limit must be 50000 entries (export-path ceiling)");
});

test("RSI 1-5: preload accepts an optional limit for getActivityFeedFull", () => {
  const preloadJs = fs.readFileSync(path.join(APP_DIR, "preload.js"), "utf8");
  // The bridge must take (brand, limit) and forward an integer 1..50000 (or omit).
  assert.ok(/getActivityFeedFull:\s*\(brand,\s*limit\)\s*=>/.test(preloadJs),
    "preload getActivityFeedFull must take a (brand, limit) signature");
  assert.ok(/Number\.isInteger\(limit\)\s*&&\s*limit\s*>\s*0\s*&&\s*limit\s*<=\s*50000/.test(preloadJs),
    "preload must clamp limit to [1, 50000] before invoking the IPC");
});

test("RSI 1-4: archive render chunks via DocumentFragment + requestIdleCallback", () => {
  // Initial chunk renders synchronously into a fragment; the tail runs
  // in idle-time chunks of ARCHIVE_CHUNK_SIZE. This converts the
  // 5000-card synchronous appendChild loop (200-500 ms initial paint)
  // into a 300-card first chunk (~30 ms) with the rest filling during
  // idle frames.
  assert.ok(/INITIAL_VISIBLE_ARCHIVE_CARDS\s*=\s*300/.test(RENDERER_JS),
    "initial chunk size must be a named constant (300)");
  assert.ok(/ARCHIVE_CHUNK_SIZE\s*=\s*200/.test(RENDERER_JS),
    "idle-time chunk size must be a named constant (200)");
  assert.ok(/createDocumentFragment\(\)/.test(RENDERER_JS),
    "archive build path must use DocumentFragment for one-shot appendChild");
  assert.ok(/requestIdleCallback\(/.test(RENDERER_JS),
    "tail chunks must schedule via requestIdleCallback (or setTimeout fallback)");
  // The stale-load guard must apply to idle callbacks too — otherwise a
  // brand switch mid-render would dump cards into the new grid.
  assert.ok(/renderNextChunk[\s\S]{0,200}isStale\(\)/.test(RENDERER_JS),
    "idle-time chunk callback must consult isStale() to short-circuit on stale loads");
  // The complete (unfiltered) list must still feed the viewer.
  assert.ok(/_archiveVisibleItems = items\.slice\(\)/.test(RENDERER_JS),
    "_archiveVisibleItems must still hold the COMPLETE filtered list (viewer prev/next depends on this)");
});


// ─────────────────────────────────────────────────────────────────────────────
// RSI-archive-perf iter 2-3 — renderer perf polish
// Verifies the approval countdown, wisdom max-precompute, and
// connection-status query-reuse changes.
// ─────────────────────────────────────────────────────────────────────────────

// REGRESSION GUARD (2026-05-15, story-thumb-broken-archive): three-layer
// invariant covering the story-format thumbnail fix. Pre-fix, an archive
// card whose only image was a 9:16 _story file got rendered with
// .archive-card-thumb (object-fit:cover) inside a 1:1 card — the image
// was center-banded to its middle ~56%, hiding the headline + persona
// layers above and below the product. Users saw thumbnails identical
// to a generic product hero shot, breaking visual differentiation in
// the archive grid.

test('story-thumb-broken-archive: createArchiveCard reads item.tallThumb and applies the class', () => {
  // Must NOT shadow into a unconditional class assignment — the conditional
  // is the entire fix. Match the assignment line + the tallThumb ternary.
  assert.ok(
    /const\s+thumbClass\s*=\s*item\.tallThumb\s*\?\s*'archive-card-thumb archive-card-thumb-tall'\s*:\s*'archive-card-thumb'/.test(RENDERER_JS),
    'createArchiveCard must assign thumbClass with archive-card-thumb-tall when item.tallThumb is truthy');
  // The class must reach the template literal — the .innerHTML must use
  // ${thumbClass}, not a hardcoded 'archive-card-thumb' string.
  assert.ok(
    /innerHTML\s*=\s*`<img class="\$\{thumbClass\}"/.test(RENDERER_JS),
    'createArchiveCard innerHTML must interpolate the resolved thumbClass, not a hardcoded class');
});

test('story-thumb-broken-archive: archive-scanner exposes tallThumb on the run item shape', () => {
  const scannerJs = fs.readFileSync(path.join(APP_DIR, 'archive-scanner.js'), 'utf8');
  // The TALL_FORMAT_RE constant must exist (the source-of-truth pattern).
  assert.ok(/TALL_FORMAT_RE\s*=\s*\/_\(story\|vertical\|9x16\|reel\|reels\)\\\./.test(scannerJs),
    'archive-scanner must declare TALL_FORMAT_RE covering story/vertical/9x16/reel/reels');
  // The picker must prefer _square over tall.
  assert.ok(/const\s+square\s*=\s*run\.files\.find/.test(scannerJs),
    'thumbnail picker must check for _square first');
  // The fall-through must consult tallImage only AFTER non-tall.
  assert.ok(/const\s+nonTallImage[\s\S]*const\s+tallImage/.test(scannerJs),
    'picker must consider nonTallImage before tallImage');
  // The item shape must set tallThumb when the picked file matches TALL_FORMAT_RE.
  assert.ok(/if\s*\(TALL_FORMAT_RE\.test\(thumbFile\.name\)\)\s*{\s*item\.tallThumb\s*=\s*true/.test(scannerJs),
    'scanner must set item.tallThumb = true when the picked thumb matches TALL_FORMAT_RE');
});

test('story-thumb-broken-archive: style.css archive-card-thumb-tall uses object-fit: contain', () => {
  const styleCss = fs.readFileSync(path.join(APP_DIR, 'style.css'), 'utf8');
  // The class must exist with object-fit:contain — without it, the
  // renderer's class hand-off is a no-op and tall images still get
  // center-banded.
  assert.ok(
    /\.archive-card-thumb-tall\s*{\s*[^}]*object-fit:\s*contain/.test(styleCss),
    '.archive-card-thumb-tall must apply object-fit: contain to letterbox tall images');
});

test('RSI 2-3: approval countdown uses two-phase setTimeout, not setInterval(1000)', () => {
  // Pre-fix: setInterval(1000) fired 900× per modal even though the UI
  // only updated text during the final 60s. Post-fix: a Phase 1 setTimeout
  // sleeps until the warning window, then a Phase 2 recursive setTimeout
  // chain ticks once per second only while the warning is on-screen.
  assert.ok(/APPROVAL_WARN_SECONDS\s*=\s*60/.test(RENDERER_JS),
    'warning window must be a named constant (60s)');
  assert.ok(/APPROVAL_TOTAL_SECONDS\s*=\s*900/.test(RENDERER_JS),
    'total countdown must be a named constant (900s = 15 min)');
  assert.ok(/_approvalCountdown\s*=\s*setTimeout\(\(\)\s*=>\s*{[\s\S]*?secondsLeft\s*=\s*APPROVAL_WARN_SECONDS/.test(RENDERER_JS),
    'Phase 1 must be a single setTimeout that sleeps until the warning window');
  assert.ok(/tickWarnPhase\s*=\s*\(\)\s*=>/.test(RENDERER_JS),
    'Phase 2 must be a named tick function');
  assert.ok(/_approvalCountdown\s*=\s*setTimeout\(tickWarnPhase,\s*1000\)/.test(RENDERER_JS),
    'tick must schedule itself via setTimeout, not setInterval');
  // The cleanup path must use clearTimeout (matches the new handle type).
  assert.ok(/clearTimeout\(_approvalCountdown\)/.test(RENDERER_JS),
    'cleanup must call clearTimeout on the setTimeout handle');
});

test('RSI 3-2: wisdom cards precompute max value once per array', () => {
  // Pre-fix: each of the 5 wisdom cards inlined Math.max(...arr.map(...))
  // — 5× O(n) map iterations + spread-arity arg unpacking on every wisdom
  // render. Post-fix: a single maxVal() helper computes each array's max
  // in one pass and the result is referenced from the template.
  assert.ok(/const maxVal\s*=\s*\(items\)\s*=>/.test(RENDERER_JS),
    'maxVal helper must exist as a single-pass O(n) loop');
  // Each precomputed max lands in a named const.
  assert.ok(/const hookMax\s*=\s*maxVal\(/.test(RENDERER_JS), 'hookMax must be precomputed via maxVal()');
  assert.ok(/const platMax\s*=\s*maxVal\(/.test(RENDERER_JS), 'platMax must be precomputed via maxVal()');
  assert.ok(/const fmtMax\s*=\s*maxVal\(/.test(RENDERER_JS),  'fmtMax must be precomputed via maxVal()');
  assert.ok(/const imgMax\s*=\s*maxVal\(/.test(RENDERER_JS),  'imgMax must be precomputed via maxVal()');
  assert.ok(/const vidMax\s*=\s*maxVal\(/.test(RENDERER_JS),  'vidMax must be precomputed via maxVal()');
  // The template MUST use the precomputed names, not the Math.max spread.
  assert.ok(/rankRows\(hookItems, i => i\.val, 'color-hooks', hookMax\)/.test(RENDERER_JS),
    'rankRows for hooks must use precomputed hookMax');
  assert.ok(/rankRows\(vidItems, i => i\.val, 'color-vid', vidMax\)/.test(RENDERER_JS),
    'rankRows for video models must use precomputed vidMax');
});

test('RSI 3-3: connection-status reuses one tile NodeList across all branches', () => {
  // Pre-fix: three querySelectorAll calls for the same selector (pre-paint,
  // safety timer, resolved branch) — 3× DOM scan per brand change. Post-fix:
  // the pre-paint NodeList is captured once and reused.
  // The safety-timer setTimeout must use the cached _preTiles, not re-query.
  assert.ok(/_loadingClearTimer\s*=\s*setTimeout\(\(\)\s*=>\s*{[\s\S]{0,200}_preTiles\.forEach\(t => t\.classList\.remove\('loading'\)\)/.test(RENDERER_JS),
    'safety timer must reuse _preTiles instead of re-running the selector');
  // The resolved branch must reuse _preTiles as allTiles.
  assert.ok(/const allTiles\s*=\s*_preTiles;/.test(RENDERER_JS),
    'resolved branch must alias _preTiles to allTiles instead of re-querying');
});

// ─────────────────────────────────────────────────────────────────────
// Palantir — competitor ad-feed tab
// ─────────────────────────────────────────────────────────────────────

// INDEX_HTML is already read once near the top of this file — reuse it.
const MAIN_JS = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
const PRELOAD_JS = fs.readFileSync(path.join(APP_DIR, 'preload.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(APP_DIR, 'style.css'), 'utf8');

test('Palantir — index.html has the tab button, panel, and detail lightbox', () => {
  assert.ok(INDEX_HTML.includes('id="palantir-btn"'), 'tab button exists');
  assert.ok(INDEX_HTML.includes('id="palantir-panel"'), 'panel exists');
  assert.ok(INDEX_HTML.includes('id="palantir-grid"'), 'feed grid exists');
  assert.ok(INDEX_HTML.includes('id="palantir-sentinel"'), 'infinite-scroll sentinel exists');
  assert.ok(INDEX_HTML.includes('id="palantir-search"'), 'competitor search input exists');
  assert.ok(INDEX_HTML.includes('id="palantir-detail"'), 'ad-detail lightbox exists');
});

// ── PAL-4 (2026-06-20): winning-ideas wall + full takeover + button move ──
test('Palantir — tooltip reads exactly "Palantir" (not "competitor ads")', () => {
  const m = INDEX_HTML.match(/id="palantir-btn"[^>]*data-tip="([^"]*)"/);
  assert.ok(m, 'palantir-btn has a data-tip');
  assert.equal(m[1], 'Palantir', 'tooltip is exactly "Palantir"');
});

test('Palantir — button sits 1 slot to the right of Reports', () => {
  const reports = INDEX_HTML.indexOf('id="agency-report-btn"');
  const palantir = INDEX_HTML.indexOf('id="palantir-btn"');
  const wisdom = INDEX_HTML.indexOf('id="wisdom-header-btn"');
  assert.ok(reports > 0 && palantir > 0 && wisdom > 0, 'all three toolbar buttons exist');
  assert.ok(reports < palantir, 'Palantir comes after Reports');
  assert.ok(palantir < wisdom, 'Palantir comes immediately before Wisdom (i.e. one slot right of Reports)');
});

test('Palantir — full takeover with an auto idea wall + connect-CTA + secondary spy', () => {
  assert.ok(INDEX_HTML.includes('id="palantir-ideas-grid"'), 'winning-ideas grid exists');
  assert.ok(INDEX_HTML.includes('id="palantir-connect-cta"'), 'connect-CTA container exists');
  assert.ok(INDEX_HTML.includes('id="palantir-niche"'), 'niche label exists');
  assert.ok(INDEX_HTML.includes('id="palantir-refresh"'), 'refresh control exists');
  // The competitor spy is now the SECONDARY path (collapsed <details>).
  assert.ok(/<details id="palantir-spy"/.test(INDEX_HTML), 'competitor spy is a secondary <details> section');
  // Full-frame: panel covers the window (left:0;right:0) like a takeover, not a 420px side panel.
  assert.ok(/\.palantir-panel\s*\{[^}]*left:\s*0/.test(STYLE_CSS), 'panel is full-frame (left:0)');
});

test('Palantir — opening the panel auto-loads the ideas wall (zero typing)', () => {
  const idx = RENDERER_JS.indexOf("getElementById('palantir-btn').addEventListener");
  assert.ok(idx > 0, 'palantir-btn handler exists');
  const handler = RENDERER_JS.slice(idx, idx + 900);
  assert.ok(handler.includes('loadPalantirIdeas'), 'opening the panel auto-loads the ideas wall');
  assert.ok(RENDERER_JS.includes('async function loadPalantirIdeas'), 'loadPalantirIdeas defined');
  assert.ok(RENDERER_JS.includes('merlin.palantirIdeas'), 'calls the palantirIdeas bridge');
});

test('Palantir — idea card has a one-click on-brand generate bridge', () => {
  assert.ok(RENDERER_JS.includes('function palantirRenderIdea'), 'idea-card renderer exists');
  assert.ok(RENDERER_JS.includes('function palantirGenerateFromIdea'), 'generate bridge exists');
  const idx = RENDERER_JS.indexOf('function palantirGenerateFromIdea');
  const fn = RENDERER_JS.slice(idx, idx + 600);
  assert.ok(fn.includes('generateSeed'), 'generate bridge uses the idea generateSeed');
  assert.ok(fn.includes('merlin.sendMessage'), 'generate bridge sends the on-brand instruction to chat');
});

test('Palantir — connect-CTA (not a dead wall) when no ad-intel platform is connected', () => {
  assert.ok(RENDERER_JS.includes('needConnect'), 'handles the needConnect state');
  assert.ok(RENDERER_JS.includes("palantirPortalHTML('connect'"), 'renders a connect portal CTA');
  assert.ok(RENDERER_JS.includes('palantir-connect-btn'), 'connect CTA has a button');
});

test('Palantir — preload exposes the palantirIdeas bridge', () => {
  assert.ok(PRELOAD_JS.includes('palantirIdeas') && PRELOAD_JS.includes("ipcRenderer.invoke('palantir-ideas'"),
    'preload exposes merlin.palantirIdeas → palantir-ideas IPC');
});

// ── TARGET 2 (2026-06-20): brand switcher button + full-window tile takeover ──
test('Brand switcher — dropdown replaced by a button; select kept hidden as value-source', () => {
  assert.ok(INDEX_HTML.includes('id="brand-switcher-btn"'), 'brand-switcher button exists');
  assert.ok(INDEX_HTML.includes('id="brand-switcher-label"'), 'button shows the active brand label');
  // The select is preserved (25+ call sites + the proven swap handler) but hidden.
  const m = INDEX_HTML.match(/<select id="brand-select"[^>]*>/);
  assert.ok(m, 'brand-select still exists');
  assert.ok(/display:\s*none/.test(m[0]), 'brand-select is hidden (button is the affordance now)');
});

test('Brand switcher — full-window tile takeover with a + New Brand form', () => {
  assert.ok(INDEX_HTML.includes('id="brand-switcher-overlay"'), 'takeover overlay exists');
  assert.ok(INDEX_HTML.includes('id="brand-switcher-grid"'), 'brand tile grid exists');
  assert.ok(INDEX_HTML.includes('id="brand-new-form"'), 'new-brand form exists');
  assert.ok(INDEX_HTML.includes('id="brand-new-name"'), 'new-brand Name field exists');
  assert.ok(INDEX_HTML.includes('id="brand-new-url"'), 'new-brand URL field exists');
  assert.ok(INDEX_HTML.includes('id="brand-new-back"') && INDEX_HTML.includes('id="brand-new-add"'), 'Back + Add buttons exist');
  // Full-frame takeover styling (like Reports/Wisdom): covers the window.
  assert.ok(/\.brand-switcher-overlay\s*\{[^}]*left:\s*0/.test(STYLE_CSS), 'overlay is full-frame');
  assert.ok(/\.brand-tile\s*\{/.test(STYLE_CSS), 'brand tiles are styled');
});

test('Brand switcher — tile click is a 1-click swap that drives the hidden select', () => {
  assert.ok(RENDERER_JS.includes('function openBrandSwitcher'), 'opener exists');
  assert.ok(RENDERER_JS.includes('function chooseBrandFromTakeover'), '1-click swap fn exists');
  const idx = RENDERER_JS.indexOf('function chooseBrandFromTakeover');
  const fn = RENDERER_JS.slice(idx, idx + 500);
  assert.ok(fn.includes("getElementById('brand-select')"), 'reuses the hidden brand-select');
  assert.ok(fn.includes("dispatchEvent(new Event('change'") , 'fires the proven swap handler');
  assert.ok(fn.includes('closeBrandSwitcher'), 'closes the takeover immediately (instant feel)');
});

test('Brand switcher — toolbar button toggles the takeover (open <-> close), 3 exits', () => {
  // RSI lock: full-window takeover has no backdrop to click outside, so the
  // button toggles. Three intentional exits = button toggle, ✕ close, Esc.
  const idx = RENDERER_JS.indexOf('function wireBrandSwitcher');
  assert.ok(idx >= 0, 'wireBrandSwitcher exists');
  const fn = RENDERER_JS.slice(idx, idx + 2000);
  assert.ok(/brand-switcher-btn'\)\?\.addEventListener\('click'/.test(fn), 'button has a click handler');
  assert.ok(fn.includes('closeBrandSwitcher') && fn.includes('openBrandSwitcher'), 'toggles open<->close');
  assert.ok(fn.includes("contains('hidden')"), 'toggle decision keys on overlay visibility');
  assert.ok(fn.includes("brand-switcher-close") && /Escape/.test(fn), 'also closes via ✕ and Esc');
});

test('Brand switcher — New Brand activates instantly + ingests async (zero friction)', () => {
  assert.ok(RENDERER_JS.includes('function addBrandFromForm'), 'add-brand fn exists');
  const idx = RENDERER_JS.indexOf('function addBrandFromForm');
  const fn = RENDERER_JS.slice(idx, idx + 1800);
  assert.ok(fn.includes('Enter a brand name') && fn.includes('Enter your brand website'), 'validates name + url');
  assert.ok(fn.includes('startBrandSetupConversation'), 'kicks off activation + async ingestion');
  assert.ok(fn.includes('Activate it immediately') && /background/i.test(fn), 'instant activate + async background ingestion');
  assert.ok(/Don.t ask me any questions/i.test(fn), 'zero mid-flow approvals (no questions)');
});

test('Brand switcher — button label stays in sync with the active brand', () => {
  assert.ok(RENDERER_JS.includes('function updateBrandSwitcherLabel'), 'label sync fn exists');
  // Synced from loadBrands (initial), brand-activated (new brand), and on swap.
  const occurrences = (RENDERER_JS.match(/updateBrandSwitcherLabel\(\)/g) || []).length;
  assert.ok(occurrences >= 3, `label sync called from multiple paths (got ${occurrences})`);
});

test('Palantir — tab button is wired and toggles the panel', () => {
  assert.ok(RENDERER_JS.includes("getElementById('palantir-btn').addEventListener"), 'btn handler bound');
  const idx = RENDERER_JS.indexOf("getElementById('palantir-btn').addEventListener");
  const handler = RENDERER_JS.slice(idx, idx + 700);
  assert.ok(handler.includes("getElementById('palantir-panel')"), 'handler toggles the panel');
  // Opening Palantir must hide every sibling surface (and clear sidebar pins).
  // Centralized in closeOtherOverlays (RSI 2026-06-22), which clears pins via
  // hideSidebarPanel; see overlay-fallthrough.test.js for helper coverage.
  assert.ok(handler.includes("closeOtherOverlays('palantir-panel')"),
    'opening Palantir delegates sibling-hiding to closeOtherOverlays');
});

test('Palantir — archive and magic handlers hide the Palantir panel', () => {
  // The symmetric invariant: every sidebar handler hides the others, now
  // centralized via closeOtherOverlays (RSI 2026-06-22) instead of per-handler
  // explicit hides, which had drifted (the helper hides palantir-panel).
  const archiveIdx = RENDERER_JS.indexOf("getElementById('archive-btn').addEventListener");
  const magicIdx = RENDERER_JS.indexOf("getElementById('magic-btn').addEventListener");
  assert.ok(RENDERER_JS.slice(archiveIdx, archiveIdx + 1600).includes("closeOtherOverlays('archive-panel')"),
    'archive-btn handler closes siblings (incl. Palantir) via closeOtherOverlays');
  assert.ok(RENDERER_JS.slice(magicIdx, magicIdx + 1600).includes("closeOtherOverlays('magic-panel')"),
    'magic-btn handler closes siblings (incl. Palantir) via closeOtherOverlays');
});

test('Palantir — infinite scroll uses an IntersectionObserver on the sentinel', () => {
  assert.ok(RENDERER_JS.includes('function palantirEnsureObserver'), 'observer setup fn exists');
  assert.ok(/palantirObserver\s*=\s*new IntersectionObserver/.test(RENDERER_JS),
    'an IntersectionObserver drives pagination');
  assert.ok(RENDERER_JS.includes("palantirState.hasMore") && RENDERER_JS.includes("loadPalantirFeed({ reset: false })"),
    'the observer pages the next cursor when hasMore');
});

test('Palantir — feed loader paginates by cursor and guards re-entry', () => {
  assert.ok(RENDERER_JS.includes('async function loadPalantirFeed'), 'loadPalantirFeed defined');
  const idx = RENDERER_JS.indexOf('async function loadPalantirFeed');
  const fn = RENDERER_JS.slice(idx, idx + 2600);
  assert.ok(fn.includes('palantirState.loading'), 'guards concurrent loads via the loading flag');
  assert.ok(fn.includes('foreplayCursor') && fn.includes('foreplayBrandIds'),
    'page 2+ requests reuse the resolved brand ids + cursor');
  assert.ok(fn.includes('window.merlin.palantirFeed'), 'calls the palantirFeed bridge');
});

test('Palantir — all ad media loads through the merlin:// protocol', () => {
  // The renderer CSP cannot load remote ad-CDN media; thumbnails are cached
  // locally by the binary and video is downloaded on demand. Both must be
  // referenced via merlinUrl(), never a raw https URL.
  assert.ok(RENDERER_JS.includes("merlinUrl('results/competitor-ads/thumbs/'"),
    'thumbnails resolve through merlin:// under results/');
  const playIdx = RENDERER_JS.indexOf('async function palantirPlayVideo');
  assert.ok(playIdx >= 0, 'palantirPlayVideo defined');
  assert.ok(RENDERER_JS.slice(playIdx, playIdx + 900).includes('merlinUrl(res.path)'),
    'downloaded video plays via a merlin:// URL');
});

test('Palantir — "use as inspiration" seeds the chat input', () => {
  assert.ok(RENDERER_JS.includes('function palantirUseAsInspiration'), 'inspiration fn exists');
  const idx = RENDERER_JS.indexOf('function palantirUseAsInspiration');
  const fn = RENDERER_JS.slice(idx, idx + 900);
  assert.ok(fn.includes('input.value'), 'writes a brief into the chat input');
  // Populates but does NOT auto-send — the user names the product first.
  assert.ok(!/sendMessage\(\)/.test(fn), 'must not auto-send the message');
});

test('Palantir — preload exposes the bridge methods', () => {
  assert.ok(/palantirFeed:\s*\(opts\)\s*=>\s*ipcRenderer\.invoke\('palantir-feed'/.test(PRELOAD_JS),
    'palantirFeed bridge wired to the palantir-feed channel');
  assert.ok(/palantirDownloadAd:\s*\(opts\)\s*=>\s*ipcRenderer\.invoke\('palantir-download-ad'/.test(PRELOAD_JS),
    'palantirDownloadAd bridge wired');
  // Options objects must be validated before crossing the IPC boundary.
  assert.ok(/palantirFeed:[^\n]*assertObj\(opts\)/.test(PRELOAD_JS), 'palantirFeed validates its options object');
});

test('Palantir — main.js IPC handlers spawn the binary safely', () => {
  assert.ok(MAIN_JS.includes("ipcMain.handle('palantir-feed'"), 'palantir-feed handler registered');
  assert.ok(MAIN_JS.includes("ipcMain.handle('palantir-download-ad'"), 'palantir-download-ad handler registered');
  assert.ok(MAIN_JS.includes("action: 'palantir-feed'"), 'feed handler invokes the palantir-feed binary action');
  assert.ok(MAIN_JS.includes("action: 'foreplay-download-ad'"), 'download handler reuses the foreplay-download-ad action');
  // The single-line result contract.
  assert.ok(MAIN_JS.includes("function extractPalantirResult"), 'result extractor present');
  assert.ok(MAIN_JS.includes("'PALANTIR_RESULT '"), 'extractor keys on the PALANTIR_RESULT prefix');
});

test('Palantir — has themed styles for the panel and lightbox', () => {
  assert.ok(STYLE_CSS.includes('.palantir-panel'), 'panel styled');
  assert.ok(STYLE_CSS.includes('.palantir-card'), 'ad card styled');
  assert.ok(STYLE_CSS.includes('.palantir-detail'), 'detail lightbox styled');
  // Uses theme variables, so it tracks dark/light mode for free.
  assert.ok(/\.palantir-panel\s*{[^}]*var\(--/.test(STYLE_CSS), 'panel uses theme CSS variables');
});

// ── RSI Iteration 1 — Palantir renderer-hygiene regression locks ─────

test('RSI — Palantir IntersectionObserver is torn down on panel close', () => {
  // The observer must not survive a panel close, or it fires zombie
  // binary spawns against a hidden panel on every sibling-tab reflow.
  assert.ok(RENDERER_JS.includes('function palantirCloseCleanup'),
    'palantirCloseCleanup teardown fn exists');
  assert.ok(/palantirCloseCleanup\b[\s\S]{0,160}palantirObserver\.disconnect\(\)/.test(RENDERER_JS),
    'cleanup disconnects the IntersectionObserver');
  assert.ok(/palantirObserver\s*=\s*null/.test(RENDERER_JS),
    'cleanup nulls the observer so it can be re-armed');
  // A lifecycle hook disconnects it whenever the panel is hidden.
  assert.ok(RENDERER_JS.includes('ensurePalantirObserverLifecycle'),
    'a MutationObserver-based lifecycle hook exists');
});

test('RSI — Palantir observer callback refuses to page a hidden panel', () => {
  const idx = RENDERER_JS.indexOf('palantirObserver = new IntersectionObserver');
  const cb = RENDERER_JS.slice(idx, idx + 700);
  assert.ok(cb.includes("classList.contains('hidden')"),
    'the observer callback early-returns when the panel is hidden');
});

test('RSI — Palantir feed grid is capped (no unbounded infinite scroll)', () => {
  assert.ok(/const PALANTIR_MAX_CARDS\s*=\s*\d+/.test(RENDERER_JS),
    'a hard card cap constant is declared');
  assert.ok(/grid\.children\.length\s*>\s*PALANTIR_MAX_CARDS[\s\S]{0,120}grid\.removeChild\(grid\.firstChild\)/.test(RENDERER_JS),
    'oldest cards are pruned from the top once over the cap');
});

test('RSI — Palantir surfaces the binary error through friendlyError', () => {
  // Rule 6 — never render an upstream error string raw.
  assert.ok(/palantirSetStatus\(friendlyError\(res\.error/.test(RENDERER_JS),
    'res.error is wrapped in friendlyError() before it reaches the DOM');
});

test('RSI — Palantir "open landing page" failure is not silent', () => {
  const idx = RENDERER_JS.indexOf('window.merlin.openExternal(ad.linkUrl)');
  assert.ok(idx >= 0, 'openExternal call present');
  const slice = RENDERER_JS.slice(idx, idx + 160);
  assert.ok(slice.includes('palantirDetailNote'),
    'a failed openExternal shows the user a note instead of swallowing silently');
});

// REGRESSION GUARD (2026-06-01, pre-release review catch): Rule 6 — the
// palantirPlayVideo error path must route the raw binary error through
// friendlyError so internal Go error strings (file paths, network detail)
// never reach a paying user. It previously passed res.error straight to
// palantirDetailNote (the textContent write dodged the explicit BLOCK
// trigger, but it still leaked).
test('RSI — Palantir video-play failure routes through friendlyError (Rule 6)', () => {
  const idx = RENDERER_JS.indexOf("btn.textContent = '▶ Play video';");
  assert.ok(idx >= 0, 'palantirPlayVideo error branch present');
  const slice = RENDERER_JS.slice(idx, idx + 400);
  assert.ok(/friendlyError\(res\.error/.test(slice),
    'the video-play error must be wrapped in friendlyError(res.error, ...) before display');
  // The raw unwrapped pass-through must be gone.
  assert.ok(!/palantirDetailNote\(\(res && res\.error\) \|\| 'Could not load the video\.'\)/.test(RENDERER_JS),
    'the raw `(res && res.error) ||` pass-through must not return');
});

// ── RSI #12 — Accessibility source-scan ────────────────────────────
//
// The renderer is a paying-user-facing surface — keyboard-only operators
// and screen-reader users have to be able to drive it. These scans pin
// the basics:
//
//   1. Every <button> in index.html has SOMETHING a screen reader can
//      announce — visible text, an aria-label, or an aria-labelledby.
//      An icon-only button with no name is invisible.
//   2. Every text/url/email <input> has either an aria-label or a
//      <label for="..."> association. An input with no name is
//      unrecognizable to AT.
//   3. The chat-stream status surfaces (where async progress messages
//      land) carry an aria-live region so screen readers announce the
//      update without the user having to refocus.
//
// Source-scan rather than DOM-driven so the lock is cheap, deterministic,
// and runs in CI without Electron. The cost is some false-positive
// brittleness (the scan parses HTML with regex) — accepted because the
// alternative is "no a11y guard at all."

const INDEX_HTML_A11Y = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');

test('RSI a11y — every <button> has an accessible name (text content OR aria-label)', () => {
  // Match each <button ...>...</button>. Greedy across newlines is fine
  // for this file (no nested <button>); the regex captures the opening
  // tag + the inner body up to the next </button>.
  const buttons = [...INDEX_HTML_A11Y.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.ok(buttons.length > 50, `scan must find buttons in index.html (got ${buttons.length}); regex may be broken`);

  const offenders = [];
  for (const [, openAttrs, inner] of buttons) {
    if (/aria-label\s*=\s*"[^"]+"/.test(openAttrs)) continue;
    if (/aria-labelledby\s*=\s*"[^"]+"/.test(openAttrs)) continue;
    // Strip every tag from `inner`, normalize whitespace, check for any
    // remaining text. An <svg> child without text counts as empty —
    // that's the icon-only case that needs an aria-label.
    const visible = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (visible.length > 0) continue;
    // Truncate the offending tag for the error message.
    const preview = `<button${openAttrs}>${inner}</button>`.slice(0, 200);
    offenders.push(preview);
  }
  if (offenders.length > 0) {
    assert.fail(`a11y: ${offenders.length} icon-only button(s) missing aria-label / aria-labelledby:\n  ` +
      offenders.slice(0, 5).map(o => o.replace(/\s+/g, ' ')).join('\n  '));
  }
});

test('RSI a11y — every text-like <input> has an accessible name', () => {
  // Cover text / search / email / url / tel / password / number.
  const inputs = [...INDEX_HTML_A11Y.matchAll(/<input\b([^>]*type\s*=\s*"(?:text|search|email|url|tel|password|number)"[^>]*)>/g)];
  if (inputs.length === 0) return; // no inputs of these types in this surface — vacuously pass
  const offenders = [];
  for (const [, attrs] of inputs) {
    if (/aria-label\s*=\s*"[^"]+"/.test(attrs)) continue;
    if (/aria-labelledby\s*=\s*"[^"]+"/.test(attrs)) continue;
    const idMatch = attrs.match(/\bid\s*=\s*"([^"]+)"/);
    if (idMatch) {
      // Look for a <label for="<id>"> elsewhere in the document.
      const id = idMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const labelRe = new RegExp(`<label\\b[^>]*\\bfor\\s*=\\s*"${id}"`);
      if (labelRe.test(INDEX_HTML_A11Y)) continue;
    }
    offenders.push(`<input${attrs}>`.slice(0, 180));
  }
  if (offenders.length > 0) {
    assert.fail(`a11y: ${offenders.length} input(s) missing aria-label / aria-labelledby / <label for=>:\n  ` +
      offenders.join('\n  '));
  }
});

test('RSI a11y — chat status surfaces carry aria-live', () => {
  // The chat row uses #status-pill (or equivalent) for async progress.
  // We don't require a specific id — just that at least one aria-live
  // region exists per layout (we already have request-thanks and
  // attachment-row as anchors), AND the count is >= 2 so a future
  // delete of one doesn't silently strand the other surface.
  const liveCount = (INDEX_HTML_A11Y.match(/aria-live\s*=\s*"(polite|assertive)"/g) || []).length;
  assert.ok(liveCount >= 2,
    `expected >= 2 aria-live regions for async announcements, found ${liveCount}. ` +
    'Async progress (chat status, attachment row, request feedback) must announce to screen readers ' +
    'without the user having to refocus.');
});

// ── Turn timer: human-readable duration (2026-05-22) ───────────────
//
// Mirror of renderer.js formatElapsed. The live ticker + post-turn stats
// line used to print raw seconds ("160s..."); they now render h/m/s. Pin
// both the formatting contract (mirror) AND that renderer.js actually uses
// the helper at both call sites (source-scan) so a revert is caught.
function formatElapsed(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

test('timer — formatElapsed renders seconds / minutes / hours, not raw seconds', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(45), '45s');
  assert.equal(formatElapsed(60), '1m 0s');
  assert.equal(formatElapsed(160), '2m 40s');   // the reported "160s..." case
  assert.equal(formatElapsed(599), '9m 59s');
  assert.equal(formatElapsed(3600), '1h 0m 0s');
  assert.equal(formatElapsed(3725), '1h 2m 5s');
  // Defensive: negatives / NaN floor to 0s, never throw or print "NaNs".
  assert.equal(formatElapsed(-5), '0s');
  assert.equal(formatElapsed(undefined), '0s');
});

test('timer — renderer.js uses formatElapsed for the live ticker AND the stats line (no raw ${elapsed}s)', () => {
  // The live ticker must format, not print raw seconds.
  assert.match(RENDERER_JS, /tickerEl\.textContent\s*=\s*`\$\{formatElapsed\(elapsed\)\}\.\.\.`/,
    'live ticker must render formatElapsed(elapsed), not `${elapsed}s...`');
  // The post-turn stats line must format the duration too.
  assert.match(RENDERER_JS, /statsText\s*=\s*formatElapsed\(parseInt\(duration,\s*10\)\)/,
    'post-turn stats line must render formatElapsed(duration), not `${duration}s`');
  // Guard against regression: the old raw-seconds ticker write must be gone.
  assert.doesNotMatch(RENDERER_JS, /tickerEl\.textContent\s*=\s*`\$\{elapsed\}s\.\.\.`/,
    'raw `${elapsed}s...` ticker write must not return');
});

// ── Spinner verb persists on long turns (onboarding) (2026-05-22) ──
//
// showTypingIndicator() arms a 120s typingStuckTimeout → clearStatusLabel().
// On any turn longer than 2 min (onboarding scrape + product import) that
// timer wiped the live spinner verb, leaving just the bare ticker counting.
// setStatusLabel now cancels that stuck-clear once a real progress verb is
// set, so the verb survives the whole live turn. Pin the fix.
test('status verb — setStatusLabel cancels the 120s stuck-clear on real progress', () => {
  const fnIdx = RENDERER_JS.indexOf('function setStatusLabel(label)');
  assert.ok(fnIdx > 0, 'setStatusLabel not found');
  const body = RENDERER_JS.slice(fnIdx, fnIdx + 1200);
  // The guard: any non-"Thinking" label clears typingStuckTimeout so a live
  // long turn keeps its verb.
  assert.match(body, /label !== 'Thinking'\s*&&\s*typingStuckTimeout/,
    'setStatusLabel must cancel typingStuckTimeout when a real progress verb replaces "Thinking"');
  assert.match(body, /clearTimeout\(typingStuckTimeout\)/,
    'setStatusLabel must clearTimeout the stuck-clear');
});

test('status verb — onboarding/brand tools get real verbs, not generic "Channeling"', () => {
  // The brand_scrape step is onboarding's longest; it (and the other brand
  // tools) must surface a meaningful verb so the user sees progress instead
  // of a generic "Channeling" or a bare timer.
  assert.match(RENDERER_JS, /tool === 'brand_scrape'/);
  assert.match(RENDERER_JS, /label = 'Studying your brand'/);
  assert.match(RENDERER_JS, /tool === 'brand_activate'/);
  assert.match(RENDERER_JS, /label = 'Setting up your brand'/);
});


// REGRESSION GUARD (2026-06-XX, connector-hardening — Rule 6):
// Two error-surfacing paths rendered the raw backend error string directly:
// the perf-bar refresh handler (escapeHtml(result.error) → innerHTML) and the
// Claude sign-in bubble (result.error → textContent). Both now route through
// friendlyErrorPlain so a raw CLI/engine/stack-trace string never reaches a
// paying user. friendlyErrorPlain is the compact variant (chip markup reduced
// to labels, single line) for surfaces that don't run renderErrorToBubble.
test('Rule 6 — friendlyErrorPlain helper exists and strips chip/deadend markup', () => {
  const idx = RENDERER_JS.indexOf('function friendlyErrorPlain(');
  assert.ok(idx > 0, 'friendlyErrorPlain must be defined');
  const body = RENDERER_JS.slice(idx, idx + 600);
  assert.ok(body.includes('friendlyError('),
    'friendlyErrorPlain must delegate to friendlyError (Rule 6 humanization)');
  assert.ok(body.includes('\\[\\[chip:'),
    'friendlyErrorPlain must strip [[chip:...]] markup for plain-text surfaces');
  assert.ok(body.includes('\\[\\[deadend:'),
    'friendlyErrorPlain must strip [[deadend:...]] markup for plain-text surfaces');
});

test('Rule 6 — perf-bar refresh error routes through friendlyErrorPlain', () => {
  // The perf-bar handler must NOT render the raw result.error.
  assert.ok(!RENDERER_JS.includes('text.innerHTML = escapeHtml(result.error)'),
    'perf-bar must not render the raw backend error string (Rule 6)');
  assert.ok(RENDERER_JS.includes('escapeHtml(friendlyErrorPlain(result.error))'),
    'perf-bar refresh error must route through friendlyErrorPlain before innerHTML');
});

test('Rule 6 — Claude sign-in bubble routes error through friendlyErrorPlain', () => {
  // The pre-fix form assigned result.error straight to textContent.
  assert.ok(!RENDERER_JS.includes("bubble.textContent = result.error || 'Sign-in failed"),
    'sign-in bubble must not render the raw backend error string (Rule 6)');
  assert.ok(RENDERER_JS.includes("friendlyErrorPlain(result.error, 'Claude sign-in')"),
    'sign-in failure must route through friendlyErrorPlain');
});

// ── Truesight funnel view ───────────────────────────────────────────
test('Truesight — index.html has the button, panel, and funnel container', () => {
  assert.ok(INDEX_HTML.includes('id="truesight-btn"'), 'toolbar button exists');
  assert.ok(INDEX_HTML.includes('id="truesight-panel"'), 'full-window panel exists');
  assert.ok(INDEX_HTML.includes('id="truesight-funnel"'), 'funnel container exists');
  assert.ok(INDEX_HTML.includes('id="truesight-connect-cta"'), 'connect CTA container exists');
});

test('Truesight — button sits one slot to the RIGHT of Palantir', () => {
  const palantir = INDEX_HTML.indexOf('id="palantir-btn"');
  const truesight = INDEX_HTML.indexOf('id="truesight-btn"');
  const wisdom = INDEX_HTML.indexOf('id="wisdom-header-btn"');
  assert.ok(palantir > 0 && truesight > 0 && wisdom > 0, 'all three buttons exist');
  assert.ok(palantir < truesight && truesight < wisdom, 'order must be Palantir → Truesight → Wisdom');
});

test('Truesight — panel is a full-window takeover (fixed, top:40px, z-index:60)', () => {
  assert.ok(/\.truesight-panel\s*\{[^}]*position:\s*fixed/.test(STYLE_CSS), 'panel is position:fixed');
  assert.ok(/\.truesight-panel\s*\{[^}]*top:\s*40px/.test(STYLE_CSS), 'panel sits below the titlebar');
  assert.ok(/\.truesight-panel\s*\{[^}]*z-index:\s*60/.test(STYLE_CSS), 'panel z-index is 60 (matches Palantir layer)');
  assert.ok(/\.truesight-panel\.hidden\s*\{\s*display:\s*none/.test(STYLE_CSS), '.hidden toggles display:none');
});

test('Truesight — opening the panel loads via the IPC bridge + closeOtherOverlays', () => {
  const idx = RENDERER_JS.indexOf("getElementById('truesight-btn')");
  assert.ok(idx > 0, 'truesight-btn handler exists');
  const handler = RENDERER_JS.slice(idx, idx + 400);
  assert.ok(handler.includes("closeOtherOverlays('truesight-panel')"), 'closes sibling overlays first');
  assert.ok(handler.includes('loadTruesightData'), 'loads funnel data on open');
  // closeOtherOverlays must also hide the truesight panel when another opens.
  const co = RENDERER_JS.indexOf('function closeOtherOverlays');
  const cofn = RENDERER_JS.slice(co, co + 700);
  assert.ok(cofn.includes("truesight-panel"), 'closeOtherOverlays manages the truesight panel');
});

test('Truesight — preload exposes the truesight bridge', () => {
  assert.ok(PRELOAD_JS.includes("truesight: (opts) => ipcRenderer.invoke('truesight'"),
    'preload exposes merlin.truesight → truesight IPC');
});

test('Truesight — renders funnel via escaped sinks (no raw innerHTML of source/label)', () => {
  const idx = RENDERER_JS.indexOf('function renderTruesightFunnel');
  assert.ok(idx > 0, 'renderTruesightFunnel exists');
  const fn = RENDERER_JS.slice(idx, idx + 2600);
  // every dynamic field is wrapped in escapeHtml; numbers go through tsNum
  assert.ok(fn.includes('escapeHtml(stage.label'), 'stage label is escaped');
  assert.ok(fn.includes('escapeHtml(stage.source'), 'stage source is escaped');
  assert.ok(/escapeHtml\(stage\.key/.test(fn), 'stage key is escaped into the data attribute');
  assert.ok(fn.includes('tsNum(stage.value)'), 'numbers render through tsNum (digits + K/M/B only)');
});

test('Truesight — empty state shows a connect CTA, never a broken funnel', () => {
  const idx = RENDERER_JS.indexOf('async function loadTruesightData');
  assert.ok(idx > 0, 'loadTruesightData exists');
  const fn = RENDERER_JS.slice(idx, idx + 2000);
  assert.ok(fn.includes('any_connected'), 'checks any_connected before rendering');
  assert.ok(fn.includes('ts-connect-btn') && fn.includes("getElementById('magic-btn')"),
    'no-source state offers a Connect button that opens the Magic panel');
  assert.ok(fn.includes('res.error'), 'surfaces a friendly error (not a crash)');
});

test('Truesight — 7/30/90 window toggle defaults to 7 days', () => {
  assert.ok(INDEX_HTML.includes('truesight-window-btn') && INDEX_HTML.includes('data-days="7"'),
    'window toggle buttons exist');
  assert.ok(RENDERER_JS.includes('let tsWindowDays = 7'), 'default window is 7 days');
});
