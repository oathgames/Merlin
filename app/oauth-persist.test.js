// Unit tests for oauth-persist.js. Run with `node app/oauth-persist.test.js`.
//
// Scenario coverage:
//   1. Non-sensitive fields flow to publicFields
//   2. Sensitive fields with real tokens are vaulted + emit placeholder
//   3. Sensitive fields with redaction markers SKIP vaultPut but STILL emit
//      placeholder — this is the Google Ads tile-not-green regression guard
//   4. Mixed result (public + sensitive-real + sensitive-redacted) splits cleanly
//   5. Empty / null input returns empty shape

const assert = require('assert');
const {
  VAULT_SENSITIVE_KEYS,
  CONFIG_FIELD_ALLOWLIST,
  isSensitiveConfigKey,
  isVaultRedactionMarker,
  splitOAuthPersistFields,
} = require('./oauth-persist');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.log('  ✗', name);
    console.log('    ', err.message);
    failed++;
  }
}

function makeVaultSpy() {
  const calls = [];
  return {
    fn: (brand, key, value) => calls.push({ brand, key, value }),
    calls,
  };
}

test('isVaultRedactionMarker detects marker regardless of case/whitespace', () => {
  assert.strictEqual(isVaultRedactionMarker('[stored securely]'), true);
  assert.strictEqual(isVaultRedactionMarker('  [STORED SECURELY]  '), true);
  assert.strictEqual(isVaultRedactionMarker('[Stored Securely]'), true);
  assert.strictEqual(isVaultRedactionMarker('real-token-xyz'), false);
  assert.strictEqual(isVaultRedactionMarker(''), false);
  assert.strictEqual(isVaultRedactionMarker(null), false);
  assert.strictEqual(isVaultRedactionMarker(undefined), false);
});

test('non-sensitive fields flow to publicFields', () => {
  const spy = makeVaultSpy();
  const { publicFields, placeholders } = splitOAuthPersistFields(
    'madchill',
    { googleAdsCustomerId: '1234567890', metaPageId: '998877' },
    spy.fn,
  );
  assert.deepStrictEqual(publicFields, {
    googleAdsCustomerId: '1234567890',
    metaPageId: '998877',
  });
  assert.deepStrictEqual(placeholders, {});
  assert.strictEqual(spy.calls.length, 0, 'no vault writes for public fields');
});

test('sensitive fields with real tokens are vaulted and emit placeholder', () => {
  const spy = makeVaultSpy();
  const { publicFields, placeholders } = splitOAuthPersistFields(
    'madchill',
    { googleAccessToken: 'ya29.real-token-xyz', googleRefreshToken: '1//real-refresh' },
    spy.fn,
  );
  assert.deepStrictEqual(publicFields, {});
  assert.deepStrictEqual(placeholders, {
    googleAccessToken: '@@VAULT:googleAccessToken@@',
    googleRefreshToken: '@@VAULT:googleRefreshToken@@',
  });
  assert.strictEqual(spy.calls.length, 2);
  assert.deepStrictEqual(spy.calls[0], {
    brand: 'madchill', key: 'googleAccessToken', value: 'ya29.real-token-xyz',
  });
  assert.deepStrictEqual(spy.calls[1], {
    brand: 'madchill', key: 'googleRefreshToken', value: '1//real-refresh',
  });
});

test('redacted sensitive fields skip vaultPut but STILL emit placeholder', () => {
  // REGRESSION GUARD (2026-04-17): Before this fix, redacted tokens produced
  // NO placeholder, so the brand config file had no reference to the token
  // and the tile stayed gray after Connect Google. See oauth-persist.js for
  // the full comment.
  const spy = makeVaultSpy();
  const { publicFields, placeholders } = splitOAuthPersistFields(
    'madchill',
    {
      googleAccessToken: '[stored securely]',
      googleRefreshToken: '[stored securely]',
      googleAdsCustomerId: '1234567890',
    },
    spy.fn,
  );
  assert.deepStrictEqual(publicFields, { googleAdsCustomerId: '1234567890' });
  assert.deepStrictEqual(placeholders, {
    googleAccessToken: '@@VAULT:googleAccessToken@@',
    googleRefreshToken: '@@VAULT:googleRefreshToken@@',
  });
  assert.strictEqual(spy.calls.length, 0,
    'vaultPut should NOT be called for redacted values — binary already wrote them');
});

test('mixed result (public + real + redacted) splits cleanly', () => {
  const spy = makeVaultSpy();
  const { publicFields, placeholders } = splitOAuthPersistFields(
    'madchill',
    {
      metaAccessToken: 'EAAreal',            // real sensitive
      metaAdAccountId: 'act_123',            // public
      googleAccessToken: '[stored securely]',// redacted sensitive
      googleAdsCustomerId: '9876543210',     // public
    },
    spy.fn,
  );
  assert.deepStrictEqual(publicFields, {
    metaAdAccountId: 'act_123',
    googleAdsCustomerId: '9876543210',
  });
  assert.deepStrictEqual(placeholders, {
    metaAccessToken: '@@VAULT:metaAccessToken@@',
    googleAccessToken: '@@VAULT:googleAccessToken@@',
  });
  assert.strictEqual(spy.calls.length, 1, 'only the real token gets vaulted');
  assert.deepStrictEqual(spy.calls[0], {
    brand: 'madchill', key: 'metaAccessToken', value: 'EAAreal',
  });
});

test('empty and null input returns empty shape', () => {
  const spy = makeVaultSpy();
  assert.deepStrictEqual(splitOAuthPersistFields('madchill', {}, spy.fn),
    { publicFields: {}, placeholders: {} });
  assert.deepStrictEqual(splitOAuthPersistFields('madchill', null, spy.fn),
    { publicFields: {}, placeholders: {} });
  assert.deepStrictEqual(splitOAuthPersistFields('madchill', undefined, spy.fn),
    { publicFields: {}, placeholders: {} });
  assert.strictEqual(spy.calls.length, 0);
});

test('VAULT_SENSITIVE_KEYS covers every OAuth provider the Go binary writes', () => {
  // Lightweight drift guard: every getXxxOAuth factory in autocmo-core/oauth.go
  // writes either a token or a refresh token via VaultPut. This test pins the
  // Electron list so a Go-side addition without an Electron update gets caught.
  const expected = [
    'metaAccessToken', 'tiktokAccessToken',
    'googleAccessToken', 'googleRefreshToken',
    'shopifyAccessToken',
    'klaviyoAccessToken', 'klaviyoApiKey',
    'amazonAccessToken', 'amazonRefreshToken',
    'pinterestAccessToken', 'pinterestRefreshToken',
    'etsyAccessToken', 'etsyRefreshToken',
    'redditAccessToken', 'redditRefreshToken',
    'stripeAccessToken',
  ];
  for (const key of expected) {
    assert.ok(VAULT_SENSITIVE_KEYS.includes(key), `missing ${key} from VAULT_SENSITIVE_KEYS`);
  }
});

test('foreplayApiKey and googleAdsDeveloperToken are vaulted', () => {
  // REGRESSION GUARD (2026-04-23, codex review): these two were accepted
  // by CONFIG_FIELD_ALLOWLIST but missing from VAULT_SENSITIVE_KEYS, so
  // every UI paste of a Foreplay key or Google Ads dev token landed in
  // merlin-config.json as plaintext. Keep both here; do not "simplify" by
  // removing this assertion — the allowlist cross-check below would still
  // flag it, but a dedicated test makes the fix visible in git blame.
  assert.ok(VAULT_SENSITIVE_KEYS.includes('foreplayApiKey'),
    'foreplayApiKey must be vaulted — it is a Foreplay ad-library API key');
  assert.ok(VAULT_SENSITIVE_KEYS.includes('googleAdsDeveloperToken'),
    'googleAdsDeveloperToken must be vaulted — it is a Google-console dev secret');
  assert.strictEqual(isSensitiveConfigKey('foreplayApiKey'), true);
  assert.strictEqual(isSensitiveConfigKey('googleAdsDeveloperToken'), true);
  assert.strictEqual(isSensitiveConfigKey('googleAdsCustomerId'), false,
    'customer IDs are public identifiers, not secrets');
  assert.strictEqual(isSensitiveConfigKey(null), false);
  assert.strictEqual(isSensitiveConfigKey(undefined), false);
});

test('every sensitive-looking key in CONFIG_FIELD_ALLOWLIST is in VAULT_SENSITIVE_KEYS', () => {
  // The root-cause invariant. `save-config-field` in main.js accepts any key
  // in CONFIG_FIELD_ALLOWLIST and writes the value to disk. If a key LOOKS
  // like a secret (ends in Token / Key / Secret / WebhookUrl) but is NOT in
  // VAULT_SENSITIVE_KEYS, the handler skips the vault path and lands the
  // raw value in merlin-config.json. That is how foreplayApiKey and
  // googleAdsDeveloperToken regressed. This test pins the invariant so the
  // next time someone adds a new secret to the allowlist, CI fails until
  // they also add it to VAULT_SENSITIVE_KEYS.
  const sensitiveSuffix = /(Token|Key|Secret|WebhookUrl)$/;
  // Empty by design — if a public field accidentally matches the suffix
  // pattern but is genuinely non-secret, add it here with a comment
  // explaining why. Today: none.
  const KNOWN_NON_SENSITIVE_MATCHES = new Set([]);
  const offenders = [];
  for (const key of CONFIG_FIELD_ALLOWLIST) {
    if (!sensitiveSuffix.test(key)) continue;
    if (KNOWN_NON_SENSITIVE_MATCHES.has(key)) continue;
    if (!VAULT_SENSITIVE_KEYS.includes(key)) offenders.push(key);
  }
  assert.deepStrictEqual(offenders, [],
    `CONFIG_FIELD_ALLOWLIST contains sensitive-looking key(s) not in VAULT_SENSITIVE_KEYS: ${offenders.join(', ')}. ` +
    `save-config-field would persist the value as plaintext. Add each key to VAULT_SENSITIVE_KEYS in oauth-persist.js.`);
});

test('every BYOK tile in renderer.js API_KEY_PLATFORMS reaches CONFIG_FIELD_ALLOWLIST and VAULT_SENSITIVE_KEYS', () => {
  // REGRESSION GUARD (2026-04-27, postscript-save-broken incident). The
  // existing "every sensitive-looking allowlist key is vaulted" test
  // catches drift in ONE direction (allowlist → vault). It does NOT catch
  // the inverse: a BYOK tile registered in renderer.js but missing from
  // the allowlist, which makes save-config-field reject the paste with
  // "Unknown config field" and the user sees nothing happen on Save.
  //
  // This test parses renderer.js's API_KEY_PLATFORMS map and asserts that
  // every `key` it references is BOTH in CONFIG_FIELD_ALLOWLIST AND in
  // VAULT_SENSITIVE_KEYS. Adding a new BYOK tile in renderer.js without
  // updating both lists fails CI before the release tags.
  const fs = require('fs');
  const path = require('path');
  const rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  // Grab the API_KEY_PLATFORMS object literal — depth-1 brace match from
  // its declaration so trailing comments/objects don't slip in.
  const declIdx = rendererSrc.indexOf('const API_KEY_PLATFORMS = {');
  assert.ok(declIdx >= 0, 'API_KEY_PLATFORMS declaration must exist in renderer.js');
  const openBrace = rendererSrc.indexOf('{', declIdx);
  let depth = 0, end = -1;
  for (let i = openBrace; i < rendererSrc.length; i++) {
    const c = rendererSrc[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > openBrace, 'API_KEY_PLATFORMS must be a balanced object literal');
  const block = rendererSrc.slice(openBrace, end + 1);
  // Every entry has `key: 'someApiKey'` — extract them.
  const keyMatches = Array.from(block.matchAll(/\bkey:\s*'([^']+)'/g));
  assert.ok(keyMatches.length >= 5,
    `API_KEY_PLATFORMS should declare at least 5 BYOK tiles, got ${keyMatches.length}`);
  const missingFromAllowlist = [];
  const missingFromVault = [];
  for (const m of keyMatches) {
    const k = m[1];
    if (!CONFIG_FIELD_ALLOWLIST.has(k)) missingFromAllowlist.push(k);
    if (!VAULT_SENSITIVE_KEYS.includes(k)) missingFromVault.push(k);
  }
  assert.deepStrictEqual(missingFromAllowlist, [],
    `API_KEY_PLATFORMS tile key(s) not in CONFIG_FIELD_ALLOWLIST: ${missingFromAllowlist.join(', ')}. ` +
    `Magic-panel "Save" click will hit "Unknown config field" and silently fail. ` +
    `Add each key to CONFIG_FIELD_ALLOWLIST in oauth-persist.js.`);
  assert.deepStrictEqual(missingFromVault, [],
    `API_KEY_PLATFORMS tile key(s) not in VAULT_SENSITIVE_KEYS: ${missingFromVault.join(', ')}. ` +
    `Saved value would land in plaintext on disk. Add each key to VAULT_SENSITIVE_KEYS in oauth-persist.js.`);
});

test('Postscript + AppLovin tile keys are in both allowlist and vault list', () => {
  // Direct assertion on the specific keys for the v1.18.0 incident, so a
  // future contributor reading the failing test gets a clear signal.
  for (const k of ['postscriptApiKey', 'applovinMaxReportKey', 'applovinAdReportKey']) {
    assert.ok(CONFIG_FIELD_ALLOWLIST.has(k), `${k} must be in CONFIG_FIELD_ALLOWLIST`);
    assert.ok(VAULT_SENSITIVE_KEYS.includes(k), `${k} must be in VAULT_SENSITIVE_KEYS`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
