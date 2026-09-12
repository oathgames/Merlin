// Source-scan regression test for the Windows auto-update runner in main.js.
// We do NOT boot the updater here — the goal is to lock the shape of the
// spawn call + batch scripts in source, the same pattern as
// ws-server.test.js and stripe_readonly_test.go.
//
// Why this matters: after v1.12.0 shipped, a paying user saw a full
// terminal window pop up during auto-update showing Merlin's startup logs
// (`[workspace-sync]`, `[WS+HTTP] Server listening on port …`,
// `[setup-probe]`, `[auth]`, `[update] current=1.12.0 latest=1.12.0`).
// Root cause was three compounding shell-scripting choices:
//
//   1. `spawn('cmd.exe', ['/c', 'start', '/min', '', batPath], …)` — the
//      outer cmd was hidden via windowsHide, but `start /min` created a
//      new, visible (minimized) console window for the batch. Minimized
//      is not hidden. Clicking it surfaced the full log stream.
//   2. `start "" "${appExe}"` inside that visible console — for GUI
//      subsystem apps `start` does not allocate a new console, so the
//      child (Merlin.exe) inherited the batch's console + stdio. Every
//      console.log from main.js streamed into the user's window.
//   3. `timeout /t 2 /nobreak >nul` as the retry/swap sleep — `timeout`
//      needs a console and aborts with "Input redirection is not
//      supported" when the cmd has CREATE_NO_WINDOW. So hiding the cmd
//      (the right fix for #1) broke the 2s backoff that guards against
//      AV scans and slow disk flushes.
//
// Fix (all three must hold, enforced below):
//   A. No `start /min` / `start /MAX` / any `start` wrapper around batPath
//      in the spawn call. The batch runs under `cmd.exe /c batPath` with
//      windowsHide: true + stdio: 'ignore' + detached: true.
//   B. Every `start "" "<exe>"` line that launches Merlin.exe redirects
//      to nul (`>nul 2>&1`) so the child process cannot inherit a live
//      console even if one exists.
//   C. No `timeout /t` as a sleep primitive. Use `ping -n N 127.0.0.1`
//      — works in any console / no-console context.
//
// Run with: node app/update-runner.test.js

const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;
const MAIN_JS = path.join(APP_DIR, 'main.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  \u2713', name);
    passed++;
  } catch (err) {
    console.log('  \u2717', name);
    console.log('   ', err.message);
    failed++;
  }
}

function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.split('\n').map((line) => {
    const idx = line.indexOf('//');
    if (idx < 0) return line;
    const before = line.slice(0, idx);
    const sq = (before.match(/'/g) || []).length;
    const dq = (before.match(/"/g) || []).length;
    const bt = (before.match(/`/g) || []).length;
    if (sq % 2 === 1 || dq % 2 === 1 || bt % 2 === 1) return line;
    return before;
  }).join('\n');
  return out;
}

if (!fs.existsSync(MAIN_JS)) {
  console.error('main.js missing at', MAIN_JS);
  process.exit(1);
}
const RAW = fs.readFileSync(MAIN_JS, 'utf8');
const SRC = stripComments(RAW);

test('main.js keeps the terminal-visibility REGRESSION GUARD marker', () => {
  if (!RAW.includes('REGRESSION GUARD (2026-04-18 terminal-visibility)')) {
    throw new Error(
      'main.js lost the "REGRESSION GUARD (2026-04-18 terminal-visibility)" ' +
      'comment block. Do not delete it — it explains why the update runner ' +
      'must not use `start /min`, must redirect `start "" appExe >nul 2>&1`, ' +
      'and must use `ping` instead of `timeout`. Restore the block or add a ' +
      'new dated guard explaining why the rule changed.',
    );
  }
});

test('no cmd.exe spawn wraps the update batch/cmd in `start /min`', () => {
  // The exact footgun: `spawn('cmd.exe', ['/c', 'start', '/min', …])`.
  // Matches the unambiguous shape the fix retired.
  const offenders = [];
  const re = /spawn\s*\(\s*['"]cmd\.exe['"]\s*,\s*\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(SRC)) !== null) {
    const args = m[1];
    // Any `'start'` or `"start"` followed by `/min` / `/max` is a fail.
    if (/['"]start['"][^\]]*['"]\/(?:min|max)['"]/i.test(args)) {
      offenders.push(args.trim().replace(/\s+/g, ' '));
    }
  }
  if (offenders.length) {
    throw new Error(
      'cmd.exe spawn uses `start /min` / `start /max` — this creates a ' +
      'visible (minimized) console window. Use `cmd.exe /c <script>` ' +
      'directly with windowsHide: true. Offenders:\n  - ' +
      offenders.join('\n  - '),
    );
  }
});

test('every `start "" "${*exe*Path}"` line in main.js redirects to nul', () => {
  // We scan for the specific shape of launching Merlin from a batch/cmd
  // heredoc: `start "" "${appExe}"` / `start "" "${exePath}"`. Each must be
  // followed by `>nul 2>&1` (order-insensitive but on the same line).
  // Template-literal string fragment: we want the substring that ends up
  // in the generated .bat / .cmd, not runtime-assembled paths.
  const lines = SRC.split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match `start "" "${something}"` inside a JS string literal (any quote
    // style). We only care about lines where a template literal is building
    // a batch command.
    if (!/start\s+""\s+"\$\{[a-zA-Z_][a-zA-Z0-9_]*\}"/.test(line)) continue;
    // Must include redirection to nul on the same line — either `>nul`
    // or `> nul` plus `2>&1`. We accept any whitespace.
    const hasNul = /(^|\s)(>|1>)\s*nul\b/i.test(line);
    const hasErrRedir = /2>&1/.test(line);
    if (!hasNul || !hasErrRedir) {
      offenders.push(`main.js:${i + 1}: ${line.trim()}`);
    }
  }
  if (offenders.length) {
    throw new Error(
      'Every `start "" "${exePath}"` / `start "" "${appExe}"` that launches ' +
      'Merlin from a batch script MUST be followed by `>nul 2>&1` so the ' +
      'child cannot inherit a live console window. Offenders:\n  - ' +
      offenders.join('\n  - '),
    );
  }
});

test('no update script uses `timeout /t` as a sleep primitive', () => {
  // We only flag `timeout /t` appearing inside a template literal string
  // that is being written to a .bat / .cmd file. Scanning the whole file
  // is fine because `timeout` is not used elsewhere in main.js — if that
  // ever changes, tighten to scan only the update-runner + swap-script
  // blocks.
  const re = /timeout\s+\/t\b/gi;
  const matches = SRC.match(re);
  if (matches && matches.length) {
    throw new Error(
      '`timeout /t` is used in main.js — this fails with "Input redirection ' +
      'is not supported" when the cmd has CREATE_NO_WINDOW (which our ' +
      'hidden update spawn requires). Use `ping -n N 127.0.0.1 >nul 2>&1` ' +
      'instead — works in any console context. Occurrences: ' +
      matches.length,
    );
  }
});

test('update-runner spawns cmd.exe with windowsHide + detached + stdio ignore', () => {
  // Every spawn of cmd.exe whose argv includes a path to a staged
  // update script (`merlin-update.bat` in %TEMP%, or `update-swap.cmd`
  // in the install dir, or a `batPath` / `swapScript` variable) must
  // carry all three hardening options. Catches future edits that drop
  // one of them.
  const re = /spawn\s*\(\s*['"]cmd\.exe['"][\s\S]*?\{[\s\S]*?\}\s*\)/g;
  const spawns = SRC.match(re) || [];
  const offenders = [];
  for (const s of spawns) {
    // Only enforce on spawns that reference one of our update scripts.
    if (!/batPath|swapScript/.test(s)) continue;
    const hasWindowsHide = /windowsHide\s*:\s*true/.test(s);
    const hasDetached = /detached\s*:\s*true/.test(s);
    const hasStdioIgnore = /stdio\s*:\s*['"]ignore['"]/.test(s);
    const missing = [];
    if (!hasWindowsHide) missing.push('windowsHide: true');
    if (!hasDetached) missing.push('detached: true');
    if (!hasStdioIgnore) missing.push("stdio: 'ignore'");
    if (missing.length) {
      offenders.push(
        `spawn is missing [${missing.join(', ')}] — ${s.replace(/\s+/g, ' ').slice(0, 160)}…`,
      );
    }
  }
  if (offenders.length) {
    throw new Error(
      'Update-runner cmd.exe spawn lost a hardening flag. All three of ' +
      '`windowsHide: true`, `detached: true`, `stdio: \'ignore\'` are ' +
      'required so the batch cmd has no visible console and Merlin inherits ' +
      'no stdio. Offenders:\n  - ' + offenders.join('\n  - '),
    );
  }
});

test('update batch waits for Merlin.exe to exit before running the installer', () => {
  // 2026-09-11 incident: the batch is spawned BEFORE app.quit() completes,
  // so the NSIS installer ran while every Merlin.exe still held the install
  // dir open. /S stalls on locked files with no exit code and no relaunch —
  // the update silently died 4 times in one day on a live machine.
  // The generated script MUST gate the installer on process exit.
  const batBlock = SRC.match(/const script = \[([\s\S]*?)\]\.join\(/);
  if (!batBlock) throw new Error('could not locate the update batch script array in main.js');
  const body = batBlock[1];
  const hasWaitLoop = /:wait_exit/.test(body) && /tasklist \/fi "imagename eq Merlin\.exe"/.test(body);
  if (!hasWaitLoop) {
    throw new Error(
      'update batch has no wait-for-exit loop. The installer MUST NOT run ' +
      'while Merlin.exe processes are alive — poll tasklist until the count ' +
      'is 0, then force-kill stragglers, then install.',
    );
  }
  // The installer invocation must come AFTER the wait loop in the script.
  const waitIdx = body.indexOf(':wait_exit');
  const installIdx = body.search(/"\$\{filePath\}" \/S/);
  if (installIdx < 0 || installIdx < waitIdx) {
    throw new Error('installer line precedes (or is missing relative to) the :wait_exit loop');
  }
  // And a bounded escape hatch so a hung process can't stall the update forever.
  if (!/taskkill \/F \/IM Merlin\.exe/.test(body)) {
    throw new Error('wait loop has no force-kill escape hatch (taskkill /F /IM Merlin.exe)');
  }
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
