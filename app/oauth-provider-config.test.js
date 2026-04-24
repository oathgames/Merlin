// Unit tests for oauth-provider-config.js. Run with
//   node app/oauth-provider-config.test.js
//
// Parity with autocmo-core/oauth.go is enforced at two levels:
//   1. Structural — every ACTIVE provider has the required config fields.
//   2. Content — the authorize URL built in Node matches the shape Go
//      would build via runOAuthWithResume for the same provider.
//
// Regression guards (cross-references to CLAUDE.md rules):
//   - Rule 9: Stripe scope MUST be exactly "read_only" (here AND in the
//     Worker AND in the Go factory — three places, all pinned).
//   - Rule 3: state is generated fresh per call; the Node constant-time
//     compare lives in oauth-fast-open.js.
//   - RFC 7636: PKCE verifiers are 43-chars minimum, base64url.

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  PROVIDERS,
  ACTIVE_PLATFORMS,
  generateState,
  generatePkceVerifier,
  pkceChallenge,
  buildAuthUrl,
} = require('./oauth-provider-config');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  \u2713', name);
    passed++;
  } catch (err) {
    console.log('  \u2717', name);
    console.log('    ', err.message);
    failed++;
  }
}

function parseUrl(u) {
  const x = new URL(u);
  const params = {};
  for (const [k, v] of x.searchParams.entries()) params[k] = v;
  return { host: x.host, pathname: x.pathname, params };
}

// ── Structural checks ───────────────────────────────────────────────

test('PROVIDERS has entries for all 10 fast-open targets', () => {
  const expected = ['meta', 'tiktok', 'google', 'shopify', 'amazon', 'reddit', 'etsy', 'linkedin', 'stripe', 'slack'];
  for (const p of expected) {
    assert.ok(PROVIDERS[p], `missing provider: ${p}`);
  }
});

test('ACTIVE_PLATFORMS contains exactly the 10 live providers', () => {
  const expected = ['meta', 'tiktok', 'google', 'shopify', 'amazon', 'reddit', 'etsy', 'linkedin', 'stripe', 'slack'];
  assert.deepStrictEqual([...ACTIVE_PLATFORMS].sort(), expected.sort());
});

test('Every provider has required fields', () => {
  for (const [key, cfg] of Object.entries(PROVIDERS)) {
    assert.ok(cfg.displayName, `${key}: displayName missing`);
    assert.ok(cfg.providerKey, `${key}: providerKey missing`);
    assert.ok(cfg.scopes || cfg.scopes === '', `${key}: scopes missing`);
    assert.ok(typeof cfg.usesPKCE === 'boolean', `${key}: usesPKCE not bool`);
    // Shopify's authUrl is a template; everyone else has authUrl.
    const hasEndpoint = Boolean(cfg.authUrl) || Boolean(cfg.authUrlTemplate);
    assert.ok(hasEndpoint, `${key}: no authUrl or authUrlTemplate`);
  }
});

// ── Rule 9: Stripe scope guard ──────────────────────────────────────

test('Stripe scope is pinned to exactly "read_only" (Rule 9)', () => {
  assert.strictEqual(PROVIDERS.stripe.scopes, 'read_only');
});

test('Stripe scope parity with autocmo-core/oauth.go getStripeOAuth', () => {
  // Source-scan: getStripeOAuth in oauth.go MUST also pin scope to read_only.
  // Drift between Node and Go is the core concern of Rule 9 — both sides
  // need to agree or the Worker's re-verification will fire on every login.
  const goSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'autocmo-core', 'oauth.go'),
    'utf8'
  );
  const stripeFactory = goSrc.match(/func getStripeOAuth[\s\S]*?^}/m);
  assert.ok(stripeFactory, 'getStripeOAuth not found in oauth.go');
  assert.ok(
    /Scopes:\s*"read_only"/.test(stripeFactory[0]),
    'Go factory does not pin Scopes: "read_only" — Rule 9 violation'
  );
});

// ── RFC 7636: PKCE verifier length + charset ────────────────────────

test('generatePkceVerifier produces 43-char base64url string', () => {
  for (let i = 0; i < 20; i++) {
    const v = generatePkceVerifier();
    assert.strictEqual(v.length, 43, `verifier length ${v.length} != 43`);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(v), `verifier contains non-base64url char: ${v}`);
  }
});

test('pkceChallenge produces 43-char base64url S256 digest', () => {
  const v = generatePkceVerifier();
  const c = pkceChallenge(v);
  assert.strictEqual(c.length, 43);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(c));
  // Deterministic — same verifier → same challenge.
  assert.strictEqual(pkceChallenge(v), c);
});

test('pkceChallenge matches Go: sha256(verifier) base64url-encoded', () => {
  // Reference vector from RFC 7636 §4.2.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  assert.strictEqual(pkceChallenge(verifier), expected);
});

// ── State format ────────────────────────────────────────────────────

test('generateState produces 32-hex string', () => {
  for (let i = 0; i < 20; i++) {
    const s = generateState();
    assert.strictEqual(s.length, 32);
    assert.ok(/^[0-9a-f]{32}$/.test(s));
  }
});

// ── buildAuthUrl per-provider ───────────────────────────────────────

test('buildAuthUrl: Meta — URL shape + Worker redirect + no PKCE', () => {
  const { authUrl, state, authState, pkceVerifier, redirectUri } = buildAuthUrl('meta', { localPort: 54321 });
  const u = parseUrl(authUrl);
  assert.strictEqual(u.host, 'www.facebook.com');
  assert.strictEqual(u.pathname, '/v22.0/dialog/oauth');
  assert.strictEqual(u.params.client_id, '823058806852722');
  assert.strictEqual(u.params.redirect_uri, 'https://merlingotme.com/auth/callback');
  assert.strictEqual(u.params.config_id, '1258603313068894');
  assert.strictEqual(u.params.response_type, 'code');
  assert.strictEqual(u.params.state, `${state}|54321`);
  assert.strictEqual(authState, `${state}|54321`);
  assert.strictEqual(pkceVerifier, ''); // no PKCE for Meta
  assert.strictEqual(redirectUri, 'https://merlingotme.com/auth/callback');
  assert.ok(!('code_challenge' in u.params), 'no code_challenge expected for Meta');
});

test('buildAuthUrl: TikTok — app_id extra param + Worker redirect', () => {
  const { authUrl } = buildAuthUrl('tiktok', { localPort: 54321 });
  const u = parseUrl(authUrl);
  assert.strictEqual(u.host, 'business-api.tiktok.com');
  assert.strictEqual(u.params.client_id, '7626197216763314192');
  assert.strictEqual(u.params.app_id, '7626197216763314192');
});

test('buildAuthUrl: Google — PKCE + loopback + access_type=offline', () => {
  const { authUrl, pkceVerifier, redirectUri } = buildAuthUrl('google', { localPort: 54321 });
  const u = parseUrl(authUrl);
  assert.strictEqual(u.host, 'accounts.google.com');
  assert.strictEqual(u.params.redirect_uri, 'http://127.0.0.1:54321/callback');
  assert.strictEqual(u.params.access_type, 'offline');
  assert.strictEqual(u.params.prompt, 'consent');
  assert.ok(u.params.code_challenge, 'PKCE challenge expected');
  assert.strictEqual(u.params.code_challenge_method, 'S256');
  assert.ok(pkceVerifier.length === 43);
  assert.strictEqual(redirectUri, 'http://127.0.0.1:54321/callback');
});

test('buildAuthUrl: Shopify — requires valid slug + uses shop-specific host', () => {
  const { authUrl, redirectUri } = buildAuthUrl('shopify', { localPort: 54321, shop: 'mad-chill' });
  const u = parseUrl(authUrl);
  assert.strictEqual(u.host, 'mad-chill.myshopify.com');
  assert.strictEqual(u.pathname, '/admin/oauth/authorize');
  assert.strictEqual(redirectUri, 'https://merlingotme.com/auth/callback');
  assert.ok(!('code_challenge' in u.params), 'Shopify does not use PKCE');

  assert.throws(
    () => buildAuthUrl('shopify', { localPort: 54321, shop: 'invalid slug with spaces' }),
    /shopify requires a valid/,
  );
  assert.throws(
    () => buildAuthUrl('shopify', { localPort: 54321 }),
    /shopify requires a valid/,
  );
});

test('buildAuthUrl: Amazon — :: preserved, not percent-encoded', () => {
  const { authUrl } = buildAuthUrl('amazon', { localPort: 54321 });
  assert.ok(
    authUrl.includes('advertising::campaign_management'),
    'expected literal :: in Amazon scope'
  );
  assert.ok(
    !authUrl.includes('advertising%3A%3Acampaign_management'),
    'Amazon scope must NOT be percent-encoded'
  );
});

test('buildAuthUrl: Reddit — duration=permanent + Worker redirect', () => {
  const { authUrl } = buildAuthUrl('reddit', { localPort: 54321 });
  const u = parseUrl(authUrl);
  assert.strictEqual(u.params.duration, 'permanent');
  assert.strictEqual(u.params.redirect_uri, 'https://merlingotme.com/auth/callback');
});

test('buildAuthUrl: Etsy — loopback + PKCE', () => {
  const { authUrl, pkceVerifier } = buildAuthUrl('etsy', { localPort: 54321 });
  const u = parseUrl(authUrl);
  assert.strictEqual(u.host, 'www.etsy.com');
  assert.ok(u.params.code_challenge);
  assert.strictEqual(pkceVerifier.length, 43);
});

test('buildAuthUrl: Stripe — stripe_landing=login + Worker redirect + read_only', () => {
  const { authUrl } = buildAuthUrl('stripe', { localPort: 54321 });
  const u = parseUrl(authUrl);
  assert.strictEqual(u.host, 'connect.stripe.com');
  assert.strictEqual(u.params.scope, 'read_only');
  assert.strictEqual(u.params.stripe_landing, 'login');
});

test('buildAuthUrl: Slack — no PKCE + Worker redirect', () => {
  const { authUrl, pkceVerifier } = buildAuthUrl('slack', { localPort: 54321 });
  const u = parseUrl(authUrl);
  assert.strictEqual(u.host, 'slack.com');
  assert.strictEqual(u.params.redirect_uri, 'https://merlingotme.com/auth/callback');
  assert.strictEqual(pkceVerifier, '');
});

test('buildAuthUrl: unknown platform rejects', () => {
  assert.throws(() => buildAuthUrl('notarealplatform', { localPort: 54321 }), /unknown platform/);
});

test('buildAuthUrl: invalid localPort rejects', () => {
  assert.throws(() => buildAuthUrl('meta', {}), /invalid localPort/);
  assert.throws(() => buildAuthUrl('meta', { localPort: 100 }), /invalid localPort/);
  assert.throws(() => buildAuthUrl('meta', { localPort: 99999 }), /invalid localPort/);
  assert.throws(() => buildAuthUrl('meta', { localPort: 'notanumber' }), /invalid localPort/);
});

// ── authState vs state semantics ────────────────────────────────────

test('Worker-relay providers: authState carries |port; state does not', () => {
  // Meta, TikTok, Reddit, LinkedIn, Stripe, Slack, Shopify all use the
  // Worker relay. The authorize URL carries state|port so the Worker can
  // route the callback back to the right local listener; the base state
  // (no suffix) is what the /callback handler's constant-time compare
  // checks against AFTER the Worker strips |port.
  for (const p of ['meta', 'tiktok', 'reddit', 'linkedin', 'stripe', 'slack', 'shopify']) {
    const opts = p === 'shopify' ? { localPort: 54321, shop: 'mad-chill' } : { localPort: 54321 };
    const { state, authState } = buildAuthUrl(p, opts);
    assert.notStrictEqual(state, authState, `${p}: state and authState should differ for Worker-relay`);
    assert.ok(authState.endsWith('|54321'), `${p}: authState should end with |54321`);
    assert.strictEqual(state.length, 32, `${p}: state should be plain 32-hex`);
  }
});

test('Loopback providers: authState === state (no |port suffix)', () => {
  for (const p of ['google', 'amazon', 'etsy']) {
    const { state, authState } = buildAuthUrl(p, { localPort: 54321 });
    assert.strictEqual(state, authState, `${p}: loopback providers have authState === state`);
  }
});

// ── Determinism ─────────────────────────────────────────────────────

test('Two buildAuthUrl calls produce different state + pkceVerifier', () => {
  const a = buildAuthUrl('google', { localPort: 54321 });
  const b = buildAuthUrl('google', { localPort: 54321 });
  assert.notStrictEqual(a.state, b.state);
  assert.notStrictEqual(a.pkceVerifier, b.pkceVerifier);
});

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
