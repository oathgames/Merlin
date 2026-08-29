// Regression guards for the ghost-brand-directory incident (2026-08-29).
//
// A run using the slug "rebecca-taylor" (the real brand is "rebeccataylor",
// no hyphen) failed on a missing Meta token. The Go engine's error log did an
// unconditional mkdir of assets/brands/<slug>/ before appending, so the ERROR
// ITSELF created a brand directory holding exactly one file, activity.jsonl.
// The engine-side fix lives in autocmo-core (brand_resolve.go + logActivity).
// This file guards the containment half on the app side: every consumer that
// enumerates brand directories agrees on what counts as a brand, so a ghost,
// a backup tree, or a scaffolding leftover never reads back as a live client.
//
// Behavioral tests exercise app/brand-dirs.js against real temp dirs. Source
// scans lock down the main.js / spell-config.js / archive-scanner.js wiring
// and fail CI if a raw readdir-plus-name-filter is re-inlined.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  BRAND_MARKER_FILES,
  RESERVED_BRAND_DIRS,
  isBrandDirName,
  isBrandDir,
  listBrandDirs,
} = require('./brand-dirs');

// Build a brands/ tree. Each entry is [name, markerFile|null].
function makeTree(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-brand-dirs-'));
  const brandsDir = path.join(root, 'assets', 'brands');
  fs.mkdirSync(brandsDir, { recursive: true });
  for (const [name, marker] of entries) {
    const d = path.join(brandsDir, name);
    fs.mkdirSync(d, { recursive: true });
    if (marker) fs.writeFileSync(path.join(d, marker), '{}\n');
  }
  return brandsDir;
}

// ── The incident ────────────────────────────────────────────────────────

test('a manifest-less ghost directory is not a brand', () => {
  const brandsDir = makeTree([
    ['rebeccataylor', 'brand-manifest.json'],
    ['rebecca-taylor', null], // the ghost, before anything was written into it
  ]);
  assert.deepEqual(listBrandDirs(brandsDir), ['rebeccataylor']);
});

test('the index generator excludes a directory with no brand.md and no manifest', () => {
  // The chip's explicit test case. Mirrors what brands-index.json consumed:
  // both slugs were listed status:"active" and nothing distinguished them.
  const brandsDir = makeTree([
    ['realbrand', 'brand.md'],
    ['no-manifest-no-brand-md', null],
  ]);
  const got = listBrandDirs(brandsDir);
  assert.deepEqual(got, ['realbrand']);
  assert.ok(!got.includes('no-manifest-no-brand-md'));
});

test('brand.md alone, manifest alone, or activity.jsonl alone each count', () => {
  const brandsDir = makeTree([
    ['has-md', 'brand.md'],
    ['has-manifest', 'brand-manifest.json'],
    ['has-activity', 'activity.jsonl'],
  ]);
  assert.deepEqual(listBrandDirs(brandsDir), ['has-activity', 'has-manifest', 'has-md']);
});

// ── Reserved names and prefixes ─────────────────────────────────────────

test("'_'-prefixed and 'backup-'-prefixed directories are excluded even with markers", () => {
  // Both shapes exist in live trees today:
  //   backup-benebone-2026-08-11-revive-contamination
  //   _backup-benebone-2026-08-11-revive-contamination
  // A backup carries a full copy of the brand's files, so a marker-file test
  // alone would happily index it as a second client.
  const brandsDir = makeTree([
    ['benebone', 'brand.md'],
    ['backup-benebone-2026-08-11-revive-contamination', 'brand.md'],
    ['_backup-benebone-2026-08-11-revive-contamination', 'brand.md'],
    ['_retired', 'brand.md'],
  ]);
  assert.deepEqual(listBrandDirs(brandsDir), ['benebone']);
});

test('shared helper folders under assets/brands are not brands', () => {
  const brandsDir = makeTree([
    ['apotheke', 'brand.md'],
    ['example', 'brand.md'],
    ['references', 'brand.md'],
    ['avatars', 'brand.md'],
    ['voices', 'brand.md'],
  ]);
  assert.deepEqual(listBrandDirs(brandsDir), ['apotheke']);
  for (const reserved of RESERVED_BRAND_DIRS) {
    assert.equal(isBrandDirName(reserved), false, `${reserved} should be reserved`);
  }
});

test('non-slug-shaped directory names are rejected', () => {
  for (const bad of ['', '-leading-dash', 'has space', 'has/slash', 'has..dots', '.hidden']) {
    assert.equal(isBrandDirName(bad), false, `${JSON.stringify(bad)} should not be a brand name`);
  }
  for (const good of ['rebeccataylor', 'lali-cosmetics', 'brand_2025', 'a1']) {
    assert.equal(isBrandDirName(good), true, `${good} should be a brand name`);
  }
});

// ── Failure modes ───────────────────────────────────────────────────────

test('an unreadable brands dir returns [] rather than throwing', () => {
  assert.deepEqual(listBrandDirs(path.join(os.tmpdir(), 'merlin-does-not-exist-' + Date.now())), []);
});

test('isBrandDir requires the directory to actually hold a marker', () => {
  const brandsDir = makeTree([['ghosty', null]]);
  assert.equal(isBrandDirName('ghosty'), true, 'name rules alone accept it');
  assert.equal(isBrandDir(brandsDir, 'ghosty'), false, 'but the marker check rejects it');
});

test('the marker list mirrors the Go side and keeps activity.jsonl', () => {
  // activity.jsonl stays a marker because a long-lived connected brand may
  // carry only that. It is safe ONLY because the engine no longer creates one
  // for an unknown slug, if that mkdir is ever restored, this marker becomes
  // a self-legitimizing loop and both halves of the fix are undone.
  assert.deepEqual([...BRAND_MARKER_FILES].sort(),
    ['activity.jsonl', 'brand-manifest.json', 'brand.md']);
});

// ── Source scans: nobody re-inlines the old filter ──────────────────────

const APP_DIR = __dirname;

function appSources() {
  return fs.readdirSync(APP_DIR)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'brand-dirs.js')
    .map((f) => [f, fs.readFileSync(path.join(APP_DIR, f), 'utf8')]);
}

test("no app source re-inlines the bare `d.name !== 'example'` brand filter", () => {
  const offenders = [];
  for (const [file, src] of appSources()) {
    // Strip line comments so the explanatory prose in a guard block doesn't
    // trip the scan.
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    if (/name\s*!==\s*'example'/.test(code) || /name\s*!==\s*"example"/.test(code)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [],
    `these files re-inline the old brand-dir filter instead of using brand-dirs.js: ${offenders.join(', ')}`);
});

test('main.js routes brand enumeration through brand-dirs.js', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
  assert.match(src, /require\('\.\/brand-dirs'\)/, 'main.js must require brand-dirs');
  // The two consumers the incident actually flowed through.
  assert.match(src, /brands = listBrandDirs\(brandsDir\);/,
    'the token watchdog must enumerate via listBrandDirs');
  assert.match(src, /const dirs = listBrandDirs\(brandsDir\)/,
    'the get-brands / brands-index generator must enumerate via listBrandDirs');
});

test('the token watchdog cannot resurrect a ghost by sweeping every directory', () => {
  // The watchdog fired watchdog-check against the ghost every 4 hours; the
  // engine appended a heartbeat, which kept the ghost's mtime as fresh as the
  // real brand's for nine days. Deleting a ghost was therefore not durable.
  const src = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
  const i = src.indexOf('const runTokenWatchdog');
  assert.ok(i > 0, 'runTokenWatchdog not found, update this guard');
  const body = src.slice(i, i + 4000);
  assert.match(body, /listBrandDirs\(brandsDir\)/,
    'runTokenWatchdog must enumerate through listBrandDirs');
  assert.doesNotMatch(body, /readdirSync\(brandsDir/,
    'runTokenWatchdog must not readdir brandsDir directly');
});

test('spell-config and archive-scanner route through brand-dirs.js', () => {
  const spell = fs.readFileSync(path.join(APP_DIR, 'spell-config.js'), 'utf8');
  assert.match(spell, /require\('\.\/brand-dirs'\)/);
  assert.match(spell, /listBrandDirs\(brandsDir\)/);
  const scanner = fs.readFileSync(path.join(APP_DIR, 'archive-scanner.js'), 'utf8');
  assert.match(scanner, /require\('\.\/brand-dirs'\)/);
  assert.match(scanner, /isBrandDir\(brandsDir, d\.name\)/);
});
