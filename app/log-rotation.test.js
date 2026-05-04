// REGRESSION GUARD (2026-05-03, mac-persistence-rsi)
//
// Three append-only logs in main.js:
//   - .merlin-errors.log     — appendErrorLog,    1 MB cap
//   - activity.jsonl         — appendActivityLog, 5 MB cap
//   - .merlin-audit.log      — appendAudit,       1 MB cap
// All three rotate to a single .old companion. Without rotation, a
// long-lived install accumulates tens of MB of noise — wasted disk on a
// folder users may have excluded from backups, and a real risk on a Mac
// install where ~/Merlin sits alongside Documents/Desktop in the home
// root.
//
// This file pins:
//   1. appendErrorLog and appendActivityLog and appendAudit all exist
//      and are wired to size caps + rotation.
//   2. NO direct `fs.appendFileSync` writes to any of those three target
//      paths from anywhere else in main.js — every write must route
//      through one of the rotating helpers. Source-scan enforced.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SRC_MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('appendErrorLog declares a 1MB cap and rotates to .old', () => {
  assert.match(SRC_MAIN, /const ERROR_LOG_MAX_BYTES = 1024 \* 1024/);
  const idx = SRC_MAIN.indexOf('function appendErrorLog(');
  assert.ok(idx > 0);
  const body = SRC_MAIN.slice(idx, idx + 800);
  assert.match(body, /_rotateIfOversize\(logPath, ERROR_LOG_MAX_BYTES\)/);
});

test('appendActivityLog declares a 5MB cap and routes through _rotateIfOversize', () => {
  assert.match(SRC_MAIN, /const ACTIVITY_LOG_MAX_BYTES = 5 \* 1024 \* 1024/);
  const idx = SRC_MAIN.indexOf('function appendActivityLog(');
  assert.ok(idx > 0);
  const body = SRC_MAIN.slice(idx, idx + 800);
  assert.match(body, /_rotateIfOversize\(logPath, ACTIVITY_LOG_MAX_BYTES\)/);
});

test('appendAudit declares a 1MB cap and rotates to .old', () => {
  assert.match(SRC_MAIN, /const AUDIT_MAX_BYTES = 1024 \* 1024/);
  const idx = SRC_MAIN.indexOf('function appendAudit(');
  assert.ok(idx > 0);
  const body = SRC_MAIN.slice(idx, idx + 1500);
  // Audit log uses inline rotation (predates the unified _rotateIfOversize),
  // but the contract is the same: stat → rename to .old when over the cap.
  assert.match(body, /AUDIT_MAX_BYTES/);
  assert.match(body, /\.old/);
});

// ─────────────────────────────────────────────────────────────────
// Source-scan: every `fs.appendFileSync` in main.js MUST live inside
// one of the three rotating helpers — anywhere else and the rotation
// contract leaks. The helper bodies are short (≤6 appendFileSync lines)
// and easy to enumerate.
// ─────────────────────────────────────────────────────────────────
test('no fs.appendFileSync outside the three rotating helpers', () => {
  // Find every `fs.appendFileSync(` in main.js.
  const lines = SRC_MAIN.split(/\r?\n/);
  const offenders = [];
  let inHelper = null; // tracks current helper function we're inside, if any
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Track which helper function we're inside via the function-declaration
    // signature. The three helpers are appendErrorLog, appendActivityLog,
    // appendAudit. Any appendFileSync inside these is sanctioned.
    const helperStart = line.match(/^function (appendErrorLog|appendActivityLog|appendAudit)\(/);
    if (helperStart) {
      inHelper = helperStart[1];
      braceDepth = 0;
    }
    if (inHelper) {
      // Track braces. The opening `{` lands on the same line as the
      // function signature OR the next non-blank line. Either way, every
      // `{` increments and every `}` decrements; when depth returns to 0
      // after rising above 0, we've left the helper.
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
    }
    if (line.includes('fs.appendFileSync(')) {
      // Comments don't count.
      const stripped = line.replace(/\/\/.*$/, '').trim();
      if (!stripped.includes('fs.appendFileSync(')) continue;
      if (!inHelper) {
        offenders.push({ line: i + 1, text: line.trim() });
      }
    }
    if (inHelper && braceDepth === 0 && line.includes('}')) {
      inHelper = null;
    }
  }

  if (offenders.length > 0) {
    const detail = offenders.map(o => `  line ${o.line}: ${o.text}`).join('\n');
    assert.fail(
      'fs.appendFileSync calls outside rotating helpers detected:\n' + detail
      + '\n\nRoute these through appendErrorLog / appendActivityLog / appendAudit '
      + 'so the size cap + .old rotation contract holds. See REGRESSION GUARD '
      + '(2026-05-03, mac-persistence-rsi) at the top of the helper block.'
    );
  }
});

// ─────────────────────────────────────────────────────────────────
// Functional: rotation actually happens at the cap.
// ─────────────────────────────────────────────────────────────────
test('functional: rotation kicks in when log exceeds cap', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-rotate-test-'));
  const logPath = path.join(tmp, 'test.log');
  const cap = 1024; // 1 KB for the test

  // Replicate _rotateIfOversize semantics inline.
  function append(line) {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size >= cap) {
        const oldPath = logPath + '.old';
        try { fs.unlinkSync(oldPath); } catch {}
        try { fs.renameSync(logPath, oldPath); } catch {}
      }
    } catch {}
    fs.appendFileSync(logPath, line);
  }

  // Write 2 KB worth of lines — should trigger one rotation.
  for (let i = 0; i < 50; i++) {
    append('x'.repeat(50) + '\n');
  }

  // After rotation, the live log is small; the .old log holds the
  // pre-rotation bulk.
  const liveSize = fs.statSync(logPath).size;
  const oldExists = fs.existsSync(logPath + '.old');
  assert.ok(oldExists, '.old should exist after rotation');
  assert.ok(liveSize < cap, `live log size (${liveSize}) should be below cap after rotation`);

  fs.rmSync(tmp, { recursive: true, force: true });
});
