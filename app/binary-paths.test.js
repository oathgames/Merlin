// Tests for app/binary-paths.js — the single source of truth for the
// Merlin engine binary path + the cleanup of orphan binaries that
// prior versions of the auto-update flow left scattered across disk.
//
// REGRESSION GUARD (2026-05-09, binary-update-rsi):
// These tests lock the v1.21.28 architectural fix that closes audit
// findings C1, C3, D1, D2, E1. See app/binary-paths.js's package
// comment for the full incident narrative. Live anchor: a paying user
// spent ~8 hours on 2026-05-08 → 05-09 debugging Google OAuth because
// a v1.1.3 binary from 2026-04-28 was sitting in os.tmpdir() AND a
// fast-open scope drift was hiding the real failure mode.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bp = require('./binary-paths');

// ─── Path helpers ────────────────────────────────────────────────────

test('getCanonicalBinaryDir: Mac uses ~/Library/Application Support/Merlin/bin', () => {
  if (process.platform !== 'darwin') {
    return;
  }
  const dir = bp.getCanonicalBinaryDir();
  assert.ok(dir.endsWith(path.join('Library', 'Application Support', 'Merlin', 'bin')),
    `Mac canonical binary dir must be ~/Library/Application Support/Merlin/bin; got: ${dir}`);
});

test('getCanonicalBinaryDir: Windows uses %LOCALAPPDATA%\\Merlin\\bin', () => {
  if (process.platform !== 'win32') {
    return;
  }
  const dir = bp.getCanonicalBinaryDir();
  assert.ok(dir.endsWith(path.join('Merlin', 'bin')),
    `Windows canonical binary dir must end in Merlin\\bin; got: ${dir}`);
  // Should NOT use Documents (Optimize-Storage risk on Mac, but also
  // wrong convention on Windows).
  assert.ok(!/Documents/i.test(dir),
    `Windows canonical binary dir must NOT live under Documents; got: ${dir}`);
});

test('getCanonicalBinaryDir: Linux uses XDG_DATA_HOME with .local/share fallback', () => {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return;
  }
  // Without XDG_DATA_HOME set, fallback path
  const prevXdg = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME;
  try {
    const dir = bp.getCanonicalBinaryDir();
    assert.ok(dir.endsWith(path.join('.local', 'share', 'Merlin', 'bin')),
      `Linux canonical binary dir fallback must be ~/.local/share/Merlin/bin; got: ${dir}`);
  } finally {
    if (prevXdg !== undefined) process.env.XDG_DATA_HOME = prevXdg;
  }
});

test('getCanonicalBinaryPath: composes dir + binary name', () => {
  const full = bp.getCanonicalBinaryPath();
  const dir = bp.getCanonicalBinaryDir();
  assert.equal(path.dirname(full), dir);
  if (process.platform === 'win32') {
    assert.equal(path.basename(full), 'Merlin.exe');
  } else {
    assert.equal(path.basename(full), 'Merlin');
  }
});

// ─── resolveBinaryPath: priority order ───────────────────────────────

test('resolveBinaryPath: canonical wins when present', () => {
  // Create a real canonical path on disk, point appInstall + appRoot
  // at non-existent bogus paths, confirm canonical is returned.
  const canonical = bp.getCanonicalBinaryPath();
  let cleanup = false;
  if (!fs.existsSync(canonical)) {
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, 'test-binary-content');
    cleanup = true;
  }
  try {
    const tmpInstall = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-test-install-'));
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-test-root-'));
    try {
      const got = bp.resolveBinaryPath({ appInstall: tmpInstall, appRoot: tmpRoot });
      assert.equal(got, canonical,
        'When canonical exists, resolveBinaryPath MUST return canonical even if appInstall + appRoot are valid dirs');
    } finally {
      try { fs.rmSync(tmpInstall, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    }
  } finally {
    if (cleanup) {
      try { fs.unlinkSync(canonical); } catch {}
    }
  }
});

test('resolveBinaryPath: install-local wins over workspace when canonical missing', () => {
  // Make sure canonical is missing for this test (it might exist from
  // a prior production install; we'll check rather than disrupt).
  const canonical = bp.getCanonicalBinaryPath();
  const canonicalExists = fs.existsSync(canonical);
  if (canonicalExists) {
    // Skip — we can't safely test this branch without removing the
    // user's real binary. Test the logic via temp dirs only.
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-resolveorder-'));
  try {
    const fakeInstall = path.join(tmpRoot, 'install-local');
    const fakeAppRoot = path.join(tmpRoot, 'app-root');
    const installBinDir = path.join(fakeInstall, '.claude', 'tools');
    const wsBinDir = path.join(fakeAppRoot, '.claude', 'tools');
    fs.mkdirSync(installBinDir, { recursive: true });
    fs.mkdirSync(wsBinDir, { recursive: true });
    const installBin = path.join(installBinDir, bp.BINARY_NAME);
    const wsBin = path.join(wsBinDir, bp.BINARY_NAME);
    fs.writeFileSync(installBin, 'install-bin');
    fs.writeFileSync(wsBin, 'workspace-bin');

    const got = bp.resolveBinaryPath({ appInstall: fakeInstall, appRoot: fakeAppRoot });
    assert.equal(got, installBin,
      'When canonical missing AND both install-local AND workspace exist, install-local MUST win over workspace.');
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test('resolveBinaryPath: workspace fallback when only workspace exists', () => {
  const canonical = bp.getCanonicalBinaryPath();
  if (fs.existsSync(canonical)) return; // avoid disturbing real install

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-fallback-'));
  try {
    const fakeInstall = path.join(tmpRoot, 'install-local-empty');
    const fakeAppRoot = path.join(tmpRoot, 'app-root');
    fs.mkdirSync(fakeInstall, { recursive: true }); // exists but no .claude/tools
    const wsBinDir = path.join(fakeAppRoot, '.claude', 'tools');
    fs.mkdirSync(wsBinDir, { recursive: true });
    const wsBin = path.join(wsBinDir, bp.BINARY_NAME);
    fs.writeFileSync(wsBin, 'workspace-bin');

    const got = bp.resolveBinaryPath({ appInstall: fakeInstall, appRoot: fakeAppRoot });
    assert.equal(got, wsBin,
      'When canonical + install-local both missing, workspace path MUST be returned as the final fallback.');
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

// ─── compareVersionStrings ──────────────────────────────────────────

test('compareVersionStrings: extracts version from "Merlin Pipeline v1.21.28"', () => {
  assert.equal(bp.compareVersionStrings('Merlin Pipeline v1.21.28', 'Merlin Pipeline v1.21.27'), 1);
  assert.equal(bp.compareVersionStrings('Merlin Pipeline v1.21.27', 'Merlin Pipeline v1.21.28'), -1);
  assert.equal(bp.compareVersionStrings('Merlin Pipeline v1.21.28', 'Merlin Pipeline v1.21.28'), 0);
});

test('compareVersionStrings: handles bare "1.2.3" form', () => {
  assert.equal(bp.compareVersionStrings('2.0.0', '1.99.99'), 1);
  assert.equal(bp.compareVersionStrings('1.21.28', '1.22.0'), -1);
});

test('compareVersionStrings: missing version components → treated as 0.0.0', () => {
  assert.equal(bp.compareVersionStrings('foo', 'bar'), 0);
});

// ─── Pending-restart marker round-trip ───────────────────────────────

test('writePendingRestartMarker → readPendingRestartMarker: round-trip works', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-marker-'));
  try {
    const ok = bp.writePendingRestartMarker(tmp, {
      fromVersion: '1.21.27',
      toVersion: '1.21.28',
      files: ['app/main.js', 'app/oauth-provider-config.js'],
    });
    assert.equal(ok, true);
    const back = bp.readPendingRestartMarker(tmp);
    assert.equal(back.fromVersion, '1.21.27');
    assert.equal(back.toVersion, '1.21.28');
    assert.deepEqual(back.files, ['app/main.js', 'app/oauth-provider-config.js']);
    assert.ok(typeof back.writtenAt === 'string', 'writtenAt timestamp must be set');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('clearPendingRestartMarker: returns false when no marker exists, true after delete', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-marker-clr-'));
  try {
    assert.equal(bp.clearPendingRestartMarker(tmp), false, 'no marker → false');
    bp.writePendingRestartMarker(tmp, { fromVersion: 'a', toVersion: 'b', files: [] });
    assert.equal(bp.clearPendingRestartMarker(tmp), true, 'after write → true');
    assert.equal(bp.readPendingRestartMarker(tmp), null, 'after clear → readback null');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('readPendingRestartMarker: returns null on bad JSON', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-marker-bad-'));
  try {
    fs.writeFileSync(bp.pendingRestartMarkerPath(tmp), 'not-json{{{');
    assert.equal(bp.readPendingRestartMarker(tmp), null);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

// ─── isCachedJsModulePath ────────────────────────────────────────────

test('isCachedJsModulePath: returns true for THIS test file (currently in require.cache)', () => {
  // This test file is being executed via `node --test`, which means it
  // IS in require.cache. The function should return true for it.
  const me = __filename;
  assert.equal(bp.isCachedJsModulePath(me), true,
    'isCachedJsModulePath must detect a module that\'s currently loaded.');
});

test('isCachedJsModulePath: returns true for binary-paths.js (we required it)', () => {
  const target = require.resolve('./binary-paths.js');
  assert.equal(bp.isCachedJsModulePath(target), true);
});

test('isCachedJsModulePath: returns false for a non-JS path', () => {
  assert.equal(bp.isCachedJsModulePath('/some/file.txt'), false);
  assert.equal(bp.isCachedJsModulePath('/some/file.json'), false);
  assert.equal(bp.isCachedJsModulePath(''), false);
  assert.equal(bp.isCachedJsModulePath(null), false);
});

test('isCachedJsModulePath: returns false for a JS file that was never required', () => {
  // Create a unique JS file that we never require()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-uncached-'));
  try {
    const jsPath = path.join(tmp, `unique-${Date.now()}-${Math.random()}.js`);
    fs.writeFileSync(jsPath, '// never loaded\nmodule.exports = 1;\n');
    assert.equal(bp.isCachedJsModulePath(jsPath), false,
      'Module that was never required MUST NOT match.');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

// ─── cleanupOrphanBinaries ───────────────────────────────────────────

test('cleanupOrphanBinaries: deletes a stale workspace binary', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-cleanup-'));
  try {
    const fakeAppRoot = path.join(tmp, 'app-root');
    const wsBinDir = path.join(fakeAppRoot, '.claude', 'tools');
    fs.mkdirSync(wsBinDir, { recursive: true });
    const wsBin = path.join(wsBinDir, bp.BINARY_NAME);
    fs.writeFileSync(wsBin, 'fake-orphan-content');

    const result = bp.cleanupOrphanBinaries({ appRoot: fakeAppRoot, log: () => {} });
    assert.ok(result.deleted.includes(wsBin),
      `workspace orphan must be deleted; got ${JSON.stringify(result)}`);
    assert.equal(fs.existsSync(wsBin), false, 'workspace orphan file must be gone after cleanup');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('cleanupOrphanBinaries: does NOT delete the canonical binary', () => {
  // If canonical happens to exist (e.g. on a real install), make sure
  // cleanup doesn't touch it.
  const canonical = bp.getCanonicalBinaryPath();
  if (!fs.existsSync(canonical)) return; // can't test this branch

  const sizeBefore = fs.statSync(canonical).size;
  bp.cleanupOrphanBinaries({ appRoot: undefined, log: () => {} });
  assert.equal(fs.existsSync(canonical), true, 'canonical must survive cleanup');
  assert.equal(fs.statSync(canonical).size, sizeBefore, 'canonical size must not change');
});

test('cleanupOrphanBinaries: does NOT delete a 0-byte file at orphan path (defensive)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-empty-'));
  try {
    const fakeAppRoot = path.join(tmp, 'app-root');
    const wsBinDir = path.join(fakeAppRoot, '.claude', 'tools');
    fs.mkdirSync(wsBinDir, { recursive: true });
    const wsBin = path.join(wsBinDir, bp.BINARY_NAME);
    fs.writeFileSync(wsBin, '');
    const result = bp.cleanupOrphanBinaries({ appRoot: fakeAppRoot, log: () => {} });
    assert.equal(fs.existsSync(wsBin), true, 'empty file must NOT be auto-deleted');
    assert.ok(result.skipped.includes(wsBin),
      `0-byte file should be in skipped list; got ${JSON.stringify(result)}`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('cleanupOrphanBinaries: handles missing files gracefully (idempotent)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-missing-'));
  try {
    // No binaries written — cleanup should no-op cleanly.
    const result = bp.cleanupOrphanBinaries({ appRoot: tmp, log: () => {} });
    assert.equal(result.errors.length, 0, 'missing files must not produce errors');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('cleanupOrphanBinaries: deletes a STALE installer-stage Merlin.Setup.X.Y.Z.exe (D1 fix)', () => {
  // AMENDED 2026-08-30 (update-cleanup-race): this test used to write a FRESH
  // installer and assert it was deleted, which is exactly the bug. The D1
  // sweep ran on every launch, and the update flow guarantees a launch while
  // the installer is still in use, so the app deleted its own update every
  // time and offered the same version forever. The contract is now
  // age-gated: a stale artifact is reclaimed, a fresh one is left alone.
  // See the companion assertions in binary-paths-update-race.test.js.
  const v = `999.${Date.now() % 1000}.${Math.floor(Math.random() * 1000)}`;
  const installer = path.join(os.tmpdir(), `Merlin.Setup.${v}.exe`);
  fs.writeFileSync(installer, 'fake-installer-bytes-larger-than-zero');
  // Backdate it well past the in-flight window so it reads as a real orphan.
  const old = new Date(Date.now() - (bp.STALE_UPDATE_ARTIFACT_MS + 60 * 60 * 1000));
  fs.utimesSync(installer, old, old);
  try {
    const result = bp.cleanupOrphanBinaries({ appRoot: undefined, log: () => {} });
    assert.equal(fs.existsSync(installer), false,
      'a stale Merlin.Setup.<semver>.exe in tmpdir must be cleaned (D1 audit finding)');
    assert.ok(result.deleted.includes(installer), 'installer must appear in deleted list');
  } finally {
    try { fs.unlinkSync(installer); } catch {}
  }
});

test('cleanupOrphanBinaries: leaves a FRESH installer alone (update-cleanup-race)', () => {
  const v = `998.${Date.now() % 1000}.${Math.floor(Math.random() * 1000)}`;
  const installer = path.join(os.tmpdir(), `Merlin.Setup.${v}.exe`);
  fs.writeFileSync(installer, 'fake-installer-bytes-larger-than-zero');
  try {
    const result = bp.cleanupOrphanBinaries({ appRoot: undefined, log: () => {} });
    assert.equal(fs.existsSync(installer), true,
      'a just-written installer is the update currently being run, not an orphan');
    assert.ok(!result.deleted.includes(installer));
  } finally {
    try { fs.unlinkSync(installer); } catch {}
  }
});

// ─── hydrateCanonicalBinary ──────────────────────────────────────────

test('hydrateCanonicalBinary: no-op when install-local missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-hydrate-noinstall-'));
  try {
    const result = await bp.hydrateCanonicalBinary({
      appInstall: path.join(tmp, 'no-install-here'),
      log: () => {},
    });
    assert.equal(result.hydrated, false);
    assert.match(result.reason, /install-local missing/);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

// ─── cleanupOrphanMacAppBundles ──────────────────────────────────────
//
// REGRESSION GUARD (2026-05-10, mac-app-bundle-cleanup):
// Mac users reported every update produces /Applications/Merlin 2.app,
// Merlin 3.app etc. instead of replacing in place. The cleanup helper
// scans /Applications for `^Merlin( \d+)?\.app$`, keeps the running
// app, deletes the rest. Tests run against a SANDBOX directory rather
// than touching real /Applications — the helper is parameterized in a
// way that the tests verify the regex + safety logic, not the live
// /Applications interaction (which is dev-machine-dependent).

test('cleanupOrphanMacAppBundles: no-op on non-darwin', () => {
  if (process.platform === 'darwin') return; // can't test the no-op on Mac
  const result = bp.cleanupOrphanMacAppBundles({
    runningExePath: '/Applications/Merlin.app/Contents/MacOS/Merlin',
    log: () => {},
  });
  assert.equal(result.deleted.length, 0, 'must be a no-op on non-Darwin');
  assert.equal(result.reason, 'not-darwin');
});

test('cleanupOrphanMacAppBundles: handles missing /Applications gracefully', () => {
  // Even on Mac, if /Applications can't be read for some reason, the
  // helper must not throw — must return a structured result.
  const result = bp.cleanupOrphanMacAppBundles({
    runningExePath: '/totally/fake/path/Merlin.app/Contents/MacOS/Merlin',
    log: () => {},
  });
  assert.ok(Array.isArray(result.deleted), 'returns deleted array');
  assert.ok(Array.isArray(result.skipped), 'returns skipped array');
  assert.ok(Array.isArray(result.errors), 'returns errors array');
});

test('cleanupOrphanMacAppBundles: bails out when runningExePath is malformed', () => {
  if (process.platform !== 'darwin') return;
  // If the running exe path doesn't resolve to an .app bundle, the
  // helper bails rather than risk deleting wrong things.
  const result = bp.cleanupOrphanMacAppBundles({
    runningExePath: '/usr/local/bin/some-tool',
    log: () => {},
  });
  assert.equal(result.deleted.length, 0,
    'must not delete anything when running exe doesn\'t look like an .app bundle');
  assert.match(result.reason || '', /doesn't resolve to \.app bundle/);
});

test('cleanupOrphanMacAppBundles: dup-name regex matches Finder "Keep Both" pattern', () => {
  // Source-scan: the regex must match Finder's exact rename pattern.
  // Finder uses a single space + integer + ".app" — e.g. "Merlin 2.app",
  // "Merlin 3.app". It does NOT use "Merlin-2.app" or "Merlin(2).app".
  const src = fs.readFileSync(path.join(__dirname, 'binary-paths.js'), 'utf8');
  const fnStart = src.indexOf('function cleanupOrphanMacAppBundles(');
  const fnEnd = src.indexOf('\nfunction ', fnStart + 36);
  const body = fnEnd > 0 ? src.slice(fnStart, fnEnd) : src.slice(fnStart);
  // Find the dupRe definition.
  const reMatch = body.match(/const dupRe = (\/[^/]+\/[gimsuy]*)/);
  assert.ok(reMatch, 'cleanupOrphanMacAppBundles must declare a dupRe regex');
  // Reconstruct the regex and test it.
  const reSrc = reMatch[1];
  const re = eval(reSrc); // safe — we just read it from our own source
  // Must match Finder's standard rename pattern.
  assert.ok(re.test('Merlin.app'), 'must match base Merlin.app');
  assert.ok(re.test('Merlin 2.app'), 'must match Merlin 2.app');
  assert.ok(re.test('Merlin 3.app'), 'must match Merlin 3.app');
  assert.ok(re.test('Merlin 99.app'), 'must match higher-numbered duplicates');
  // Must NOT match unrelated apps.
  assert.ok(!re.test('MerlinPro.app'), 'must NOT match MerlinPro.app');
  assert.ok(!re.test('Merlin Pro.app'), 'must NOT match Merlin Pro.app (no number)');
  assert.ok(!re.test('Merlin-2.app'), 'must NOT match Merlin-2.app (different separator)');
  assert.ok(!re.test('Merlinette.app'), 'must NOT match Merlinette.app');
  assert.ok(!re.test('Merlin.appx'), 'must NOT match Merlin.appx');
});

test('cleanupOrphanMacAppBundles: bundle-identifier guard exists', () => {
  // The helper must read CFBundleIdentifier from each candidate's
  // Info.plist and only delete bundles whose identifier matches the
  // running app's. This guards against any third-party "Merlin"-named
  // app on the user's system. Source-scan asserts the guard is present.
  const src = fs.readFileSync(path.join(__dirname, 'binary-paths.js'), 'utf8');
  const fnStart = src.indexOf('function cleanupOrphanMacAppBundles(');
  const fnEnd = src.indexOf('\nfunction ', fnStart + 36);
  const body = fnEnd > 0 ? src.slice(fnStart, fnEnd) : src.slice(fnStart);
  assert.ok(/CFBundleIdentifier/.test(body),
    'cleanupOrphanMacAppBundles must read CFBundleIdentifier from Info.plist');
  assert.ok(/runningBundleID/.test(body),
    'cleanupOrphanMacAppBundles must compute the running app\'s bundle ID');
  // The skip path must reference an identifier mismatch.
  assert.ok(/CFBundleIdentifier=/.test(body),
    'skipped reason must surface the identifier mismatch for telemetry');
});

test('cleanupOrphanMacAppBundles: refuses to delete the running app', () => {
  // Source-scan: the helper must compare each candidate against
  // runningAppPath and skip the running one.
  const src = fs.readFileSync(path.join(__dirname, 'binary-paths.js'), 'utf8');
  const fnStart = src.indexOf('function cleanupOrphanMacAppBundles(');
  const fnEnd = src.indexOf('\nfunction ', fnStart + 36);
  const body = fnEnd > 0 ? src.slice(fnStart, fnEnd) : src.slice(fnStart);
  assert.ok(/fullPath === runningAppPath/.test(body),
    'cleanupOrphanMacAppBundles must skip the running app via path equality check');
  assert.ok(/\(running\)/.test(body),
    'skipped reason for the running app must say "(running)"');
});

// ─── F1: merlin-config.json write-location lint ──────────────────────
//
// REGRESSION GUARD (2026-05-09, binary-update-rsi audit Phase F finding F1):
// The Go binary derives its projectRoot from the location of
// merlin-config.json via filepath.Dir^3(globalConfigPath). Any JS
// write of merlin-config.json outside <appRoot>/.claude/tools/ would
// cause the Go binary to compute a wrong projectRoot — silently
// stranding brand files, results, and config-derived paths. The
// audit cited a live incident at autocmo-core comments around line
// 6089 where a tmp config in os.tmpdir() did exactly this.
//
// This test source-scans every app/*.js for `merlin-config.json`
// writes and asserts the resolved path lives under .claude/tools/
// (or is a documented temp-roundtrip with an explicit tmpdir + 10s
// cleanup pattern, which is allowed but heavily scrutinized).

test('F1 lint: every merlin-config.json write lands inside .claude/tools/ or a documented tmp-roundtrip', () => {
  const appDir = path.resolve(__dirname);
  const entries = fs.readdirSync(appDir).filter((f) => f.endsWith('.js'));
  const violations = [];
  // Allow patterns that are KNOWN-SAFE:
  //   - path.join(<...>, '.claude', 'tools', 'merlin-config.json')      ← canonical
  //   - path.join(<stateDir>, 'merlin-config.json')                     ← Cluster-B StateDir
  //   - path.join(os.tmpdir(), `.merlin-config-tmp-${...}.json`)        ← tmp-roundtrip with cleanup
  //   - merlin-config-tmp-* (any path) — not the real config name
  //   - merlin-config-<brand>.json (per-brand override) — different file
  // The deny list catches: anyone writing the literal "merlin-config.json"
  // at a path that doesn't include `.claude/tools` or `stateDir` or a
  // tmp-roundtrip prefix.
  const SAFE_LOCATION_HINTS = [
    /['"`]\.claude['"`]\s*,\s*['"`]tools['"`]/,
    /stateDir/,
    /['"`]merlin-config-tmp-/,
    /['"`]merlin-config-[a-z0-9-]+\.json['"`]/i,
  ];
  for (const file of entries) {
    if (file.endsWith('.test.js')) continue;
    const full = path.join(appDir, file);
    let src;
    try { src = fs.readFileSync(full, 'utf8'); } catch { continue; }
    // Find any line that writes the literal "merlin-config.json".
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Look for write calls referencing merlin-config.json.
      if (!/merlin-config\.json/.test(line)) continue;
      // Skip if this is a comment-only line.
      const stripped = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trim();
      if (!stripped) continue;
      // Must be a write/copy/rename context.
      const isWriteContext = /writeFileSync|writeFile\b|copyFileSync|renameSync|createWriteStream/.test(line);
      if (!isWriteContext) continue;
      // Now check the path-construction context — look at the previous
      // 3 + next 1 lines for safe-location hints.
      const window = lines.slice(Math.max(0, i - 3), i + 2).join('\n');
      const hasSafeHint = SAFE_LOCATION_HINTS.some((re) => re.test(window));
      if (!hasSafeHint) {
        violations.push(`${file}:${i + 1} — ${line.trim()}`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(
      'F1 lint failure: merlin-config.json write detected outside the canonical .claude/tools/ ' +
      'or stateDir or tmp-roundtrip path. Per the binary-paths audit (Phase F finding F1), the Go ' +
      'binary derives projectRoot from the config-file location via filepath.Dir^3, so writes ' +
      'outside canonical strand brand files. Move the write into .claude/tools/ or use the ' +
      'tmp-roundtrip pattern with an explicit cleanup timer.\n\nViolations:\n  ' +
      violations.join('\n  ')
    );
  }
});

// ─── Module exports surface ──────────────────────────────────────────

test('module exports the documented surface', () => {
  const required = [
    'BINARY_NAME', 'getCanonicalBinaryDir', 'getCanonicalBinaryPath',
    'resolveBinaryPath', 'hydrateCanonicalBinary', 'cleanupOrphanBinaries',
    'compareVersionStrings', 'writePendingRestartMarker',
    'readPendingRestartMarker', 'clearPendingRestartMarker',
    'pendingRestartMarkerPath', 'isCachedJsModulePath',
    'PENDING_RESTART_MARKER_NAME',
  ];
  for (const name of required) {
    assert.ok(name in bp, `binary-paths.js must export ${name}`);
  }
});
