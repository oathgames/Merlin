// Spellbook config helpers — extracted from main.js so the brand-extraction
// logic and config-read path can be unit-tested without spinning up Electron.
//
// See REGRESSION GUARD (2026-04-24) comments below and the 2026-04-24 audit
// for the incident this module was split out to address.

'use strict';

const fs = require('fs');
const path = require('path');
const { listBrandDirs } = require('./brand-dirs');

// Legacy hardcoded suffix allowlist. Used as a fallback when no real brand
// directory exists (fresh install, brand folder moved). `creative` and
// `refresh` are in the list to cover the `creative-refresh` spell that the
// original regex missed — that's the specific bug the audit flagged.
const LEGACY_SUFFIX_RE =
  /^merlin-([a-z0-9_-]+?)-(?:daily|performance|morning|weekly|seo|competitor|email|custom|creative|refresh)/i;

// Canonical 5-field cron validator. Shared between main.js's create-spell
// IPC handler and spellbook.test.js's SPELLS-shape test so both accept the
// same set of expressions.
//
// REGRESSION GUARD (2026-04-24, spellbook-audit-fixes):
// Previously main.js used `\s` (single space) while spellbook.test.js
// used `\s+` (one-or-more). A cron with multi-space separators passed
// the test-suite validator and was then rejected by the IPC validator —
// silently, with just `{ success: false, error: 'invalid cron' }`.
// Re-export so any future tightening happens in one place.
//
// REGRESSION GUARD (2026-04-27, spellbook-rsi):
// The old validator only checked the field-character whitelist
// (`\d*,/-`). It accepted `61 25 32 13 8` — every field out of range —
// because `\d` doesn't pin a numeric range. The daemon then silently
// refused to schedule the task and the user saw an active spell that
// never fired. Range validation now happens AFTER the regex pass so
// every valid cron passes both layers and every nonsense cron fails
// loudly at the IPC boundary instead of silently at runtime. Tests in
// spell-config.test.js cover hour=24, minute=60, day=0, month=13,
// dow=8, step-size>field-max.
const CRON_FIELD_CHARS = '\\d*,\\/-';
const CRON_RE = new RegExp(`^[${CRON_FIELD_CHARS}]+(\\s+[${CRON_FIELD_CHARS}]+){4}$`);

// Per-field [min, max] bounds. dow=7 is intentionally allowed as an alias
// for Sunday (POSIX cron + most real implementations accept both 0 and 7).
const FIELD_BOUNDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
];

// Validate a single field-token within its [min, max] bound. Tokens look
// like:  *   5   *  /5   1-5   1,3,5   1-30/2   */15
function isValidCronField(token, bounds) {
  if (typeof token !== 'string' || token.length === 0) return false;
  // Lists: comma-separated atoms. Each atom validates against the same
  // step / range / value rule below.
  if (token.includes(',')) {
    return token.split(',').every((part) => isValidCronField(part, bounds));
  }
  // Step: `<base>/<step>`. Step must be a positive integer ≤ field max.
  if (token.includes('/')) {
    const [base, stepStr] = token.split('/');
    if (!base || !stepStr) return false;
    if (!/^\d+$/.test(stepStr)) return false;
    const step = parseInt(stepStr, 10);
    if (step < 1 || step > bounds.max) return false;
    return isValidCronField(base, bounds);
  }
  // Range: `<a>-<b>`. Both endpoints in bounds; a ≤ b.
  if (token.includes('-')) {
    const [a, b] = token.split('-');
    if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
    const ai = parseInt(a, 10);
    const bi = parseInt(b, 10);
    if (ai < bounds.min || ai > bounds.max) return false;
    if (bi < bounds.min || bi > bounds.max) return false;
    if (ai > bi) return false;
    return true;
  }
  // Wildcard
  if (token === '*') return true;
  // Plain integer
  if (/^\d+$/.test(token)) {
    const n = parseInt(token, 10);
    return n >= bounds.min && n <= bounds.max;
  }
  return false;
}

function isValidCron(expr) {
  if (typeof expr !== 'string') return false;
  const trimmed = expr.trim();
  if (!CRON_RE.test(trimmed)) return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== FIELD_BOUNDS.length) return false;
  for (let i = 0; i < FIELD_BOUNDS.length; i++) {
    if (!isValidCronField(fields[i], FIELD_BOUNDS[i])) return false;
  }
  return true;
}

function legacyFallback(taskId) {
  const m = String(taskId || '').match(LEGACY_SUFFIX_RE);
  return m ? m[1] : null;
}

/**
 * Extract the brand name from a spell task ID of the form:
 *   merlin-{brand}-{slug}
 * where {slug} can itself contain hyphens (e.g. "creative-refresh") and
 * {brand} is itself a slug that may contain hyphens (e.g. "bright-co").
 *
 * The primary strategy enumerates real brand directories under
 * `{appRoot}/assets/brands/` and longest-prefix-matches against the task
 * ID's suffix. This is robust to any spell slug — including custom spells
 * whose suffix isn't in the hardcoded allowlist — and handles brands whose
 * own names contain hyphens by preferring the longest match.
 *
 * Falls back to LEGACY_SUFFIX_RE when no real brand directory matches
 * (fresh install, brand renamed after spell was created).
 *
 * REGRESSION GUARD (2026-04-24, spellbook-audit-fixes):
 * The previous regex-only version returned null for every spell whose
 * slug wasn't in a hardcoded allowlist. `creative-refresh` was the
 * first known victim — its brand fell back to the global `cfg.spells`
 * store via updateSpellConfig, desyncing it from `cfg.brandSpells[brand]`,
 * and its outcomes never loaded because readSpellOutcomes was gated on
 * spellBrand being non-null. Any future custom spell slug would have hit
 * the same split-brain bug.
 */
function extractBrandFromSpellId(taskId, appRoot) {
  if (typeof taskId !== 'string' || !taskId.startsWith('merlin-')) return null;
  const rest = taskId.slice('merlin-'.length);

  if (appRoot) {
    try {
      const brandsDir = path.join(appRoot, 'assets', 'brands');
      if (fs.existsSync(brandsDir)) {
        // REGRESSION GUARD (2026-08-29, ghost-brand-directory incident):
        // the brand extracted here becomes the activity.jsonl path in
        // main.js's spell-completion logger. Matching a ghost directory
        // would route a real spell's log into it and keep it alive.
        // listBrandDirs is the single shared rule (brand-dirs.js).
        const brands = listBrandDirs(brandsDir)
          // Longest first so "bright-co" wins over "bright" when both exist.
          .sort((a, b) => b.length - a.length);
        for (const b of brands) {
          if (rest === b) return b;
          if (rest.startsWith(b + '-') || rest.startsWith(b + '_')) return b;
        }
      }
    } catch {
      // fall through to legacy fallback
    }
  }

  return legacyFallback(taskId);
}

/**
 * Read the persisted metadata for a spell from either the brand-scoped
 * `cfg.brandSpells[brand][taskId]` or the global `cfg.spells[taskId]`
 * store, whichever exists. Always returns an object so callers can read
 * `.consecutiveFailures` etc. without null checks.
 */
function readSpellConfig(cfg, taskId, appRoot) {
  if (!cfg || typeof cfg !== 'object') return {};
  const brand = extractBrandFromSpellId(taskId, appRoot);
  if (
    brand &&
    cfg.brandSpells &&
    cfg.brandSpells[brand] &&
    cfg.brandSpells[brand][taskId]
  ) {
    return cfg.brandSpells[brand][taskId];
  }
  return (cfg.spells && cfg.spells[taskId]) || {};
}

/**
 * Strip the `merlin-{brand}-` prefix from a spell task ID, returning just
 * the spell slug (e.g. "daily-ads", "creative-refresh"). Used by the
 * renderer to de-duplicate active spells against the preloaded template
 * list — the template IDs are plain slugs but the active-spell IDs
 * include the brand prefix. Without this, every active spell ALSO shows
 * as an un-activated template row.
 *
 * REGRESSION GUARD (2026-04-24, spellbook-audit-fixes):
 * loadSpells() previously compared `merlin-${t.spell}` against a set of
 * full IDs like `merlin-branda-daily-ads`. The comparison never matched
 * so every active spell rendered twice — once as active, once as
 * template. Clicking the duplicate template re-created the spell for
 * all brands. Fix: list-spells exposes the slug via this helper so the
 * renderer can compare slug-to-slug.
 */
function stripBrandPrefix(taskId, appRoot) {
  if (typeof taskId !== 'string') return taskId;
  if (!taskId.startsWith('merlin-')) return taskId;
  const brand = extractBrandFromSpellId(taskId, appRoot);
  if (brand) {
    const prefix = `merlin-${brand}-`;
    if (taskId.startsWith(prefix)) return taskId.slice(prefix.length);
  }
  return taskId.slice('merlin-'.length);
}

/**
 * Compute the next `consecutiveFailures` count given the previous metadata
 * and the new task_notification status. Increments on failure, resets to
 * 0 on success. Extracted into a pure helper so the behaviour is unit-
 * testable without standing up Electron.
 *
 * REGRESSION GUARD (2026-04-24, spellbook-audit-fixes):
 * The call site in main.js previously hard-coded `1` on any failure,
 * which made the renderer's >= 2 escalation threshold (red dot + Retry
 * button) unreachable no matter how many consecutive failures a spell
 * suffered. Reading the previous value and incrementing lets the UI
 * actually escalate.
 */
function computeNextFailureCount(prevMeta, status) {
  const failed = status === 'failed' || status === 'error';
  const prev = Number((prevMeta && prevMeta.consecutiveFailures) || 0);
  if (!Number.isFinite(prev) || prev < 0) return failed ? 1 : 0;
  return failed ? prev + 1 : 0;
}

module.exports = {
  extractBrandFromSpellId,
  readSpellConfig,
  stripBrandPrefix,
  computeNextFailureCount,
  isValidCron,
  isValidCronField,
  CRON_RE,
  FIELD_BOUNDS,
  LEGACY_SUFFIX_RE,
};
