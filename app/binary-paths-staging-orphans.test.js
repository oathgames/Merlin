// REGRESSION GUARD (2026-09-04, engine-install-bak-never-swept):
//
// engine-install.js:atomicReplaceBinary stages the download at `<target>.new`
// and moves the incumbent aside to `<target>.bak`. Its final
// `try { fs.unlinkSync(bakPath); } catch {}` is best-effort on purpose (a
// failed cleanup must not fail an otherwise-good update), and on Windows it
// fails routinely: the just-replaced executable is commonly still mapped by AV
// or a lingering child process, so the unlink throws EBUSY and is swallowed.
// The comment there says a leftover .bak is harmless because "the next update
// clears it" -- true only if there IS a next update, and nothing else on disk
// ever looked for those names. cleanupOrphanBinaries, the every-launch sweep
// whose entire job is exactly this, had no .bak/.new pattern, so a user who
// updated once kept a full second copy of the engine forever.
//
// Both names are staleness-gated for the same reason the installer artifacts
// are: an update running right now owns those exact files, and a second app
// instance sweeping at launch must not delete them out from under it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  cleanupOrphanBinaries,
  STALE_UPDATE_ARTIFACT_MS,
} = require('./binary-paths.js');

const BINARY_NAME = process.platform === 'win32' ? 'Merlin.exe' : 'Merlin';

// Private sandboxes per the 2026-09-04 cross-test tmpdir race note in
// binary-paths-update-race.test.js: node --test runs files in parallel
// processes and several of them exercise this same sweep.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-staging-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {} });

function makeAppRoot(name) {
  const root = path.join(SANDBOX, name);
  fs.mkdirSync(path.join(root, '.claude', 'tools'), { recursive: true });
  return root;
}

function writeAged(fullPath, ageMs) {
  fs.writeFileSync(fullPath, 'x'.repeat(64));
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(fullPath, when, when);
  }
  return fullPath;
}

function sweep(appRoot, tmpDir) {
  return cleanupOrphanBinaries({ appRoot, log: () => {}, tmpDir });
}

test('a stale Merlin.exe.bak left by a failed unlink is swept', () => {
  const root = makeAppRoot('bak-stale');
  const tmp = fs.mkdtempSync(path.join(SANDBOX, 'tmp-'));
  const bak = writeAged(
    path.join(root, '.claude', 'tools', `${BINARY_NAME}.bak`),
    STALE_UPDATE_ARTIFACT_MS + 60000,
  );
  const r = sweep(root, tmp);
  assert.ok(r.deleted.includes(bak),
    'the .bak the update could not unlink is a full second copy of the engine; the launch sweep is the only thing that will ever remove it');
  assert.strictEqual(fs.existsSync(bak), false);
});

test('a stale Merlin.exe.new left by an aborted update is swept', () => {
  const root = makeAppRoot('new-stale');
  const tmp = fs.mkdtempSync(path.join(SANDBOX, 'tmp-'));
  const staged = writeAged(
    path.join(root, '.claude', 'tools', `${BINARY_NAME}.new`),
    STALE_UPDATE_ARTIFACT_MS + 60000,
  );
  const r = sweep(root, tmp);
  assert.ok(r.deleted.includes(staged));
  assert.strictEqual(fs.existsSync(staged), false);
});

test('a FRESH .bak/.new belongs to a running update and is skipped, not deleted', () => {
  const root = makeAppRoot('fresh');
  const tmp = fs.mkdtempSync(path.join(SANDBOX, 'tmp-'));
  const bak = writeAged(path.join(root, '.claude', 'tools', `${BINARY_NAME}.bak`), 0);
  const staged = writeAged(path.join(root, '.claude', 'tools', `${BINARY_NAME}.new`), 0);
  const r = sweep(root, tmp);
  for (const p of [bak, staged]) {
    assert.ok(fs.existsSync(p),
      'deleting a staging file seconds old destroys the update that is writing it -- the same failure mode as the 2026-08-30 installer race');
    assert.ok(r.skipped.includes(p));
    assert.ok(!r.deleted.includes(p));
  }
});

test('the sweep is idempotent and silent when no staging debris exists', () => {
  const root = makeAppRoot('empty');
  const tmp = fs.mkdtempSync(path.join(SANDBOX, 'tmp-'));
  const r = sweep(root, tmp);
  assert.deepStrictEqual(r.deleted, []);
  assert.deepStrictEqual(r.errors, []);
});

test('the canonical bin dir is swept too, not just the legacy workspace dir', () => {
  // engine-install writes to the CANONICAL path (that is what /update
  // replaces), so a sweep that only looked at appRoot would miss every real
  // leftover. Source-scanned rather than exercised, because pointing a test at
  // the real canonical dir would delete a developer's own files.
  const src = fs.readFileSync(path.join(__dirname, 'binary-paths.js'), 'utf8');
  const fn = src.slice(src.indexOf('function cleanupOrphanBinaries'));
  assert.ok(/stagingDirs\s*=\s*\[getCanonicalBinaryDir\(\)\]/.test(fn),
    'the canonical bin dir must be first in the staging sweep');
  assert.ok(/UPDATE_STAGING_SUFFIXES\s*=\s*\['\.bak',\s*'\.new'\]/.test(fn),
    'both staging suffixes must be swept; .new is left behind by every aborted update');
  assert.ok(/BINARY_NAME \+ suffix/.test(fn),
    'suffixes must append to BINARY_NAME so the mac/Linux "Merlin.bak" names are covered as well as "Merlin.exe.bak"');
  assert.ok(/isStaleUpdateArtifact\(full\)/.test(fn),
    'the staging sweep must be staleness-gated like the installer sweep');
});

test('engine-install still stages at .new/.bak, so the swept names stay correct', () => {
  const src = fs.readFileSync(path.join(__dirname, 'engine-install.js'), 'utf8');
  assert.match(src, /const newPath = `\$\{targetPath\}\.new`;/);
  assert.match(src, /const bakPath = `\$\{targetPath\}\.bak`;/);
  assert.match(src, /try \{ fs\.unlinkSync\(bakPath\); \} catch \{\}/,
    'the swallowed unlink is why the sweep has to exist; if it ever becomes strict, revisit this guard');
});
