// Tests for RSI §5 memory-bound tasks (Cluster-L, group 5).
//
// Covers:
//   5.1 — LRU-bounded dashboardFileCache at 64 entries.
//   5.4 — briefingLastNotified prune on file-missing OR date > 14d.
//   5.7 — computePerfSummary filters dashboard files older than 60d.
//   5.8 — readConfig mtime cache + 15-min sweep of
//          .merlin-config-tmp-*.json older than 24h.
//
// Source-scan + one real LRU simulation.
//
// Run with: node --test app/memory-bounds.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// ─── §5.1 ────────────────────────────────────────────────────────────
test('5.1 — dashboardFileCache is bounded to DASHBOARD_CACHE_MAX = 64', () => {
  assert.ok(
    /const\s+DASHBOARD_CACHE_MAX\s*=\s*64\s*;/.test(MAIN_JS),
    'DASHBOARD_CACHE_MAX constant is exactly 64',
  );
  // The LRU touch helper must re-insert on hit (keeps hot keys at tail)
  // and evict the oldest when over the cap.
  assert.ok(
    MAIN_JS.includes('function _touchDashboardCache'),
    '_touchDashboardCache helper defined',
  );
  const fnStart = MAIN_JS.indexOf('function _touchDashboardCache');
  const fnEnd = MAIN_JS.indexOf('\nasync function readDashboardJson', fnStart);
  const body = MAIN_JS.slice(fnStart, fnEnd);
  assert.ok(body.includes('dashboardFileCache.delete(key)'), 'delete-before-set (LRU bump)');
  assert.ok(
    body.includes('dashboardFileCache.size > DASHBOARD_CACHE_MAX'),
    'evicts when over the cap',
  );
  assert.ok(
    body.includes('dashboardFileCache.keys().next().value'),
    'evicts the oldest (insertion-order head)',
  );
});

test('5.1 — readDashboardJson touches cache on hit AND miss', () => {
  const fnStart = MAIN_JS.indexOf('async function readDashboardJson');
  const fnEnd = MAIN_JS.indexOf('\nasync function computePerfSummary', fnStart);
  const body = MAIN_JS.slice(fnStart, fnEnd);
  // Hit branch must call _touchDashboardCache to bump recency.
  assert.ok(
    /mtimeMs === st\.mtimeMs[\s\S]*?_touchDashboardCache\(fullPath/.test(body),
    'cache hit bumps recency via _touchDashboardCache',
  );
  // Miss branch must also use the helper (not direct .set).
  assert.ok(
    /_touchDashboardCache\(fullPath,\s*\{\s*mtimeMs:/.test(body),
    'cache miss goes through _touchDashboardCache',
  );
  // Direct .set calls bypass the eviction loop and would re-introduce
  // unbounded growth. Regression guard.
  const codeOnly = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(
    !/dashboardFileCache\.set\(/.test(codeOnly),
    'no direct .set() in readDashboardJson (must go through helper)',
  );
});

test('5.1 — LRU eviction simulation: exceeding cap evicts oldest', () => {
  // Extract helper + cache declaration as a standalone snippet.
  const declStart = MAIN_JS.indexOf('const DASHBOARD_CACHE_MAX = 64;');
  const helperEnd = MAIN_JS.indexOf('async function readDashboardJson', declStart);
  const snippet = MAIN_JS.slice(declStart, helperEnd);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${snippet}\nreturn { cache: dashboardFileCache, touch: _touchDashboardCache, MAX: DASHBOARD_CACHE_MAX };`);
  const { cache, touch, MAX } = factory();

  // Fill to MAX + 5 — eviction should trim to MAX.
  for (let i = 0; i < MAX + 5; i++) touch(`k${i}`, { v: i });
  assert.equal(cache.size, MAX, 'cache capped at MAX');
  // The first 5 keys should be evicted; the last MAX keys present.
  for (let i = 0; i < 5; i++) assert.equal(cache.has(`k${i}`), false, `k${i} evicted`);
  for (let i = 5; i < MAX + 5; i++) assert.equal(cache.has(`k${i}`), true, `k${i} retained`);

  // Touch k5 — it should move to the tail, so next eviction takes k6.
  touch('k5', { v: 5, bumped: true });
  touch('k999', { v: 999 }); // triggers eviction
  assert.equal(cache.has('k5'), true, 'k5 survived after bump');
  assert.equal(cache.has('k6'), false, 'k6 evicted (now oldest)');
});

// ─── §5.4 ────────────────────────────────────────────────────────────
test('5.4 — pruneBriefingLastNotified drops missing files and 14d+ entries', () => {
  assert.ok(
    MAIN_JS.includes('function pruneBriefingLastNotified()'),
    'pruneBriefingLastNotified defined',
  );
  const fnStart = MAIN_JS.indexOf('function pruneBriefingLastNotified()');
  const fnEnd = MAIN_JS.indexOf('\nfunction startBriefingNotifier', fnStart);
  const body = MAIN_JS.slice(fnStart, fnEnd);
  // 14 days = 14 * 24 * 60 * 60 * 1000 ms
  assert.ok(
    /14\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(body),
    '14-day cutoff applied',
  );
  assert.ok(body.includes('!fs.existsSync(full)'), 'missing-file drop branch');
  assert.ok(body.includes('briefingLastNotified.delete(full)'), 'actually deletes');
});

test('5.4 — prune runs on cold-start seed AND after each notify', () => {
  // Cold-start seed path: startBriefingNotifier calls pruneBriefingLastNotified
  // after seeding.
  const seedStart = MAIN_JS.indexOf('function startBriefingNotifier()');
  const seedEnd = MAIN_JS.indexOf('function maybeNotifyBriefing(', seedStart);
  const seedBody = MAIN_JS.slice(seedStart, seedEnd);
  assert.ok(
    seedBody.includes('pruneBriefingLastNotified();'),
    'prune invoked after cold-start seed',
  );
  // The watch-callback path also prunes after each maybeNotifyBriefing.
  const debIdx = seedBody.indexOf('maybeNotifyBriefing(full);');
  const pruneIdx = seedBody.indexOf('pruneBriefingLastNotified();', debIdx);
  assert.ok(pruneIdx > debIdx, 'prune invoked in watch callback after notify');
});

// ─── §5.7 ────────────────────────────────────────────────────────────
test('5.7 — computePerfSummary skips dashboard files older than 60 days', () => {
  const fnStart = MAIN_JS.indexOf('async function computePerfSummary(');
  const fnEnd = MAIN_JS.indexOf('\nipcMain.handle(\'get-perf-summary\'', fnStart);
  const body = MAIN_JS.slice(fnStart, fnEnd);
  // 60d cutoff
  assert.ok(
    /60\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(body),
    '60-day mtime cutoff present',
  );
  assert.ok(
    body.includes('mtimeCutoffMs'),
    'mtimeCutoffMs variable used in filter',
  );
  // Filter must happen BEFORE the parsed list is built — otherwise we
  // pay the parse cost just to throw away the result. Anchor on the
  // `st.mtimeMs < mtimeCutoffMs` guard.
  const filterIdx = body.indexOf('st.mtimeMs < mtimeCutoffMs');
  const parseIdx = body.indexOf('readDashboardJson');
  assert.ok(filterIdx > 0 && filterIdx < parseIdx, 'mtime filter precedes parse');
});

// ─── §5.8 ────────────────────────────────────────────────────────────
test('5.8 — readConfig is mtime-cached (same mtime+size → no re-parse)', () => {
  const fnStart = MAIN_JS.indexOf('function readConfig()');
  const fnEnd = MAIN_JS.indexOf('\nlet _configLock', fnStart);
  const body = MAIN_JS.slice(fnStart, fnEnd);
  assert.ok(body.includes('fs.statSync(configPath)'), 'stats the config file');
  assert.ok(
    /_readConfigCache\.mtimeMs\s*===\s*st\.mtimeMs/.test(body),
    'compares cached mtime vs stat mtime',
  );
  assert.ok(
    /_readConfigCache\.size\s*===\s*st\.size/.test(body),
    'size is a second cache-key signal (SMB/USB mtime resolution)',
  );
  // The cache MUST NOT be populated with {} on a stat failure — that
  // would prevent a later successful read from ever recovering.
  assert.ok(
    !/return\s*\{\}\s*;[\s\S]*?_readConfigCache\s*=\s*\{/.test(body),
    'empty {} on failure is NOT cached',
  );
});

test('5.8 — writeConfig invalidates the readConfig cache', () => {
  const fnStart = MAIN_JS.indexOf('function writeConfig(cfg)');
  const fnEnd = MAIN_JS.indexOf('\n// §3.10', fnStart) > 0
    ? MAIN_JS.indexOf('\n// §3.10', fnStart)
    : MAIN_JS.indexOf('\n// §5.8', fnStart);
  const body = MAIN_JS.slice(fnStart, fnEnd);
  assert.ok(
    body.includes('_invalidateReadConfigCache()'),
    'writeConfig calls _invalidateReadConfigCache',
  );
});

test('5.8 — orphaned .merlin-config-tmp-*.json files older than 24h are swept', () => {
  const fnStart = MAIN_JS.indexOf('function _maybeSweepConfigTmp(');
  const fnEnd = MAIN_JS.indexOf('\nfunction readConfig()', fnStart);
  const body = MAIN_JS.slice(fnStart, fnEnd);
  assert.ok(
    /24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(body),
    '24h cutoff applied',
  );
  // The sweep is debounced to 15min — prevents every readConfig call
  // from doing a full readdir.
  assert.ok(
    /15\s*\*\s*60\s*\*\s*1000/.test(body),
    '15-minute debounce present',
  );
  // Both the newer (.merlin-config-tmp-*.json) and legacy
  // (merlin-config.json.tmp) shapes must be matched.
  assert.ok(
    /\^\\\.merlin-config-tmp-\.\*\\\.json\$/.test(body),
    'matches new-style tmp files',
  );
  assert.ok(
    body.includes("'merlin-config.json.tmp'"),
    'matches legacy in-place tmp filename',
  );
});
