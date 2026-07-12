// cross-brand-config-scope.test.js — REGRESSION GUARD (2026-06-30, cross-brand leak sweep)
//
// Locks the class of leak first documented by the 2026-04-15 codex per-brand
// revenue audit (finding #2) and re-found across the whole app in the v1.31.x
// reliability sweep: any binary invocation or per-brand index that names a brand
// but resolves its config through readBrandConfig (global ⊕ brand overlay) leaks
// the global config's plain legacy creds + non-sensitive BRAND_KEYS
// (metaAdAccountId, shopifyStore, …) into EVERY brand. buildStrictBrandConfig is
// the ONLY safe resolver for a brand-scoped binary call — it strips all
// BRAND_KEYS from the global base and overlays only the brand's own creds.
//
// Pure source-scan (no Electron boot).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const MCP = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');

function sliceAround(hay, needle, before, after) {
  const i = hay.indexOf(needle);
  assert.ok(i >= 0, `anchor not found: ${needle}`);
  return hay.slice(Math.max(0, i - before), i + after);
}

// ── The MCP tool surface (runBinary) ────────────────────────────────────
test('mcpCtx exports buildStrictBrandConfig so the MCP layer can resolve strict', () => {
  // The ctx object handed to createMerlinMcpServer must carry buildStrictBrandConfig.
  const ctxBlock = sliceAround(MAIN, 'const mcpCtx = {', 0, 800);
  assert.ok(/buildStrictBrandConfig,/.test(ctxBlock),
    'mcpCtx must export buildStrictBrandConfig (runBinary keys on it)');
});

test('runBinary resolves a named brand via buildStrictBrandConfig, never readBrandConfig', () => {
  const i = MCP.indexOf('const brandName = args.brand');
  assert.ok(i >= 0, 'runBinary brand resolution anchor not found');
  const block = MCP.slice(i, i + 400);
  assert.ok(/ctx\.buildStrictBrandConfig/.test(block),
    'runBinary must prefer ctx.buildStrictBrandConfig for a named brand');
  // The only readBrandConfig allowed here is the test-context fallback ternary.
  assert.ok(/buildStrictBrandConfig[\s\S]*?ctx\.readBrandConfig/.test(block),
    'readBrandConfig may appear ONLY as the strict-preferred fallback, after buildStrictBrandConfig');
});

// ── The three brand-scoped binary handlers ──────────────────────────────
test('refresh-live-ads resolves config via buildStrictBrandConfig', () => {
  const block = sliceAround(MAIN, "ipcMain.handle('refresh-live-ads'", 0, 1400);
  assert.ok(/buildStrictBrandConfig\(brandName\)/.test(block),
    'refresh-live-ads must strict-scope (ads-live.json feeds budget caps)');
  assert.ok(!/readBrandConfig\(brandName\)/.test(block),
    'refresh-live-ads must NOT use readBrandConfig');
});

test('token watchdog resolves each brand config via buildStrictBrandConfig', () => {
  // The watchdog loop lives near the watchdog-check cmd construction.
  const block = sliceAround(MAIN, "action: 'watchdog-check'", 900, 200);
  assert.ok(/buildStrictBrandConfig\(brand\)/.test(block),
    'watchdog must strict-scope so it never renews Brand A token under Brand B');
  assert.ok(!/readBrandConfig\(brand\)/.test(block),
    'watchdog must NOT use readBrandConfig');
});

test('brands-index hasShopify/hasMeta computed per-brand via buildStrictBrandConfig', () => {
  const block = sliceAround(MAIN, 'hasShopify:', 400, 200);
  assert.ok(/buildStrictBrandConfig\(b\.name\)/.test(block),
    'brands-index flags must be per-brand strict, not off the global readConfig()');
  assert.ok(!/const cfg = readConfig\(\);[\s\S]{0,120}hasShopify/.test(block),
    'brands-index must NOT derive hasShopify/hasMeta from the global config');
});

// ── The dead get-decrypted-config-path leak primitive ───────────────────
// Removed in the 2026-07 audit: the handler had no preload bridge and no
// invoker, and materializing resolved brand secrets into a temp file is a
// leak primitive one refactor away from being wired back. The strongest
// guard is absence. If a future feature genuinely needs this, see the
// removal comment in main.js for the two mandatory hardenings.
test('get-decrypted-config-path handler stays removed', () => {
  assert.ok(!MAIN.includes("ipcMain.handle('get-decrypted-config-path'"),
    'get-decrypted-config-path leak primitive must stay deleted (2026-07 audit)');
});

// ── The removed cross-brand .merlin-stats cache ─────────────────────────
test('the action-keyed .merlin-stats cross-brand cache is fully removed', () => {
  assert.ok(!MAIN.includes('function cacheDashboardData'),
    'cacheDashboardData (cross-brand action-keyed write path) must be deleted');
  assert.ok(!MAIN.includes("ipcMain.handle('get-stats-cache'"),
    'get-stats-cache handler must be deleted');
  assert.ok(!/const statsFile\s*=/.test(MAIN),
    'the statsFile path must be gone');
  // Check the bridge PROPERTY (`getStatsCache:`), not the bare word — the removal
  // comment intentionally names the identifier for documentation.
  assert.ok(!/getStatsCache\s*:/.test(PRELOAD),
    'getStatsCache preload bridge property must be removed');
});
