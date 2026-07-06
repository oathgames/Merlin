// data-pipeline.test.js — REGRESSION GUARDS (2026-07-02, data-pipeline sweep)
//
// Locks the v1.32.0 data-pipeline fixes:
//  DP-1 archive-blank-thumbs: creativePath is brand-relative + Windows-backslashed;
//       every consumer must resolve through liveAdCreativeSrc, and the Go side
//       writes forward slashes (locked in Go tests).
//  DP-4 WoW report: "List Growth" tile present (renamed from List Joins 2026-07-06); "mindshare precedes revenue" line gone;
//       joined_list excluded from the funnel bars.
//  DP-5 palantir portal jitter: connection gate BEFORE the Scrying portal paint.
//  DP-6 async data warm: warmBrandData exists, covers all five windows + live ads,
//       is staleness-gated, and refresh-perf is queued main-side.
//
// Pure source-scan (renderer.js can't be require()d outside Electron).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function fnBody(src, anchor, len) {
  const i = src.indexOf(anchor);
  assert.ok(i >= 0, `anchor not found: ${anchor}`);
  return src.slice(i, i + len);
}

// ── DP-1: archive thumbnails ────────────────────────────────────────────
test('liveAdCreativeSrc normalizes backslashes and brand-qualifies cache paths', () => {
  const body = fnBody(R, 'function liveAdCreativeSrc(ad)', 900);
  assert.ok(/replace\(\/\\\\\/g, '\/'\)/.test(body), 'must convert backslashes to forward slashes');
  assert.ok(body.includes("'assets/brands/' + ad.brand + '/'"), 'must qualify brand-relative paths with assets/brands/<brand>/');
  assert.ok(/isAbsolute/.test(body), 'must NOT brand-prefix absolute paths (Merlin-pushed source images)');
  assert.ok(/^[\s\S]*\(assets\|results\)/.test(body), 'must pass through already appRoot-relative paths');
});

test('every creativePath consumer routes through liveAdCreativeSrc (no bare merlinUrl(ad.creativePath))', () => {
  assert.ok(!/merlinUrl\(ad\.creativePath\)/.test(R),
    'bare merlinUrl(ad.creativePath) is the archive-blank-thumbs regression');
  assert.ok(!/const previewSrc = ad\.creativePath \|\|/.test(R) && !/const src = ad\.creativePath \|\|/.test(R),
    'preview/context-menu consumers must use liveAdCreativeSrc too');
  // card thumb + click preview + context details = at least 3 call sites
  const uses = (R.match(/liveAdCreativeSrc\(ad\)/g) || []).length;
  assert.ok(uses >= 3, `expected >=3 liveAdCreativeSrc(ad) call sites, found ${uses}`);
});

test('archive card thumb falls back to the CDN URL before the placeholder', () => {
  assert.ok(/data-fallback-src=/.test(R), 'card img must carry data-fallback-src (Meta CDN)');
  const handler = fnBody(R, 'let triedFallback = false;', 700);
  assert.ok(/thumbImg\.src = fb/.test(handler), 'error handler must retry with the fallback src');
  assert.ok(/outerHTML = placeholderHTML/.test(handler), 'second failure lands on the placeholder');
});

// ── DP-4: WoW growth header ─────────────────────────────────────────────
test('WoW growth header has the List Growth tile and no mindshare-precedes-revenue line', () => {
  const body = fnBody(R, 'function truesightGrowthHeader(', 2200);
  assert.ok(/byKey\.joined_list/.test(body), 'joined_list stage must be a growth tile');
  assert.ok(/List Growth/.test(body), 'tile label must be "List Growth"');
  assert.ok(!/Mindshare precedes revenue/i.test(R), 'the mindshare-precedes-revenue copy line must be gone');
});

test('joined_list is excluded from the funnel bars', () => {
  const body = fnBody(R, 'function renderTruesightFunnel(', 1600);
  assert.ok(/filter\(\(s\) => s && s\.key !== 'joined_list'\)/.test(body),
    'funnel bars must filter out the header-only joined_list stage');
  assert.ok(/barStages\.forEach/.test(body), 'bar loop iterates the filtered list');
});

// ── DP-5: palantir early-exit gate ──────────────────────────────────────
test('palantir checks the TrendTrack connection BEFORE painting the Scrying portal', () => {
  const body = fnBody(R, 'async function loadPalantirIdeas(', 2600);
  const gateIdx = body.indexOf('getConnectedPlatforms');
  // 2026-07 interaction-polish pass: the `opts.reset` loading placeholder is now
  // content-shaped skeleton cards (was palantirPortalHTML('loading')). The
  // portal-jitter invariant is unchanged: the connection gate must still run
  // BEFORE any loading placeholder paints. Anchor on the `opts.reset && grid`
  // paint line, whichever placeholder it renders.
  const portalIdx = body.search(/opts\.reset && grid/);
  assert.ok(gateIdx >= 0, 'connection gate missing');
  assert.ok(portalIdx >= 0, 'loading placeholder paint missing');
  assert.ok(gateIdx < portalIdx, 'gate must run BEFORE the loading paint (portal jitter regression)');
  assert.ok(/skeleton-card/.test(body), 'the reset loading placeholder is content-shaped skeleton cards');
  assert.ok(/palantirRenderConnectState/.test(body), 'unconnected path renders the connect state directly');
  // The gate must not wedge the panel: raced with a timeout, loading flag released.
  assert.ok(/conn-gate-timeout/.test(body), 'gate must be raced with a timeout');
  assert.ok(/palantirIdeasLoading = false;[\s\S]{0,120}palantirRenderConnectState/.test(body),
    'early-exit must release the loading latch');
});

// ── DP-6: async data warm ───────────────────────────────────────────────
test('warmBrandData covers all five perf windows plus live ads, staleness-gated', () => {
  const body = fnBody(R, 'async function warmBrandData(', 2600);
  assert.ok(/PERF_WARM_WINDOWS/.test(body), 'iterates the shared window list');
  assert.ok(/\[1, 7, 30, 90, 365\]/.test(R), 'window list must be 1/7/30/90/365');
  assert.ok(/refreshLiveAds\(target\)/.test(body), 'warms live ads (feeds Wisdom continuously)');
  assert.ok(/WARM_FRESH_MS/.test(body), 'staleness gate present');
  assert.ok(/brandChanged\(\)/.test(body), 'aborts when the user switches brands mid-warm');
});

test('warmBrandData fires on launch, on brand switch, and on the 4h cycle', () => {
  const calls = (R.match(/warmBrandData\(/g) || []).length;
  // definition + >=3 call sites
  assert.ok(calls >= 4, `expected warmBrandData wired at launch/switch/interval, found ${calls} refs`);
});

test('main-side refresh-perf is queued (dedup + serial chain)', () => {
  assert.ok(/function queueRefreshPerf\(/.test(MAIN), 'queueRefreshPerf must exist');
  assert.ok(/_perfRefreshInflight/.test(MAIN), 'per-(brand,days) in-flight dedup map');
  assert.ok(/_perfRefreshChain/.test(MAIN), 'serial chain so binary runs never overlap');
  assert.ok(/ipcMain\.handle\('refresh-perf', \(_, brandName, days\) => queueRefreshPerf\(brandName, days\)\)/.test(MAIN),
    'the IPC handler must route through the queue');
});
