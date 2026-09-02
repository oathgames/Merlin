// REGRESSION GUARD (2026-08-30, TrendTrack "API key is empty").
// See app/universal-key-scope.js for the incident.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { GLOBAL_SCOPE, vaultScopeFor, planUniversalKeyMigration, resolveKeyScopes } =
  require('./universal-key-scope');

const UNIVERSAL = new Set([
  'falApiKey', 'elevenLabsApiKey', 'heygenApiKey', 'arcadsApiKey',
  'foreplayApiKey', 'trendtrackApiKey', 'googleApiKey',
  'slackBotToken', 'slackWebhookUrl', 'slackChannel',
  'discordGuildId', 'discordChannelId', 'discordWebhookUrl',
]);

let failures = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('universal-key-scope');

// ---- vaultScopeFor ---------------------------------------------------------

t('a universal key ignores the active brand — the exact incident', () => {
  assert.strictEqual(vaultScopeFor('trendtrackApiKey', 'apotheke', UNIVERSAL), '_global');
});

t('every universal key routes to _global from a brand context', () => {
  for (const k of UNIVERSAL) {
    assert.strictEqual(vaultScopeFor(k, 'forever21', UNIVERSAL), '_global',
      k + ' must be workspace-scoped');
  }
});

t('a brand-scoped key still follows the brand', () => {
  // The other half of the guard. Routing these to _global would be the
  // 2026-04-27 cross-brand vault leak, in reverse.
  for (const k of ['metaAccessToken', 'clarityApiToken', 'aliaApiKey',
                   'shopifyAccessToken', 'klaviyoApiKey']) {
    assert.strictEqual(vaultScopeFor(k, 'apotheke', UNIVERSAL), 'apotheke');
  }
});

t('a brandless write is global for both kinds', () => {
  assert.strictEqual(vaultScopeFor('metaAccessToken', '', UNIVERSAL), '_global');
  assert.strictEqual(vaultScopeFor('trendtrackApiKey', null, UNIVERSAL), '_global');
});


// Mirror of BRAND_KEYS in main.js (only the entries these assertions use).
// Membership itself is guarded by brand-scope-isolation.test.js; this list
// exists so resolveKeyScopes can be exercised without loading Electron.
const BRAND_KEYS = [
  'metaAccessToken', 'metaAdAccountId', 'shopifyAccessToken', 'klaviyoApiKey',
  'clarityApiToken', 'aliaApiKey', 'googleAccessToken', 'triplewhaleApiKey',
];
const MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// ---- planUniversalKeyMigration --------------------------------------------

function vaultOf(entries) {
  const set = new Set(entries.map(([b, k]) => b + '|' + k));
  return (scope, key) => set.has(scope + '|' + key);
}

t('plans a move for a universal key found under a brand', () => {
  const plan = planUniversalKeyMigration(
    UNIVERSAL, ['apotheke', 'forever21'],
    vaultOf([['apotheke', 'trendtrackApiKey']]));
  assert.deepStrictEqual(plan,
    [{ key: 'trendtrackApiKey', fromBrand: 'apotheke', conflict: false }]);
});

t('plans nothing when the vault is already clean', () => {
  const plan = planUniversalKeyMigration(
    UNIVERSAL, ['apotheke'], vaultOf([['_global', 'trendtrackApiKey']]));
  assert.deepStrictEqual(plan, []);
});

t('never plans to move a brand-scoped key', () => {
  const plan = planUniversalKeyMigration(
    UNIVERSAL, ['apotheke'],
    vaultOf([['apotheke', 'metaAccessToken'], ['apotheke', 'aliaApiKey']]));
  assert.deepStrictEqual(plan, [], 'brand credentials must stay with the brand');
});

t('a key present in both scopes is reported as a conflict, not a move', () => {
  // Neither copy may be destroyed: _global is NOT reliably the good one. In the
  // incident it held a revoked key while the brand scope held the fresh paste.
  const plan = planUniversalKeyMigration(
    UNIVERSAL, ['apotheke'],
    vaultOf([['apotheke', 'falApiKey'], ['_global', 'falApiKey']]));
  assert.deepStrictEqual(plan,
    [{ key: 'falApiKey', fromBrand: 'apotheke', conflict: true }]);
});

t('the call site never deletes a conflicted brand copy', () => {
  const i = MAIN.indexOf('function migrateUniversalKeysToGlobal');
  const body = MAIN.slice(i, i + 2600);
  const guard = body.indexOf('if (conflict)');
  const del = body.indexOf('vaultDelete(');
  assert.ok(guard > -1, 'conflicts must be branched on before any delete');
  assert.ok(guard < del, 'the conflict guard must precede the delete');
  assert.ok(/if \(conflict\) \{[\s\S]{0,600}?continue;/.test(body),
    'a conflicted entry must continue, not fall through to the move');
});

t('the _global scope is never treated as a source brand', () => {
  const plan = planUniversalKeyMigration(
    UNIVERSAL, ['_global'], vaultOf([['_global', 'trendtrackApiKey']]));
  assert.deepStrictEqual(plan, []);
});

t('survives a missing brand list rather than throwing on boot', () => {
  assert.deepStrictEqual(planUniversalKeyMigration(UNIVERSAL, null, () => true), []);
});

// ---- source scans ----------------------------------------------------------

t('save-config-field routes through vaultScopeFor, not brandName || _global', () => {
  assert.ok(/const vaultBrand = vaultScopeFor\(key, brandName, UNIVERSAL_KEYS\)/.test(MAIN),
    'the scope decision must go through the shared helper');
  assert.ok(!/const vaultBrand = brandName \|\| '_global'/.test(MAIN),
    'the original misrouting line is back');
});

t('the migration runs on boot and is not behind a one-shot version gate', () => {
  assert.ok(/try \{ migrateUniversalKeysToGlobal\(\); \}/.test(MAIN),
    'migration is defined but never called');
  const body = MAIN.slice(MAIN.indexOf('function migrateUniversalKeysToGlobal'),
                          MAIN.indexOf('function migrateUniversalKeysToGlobal') + 1800);
  assert.ok(!/_migrationVersion|hasRun|alreadyMigrated/.test(body),
    'a one-shot gate was the original bug in the sibling sweep (Rule 21)');
});

t('the migration logs key names only, never a value', () => {
  const i = MAIN.indexOf('function migrateUniversalKeysToGlobal');
  const body = MAIN.slice(i, i + 1800);
  assert.ok(!/console\.(log|error)\([^)]*\bvalue\b/.test(body),
    'a credential must never reach a log line');
});

t('UNIVERSAL_KEYS still contains the key that caused the incident', () => {
  assert.ok(/'trendtrackApiKey'/.test(MAIN));
});


// ---- resolveKeyScopes ------------------------------------------------------
// REGRESSION GUARD (2026-09-02, universal-key-read-shadow). The write side was
// fixed on 2026-08-30 but every READER still asked the brand namespace first,
// so a stale pre-migration brand copy shadowed the good _global one forever.

t('a universal key reads _global FIRST, brand only as legacy fallback', () => {
  assert.deepStrictEqual(
    resolveKeyScopes('trendtrackApiKey', 'apotheke', UNIVERSAL, BRAND_KEYS),
    ['_global', 'apotheke']);
});

t('every universal key reads _global first', () => {
  for (const k of UNIVERSAL) {
    assert.strictEqual(
      resolveKeyScopes(k, 'forever21', UNIVERSAL, BRAND_KEYS)[0], '_global',
      k + ' must resolve _global first');
  }
});

t('a brand-scoped key reads the brand ONLY, never _global', () => {
  for (const k of ['metaAccessToken', 'clarityApiToken', 'aliaApiKey',
                   'shopifyAccessToken', 'klaviyoApiKey']) {
    assert.deepStrictEqual(
      resolveKeyScopes(k, 'apotheke', UNIVERSAL, BRAND_KEYS), ['apotheke'],
      k + ' must not fall back to _global (2026-04-27 cross-brand leak)');
  }
});

t('an unclassified key keeps the legacy brand-then-global order', () => {
  assert.deepStrictEqual(
    resolveKeyScopes('productUrl', 'apotheke', UNIVERSAL, BRAND_KEYS),
    ['apotheke', '_global']);
});

t('a brandless read never invents a brand scope', () => {
  assert.deepStrictEqual(resolveKeyScopes('trendtrackApiKey', '', UNIVERSAL, BRAND_KEYS), ['_global']);
  assert.deepStrictEqual(resolveKeyScopes('productUrl', null, UNIVERSAL, BRAND_KEYS), ['_global']);
  assert.deepStrictEqual(resolveKeyScopes('metaAccessToken', '', UNIVERSAL, BRAND_KEYS), []);
});

t('the scope order and the write scope agree for every universal key', () => {
  for (const k of UNIVERSAL) {
    assert.strictEqual(
      resolveKeyScopes(k, 'apotheke', UNIVERSAL, BRAND_KEYS)[0],
      vaultScopeFor(k, 'apotheke', UNIVERSAL),
      k + ': readers must look first where writers put it');
  }
});

// The incident itself, end to end: both copies present, stale under the brand.
t('a stale brand copy no longer shadows the fresh _global key', () => {
  const vault = {
    'apotheke|trendtrackApiKey': 'REVOKED-pasted-before-2026-08-30',
    '_global|trendtrackApiKey': 'FRESH-workspace-key',
  };
  const vaultGet = (scope, key) => vault[scope + '|' + key] || null;
  let real = null;
  for (const scope of resolveKeyScopes('trendtrackApiKey', 'apotheke', UNIVERSAL, BRAND_KEYS)) {
    real = vaultGet(scope, 'trendtrackApiKey');
    if (real) break;
  }
  assert.strictEqual(real, 'FRESH-workspace-key',
    'the _global key must win; reading the brand copy is the live 2026-09-02 bug');
});

t('a pre-migration install whose only copy is under the brand still works', () => {
  const vault = { 'apotheke|trendtrackApiKey': 'only-copy-on-this-machine' };
  const vaultGet = (scope, key) => vault[scope + '|' + key] || null;
  let real = null;
  for (const scope of resolveKeyScopes('trendtrackApiKey', 'apotheke', UNIVERSAL, BRAND_KEYS)) {
    real = vaultGet(scope, 'trendtrackApiKey');
    if (real) break;
  }
  assert.strictEqual(real, 'only-copy-on-this-machine',
    'the brand fallback is what keeps un-migrated installs alive');
});

// ---- source scan: no read site may re-derive the policy ---------------------

t('readBrandConfig routes its vault reads through resolveKeyScopes', () => {
  const i = MAIN.indexOf('function readBrandConfig');
  assert.ok(i > 0, 'readBrandConfig must exist');
  const body = MAIN.slice(i, MAIN.indexOf('function readBrandOnlyBrandCreds'));
  assert.ok(/resolveKeyScopes\(k, brandName, UNIVERSAL_KEYS, BRAND_KEYS\)/.test(body),
    'readBrandConfig must resolve scopes through the shared helper');
  assert.ok(!/let real = vaultGet\(brandName, vKey\)/.test(body),
    'the bare brand-first read is the 2026-09-02 shadow bug; it must be gone');
});

t('readBrandOnlyBrandCreds resolves universal keys through the helper too', () => {
  const i = MAIN.indexOf('function readBrandOnlyBrandCreds');
  assert.ok(i > 0, 'readBrandOnlyBrandCreds must exist');
  const body = MAIN.slice(i, MAIN.indexOf('function buildStrictBrandConfig'));
  assert.ok(/resolveKeyScopes\(/.test(body),
    'this config is overlaid on the global base, so a stale brand copy would win');
  assert.ok(!/const real = vaultGet\(brandName, vKey\)/.test(body),
    'the bare brand-first read must be gone here as well');
});

t('main.js imports resolveKeyScopes from the single-source module', () => {
  assert.ok(/resolveKeyScopes[^\n]*require\('\.\/universal-key-scope'\)/.test(MAIN),
    'the policy must come from universal-key-scope.js, never be re-inlined');
});

t('the read guard is documented at the read site', () => {
  assert.ok(/REGRESSION GUARD \(2026-09-02, universal-key-read-shadow\)/.test(MAIN),
    'a dated guard block must explain the incident at the read site');
});

console.log(failures ? '\nFAILED ' + failures : '\nall passed');
process.exit(failures ? 1 : 0);
