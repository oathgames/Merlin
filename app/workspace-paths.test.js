// Tests for the workspace path split introduced by RSI §1.3 (Cluster-L).
//
// This test file does NOT require app/main.js directly — main.js imports
// Electron's `app` module which cannot boot under `node --test`. Instead
// it source-scans main.js to verify the contract invariants that Cluster-B
// (bootstrapper) and every downstream cluster depend on:
//
//   1. StateDir resolution order: env → pointer file → legacy → default.
//   2. Pointer filename MUST be `MERLIN_STATE_DIR.txt` (Cluster-B constant).
//   3. Windows StateDir MUST use APPDATA (Roaming), never LOCALAPPDATA.
//   4. `isStateFileName` recognises every state-file pattern from the
//      hook blocklist (vault/ratelimit/audit/tokens/config-tmp).
//   5. The StateDir layout is FLAT: migration copies state files to
//      `<stateDir>/<name>`, NOT `<stateDir>/.claude/tools/<name>`.
//
// Run with: node --test app/workspace-paths.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('resolveStateDir honours env var first', () => {
  // Source-scan: env var check must precede pointer file check.
  const envIdx = MAIN_JS.indexOf('process.env.MERLIN_STATE_DIR');
  const ptrIdx = MAIN_JS.indexOf('MERLIN_STATE_DIR.txt');
  assert.ok(envIdx > 0, 'MERLIN_STATE_DIR env var referenced');
  assert.ok(ptrIdx > 0, 'MERLIN_STATE_DIR.txt pointer file referenced');
  assert.ok(envIdx < ptrIdx, 'env var lookup precedes pointer file lookup');
});

test('pointer filename is exactly MERLIN_STATE_DIR.txt (Cluster-B contract)', () => {
  // Drift here splits the trust root with the bootstrapper.
  const occurrences = (MAIN_JS.match(/MERLIN_STATE_DIR\.txt/g) || []).length;
  assert.ok(occurrences >= 2, 'pointer filename appears in both resolveStateDir + writeStateDirPointer');
});

test('Windows StateDir uses APPDATA (Roaming), not LOCALAPPDATA', () => {
  // Cluster-B's determineWorkspacePaths uses APPDATA. Drift = config split-brain.
  assert.ok(MAIN_JS.includes('process.env.APPDATA'), 'APPDATA is the Win state env var');
  // Defensive: if LOCALAPPDATA ever lands as *code* (not comment text), flag it.
  const stateDirFnStart = MAIN_JS.indexOf('function defaultStateDir()');
  const stateDirFnEnd = MAIN_JS.indexOf('\nfunction ', stateDirFnStart + 1);
  const body = MAIN_JS.slice(stateDirFnStart, stateDirFnEnd);
  // Strip // line comments + /* */ block comments before scanning.
  const noComments = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(
    !noComments.includes('LOCALAPPDATA'),
    'defaultStateDir code does NOT reference LOCALAPPDATA',
  );
});

test('StateDir resolution has legacy fallback for installs that predate PR', () => {
  // (3) in the lookup order: `<contentDir>/.claude/tools/` with merlin-config.json.
  assert.ok(
    MAIN_JS.includes("path.join(contentDir, '.claude', 'tools')"),
    'legacy nested path is checked',
  );
  assert.ok(
    MAIN_JS.includes("fs.existsSync(path.join(legacy, 'merlin-config.json'))"),
    'legacy path only wins when it actually holds state',
  );
});

test('isStateFileName recognises every hook-blocked state pattern', () => {
  const patterns = [
    'merlin-config.json',
    '.merlin-config-brand1.json',
    '.merlin-config-tmp-abc123.json',
    '.merlin-tokens',
    '.merlin-tokens-brand1',
    '.merlin-vault',
    '.merlin-vault.bak',
    '.merlin-ratelimit',
    '.merlin-ratelimit.tmp.2',
    '.merlin-audit',
    '.merlin-audit.log',
  ];
  // Evaluate STATE_FILE_PATTERNS from source.
  const srcStart = MAIN_JS.indexOf('const STATE_FILE_PATTERNS = [');
  const srcEnd = MAIN_JS.indexOf('];', srcStart);
  const arr = MAIN_JS.slice(srcStart, srcEnd + 2);
  // eslint-disable-next-line no-new-func
  const STATE_FILE_PATTERNS = Function(`${arr}; return STATE_FILE_PATTERNS;`)();
  function isStateFileName(name) {
    return STATE_FILE_PATTERNS.some((re) => re.test(name));
  }
  for (const p of patterns) {
    assert.equal(isStateFileName(p), true, `recognises ${p}`);
  }
  // Negative cases — content files MUST NOT be flagged as state.
  for (const p of ['brand.md', 'memory.md', 'logo.png', 'activity.jsonl', 'version.json']) {
    assert.equal(isStateFileName(p), false, `does NOT recognise ${p} as state`);
  }
});

test('StateDir layout is FLAT — migration writes to <stateDir>/<name>', () => {
  // The migrateTreeToSplit branch for state files must use path.join(stateDir, ent.name),
  // NOT path.join(stateDir, '.claude', 'tools', ent.name). Dropping the nested path
  // is the whole point of the FLAT contract.
  const mig = MAIN_JS.slice(MAIN_JS.indexOf('function migrateTreeToSplit'));
  const migEnd = mig.indexOf('\nfunction ');
  const body = mig.slice(0, migEnd);
  assert.ok(
    body.includes('path.join(stateDir, ent.name)'),
    'migration writes state file FLAT into stateDir',
  );
  assert.ok(
    !body.includes("path.join(stateDir, '.claude'"),
    'migration never re-creates .claude/tools/ nesting under stateDir',
  );
});

test('pointer file is written after StateDir resolution', () => {
  // Guarantees subsequent launches, the Go binary, and Cluster-B sibling tools
  // converge on the same path without the env var.
  const writeFn = MAIN_JS.indexOf('function writeStateDirPointer()');
  const callSite = MAIN_JS.indexOf('writeStateDirPointer();', writeFn);
  assert.ok(writeFn > 0, 'writeStateDirPointer defined');
  assert.ok(callSite > writeFn, 'writeStateDirPointer invoked after definition');
  // And before the migration kicks in (so migration logs see a stable StateDir).
  const migrateCall = MAIN_JS.indexOf('maybeMigrateFromDocuments();');
  assert.ok(callSite < migrateCall, 'pointer write happens before migration scan');
});

test('migration writes a breadcrumb to block re-runs (idempotent)', () => {
  assert.ok(
    MAIN_JS.includes('MOVED-TO-NEW-LOCATION.txt'),
    'breadcrumb filename matches Cluster-B constant',
  );
  // Guard: next run finds breadcrumb and skips.
  const guard = MAIN_JS.indexOf("if (fs.existsSync(breadcrumb)) continue;");
  assert.ok(guard > 0, 'breadcrumb guard present in maybeMigrateFromDocuments');
});

test('migration logs to activity.jsonl under ContentDir', () => {
  // Per the task description: "log migration to activity.jsonl".
  // activity.jsonl lives under ContentDir (appRoot), not StateDir.
  const logFn = MAIN_JS.slice(MAIN_JS.indexOf('function logMigration('));
  const end = logFn.indexOf('\nfunction ');
  const body = logFn.slice(0, end);
  assert.ok(
    body.includes("path.join(appRoot, 'activity.jsonl')"),
    'migration log lands under ContentDir',
  );
  assert.ok(body.includes("kind: 'migration'"), 'log entry tagged as migration');
});
