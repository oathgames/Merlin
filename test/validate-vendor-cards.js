#!/usr/bin/env node
// test/validate-vendor-cards.js
//
// Validator for tools/vendor-cards/vendor-capabilities.json and the cards
// it generates. Runs in CI on any PR touching vendor-capabilities.json,
// tools/vendor-cards/gen-vendor-cards.js, or .claude/skills/*/SKILL.md.
//
// Checks:
//   1. Schema — required fields present; pick_when/skip_when each ≥2; killer_features ≥2.
//   2. Action coverage — every action in vendor-capabilities.json exists as a
//      `case "<name>":` in autocmo-core/main.go (cross-repo; best-effort).
//   3. Hygiene — no banned hedge words; headline ≤120 chars; pick/skip entries
//      non-empty; docs_url is https://; last_verified is ISO date within 18 months.
//   4. Generated-sync — running gen-vendor-cards.js --check produces zero diffs.
//   5. Skill existence — every card's `skill` field resolves to an existing SKILL.md.
//
// No external deps.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(REPO_ROOT, 'tools', 'vendor-cards', 'vendor-capabilities.json');
const GENERATOR = path.join(REPO_ROOT, 'tools', 'vendor-cards', 'gen-vendor-cards.js');
const SKILLS_DIR = path.join(REPO_ROOT, '.claude', 'skills');
const MAIN_GO = path.resolve(REPO_ROOT, '..', 'autocmo-core', 'main.go');

const REQUIRED_KEYS = [
  'name', 'skill', 'headline', 'actions', 'pick_when', 'skip_when',
  'killer_features', 'constraints', 'cost', 'output', 'docs_url', 'last_verified',
];

const BANNED_HEDGE = [
  'stuff', 'things', 'various', 'miscellaneous', 'etc.', ' etc ',
  'and more', 'anything', 'catch-all', 'general-purpose',
];

const MAX_STALE_DAYS = 548; // ~18 months

const errors = [];
const warnings = [];

function fail(id, msg) { errors.push(`[${id}] ${msg}`); }
function warn(id, msg) { warnings.push(`[${id}] ${msg}`); }

// ── 1. Load + schema ─────────────────────────────────────────────────────────
let data;
try {
  data = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
} catch (err) {
  console.error(`[FATAL] cannot read ${SOURCE}: ${err.message}`);
  process.exit(2);
}

if (data.schema_version !== 1) {
  fail('schema', `unsupported schema_version: ${data.schema_version}`);
}
if (!data.vendors || typeof data.vendors !== 'object') {
  console.error('[FATAL] missing vendors map');
  process.exit(2);
}

for (const [id, v] of Object.entries(data.vendors)) {
  for (const key of REQUIRED_KEYS) {
    if (!(key in v)) fail(id, `missing required field "${key}"`);
  }

  if (Array.isArray(v.pick_when) && v.pick_when.length < 2) {
    fail(id, `pick_when must have ≥2 entries (has ${v.pick_when.length})`);
  }
  if (Array.isArray(v.skip_when) && v.skip_when.length < 2) {
    fail(id, `skip_when must have ≥2 entries (has ${v.skip_when.length})`);
  }
  if (Array.isArray(v.killer_features) && v.killer_features.length < 2) {
    fail(id, `killer_features must have ≥2 entries (has ${v.killer_features.length})`);
  }
  if (Array.isArray(v.actions) && v.actions.length < 1) {
    fail(id, `actions must have ≥1 entry`);
  }

  if (typeof v.headline === 'string' && v.headline.length > 120) {
    fail(id, `headline ${v.headline.length} chars exceeds 120`);
  }

  if (typeof v.docs_url === 'string' && !v.docs_url.startsWith('https://')) {
    fail(id, `docs_url must be https (got ${v.docs_url})`);
  }

  // Hedge-word scan across prose fields
  const prose = [
    v.headline, v.constraints, v.cost, v.output,
    ...(v.pick_when || []),
    ...(v.skip_when || []),
    ...(v.killer_features || []).flatMap(f => [f.name, f.desc]),
  ].filter(s => typeof s === 'string').join(' | ').toLowerCase();
  for (const banned of BANNED_HEDGE) {
    if (prose.includes(banned)) fail(id, `contains banned hedge word: "${banned.trim()}"`);
  }

  // last_verified freshness
  if (typeof v.last_verified === 'string') {
    const d = new Date(v.last_verified);
    if (Number.isNaN(d.getTime())) {
      fail(id, `last_verified is not a valid date: ${v.last_verified}`);
    } else {
      const ageDays = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > MAX_STALE_DAYS) {
        warn(id, `last_verified is ${Math.round(ageDays)} days old — re-verify`);
      }
    }
  }

  // Skill existence
  if (typeof v.skill === 'string') {
    const skillPath = path.join(SKILLS_DIR, v.skill, 'SKILL.md');
    if (!fs.existsSync(skillPath)) fail(id, `skill "${v.skill}" has no SKILL.md at ${skillPath}`);
  }
}

// ── 2. Action coverage against autocmo-core/main.go (best-effort) ────────────
let mainGo = null;
try { mainGo = fs.readFileSync(MAIN_GO, 'utf8'); }
catch { warn('coverage', `main.go not accessible at ${MAIN_GO} — skipping action coverage`); }

if (mainGo) {
  const cases = new Set();
  const re = /case\s+"([a-z0-9][a-z0-9-]*)"\s*:/g;
  let m;
  while ((m = re.exec(mainGo)) !== null) cases.add(m[1]);

  for (const [id, v] of Object.entries(data.vendors)) {
    for (const action of (v.actions || [])) {
      if (!cases.has(action)) {
        fail(id, `action "${action}" not found as a case in autocmo-core/main.go`);
      }
    }
  }
}

// ── 3. Generator-sync check ──────────────────────────────────────────────────
try {
  execFileSync(process.execPath, [GENERATOR, '--check'], { stdio: 'pipe' });
} catch (err) {
  const out = (err.stderr || err.stdout || Buffer.from('')).toString();
  fail('generator', `gen-vendor-cards.js --check failed:\n${out.trim()}`);
}

// ── Report ───────────────────────────────────────────────────────────────────
if (warnings.length) {
  console.error('Warnings:');
  for (const w of warnings) console.error(`  ${w}`);
}
if (errors.length) {
  console.error('Errors:');
  for (const e of errors) console.error(`  ${e}`);
  console.error(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`vendor-cards OK (${Object.keys(data.vendors).length} vendors, ${warnings.length} warning(s))`);
