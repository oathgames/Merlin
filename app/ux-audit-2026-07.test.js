// ux-audit-2026-07.test.js: source-scan locks for the 2026-07-11 UX audit
// fix pass (session/fable-audit). The renderer cannot be exercised without
// an Electron BrowserWindow plus preload, so, like renderer.test.js and
// interaction-polish.test.js, each fix is pinned by scanning the shipped
// source for the string that makes the fix true and, where it matters, for
// the anti-pattern that made the old code wrong.
//
// Items covered (numbering from the audit punch list):
//   1  staleness chip uses timeAgo (fmtAgo was a ReferenceError)
//   2  sentinel-safe error sinks (friendlyErrorPlain into textContent)
//   3  single stats-overlay Esc handler
//   4  anyModalTakeoverOpen covers truesight + archive
//   5  singular/plural ad counts
//   6  one money dialect (formatMoney everywhere, uppercase K)
//   7  truthful perf-bar no-brand empty state (pinned in renderer.test.js)
//   8  brand switcher getBrands-failure copy
//   9  wisdom fetch-failure copy distinct from genuine-empty
//   10 activity feed failure state with retry
//   11 activity CSS tokens (no hardcoded white-alpha)
//   12 snapchat chip light-theme override
//   13 palantir close paths route through closeTakeover
//   14 QR modal dialog semantics
//   15 honest connection-check timeout guidance
//   16 closeTakeover timer cancellation (pinned in interaction-polish.test.js)
//   17 focus management on aria-modal takeovers + stats overlay semantics
//   18 keyboard activation for click-only cards and rows
//   19 brand-switch failure repaints the previous thread + toasts
//   20 startup IPC dedup via bootSnapshot
//   21 palantir prune scroll compensation
//   22 budget breakdown opens on click and focus, not hover only
//   23 aria-live turn-completion announcement
//   24 friendlyError OAuth + safe-mode mappings
//   25 OAuth tile waiting state + cancel affordance
//   26 two-container streaming write
//
// Run with: node --test app/ux-audit-2026-07.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_JS = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const OAUTH_FAST_OPEN_JS = fs.readFileSync(path.join(__dirname, 'oauth-fast-open.js'), 'utf8');

// ── 1: staleness chip ───────────────────────────────────────────────

test('item 1: archive staleness chip uses timeAgo, fmtAgo is gone', () => {
  assert.ok(!RENDERER_JS.includes('fmtAgo('),
    'fmtAgo() does not exist; calling it threw a ReferenceError that left the chip on "refreshing" forever');
  assert.match(RENDERER_JS, /showing saved data \(\$\{timeAgo\(newestUpdatedAt\)\}\)/,
    'the failed-refresh chip renders the saved-data age via the shared timeAgo helper');
});

// ── 2: sentinel-safe error sinks ────────────────────────────────────

test('item 2: textContent and escaped sinks use friendlyErrorPlain, never friendlyError', () => {
  // The chip-capable friendlyError can emit [[chip:...]] sentinels, which
  // render as literal markup in plain-text sinks.
  assert.match(RENDERER_JS, /setStatus\(friendlyErrorPlain\(err\?\.message \|\| String\(err\), 'report'\)/,
    'agency report modal status routes through friendlyErrorPlain');
  assert.match(RENDERER_JS, /palantirPortalHTML\('error', \(res && res\.error\) \? friendlyErrorPlain\(/,
    'palantir portal error routes through friendlyErrorPlain (portal escapes msg)');
  assert.match(RENDERER_JS, /url\.textContent = friendlyErrorPlain\(/,
    'QR modal error routes through friendlyErrorPlain');
});

// ── 3: single stats-overlay Esc handler ─────────────────────────────

test('item 3: exactly one Esc handler closes the stats overlay, via closeTakeover', () => {
  const escBlocks = RENDERER_JS.match(
    /if \(e\.key !== 'Escape'\) return;\s*\n\s*const overlay = document\.getElementById\('stats-overlay'\)/g,
  ) || [];
  assert.equal(escBlocks.length, 1,
    'a second Esc handler used to set .hidden directly and kill the close animation');
});

// ── 4: anyModalTakeoverOpen coverage ────────────────────────────────

test('item 4: anyModalTakeoverOpen checks all six takeover surfaces', () => {
  const idx = RENDERER_JS.indexOf('function anyModalTakeoverOpen');
  assert.ok(idx > 0, 'anyModalTakeoverOpen exists');
  const fn = RENDERER_JS.slice(idx, idx + 500);
  for (const id of ['brand-switcher-overlay', 'wisdom-overlay', 'palantir-panel', 'agency-overlay', 'truesight-panel', 'archive-panel']) {
    assert.ok(fn.includes(`'${id}'`), `anyModalTakeoverOpen must include ${id}`);
  }
});

// ── 5: plurals ──────────────────────────────────────────────────────

test('item 5: ad counts pluralize (no "1 ads", no "1 days left")', () => {
  assert.match(RENDERER_JS, /palantirState\.count \+ ' ad' \+ \(palantirState\.count === 1 \? '' : 's'\)/,
    'palantir feed count pluralizes');
  assert.match(RENDERER_JS, /\(p\.n \|\| 0\) \+ ' ad' \+ \(\(p\.n \|\| 0\) === 1 \? '' : 's'\)/,
    'wisdom platform row count pluralizes');
  assert.ok(!/palantirState\.count \+ ' ads'/.test(RENDERER_JS),
    'the always-plural palantir count must not return');
});

// ── 6: money dialect ────────────────────────────────────────────────

test('item 6: money surfaces route through formatMoney; fmtInt uses uppercase K', () => {
  assert.match(RENDERER_JS, /Daily Budget: \$\{formatMoney\(perf\.dailyBudget\)\}\/day/,
    'perf-bar daily budget uses formatMoney');
  assert.match(RENDERER_JS, /<span>\$\{formatMoney\(p\.spend\)\}<\/span>/,
    'platform dropdown spend uses formatMoney');
  assert.match(RENDERER_JS, /\$\{formatMoney\(ad\.budget\)\}\/day/,
    'live-ad card budget uses formatMoney');
  assert.ok(RENDERER_JS.includes('(n/1000).toFixed(1)}K'),
    'live-ad fmtInt compacts with uppercase K');
  assert.ok(!RENDERER_JS.includes('(n/1000).toFixed(1)}k'),
    'the lowercase-k fmtInt dialect must not return');
});

// ── 8: brand switcher load failure ──────────────────────────────────

test('item 8: brand switcher distinguishes load failure from an empty brand list', () => {
  const idx = RENDERER_JS.indexOf('async function openBrandSwitcher');
  assert.ok(idx > 0, 'openBrandSwitcher exists');
  const fn = RENDERER_JS.slice(idx, idx + 3000);
  assert.match(fn, /brandsLoadFailed/, 'a load-failed flag is tracked');
  assert.ok(fn.includes("Couldn't load your brands. Close and reopen to try again."),
    'load failure renders honest copy instead of an empty grid that reads as data loss');
});

// ── 9: wisdom fetch failure ─────────────────────────────────────────

test('item 9: wisdom fetch failure has its own copy, distinct from genuine-empty', () => {
  const idx = RENDERER_JS.indexOf('async function loadWisdom');
  const fn = RENDERER_JS.slice(idx, idx + 2400);
  // Source form: the copy lives in a single-quoted string, so the
  // apostrophe is backslash-escaped in the file text.
  assert.ok(fn.includes("Couldn\\'t reach Wisdom. Check your connection and tap refresh."),
    'fetch failure says the truth');
  assert.match(fn, /wisdomFetchFailed/, 'failure tracked separately from the empty result');
});

// ── 10: activity feed failure state ─────────────────────────────────

test('item 10: activity feed failure renders an error shell with retry', () => {
  const idx = RENDERER_JS.indexOf('async function loadActivityFeed');
  const fn = RENDERER_JS.slice(idx, idx + 3500);
  // Source form: single-quoted string, apostrophe backslash-escaped.
  assert.ok(fn.includes("Couldn\\'t load activity."), 'failure copy present');
  assert.match(fn, /retry\.addEventListener\('click',[\s\S]{0,120}loadActivityFeed\(/,
    'retry link re-calls loadActivityFeed');
});

// ── 11 + 12: theme-safe CSS ─────────────────────────────────────────

test('item 11: activity block uses hover tokens, not hardcoded white-alpha', () => {
  // Slice the Activity styles between the .activity-item rule and the
  // titlebar section that follows the block.
  const start = STYLE_CSS.indexOf('.activity-item {');
  const end = STYLE_CSS.indexOf('Custom Titlebar');
  assert.ok(start > 0 && end > start, 'activity CSS block found');
  const block = STYLE_CSS.slice(start, end);
  assert.ok(!/rgba\(255,\s*255,\s*255/.test(block),
    'activity controls must use the theme-aware --hover-* tokens; white-alpha is invisible in light mode');
  assert.match(block, /var\(--hover-4\)/, 'hover tokens are in use');
});

test('item 12: snapchat chip has a readable light-theme override', () => {
  assert.match(STYLE_CSS, /\[data-theme="light"\] \.platform-snapchat/,
    'light theme overrides the #fffc00-on-white chip (about 1.1:1 contrast)');
});

// ── 13: palantir close paths ────────────────────────────────────────

test('item 13: palantir closes via closeTakeover everywhere, Esc restores focus', () => {
  // No raw .hidden flips on the palantir panel remain (interaction-polish
  // lock covers getElementById form; this pins the two former offenders).
  const inspIdx = RENDERER_JS.indexOf('function palantirUseAsInspiration');
  const inspFn = RENDERER_JS.slice(inspIdx, inspIdx + 1200);
  assert.match(inspFn, /closeTakeover\(palantirEl\('palantir-panel'\)\)/,
    'use-as-inspiration closes via closeTakeover');
  assert.ok(!inspFn.includes("panel.classList.add('hidden')"),
    'the raw .hidden flip in use-as-inspiration must not return');
  // Esc handler: closeTakeover + focus restore to the opener.
  const escIdx = RENDERER_JS.indexOf('// Esc closes the full-frame takeover');
  const escFn = RENDERER_JS.slice(escIdx, escIdx + 900);
  assert.match(escFn, /closeTakeover\(panel\)/, 'palantir Esc uses closeTakeover');
  assert.match(escFn, /getElementById\('palantir-btn'\)\?\.focus\(\)/, 'palantir Esc restores focus to the opener');
});

// ── 14: QR modal semantics ──────────────────────────────────────────

test('item 14: QR modal is a labeled dialog with a labeled close button', () => {
  assert.match(INDEX_HTML, /id="qr-modal"[^>]*role="dialog"/, 'qr-modal has role=dialog');
  assert.match(INDEX_HTML, /id="qr-modal"[^>]*aria-modal="true"/, 'qr-modal is aria-modal');
  assert.match(INDEX_HTML, /id="qr-close"[^>]*aria-label="Close"/, 'qr-close has an accessible name');
});

// ── 15: honest timeout guidance ─────────────────────────────────────

test('item 15: connection-check timeout tells the user to reopen the panel', () => {
  assert.ok(RENDERER_JS.includes('Close and reopen this panel to try again.'),
    'reopening the panel is what actually re-runs loadConnections');
  assert.ok(!RENDERER_JS.includes('Click any tile to retry.'),
    'the old copy was wrong: a tile click starts OAuth, it does not retry the check');
});

// ── 17: focus management ────────────────────────────────────────────

test('item 17: aria-modal takeovers move focus in on open and restore it on close', () => {
  for (const closeId of ['wisdom-close', 'palantir-close', 'archive-close', 'brand-switcher-close', 'stats-close']) {
    assert.ok(RENDERER_JS.includes(`document.getElementById('${closeId}')?.focus()`),
      `${closeId} receives focus when its takeover opens`);
  }
  for (const openerId of ['wisdom-header-btn', 'palantir-btn', 'archive-btn', 'brand-switcher-btn']) {
    assert.ok(RENDERER_JS.includes(`document.getElementById('${openerId}')?.focus()`),
      `focus returns to ${openerId} when its takeover closes`);
  }
});

test('item 17: stats overlay is a dialog and its period toggle announces state', () => {
  assert.match(INDEX_HTML, /id="stats-overlay"[^>]*role="dialog"/, 'stats overlay has role=dialog');
  assert.match(INDEX_HTML, /id="stats-overlay"[^>]*aria-modal="true"/, 'stats overlay is aria-modal');
  assert.ok(!/stats-period-btn" data-days="\d+" role="tab"/.test(INDEX_HTML),
    'period buttons are toggle buttons now, not unmanaged tabs');
  assert.match(INDEX_HTML, /class="stats-period-btn" data-days="7" aria-pressed="false"/,
    'period buttons carry aria-pressed');
  const fnIdx = RENDERER_JS.indexOf('function setStatsPeriodActive');
  const fn = RENDERER_JS.slice(fnIdx, fnIdx + 600);
  assert.match(fn, /setAttribute\('aria-pressed'/, 'setStatsPeriodActive manages aria-pressed');
});

// ── 18: keyboard dead zones ─────────────────────────────────────────

test('item 18: click-only cards and rows are keyboard-activatable', () => {
  // Each surface follows the shipped gallery-card pattern: tabindex=0,
  // role=button, Enter/Space activate.
  const anchors = [
    ['swipe cards', "card.className = 'archive-card swipe-card'", 1600],
    ['palantir feed cards', 'function palantirRenderCard', 2400],
    ['activity rows', 'function renderActivityItem', 7000],
  ];
  for (const [label, anchor, span] of anchors) {
    const idx = RENDERER_JS.indexOf(anchor);
    assert.ok(idx > 0, `${label}: anchor found`);
    const region = RENDERER_JS.slice(Math.max(0, idx - 900), idx + span);
    assert.match(region, /setAttribute\('tabindex', '0'\)/, `${label}: focusable`);
    assert.match(region, /setAttribute\('role', 'button'\)/, `${label}: announced as a button`);
    assert.match(region, /e(v)?\.key === 'Enter' \|\| e(v)?\.key === ' '/, `${label}: Enter/Space activate`);
  }
  // Live-ad cards: attributes land at card creation, the keydown next to
  // the click handler ~170 lines later, so pin the two ends separately.
  assert.match(RENDERER_JS, /aria-label', `\$\{ad\.name \|\| 'Ad'\}/,
    'live-ad cards: labeled at creation');
  const liveIdx = RENDERER_JS.indexOf('const openLiveAdPreview = () =>');
  assert.ok(liveIdx > 0, 'live-ad cards: activate fn found');
  const liveRegion = RENDERER_JS.slice(liveIdx, liveIdx + 2600);
  assert.match(liveRegion, /e\.key === 'Enter' \|\| e\.key === ' '/,
    'live-ad cards: Enter/Space activate');
  // Spell rows + custom row + Show more expander.
  const spellIdx = RENDERER_JS.indexOf("row.className = 'spell-row spell-row-template'");
  const spellRegion = RENDERER_JS.slice(spellIdx, spellIdx + 1400);
  assert.match(spellRegion, /setAttribute\('role', 'button'\)/, 'spell template rows are buttons');
  const showMoreIdx = RENDERER_JS.indexOf("showMore.className = 'spell-show-more'");
  const showMoreRegion = RENDERER_JS.slice(showMoreIdx, showMoreIdx + 900);
  assert.match(showMoreRegion, /setAttribute\('aria-expanded', 'false'\)/, 'Show more announces expansion state');
});

// ── 19: brand-switch failure recovery ───────────────────────────────

test('item 19: failed brand switch repaints the previous thread and toasts', () => {
  const idx = RENDERER_JS.indexOf("document.getElementById('brand-select').addEventListener('change'");
  assert.ok(idx > 0, 'brand-select change handler exists');
  const fn = RENDERER_JS.slice(idx, idx + 8000);
  assert.match(fn, /preseedPlaceholder = preseedBrandSwitch\(/, 'preseed placeholder is captured');
  assert.match(fn, /recovered = await merlin\.switchBrand\(prevBrand\)/,
    'failure path re-pulls the previous brand thread (same-brand no-op returns bubbles)');
  assert.match(fn, /paintBrandThread\(recovered\.bubbles\)/, 'previous thread is repainted');
  assert.ok(fn.includes("Couldn't switch brands. You're still on ${prevLabel}."),
    'failure is announced with the brand the user is still on');
});

// ── 20: startup IPC dedup ───────────────────────────────────────────

test('item 20: bootSnapshot dedupes the startup getBrands/loadState/getBriefing pulls', () => {
  assert.match(RENDERER_JS, /function bootSnapshot\(\)/, 'bootSnapshot exists');
  const briefingCalls = RENDERER_JS.match(/merlin\.getBriefing\(\)/g) || [];
  assert.equal(briefingCalls.length, 1,
    `getBriefing must fire exactly once at launch (inside bootSnapshot); found ${briefingCalls.length} call sites`);
  assert.match(RENDERER_JS, /loadBrands\(bootSnapshot\(\)\)\.then\(/,
    'the boot loadBrands chain consumes the shared snapshot');
  const loadBrandsIdx = RENDERER_JS.indexOf('async function loadBrands(');
  const loadBrandsFn = RENDERER_JS.slice(loadBrandsIdx, loadBrandsIdx + 800);
  assert.match(loadBrandsFn, /bootReads\?\.brands \?\? merlin\.getBrands\(\)/,
    'loadBrands uses the snapshot only when the boot chain passes it; all later callers hit live IPC');
});

// ── 21: palantir prune scroll compensation ──────────────────────────

test('item 21: pruning palantir cards compensates scrollTop', () => {
  const idx = RENDERER_JS.indexOf('const scroller = grid.closest(\'.palantir-scroll\')');
  assert.ok(idx > 0, 'prune block measures the scroller');
  const block = RENDERER_JS.slice(idx - 600, idx + 700);
  assert.match(block, /heightBefore - scroller\.scrollHeight/, 'height delta measured across the prune');
  assert.match(block, /scroller\.scrollTop = Math\.max\(0, scroller\.scrollTop - delta\)/,
    'scrollTop compensated so on-screen cards stay visually fixed');
});

// ── 22: budget breakdown input methods ──────────────────────────────

test('item 22: budget breakdown opens on hover, click, and focus', () => {
  const idx = RENDERER_JS.indexOf("indicator.setAttribute('tabindex', '0')");
  assert.ok(idx > 0, 'budget indicator is focusable');
  const block = RENDERER_JS.slice(idx, idx + 2600);
  assert.match(block, /indicator\.addEventListener\('mouseenter'/, 'hover still works');
  assert.match(block, /indicator\.addEventListener\('click'/, 'click toggles');
  assert.match(block, /indicator\.addEventListener\('focus'/, 'focus opens');
  assert.match(block, /e\.stopPropagation\(\)/,
    'indicator clicks must not bubble into the perf-bar Revenue opener');
  assert.match(block, /focusOpenedAt/, 'the first touch tap must not open-then-instantly-close');
});

// ── 23: aria-live announcements ─────────────────────────────────────

test('item 23: chat status is polite and turn completion is announced off-stream', () => {
  assert.match(INDEX_HTML, /id="chat-status"[^>]*aria-live="polite"/, 'chat-status is a polite live region');
  assert.match(INDEX_HTML, /id="sr-announcer"[^>]*aria-live="polite"/, 'dedicated announcer exists');
  assert.ok(!/id="messages"[^>]*aria-live/.test(INDEX_HTML),
    'the streaming container itself must NOT be a live region (it would spam AT with every delta)');
  assert.ok(RENDERER_JS.includes("announcer.textContent = 'Merlin finished responding.'"),
    'finalizeBubble announces completion');
  assert.match(STYLE_CSS, /\.visually-hidden\{/, 'visually-hidden helper exists');
});

// ── 24: friendlyError mappings ──────────────────────────────────────

test('item 24: OAuth flow errors and safe mode map to honest copy', () => {
  assert.ok(RENDERER_JS.includes('The sign-in window timed out.\\nTry: Click the tile to try again.'),
    'OAuth authorization timeout is not misdiagnosed as an internet problem');
  assert.ok(RENDERER_JS.includes('That sign-in window was stale.\\nTry: Click the tile to try again.'),
    'state mismatch maps to plain copy');
  assert.ok(RENDERER_JS.includes("You declined the connection.\\nTry: Click the tile whenever you're ready."),
    'provider access_denied maps to calm copy');
  // Safe mode must be matched BEFORE the generic rate-limit branch: its
  // pause lasts up to 24h and resolves on its own, so "Wait 30 seconds"
  // would be a lie.
  const safeIdx = RENDERER_JS.indexOf("sl.includes('safe mode')");
  const rateIdx = RENDERER_JS.indexOf("sl.includes('rate limit')");
  assert.ok(safeIdx > 0 && rateIdx > 0 && safeIdx < rateIdx,
    'the safe-mode branch must run before the generic rate-limit branch');
  assert.ok(RENDERER_JS.includes('paused for safety after too many requests'),
    'safe-mode copy says the platform is paused and resumes automatically');
});

// ── 25: OAuth pending state + cancel ────────────────────────────────

test('item 25: clicked OAuth tiles show a waiting state with cancel', () => {
  assert.match(RENDERER_JS, /function setOAuthTileWaiting\(/, 'waiting-state helper exists');
  assert.match(RENDERER_JS, /function clearOAuthTileWaiting\(/, 'clear helper exists');
  assert.ok(RENDERER_JS.includes('Waiting for you in the browser…'), 'waiting copy present');
  assert.ok(RENDERER_JS.includes('Still waiting for you to finish the ${displayName} sign-in in your browser.'),
    're-clicks while pending get a toast instead of silence');
  assert.match(RENDERER_JS, /merlin\.cancelOAuth\?\.\(platform, activeBrand\)/,
    'cancel calls the bridge with optional chaining (main.js/preload wiring ships separately)');
  assert.match(RENDERER_JS, /_oauthFlowTokens/,
    'per-flow tokens stop a stale canceled flow from tearing down a restarted one');
  assert.ok(RENDERER_JS.includes('oauth_canceled_by_user'),
    'the cancel sentinel is suppressed instead of shown as a failure');
  assert.match(STYLE_CSS, /\.magic-tile\.oauth-waiting\{/, 'waiting tile style exists');
  assert.match(STYLE_CSS, /\.tile-cancel\{/, 'cancel affordance style exists');
});

test('item 25: oauth-fast-open exposes a cancel that settles the pending flow', () => {
  assert.match(OAUTH_FAST_OPEN_JS, /function cancelFastOpenOAuth\(platform, brand\)/,
    'cancelFastOpenOAuth exported for the (separately shipped) cancel-oauth IPC');
  assert.match(OAUTH_FAST_OPEN_JS, /OAUTH_CANCELED_SENTINEL = 'oauth_canceled_by_user'/,
    'stable sentinel for the renderer to suppress');
  assert.match(OAUTH_FAST_OPEN_JS, /_activeFlowCancels\.set\(cancelKey, cancelThisFlow\)/,
    'each flow registers its canceler');
  assert.match(OAUTH_FAST_OPEN_JS, /_activeFlowCancels\.get\(cancelKey\) === cancelThisFlow/,
    'a stale flow must not deregister a restarted flow for the same key');
  assert.match(OAUTH_FAST_OPEN_JS, /cancelFastOpenOAuth,\s*\n\s*OAUTH_CANCELED_SENTINEL,/,
    'both symbols are exported');
});

test('item 25: cancelFastOpenOAuth returns false when no flow is active', () => {
  const { cancelFastOpenOAuth } = require('./oauth-fast-open');
  assert.equal(cancelFastOpenOAuth('meta', 'nonexistent-brand'), false,
    'cancel with nothing registered is a safe no-op');
});

// ── 26: two-container streaming write ───────────────────────────────

test('item 26: streaming writes land in stream-prefix/stream-tail containers', () => {
  assert.match(RENDERER_JS, /function ensureStreamContainers\(bubble\)/, 'container helper exists');
  assert.ok(RENDERER_JS.includes("prefixEl.className = 'stream-prefix'"), 'prefix container class');
  assert.ok(RENDERER_JS.includes("tailEl.className = 'stream-tail'"), 'tail container class');
  const appendIdx = RENDERER_JS.indexOf('function appendText(text)');
  const appendEnd = RENDERER_JS.indexOf('\n}\n', appendIdx);
  const body = RENDERER_JS.slice(appendIdx, appendEnd);
  // The tail is the only unconditional per-frame write; the prefix is
  // gated on boundary advancement (or fresh containers).
  assert.match(body, /if \(els\.created \|\| prefixAdvanced\) \{\s*\n\s*els\.prefixEl\.innerHTML = prefixHtml;/,
    'prefix container written only when the boundary advances');
  assert.match(body, /els\.tailEl\.innerHTML = tailHtml;/, 'tail is the per-frame write');
  // Guard preservation: the 2026-05-03 delta-parse cache is intact.
  assert.match(body, /_streamRenderState\.prefixHtml \+ renderMarkdown\(deltaPrefix\)/,
    'the cached-prefix delta parse (2026-05-03 guard) is preserved');
  assert.match(body, /prefixHtml = _streamRenderState\.prefixHtml;\s*\n\s*tailHtml = renderMarkdown\(cleaned\.slice\(_streamRenderState\.prefixText\.length\)\)/,
    'tail-only growth reuses the cached prefix without re-parsing it');
  // Fact-binding path keeps the legacy full-bubble write.
  assert.match(body, /currentBubble\.innerHTML = _factApplyAndMount\(prefixHtml \+ tailHtml\)/,
    'fact-binding path still writes the whole bubble (it rewrites the full document)');
  // finalize flattens: full render + container refs dropped.
  const finalIdx = RENDERER_JS.indexOf('function finalizeBubble()');
  const finalBody = RENDERER_JS.slice(finalIdx, RENDERER_JS.indexOf('\n}\n', finalIdx));
  assert.match(finalBody, /delete currentBubble\._streamEls/,
    'finalizeBubble drops the container refs with the stream cache');
  assert.match(finalBody, /currentBubble\.innerHTML = renderMarkdown\(cleaned\)/,
    'finalizeBubble still does one full flat render');
  // Layout transparency + the p:last-child seam fix.
  assert.match(STYLE_CSS, /\.stream-prefix,\.stream-tail\{display:contents\}/,
    'containers are layout-transparent');
  assert.match(STYLE_CSS, /\.msg-bubble \.stream-prefix p:last-child\{margin-bottom:8px\}/,
    'the prefix/tail seam keeps the normal inter-paragraph gap mid-stream');
});
