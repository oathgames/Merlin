// REGRESSION GUARD (2026-08-22, Benebone cross-brand Instagram leak): every
// account-bound Meta identity field must be brand-scoped, on BOTH sides of
// the mirror, and must be cleared on disconnect.
//
// The incident: `metaInstagramUserId` was absent from BRAND_KEYS (main.js) and
// from brandScopedKeys (autocmo-core/vault.go) while its three siblings
// metaAdAccountId / metaPageId / metaPixelId were present in both. Because it
// was absent, buildStrictBrandConfig did not strip it from the global base, so
// a single value in the global merlin-config.json was applied as
// `instagram_user_id` on EVERY brand's creative POST. Benebone inherited
// another brand's Instagram account and Meta refused all 8 ads with
// "Ad Account Has No Access To Instagram Account" (code 200/1815199).
//
// Nothing failed loudly. The config read correct per-brand, the page and pixel
// were right, and the only symptom was a Meta 400 whose text the MCP error
// classifier discarded (see mcp-error-detail.test.js for that half).
//
// This is the third instance of the same drift class (mailchimpApiKey
// 2026-07-11, googleAnalyticsMeasurementId 2026-08-02). The sibling-completeness
// assertion below is what makes the class detectable instead of the individual
// bug: add a fourth Meta identity field and forget one list, and this fails.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// Account-bound Meta identity: values that name a specific ad account, page,
// pixel or Instagram account. Every one of these is meaningless (worse:
// actively harmful) when carried from one brand to another.
const META_IDENTITY_FIELDS = [
  'metaAccessToken',
  'metaAdAccountId',
  'metaPageId',
  'metaPixelId',
  'metaInstagramUserId',
];

function brandKeysFromMainJs() {
  const m = MAIN_JS.match(/const BRAND_KEYS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, 'BRAND_KEYS must be present in main.js');
  // Comments inside the array must avoid apostrophes - this quote regex is
  // the same extraction brand-scope-isolation.test.js uses.
  return (m[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
}

function universalKeysFromMainJs() {
  const m = MAIN_JS.match(/const UNIVERSAL_KEYS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'UNIVERSAL_KEYS must be present in main.js');
  return (m[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
}

// The Go mirror lives in the private repo. In a shipped install it is absent,
// so the cross-repo assertions skip rather than fail - the JS-side assertions
// still run everywhere.
function goBrandScopedKeys() {
  const candidates = [
    path.join(__dirname, '..', '..', 'autocmo-core', 'vault.go'),
    path.join(__dirname, '..', '..', '..', 'autocmo-core', 'vault.go'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) return null;
  const src = fs.readFileSync(found, 'utf8');
  const m = src.match(/var brandScopedKeys = map\[string\]bool\{([\s\S]*?)\n\}/);
  assert.ok(m, 'brandScopedKeys must be present in vault.go');
  const body = m[1]
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return (body.match(/"([^"]+)"\s*:/g) || []).map((s) => s.match(/"([^"]+)"/)[1]);
}

test('every Meta identity field is brand-scoped in BRAND_KEYS', () => {
  const brand = brandKeysFromMainJs();
  for (const field of META_IDENTITY_FIELDS) {
    assert.ok(
      brand.includes(field),
      `${field} must be in BRAND_KEYS - otherwise buildStrictBrandConfig leaves ` +
      `the global value in place and it is applied to EVERY brand`,
    );
  }
});

test('no Meta identity field is universal', () => {
  const universal = universalKeysFromMainJs();
  for (const field of META_IDENTITY_FIELDS) {
    assert.ok(
      !universal.includes(field),
      `${field} must NOT be in UNIVERSAL_KEYS - universal membership is exactly ` +
      `the "_global fallback is allowed" signal, which is the leak`,
    );
  }
});

test('every Meta identity field is brand-scoped in the Go mirror', () => {
  const goKeys = goBrandScopedKeys();
  if (!goKeys) return; // private repo not present (shipped install)
  for (const field of META_IDENTITY_FIELDS) {
    assert.ok(
      goKeys.includes(field),
      `${field} is missing from brandScopedKeys in autocmo-core/vault.go - the ` +
      `Go vault resolver would fall back to the _global namespace for it`,
    );
  }
});

test('the two brand-scope lists agree on Meta identity fields', () => {
  const goKeys = goBrandScopedKeys();
  if (!goKeys) return;
  const brand = brandKeysFromMainJs();
  const jsSide = META_IDENTITY_FIELDS.filter((f) => brand.includes(f)).sort();
  const goSide = META_IDENTITY_FIELDS.filter((f) => goKeys.includes(f)).sort();
  assert.deepStrictEqual(
    jsSide, goSide,
    'BRAND_KEYS and brandScopedKeys drifted on Meta identity fields - the two ' +
    'lists are a mirror by contract and drift between them is the bug class ' +
    'that produced the mailchimpApiKey, googleAnalyticsMeasurementId and ' +
    'metaInstagramUserId incidents',
  );
});

test('disconnecting Meta clears every Meta identity field', () => {
  const m = MAIN_JS.match(/const keyMap = \{([\s\S]*?)\n    \};/);
  assert.ok(m, 'disconnect-platform keyMap must be present');
  const metaLine = m[1].split('\n').find((line) => /^\s*meta:\s*\[/.test(line));
  assert.ok(metaLine, 'keyMap.meta must be present');
  const cleared = (metaLine.match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
  for (const field of META_IDENTITY_FIELDS) {
    assert.ok(
      cleared.includes(field),
      `keyMap.meta must clear ${field} - an identity field left behind on ` +
      `disconnect is inherited by the NEXT Meta account the brand connects`,
    );
  }
});
