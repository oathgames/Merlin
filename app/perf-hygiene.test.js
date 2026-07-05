// perf-hygiene.test.js - locks the 2026-07-04 perf/resource-hygiene sweep
// on app/main.js:
//
//   1. Every long-running child spawn in main.js registers itself in
//      activeChildProcesses so the before-quit sweep can kill it. Untracked
//      children (dashboard refresh hitting live ad-platform APIs, the
//      --version probe, the fact-binding session-prelude, the transcribe
//      ffmpeg + whisper-cli pair) survived quit as zombies.
//   2. The three long-lived intervals (4h token watchdog, 30s OAuth pending
//      poll, hourly referral/subscription reconcile) are stored in module
//      level handles and cleared in the same before-quit block that clears
//      _updateCheckInterval, closing the EPIPE/hung-quit teardown race.
//   3. installUpdateFromLatestRelease streams the ~300-400MB installer to
//      disk with an incremental sha256 (httpsDownloadToFile) instead of
//      buffering it whole + synchronous hash + writeFileSync on the main
//      process (2x peak RAM, multi-second UI freeze, OOM risk).
//   4. The silent-send suppression flag's 120s safety timer is tracked in
//      _suppressClearTimer and disarmed before re-arming, so a second
//      silent send inside a prior send's window is not un-suppressed by
//      the first send's stale timer (2026-04-24 incident recurrence).
//
// Source-scan only - main.js requires the electron runtime and can't be
// loaded under node:test. Assertions anchor on stable strings (function
// names, action names, variable names), never line numbers.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// Slice a region of main.js starting at a unique anchor string.
function region(anchor, length) {
  const idx = mainSrc.indexOf(anchor);
  assert.ok(idx >= 0, `anchor not found in main.js: ${anchor}`);
  assert.strictEqual(mainSrc.indexOf(anchor, idx + 1), -1,
    `anchor must be unique in main.js: ${anchor}`);
  return mainSrc.slice(idx, idx + length);
}

// ── 1. Child-spawn sites register in activeChildProcesses ────────────

test('fact-binding session-prelude execFile is tracked in activeChildProcesses', () => {
  const src = region("action: 'session-prelude'", 3500);
  assert.match(src, /activeChildProcesses\.add\(child\)/,
    'the session-prelude child must be added to activeChildProcesses so before-quit can kill it');
  assert.match(src, /child\.on\('exit',\s*\(\)\s*=>\s*activeChildProcesses\.delete\(child\)\)/,
    'the session-prelude child must delete itself from the set on exit');
});

test('refresh-perf dashboard execFile is tracked in activeChildProcesses', () => {
  // Anchor on the dashboard command construction unique to the perf refresh.
  const src = region("{ action: 'dashboard', batchCount: requestedDays }", 4000);
  assert.match(src, /activeChildProcesses\.add\(child\)/,
    'the 90s dashboard child (hits live ad-platform APIs) must be added to activeChildProcesses');
  assert.match(src, /child\.on\('exit',\s*\(\)\s*=>\s*activeChildProcesses\.delete\(child\)\)/,
    'the dashboard child must delete itself from the set on exit');
});

test('getBinaryVersionAt --version probe is tracked in activeChildProcesses', () => {
  const src = region('async function getBinaryVersionAt', 1200);
  assert.match(src, /activeChildProcesses\.add\(child\)/,
    'the --version probe child must be added to activeChildProcesses');
  assert.match(src, /child\.on\('exit',\s*\(\)\s*=>\s*activeChildProcesses\.delete\(child\)\)/,
    'the --version probe child must delete itself from the set on exit');
});

test('transcribe-audio ffmpeg spawn is tracked in activeChildProcesses', () => {
  const src = region('spawn(ffmpegPath, args', 600);
  assert.match(src, /activeChildProcesses\.add\(ff\)/,
    'the transcode ffmpeg child must be added to activeChildProcesses');
  assert.match(src, /ff\.on\('exit',\s*\(\)\s*=>\s*activeChildProcesses\.delete\(ff\)\)/,
    'the transcode ffmpeg child must delete itself from the set on exit');
});

test('transcribe-audio whisper-cli spawn is tracked in activeChildProcesses', () => {
  const src = region('spawn(whisperBin, args', 600);
  assert.match(src, /activeChildProcesses\.add\(w\)/,
    'the whisper-cli child must be added to activeChildProcesses');
  assert.match(src, /w\.on\('exit',\s*\(\)\s*=>\s*activeChildProcesses\.delete\(w\)\)/,
    'the whisper-cli child must delete itself from the set on exit');
});

// ── 2. Long-lived intervals stored + cleared in before-quit ──────────

const INTERVAL_VARS = ['_tokenWatchdogInterval', '_oauthPendingPollInterval', '_reconcileInterval'];

test('the three long-lived interval handles are declared at module level', () => {
  for (const name of INTERVAL_VARS) {
    assert.match(mainSrc, new RegExp(`let ${name} = null`),
      `${name} must be declared as a module-level handle (next to _updateCheckInterval)`);
  }
});

test('each long-lived setInterval stores its handle', () => {
  assert.match(mainSrc, /_tokenWatchdogInterval = setInterval\(runTokenWatchdog/,
    'the 4h token watchdog interval must store its handle');
  assert.match(mainSrc, /_oauthPendingPollInterval = setInterval\(\(\)\s*=>\s*\{\s*runOAuthPendingPoll\(\)/,
    'the 30s OAuth pending poll interval must store its handle');
  assert.match(mainSrc, /_reconcileInterval = setInterval\(async/,
    'the hourly referral/subscription reconcile interval must store its handle');
});

test('before-quit clears all long-lived intervals alongside _updateCheckInterval', () => {
  const src = region("app.on('before-quit'", 4500);
  assert.match(src, /clearInterval\(_updateCheckInterval\)/,
    'the pre-existing _updateCheckInterval clear must remain in before-quit');
  for (const name of INTERVAL_VARS) {
    assert.match(src, new RegExp(`clearInterval\\(${name}\\)`),
      `before-quit must clearInterval(${name}) (teardown race: a late tick fires HTTPS or spawns a child mid-quit, surfacing as EPIPE or a hung quit)`);
    assert.match(src, new RegExp(`${name}\\s*=\\s*null`),
      `before-quit must null out ${name} after clearing`);
  }
});

// ── 3. Installer download streams to disk (no full buffering) ────────

test('installUpdateFromLatestRelease streams the installer via httpsDownloadToFile', () => {
  const src = region('async function installUpdateFromLatestRelease', 14000);
  assert.match(src, /httpsDownloadToFile\(asset\.browser_download_url,\s*tmpFile\)/,
    'the installer download must stream to the tmp file via httpsDownloadToFile');
  assert.ok(!/await httpsGet\(asset\.browser_download_url\)/.test(src),
    'the installer must NOT be buffered in memory via httpsGet (2x peak RAM on a ~300-400MB artifact)');
  assert.ok(!/writeFileSync\(tmpFile/.test(src),
    'the installer must NOT be written with a full-buffer writeFileSync (multi-second main-process freeze)');
});

test('httpsDownloadToFile pipes into createWriteStream with an incremental sha256', () => {
  const src = region('function httpsDownloadToFile', 3500);
  assert.match(src, /fs\.createWriteStream\(destPath\)/,
    'httpsDownloadToFile must write through fs.createWriteStream');
  assert.match(src, /createHash\('sha256'\)/,
    'httpsDownloadToFile must compute sha256');
  assert.match(src, /hash\.update\(c\)/,
    'the sha256 must be updated chunk-by-chunk, not over a full buffer');
  // The httpsGet REGRESSION GUARD (2026-04-16) invariants carry over:
  // Content-Length validation + response stream error rejection.
  assert.match(src, /received !== expectedLen/,
    'httpsDownloadToFile must validate byte count against Content-Length (httpsGet guard parity)');
  assert.match(src, /res\.on\('error'/,
    'httpsDownloadToFile must reject on the response stream error event (httpsGet guard parity)');
  assert.match(src, /Too many redirects/,
    'httpsDownloadToFile must cap redirect depth like httpsGet');
});

// ── 4. Suppression safety timer disarmed before re-arm ───────────────

test('_suppressClearTimer is declared at module level', () => {
  assert.match(mainSrc, /let _suppressClearTimer = null/,
    '_suppressClearTimer must be a module-level handle so both the silent-send arm site and the result-event clear site can disarm it');
});

test('silent send disarms the stale suppression timer before arming a fresh one', () => {
  const src = region('if (options.silent)', 900);
  const clearIdx = src.indexOf('clearTimeout(_suppressClearTimer)');
  const armIdx = src.indexOf('_suppressClearTimer = setTimeout');
  assert.ok(clearIdx > 0, 'silent send must clearTimeout(_suppressClearTimer) (stale-timer overlap: the FIRST send\'s 120s timer must not cut a SECOND silent send\'s suppression short)');
  assert.ok(armIdx > 0, 'silent send must store the new timer in _suppressClearTimer');
  assert.ok(clearIdx < armIdx,
    'the stale timer must be cleared BEFORE the fresh one is armed');
});

test('result-event clear also disarms and nulls the suppression timer', () => {
  // Anchor on the shallow-spread suppression stamp unique to the sdk-message
  // fan-out loop.
  const src = region('outbound = { ...msg, _internal: true }', 700);
  assert.match(src, /_suppressNextResponse = false/,
    'the result event must still clear the suppression flag');
  assert.match(src, /clearTimeout\(_suppressClearTimer\);\s*_suppressClearTimer = null/,
    'the result event must clearTimeout AND null _suppressClearTimer so the stale timer cannot fire inside a later silent send\'s window');
});

// ── 5. Wrong-brand-session race (perf-rsi 2026-07-04) ────────────────
// The queue-drain paths must only start a session through the guarded
// helper, which refuses while a brand switch is mid-flight. A bare
// `if (!activeQuery) startSession()` in a drain path could boot a
// wrong-brand session inside the switch window.

test('queue-drain paths route through startSessionForQueuedMessage, not a bare startSession', () => {
  // The helper exists and guards on _switchInProgress.
  const helper = region('function startSessionForQueuedMessage()', 200);
  assert.match(helper, /if \(activeQuery \|\| _switchInProgress\) return/,
    'startSessionForQueuedMessage must bail while a brand switch is in progress');

  // No queue-drain path uses the old bare pattern. Strip comments first so
  // the guard comment describing the old pattern does not trip the scan.
  const code = mainSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/if \(!activeQuery\) startSession\(\)/.test(code),
    'no bare `if (!activeQuery) startSession()` may remain; queue-drain must use startSessionForQueuedMessage');

  // Both drain call sites use the helper.
  const uses = (mainSrc.match(/startSessionForQueuedMessage\(\)/g) || []).length;
  assert.ok(uses >= 2, `expected both queue-drain sites to call the helper, found ${uses}`);
});

// ── 6. Legacy migration moves (rename) instead of copying (perf-rsi) ──
// The Documents/Merlin migration runs synchronously before any window
// exists; copying results/ (GB of video) froze startup and doubled disk.
// It must move (rename, copy only across devices).

test('legacy workspace migration moves files instead of copyFileSync', () => {
  const fn = region('function migrateTreeToSplit(oldRoot)', 1600);
  assert.ok(!/fs\.copyFileSync\(absSrc, dst\)/.test(fn),
    'migrateTreeToSplit must not copyFileSync the tree; use moveFileSync (rename-first)');
  assert.match(fn, /moveFileSync\(absSrc, dst\)/,
    'migration must route file relocation through moveFileSync');
  const helper = region('function moveFileSync(src, dst)', 400);
  assert.match(helper, /fs\.renameSync\(src, dst\)/,
    'moveFileSync must try an atomic rename first');
  assert.match(helper, /EXDEV/,
    'moveFileSync must fall back to copy only across devices (EXDEV)');
});
