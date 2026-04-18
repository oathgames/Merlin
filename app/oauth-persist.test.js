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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
