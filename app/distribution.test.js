// Tests for RSI §2 distribution / platform-integration tasks (Cluster-L).
//
// Covers:
//   2.1 — ensureBinaryMinVersion prefers install-local before network fetch.
//   2.5 — Mac DMG auto-update uses hdiutil + ditto, not `open [dmg]`.
//   2.6 — Mic permission IPC handlers (status / request / open-settings).
//   2.7 — merlin:// URL scheme registration + deep-link buffering.
//   2.8 — releaseHasInstallerForPlatform respects process.arch on Mac;
//         pickMacInstallerAssetName honours arch preference and universal fallback.
//
// These tests source-scan app/main.js and app/preload.js rather than booting
// Electron — main.js imports `app` which cannot run under `node --test`.
//
// Run with: node --test app/distribution.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const PRELOAD_JS = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// ─── §2.1 ────────────────────────────────────────────────────────────
test('2.1 — ensureBinaryMinVersion prefers install-local binary before download', () => {
  const fn = MAIN_JS.slice(MAIN_JS.indexOf('async function ensureBinaryMinVersion'));
  const end = fn.indexOf('\nasync function ');
  const body = fn.slice(0, end);
  assert.ok(
    body.includes('appInstall'),
    'install-local probe references appInstall',
  );
  assert.ok(
    body.includes('getBinaryVersionAt(installLocalPath)'),
    'explicit version probe against install-local path',
  );
  // Probe must happen BEFORE the forced download.
  const probeIdx = body.indexOf('getBinaryVersionAt(installLocalPath)');
  const downloadIdx = body.indexOf("ensureBinary({ force: true");
  assert.ok(probeIdx > 0 && downloadIdx > probeIdx, 'probe precedes forced download');
});

test('2.1 — getBinaryVersionAt is a reusable helper for arbitrary paths', () => {
  assert.ok(
    MAIN_JS.includes('async function getBinaryVersionAt('),
    'getBinaryVersionAt defined as path-parameterized helper',
  );
  assert.ok(
    MAIN_JS.includes('return getBinaryVersionAt(getBinaryPath());'),
    'getBinaryVersion delegates to getBinaryVersionAt',
  );
});

// ─── §2.5 ────────────────────────────────────────────────────────────
test('2.5 — Mac DMG installer uses hdiutil + ditto (no drag flow)', () => {
  // Scope: the darwin branch of installUpdateFromLatestRelease. We anchor on
  // the `pickMacInstallerAssetName(data.assets)` call that only appears in
  // that branch (it's the §2.8 arch-aware picker introduced here).
  const anchor = MAIN_JS.indexOf('pickMacInstallerAssetName(data.assets)');
  assert.ok(anchor > 0, 'pickMacInstallerAssetName call found (anchors darwin install branch)');
  // Walk backwards to the enclosing `else if (process.platform === 'darwin')`.
  const darwinStart = MAIN_JS.lastIndexOf("} else if (process.platform === 'darwin') {", anchor);
  assert.ok(darwinStart > 0 && darwinStart < anchor, 'darwin branch found');
  const darwinEnd = MAIN_JS.indexOf('} else {', anchor);
  const body = MAIN_JS.slice(darwinStart, darwinEnd);
  assert.ok(/spawnSync\('hdiutil',/.test(body), 'hdiutil attach + detach in use');
  assert.ok(body.includes("'attach'"), 'attach verb present');
  assert.ok(/spawnSync\('ditto',/.test(body), 'ditto copies app into Applications');
  assert.ok(body.includes("'detach'"), 'detach cleanup present');
  // Legacy fallback (open dmg) is retained ONLY in the error branch.
  const openCalls = body.match(/spawn\('open'/g) || [];
  assert.ok(openCalls.length >= 1, 'fallback `open` preserved');
  // `xattr -dr com.apple.quarantine` clears the bundle so Gatekeeper does not stall.
  assert.ok(body.includes("'-dr', 'com.apple.quarantine'"), 'quarantine attribute cleared on target');
  // New relaunch verb: `open -n /Applications/Merlin.app`.
  assert.ok(body.includes("'-n', targetAppPath"), 'relaunch uses -n with targetAppPath');
});

// ─── §2.6 ────────────────────────────────────────────────────────────
test('2.6 — mic permission IPC handlers are registered', () => {
  assert.ok(
    MAIN_JS.includes("ipcMain.handle('mic-permission-status'"),
    'status handler registered',
  );
  assert.ok(
    MAIN_JS.includes("ipcMain.handle('mic-permission-request'"),
    'request handler registered',
  );
  assert.ok(
    MAIN_JS.includes("ipcMain.handle('mic-permission-open-settings'"),
    'open-settings handler registered',
  );
  // systemPreferences is imported from electron.
  assert.ok(
    /require\('electron'\)[\s\S]*?systemPreferences/.test(MAIN_JS),
    'systemPreferences imported from electron',
  );
});

test('2.6 — mic handlers no-op on non-darwin', () => {
  // Source-scan the status handler body: non-darwin returns granted/unknown
  // WITHOUT consulting systemPreferences APIs.
  const statusIdx = MAIN_JS.indexOf("ipcMain.handle('mic-permission-status'");
  const end = MAIN_JS.indexOf('\nipcMain.handle(', statusIdx + 1);
  const body = MAIN_JS.slice(statusIdx, end);
  assert.ok(
    body.includes("process.platform !== 'darwin'") && body.indexOf("process.platform !== 'darwin'") < body.indexOf('getMediaAccessStatus'),
    'non-darwin early-return precedes getMediaAccessStatus',
  );
});

test('2.6 — preload exposes mic permission methods', () => {
  assert.ok(PRELOAD_JS.includes('micPermissionStatus'), 'micPermissionStatus exposed');
  assert.ok(PRELOAD_JS.includes('micPermissionRequest'), 'micPermissionRequest exposed');
  assert.ok(PRELOAD_JS.includes('micPermissionOpenSettings'), 'micPermissionOpenSettings exposed');
});

// ─── §2.7 ────────────────────────────────────────────────────────────
test('2.7 — merlin:// scheme is declared as privileged BEFORE whenReady', () => {
  const schemeIdx = MAIN_JS.indexOf('registerSchemesAsPrivileged');
  const readyIdx = MAIN_JS.indexOf('app.whenReady()');
  assert.ok(schemeIdx > 0 && schemeIdx < readyIdx, 'scheme registered before whenReady');
  assert.ok(
    /\{\s*scheme:\s*'merlin'/.test(MAIN_JS),
    'merlin scheme present in privileged list',
  );
});

test('2.7 — open-url handler fires deep link on Mac', () => {
  assert.ok(MAIN_JS.includes("app.on('open-url'"), 'open-url listener attached');
  const idx = MAIN_JS.indexOf("app.on('open-url'");
  const end = MAIN_JS.indexOf('\n});\n', idx);
  const body = MAIN_JS.slice(idx, end);
  assert.ok(body.includes('event.preventDefault()'), 'preventDefault before delivering');
  assert.ok(body.includes('deliverDeepLink(url)'), 'routes into deliverDeepLink');
});

test('2.7 — second-instance handler scans argv for merlin:// URLs', () => {
  const idx = MAIN_JS.indexOf("app.on('second-instance'");
  const end = MAIN_JS.indexOf('\n});\n', idx);
  const body = MAIN_JS.slice(idx, end);
  assert.ok(/\/\^merlin:\\\/\\\/\/i/.test(body), 'argv filtered with merlin:// regex');
  assert.ok(body.includes('deliverDeepLink'), 'matched URL routed through deliverDeepLink');
});

test('2.7 — pending deep link is flushed after did-finish-load', () => {
  assert.ok(MAIN_JS.includes('flushPendingDeepLink'), 'flush helper defined');
  assert.ok(
    /did-finish-load[^}]*flushPendingDeepLink\(\)/s.test(MAIN_JS),
    'flush invoked on did-finish-load',
  );
});

test('2.7 — setAsDefaultProtocolClient is invoked on packaged builds', () => {
  assert.ok(
    MAIN_JS.includes("app.setAsDefaultProtocolClient('merlin')"),
    'default protocol client registration present',
  );
});

test('2.7 — preload exposes onMerlinDeepLink subscription', () => {
  assert.ok(PRELOAD_JS.includes('onMerlinDeepLink'), 'onMerlinDeepLink exported');
  assert.ok(
    PRELOAD_JS.includes("ipcRenderer.on('merlin-deep-link'"),
    'onMerlinDeepLink wires the main-process channel',
  );
});

test('2.7 — package.json declares the merlin:// protocol for electron-builder', () => {
  const protocols = PACKAGE_JSON && PACKAGE_JSON.build && PACKAGE_JSON.build.protocols;
  assert.ok(Array.isArray(protocols), 'build.protocols is an array');
  const merlin = protocols.find((p) => p && Array.isArray(p.schemes) && p.schemes.includes('merlin'));
  assert.ok(merlin, 'merlin scheme declared in build.protocols (for Info.plist)');
});

// ─── §2.8 ────────────────────────────────────────────────────────────
// REGRESSION (2026-07-03, mac-compat): these fixtures now use the REAL release
// asset names electron-builder produces (verified against live releases), NOT
// the fictional Merlin-mac-arm64.dmg / Merlin-mac-x64.dmg / Merlin-mac.dmg
// names the prior tests asserted. Those fictional names let the picker match
// zero real assets while the suite stayed green, which is how the Intel-gets-
// arm64-zip bug shipped. Do not reintroduce hyphenated -mac-<arch> fixtures.
const REAL_MAC_RELEASE = [
  { name: 'Merlin-1.32.0-arm64.dmg' },      // Apple Silicon installer
  { name: 'Merlin-1.32.0.dmg' },            // Intel x64 installer (NO arch marker)
  { name: 'Merlin-1.32.0-arm64-mac.zip' },  // arm64 auto-update archive
  { name: 'Merlin-1.32.0-mac.zip' },        // x64 auto-update archive
  { name: 'MerlinSetup-mac-arm64' },        // raw bootstrapper (never an installer target)
  { name: 'MerlinSetup-mac-intel' },        // raw bootstrapper (never an installer target)
  { name: 'checksums.txt' },
];

function loadMacPickers() {
  const fnStart = MAIN_JS.indexOf('function pickMacInstallerAssetName');
  const fnEnd = MAIN_JS.indexOf('\nfunction releaseHasInstallerForPlatform', fnStart);
  const picker = MAIN_JS.slice(fnStart, fnEnd);
  const helperStart = MAIN_JS.indexOf('function macAssetIsArm64');
  const helperEnd = MAIN_JS.indexOf('\nfunction pickMacInstallerAssetName', helperStart);
  const helper = MAIN_JS.slice(helperStart, helperEnd);
  // eslint-disable-next-line no-new-func
  const factory = new Function('process', `${helper}\n${picker}\nreturn pickMacInstallerAssetName;`);
  return { pickArm: factory({ arch: 'arm64' }), pickX64: factory({ arch: 'x64' }) };
}

test('2.8 — pickMacInstallerAssetName picks the native-arch DMG from REAL release names', () => {
  assert.ok(MAIN_JS.includes('function pickMacInstallerAssetName'), 'picker defined');
  const { pickArm, pickX64 } = loadMacPickers();

  // arm64 host gets the arm64 DMG; x64 host gets the unsuffixed (Intel) DMG.
  assert.equal(pickArm(REAL_MAC_RELEASE), 'Merlin-1.32.0-arm64.dmg', 'arm64 → arm64 DMG');
  assert.equal(pickX64(REAL_MAC_RELEASE), 'Merlin-1.32.0.dmg', 'x64 → unsuffixed (Intel) DMG');
});

test('2.8 — picker never returns a wrong-arch asset or a raw bootstrapper', () => {
  const { pickArm, pickX64 } = loadMacPickers();

  // arm64-only release: an Intel client must get NULL, never the arm64 build.
  const arm64Only = [
    { name: 'Merlin-1.32.0-arm64.dmg' },
    { name: 'Merlin-1.32.0-arm64-mac.zip' },
    { name: 'checksums.txt' },
  ];
  assert.equal(pickX64(arm64Only), null, 'x64 returns null on arm64-only release (no brick)');

  // x64-only release (never happens in practice; both arches always ship):
  // an arm64 client skips rather than silently downgrading a native arm64
  // install to a Rosetta x64 build. Auto-update knows process.arch, so unlike
  // the arch-blind landing download it should not cross arches on its own.
  const x64Only = [
    { name: 'Merlin-1.32.0.dmg' },
    { name: 'Merlin-1.32.0-mac.zip' },
    { name: 'checksums.txt' },
  ];
  assert.equal(pickArm(x64Only), null, 'arm64 skips an x64-only release (no silent Rosetta downgrade)');

  // Never a raw MerlinSetup-mac-* bootstrapper.
  assert.ok(!String(pickArm(REAL_MAC_RELEASE)).startsWith('MerlinSetup'), 'arm64 never a bootstrapper');
  assert.ok(!String(pickX64(REAL_MAC_RELEASE)).startsWith('MerlinSetup'), 'x64 never a bootstrapper');
});

test('2.8 — zip fallback is arch-correct when no DMG ships', () => {
  const { pickArm, pickX64 } = loadMacPickers();
  const zipsOnly = [
    { name: 'Merlin-1.32.0-arm64-mac.zip' },
    { name: 'Merlin-1.32.0-mac.zip' },
    { name: 'checksums.txt' },
  ];
  assert.equal(pickArm(zipsOnly), 'Merlin-1.32.0-arm64-mac.zip', 'arm64 → arm64 zip');
  assert.equal(pickX64(zipsOnly), 'Merlin-1.32.0-mac.zip', 'x64 → x64 zip (not the arm64 one)');
});

test('2.8 — picker tolerates a future arch-marked x64 DMG name', () => {
  const { pickX64 } = loadMacPickers();
  const future = [
    { name: 'Merlin-2.0.0-arm64.dmg' },
    { name: 'Merlin-2.0.0-x64.dmg' },  // hypothetical future explicit x64 marker
    { name: 'checksums.txt' },
  ];
  assert.equal(pickX64(future), 'Merlin-2.0.0-x64.dmg', 'x64 accepts an explicit x64-marked DMG');
});

test('2.8 — pickMacInstallerAssetName handles empty/null input', () => {
  const { pickArm } = loadMacPickers();
  assert.equal(pickArm([]), null, 'empty list → null');
  assert.equal(pickArm(null), null, 'null input → null');
});
