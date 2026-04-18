// OAuth persistence helpers. Pure functions extracted from main.js so they
// can be unit-tested without booting the Electron runtime. Imported by main.js
// at module load; the actual vaultPut side-effect is injected from the caller.

const VAULT_SENSITIVE_KEYS = [
  'metaAccessToken',
  'tiktokAccessToken',
  'tiktokRefreshToken',
  'googleAccessToken',
  'googleRefreshToken',
  'shopifyAccessToken',
  'klaviyoAccessToken',
  'klaviyoRefreshToken',
  'klaviyoApiKey',
  'amazonAccessToken',
  'amazonRefreshToken',
  'pinterestAccessToken',
  'pinterestRefreshToken',
  'snapchatAccessToken',
  'snapchatRefreshToken',
  'linkedinAccessToken',
  'linkedinRefreshToken',
  'threadsAccessToken',
  'twitterAccessToken',
  'twitterRefreshToken',
  'etsyAccessToken',
  'etsyRefreshToken',
  'redditAccessToken',
  'redditRefreshToken',
  // Stripe Connect read-only token — a live API key even in read-only mode.
  // REGRESSION GUARD (2026-04-17, v1.4 Stripe review Cipher #1):
  //   runStripeLogin used to write stripeAccessToken in plaintext to
  //   merlin-config.json. Do NOT remove this from the list.
  'stripeAccessToken',
  // API keys that were previously left in plaintext — adversarial review
  // found these are just as sensitive as OAuth tokens.
  'falApiKey',
  'elevenLabsApiKey',
  'heygenApiKey',
  'arcadsApiKey',
  'googleApiKey',
  'slackBotToken',
  'slackWebhookUrl',
];

function isVaultRedactionMarker(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === '[stored securely]';
}

// Split the binary's login JSON into (a) non-sensitive public fields for the
// brand config file and (b) vault placeholders for sensitive tokens.
//
// Binary-redacted values (`[stored securely]`) mean the Go binary already
// persisted the real token to the vault. We MUST still emit a placeholder
// for the brand config so getConnections resolves via readBrandConfig's
// vault fallback on the first read after OAuth — without it, brand config
// has no entry for the key and tile greenness silently depends on global
// config inheritance, which breaks across disconnect/reconnect cycles.
//
// REGRESSION GUARD (2026-04-17, v1.4 Google Ads tile-not-green fix):
// Previously this function `continue`d on redaction markers, emitting NO
// placeholder for sensitive keys. The brand config ended up with only
// discovery-derived public fields (googleAdsCustomerId, metaAdAccountId)
// and no token reference. Greenness depended on
// `readBrandConfig -> vaultGet(brand,...) || vaultGet('_global',...)`
// inheriting the placeholder from the global config file — works on first
// connect, fails the moment disconnect-platform clears the global
// placeholder (brand vault is untouched but the reference is gone, so the
// tile flips gray even while the token is live in _global vault). Always
// emitting the placeholder makes the brand config self-sufficient.
function splitOAuthPersistFields(vaultBrand, result, vaultPut) {
  const publicFields = {};
  const placeholders = {};
  for (const [k, v] of Object.entries(result || {})) {
    if (VAULT_SENSITIVE_KEYS.includes(k)) {
      if (isVaultRedactionMarker(v)) {
        placeholders[k] = `@@VAULT:${k}@@`;
        continue;
      }
      if (typeof vaultPut === 'function') vaultPut(vaultBrand, k, v);
      placeholders[k] = `@@VAULT:${k}@@`;
    } else {
      publicFields[k] = v;
    }
  }
  return { publicFields, placeholders };
}

module.exports = { VAULT_SENSITIVE_KEYS, isVaultRedactionMarker, splitOAuthPersistFields };
