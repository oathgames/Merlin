// REGRESSION GUARD (2026-04-24) — app/main.js must parse cleanly.
//
// Incident: v1.17.0 shipped with a module-scope `const stateFile = ...`
// added next to `function stateFile(name) { ... }` declared ~5400 lines
// earlier in the same file. At require-time Node throws
//
//   SyntaxError: Identifier 'stateFile' has already been declared
//
// which killed the Electron main process before any UI rendered. Every
// installed user saw a native error dialog on launch; auto-update could
// not run (main process never got past module load), so the only
// recovery was a manual reinstall from the landing page. See CLAUDE.md
// Rule 11-style fix + the two REGRESSION GUARD blocks in app/main.js.
//
// The test: compile app/main.js with `vm.Script` (parse-only, no
// execution — we don't care whether its `require()` dependencies
// resolve). A duplicate-identifier SyntaxError is a parse-time error in
// ES6 and fires here immediately. The next edit that re-introduces the
// same pattern (or any other top-level name collision) fails CI before
// it can ship.
//
// Run with: node --test app/main-no-duplicate-toplevel-ids.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MAIN_PATH = path.join(__dirname, 'main.js');

test('app/main.js parses — no duplicate top-level identifiers', () => {
  const source = fs.readFileSync(MAIN_PATH, 'utf8');

  let err = null;
  try {
    // `vm.Script` compiles but does not run. That's exactly what we want:
    // the parser catches "Identifier 'X' has already been declared" without
    // requiring any of main.js's actual deps (electron, ws, etc) to resolve.
    new vm.Script(source, { filename: 'main.js', displayErrors: false });
  } catch (e) {
    err = e;
  }

  if (err) {
    // Surface the real parse error (line + column) so the next engineer
    // can see exactly where the collision is without re-running Electron.
    const msg = `app/main.js failed to parse:\n  ${err.message}\n` +
      `If this is "Identifier 'X' has already been declared", you've just\n` +
      `reintroduced the v1.17.0 launch-crash bug. Rename one of the two\n` +
      `declarations — read the REGRESSION GUARD comment blocks in main.js.`;
    assert.fail(msg);
  }
});

test('app/main.js has exactly one top-level `function stateFile(` and zero top-level `const stateFile =`', () => {
  // Belt-and-suspenders: even if a future JS engine changes error semantics,
  // a direct source-scan protects the specific identifier that caused the
  // v1.17.0 incident. "Top-level" here = the declaration starts at column 0
  // (no leading whitespace). This is coarse but effective for main.js which
  // follows that convention throughout.
  const source = fs.readFileSync(MAIN_PATH, 'utf8');
  const lines = source.split('\n');

  const topLevelFnStateFile = [];
  const topLevelConstStateFile = [];
  const topLevelLetVarStateFile = [];

  lines.forEach((line, i) => {
    if (/^function\s+stateFile\s*\(/.test(line)) topLevelFnStateFile.push(i + 1);
    if (/^const\s+stateFile\s*=/.test(line)) topLevelConstStateFile.push(i + 1);
    if (/^(let|var)\s+stateFile\s*=/.test(line)) topLevelLetVarStateFile.push(i + 1);
  });

  assert.equal(
    topLevelFnStateFile.length, 1,
    `Expected exactly 1 top-level \`function stateFile(\` in main.js, found ${topLevelFnStateFile.length} at lines: ${topLevelFnStateFile.join(', ')}`
  );
  assert.equal(
    topLevelConstStateFile.length, 0,
    `Found top-level \`const stateFile =\` in main.js at line(s) ${topLevelConstStateFile.join(', ')} — this is the v1.17.0 crash bug. Rename to \`sessionStateFile\` (or similar).`
  );
  assert.equal(
    topLevelLetVarStateFile.length, 0,
    `Found top-level \`let/var stateFile =\` in main.js at line(s) ${topLevelLetVarStateFile.join(', ')} — same shadowing hazard as the const form.`
  );
});
