// REGRESSION GUARD (2026-08-31, installer-name-collision):
// TWO different programs are named Merlin.exe on a Merlin machine:
//
//   <install dir>\Merlin.exe                the Electron shell (~220 MB)
//   %LOCALAPPDATA%\Merlin\bin\Merlin.exe    the Go engine (~19 MB)
//
// The engine is short-lived and spawned constantly (by the app, the watchdog,
// and the Merlin MCP server inside any Claude Code session). electron-builder's
// stock app-running check matches by process NAME, so it saw an engine
// invocation, showed "Merlin cannot be closed. Please close it manually and
// click Retry to continue," and Retry found the next one. A user could not
// install v1.39.1 by any route, and was told to close an app already closed.
//
// The mirror-image bug: `taskkill /IM Merlin.exe /T` killed unrelated
// in-flight engine work during an install, which is the mid-write kill the
// 2026-04-23 guard exists to prevent.
//
// NSIS cannot be compiled in unit tests, so these are source invariants.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const nshPath = path.join(__dirname, '..', 'build', 'installer.nsh');
const raw = fs.readFileSync(nshPath, 'utf8');
// NSIS comments start with ';'
const code = raw.split(/\r?\n/).filter((l) => !l.trim().startsWith(';')).join('\n');

test('installer never matches processes by name alone', () => {
  assert.ok(!/taskkill\s+[^\n]*\/IM/i.test(code),
    'taskkill /IM matches BOTH the Electron shell and the Go engine. Scope by executable path.');
  assert.ok(!/_FindProcess/i.test(code),
    'nsProcess::_FindProcess is name-based and matches the engine. Scope by executable path.');
});

test('installer scopes process matching to the install directory', () => {
  assert.ok(code.includes('MERLIN_KILL_TARGET'),
    'the kill target must be an explicit path handed to PowerShell');
  assert.ok(/SetEnvironmentVariable[^\n]*MERLIN_KILL_TARGET[^\n]*\$INSTDIR/.test(code),
    'MERLIN_KILL_TARGET must be set from $INSTDIR, not a bare process name');
  assert.ok(/\$\$_\.Path\s+-eq\s+\$\$t/.test(code),
    'the PowerShell filter must compare .Path, which is what makes it path-scoped');
});

test('installer overrides the stock name-based running check', () => {
  assert.ok(/!macro\s+customCheckAppRunning/.test(code),
    'without overriding customCheckAppRunning, electron-builder\'s name-based ' +
    '"cannot be closed" dialog still fires on an engine process');
});

test('PowerShell dollars are NSIS-escaped', () => {
  // NSIS treats $ as the start of a variable. An unescaped PowerShell $var
  // is either substituted away or errors at compile time, and the resulting
  // command silently matches nothing.
  const line = raw.split(/\r?\n/).find((l) => l.includes('MERLIN_KILL_TARGET') && l.includes('nsExec'));
  assert.ok(line, 'nsExec line not found');
  const body = line.slice(line.indexOf('-Command "') + 10, line.lastIndexOf('"'));
  const singles = body.match(/(?<!\$)\$(?!\$)/g) || [];
  assert.deepStrictEqual(singles, [],
    'every PowerShell $ inside the NSIS string must be written $$');
});

test('graceful close still precedes force kill', () => {
  // The 2026-04-23 guard: a hard kill mid-write truncates the rate-limit
  // state file and drops the user into 24h safe mode for no reason.
  const closeAt = code.indexOf('CloseMainWindow');
  const killAt = code.indexOf('Stop-Process');
  assert.ok(closeAt > -1, 'graceful CloseMainWindow must be attempted');
  assert.ok(killAt > -1, 'force kill must remain as the escalation');
  assert.ok(closeAt < killAt, 'graceful close must come before force kill');
  assert.ok(/Start-Sleep/.test(code), 'there must be a wait between graceful close and escalation');
});

test('kill macro declares no NSIS labels', () => {
  // KillAppByPath is expanded twice (customInit + customCheckAppRunning).
  // NSIS labels are function-scoped, so any label inside it fails to compile
  // with "label already declared" once both expansions land in .onInit.
  const start = raw.indexOf('!macro KillAppByPath');
  assert.ok(start > -1, 'KillAppByPath macro not found');
  const body = raw.slice(start, raw.indexOf('!macroend', start));
  const labels = body.split(/\r?\n/).filter((l) => /^\s*[A-Za-z_][A-Za-z0-9_]*:\s*$/.test(l));
  assert.deepStrictEqual(labels, [],
    'a macro expanded more than once per function must not declare labels');
});
