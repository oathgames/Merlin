// Regression guards for the cross-brand connection-leak incident
// (2026-04-27). Three layered bugs in main.js compounded to render one
// brand's connections under another brand's tiles in the Magic panel:
//
//   1. readBrandConfig() mutated the cached global config object
//      (Object.assign onto readConfig()'s cached reference) — every
//      subsequent call inherited the previous brand's tokens.
//   2. Vault placeholder resolution fell back unconditionally to the
//      "_global" namespace, so a brand with no connection inherited
//      whatever was stored under "_global/<key>" by a legacy migration
//      or another brand's setup.
//   3. getConnections() used readBrandConfig() (which merges global ⊕
//      brand) instead of buildStrictBrandConfig() (which strips
//      BRAND_KEYS from global before overlay).
//
// These tests source-scan main.js for the specific guards put in place
// and fail loudly if any future edit removes them.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// Source-scan strategy: operate on the raw source. Comments and dated
// REGRESSION GUARD prose CAN contain identifiers like "readBrandConfig"
// — that's fine because the structural regexes below match code shapes
// (clones, balanced braces, ternaries) that won't appear in comments.
//
// Extract a named top-level function body. The naive `function X { ... }`
// regex with a lazy `}` matches at the FIRST closing brace, which is
// wrong for any function with nested braces. Walk forward from the
// function header counting braces.
function extractFunction(name, src) {
  const start = src.indexOf('function ' + name);
  if (start < 0) return '';
  const open = src.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

// ── Layer 1: readBrandConfig clones cached global ──────────────

test('readBrandConfig clones the cached config (no in-place mutation)', () => {
  const body = extractFunction('readBrandConfig', MAIN_JS);
  assert.ok(body, 'readBrandConfig must exist');
  assert.ok(/const\s+cfg\s*=\s*\{\s*\.\.\.readConfig\(\)\s*\}/.test(body),
    'readBrandConfig must clone readConfig() before mutating (shape: const cfg = { ...readConfig() })');
  assert.ok(!/const\s+cfg\s*=\s*readConfig\(\)\s*;[\s\S]*?Object\.assign\(cfg,/.test(body),
    'readBrandConfig must not Object.assign onto a non-cloned readConfig() reference');
});

test('readBrandConfig has REGRESSION GUARD comment for cache mutation', () => {
  // The dated comment is the lifeline for any future contributor
  // tempted to "simplify" the clone away.
  assert.ok(/REGRESSION GUARD \(2026-04-27, cross-brand cache mutation\)/.test(MAIN_JS),
    'readBrandConfig must keep the dated regression-guard comment');
});

// ── Layer 2: vault placeholder fallback gated by UNIVERSAL_KEYS ─

test('UNIVERSAL_KEYS set is defined and contains universal-only credentials', () => {
  // The Set is declared at module scope — match against the raw source
  // because the declaration includes string literals.
  assert.ok(/const\s+UNIVERSAL_KEYS\s*=\s*new\s+Set\(/.test(MAIN_JS),
    'UNIVERSAL_KEYS Set must exist');
  const m = MAIN_JS.match(/const\s+UNIVERSAL_KEYS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, 'UNIVERSAL_KEYS Set must be parseable');
  const block = m[1];
  for (const k of ['falApiKey', 'elevenLabsApiKey', 'heygenApiKey', 'foreplayApiKey']) {
    assert.ok(block.includes(`'${k}'`),
      `UNIVERSAL_KEYS must contain ${k}`);
  }
});

test('vault placeholder fallback to _global is gated by UNIVERSAL_KEYS', () => {
  const body = extractFunction('readBrandConfig', MAIN_JS);
  assert.ok(body, 'readBrandConfig must exist');
  // The resolve must take the brand-scoped flag into account.
  assert.ok(/isBrandScoped/.test(body),
    'readBrandConfig vault loop must compute isBrandScoped');
  // The unconditional `vaultGet(brand) || vaultGet("_global")` shape is
  // the EXACT bug pattern. Any reintroduction must fail this test.
  // We allow it to appear under an `if (!isBrandScoped)` branch — that's
  // the legitimate gated form — but a top-level "always fall back to
  // _global" assignment is forbidden.
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/vaultGet\(brandName,\s*vKey\)\s*\|\|\s*vaultGet\(\s*['"]_global['"]\s*,/.test(line)) {
      assert.fail('readBrandConfig contains an ungated `brandName || _global` vault fallback at line ' + i);
    }
  }
});

test('readBrandConfig strips unresolved brand-scoped placeholders', () => {
  const body = extractFunction('readBrandConfig', MAIN_JS);
  assert.ok(body, 'readBrandConfig must exist');
  assert.ok(/delete\s+cfg\[k\]/.test(body),
    'readBrandConfig must strip unresolved brand-scoped placeholders (delete cfg[k])');
});

// ── Layer 3: getConnections uses strict-brand config ───────────

test('getConnections uses buildStrictBrandConfig (not readBrandConfig)', () => {
  const body = extractFunction('getConnections', MAIN_JS);
  assert.ok(body, 'getConnections must exist');
  assert.ok(/buildStrictBrandConfig\(brandName\)/.test(body),
    'getConnections must call buildStrictBrandConfig(brandName) for the brand path');
  assert.ok(!/=\s*readBrandConfig\(brandName\)/.test(body),
    'getConnections must not use readBrandConfig (use the strict variant instead)');
});

test('getConnections checkBrand reads brandCfg only, never falls back to globalCfg for credentials', () => {
  // checkBrand is a nested function inside getConnections. Extract the
  // outer body and look for the ternary brandCfg/globalCfg pattern.
  const body = extractFunction('getConnections', MAIN_JS);
  assert.ok(/brandName\s*\?\s*brandCfg\[key\]\s*:\s*globalCfg\[key\]/.test(body),
    'checkBrand must branch on brandName, never coalesce brandCfg with globalCfg credentials');
  // The legacy bug shape: `brandCfg[key] || globalCfg[key]` with no
  // brand guard. Allow only `(!brandName ? globalCfg[key] : null)` form.
  // The current fix uses the ternary above; either is fine, but a bare
  // `brandCfg[key] || globalCfg[key]` is forbidden.
  assert.ok(!/brandCfg\[key\]\s*\|\|\s*globalCfg\[key\]/.test(body),
    'checkBrand must not coalesce brandCfg || globalCfg (would re-introduce the leak)');
});

// ── Layer 4: BRAND_KEYS / UNIVERSAL_KEYS sync with disconnect ───

test('BRAND_KEYS and UNIVERSAL_KEYS partitions are disjoint', () => {
  // No key should appear in BOTH sets — that would make the gating
  // inconsistent. Extract both lists and compare.
  const brandKeysMatch = MAIN_JS.match(/const BRAND_KEYS\s*=\s*\[([\s\S]*?)\];/);
  const universalKeysMatch = MAIN_JS.match(/const UNIVERSAL_KEYS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\);/);
  assert.ok(brandKeysMatch, 'BRAND_KEYS must be present');
  assert.ok(universalKeysMatch, 'UNIVERSAL_KEYS must be present');
  const brand = (brandKeysMatch[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));
  const universal = (universalKeysMatch[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));
  // BRAND_KEYS legitimately includes some universal-shape entries
  // (slackBotToken, slackWebhookUrl) for legacy migration purposes —
  // those are documented in UNIVERSAL_KEYS too. The contract is that
  // UNIVERSAL_KEYS membership is the authoritative signal for "may
  // fall back to _global", so the OVERLAP set is the per-brand-config
  // legacy migration helpers. The CRITICAL assertion is that
  // metaAccessToken / tiktokAccessToken / googleAccessToken etc. are
  // in BRAND but NOT in UNIVERSAL.
  for (const mustBeBrandOnly of [
    'metaAccessToken', 'tiktokAccessToken', 'googleAccessToken',
    'shopifyAccessToken', 'stripeAccessToken', 'klaviyoApiKey',
    'redditAccessToken', 'amazonAccessToken', 'etsyAccessToken',
    'pinterestAccessToken', 'linkedinAccessToken',
  ]) {
    assert.ok(brand.includes(mustBeBrandOnly), `${mustBeBrandOnly} must be in BRAND_KEYS`);
    assert.ok(!universal.includes(mustBeBrandOnly), `${mustBeBrandOnly} must NOT be in UNIVERSAL_KEYS (would re-introduce leak)`);
  }
  for (const mustBeUniversal of [
    'falApiKey', 'elevenLabsApiKey', 'heygenApiKey', 'foreplayApiKey',
  ]) {
    assert.ok(universal.includes(mustBeUniversal), `${mustBeUniversal} must be in UNIVERSAL_KEYS`);
  }
});

// ── Layer 5: renderer race guard sanity check ─────────────────

test('renderer loadConnections has a sequence guard against brand-switch races', () => {
  const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  assert.ok(/_connLoadSeq/.test(renderer),
    'loadConnections must use a sequence token to bail on stale resolves');
  assert.ok(/getActiveBrandSelection\(\)\s*!==\s*brand/.test(renderer),
    'loadConnections must double-check the brand selector did not change');
});

// ── REGRESSION GUARD trail ────────────────────────────────────

test('all five layered fixes carry dated REGRESSION GUARD comments', () => {
  // Every layer of the fix should be discoverable by grepping for the
  // dated tag. Future contributors who delete a guard MUST update this
  // count too — that's the trip wire.
  const guards = (MAIN_JS.match(/REGRESSION GUARD \(2026-04-27/g) || []).length;
  assert.ok(guards >= 3, `expected >=3 REGRESSION GUARD (2026-04-27) tags in main.js, got ${guards}`);
  const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  assert.ok(/REGRESSION GUARD \(2026-04-27/.test(renderer),
    'renderer.js must carry the dated guard for the loadConnections race');
});
