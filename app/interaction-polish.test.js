// interaction-polish.test.js: LOCK for the Tier-2 interaction-polish pass
// (2026-07, design-polish session). Source-scan against renderer.js (the
// renderer can't be exercised without an Electron BrowserWindow + preload, so
// these pin structure the same way ws-server.test.js / pin-sidebar.test.js do).
//
// What it locks:
//   1. Shared takeover enter/exit helpers (openTakeover / closeTakeover) exist
//      and the six full-window surfaces route their visibility through them (or
//      the magic-slide variant), no bare classList.remove/add('hidden') left
//      for those panel ids.
//   2. Content-shaped skeletons (.skeleton-card / .skeleton-bar) in the
//      archive / palantir / wisdom / truesight loading paths.
//   3. Staggered arrival (revealGrid + .reveal-item) on grid rebuilds.
//   4. The scroll-bottom BUTTON uses behavior:'smooth' (streaming auto-follow
//      stays instant).
//   5. Truesight funnel draw (bars start at width:0, real width applied on rAF).
//   6. Single showToast() helper (the four hand-rolled toast blobs collapsed).
//
// Run with: node --test app/interaction-polish.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_JS = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

// The six full-window takeover surfaces this pass animates.
const TAKEOVER_IDS = [
  'brand-switcher-overlay',
  'wisdom-overlay',
  'palantir-panel',
  'truesight-panel',
  'archive-panel',
  'magic-panel',
];

// ── 1. Shared takeover enter/exit helpers ──────────────────────────────────

test('openTakeover / closeTakeover helpers are defined', () => {
  assert.match(RENDERER_JS, /function\s+openTakeover\s*\(\s*el\s*\)/,
    'openTakeover(el) must exist');
  assert.match(RENDERER_JS, /function\s+closeTakeover\s*\(\s*el\s*\)/,
    'closeTakeover(el) must exist');
  // openTakeover gates the .open flip on a double rAF after removing .hidden so
  // the resting frame paints before the transition runs.
  // Window 400 -> 1000 (2026-07-11): openTakeover now also cancels a
  // still-pending close (timer + transitionend) before reopening.
  const idx = RENDERER_JS.indexOf('function openTakeover');
  const fn = RENDERER_JS.slice(idx, idx + 1000);
  assert.match(fn, /classList\.add\(['"]takeover-anim['"]\)/, 'adds the takeover-anim transition class');
  assert.match(fn, /classList\.remove\(['"]hidden['"]\)/, 'removes hidden to render the element');
  assert.match(fn, /requestAnimationFrame\([\s\S]*?requestAnimationFrame/, 'double-rAF gate before adding .open');
  assert.match(fn, /classList\.add\(['"]open['"]\)/, 'flips .open to trigger the transition');
  // 2026-07-11: a fast close-then-reopen must not be re-hidden by the stale
  // close's 260ms fallback timer (or its late transitionend listener).
  assert.match(fn, /clearTimeout\(el\._takeoverCloseTimer\)/, 'openTakeover cancels a pending close timer');
  assert.match(fn, /removeEventListener\(['"]transitionend['"],\s*el\._takeoverCloseDone\)/,
    'openTakeover detaches the pending close transitionend listener');
});

test('closeTakeover adds hidden only after the exit transition', () => {
  // Window 500 -> 1400 (2026-07-11): the fallback timer is now stashed on
  // the element so openTakeover can cancel it.
  const idx = RENDERER_JS.indexOf('function closeTakeover');
  const fn = RENDERER_JS.slice(idx, idx + 1400);
  assert.match(fn, /classList\.remove\(['"]open['"]\)/, 'removes .open to start the exit transition');
  assert.match(fn, /transitionend/, 'waits for transitionend before hiding');
  assert.match(fn, /classList\.add\(['"]hidden['"]\)/, 'ends in the hidden resting state');
  assert.match(fn, /setTimeout\(/, 'has a fallback timer in case transitionend never fires');
  assert.match(fn, /el\._takeoverCloseTimer\s*=\s*setTimeout\(/,
    'the fallback timer is stashed on the element for cancellation by openTakeover');
});

test('magic slide helpers make the authored translateX transition play', () => {
  assert.match(RENDERER_JS, /function\s+openMagicSlide\s*\(/, 'openMagicSlide exists');
  assert.match(RENDERER_JS, /function\s+closeMagicSlide\s*\(/, 'closeMagicSlide exists');
  const idx = RENDERER_JS.indexOf('function openMagicSlide');
  const fn = RENDERER_JS.slice(idx, idx + 400);
  // Force translateX(100%) for one painted frame, then clear so the CSS
  // :not(.hidden) rule (translateX(0)) transitions in.
  assert.match(fn, /translateX\(100%\)/, 'forces an off-screen start frame');
  assert.match(fn, /requestAnimationFrame\([\s\S]*?requestAnimationFrame/, 'clears the inline transform on the next frame');
});

test('the six takeover surfaces route visibility through the motion helpers', () => {
  // No literal `getElementById('<panel-id>').classList.{add,remove,toggle}('hidden')`
  // may remain for any of the six surfaces (or the revenue/stats overlay):
  // every open/close goes through openTakeover/closeTakeover/openMagicSlide/
  // closeMagicSlide. Read-only `.contains('hidden')` checks are still allowed.
  const offenders = [];
  for (const id of [...TAKEOVER_IDS, 'stats-overlay']) {
    const re = new RegExp(
      `getElementById\\(['"]${id}['"]\\)\\??\\.classList\\.(add|remove|toggle)\\(['"]hidden['"]\\)`,
      'g',
    );
    const m = RENDERER_JS.match(re);
    if (m) offenders.push(`${id}: ${m.join(', ')}`);
  }
  assert.deepStrictEqual(offenders, [],
    'these surfaces must toggle visibility via openTakeover/closeTakeover (or the magic-slide variant), not a bare classList hidden toggle:\n  ' + offenders.join('\n  '));
});

test('each takeover opener/closer actually references a motion helper', () => {
  // openBrandSwitcher / closeBrandSwitcher / closeWisdom and the palantir /
  // truesight / archive / magic handlers must mention one of the four helpers.
  for (const anchor of ['function openBrandSwitcher', 'function closeBrandSwitcher', 'function closeWisdom', 'function hideSidebarPanel']) {
    const idx = RENDERER_JS.indexOf(anchor);
    assert.ok(idx > 0, `${anchor} must exist`);
    const fn = RENDERER_JS.slice(idx, idx + 600);
    assert.match(fn, /openTakeover\(|closeTakeover\(|openMagicSlide\(|closeMagicSlide\(/,
      `${anchor} must route through a takeover-motion helper`);
  }
});

// ── 2. Content-shaped skeletons ─────────────────────────────────────────────

test('archive loading path renders skeleton cards', () => {
  const idx = RENDERER_JS.indexOf('async function loadArchive');
  // Slice to the START OF THE NEXT top-level function instead of a fixed
  // character window. loadArchive opens with several long regression-guard
  // comment blocks before the loading branch, and on 2026-07-23 a newly-added
  // block pushed the skeleton render past the old hard-coded 5000-char window
  // so the test failed while the behavior was perfectly correct. Anchoring on
  // the function boundary keeps this assertion honest as the comments grow.
  const next = RENDERER_JS.indexOf('\nfunction ', idx);
  const fn = RENDERER_JS.slice(idx, next > idx ? next : idx + 12000);
  assert.match(fn, /skeleton-card/, 'archive loading path renders .skeleton-card placeholders');
});

test('palantir wall loading path renders skeleton cards', () => {
  const idx = RENDERER_JS.indexOf('async function loadPalantirIdeas');
  const fn = RENDERER_JS.slice(idx, idx + 2400);
  assert.match(fn, /skeleton-card/, 'palantir loading path renders .skeleton-card placeholders');
});

test('wisdom loading path renders skeleton cards', () => {
  const idx = RENDERER_JS.indexOf('async function loadWisdom');
  const fn = RENDERER_JS.slice(idx, idx + 600);
  assert.match(fn, /skeleton-card/, 'wisdom loading path renders .skeleton-card placeholders');
});

test('truesight loading path renders skeleton bars in the funnel', () => {
  const idx = RENDERER_JS.indexOf('function showTruesightLoading');
  const fn = RENDERER_JS.slice(idx, idx + 1100);
  assert.match(fn, /skeleton-bar/, 'truesight loading path renders .skeleton-bar placeholders');
  assert.match(fn, /Reading your funnel/, 'keeps the "Reading your funnel…" status');
});

// ── 3. Staggered arrival ────────────────────────────────────────────────────

test('revealGrid helper exists and stages children with capped delay', () => {
  assert.match(RENDERER_JS, /function\s+revealGrid\s*\(/, 'revealGrid(gridEl) must exist');
  const idx = RENDERER_JS.indexOf('function revealGrid');
  const fn = RENDERER_JS.slice(idx, idx + 500);
  assert.match(fn, /reveal-item/, 'adds the reveal-item fadeUp class');
  assert.match(fn, /animationDelay/, 'sets a per-child animation-delay');
  assert.match(fn, /Math\.min\(/, 'caps the stagger delay');
});

test('grid rebuild sites apply revealGrid', () => {
  // Brand switcher, palantir wall, wisdom grid, and the archive first batch.
  const count = (RENDERER_JS.match(/revealGrid\(/g) || []).length;
  assert.ok(count >= 4, `revealGrid must be applied at multiple rebuild sites (found ${count})`);
});

// ── 4. Smooth jump-to-bottom (button only) ──────────────────────────────────

test('scroll-bottom button click uses behavior:smooth', () => {
  const idx = RENDERER_JS.indexOf("scrollBtn.addEventListener('click'");
  assert.ok(idx > 0, 'scroll-bottom button click handler must exist');
  const fn = RENDERER_JS.slice(idx, idx + 500);
  assert.match(fn, /behavior:\s*['"]smooth['"]/, 'explicit button click scrolls smoothly');
});

test('streaming auto-follow scrollToBottom stays instant (no smooth)', () => {
  const idx = RENDERER_JS.indexOf('function scrollToBottom');
  const fn = RENDERER_JS.slice(idx, idx + 400);
  assert.ok(!/behavior:\s*['"]smooth['"]/.test(fn),
    'scrollToBottom (auto-follow during streaming) must NOT use smooth; it would fight every token tick');
});

// ── 5. Truesight funnel draw ─────────────────────────────────────────────────

test('truesight bars start at width:0 and animate to their target width', () => {
  const idx = RENDERER_JS.indexOf('function renderTruesightFunnel');
  const fn = RENDERER_JS.slice(idx, idx + 5200);
  assert.match(fn, /width:0%/, 'bars are built at width:0');
  assert.match(fn, /data-tw=/, 'target width is stashed in data-tw');
  assert.match(fn, /requestAnimationFrame\([\s\S]{0,200}data-tw/,
    'a rAF after innerHTML applies the real widths so the funnel draws itself');
});

// ── 6. Toast consolidation ───────────────────────────────────────────────────

test('showToast is the single toast helper', () => {
  assert.match(RENDERER_JS, /function\s+showToast\s*\(\s*msg\s*,\s*opts/,
    'showToast(msg, opts) must exist as the single helper');
  const idx = RENDERER_JS.indexOf('function showToast');
  const fn = RENDERER_JS.slice(idx, idx + 1600);
  assert.match(fn, /spell-toast-(success|error|info)/, 'maps variant to the existing spell-toast border tokens');
});

test('the four legacy toast blobs route through showToast', () => {
  // The engine-status, bypass-blocked, post-crash, and referral-auto toasts
  // each call showToast now (identified by their id: option).
  for (const id of ['engine-toast', 'bypass-toast', 'post-crash-toast', 'referral-auto-toast']) {
    const re = new RegExp(`showToast\\([\\s\\S]{0,400}id:\\s*['"]${id}['"]`);
    assert.match(RENDERER_JS, re, `${id} must be produced via showToast`);
  }
  // The old hand-rolled per-toast cssText positioning blobs must be gone.
  assert.ok(!/_engineToast\s*=\s*document\.createElement/.test(RENDERER_JS),
    'the hand-rolled _engineToast element blob must be gone (consolidated into showToast)');
});

// ── 7. Full-height titlebar buttons + off-screen render skipping ──────────
//
// (2026-07-23, perf-polish session.) Two locks, both in style.css:
//
//   A. Fitts's Law on the titlebar. The icon buttons were 28x28 chips floating
//      in a 40px bar with 4px margins, so the click target was a small island
//      ringed by dead titlebar. Windows solved this decades ago: titlebar
//      buttons run the FULL height of the bar. .win-ctrl already did; the icon
//      buttons now match, which also removes every dead gap between them.
//
//   B. content-visibility on .archive-card. The archive renders 300 cards
//      synchronously and thousands more on idle chunks; without containment
//      the browser lays out and paints every off-screen card on every reflow.
const STYLE_CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');

// Return the body of the first rule whose selector list ENDS with `selector`
// immediately before the `{`. Tolerates `sel{` and `sel  {`, and the trailing
// anchor stops `.archive-card` from matching `.archive-card-delete`.
function cssRule(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(esc + '\\s*\\{([^}]*)\\}').exec(css);
  return m ? m[1] : '';
}

test('titlebar icon buttons are full-height with no dead gaps (Fitts\'s Law)', () => {
  const magic = cssRule(STYLE_CSS, '.magic-btn-inline');
  assert.ok(magic, '.magic-btn-inline rule must exist');
  assert.match(magic, /height:100%/,
    '.magic-btn-inline must be full titlebar height: a short chip in a tall bar is a small target ringed by dead space');
  assert.match(magic, /margin-right:0/,
    '.magic-btn-inline must not re-introduce margins; gaps between full-height buttons are unclickable dead zones');
  assert.doesNotMatch(magic, /height:28px/,
    '.magic-btn-inline must not revert to the fixed 28px chip height');

  const theme = cssRule(STYLE_CSS, '.theme-toggle');
  assert.ok(theme, '.theme-toggle rule must exist');
  assert.match(theme, /height:100%/,
    '.theme-toggle must match its full-height neighbours');
  assert.match(theme, /margin-right:0/,
    '.theme-toggle must not re-introduce a margin gap');
});

test('titlebar icon buttons match the window controls height contract', () => {
  // .win-ctrl (min/max/close) has been height:100% forever. The icon buttons
  // must use the SAME contract so the titlebar reads as one coherent row
  // rather than chips-next-to-slabs.
  const win = cssRule(STYLE_CSS, '.win-ctrl');
  assert.match(win, /height:100%/, '.win-ctrl is the height reference and must stay full-height');
});

test('archive cards skip layout + paint while off-screen', () => {
  const card = cssRule(STYLE_CSS, '.archive-card');
  assert.ok(card, '.archive-card rule must exist');
  assert.match(card, /content-visibility:\s*auto/,
    '.archive-card must keep content-visibility:auto; without it every off-screen card in a thousands-of-assets grid is laid out and painted on each reflow');
  assert.match(card, /contain-intrinsic-size:\s*auto\s+\d+px/,
    '.archive-card must declare contain-intrinsic-size with the `auto` keyword so skipped cards still reserve honest scroll height and remember their real size once seen');
});

// ── 8. Full-height controls in the perf bar ──────────────────────────────
//
// (2026-07-23.) The perf bar itself is clickable: clicking it opens the
// Revenue overlay. So every pixel inside a control's column that belongs to
// the bar instead of the control is a misclick trap. Measured before the fix,
// the bar was 31px tall but the period buttons were 14px, leaving an 8px dead
// strip above and 9px below: aiming at "7D" and landing 2px high opened the
// summary window. The controls now stretch to fill the bar, so a near-miss
// hits the control the user aimed at.
//
// After the fix (measured in a real render): bar 31px, every period button and
// the brand switcher 30px tall, 0px dead strip above, and the only pixel below
// is the bar's own 1px border.

test('the perf bar stretches its controls to full height', () => {
  const bar = cssRule(STYLE_CSS, '.perf-bar');
  assert.ok(bar, '.perf-bar rule must exist');
  assert.match(bar, /align-items:\s*stretch/,
    '.perf-bar must stretch its children; align-items:center leaves clickable bar above and below each control');
  assert.match(bar, /min-height:\s*\d+px/,
    '.perf-bar must use min-height (not a hard height) so it keeps its size but can still grow if the perf text wraps');
  assert.doesNotMatch(bar, /padding:\s*\d*[1-9]\d*px\s+\d+px/,
    '.perf-bar must not re-introduce VERTICAL padding: that padding is exactly the dead strip that opens the Revenue overlay on a near-miss');

  const content = cssRule(STYLE_CSS, '.perf-bar-content');
  assert.match(content, /align-items:\s*stretch/,
    '.perf-bar-content must stretch its children too');
});

test('perf-bar controls declare full-height stretch', () => {
  const group = cssRule(STYLE_CSS, '.perf-period-group');
  assert.match(group, /align-self:\s*stretch/,
    '.perf-period-group must stretch to the full bar height');
  assert.match(group, /border-radius:\s*0/,
    '.perf-period-group must square its corners; rounded corners in a full-height control leave bar-surface notches that open the overlay');

  const brand = cssRule(STYLE_CSS, '.brand-switcher-btn');
  assert.match(brand, /align-self:\s*stretch/,
    '.brand-switcher-btn must stretch to the full bar height');
  assert.match(brand, /border-radius:\s*0/,
    '.brand-switcher-btn must square its corners for the same reason');
});

test('the perf-bar click guard still exempts every in-bar control', () => {
  // The overlay opener must keep bailing out for clicks that belong to a
  // control. Full-height controls shrink the trap; this guard is what stops a
  // real hit on a control from ALSO opening the overlay via bubbling.
  const idx = RENDERER_JS.indexOf("getElementById('perf-bar').addEventListener('click'");
  assert.ok(idx > 0, 'the perf-bar click handler must exist');
  const fn = RENDERER_JS.slice(idx, idx + 900);
  for (const sel of ['.perf-period-group', '#brand-switcher-btn']) {
    assert.ok(fn.includes(sel),
      `the perf-bar click handler must exempt ${sel} so activating it does not also open the Revenue overlay`);
  }
});
