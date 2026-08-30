// REGRESSION GUARD (2026-08-30, TrendTrack "API key is empty").
// See app/universal-key-scope.js for the incident.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { GLOBAL_SCOPE, vaultScopeFor, planUniversalKeyMigration } =
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

console.log(failures ? '\nFAILED ' + failures : '\nall passed');
process.exit(failures ? 1 : 0);
