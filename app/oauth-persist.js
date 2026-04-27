// OAuth persistence helpers. Pure functions extracted from main.js so they
// can be unit-tested without booting the Electron runtime. Imported by main.js
// at module load; the actual vaultPut side-effect is injected from the caller.

const VAULT_SENSITIVE_KEYS = [
  'metaAccessToken',
  'tiktokAccessToken',
  'tiktokRefreshToken',
  'googleAccessToken',
  'googleRefreshToken',
  // Google Ads developer token — a Google-console-issued secret, not an
  // OAuth token. Previously missing from this list: save-config-field
  // (which accepted it via CONFIG_FIELD_ALLOWLIST) wrote it as plaintext
  // to merlin-config.json / .merlin-config-<brand>.json. REGRESSION GUARD
  // (2026-04-23, codex review): covered by the allowlist cross-check
  // test below — do not remove without also removing it from the allowlist.
  'googleAdsDeveloperToken',
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
  // Foreplay ad-library API key. Same story as googleAdsDeveloperToken —
  // in CONFIG_FIELD_ALLOWLIST but previously missing here, so every paste
  // landed on disk in plaintext.
  'foreplayApiKey',
  // Postscript SMS marketing API key (BYOK tile, shipped v1.18.0).
  // REGRESSION GUARD (2026-04-27, postscript-save-broken incident): the
  // initial v1.18.0 ship added 'postscript' to renderer.js
  // API_KEY_PLATFORMS but forgot BOTH this list and CONFIG_FIELD_ALLOWLIST,
  // so every Save click in the Magic-panel modal hit a silent
  // "Unknown config field" rejection in main.js's save-config-field
  // handler. Paid users saw "I clicked Save and nothing happened." The
  // allowlist cross-check test below was scoped to "every allowlisted
  // sensitive-shape key is vaulted" — the inverse direction ("every
  // BYOK tile in API_KEY_PLATFORMS reaches the allowlist") was added
  // in this same release as a stronger guard so the next BYOK tile
  // can't ship with the same omission.
  'postscriptApiKey',
  // AppLovin reporting keys (BYOK tile, shipped v1.18.0). Two
  // independent keys — MAX (publisher report) and AppDiscovery
  // (advertiser report). Same incident class as Postscript above:
  // the tile was wired in renderer.js but the allowlist + vault lists
  // were never updated, so saving either key silently failed. The
  // right-click "Use my API key" override modal collected both keys
  // in one shot but the per-key save call still hit the rejection.
  'applovinMaxReportKey',
  'applovinAdReportKey',
  'googleApiKey',
  'slackBotToken',
  'slackWebhookUrl',
];

// CONFIG_FIELD_ALLOWLIST — every key `save-config-field` will accept from the
// renderer. Kept here (rather than main.js) so the allowlist cross-check
// test below can run without booting Electron. Drift between this list and
// VAULT_SENSITIVE_KEYS silently leaks plaintext on every API-key paste;
// the regression test at the bottom of oauth-persist.test.js catches it.
const CONFIG_FIELD_ALLOWLIST = new Set([
  'metaAccessToken', 'metaAdAccountId', 'metaPageId', 'metaPixelId', 'metaConfigId',
  'tiktokAccessToken', 'tiktokAdvertiserId', 'tiktokPixelId',
  'shopifyStore', 'shopifyAccessToken',
  'googleAccessToken', 'googleRefreshToken', 'googleAdsCustomerId', 'googleAdsDeveloperToken', 'googleApiKey',
  'amazonAccessToken', 'amazonRefreshToken', 'amazonProfileId', 'amazonSellerId',
  'klaviyoAccessToken', 'klaviyoApiKey',
  'pinterestAccessToken', 'pinterestRefreshToken',
  'falApiKey', 'elevenLabsApiKey', 'heygenApiKey', 'arcadsApiKey', 'foreplayApiKey',
  // Postscript + AppLovin BYOK API keys. Shipped in v1.18.0 but the
  // allowlist update was missed — see VAULT_SENSITIVE_KEYS comment block
  // above for the full incident writeup. Without these entries the
  // save-config-field handler returns 'Unknown config field' and the
  // Magic-panel modal save click silently fails.
  'postscriptApiKey', 'applovinMaxReportKey', 'applovinAdReportKey',
  'slackBotToken', 'slackWebhookUrl', 'slackChannel',
  'discordGuildId', 'discordChannelId',
  'productName', 'productUrl', 'productDescription', 'vertical', 'outputDir',
  'maxDailyAdBudget', 'maxMonthlyAdSpend', 'autoPublishAds', 'blogPublishMode',
  'qualityGate', 'falModel', 'imageModel', 'startAtLogin', 'dailyAdBudget',
]);

// isSensitiveConfigKey — single source of truth for "does this key need
// the vault?" Shared between save-config-field and any future config-ingest
// IPC so a new secret path can't skip the vault by accident.
function isSensitiveConfigKey(key) {
  return typeof key === 'string' && VAULT_SENSITIVE_KEYS.includes(key);
}

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

module.exports = {
  VAULT_SENSITIVE_KEYS,
  CONFIG_FIELD_ALLOWLIST,
  isSensitiveConfigKey,
  isVaultRedactionMarker,
  splitOAuthPersistFields,
};
