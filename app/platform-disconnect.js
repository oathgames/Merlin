'use strict';

// platform-disconnect.js: the scoping core of the `disconnect-platform` IPC
// handler in main.js, split out so it can be behavior-tested without booting
// Electron. main.js owns the per-platform key list (the `keyMap` inside the
// handler, which several source-scan tests read) and passes the resolved key
// list plus filesystem / vault adapters in here.
//
// REGRESSION GUARD (2026-10-17, tile-disconnect): a disconnect clears ONE
// platform for ONE scope, and never anything else.
//
//   * Brand-scoped platform with an active brand: clear the brand config
//     file, the legacy per-brand tokens file, the brand vault namespace, and
//     the brand's revoked-grant flag. The GLOBAL config and the _global vault
//     are NOT touched. The pre-fix handler also deleted the same keys from the
//     global config on every brand disconnect, so disconnecting Snapchat from
//     APOTHEKE also wiped the no-brand (legacy single-brand) copy that other
//     setups read.
//   * Universal platform (every key is a UNIVERSAL_KEYS credential, e.g. fal,
//     Slack, Discord): clear the global config and the _global vault. Those
//     credentials are shared by every brand by design.
//   * Brand-scoped platform with NO active brand (legacy single-brand setup):
//     the credential lives in the global config, so that is what is cleared.
//
// Every key in the list is deleted from the vault scope, not only the
// VAULT_SENSITIVE_KEYS subset. The engine VaultPuts plain ids too (for
// example snapchatAdAccountId, twitterUserId), and leaving those behind meant
// a reconnect inherited the previous account's selection instead of
// re-discovering it. Deleting an absent vault entry is a no-op, and the scope
// is always exactly one namespace, so this can never reach another brand.

function stripKeys(obj, keys, platform) {
  if (!obj || typeof obj !== 'object') return false;
  let changed = false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      delete obj[key];
      changed = true;
    }
  }
  if (obj._tokenTimestamps && typeof obj._tokenTimestamps === 'object'
      && Object.prototype.hasOwnProperty.call(obj._tokenTimestamps, platform)) {
    delete obj._tokenTimestamps[platform];
    changed = true;
  }
  return changed;
}

// Decide which scope a disconnect applies to. Pure; exported for tests and
// for the renderer-facing label logic to stay in agreement with main.
function disconnectScope({ brandName, isGlobalPlatform }) {
  if (isGlobalPlatform) return 'global';
  if (brandName) return 'brand';
  return 'legacy-global';
}

// io adapters (all synchronous, all required unless marked optional):
//   readGlobalConfig() -> object
//   writeGlobalConfig(cfg)
//   readBrandConfig(brand) -> object | null   (null when the file is absent)
//   writeBrandConfig(brand, cfg)
//   vaultDeleteKeys(scope, keys) -> number     (entries actually removed)
//   scrubLegacyTokens(brand, keys)             (optional)
//   clearAuthFailure(platform, brandOrEmpty)   (optional)
function applyDisconnect({ platform, brandName, keys, isGlobalPlatform }, io) {
  if (!platform || !Array.isArray(keys) || keys.length === 0) {
    throw new Error('applyDisconnect requires a platform and a non-empty key list');
  }
  const scope = disconnectScope({ brandName, isGlobalPlatform });
  let configChanged = false;
  let vaultCleared = 0;

  if (scope === 'brand') {
    const brandCfg = io.readBrandConfig(brandName);
    if (brandCfg && stripKeys(brandCfg, keys, platform)) {
      io.writeBrandConfig(brandName, brandCfg);
      configChanged = true;
    }
    if (typeof io.scrubLegacyTokens === 'function') {
      try { io.scrubLegacyTokens(brandName, keys); } catch { /* legacy file is optional */ }
    }
    vaultCleared = io.vaultDeleteKeys(brandName, keys) || 0;
    if (typeof io.clearAuthFailure === 'function') {
      try { io.clearAuthFailure(platform, brandName); } catch { /* best effort */ }
    }
  } else {
    const cfg = io.readGlobalConfig();
    if (stripKeys(cfg, keys, platform)) {
      io.writeGlobalConfig(cfg);
      configChanged = true;
    }
    vaultCleared = io.vaultDeleteKeys('_global', keys) || 0;
    if (typeof io.clearAuthFailure === 'function') {
      try { io.clearAuthFailure(platform, ''); } catch { /* best effort */ }
    }
  }

  return { success: true, scope, brand: scope === 'brand' ? brandName : null, configChanged, vaultCleared };
}

module.exports = { applyDisconnect, disconnectScope, stripKeys };
