// Tests for RSI §6 crash-recovery tasks (Cluster-L, group 6).
//
// Covers:
//   6.2 — webContents.on('render-process-gone') handler wired on the
//         main window + reload + wisdom ping + post-crash-reload channel.
//   6.4 — uncaughtException triggers relaunch-with-cap (3 in a 10-minute
//         window) with StateDir-backed counter state.
//   6.5 — unhandledRejection forwards to the wisdom crash channel as
//         'unhandled_rejection' (and does NOT relaunch).
//
// Source-scan + one real relaunch-cap simulation.
//
// Run with: node --test app/crash-recovery.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// ─── §6.2 ────────────────────────────────────────────────────────────
test('6.2 — render-process-gone handler is wired on the main window', () => {
  assert.ok(
    MAIN_JS.includes("win.webContents.on('render-process-gone'"),
    'handler attached via win.webContents.on',
  );
  const idx = MAIN_JS.indexOf("win.webContents.on('render-process-gone'");
  // Scope: from the handler to the closing '});'. Strip comments so
  // the ordering assertions below are checking code, not prose.
  const end = MAIN_JS.indexOf('\n  });\n', idx);
  const body = MAIN_JS.slice(idx, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // Must ping wisdom with 'render_crash' kind.
  assert.ok(
    body.includes("_pingWisdomCrash('render_crash'"),
    'wisdom ping fired with render_crash kind',
  );
  // Must reload the webContents on non-launch-failed faults.
  assert.ok(
    body.includes('win.webContents.reload()'),
    'reload invoked on non-launch-failed faults',
  );
  // Must NOT reload on launch-failed (pre-ready, reload would throw):
  // the `return` short-circuit must sit before the reload() call.
  const guardIdx = body.indexOf("reason === 'launch-failed'");
  const reloadIdx = body.indexOf('webContents.reload()');
  assert.ok(guardIdx > 0 && reloadIdx > guardIdx, 'launch-failed short-circuits before reload');
  // Post-reload renderer notification.
  assert.ok(
    body.includes("'post-crash-reload'"),
    'post-crash-reload renderer channel fired on did-finish-load',
  );
});

// ─── §6.4 ────────────────────────────────────────────────────────────
test('6.4 — uncaughtException routes through _tryRelaunchWithCap', () => {
  const handlerStart = MAIN_JS.indexOf("process.on('uncaughtException'");
  assert.ok(handlerStart > 0, 'uncaughtException handler registered');
  const end = MAIN_JS.indexOf('});', handlerStart);
  const body = MAIN_JS.slice(handlerStart, end);
  assert.ok(body.includes('_pingWisdomCrash('), 'wisdom ping fired');
  assert.ok(body.includes('_tryRelaunchWithCap()'), 'relaunch-with-cap invoked');
});

test('6.4 — relaunch cap is 3 in a 10-minute window', () => {
  assert.ok(
    /const\s+RELAUNCH_CAP\s*=\s*3\s*;/.test(MAIN_JS),
    'RELAUNCH_CAP = 3',
  );
  assert.ok(
    /const\s+RELAUNCH_WINDOW_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000\s*;/.test(MAIN_JS),
    'RELAUNCH_WINDOW_MS = 10min',
  );
});

test('6.4 — relaunch cap is backed by a StateDir-resident counter file', () => {
  assert.ok(
    /const\s+RELAUNCH_STATE_FILE\s*=\s*'\.merlin-relaunch'\s*;/.test(MAIN_JS),
    'RELAUNCH_STATE_FILE = .merlin-relaunch',
  );
  // Path resolution must go through stateFile() so the counter lives
  // in the same FLAT StateDir as the other state files.
  const fnIdx = MAIN_JS.indexOf('function _relaunchStatePath()');
  const fnEnd = MAIN_JS.indexOf('\nfunction _readRelaunchState', fnIdx);
  const body = MAIN_JS.slice(fnIdx, fnEnd);
  assert.ok(
    body.includes('stateFile(RELAUNCH_STATE_FILE)'),
    'counter path resolved through stateFile() helper',
  );
});

test('6.4 — relaunch cap simulation: 3 fires relaunch, 4th exits', () => {
  // Extract _tryRelaunchWithCap + its dependencies and exercise them
  // against a sandboxed StateDir. Stub `app.relaunch` and `app.exit`
  // to observe behaviour.
  const declStart = MAIN_JS.indexOf("const RELAUNCH_STATE_FILE = '.merlin-relaunch';");
  const declEnd = MAIN_JS.indexOf('\nfunction _pingWisdomCrash', declStart);
  const snippet = MAIN_JS.slice(declStart, declEnd);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-relaunch-'));
  const statePath = path.join(tmpDir, '.merlin-relaunch');
  const events = [];
  const fakeApp = {
    relaunch: () => events.push('relaunch'),
    exit: (code) => events.push(`exit:${code}`),
  };
  // Stub stateFile to return our sandboxed path.
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'fs', 'path', 'app', 'stateFile', 'console',
    `${snippet}\nreturn _tryRelaunchWithCap;`,
  );
  const tryRelaunch = factory(fs, path, fakeApp, () => statePath, console);

  // 3 attempts inside the window — should each relaunch.
  for (let i = 0; i < 3; i++) tryRelaunch();
  // 4th — should trigger the cap and exit WITHOUT relaunching.
  tryRelaunch();

  const relaunches = events.filter((e) => e === 'relaunch').length;
  const exits = events.filter((e) => e.startsWith('exit:1')).length;
  assert.equal(relaunches, 3, 'exactly 3 relaunches fired');
  // The 4th call produces an exit AND no relaunch. The first three
  // calls ALSO produce an exit (after relaunch(), before the new
  // process replaces us) — so total exits = 4.
  assert.equal(exits, 4, 'each crash emits an exit(1)');

  // Counter state persisted.
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.count, 4, 'counter incremented across the four calls');
  assert.ok(state.windowStartMs > 0, 'window start timestamp recorded');

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('6.4 — relaunch window resets when a crash arrives after the window expires', () => {
  const declStart = MAIN_JS.indexOf("const RELAUNCH_STATE_FILE = '.merlin-relaunch';");
  const declEnd = MAIN_JS.indexOf('\nfunction _pingWisdomCrash', declStart);
  const snippet = MAIN_JS.slice(declStart, declEnd);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-relaunch-win-'));
  const statePath = path.join(tmpDir, '.merlin-relaunch');

  // Seed a state whose window is 11 minutes ago, count at cap.
  const staleWindowStart = Date.now() - (11 * 60 * 1000);
  fs.writeFileSync(statePath, JSON.stringify({ windowStartMs: staleWindowStart, count: 5 }));

  const events = [];
  const fakeApp = { relaunch: () => events.push('relaunch'), exit: () => events.push('exit') };

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'fs', 'path', 'app', 'stateFile', 'console',
    `${snippet}\nreturn _tryRelaunchWithCap;`,
  );
  const tryRelaunch = factory(fs, path, fakeApp, () => statePath, console);

  // The stale state should be reset — next call counts as #1 in a
  // fresh window and triggers a relaunch.
  tryRelaunch();
  assert.equal(events.filter((e) => e === 'relaunch').length, 1, 'fresh-window call relaunches');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.count, 1, 'count reset to 1 after window expired');
  assert.ok(state.windowStartMs > staleWindowStart, 'window start bumped to now');

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ─── §6.5 ────────────────────────────────────────────────────────────
test('6.5 — unhandledRejection forwards to wisdom (NO relaunch)', () => {
  const handlerStart = MAIN_JS.indexOf("process.on('unhandledRejection'");
  assert.ok(handlerStart > 0, 'unhandledRejection handler registered');
  const end = MAIN_JS.indexOf('});', handlerStart);
  const body = MAIN_JS.slice(handlerStart, end);
  assert.ok(
    body.includes("_pingWisdomCrash('unhandled_rejection'"),
    'wisdom ping fired with unhandled_rejection kind',
  );
  // MUST NOT call _tryRelaunchWithCap — stray rejections burn the cap
  // on installs with chatty async libraries.
  assert.ok(
    !body.includes('_tryRelaunchWithCap'),
    'unhandledRejection does NOT trigger a relaunch',
  );
});

test('6.5 — non-Error reasons are wrapped before ping', () => {
  // Defensive: many libraries reject with a plain string / number /
  // object. _pingWisdomCrash expects something with .message / .stack.
  const handlerStart = MAIN_JS.indexOf("process.on('unhandledRejection'");
  const end = MAIN_JS.indexOf('});', handlerStart);
  const body = MAIN_JS.slice(handlerStart, end);
  assert.ok(
    body.includes('reason instanceof Error'),
    'guards against non-Error reasons',
  );
  assert.ok(
    body.includes('new Error(String(reason))'),
    'wraps non-Error reasons for .message/.stack access',
  );
});

test('6.5 — _pingWisdomCrash is timeout-guarded and error-silent', () => {
  // Wisdom pings fire on every crash. If the request stalls (flaky
  // wifi, captive portal), the process must not hang waiting for it.
  const fnStart = MAIN_JS.indexOf('function _pingWisdomCrash(');
  const fnEnd = MAIN_JS.indexOf("\nprocess.on('uncaughtException'", fnStart);
  const body = MAIN_JS.slice(fnStart, fnEnd);
  assert.ok(
    /timeout:\s*3000/.test(body),
    'https request has a 3s timeout',
  );
  assert.ok(
    body.includes("req.on('error'"),
    'request error is silently swallowed',
  );
});
