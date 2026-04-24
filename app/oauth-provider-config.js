// oauth-provider-config.js — RFC 8252 fast-click provider definitions.
//
// Mirrors the source-of-truth OAuth provider factories in
// autocmo-core/oauth.go (getMetaOAuth, getTiktokOAuth, …) for the
// click-to-browser path only. Token exchange, post-exchange discovery,
// and vault persistence stay in the Go binary — this file only provides
// the URL + state + PKCE generation that runs before the browser opens,
// so shell.openExternal fires < 50 ms after the tile click instead of
// after the 200-400 ms binary spawn that used to gate it.
//
// See the Engineering Standard section in D:\autoCMO-claude\CLAUDE.md
// for the RFC 8252 anchor. See the trace at autoCMO/app/oauth-fast-open.js
// for the surrounding HTTP-listener + callback + exchange flow.
//
// WHAT LIVES HERE (safe):
//   - OAuth endpoint URLs (public — appear in every authorize URL).
//   - Client IDs (public by RFC — appear in every authorize URL).
//   - Scope strings (public — appear in every authorize URL).
//   - Redirect URIs (public — registered with each OAuth provider).
//   - Provider display names (user-facing success page).
//
// WHAT DOES NOT LIVE HERE (Rule 2 — bulk-secret ban):
//   - Client secrets. Never. Those stay server-side in the BFF
//     (autocmo-core/landing/worker.js :/api/oauth/exchange).
//
// HOW TO ADD A NEW PROVIDER:
//   1. Add the corresponding getXxxOAuth factory in autocmo-core/oauth.go.
//   2. Add the providerToKey mapping there too.
//   3. Add a matching entry here with identical authUrl / clientId / scopes.
//   4. Add the corresponding case in autocmo-core/oauth_exchange.go's
//      RunOAuthExchangeAction routing so post-exchange discovery runs.
//   5. The parity test in oauth-provider-config.test.js fails CI if this
//      file and oauth.go drift.

'use strict';

const crypto = require('crypto');

// ── Provider table ─────────────────────────────────────────────────
//
// Every entry MUST mirror the corresponding getXxxOAuth factory in
// autocmo-core/oauth.go. Drift is caught by the parity test.
//
// Field meanings:
//   displayName     — shown on the browser "connected" page.
//   providerKey     — matches providerToKey() in oauth.go; BFF route key.
//   authUrl         — authorize endpoint. For Shopify the shop subdomain
//                     is substituted at buildAuthUrl() time.
//   clientId        — public OAuth app ID.
//   scopes          — space- or comma-separated per provider's quirks.
//   redirectUri     — where the browser lands after user approval.
//                     Empty string = localhost loopback (RFC 8252 §7.3).
//                     Non-empty HTTPS = Worker relay at merlingotme.com/auth/callback
//                     which 302s back to localhost based on the |port
//                     suffix baked into state.
//   usesPKCE        — RFC 7636. True for localhost-loopback providers
//                     (matches Go: PKCE only when provider.RedirectURI == "").
//   extraParams     — provider-specific extras (Meta config_id, Google
//                     access_type, Reddit duration, etc.).
//   amazonScopeFix  — if true, the literal `::` in the scope string is
//                     restored after querystring encoding. Matches the
//                     strings.ReplaceAll(..., "%3A%3A", "::") in oauth.go.

const PROVIDERS = {
  meta: {
    displayName: 'Meta Ads',
    providerKey: 'meta',
    authUrl: 'https://www.facebook.com/v22.0/dialog/oauth',
    clientId: '823058806852722',
    scopes: 'ads_management,pages_manage_ads,pages_read_engagement,business_management,pages_show_list',
    redirectUri: 'https://merlingotme.com/auth/callback',
    usesPKCE: false,
    extraParams: { config_id: '1258603313068894' },
  },
  tiktok: {
    displayName: 'TikTok Ads',
    providerKey: 'tiktok',
    authUrl: 'https://business-api.tiktok.com/portal/auth',
    clientId: '7626197216763314192',
    scopes: 'campaign.manage,adgroup.manage,ad.manage,creative.manage,report.read,dmp.audience.manage,account.read',
    redirectUri: 'https://merlingotme.com/auth/callback',
    usesPKCE: false,
    extraParams: { app_id: '7626197216763314192' },
  },
  google: {
    displayName: 'Google',
    providerKey: 'google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    clientId: '621539162889-6tdr07fufe97696knqvld0k62msr3di2.apps.googleusercontent.com',
    scopes: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/content',
    redirectUri: '', // loopback — any port
    usesPKCE: true,
    extraParams: { access_type: 'offline', prompt: 'consent' },
  },
  shopify: {
    displayName: 'Shopify',
    providerKey: 'shopify',
    // Auth endpoint is shop-specific — built as
    //   https://<shop>.myshopify.com/admin/oauth/authorize
    // at buildAuthUrl() time. The `shop` opts field must be a canonical
    // .myshopify.com slug (resolved by resolveShopifyShop() in
    // oauth-fast-open.js — same SSRF guard semantics as
    // resolveShopifyStore in autocmo-core/oauth.go).
    authUrlTemplate: 'https://{shop}.myshopify.com/admin/oauth/authorize',
    clientId: '79e0cd99d736273d5c3d7341e99942e5',
    scopes: 'read_analytics,read_customers,read_orders,read_products,write_products,read_content,write_content',
    // Worker relay — the Shopify Partner Dashboard pins the redirect URI
    // to merlingotme.com/auth/callback, NOT localhost. The Worker does a
    // 302 back to localhost:<port> with the port extracted from the
    // |port suffix we bake into state. See runShopifyLogin in oauth.go
    // :1562 for the canonical URL shape the binary uses today.
    redirectUri: 'https://merlingotme.com/auth/callback',
    // No PKCE — Shopify verifies the request via HMAC on the `hmac` query
    // param the Worker strips before relaying, and the BFF exchange
    // re-verifies app credentials. Mirrors the comment at oauth.go:1569
    // ("Shopify does not use PKCE in this path").
    usesPKCE: false,
    extraParams: {},
  },
  amazon: {
    displayName: 'Amazon',
    providerKey: 'amazon',
    authUrl: 'https://www.amazon.com/ap/oa',
    clientId: 'amzn1.application-oa2-client.39f768b73d734a5bae47aa9d50dc0a88',
    scopes: 'advertising::campaign_management',
    redirectUri: '', // loopback
    usesPKCE: true,
    extraParams: { response_type: 'code' },
    amazonScopeFix: true,
  },
  reddit: {
    displayName: 'Reddit',
    providerKey: 'reddit',
    authUrl: 'https://www.reddit.com/api/v1/authorize',
    clientId: 'n-HnTwFG2PwCE1gk9CjbA',
    scopes: 'ads:read ads:manage identity read submit history privatemessages',
    redirectUri: 'https://merlingotme.com/auth/callback',
    usesPKCE: false,
    extraParams: { duration: 'permanent', response_type: 'code' },
  },
  etsy: {
    displayName: 'Etsy',
    providerKey: 'etsy',
    authUrl: 'https://www.etsy.com/oauth/connect',
    clientId: 'j29lwgck6h',
    scopes: 'listings_r transactions_r shops_r',
    redirectUri: '', // loopback
    usesPKCE: true,
    extraParams: {},
  },
  linkedin: {
    displayName: 'LinkedIn Ads',
    providerKey: 'linkedin',
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    clientId: '86p3wa6kt80r7z',
    scopes: 'r_ads r_ads_reporting rw_ads r_basicprofile r_organization_social',
    redirectUri: 'https://merlingotme.com/auth/callback',
    usesPKCE: false,
    extraParams: {},
  },
  stripe: {
    displayName: 'Stripe',
    providerKey: 'stripe',
    authUrl: 'https://connect.stripe.com/oauth/authorize',
    // Merlin Stripe Connect platform ID. Public — appears on every authorize
    // URL. Same ca_ ID serves affiliate Express payouts + Standard OAuth
    // reporting. Override via cfg.OAuthStripe.ClientID from the Worker if a
    // fork needs a different ID.
    clientId: 'ca_UHt7DixMn4q8koDPH2Ya8PB8Hjv3TdAn',
    // REGRESSION GUARD (2026-04-24, Rule 9 in CLAUDE.md — Stripe scope is pinned
    // to exactly "read_only" in BOTH the factory AND the Worker). Widening
    // this string here would require widening the Worker check at
    // landing/worker.js and re-auditing stripe.go's READ-ONLY HTTP helper
    // (Rule 8). The parity test (oauth-provider-config.test.js) will fail CI
    // if this value drifts from getStripeOAuth in autocmo-core/oauth.go.
    // DO NOT widen without reading Rule 8 and Rule 9.
    scopes: 'read_only',
    redirectUri: 'https://merlingotme.com/auth/callback',
    usesPKCE: false,
    extraParams: { response_type: 'code', stripe_landing: 'login' },
  },
  slack: {
    displayName: 'Slack',
    providerKey: 'slack',
    authUrl: 'https://slack.com/oauth/v2/authorize',
    clientId: '8988877007078.10822045906036',
    scopes: 'chat:write,files:write,channels:read,channels:join,incoming-webhook',
    redirectUri: 'https://merlingotme.com/auth/callback',
    usesPKCE: false,
    extraParams: {},
  },
  // ── TODO providers ───────────────────────────────────────────────
  // Defined here for forward-compat — NOT yet wired into main.js's
  // runOAuthFlow dispatch. When a TODO provider graduates to ACTIVE,
  // add the matching case in oauth_exchange.go and remove it from the
  // TODO list in the top-level CLAUDE.md (Action / OAuth / Rate Limit
  // References section).
  klaviyo: {
    displayName: 'Klaviyo',
    providerKey: 'klaviyo',
    authUrl: 'https://www.klaviyo.com/oauth/authorize',
    clientId: '', // Not configured — Klaviyo provisions via BFF env
    scopes: 'campaigns:read campaigns:write flows:read lists:read metrics:read profiles:read',
    redirectUri: '',
    usesPKCE: true,
    extraParams: {},
  },
  pinterest: {
    displayName: 'Pinterest Ads',
    providerKey: 'pinterest',
    authUrl: 'https://www.pinterest.com/oauth/',
    clientId: '',
    scopes: 'ads:read,ads:write,boards:read,pins:read',
    redirectUri: '',
    usesPKCE: true,
    extraParams: {},
  },
  snapchat: {
    displayName: 'Snapchat Ads',
    providerKey: 'snapchat',
    authUrl: 'https://accounts.snapchat.com/login/oauth2/authorize',
    clientId: '',
    scopes: 'snapchat-marketing-api',
    redirectUri: '',
    usesPKCE: true,
    extraParams: {},
  },
  twitter: {
    displayName: 'X (Twitter) Ads',
    providerKey: 'twitter',
    authUrl: 'https://twitter.com/i/oauth2/authorize',
    clientId: '',
    scopes: 'tweet.read tweet.write users.read ads.read ads.write offline.access',
    redirectUri: '',
    usesPKCE: true,
    extraParams: {},
  },
};

// ACTIVE_PLATFORMS — the subset of PROVIDERS that main.js's runOAuthFlow
// dispatches to the fast-open path. Discord is intentionally absent
// (bot-install flow via guild_id, not a token OAuth — stays on the
// binary-login path until a future PR adds a deep-link callback model).
// Slack IS active but goes through runFastOpenOAuth like the others for
// uniform state-compare + HTML response handling.
const ACTIVE_PLATFORMS = Object.freeze([
  'meta',
  'tiktok',
  'google',
  'shopify',
  'amazon',
  'reddit',
  'etsy',
  'linkedin',
  'stripe',
  'slack',
]);

// ── State + PKCE generation ────────────────────────────────────────

// generateState — 16 random bytes, hex-encoded → 32 hex chars. Matches
// oauth.go:494-497 (rand.Read(stateBytes); state = hex.EncodeToString).
// Crypto-quality randomness via Node's crypto.randomBytes (backed by the
// OS CSPRNG — /dev/urandom on Linux/macOS, CryptGenRandom on Windows).
function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// generatePkceVerifier — 32 random bytes, base64url-encoded → 43 chars.
// RFC 7636 §4.1 requires 43-128 chars; 43 is the minimum and matches
// oauth.go:504-507 (verifierBytes := make([]byte, 32); base64.RawURLEncoding).
function generatePkceVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

// pkceChallenge — SHA-256 of the verifier, base64url-encoded. RFC 7636 §4.2
// S256 method. Matches oauth.go:509-510 (sha256.Sum256; base64.RawURLEncoding).
function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── URL builder ─────────────────────────────────────────────────────

// buildAuthUrl — constructs the authorize URL and the companion state
// material for a single OAuth attempt. Called from main.js's runOAuthFlow
// BEFORE shell.openExternal so the click-to-browser span stays < 50 ms.
//
// opts:
//   platform   — key in PROVIDERS (required).
//   localPort  — port the local HTTP listener is bound to (required for
//                Worker-relay providers; used as the |port suffix in state
//                so the Worker knows where to 302 back to). For pure-
//                loopback providers the port appears directly in
//                redirect_uri.
//   shop       — canonical .myshopify.com slug (required for Shopify only).
//
// Returns:
//   { authUrl, state, pkceVerifier, redirectUri, providerKey, displayName }
function buildAuthUrl(platform, opts = {}) {
  const cfg = PROVIDERS[platform];
  if (!cfg) {
    throw new Error(`oauth-provider-config: unknown platform "${platform}"`);
  }

  const { localPort, shop } = opts;
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
    throw new Error(`oauth-provider-config: invalid localPort ${localPort}`);
  }

  const baseState = generateState();
  const pkceVerifier = cfg.usesPKCE ? generatePkceVerifier() : '';
  const challenge = cfg.usesPKCE ? pkceChallenge(pkceVerifier) : '';

  // Pick redirect_uri: Worker-relay if provider registered a fixed HTTPS
  // URL, else loopback with the ephemeral port. Matches the branching at
  // oauth.go:650-655.
  let redirectUri;
  let authState;
  if (cfg.redirectUri) {
    redirectUri = cfg.redirectUri;
    // Encode the local port so the Worker at merlingotme.com/auth/callback
    // can 302 back to the right localhost listener — see worker.js:1403-1424.
    // The /callback handler in oauth-fast-open.js strips the |port suffix
    // before comparing state constant-time.
    authState = `${baseState}|${localPort}`;
  } else {
    redirectUri = `http://127.0.0.1:${localPort}/callback`;
    authState = baseState;
  }

  // Build the authorize URL. For Shopify the host contains the shop slug;
  // everything else uses a fixed authUrl.
  let authEndpoint;
  if (platform === 'shopify') {
    if (!shop || !/^[a-z0-9][a-z0-9-]*$/.test(shop)) {
      throw new Error(`oauth-provider-config: shopify requires a valid .myshopify.com slug, got "${shop}"`);
    }
    authEndpoint = cfg.authUrlTemplate.replace('{shop}', shop);
  } else {
    authEndpoint = cfg.authUrl;
  }

  // Query params — mirror oauth.go:657-678 ordering and encoding.
  const params = new URLSearchParams();
  params.set('client_id', cfg.clientId);
  params.set('redirect_uri', redirectUri);
  params.set('response_type', 'code');
  params.set('state', authState);
  if (cfg.usesPKCE) {
    params.set('code_challenge', challenge);
    params.set('code_challenge_method', 'S256');
  }
  if (cfg.scopes) {
    params.set('scope', cfg.scopes);
  }
  for (const [k, v] of Object.entries(cfg.extraParams || {})) {
    params.set(k, v);
  }

  let encoded = params.toString();
  // Amazon's scope uses :: which must NOT be percent-encoded per their API.
  // Matches oauth.go:676-677 (strings.ReplaceAll(encoded, "%3A%3A", "::")).
  if (cfg.amazonScopeFix) {
    encoded = encoded.replace(/%3A%3A/g, '::');
  }

  return {
    authUrl: `${authEndpoint}?${encoded}`,
    state: baseState,
    authState,
    pkceVerifier,
    redirectUri,
    providerKey: cfg.providerKey,
    displayName: cfg.displayName,
    localPort,
  };
}

module.exports = {
  PROVIDERS,
  ACTIVE_PLATFORMS,
  generateState,
  generatePkceVerifier,
  pkceChallenge,
  buildAuthUrl,
};
