// Tests pinning App-Store-compliant Shopify behavior in the renderer +
// preload + main + oauth-fast-open. App Store requirement 2.3.1
// prohibits any UI flow that asks for a .myshopify.com URL or shop's
// domain; requirement 1.1.12 forbids requiring a desktop app to
// function.
//
// REGRESSION GUARD (2026-04-25, App Store review unblock):
// These source-scans pin the new flow's invariants. A future change
// that re-introduces a URL-entry modal, a localhost listener for
// Shopify, or a "Use my API key" Shopify path will fail loudly here.
//
// Run with: node --test shopify-app-review.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const HERE = __dirname;
const RENDERER_JS = readFileSync(join(HERE, 'renderer.js'), 'utf8');
const MAIN_JS = readFileSync(join(HERE, 'main.js'), 'utf8');
const PRELOAD_JS = readFileSync(join(HERE, 'preload.js'), 'utf8');
const FAST_OPEN_JS = readFileSync(join(HERE, 'oauth-fast-open.js'), 'utf8');
const PROVIDER_CONFIG = readFileSync(join(HERE, 'oauth-provider-config.js'), 'utf8');

// ─── 2.3.1: no manual store-URL entry ──────────────────────────────────

test('renderer: no "your-store.myshopify.com" placeholder anywhere', () => {
  // The placeholder string itself is an App Store rejection ground.
  // Any reappearance of this text — even in a comment — should be
  // reviewed before shipping; let CI flag it.
  assert.equal(
    RENDERER_JS.includes('your-store.myshopify.com'),
    false,
    'renderer.js must not contain the "your-store.myshopify.com" placeholder string',
  );
});

test('renderer: no modal asks for a Shopify shop URL', () => {
  // Look for showModal({ ..., title: "Connect Shopify" / "Shopify — Store URL"
  // / similar }) followed by an inputPlaceholder. The new flow uses
  // showModal with title:"Finish in your browser" but no input.
  const banned = [
    /showModal\(\{[^}]*title:\s*['"]Connect Shopify['"][^}]*inputPlaceholder/s,
    /showModal\(\{[^}]*title:\s*['"]Shopify — Store URL['"]/s,
    /showModal\(\{[^}]*title:\s*['"]Shopify — Access Token['"]/s,
  ];
  for (const re of banned) {
    assert.equal(re.test(RENDERER_JS), false, `forbidden Shopify URL-entry modal pattern matched: ${re}`);
  }
});

test('renderer: MANUAL_KEY_HANDLERS does NOT include shopify', () => {
  const m = RENDERER_JS.match(/const MANUAL_KEY_HANDLERS\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(m, 'MANUAL_KEY_HANDLERS table must exist');
  const tableBody = m[1];
  // The "Use my API key" right-click path was the second URL-entry vector.
  assert.equal(
    /\bshopify\s*:/.test(tableBody),
    false,
    'shopify entry in MANUAL_KEY_HANDLERS would re-introduce the shpat_* + URL prompt path',
  );
});

test('renderer: showShopifyApiKeyModal function definition is removed', () => {
  // The modal function itself was the manual-credential path. It must
  // not be redefined anywhere in renderer.js. References inside REGRESSION
  // GUARD comments are allowed (they document the prohibition).
  assert.equal(
    /function\s+showShopifyApiKeyModal\s*\(/.test(RENDERER_JS),
    false,
    'showShopifyApiKeyModal function must not be defined in renderer.js',
  );
});

test('renderer: no merlin.saveConfigField call writes shopifyStore from a user-typed value', () => {
  // Search for saveConfigField('shopifyStore' in any context. The new
  // flow only writes shopifyStore from the binary's vault path
  // (shopify-handoff action → applyExchangeResult → splitOAuthPersistFields).
  assert.equal(
    /saveConfigField\(\s*['"]shopifyStore['"]/.test(RENDERER_JS),
    false,
    'renderer.js must not call saveConfigField with shopifyStore — token landing is owned by shopify-handoff',
  );
  assert.equal(
    /saveConfigField\(\s*['"]shopifyAccessToken['"]/.test(RENDERER_JS),
    false,
    'renderer.js must not call saveConfigField with shopifyAccessToken',
  );
});

// ─── 2.3.1: no localhost OAuth listener for Shopify ─────────────────

test('oauth-provider-config: ACTIVE_PLATFORMS does not include shopify', () => {
  const m = PROVIDER_CONFIG.match(/const ACTIVE_PLATFORMS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'ACTIVE_PLATFORMS list must exist');
  const list = m[1];
  assert.equal(
    /['"]shopify['"]/.test(list),
    false,
    "ACTIVE_PLATFORMS must NOT include 'shopify' — fast-open binds 127.0.0.1 which violates App Store 2.3.1",
  );
});

// ─── new flow wiring ───────────────────────────────────────────────────

test('main: runOAuthFlow short-circuits Shopify with shell.openExternal', () => {
  // The Shopify branch must come BEFORE the fast-open + binary spawn
  // logic, and use openExternalSafe — never spawn the binary for the
  // initial install.
  const shopifyBranchIdx = MAIN_JS.indexOf("if (platform === 'shopify')");
  const fastOpenIdx = MAIN_JS.indexOf('if (FAST_OPEN_PLATFORMS.includes(platform))');
  assert.ok(shopifyBranchIdx > 0, 'Shopify short-circuit must exist in runOAuthFlow');
  assert.ok(fastOpenIdx > 0, 'FAST_OPEN_PLATFORMS branch must exist');
  assert.ok(shopifyBranchIdx < fastOpenIdx, 'Shopify short-circuit must precede FAST_OPEN_PLATFORMS branch');

  // The branch must call openExternalSafe with the SHOPIFY_CONNECT_URL
  // constant (server-driven install — not apps.shopify.com directly).
  const branch = MAIN_JS.slice(shopifyBranchIdx, shopifyBranchIdx + 1500);
  assert.match(branch, /openExternalSafe\(SHOPIFY_CONNECT_URL\)/, 'Shopify short-circuit must call openExternalSafe(SHOPIFY_CONNECT_URL)');
  assert.match(branch, /awaiting:\s*['"]browser['"]/, 'Shopify short-circuit must return awaiting:"browser"');
});

test('main: SHOPIFY_CONNECT_URL points at the worker /connect/shopify endpoint', () => {
  const m = MAIN_JS.match(/const SHOPIFY_CONNECT_URL = ['"]([^'"]+)['"];/);
  assert.ok(m, 'SHOPIFY_CONNECT_URL constant must be defined');
  const url = m[1];
  assert.ok(url.startsWith('https://'), `SHOPIFY_CONNECT_URL must be HTTPS, got ${url}`);
  assert.ok(url.includes('/connect/shopify'), `SHOPIFY_CONNECT_URL must hit /connect/shopify (got ${url})`);
});

test('main: run-shopify-handoff IPC handler exists and validates handoff format', () => {
  const idx = MAIN_JS.indexOf("ipcMain.handle('run-shopify-handoff'");
  assert.ok(idx > 0, 'run-shopify-handoff IPC handler must be registered');
  const handler = MAIN_JS.slice(idx, idx + 3000);
  assert.match(handler, /\^\[A-Za-z0-9_-\]\{22,86\}\$/, 'handler must validate handoff format');
  assert.match(handler, /shopify-handoff/, 'handler must dispatch action=shopify-handoff to the binary');
  assert.match(handler, /applyExchangeResult/, 'handler must route the binary result through applyExchangeResult');
});

test('preload: runShopifyHandoff is exposed', () => {
  assert.match(PRELOAD_JS, /runShopifyHandoff:\s*\(handoffCode,\s*brand\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]run-shopify-handoff['"]/);
});

test('renderer: registers an onMerlinDeepLink handler for oauth-complete', () => {
  // The handler is the ONLY way the desktop receives the post-install
  // handoff code. Removing it strands the install flow — the merchant
  // sees the dashboard but the desktop never picks up the token.
  assert.match(
    RENDERER_JS,
    /merlin\.onMerlinDeepLink\(/,
    'renderer.js must register onMerlinDeepLink',
  );
  assert.match(
    RENDERER_JS,
    /oauth-complete/,
    'deep-link handler must inspect the oauth-complete action',
  );
  assert.match(
    RENDERER_JS,
    /merlin\.runShopifyHandoff\(/,
    'deep-link handler must invoke runShopifyHandoff',
  );
});

test('renderer: deep link host check is strict (no pathname fallback bypass)', () => {
  // REGRESSION GUARD: the previous version accepted
  //   merlin://attacker.com//oauth-complete?handoff=X
  // because pathname fell through to '//oauth-complete' even though
  // host was 'attacker.com'. Fix: require host === 'oauth-complete'
  // strictly. Any reappearance of the pathname disjunct fails CI.
  const m = RENDERER_JS.match(/parsed\.host\s*!==\s*['"]oauth-complete['"]/);
  assert.ok(m, 'renderer must check parsed.host === oauth-complete');
  // Pathname fallback would re-open the bypass. Look for the dangerous pattern.
  assert.equal(
    /parsed\.pathname\s*!==\s*['"]\/\/oauth-complete['"]/.test(RENDERER_JS),
    false,
    'renderer must NOT use pathname disjunct as a fallback host check (CVE-style bypass)',
  );
});

test('renderer: handoff code validation matches server regex', () => {
  // 22-86 base64url chars. Must match the worker's
  // /^[A-Za-z0-9_-]{22,86}$/ exactly so a malformed deep link doesn't
  // hit the IPC handler in the first place.
  assert.match(
    RENDERER_JS,
    /\^\[A-Za-z0-9_-\]\{22,86\}\$/,
    'renderer.js must validate handoff format with the canonical regex',
  );
});

// ─── 1.1.12: dashboard standalone (verified via worker tests) ──────

test('runShopifyOAuthWithStore: signature has no `store` parameter', () => {
  // The old signature took `store` as a 2nd arg, used to seed the
  // shop URL. The new flow has no store input; the signature is
  // collapsed to `(activeBrand)`.
  const m = RENDERER_JS.match(/function runShopifyOAuthWithStore\s*\(([^)]*)\)/);
  assert.ok(m, 'runShopifyOAuthWithStore must still exist (entry point for the tile click)');
  const params = m[1].trim();
  // No `store` parameter (would re-introduce the URL-seeded path).
  assert.ok(
    !params.includes('store'),
    `runShopifyOAuthWithStore must not take a store parameter; got "${params}"`,
  );
});
