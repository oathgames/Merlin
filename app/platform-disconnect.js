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
//     When the install HAS brands, that fallthrough is refused (see below).
//
// Every key in the list is deleted from the vault scope, not only the
// VAULT_SENSITIVE_KEYS subset. The engine VaultPuts plain ids too (for
// example snapchatAdAccountId, twitterUserId), and leaving those behind meant
// a reconnect inherited the previous account's selection instead of
// re-discovering it. Deleting an absent vault entry is a no-op.
//
// REGRESSION GUARD (2026-10-17, snapchat-apotheke-still-connected): a
// disconnect is not done until the ENGINE would read the platform as not
// connected, and the engine reads the vault, not the tile. Live incident:
// Snapchat was disconnected from APOTHEKE in the app, and afterwards
// `snapchat-status --brand apotheke` still reported the same ad account and
// org. Three holes, each closed here:
//   * The vault namespace match was a byte-exact `${brand}/${key}`. The
//     engine canonicalizes the brand (resolveBrandSlug: case-insensitive,
//     slugify-equivalent), so a namespace written as "APOTHEKE/" survived a
//     delete sent for "apotheke". vaultScopeMatches mirrors that
//     equivalence. It never widens past one brand: two names that slugify
//     equal are the same brand to the engine. _global never matches a brand.
//   * A vault load or save failure was swallowed and the handler still
//     reported success, so the tile flipped while every token stayed put.
//     Vault errors now propagate, and applyDisconnect re-reads the vault
//     after the delete (io.vaultRemainingKeys) and refuses to report success
//     while any key is still there.
//   * A brand-scoped disconnect with no brand fell through to the global
//     scope and cleared _global, leaving the brand's own grant intact. When
//     the install has brands (io.hasBrands), that is now refused.

const { slugifyBrandName } = require('./brand-slug');

function vaultScopeMatches(namespace, scope) {
  if (namespace === scope) return true;
  if (!scope || scope === '_global' || namespace === '_global') return false;
  const a = slugifyBrandName(namespace);
  return a !== '' && a === slugifyBrandName(scope);
}

function splitVaultId(id) {
  const slash = id.indexOf('/');
  if (slash <= 0) return null;
  return { ns: id.slice(0, slash), key: id.slice(slash + 1) };
}

// Pure: delete every entry for `keys` under the scope (and its engine-
// equivalent spellings) from a decrypted vault map. Returns the count.
function deleteVaultEntries(map, scope, keys) {
  const want = new Set(keys);
  let removed = 0;
  for (const id of Object.keys(map)) {
    const p = splitVaultId(id);
    if (!p || !want.has(p.key) || !vaultScopeMatches(p.ns, scope)) continue;
    delete map[id];
    removed++;
  }
  return removed;
}

// Pure: the keys still present for the scope (any equivalent spelling).
function remainingVaultKeys(map, scope, keys) {
  const want = new Set(keys);
  const left = new Set();
  for (const id of Object.keys(map)) {
    const p = splitVaultId(id);
    if (p && want.has(p.key) && vaultScopeMatches(p.ns, scope)) left.add(p.key);
  }
  return [...left];
}

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

const VAULT_NOT_CLEARED_MSG = 'Merlin could not remove the saved sign-in from this computer. Close other Merlin windows and try again.';
const NO_BRAND_MSG = 'Pick the brand to disconnect from first, then try again.';

function assertVaultCleared(io, scope, keys) {
  if (typeof io.vaultRemainingKeys !== 'function') return;
  const left = io.vaultRemainingKeys(scope, keys) || [];
  if (left.length > 0) throw new Error(VAULT_NOT_CLEARED_MSG);
}

// io adapters (all synchronous, all required unless marked optional):
//   readGlobalConfig() -> object
//   writeGlobalConfig(cfg)
//   readBrandConfig(brand) -> object | null   (null when the file is absent)
//   writeBrandConfig(brand, cfg)
//   vaultDeleteKeys(scope, keys) -> number     (entries removed; THROWS on vault error)
//   vaultRemainingKeys(scope, keys) -> string[] (optional, re-reads the vault)
//   hasBrands() -> boolean                       (optional)
//   scrubLegacyTokens(brand, keys)             (optional)
//   clearAuthFailure(platform, brandOrEmpty)   (optional)
function applyDisconnect({ platform, brandName, keys, isGlobalPlatform }, io) {
  if (!platform || !Array.isArray(keys) || keys.length === 0) {
    throw new Error('applyDisconnect requires a platform and a non-empty key list');
  }
  const scope = disconnectScope({ brandName, isGlobalPlatform });
  if (scope === 'legacy-global' && typeof io.hasBrands === 'function' && io.hasBrands()) {
    throw new Error(NO_BRAND_MSG);
  }
  let configChanged = false;
  let vaultCleared = 0;

  if (scope === 'brand') {
    // Vault first: it is what the engine reads. If it fails, nothing else
    // changes and the tile keeps showing connected, which is the truth.
    vaultCleared = io.vaultDeleteKeys(brandName, keys) || 0;
    assertVaultCleared(io, brandName, keys);
    const brandCfg = io.readBrandConfig(brandName);
    if (brandCfg && stripKeys(brandCfg, keys, platform)) {
      io.writeBrandConfig(brandName, brandCfg);
      configChanged = true;
    }
    if (typeof io.scrubLegacyTokens === 'function') {
      try { io.scrubLegacyTokens(brandName, keys); } catch { /* legacy file is optional */ }
    }
    if (typeof io.clearAuthFailure === 'function') {
      try { io.clearAuthFailure(platform, brandName); } catch { /* best effort */ }
    }
  } else {
    vaultCleared = io.vaultDeleteKeys('_global', keys) || 0;
    assertVaultCleared(io, '_global', keys);
    const cfg = io.readGlobalConfig();
    if (stripKeys(cfg, keys, platform)) {
      io.writeGlobalConfig(cfg);
      configChanged = true;
    }
    if (typeof io.clearAuthFailure === 'function') {
      try { io.clearAuthFailure(platform, ''); } catch { /* best effort */ }
    }
  }

  return { success: true, scope, brand: scope === 'brand' ? brandName : null, configChanged, vaultCleared };
}

module.exports = {
  applyDisconnect, disconnectScope, stripKeys,
  vaultScopeMatches, deleteVaultEntries, remainingVaultKeys,
  VAULT_NOT_CLEARED_MSG, NO_BRAND_MSG,
};
