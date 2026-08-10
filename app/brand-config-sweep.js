// Stale brand-config sweep, vault-or-delete plaintext per-brand configs
// stranded outside the tools dir. Pure logic extracted from main.js (same
// pattern as oauth-persist.js) so it can be unit-tested without booting
// Electron. main.js injects the vault and logging side-effects.
//
// REGRESSION GUARD (2026-07-13, plaintext brand configs stranded in StateDir):
// The workspace split migration (main.js:migrateTreeToSplit) routes every
// file matching STATE_FILE_PATTERNS (including .merlin-config-<brand>.json)
// FLAT into StateDir (%APPDATA%\Merlin / ~/Library/Application Support/Merlin).
// But the config I/O layer (readBrandConfig / writeBrandTokens) reads and
// writes ONLY <ContentDir>/.claude/tools/. So any per-brand config that
// existed at split-migration time was moved to a directory no code path ever
// reads again, frozen with whatever it held. On installs that predate the
// vault, that meant PLAINTEXT Meta access tokens and API keys sitting
// unencrypted on disk indefinitely (live incident 2026-07-13: two brands'
// EAA tokens in %APPDATA%\Merlin, untouched for ~3 months).
// migrateTokensToVault could never catch them: it scans only the tools dir
// AND is one-shot gated on _migrationVersion >= 3, which was already set.
//
// Rules encoded here, do not "simplify" any of them away:
//   1. The sweep runs EVERY boot with no version/flag gate. A one-shot gate
//      is exactly what let the originals rot: strays can reappear at any
//      time (restored backups, re-run split migration from another legacy
//      tree, machine sync), so the invariant must be re-checked per boot.
//      Cost is a readdir over <= 2 dirs plus a JSON.parse per stray, zero
//      when no strays exist.
//   2. Strays are DEAD FILES: nothing reads .merlin-config-<brand>.json
//      outside the tools dir (verified across app/*.js and autocmo-core).
//      The sweep therefore never merges stray values into live configs and
//      never resurrects months-stale credentials into a brand's active
//      connection state, a stray Meta token is near-certainly expired, and
//      "tile shows connected but every call 401s" is a worse outcome than
//      "reconnect via OAuth".
//   3. Live brand (assets/brands/<brand>/ exists) → PRESERVE THEN DELETE:
//      each sensitive plaintext value is written to the vault only if that
//      brand/key slot is EMPTY (vaultGet returns nothing). Never clobber:
//      the vault entry, when present, was written by the live OAuth flow
//      and is fresher than the stray by construction.
//   4. Never delete before the vault write is CONFIRMED (vaultGet readback
//      matches). vaultPut swallows its own errors, so a readback is the
//      only success signal. A file we failed to preserve stays on disk and
//      is retried next boot, a lingering plaintext file is recoverable,
//      a deleted credential is not.
//   5. Retired brand (no assets/brands/<brand>/ dir) → delete without
//      vaulting. The brand cannot be selected, so its credentials are
//      unreachable junk; archiving them would keep dead secrets alive.
//   6. Unparseable files are left in place (logged). We cannot prove what a
//      corrupt file holds, so we do not destroy it.
//   7. The injected log callback receives KEY NAMES AND COUNTS ONLY, never
//      values. activity.jsonl is plaintext.
// Tests: app/brand-config-sweep.test.js.

'use strict';

const fs = require('fs');
const path = require('path');

// Matches the live-file naming contract (main.js STATE_FILE_PATTERNS), with
// the brand slug captured. tmp- siblings belong to the atomic-write sweeper
// in main.js (_maybeSweepConfigTmp), not to us.
const BRAND_CONFIG_RE = /^\.merlin-config-([a-z0-9_-]+)\.json$/i;

function parseBrandConfigName(fileName) {
  const m = BRAND_CONFIG_RE.exec(fileName);
  if (!m) return null;
  const brand = m[1];
  if (/^tmp-/i.test(brand)) return null;
  return brand;
}

function isVaultPlaceholder(value) {
  return typeof value === 'string' && value.startsWith('@@VAULT:');
}

// Directory equality helper, Windows paths are case-insensitive.
function sameDir(a, b) {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (process.platform === 'win32') return ra.toLowerCase() === rb.toLowerCase();
  return ra === rb;
}

// Sweep one stray directory. Returns per-file results (appended to out).
function sweepDir(dir, deps, out) {
  const { brandsDir, isSensitiveKey, isRedactionMarker, vaultGet, vaultPut, log } = deps;
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; } // dir absent, nothing to do

  for (const name of entries) {
    const brand = parseBrandConfigName(name);
    if (!brand) continue;
    const filePath = path.join(dir, name);

    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      out.errors.push(name + ': unparseable');
      log({ file: name, dir, brand, action: 'skipped-unparseable' });
      continue;
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      out.errors.push(name + ': not an object');
      log({ file: name, dir, brand, action: 'skipped-not-object' });
      continue;
    }

    let brandLive = false;
    try { brandLive = brand !== 'example' && fs.statSync(path.join(brandsDir, brand)).isDirectory(); } catch {}

    const preserved = [];
    const superseded = [];
    let preserveFailed = false;

    if (brandLive) {
      for (const [key, value] of Object.entries(cfg)) {
        if (!isSensitiveKey(key)) continue;
        if (typeof value !== 'string' || value.length === 0) continue;
        if (isVaultPlaceholder(value) || isRedactionMarker(value)) continue;
        // Plaintext secret. Preserve into the vault only if the slot is
        // empty (rule 3) and verify the write landed (rule 4).
        if (vaultGet(brand, key)) {
          superseded.push(key);
          continue;
        }
        vaultPut(brand, key, value);
        if (vaultGet(brand, key) === value) {
          preserved.push(key);
        } else {
          preserveFailed = true;
          out.errors.push(name + ': vault write unconfirmed for ' + key);
        }
      }
    }

    if (preserveFailed) {
      // Rule 4: do NOT delete, retry next boot.
      log({ file: name, dir, brand, action: 'kept-vault-write-failed', preserved, superseded });
      continue;
    }

    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      out.errors.push(name + ': unlink failed (' + e.message + ')');
      log({ file: name, dir, brand, action: 'kept-unlink-failed' });
      continue;
    }
    out.deleted.push(name);
    out.preservedKeys += preserved.length;
    log({
      file: name,
      dir,
      brand,
      action: brandLive ? 'vaulted-and-deleted' : 'deleted-retired-brand',
      preserved,
      superseded,
    });
  }
}

// Entry point. deps:
//   toolsDir:          <ContentDir>/.claude/tools (canonical config home;
//                      EXCLUDED from the sweep, live files are owned by
//                      readBrandConfig/writeBrandTokens/migrateTokensToVault)
//   strayDirs:         candidate stray locations (StateDir, default OS
//                      state dir); any entry equal to toolsDir is skipped
//   brandsDir:         <ContentDir>/assets/brands
//   isSensitiveKey:    oauth-persist.isSensitiveConfigKey
//   isRedactionMarker: oauth-persist.isVaultRedactionMarker
//   vaultGet/vaultPut: main.js vault primitives (brand-namespaced)
//   log:               main.js logMigration wrapper (key names only)
function sweepStaleBrandConfigs(deps) {
  const out = { deleted: [], preservedKeys: 0, errors: [] };
  const seen = [];
  for (const dir of deps.strayDirs || []) {
    if (!dir) continue;
    if (sameDir(dir, deps.toolsDir)) continue; // never touch the live config home
    if (seen.some((d) => sameDir(d, dir))) continue;
    seen.push(dir);
    sweepDir(dir, deps, out);
  }
  return out;
}

module.exports = {
  sweepStaleBrandConfigs,
  parseBrandConfigName,
  BRAND_CONFIG_RE,
};
