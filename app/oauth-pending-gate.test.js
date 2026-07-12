// Tests for oauth-pending-gate.js: the stat-gate that keeps
// runOAuthPendingPoll from execFile-ing the Go binary every 30s
// (~2,880 spawns/day) when the pending-state file proves there is
// nothing to poll. Behavioral tests inject a fake fs; the wiring in
// main.js (which requires electron and cannot load under node --test)
// is pinned by source scan.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createOAuthPendingGate, DEFAULT_EMPTY_THRESHOLD } = require('./oauth-pending-gate');

// Fake fs whose statSync serves a mutable per-path mtime map.
function makeFakeFs(mtimes) {
  return {
    statSync(p) {
      if (!(p in mtimes)) {
        const err = new Error(`ENOENT: no such file, stat '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return { mtimeMs: mtimes[p] };
    },
  };
}

const PENDING = 'C:/fake/state/.merlin-oauth-pending.json';
const LEGACY = 'C:/fake/appRoot/.claude/tools/.merlin-oauth-pending.json';

test('gate skips the spawn when the pending file is absent', () => {
  const gate = createOAuthPendingGate({
    fsImpl: makeFakeFs({}),
    candidates: [PENDING, LEGACY],
  });
  const d = gate.shouldSpawn();
  assert.equal(d.spawn, false);
  assert.equal(d.reason, 'no-pending-file');
});

test('forced refresh bypasses the gate even with the file absent', () => {
  const gate = createOAuthPendingGate({
    fsImpl: makeFakeFs({}),
    candidates: [PENDING],
  });
  gate.force();
  const d = gate.shouldSpawn();
  assert.equal(d.spawn, true);
  assert.equal(d.reason, 'forced');
  // force is one-shot: the next un-forced tick re-consults the file.
  assert.equal(gate.shouldSpawn().spawn, false);
});

test('gate spawns while the file exists and results have not gone stale-empty', () => {
  const mtimes = { [PENDING]: 1000 };
  const gate = createOAuthPendingGate({ fsImpl: makeFakeFs(mtimes), candidates: [PENDING] });
  for (let i = 0; i < DEFAULT_EMPTY_THRESHOLD; i++) {
    const d = gate.shouldSpawn();
    assert.equal(d.spawn, true, `poll ${i + 1} should still spawn (threshold not yet met)`);
    gate.record(true, d.mtimeMs);
  }
  // Threshold met + mtime unchanged: now it skips.
  const skipped = gate.shouldSpawn();
  assert.equal(skipped.spawn, false);
  assert.equal(skipped.reason, 'unchanged-and-empty');
});

test('an mtime change re-enables the spawn after the stale-empty skip engaged', () => {
  const mtimes = { [PENDING]: 1000 };
  const gate = createOAuthPendingGate({ fsImpl: makeFakeFs(mtimes), candidates: [PENDING] });
  for (let i = 0; i < DEFAULT_EMPTY_THRESHOLD; i++) {
    gate.record(true, gate.shouldSpawn().mtimeMs);
  }
  assert.equal(gate.shouldSpawn().spawn, false, 'sanity: skip engaged');
  mtimes[PENDING] = 2000; // binary touched the pending file
  const d = gate.shouldSpawn();
  assert.equal(d.spawn, true, 'mtime change must punch through the skip');
  assert.equal(d.mtimeMs, 2000);
});

test('a non-empty result resets the empty streak', () => {
  const mtimes = { [PENDING]: 1000 };
  const gate = createOAuthPendingGate({ fsImpl: makeFakeFs(mtimes), candidates: [PENDING] });
  gate.record(true, gate.shouldSpawn().mtimeMs);
  gate.record(true, gate.shouldSpawn().mtimeMs);
  gate.record(false, gate.shouldSpawn().mtimeMs); // pending flow appeared
  // Two more empties still do not reach the threshold of 3.
  gate.record(true, gate.shouldSpawn().mtimeMs);
  gate.record(true, gate.shouldSpawn().mtimeMs);
  assert.equal(gate.shouldSpawn().spawn, true, 'streak was reset by the non-empty result');
});

test('legacy candidate path is consulted when the flat StateDir file is absent', () => {
  const mtimes = { [LEGACY]: 555 };
  const gate = createOAuthPendingGate({ fsImpl: makeFakeFs(mtimes), candidates: [PENDING, LEGACY] });
  const d = gate.shouldSpawn();
  assert.equal(d.spawn, true);
  assert.equal(d.mtimeMs, 555);
});

test('force() clears learned stale-empty state', () => {
  const mtimes = { [PENDING]: 1000 };
  const gate = createOAuthPendingGate({ fsImpl: makeFakeFs(mtimes), candidates: [PENDING] });
  for (let i = 0; i < DEFAULT_EMPTY_THRESHOLD; i++) {
    gate.record(true, gate.shouldSpawn().mtimeMs);
  }
  assert.equal(gate.shouldSpawn().spawn, false, 'sanity: skip engaged');
  gate.force();
  assert.equal(gate.shouldSpawn().spawn, true, 'forced poll goes through');
  // Learned state was cleared: the next tick spawns too (streak restarts).
  assert.equal(gate.shouldSpawn().spawn, true);
});

// ── main.js wiring (source scan; main.js requires electron) ───────────

function mainSrc() {
  return fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
}

test('runOAuthPendingPoll consults the gate before spawning and preserves visibility gating', () => {
  const src = mainSrc();
  const fnMatch = src.match(/const runOAuthPendingPoll = async \(opts\) => \{[\s\S]*?\n  \};/);
  assert.ok(fnMatch, 'runOAuthPendingPoll(opts) not found in main.js');
  const body = fnMatch[0];
  assert.match(body, /_oauthPendingGate\.shouldSpawn\(\)/, 'poll must consult the stat-gate');
  assert.match(body, /win\.isVisible\(\)/, 'visibility gating must be preserved');
  const gateIdx = body.indexOf('.shouldSpawn()');
  const spawnIdx = body.indexOf('execFile(');
  assert.ok(gateIdx >= 0 && spawnIdx > gateIdx, 'gate check must run BEFORE the execFile spawn');
  assert.match(body, /if \(opts && opts\.force && _oauthPendingGate\) _oauthPendingGate\.force\(\)/,
    'forced polls must punch through the gate');
  assert.match(body, /_oauthPendingGate\.record\(/, 'poll must feed results back into the gate');
});

test('oauth-pending-refresh IPC forces the poll through the gate', () => {
  const src = mainSrc();
  assert.match(
    src,
    /ipcMain\.handle\('oauth-pending-refresh',[\s\S]{0,300}?runOAuthPendingPoll\(\{ force: true \}\)/,
    'renderer-requested refresh must bypass the stat-gate',
  );
});

test('runOAuthFlow resets the gate so a new flow is polled promptly', () => {
  const src = mainSrc();
  const fnIdx = src.indexOf('async function runOAuthFlow(platform, brandName, extra)');
  assert.ok(fnIdx >= 0, 'runOAuthFlow not found');
  const head = src.slice(fnIdx, fnIdx + 600);
  assert.match(head, /_oauthPendingGate\.force\(\)/,
    'runOAuthFlow must force() the gate at flow start, otherwise a fresh pending entry can be skipped for stale-empty reasons');
});
