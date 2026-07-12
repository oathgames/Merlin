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

test('ACTIVE_PLATFORMS contains exactly the 9 fast-open providers (no Shopify)', () => {
  // Shopify is intentionally OMITTED — App Store §2.3.1 forbids the
  // localhost-listener fast-open path. Shopify install routes through
  // the merlin:// custom protocol + shopify-handoff binary action
  // instead. The absence is also pinned by
  // app/shopify-app-review.test.js → "ACTIVE_PLATFORMS does not
  // include shopify". Keep both pins; they catch the regression at
  // different layers (this one fails on count drift, the other fails
  // on a specific 'shopify' add-back).
  const expected = ['meta', 'tiktok', 'google', 'amazon', 'reddit', 'etsy', 'linkedin', 'stripe', 'slack'];
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
  //
  // Skip when the sibling autocmo-core/ checkout isn't on disk — matches the
  // pattern used in autocmo-core/oauth_exchange_test.go (PR #88) for Go-side
  // mirror checks. CI lanes and --app-only session worktrees only check out
  // one repo; the parity check still runs in any environment that has both
  // siblings, which is every dev workstation and the full-monorepo CI lane.
  const goPath = path.join(__dirname, '..', '..', 'autocmo-core', 'oauth.go');
  let goSrc;
  try {
    goSrc = fs.readFileSync(goPath, 'utf8');
  } catch (err) {
    // Sibling repo absent — log and skip without failing the suite. The
    // test runner has no native skip primitive, so the conditional return
    // is the equivalent.
    console.log('     (skipped: autocmo-core/oauth.go not on disk — sibling repo absent)');
    return;
  }
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

test('buildAuthUrl: Meta — URL shape + Worker redirect + no PKCE + no config_id', () => {
  // REGRESSION GUARD (2026-05-09, meta-config-id-fast-open):
  // The previous version of this test asserted config_id === '1258603313068894'
  // — pinning the FBLB Configuration ID into every Meta OAuth URL by default.
  // That config_id silently routed users through the FBLB-Configuration-gated
  // flow, which had its own approval state separate from the parent app's
  // Live status. Live anchor: 2026-05-09 — Mac users hitting "Feature
  // Unavailable" because Meta's strict checks refused the FBLB-gated flow
  // even though standard FB Login (which is what we WANT to use) was Live.
  // PR #167 dropped config_id from autocmo-core/oauth.go's getMetaOAuth on
  // 2026-05-09 morning; this commit completes the same fix on the JS side.
  // The assertion now anti-asserts config_id's PRESENCE.
  const { authUrl, state, authState, pkceVerifier, redirectUri } = buildAuthUrl('meta', { localPort: 54321 });
  const u = parseUrl(authUrl);
  assert.strictEqual(u.host, 'www.facebook.com');
  assert.strictEqual(u.pathname, '/v24.0/dialog/oauth');
  assert.strictEqual(u.params.client_id, '823058806852722');
  assert.strictEqual(u.params.redirect_uri, 'https://merlingotme.com/auth/callback');
  assert.ok(
    !('config_id' in u.params),
    'Meta OAuth URL must NOT carry a default config_id — the FBLB Configuration has its own approval state separate from the parent app, which silently surfaces as "Feature Unavailable" for users tripping Meta\'s strict checks. See REGRESSION GUARD in oauth-provider-config.js extraParams comment block.',
  );
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

// ── Cross-file scope parity (REGRESSION GUARD 2026-05-09) ──────────
//
// fast-open-google-scope incident: oauth-provider-config.js's `google.scopes`
// silently drifted from autocmo-core/oauth.go's getGoogleOAuth().Scopes.
// The fast-open path (this file) is the default for Google in the Merlin UI;
// the binary path (oauth.go) is a legacy fallback for un-ported providers.
// When the 2026-05-01 ga-scope-readonly-downgrade added analytics.readonly
// to oauth.go, this file was missed. Every UI-driven Google OAuth silently
// dropped the scope; only direct binary calls (which bypass fast-open)
// requested all 4 scopes. The two-source-of-truth desync ate ~8 hours of
// debugging.
//
// This test reads BOTH source files at runtime, parses out the Google scope
// string from each, and asserts they're set-equal. Adding/removing scopes
// in one place without the other now fails CI immediately.

test('REGRESSION 2026-05-09: Google scopes match between oauth-provider-config.js and autocmo-core/oauth.go', () => {
  const fastOpenScopes = PROVIDERS.google.scopes
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();

  // oauth.go lives in the sibling autocmo-core repo. Resolve via the
  // workspace-root pattern (sessions/<topic>/{autoCMO,autocmo-core} layout
  // and base-worktree {autoCMO,autocmo-core} layout both work — the relative
  // hop is ../../autocmo-core/oauth.go from app/).
  const oauthGoPath = path.resolve(__dirname, '..', '..', 'autocmo-core', 'oauth.go');
  if (!fs.existsSync(oauthGoPath)) {
    // CI runs the JS suite from autoCMO checkout only; skip the cross-repo
    // check there. The mirror test in autocmo-core (oauth_google_scope_parity_test.go)
    // catches drift from the Go side. Both halves of the parity guard ship
    // in the same commit so neither side can drift without the other firing.
    console.log('    (skipping — oauth.go not adjacent; Go-side mirror test handles it)');
    return;
  }

  const oauthGoSrc = fs.readFileSync(oauthGoPath, 'utf8');
  // Extract the Scopes string literal from getGoogleOAuth(). Anchored to
  // the function name to avoid false matches in adjacent factories.
  const fnAnchor = 'func getGoogleOAuth(';
  const fnStart = oauthGoSrc.indexOf(fnAnchor);
  assert.ok(fnStart > 0, 'oauth.go must contain func getGoogleOAuth(');
  // Bound by next "func " to keep the slice tight.
  const fnEnd = oauthGoSrc.indexOf('\nfunc ', fnStart + fnAnchor.length);
  const fnBody = fnEnd > 0 ? oauthGoSrc.slice(fnStart, fnEnd) : oauthGoSrc.slice(fnStart);
  // The Scopes line in Go is `Scopes:       "https://...auth/foo https://...auth/bar"`.
  const m = fnBody.match(/Scopes:\s*"([^"]+)"/);
  assert.ok(m && m[1], 'oauth.go getGoogleOAuth must have a Scopes: "..." line');
  const binaryScopes = m[1]
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();

  assert.deepStrictEqual(
    fastOpenScopes,
    binaryScopes,
    'fast-open google.scopes (oauth-provider-config.js) and binary getGoogleOAuth().Scopes (oauth.go) must contain the same set of scopes. Drift = silent UX failure: the fast-open URL the renderer sends to Google will be missing whichever scope was added/removed only on the other side, and Google will silently drop or include it. See REGRESSION GUARD comment block at oauth-provider-config.js:google.scopes for the live incident anchor (2026-05-08 → 05-09, fast-open-google-scope).',
  );
});

// ── Cross-file ExtraParams parity (REGRESSION GUARD 2026-05-09) ────
//
// meta-config-id-fast-open incident: fast-open Meta entry hardcoded
// `extraParams: { config_id: '1258603313068894' }`, but the binary's
// getMetaOAuth had ALREADY dropped this default in v1.21.27 (PR #167)
// after Meta's FBLB Configuration approval state diverged from the
// app's Live status, surfacing "Feature Unavailable" to users.
// PR #167 fixed the binary side. The JS fast-open side was never
// touched. Every UI-driven Meta OAuth (which uses fast-open by default)
// kept routing through the FBLB-gated flow for ANOTHER day, surfacing
// "Feature Unavailable" again on 2026-05-09 — same root cause as
// the Google scope drift. Same class of bug.
//
// The Google scope parity test above only covered scopes — extraParams
// was a separate drift vector that nothing checked. This test extends
// the parity to cover EVERY provider's extraParams keys, comparing
// the fast-open extraParams object to the binary's ExtraParams map
// in the corresponding factory function.
//
// Why parity is per-key, not per-value:
//   - The binary may apply extraParams conditionally (cfg.OAuth*.Foo
//     overrides, env-var defaults). Comparing values would flag
//     intentional conditionality.
//   - What matters for "no surprise default" is that both sides
//     advertise the SAME SET of always-set keys.
//
// Skips per-provider when the binary side has clearly-dynamic keys
// (e.g. "scope" assembly via concatenation) — the test focuses on
// hardcoded-default keys like config_id, app_id, prompt, access_type.

test('REGRESSION 2026-05-09: ExtraParams keys match between oauth-provider-config.js and oauth.go for every active provider', () => {
  const oauthGoPath = path.resolve(__dirname, '..', '..', 'autocmo-core', 'oauth.go');
  if (!fs.existsSync(oauthGoPath)) {
    console.log('    (skipping — oauth.go not adjacent; Go-side mirror test handles it)');
    return;
  }
  const oauthGoSrc = fs.readFileSync(oauthGoPath, 'utf8');

  // Map fast-open provider key → Go factory function name.
  const goFactoryName = {
    meta: 'getMetaOAuth',
    tiktok: 'getTiktokOAuth',
    google: 'getGoogleOAuth',
    shopify: 'getShopifyOAuth',
    amazon: 'getAmazonOAuth',
    reddit: 'getRedditOAuth',
    etsy: 'getEtsyOAuth',
    linkedin: 'getLinkedInOAuth', // capital I matches Go convention
    stripe: 'getStripeOAuth',
    slack: 'getSlackOAuth',
  };

  const drift = [];
  for (const [providerKey, fnName] of Object.entries(goFactoryName)) {
    const provider = PROVIDERS[providerKey];
    if (!provider) continue;
    const fastOpenKeys = Object.keys(provider.extraParams || {}).sort();

    const fnAnchor = `func ${fnName}(`;
    const fnStart = oauthGoSrc.indexOf(fnAnchor);
    if (fnStart < 0) {
      drift.push(`${providerKey}: oauth.go missing ${fnAnchor}`);
      continue;
    }
    const fnEnd = oauthGoSrc.indexOf('\nfunc ', fnStart + fnAnchor.length);
    const fnBody = fnEnd > 0 ? oauthGoSrc.slice(fnStart, fnEnd) : oauthGoSrc.slice(fnStart);

    // Locate the FIRST ExtraParams literal — the default. Conditional
    // overrides later in the function (e.g. `if cfg.X != "" { p.ExtraParams = ... }`)
    // are intentional opt-ins, not drift.
    //
    // Match shapes accepted:
    //   ExtraParams: map[string]string{},
    //   ExtraParams: map[string]string{"key": "..."},
    //   ExtraParams: map[string]string{"k1":"v1","k2":"v2"},
    //   ExtraParams:  nil,
    const extraMatch = fnBody.match(/ExtraParams:\s*(?:nil|map\[string\]string\{([^}]*)\})/);
    if (!extraMatch) {
      // Function has no default ExtraParams field — treat as empty.
      if (fastOpenKeys.length > 0) {
        drift.push(`${providerKey}: fast-open declares extraParams keys [${fastOpenKeys.join(', ')}] but oauth.go's ${fnName} has NO ExtraParams default field`);
      }
      continue;
    }
    const inner = extraMatch[1] || '';
    // Extract keys from `"key": "value"` pairs.
    const keyRe = /"([^"]+)"\s*:\s*"[^"]*"/g;
    const binaryKeys = [];
    let km;
    while ((km = keyRe.exec(inner)) !== null) {
      binaryKeys.push(km[1]);
    }
    binaryKeys.sort();

    if (JSON.stringify(fastOpenKeys) !== JSON.stringify(binaryKeys)) {
      drift.push(
        `${providerKey}: fast-open extraParams keys = [${fastOpenKeys.join(', ')}], ` +
        `binary ${fnName} default ExtraParams keys = [${binaryKeys.join(', ')}]`
      );
    }
  }

  if (drift.length > 0) {
    throw new Error(
      'ExtraParams parity failure between oauth-provider-config.js (fast-open) and ' +
      'autocmo-core/oauth.go (binary). Live anchor: 2026-05-09 meta-config-id-fast-open ' +
      'incident — fast-open Meta entry kept config_id long after the binary dropped it, ' +
      'surfacing "Feature Unavailable" to users tripping Meta\'s strict checks.\n\n' +
      'Drift detected:\n  ' + drift.join('\n  ')
    );
  }
});

// ── COMPREHENSIVE cross-file parity (REGRESSION GUARD 2026-05-09) ──
//
// Defense-in-depth uber-test that audits EVERY shared data shape between
// oauth-provider-config.js and autocmo-core/oauth.go for EVERY active
// provider. Live anchor: the 2026-05-08→09 24-hour incident in which we
// shipped THREE separate two-source-of-truth fixes:
//
//   - 2026-05-08: Google scope drift (PR #235) — fast-open scopes missed
//     the analytics.readonly addition. 8-day silent failure window.
//   - 2026-05-09: Meta config_id drift (PR #240) — fast-open extraParams
//     kept the FBLB config_id long after the binary dropped it. Caused
//     "Feature Unavailable" for non-admin users.
//   - 2026-05-09: ExtraParams parity test added (extends the original
//     scope parity to cover the broader extraParams class).
//
// The Phase A audit on 2026-05-09 morning confirmed scope parity but
// MISSED extraParams. This test closes ALL OTHER drift vectors at once
// — clientId, authUrl, usesPKCE, and redirectUri — so any future change
// to oauth.go or oauth-provider-config.js that touches a shared field
// without matching the other side fails CI immediately.
//
// Per-field rationale:
//   clientId   — public OAuth app ID. Drift = wrong app receives the
//                authorize request; users see "App not found" or
//                config_id-style mismatch errors.
//   authUrl    — authorize endpoint. Drift = browser opens to a 404
//                or wrong provider entirely.
//   usesPKCE   — RFC 7636. Binary derives this from RedirectURI being
//                empty (loopback only); JS declares it explicitly. Drift
//                = either side adds code_challenge that the other side
//                doesn't expect to verify, or omits it when needed.
//   redirectUri — RFC 8252 §7.3. Loopback (empty) vs Worker-relay
//                 (https://merlingotme.com/auth/callback). Drift =
//                 OAuth provider rejects the redirect_uri as unregistered.
//
// Skipped: token URL (binary-only), client secret (Hard-Won Rule 2 —
// stays server-side), Shopify (uses a different binary code path
// entirely; intentionally omitted from ACTIVE_PLATFORMS, see
// REGRESSION GUARD comment at the array decl).

test('REGRESSION 2026-05-09: COMPREHENSIVE parity (clientId, authUrl, usesPKCE, redirectUri) for every active provider', () => {
  const oauthGoPath = path.resolve(__dirname, '..', '..', 'autocmo-core', 'oauth.go');
  if (!fs.existsSync(oauthGoPath)) {
    console.log('    (skipping — oauth.go not adjacent; Go-side mirror test handles it)');
    return;
  }
  const oauthGoSrc = fs.readFileSync(oauthGoPath, 'utf8');

  // Map fast-open provider key → Go factory function name.
  // Shopify uses a different binary code path (runShopifyLogin) so it's
  // NOT validated by this generic test — its parity is enforced by
  // shopify_handoff.go-specific tests.
  const goFactoryName = {
    meta: 'getMetaOAuth',
    tiktok: 'getTiktokOAuth',
    google: 'getGoogleOAuth',
    amazon: 'getAmazonOAuth',
    reddit: 'getRedditOAuth',
    etsy: 'getEtsyOAuth',
    linkedin: 'getLinkedInOAuth',
    stripe: 'getStripeOAuth',
    slack: 'getSlackOAuth',
  };

  function extractGoField(fnBody, fieldName) {
    const re = new RegExp(`\\b${fieldName}:\\s*"([^"]*)"`);
    const m = fnBody.match(re);
    return m ? m[1] : null;
  }

  // 2026-07 oauth.go refactor: the ten literal
  // "https://merlingotme.com/auth/callback" strings became a single
  // `const oauthRedirectURI = "..."` referenced as
  // `RedirectURI: oauthRedirectURI` in each factory. Resolve that const
  // here so the parity guarantee is UNCHANGED: the JS redirectUri literal
  // must still equal the exact URL the binary registers. Fail closed on
  // anything unresolvable (unknown identifier, missing const) so a rename
  // or indirection on the Go side surfaces as drift, never as a silent
  // "loopback" misread.
  const goRedirectConstMatch = oauthGoSrc.match(/\bconst\s+oauthRedirectURI\s*=\s*"([^"]*)"/);
  const goRedirectConstValue = goRedirectConstMatch ? goRedirectConstMatch[1] : null;

  function extractGoRedirectURI(body) {
    const lit = body.match(/\bRedirectURI:\s*"([^"]*)"/);
    if (lit) return lit[1];
    const ref = body.match(/\bRedirectURI:\s*([A-Za-z_]\w*)/);
    if (ref) {
      if (ref[1] === 'oauthRedirectURI' && goRedirectConstValue !== null) {
        return goRedirectConstValue;
      }
      // Unknown identifier or const not found: return a sentinel that can
      // never equal a JS redirectUri, forcing a visible drift entry.
      return `<unresolved Go identifier: ${ref[1]}>`;
    }
    return null; // field absent = loopback convention
  }

  function fnBody(fnName) {
    const fnAnchor = `func ${fnName}(`;
    const fnStart = oauthGoSrc.indexOf(fnAnchor);
    if (fnStart < 0) return null;
    const fnEnd = oauthGoSrc.indexOf('\nfunc ', fnStart + fnAnchor.length);
    return fnEnd > 0 ? oauthGoSrc.slice(fnStart, fnEnd) : oauthGoSrc.slice(fnStart);
  }

  const drift = [];

  for (const [providerKey, fnName] of Object.entries(goFactoryName)) {
    const provider = PROVIDERS[providerKey];
    if (!provider) {
      drift.push(`${providerKey}: missing from PROVIDERS map`);
      continue;
    }
    const body = fnBody(fnName);
    if (!body) {
      drift.push(`${providerKey}: oauth.go missing func ${fnName}`);
      continue;
    }

    // ── clientId parity ──────────────────────────────────────────
    const goClientID = extractGoField(body, 'ClientID');
    if (goClientID !== null && provider.clientId !== goClientID) {
      drift.push(`${providerKey}: clientId mismatch — fast-open="${provider.clientId}", binary="${goClientID}"`);
    }

    // ── authUrl parity ───────────────────────────────────────────
    const goAuthURL = extractGoField(body, 'AuthURL');
    if (goAuthURL !== null && provider.authUrl && provider.authUrl !== goAuthURL) {
      drift.push(`${providerKey}: authUrl mismatch — fast-open="${provider.authUrl}", binary="${goAuthURL}"`);
    }

    // ── scopes parity (set equality, separator-tolerant) ─────────
    const goScopes = extractGoField(body, 'Scopes');
    if (goScopes !== null) {
      const norm = (s) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean).sort();
      const fastSet = norm(provider.scopes || '');
      const binarySet = norm(goScopes);
      if (JSON.stringify(fastSet) !== JSON.stringify(binarySet)) {
        drift.push(`${providerKey}: scopes mismatch — fast-open=[${fastSet.join(',')}], binary=[${binarySet.join(',')}]`);
      }
    }

    // ── redirectUri parity ───────────────────────────────────────
    // Convention:
    //   loopback → JS redirectUri="" AND Go has NO RedirectURI field
    //              (or RedirectURI="" — both express loopback in Go's
    //              runOAuthWithResume which constructs http://localhost:<port>/callback).
    //   worker-relay → JS redirectUri="https://...callback" AND Go has
    //                  matching RedirectURI literal or the shared
    //                  oauthRedirectURI const (resolved above).
    const goRedirectURI = extractGoRedirectURI(body);
    const fastIsLoopback = !provider.redirectUri;
    const binaryIsLoopback = goRedirectURI === null || goRedirectURI === '';
    if (fastIsLoopback !== binaryIsLoopback) {
      drift.push(`${providerKey}: redirect convention mismatch — fast-open ${fastIsLoopback ? 'loopback' : 'worker-relay'}, binary ${binaryIsLoopback ? 'loopback' : 'worker-relay'}`);
    } else if (!fastIsLoopback && goRedirectURI && provider.redirectUri !== goRedirectURI) {
      drift.push(`${providerKey}: redirectUri value mismatch — fast-open="${provider.redirectUri}", binary="${goRedirectURI}"`);
    }

    // ── usesPKCE parity ──────────────────────────────────────────
    // Binary derives PKCE from RedirectURI being empty (loopback only).
    // JS declares it explicitly. They must agree.
    const binaryUsesPKCE = binaryIsLoopback;
    if (provider.usesPKCE !== binaryUsesPKCE) {
      drift.push(`${providerKey}: usesPKCE mismatch — fast-open=${provider.usesPKCE}, binary derives ${binaryUsesPKCE} from RedirectURI emptiness`);
    }
  }

  if (drift.length > 0) {
    throw new Error(
      'COMPREHENSIVE OAuth parity failure between oauth-provider-config.js (fast-open) and ' +
      'autocmo-core/oauth.go (binary). Fields checked: clientId, authUrl, scopes, redirectUri, ' +
      'usesPKCE. Live anchor: 2026-05-09 incident bundle (Google scope drift PR #235, Meta ' +
      'config_id drift PR #240, this comprehensive guard PR).\n\nDrift detected:\n  ' +
      drift.join('\n  ')
    );
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
