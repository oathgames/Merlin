// Tests for spell-config.js — the extracted helpers for brand extraction,
// config-scope resolution, and task-ID slug stripping. Each case pins a
// behaviour the 2026-04-24 Spellbook audit found regressed.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  extractBrandFromSpellId,
  readSpellConfig,
  stripBrandPrefix,
  computeNextFailureCount,
  isValidCron,
  isValidCronField,
  CRON_RE,
  FIELD_BOUNDS,
} = require('./spell-config');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-spell-config-'));
}

function makeBrands(root, names) {
  const brandsDir = path.join(root, 'assets', 'brands');
  fs.mkdirSync(brandsDir, { recursive: true });
  for (const n of names) {
    fs.mkdirSync(path.join(brandsDir, n), { recursive: true });
    // A real brand dir always carries a marker file. brand-dirs.js requires
    // one so a ghost directory cannot read back as a live brand.
    fs.writeFileSync(path.join(brandsDir, n, 'brand.md'), '# ' + n + '\n');
  }
}

// ─── extractBrandFromSpellId ──────────────────────────────────────────

test('extractBrandFromSpellId returns null for non-merlin taskIds', () => {
  const root = tempRoot();
  assert.equal(extractBrandFromSpellId('foo', root), null);
  assert.equal(extractBrandFromSpellId('', root), null);
  assert.equal(extractBrandFromSpellId(null, root), null);
  assert.equal(extractBrandFromSpellId(undefined, root), null);
  assert.equal(extractBrandFromSpellId(123, root), null);
});

test('extractBrandFromSpellId matches a brand registered in assets/brands/', () => {
  const root = tempRoot();
  makeBrands(root, ['acme', 'widgets']);
  assert.equal(extractBrandFromSpellId('merlin-acme-daily-ads', root), 'acme');
  assert.equal(extractBrandFromSpellId('merlin-widgets-morning-briefing', root), 'widgets');
});

test('extractBrandFromSpellId handles creative-refresh (regression 2026-04-24)', () => {
  const root = tempRoot();
  makeBrands(root, ['branda']);
  // Before the fix, the hardcoded suffix regex had no `creative` branch
  // and returned null, breaking brand routing for this spell entirely.
  assert.equal(extractBrandFromSpellId('merlin-branda-creative-refresh', root), 'branda');
});

test('extractBrandFromSpellId handles custom spell slugs (no hardcoded suffix match)', () => {
  const root = tempRoot();
  makeBrands(root, ['acme']);
  assert.equal(extractBrandFromSpellId('merlin-acme-my-weird-slug', root), 'acme');
  assert.equal(extractBrandFromSpellId('merlin-acme-x', root), 'acme');
});

test('extractBrandFromSpellId picks the longest brand-name match', () => {
  const root = tempRoot();
  makeBrands(root, ['bright-co', 'mad']);
  assert.equal(extractBrandFromSpellId('merlin-bright-co-daily-ads', root), 'bright-co');
  assert.equal(extractBrandFromSpellId('merlin-mad-daily-ads', root), 'mad');
});

test('extractBrandFromSpellId skips the example directory', () => {
  const root = tempRoot();
  makeBrands(root, ['example', 'acme']);
  assert.equal(extractBrandFromSpellId('merlin-acme-daily-ads', root), 'acme');
});

test('extractBrandFromSpellId falls back to the legacy regex when brands dir is missing', () => {
  const root = tempRoot(); // no assets/brands/ subdir
  assert.equal(extractBrandFromSpellId('merlin-acme-daily-ads', root), 'acme');
  assert.equal(extractBrandFromSpellId('merlin-acme-creative-refresh', root), 'acme');
  // No allowlisted suffix in the id → legacy fallback can't resolve a brand.
  assert.equal(extractBrandFromSpellId('merlin-acme-xyz', root), null);
});

test('extractBrandFromSpellId accepts omitted appRoot via legacy regex', () => {
  assert.equal(extractBrandFromSpellId('merlin-acme-daily-ads'), 'acme');
  assert.equal(extractBrandFromSpellId('merlin-acme-creative-refresh'), 'acme');
});

// ─── readSpellConfig ──────────────────────────────────────────────────

test('readSpellConfig prefers brand-scoped metadata over global', () => {
  const root = tempRoot();
  makeBrands(root, ['acme']);
  const cfg = {
    spells: { 'merlin-acme-daily-ads': { source: 'global' } },
    brandSpells: { acme: { 'merlin-acme-daily-ads': { source: 'brand' } } },
  };
  assert.equal(readSpellConfig(cfg, 'merlin-acme-daily-ads', root).source, 'brand');
});

test('readSpellConfig falls back to global when no brand-scoped entry exists', () => {
  const root = tempRoot();
  const cfg = { spells: { 'merlin-unknown-thing': { v: 1 } } };
  assert.equal(readSpellConfig(cfg, 'merlin-unknown-thing', root).v, 1);
});

test('readSpellConfig returns {} when taskId is absent everywhere', () => {
  assert.deepEqual(readSpellConfig({}, 'merlin-missing', '/tmp'), {});
});

test('readSpellConfig is defensive against nullish cfg', () => {
  assert.deepEqual(readSpellConfig(null, 'merlin-x', '/tmp'), {});
  assert.deepEqual(readSpellConfig(undefined, 'merlin-x', '/tmp'), {});
  assert.deepEqual(readSpellConfig('nope', 'merlin-x', '/tmp'), {});
});

test('readSpellConfig reads creative-refresh from brand store (regression 2026-04-24)', () => {
  const root = tempRoot();
  makeBrands(root, ['branda']);
  const cfg = {
    brandSpells: {
      branda: { 'merlin-branda-creative-refresh': { consecutiveFailures: 3 } },
    },
  };
  assert.equal(
    readSpellConfig(cfg, 'merlin-branda-creative-refresh', root).consecutiveFailures,
    3,
  );
});

// ─── stripBrandPrefix ─────────────────────────────────────────────────

test('stripBrandPrefix returns the bare slug for merlin-{brand}-{slug}', () => {
  const root = tempRoot();
  makeBrands(root, ['acme']);
  assert.equal(stripBrandPrefix('merlin-acme-daily-ads', root), 'daily-ads');
  assert.equal(stripBrandPrefix('merlin-acme-creative-refresh', root), 'creative-refresh');
});

test('stripBrandPrefix handles brand names with hyphens', () => {
  const root = tempRoot();
  makeBrands(root, ['bright-co']);
  assert.equal(stripBrandPrefix('merlin-bright-co-daily-ads', root), 'daily-ads');
});

test('stripBrandPrefix leaves non-merlin IDs untouched', () => {
  assert.equal(stripBrandPrefix('foo', '/tmp'), 'foo');
  assert.equal(stripBrandPrefix('', '/tmp'), '');
});

test('stripBrandPrefix strips merlin- even when no brand is resolvable', () => {
  const root = tempRoot(); // empty
  // `-xyz` isn't in the legacy suffix allowlist, so brand extraction fails
  // and we only strip the leading `merlin-`.
  assert.equal(stripBrandPrefix('merlin-unknown-xyz', root), 'unknown-xyz');
});

// ─── computeNextFailureCount ──────────────────────────────────────────

test('computeNextFailureCount increments on repeat failure (regression 2026-04-24)', () => {
  // This is the core of Bug 1: before the fix, this was hard-coded to 1.
  // The renderer's red dot + Retry button require >= 2 — unreachable
  // unless the count actually accumulates.
  assert.equal(computeNextFailureCount({}, 'failed'), 1);
  assert.equal(computeNextFailureCount({ consecutiveFailures: 1 }, 'failed'), 2);
  assert.equal(computeNextFailureCount({ consecutiveFailures: 2 }, 'failed'), 3);
  assert.equal(computeNextFailureCount({ consecutiveFailures: 99 }, 'error'), 100);
});

test('computeNextFailureCount treats error and failed identically', () => {
  assert.equal(computeNextFailureCount({ consecutiveFailures: 3 }, 'failed'), 4);
  assert.equal(computeNextFailureCount({ consecutiveFailures: 3 }, 'error'), 4);
});

test('computeNextFailureCount resets to 0 on success', () => {
  assert.equal(computeNextFailureCount({ consecutiveFailures: 5 }, 'success'), 0);
  assert.equal(computeNextFailureCount({ consecutiveFailures: 5 }, 'completed'), 0);
  assert.equal(computeNextFailureCount({ consecutiveFailures: 5 }, ''), 0);
  assert.equal(computeNextFailureCount({ consecutiveFailures: 5 }, null), 0);
});

test('computeNextFailureCount handles missing / malformed prev meta', () => {
  assert.equal(computeNextFailureCount(null, 'failed'), 1);
  assert.equal(computeNextFailureCount(undefined, 'failed'), 1);
  assert.equal(computeNextFailureCount({}, 'failed'), 1);
  assert.equal(computeNextFailureCount({ consecutiveFailures: 'garbage' }, 'failed'), 1);
  assert.equal(computeNextFailureCount({ consecutiveFailures: -1 }, 'failed'), 1);
  assert.equal(computeNextFailureCount({ consecutiveFailures: NaN }, 'failed'), 1);
});

// ─── isValidCron ──────────────────────────────────────────────────────
// (isValidCron + CRON_RE + isValidCronField + FIELD_BOUNDS imported at top)

test('isValidCron accepts the canonical 5-field expressions used by SPELLS', () => {
  assert.equal(isValidCron('0 9 * * 1-5'), true);
  assert.equal(isValidCron('30 14 * * *'), true);
  assert.equal(isValidCron('0 9 * * 1'), true);
  assert.equal(isValidCron('0 9 * * 2,4'), true);
  assert.equal(isValidCron('*/5 * * * *'), true);
});

test('isValidCron tolerates multi-whitespace (regression 2026-04-24)', () => {
  // Previously main.js used `\s` (single space) but the test validator used
  // `\s+`, so a copy-pasted cron with double-spaces greened CI and failed
  // the IPC handler. Both paths now go through isValidCron.
  assert.equal(isValidCron('0  9  *  *  1-5'), true);
  assert.equal(isValidCron('0\t9 * * 1-5'), true);
  assert.equal(isValidCron('  0 9 * * 1-5  '), true); // trim is applied
});

test('isValidCron rejects obviously malformed input', () => {
  assert.equal(isValidCron(''), false);
  assert.equal(isValidCron(null), false);
  assert.equal(isValidCron(undefined), false);
  assert.equal(isValidCron(42), false);
  assert.equal(isValidCron('foo'), false);
  assert.equal(isValidCron('0 9 * *'), false);           // 4 fields
  assert.equal(isValidCron('0 9 * * 1-5 extra'), false); // 6 fields
  assert.equal(isValidCron('0; rm -rf / *'), false);     // shell injection attempt
});

test('CRON_RE is exported for direct source-grep parity checks', () => {
  assert.ok(CRON_RE instanceof RegExp);
});

// ─── Cron range validation (REGRESSION GUARD 2026-04-27) ─────────────────
//
// The 2026-04-27 RSI audit found that the field-character regex accepted
// out-of-range values (hour=25, day=32, minute=60, dow=8). The daemon
// then refused to schedule, but silently — no UI feedback, the spell
// just never fired. Each test below is one nonsense cron that USED to
// pass and now MUST fail loudly at the IPC boundary.

test('isValidCron rejects hour out of range (24+)', () => {
  assert.equal(isValidCron('0 24 * * *'), false);
  assert.equal(isValidCron('0 25 * * *'), false);
  assert.equal(isValidCron('0 99 * * *'), false);
});

test('isValidCron rejects minute out of range (60+)', () => {
  assert.equal(isValidCron('60 9 * * *'), false);
  assert.equal(isValidCron('99 9 * * *'), false);
});

test('isValidCron rejects day-of-month out of range (0 or 32+)', () => {
  assert.equal(isValidCron('0 9 0 * *'), false);
  assert.equal(isValidCron('0 9 32 * *'), false);
});

test('isValidCron rejects month out of range (0 or 13+)', () => {
  assert.equal(isValidCron('0 9 1 0 *'), false);
  assert.equal(isValidCron('0 9 1 13 *'), false);
});

test('isValidCron rejects day-of-week > 7 (only 0..7 are valid POSIX values)', () => {
  assert.equal(isValidCron('0 9 * * 8'), false);
  assert.equal(isValidCron('0 9 * * 99'), false);
});

test('isValidCron accepts day-of-week 7 as a Sunday alias', () => {
  // POSIX cron + most real schedulers accept both 0 and 7 for Sunday.
  assert.equal(isValidCron('0 9 * * 7'), true);
  assert.equal(isValidCron('0 9 * * 0'), true);
});

test('isValidCron rejects step sizes larger than the field range', () => {
  assert.equal(isValidCron('*/60 * * * *'), false); // step > minute max
  assert.equal(isValidCron('* */24 * * *'), false); // step > hour max
  assert.equal(isValidCron('*/15 * * * *'), true);  // valid 15-min step
});

test('isValidCron rejects ranges with reversed endpoints (hi < lo)', () => {
  assert.equal(isValidCron('0 9 * * 5-1'), false);
  assert.equal(isValidCron('0 9 5-1 * *'), false);
});

test('isValidCron accepts well-formed lists, ranges, and steps', () => {
  assert.equal(isValidCron('0 9 * * 1-5'), true);
  assert.equal(isValidCron('0,30 9 * * 1-5'), true);
  assert.equal(isValidCron('0 9 1,15 * *'), true);
  assert.equal(isValidCron('*/15 9-17 * * 1-5'), true);
});

test('isValidCronField is exposed and pins per-field bounds', () => {
  // Bounds list MUST follow the canonical [min, hour, dom, month, dow]
  // order Posix cron uses, so a future field reorder breaks loudly.
  assert.equal(FIELD_BOUNDS.length, 5);
  assert.equal(FIELD_BOUNDS[0].name, 'minute');
  assert.equal(FIELD_BOUNDS[1].name, 'hour');
  assert.equal(FIELD_BOUNDS[4].name, 'day-of-week');
  // Spot-check a value-aware token.
  assert.equal(isValidCronField('59', FIELD_BOUNDS[0]), true);
  assert.equal(isValidCronField('60', FIELD_BOUNDS[0]), false);
});

test('isValidCron rejects negative numbers and signs', () => {
  assert.equal(isValidCron('-1 9 * * *'), false);
  assert.equal(isValidCron('+0 9 * * *'), false);
});
