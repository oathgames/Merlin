// REGRESSION GUARD (2026-08-30, update-cleanup-race):
// cleanupOrphanBinaries deleted merlin-update.bat, merlin-update.log, and any
// Merlin.Setup.*.exe unconditionally on every launch. All three ARE the live
// update: the batch cmd.exe is reading line-by-line off disk, the installer it
// is about to run, and the only log of what happened.
//
// The update flow quits the app and the installer relaunches it, so a restart
// during the update is guaranteed. The sweep therefore destroyed its own
// update every time, and the app offered the same version forever. A real
// install sat on 1.37.0 through three consecutive releases this way, and
// deleting the log is why four attempts left zero diagnostics.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// REGRESSION GUARD (2026-09-04, tmpdir-cross-file-race): cleanupOrphanBinaries
// sweeps the process-wide os.tmpdir() for Merlin.Setup.*.exe, and node --test
// runs test FILES concurrently in separate processes. binary-paths.test.js and
// this file both seed fixed-name installers there, so each file's sweep
// reclaimed the other's fixture and "still reclaims a genuinely stale
// installer" failed at random. Give this process its own tmpdir before
// requiring binary-paths.js (os.tmpdir() reads TEMP/TMP/TMPDIR every call).
{
  const realTmp = require('node:os').tmpdir();
  const mine = require('node:fs').mkdtempSync(require('node:path').join(realTmp, 'bpr-proc-'));
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = mine;
}

const {
  cleanupOrphanBinaries,
  isStaleUpdateArtifact,
  STALE_UPDATE_ARTIFACT_MS,
} = require('./binary-paths.js');

const HOUR = 60 * 60 * 1000;

// REGRESSION GUARD (2026-09-04, cross-test tmpdir race): these fixtures used
// to live in the shared os.tmpdir(). `node --test` runs test FILES in parallel
// processes, and binary-paths.test.js exercises the same sweep, so its
// cleanupOrphanBinaries() call deleted this file's deliberately-stale
// `Merlin.Setup.*.exe` before this file's own call could claim it. The
// assertions then disagreed with each other (file gone, but absent from OUR
// result.deleted) and the suite was red in CI while every targeted re-run was
// green. Each fixture now lives in a private directory that is passed to
// cleanupOrphanBinaries via `tmpDir`, so no other process can see it.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-race-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {} });

function makeTmpFile(name, ageMs) {
  const p = path.join(SANDBOX, name);
  fs.writeFileSync(p, 'x'.repeat(64));
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(p, when, when);
  }
  return p;
}

test('STALE_UPDATE_ARTIFACT_MS is long enough to outlast any real install', () => {
  assert.ok(STALE_UPDATE_ARTIFACT_MS >= HOUR,
    'an in-flight update must never be reclassified as an orphan within the hour');
});

test('a freshly written installer is NOT stale', () => {
  const p = makeTmpFile('Merlin.Setup.9.9.9.exe', 0);
  try {
    assert.strictEqual(isStaleUpdateArtifact(p), false,
      'an installer written seconds ago belongs to a running update');
  } finally { fs.unlinkSync(p); }
});

test('an installer older than the window IS stale', () => {
  const p = makeTmpFile('Merlin.Setup.9.9.8.exe', STALE_UPDATE_ARTIFACT_MS + HOUR);
  try {
    assert.strictEqual(isStaleUpdateArtifact(p), true);
  } finally { try { fs.unlinkSync(p); } catch {} }
});

test('an unreadable path is treated as NOT stale', () => {
  // Refusing to delete is the safe direction: a wrongly-kept file wastes
  // disk, a wrongly-deleted one breaks the update the user is waiting on.
  assert.strictEqual(
    isStaleUpdateArtifact(path.join(os.tmpdir(), 'merlin-does-not-exist-xyz.exe')),
    false
  );
});

test('cleanup does NOT delete a fresh installer or update script', () => {
  const exe = makeTmpFile('Merlin.Setup.9.9.7.exe', 0);
  const bat = makeTmpFile('merlin-update.bat', 0);
  try {
    const r = cleanupOrphanBinaries({ appRoot: null, log: () => {}, tmpDir: SANDBOX });
    assert.ok(fs.existsSync(exe), 'fresh installer must survive: it is the update being run');
    assert.ok(fs.existsSync(bat), 'fresh update script must survive: cmd.exe is reading it now');
    assert.ok(!r.deleted.includes(exe));
    assert.ok(!r.deleted.includes(bat));
  } finally {
    try { fs.unlinkSync(exe); } catch {}
    try { fs.unlinkSync(bat); } catch {}
  }
});

test('cleanup NEVER deletes merlin-update.log, at any age', () => {
  // The log is the post-mortem for a failed update. Sweeping it is what made
  // four consecutive failures undiagnosable.
  const fresh = makeTmpFile('merlin-update.log', 0);
  try {
    cleanupOrphanBinaries({ appRoot: null, log: () => {}, tmpDir: SANDBOX });
    assert.ok(fs.existsSync(fresh), 'fresh update log must survive');
    const old = new Date(Date.now() - (STALE_UPDATE_ARTIFACT_MS * 10));
    fs.utimesSync(fresh, old, old);
    const r = cleanupOrphanBinaries({ appRoot: null, log: () => {}, tmpDir: SANDBOX });
    assert.ok(fs.existsSync(fresh), 'even an old update log must survive');
    assert.ok(!r.deleted.some((p) => /merlin-update\.log$/i.test(p)));
  } finally { try { fs.unlinkSync(fresh); } catch {} }
});

test('cleanup still reclaims a genuinely stale installer', () => {
  const exe = makeTmpFile('Merlin.Setup.9.9.6.exe', STALE_UPDATE_ARTIFACT_MS + HOUR);
  const r = cleanupOrphanBinaries({ appRoot: null, log: () => {}, tmpDir: SANDBOX });
  assert.ok(!fs.existsSync(exe), 'a hours-old installer is a real orphan and should be reclaimed');
  assert.ok(r.deleted.includes(exe));
});

test('source no longer sweeps merlin-update.log', () => {
  const src = fs.readFileSync(path.join(__dirname, 'binary-paths.js'), 'utf8');
  const fn = src.slice(src.indexOf('function cleanupOrphanBinaries'));
  const body = fn.slice(0, fn.indexOf('function cleanupOrphanMacAppBundles'));
  const codeOnly = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(
    !/merlin-update\\.log/.test(codeOnly),
    'merlin-update.log must not appear in a match expression — it is a post-mortem, never an orphan'
  );
});

// REGRESSION GUARD (2026-09-04, cross-test tmpdir race, part 2): the sweep
// must honour the injected directory. If a future refactor re-hardcodes
// os.tmpdir() inside cleanupOrphanBinaries, the isolation above silently stops
// working and the flake comes back — so assert the scoping directly.
test('cleanupOrphanBinaries sweeps ONLY the tmpDir it is given', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-race-other-'));
  try {
    const outsider = path.join(other, 'Merlin.Setup.9.9.5.exe');
    fs.writeFileSync(outsider, 'x'.repeat(64));
    const when = new Date(Date.now() - (STALE_UPDATE_ARTIFACT_MS + HOUR));
    fs.utimesSync(outsider, when, when);

    const r = cleanupOrphanBinaries({ appRoot: null, log: () => {}, tmpDir: SANDBOX });
    assert.ok(fs.existsSync(outsider), 'a stale installer OUTSIDE the given tmpDir must not be touched');
    assert.ok(!r.deleted.includes(outsider));
    assert.ok(!r.skipped.includes(outsider));
  } finally {
    try { fs.rmSync(other, { recursive: true, force: true }); } catch {}
  }
});
