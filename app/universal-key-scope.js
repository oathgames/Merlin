// Universal-key vault scope: one decision, one place.
//
// REGRESSION GUARD (2026-08-30, TrendTrack "API key is empty").
//
// `save-config-field` vaulted every sensitive key under `brandName || '_global'`.
// The API-key tiles in the renderer always pass `activeBrand`, so a key typed
// while a brand was selected landed under that brand. For a brand-scoped key
// (metaAccessToken, clarityApiToken, aliaApiKey) that is exactly right. For a
// UNIVERSAL key it is wrong, and it fails silently in the worst possible shape:
//
//   - the vault write succeeds, so the file grows and nothing errors,
//   - the brand config gets a real `@@VAULT:<key>@@` placeholder, so the UI
//     renders the platform as connected,
//   - the Go engine resolves universal keys at `_global` only
//     (autocmo-core/vault.go `brandScopedKeys` deliberately omits them, and
//     trendtrack.go documents `_global/trendtrackApiKey`), so every call comes
//     back "API key is empty".
//
// A user who re-pastes the key gets the identical result, because re-pasting
// repeats the same misrouted write. That is what makes this worth a guard: the
// obvious remedy reinforces the bug.
//
// Two halves, and both are needed. `vaultScopeFor` fixes NEW writes. Existing
// installs already hold misfiled keys and their owners have no way to reach
// them, so `planUniversalKeyMigration` moves them on boot.
//
// The list itself stays in main.js (UNIVERSAL_KEYS) and is passed in, so this
// module cannot drift into being a second source of truth for which keys are
// universal. Its counterparts are `brandScopedKeys` in autocmo-core/vault.go
// and GLOBAL_KEYS_SET in disconnect-platform; all three describe the same set.

'use strict';

const GLOBAL_SCOPE = '_global';

// Where a sensitive key's VALUE belongs. Brand-scoped keys follow the brand;
// universal keys are workspace-wide and always land in `_global`, whatever
// brand happened to be selected when the user typed them.
function vaultScopeFor(key, brandName, universalKeys) {
  if (universalKeys && universalKeys.has && universalKeys.has(key)) return GLOBAL_SCOPE;
  return brandName || GLOBAL_SCOPE;
}

// Which misfiled entries to move, given what the vault actually holds.
//
// Returns [{ key, fromBrand }] for every universal key sitting under a brand
// scope. Deliberately a PLAN rather than the move itself: the caller owns
// vaultGet/vaultPut/vaultDelete, so this stays testable without a real vault,
// and the destructive half is one obvious loop at the call site.
//
// On conflict, NOTHING is destroyed. When both scopes hold the key, the entry
// comes back as `conflict: true` and the caller moves neither and deletes
// neither. An earlier draft deleted the brand copy on the theory that a value
// already at `_global` must be the working one, which is exactly backwards in
// the shape that produced this incident: `_global` held a revoked key (the
// engine reports 401, not "not connected") and the brand scope held the fresh
// paste. Deleting the brand copy would have destroyed the only good credential
// on the machine, and neither scope carries a timestamp or any other signal
// that could tell them apart. Two readable copies is cosmetic, since every
// reader resolves at `_global` only; a deleted credential is not recoverable.
// The user resolves it by re-pasting once, which now lands on `_global`.
function planUniversalKeyMigration(universalKeys, brands, vaultHas) {
  const plan = [];
  if (!universalKeys || !Array.isArray(brands)) return plan;
  for (const brand of brands) {
    if (!brand || brand === GLOBAL_SCOPE) continue;
    for (const key of universalKeys) {
      if (!vaultHas(brand, key)) continue;
      plan.push({ key, fromBrand: brand, conflict: vaultHas(GLOBAL_SCOPE, key) });
    }
  }
  return plan;
}

module.exports = { GLOBAL_SCOPE, vaultScopeFor, planUniversalKeyMigration };
