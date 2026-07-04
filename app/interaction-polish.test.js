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
  const idx = RENDERER_JS.indexOf('function openTakeover');
  const fn = RENDERER_JS.slice(idx, idx + 400);
  assert.match(fn, /classList\.add\(['"]takeover-anim['"]\)/, 'adds the takeover-anim transition class');
  assert.match(fn, /classList\.remove\(['"]hidden['"]\)/, 'removes hidden to render the element');
  assert.match(fn, /requestAnimationFrame\([\s\S]*?requestAnimationFrame/, 'double-rAF gate before adding .open');
  assert.match(fn, /classList\.add\(['"]open['"]\)/, 'flips .open to trigger the transition');
});

test('closeTakeover adds hidden only after the exit transition', () => {
  const idx = RENDERER_JS.indexOf('function closeTakeover');
  const fn = RENDERER_JS.slice(idx, idx + 500);
  assert.match(fn, /classList\.remove\(['"]open['"]\)/, 'removes .open to start the exit transition');
  assert.match(fn, /transitionend/, 'waits for transitionend before hiding');
  assert.match(fn, /classList\.add\(['"]hidden['"]\)/, 'ends in the hidden resting state');
  assert.match(fn, /setTimeout\(/, 'has a fallback timer in case transitionend never fires');
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
  // Wide slice: loadArchive opens with several long regression-guard comment
  // blocks before the loading branch where the skeletons render.
  const fn = RENDERER_JS.slice(idx, idx + 5000);
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
