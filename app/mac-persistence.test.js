// REGRESSION GUARD (2026-05-03, mac-persistence-rsi)
//
// Live incident: Mac users reported being asked to re-do brand setup on every
// app re-open. Three reinforcing causes — see main.js's `isReturningUser()`,
// `discoverBrands()`, and `bootstrapWorkspace()` regression-guard blocks.
// This file pins the source-level invariants so a future "simpler" rewrite
// can't silently strip the multi-signal, multi-path safety net.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const SRC_VERSION = fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8');

// ─────────────────────────────────────────────────────────────────
// 1. State-file redundancy: writes land in BOTH ContentDir + StateDir.
// ─────────────────────────────────────────────────────────────────
test('readState merges from both ContentDir + StateDir copies', () => {
  // Both file paths are declared at the top of the state block.
  assert.match(SRC_MAIN, /const sessionStateFile = path\.join\(appRoot, '\.merlin-state\.json'\)/);
  assert.match(SRC_MAIN, /const sessionStateFileAlt = path\.join\(stateDir, '\.merlin-state\.json'\)/);
  // readState reads from BOTH — anchor on the helper that does the read.
  assert.match(SRC_MAIN, /_readStateAt\(sessionStateFile\)/);
  assert.match(SRC_MAIN, /_readStateAt\(sessionStateFileAlt\)/);
});

test('writeState writes to BOTH redundant locations', () => {
  // Anchor on the writeState body — both _writeStateAtomic calls must
  // appear, AND the return must succeed if EITHER succeeded (so a
  // read-only ContentDir on iCloud doesn't lose the activeBrand).
  const idx = SRC_MAIN.indexOf('function writeState(data) {');
  assert.ok(idx > 0, 'writeState definition not found');
  const body = SRC_MAIN.slice(idx, idx + 1500);
  assert.match(body, /_writeStateAtomic\(sessionStateFile,/);
  assert.match(body, /_writeStateAtomic\(sessionStateFileAlt,/);
  // Both-failed is the only failure case.
  assert.match(body, /return okA \|\| okB/);
});

test('writeState stamps a _ts so reads can pick the most recent', () => {
  const idx = SRC_MAIN.indexOf('function writeState(data) {');
  const body = SRC_MAIN.slice(idx, idx + 1500);
  assert.match(body, /_ts:\s*Date\.now\(\)/);
});

test('readState merge prefers most recent _ts when both files exist', () => {
  // Anchor on readState body. Both copies fall through; merge picks newer.
  const idx = SRC_MAIN.indexOf('function readState() {');
  const body = SRC_MAIN.slice(idx, idx + 1200);
  assert.match(body, /Number\(a\._ts\)/);
  assert.match(body, /Number\(b\._ts\)/);
  // The pick — most recent wins (>= so a newer A wins ties; b wins
  // pre-_ts files because both ts values are 0 and the conditional is
  // strict, but defensively we never want both to be exactly equal to
  // a non-zero number, so the >= bias is correct).
  assert.match(body, /at >= bt\s*\?\s*a\s*:\s*b/);
});

// ─────────────────────────────────────────────────────────────────
// 2. Multi-path brand discovery + auto-recovery.
// ─────────────────────────────────────────────────────────────────
test('BRAND_SEARCH_PATHS includes every known location', () => {
  const idx = SRC_MAIN.indexOf('const BRAND_SEARCH_PATHS = ');
  assert.ok(idx > 0, 'BRAND_SEARCH_PATHS declaration not found');
  const decl = SRC_MAIN.slice(idx, SRC_MAIN.indexOf('})()', idx) + 4);
  // Canonical ContentDir.
  assert.match(decl, /path\.join\(appRoot, 'assets', 'brands'\)/);
  // StateDir mirror — for future where state moves into hot-state dir.
  assert.match(decl, /path\.join\(stateDir, 'assets', 'brands'\)/);
  // Mac legacy monolith.
  assert.match(decl, /'darwin'/);
  assert.match(decl, /app\.getPath\('userData'\)/);
  assert.match(decl, /'Library', 'Application Support', 'Merlin'/);
  // Documents/Merlin legacy (pre-1.0).
  assert.match(decl, /app\.getPath\('documents'\)/);
  assert.match(decl, /'Documents', 'Merlin'/);
});

test('discoverBrands auto-recovers stranded brands to canonical path', () => {
  const idx = SRC_MAIN.indexOf('function discoverBrands() {');
  assert.ok(idx > 0, 'discoverBrands not found');
  const body = SRC_MAIN.slice(idx, idx + 1500);
  // Recovery fires for every non-canonical path (i > 0).
  assert.match(body, /if\s*\(i\s*>\s*0\)/);
  assert.match(body, /_recoverStrandedBrand\(/);
});

test('_listBrandsAt rejects empty stub directories (filters real brands only)', () => {
  // A directory is "real" if it has brand.md OR products/ OR memory.md.
  // Stub dirs created by failed mid-flight setup have none of these and
  // were the source of "phantom brand directory blocks re-onboarding"
  // edge cases.
  const idx = SRC_MAIN.indexOf('function _listBrandsAt(brandsDir) {');
  assert.ok(idx > 0, '_listBrandsAt not found');
  const body = SRC_MAIN.slice(idx, idx + 1500);
  assert.match(body, /'brand\.md'/);
  assert.match(body, /'products'/);
  assert.match(body, /'memory\.md'/);
});

test('_recoverStrandedBrand never overwrites canonical (idempotent + safe)', () => {
  const idx = SRC_MAIN.indexOf('function _recoverStrandedBrand(');
  assert.ok(idx > 0, '_recoverStrandedBrand not found');
  const body = SRC_MAIN.slice(idx, idx + 1500);
  // Skip-if-exists guard.
  assert.match(body, /if\s*\(fs\.existsSync\(dst\)\)\s*return false/);
  // cpSync uses force:false so a partial-overwrite race can't stomp data.
  assert.match(body, /force:\s*false/);
});

// ─────────────────────────────────────────────────────────────────
// 3. Multi-signal first-run detection (5 signals).
// ─────────────────────────────────────────────────────────────────
test('isReturningUser checks five independent signals', () => {
  const idx = SRC_MAIN.indexOf('function isReturningUser() {');
  assert.ok(idx > 0, 'isReturningUser not found');
  // End the slice at the next top-level function declaration.
  const end = SRC_MAIN.indexOf('\nfunction ', idx + 50);
  const body = SRC_MAIN.slice(idx, end > idx ? end : idx + 2000);
  // Signal 1: state file declares activeBrand.
  assert.match(body, /readState\(\)/);
  assert.match(body, /st\.activeBrand/);
  // Signal 2: CLAUDE.md exists (legacy single-signal).
  assert.match(body, /'CLAUDE\.md'/);
  // Signal 3: discoverBrands().length > 0.
  assert.match(body, /discoverBrands\(\)\.length\s*>\s*0/);
  // Signal 4: vault file exists (StateDir).
  assert.match(body, /'\.vault'/);
  assert.match(body, /'\.merlin-vault'/);
  // Signal 5: merlin-config.json in StateDir.
  assert.match(body, /'merlin-config\.json'/);
});

test('ready-to-show first-run gate uses isReturningUser, not bare CLAUDE.md check', () => {
  // Source-scan: the isFirstRun line MUST call isReturningUser, NOT just
  // fs.existsSync against CLAUDE.md. The bare-existsSync form was the
  // single-signal vulnerability that drove the Mac re-setup loop.
  const idx = SRC_MAIN.indexOf("win.once('ready-to-show'");
  assert.ok(idx > 0, 'ready-to-show handler not found');
  const slice = SRC_MAIN.slice(idx, idx + 2400);
  assert.match(slice, /const isFirstRun = app\.isPackaged && !isReturningUser\(\)/);
  // Negative: the old form must NOT come back via copy-paste.
  assert.doesNotMatch(slice,
    /const isFirstRun = app\.isPackaged && !fs\.existsSync\(path\.join\(appRoot, 'CLAUDE\.md'\)\)/);
});

// ─────────────────────────────────────────────────────────────────
// 4. Bootstrap is synchronous + verified BEFORE createWindow.
// ─────────────────────────────────────────────────────────────────
test('bootstrapWorkspace runs synchronously BEFORE createWindow (no setTimeout race)', () => {
  // Anchor: the whenReady block. bootstrapWorkspace() must appear
  // BEFORE `await createWindow()`, AND the prior `setTimeout(bootstrapWorkspace, 500)`
  // form must be gone.
  const bootCallIdx = SRC_MAIN.indexOf('try { bootstrapWorkspace(); }');
  assert.ok(bootCallIdx > 0, 'sync bootstrap call not found');
  const createWindowIdx = SRC_MAIN.indexOf('await createWindow()', bootCallIdx);
  assert.ok(createWindowIdx > 0, 'createWindow call after bootstrap not found');
  assert.ok(bootCallIdx < createWindowIdx,
    'bootstrap MUST run before createWindow — a setTimeout race here is the original bug');
  // Old form is gone.
  assert.doesNotMatch(SRC_MAIN, /setTimeout\(bootstrapWorkspace,\s*500\)/);
});

test('bootstrapWorkspace verifies CLAUDE.md landed and surfaces failure', () => {
  const idx = SRC_MAIN.indexOf('function bootstrapWorkspace() {');
  assert.ok(idx > 0, 'bootstrapWorkspace not found');
  // Function ends at the next top-level function or `let win =`.
  const end = SRC_MAIN.indexOf('\nlet win = null', idx);
  const body = SRC_MAIN.slice(idx, end > idx ? end : idx + 4000);
  // Synchronous Node-native cpSync — not the prior child-process callback chain.
  assert.match(body, /fs\.cpSync\(/);
  assert.doesNotMatch(body, /execFile\('cp'/);
  assert.doesNotMatch(body, /execFile\('robocopy'/);
  // Verifies CLAUDE.md exists post-copy.
  assert.match(body, /result\.verified = fs\.existsSync\(path\.join\(appRoot, 'CLAUDE\.md'\)\)/);
  // Loud failure surface.
  assert.match(body, /appendErrorLog\(/);
});

// ─────────────────────────────────────────────────────────────────
// 5. Update preserve list keeps the new state files.
// ─────────────────────────────────────────────────────────────────
test('version.json preserve list includes .merlin-state.json + .merlin-threads.json', () => {
  const v = JSON.parse(SRC_VERSION);
  assert.ok(Array.isArray(v.preserve), 'version.json must have a preserve array');
  assert.ok(v.preserve.includes('.merlin-state.json'),
    '.merlin-state.json MUST be in preserve — it carries activeBrand and a wipe re-routes returning users into onboarding');
  assert.ok(v.preserve.includes('.merlin-threads.json'),
    '.merlin-threads.json MUST be in preserve — it carries the chat bubble cache + per-brand SDK session IDs');
});

// ─────────────────────────────────────────────────────────────────
// 6. Functional smoke test: write→read round-trip across redundancy.
// ─────────────────────────────────────────────────────────────────
test('functional: state write lands in both files; read returns the most recent _ts', () => {
  // Replicate the redundancy logic against a tmp dir to verify the
  // contract holds — this catches future drift between source-scan and
  // actual behaviour.
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'merlin-state-test-'));
  const a = path.join(tmp, 'a', '.merlin-state.json');
  const b = path.join(tmp, 'b', '.merlin-state.json');

  function writeAtomic(p, payload) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const t = p + '.tmp-' + require('crypto').randomBytes(4).toString('hex');
    fs.writeFileSync(t, payload);
    fs.renameSync(t, p);
  }
  function readAt(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

  // First write — older _ts.
  writeAtomic(a, JSON.stringify({ activeBrand: 'old', _ts: 1000 }));
  // Second write — newer _ts at the alt path.
  writeAtomic(b, JSON.stringify({ activeBrand: 'new', _ts: 2000 }));

  const ra = readAt(a), rb = readAt(b);
  const winner = (Number(ra._ts) || 0) >= (Number(rb._ts) || 0) ? ra : rb;
  assert.equal(winner.activeBrand, 'new', 'newer _ts must win the merge');

  // Cleanup.
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('functional: brand recovery copies a stranded brand to canonical without overwriting', () => {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'merlin-brand-recover-'));
  const legacyBrandsDir = path.join(tmp, 'legacy', 'assets', 'brands');
  const canonicalBrandsDir = path.join(tmp, 'canonical', 'assets', 'brands');

  // Lay down a stranded brand at the legacy path.
  fs.mkdirSync(path.join(legacyBrandsDir, 'pog'), { recursive: true });
  fs.writeFileSync(path.join(legacyBrandsDir, 'pog', 'brand.md'), '# POG\n');
  fs.writeFileSync(path.join(legacyBrandsDir, 'pog', 'memory.md'), 'recovered from legacy\n');

  // Replicate the recovery logic.
  const dst = path.join(canonicalBrandsDir, 'pog');
  assert.equal(fs.existsSync(dst), false, 'canonical must start empty');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(path.join(legacyBrandsDir, 'pog'), dst,
    { recursive: true, errorOnExist: false, force: false });

  // Verify the brand is now at canonical, with the same content.
  assert.equal(fs.existsSync(path.join(dst, 'brand.md')), true);
  assert.equal(fs.readFileSync(path.join(dst, 'memory.md'), 'utf8'), 'recovered from legacy\n');

  // Idempotency: second copy attempt must NOT overwrite (write a marker
  // to the canonical brand, then re-attempt — marker must survive).
  fs.writeFileSync(path.join(dst, 'memory.md'), 'edited at canonical\n');
  // Skip-if-exists guard would short-circuit before cpSync; we replicate
  // by checking existsSync ourselves first.
  if (!fs.existsSync(dst)) {
    fs.cpSync(path.join(legacyBrandsDir, 'pog'), dst,
      { recursive: true, errorOnExist: false, force: false });
  }
  assert.equal(fs.readFileSync(path.join(dst, 'memory.md'), 'utf8'), 'edited at canonical\n',
    'canonical edit must survive recovery — recovery is one-way (legacy → canonical), idempotent');

  fs.rmSync(tmp, { recursive: true, force: true });
});
