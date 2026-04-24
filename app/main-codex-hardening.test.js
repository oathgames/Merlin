// main-codex-hardening.test.js
//
// Source-scan regressions for the Codex 2026-04-24 hardening pass. main.js
// is an Electron entry-point and doesn't export anything testable via
// require(), so these guards read the source and assert structural
// invariants the same way ws-server.test.js enforces Rule 11.
//
// Covered:
//   1. openExternalSafe — every shell.openExternal call site must be
//      wrapped (no raw shell.openExternal in main.js except the ONE
//      reference inside openExternalSafe itself).
//   2. Vault v2 salt parity — _vaultDeriveKey takes a salt param,
//      _vaultLoadSalt / _vaultEnsureSalt exist, vaultLoad branches on
//      fv.v === 1 and fv.v === 2. If any of these drift, the Electron
//      side stops matching vault.go and first-save-after-upgrade bricks
//      every user's vault (Codex P1 #5).
//   3. assertBrandSafe — declared and called at least once. The regex
//      pattern /^[a-z0-9_-]{1,100}$/i must stay in sync with
//      app/preload.js:BRAND_RE (Codex defense-in-depth, 2026-04-24).
//
// Run with: node --test app/main-codex-hardening.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const BLOCKLIST = fs.readFileSync(
  path.join(__dirname, '..', '.claude', 'hooks', 'block-api-bypass.js'),
  'utf8',
);

// Strip comments + string literals so the pattern scans match real code
// only. Same approach as ws-server.test.js + stripe_readonly_test.go.
function stripCommentsAndStrings(src) {
  // Block comments.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Line comments.
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  // Template literal bodies (keep the backticks so later scans can
  // still see identifiers before them).
  out = out.replace(/`(?:\\.|[^\\`])*`/g, '``');
  // Double-quoted and single-quoted strings — preserve delimiters only.
  out = out.replace(/"(?:\\.|[^\\"])*"/g, '""');
  out = out.replace(/'(?:\\.|[^\\'])*'/g, "''");
  return out;
}

// ── 1. openExternalSafe must wrap every shell.openExternal call ─────────
test('openExternalSafe is defined in main.js', () => {
  assert.match(
    MAIN_JS,
    /function\s+openExternalSafe\s*\(/,
    'openExternalSafe declaration missing — Codex P0 #2 guard removed',
  );
});

test('every shell.openExternal call goes through a wrapper', () => {
  const cleaned = stripCommentsAndStrings(MAIN_JS);
  // Exactly two raw shell.openExternal calls are allowed:
  //   1. Inside openExternalSafe's own body (the http/https wrapper).
  //   2. Inside _openSystemPrefsDeepLink's body (the narrow allowlist
  //      for x-apple.systempreferences: / ms-settings: URIs, whose
  //      non-http schemes openExternalSafe correctly rejects).
  // Any third call site means a renderer-reachable path went out
  // unwrapped — Codex P0 #2 regression.
  const matches = cleaned.match(/shell\.openExternal\s*\(/g) || [];
  assert.equal(
    matches.length,
    2,
    `Expected exactly 2 shell.openExternal calls (inside openExternalSafe + inside _openSystemPrefsDeepLink). Got ${matches.length}. Every other call site must use openExternalSafe(url) or _openSystemPrefsDeepLink(uri).`,
  );
});

test('openExternalSafe rejects non-http/https schemes by regex', () => {
  // The function's regex guard is the load-bearing part. Assert the
  // /^https?:\/\//i pattern is literally there so a future edit can't
  // silently loosen it to /^https?/ (would accept "https-evil://").
  assert.match(
    MAIN_JS,
    /function\s+openExternalSafe[\s\S]{0,400}\/\^https\?:\\\/\\\/\/i/,
    'openExternalSafe must validate with /^https?:\\/\\// — tighter anchor required',
  );
});

// ── 2. Vault v2 salt parity with vault.go ───────────────────────────────
test('_vaultDeriveKey accepts a salt argument', () => {
  assert.match(
    MAIN_JS,
    /function\s+_vaultDeriveKey\s*\(\s*salt\s*\)/,
    '_vaultDeriveKey must take a `salt` argument (Codex P1 #5). Without it, Electron cannot match the salted key derivation in vault.go and v2 vaults fail to decrypt.',
  );
});

test('_vaultLoadSalt and _vaultEnsureSalt are declared', () => {
  assert.match(MAIN_JS, /function\s+_vaultLoadSalt\s*\(/, '_vaultLoadSalt missing');
  assert.match(MAIN_JS, /function\s+_vaultEnsureSalt\s*\(/, '_vaultEnsureSalt missing');
});

test('_vaultSaltFilePath lives alongside the vault file', () => {
  assert.match(
    MAIN_JS,
    /function\s+_vaultSaltFilePath\s*\(\s*\)\s*\{[\s\S]*?_vaultFilePath\s*\(\s*\)\s*\+\s*['"]-salt['"]/,
    "_vaultSaltFilePath must return _vaultFilePath() + '-salt' — mismatched paths would prevent Electron and Go from sharing the salt",
  );
});

test('vaultLoad branches on fv.v === 1 and fv.v === 2', () => {
  assert.match(
    MAIN_JS,
    /fv\.v\s*===\s*1/,
    'vaultLoad must handle legacy v1 files (pre-salt upgrade path)',
  );
  assert.match(
    MAIN_JS,
    /fv\.v\s*===\s*2/,
    'vaultLoad must handle salted v2 files',
  );
});

test('vaultSave writes v2 with the ensured salt', () => {
  // The save path calls _vaultEnsureSalt + _vaultDeriveKey(salt) so every
  // write goes out v2 with a real salt. If this regresses, the vault
  // file version would revert to 1 and the salt file would never be
  // created on Electron-driven saves.
  assert.match(
    MAIN_JS,
    /_vaultEnsureSalt\s*\(\s*\)[\s\S]{0,400}_vaultDeriveKey\s*\(\s*salt\s*\)/,
    'vaultSave must call _vaultEnsureSalt() then _vaultDeriveKey(salt) in order',
  );
  assert.match(
    MAIN_JS,
    /v:\s*2\s*,/,
    'vaultSave must write v: 2 in the output JSON',
  );
});

// ── 3. Brand-name defense-in-depth ──────────────────────────────────────
test('assertBrandSafe is declared and used', () => {
  assert.match(
    MAIN_JS,
    /function\s+assertBrandSafe\s*\(/,
    'assertBrandSafe missing — path builders unprotected against ../ brand names',
  );
  // Must be called somewhere. Count occurrences; >1 means the helper is
  // wired, ==1 means only the declaration is present.
  const calls = (MAIN_JS.match(/assertBrandSafe\s*\(/g) || []).length;
  assert.ok(
    calls > 1,
    `assertBrandSafe must be CALLED at path-builder sites, not just declared. Got ${calls} occurrence(s) (need >1).`,
  );
});

test('assertBrandSafe regex matches preload BRAND_RE', () => {
  // Intentionally the SAME regex as app/preload.js:BRAND_RE — one regex
  // change without the other creates an attacker-visible gap. If preload
  // were ever loosened independently, this test would still enforce the
  // main-process side stays tight.
  assert.match(
    MAIN_JS,
    /\/\^\[a-z0-9_-\]\{1,100\}\$\/i/,
    'assertBrandSafe regex must be /^[a-z0-9_-]{1,100}$/i to stay in lockstep with preload.js:BRAND_RE',
  );
});

// ── 4. Hook blocklist covers .vault-salt (Rule 7 extension) ─────────────
test('hook blocklist protects .vault-salt', () => {
  assert.match(
    BLOCKLIST,
    /\\\.vault-salt\(\\\.\|\$\)/,
    'PROTECTED_PATH_PATTERNS must include /\\.vault-salt(\\.|$)/ — atomic-write siblings like .vault-salt.tmp would otherwise be readable',
  );
  assert.match(
    BLOCKLIST,
    /\\\.vault-salt\\b/,
    'PROTECTED_COMMAND_PATTERNS must include /\\.vault-salt\\b/ — cp/mv/rm of the salt file must be blocked in Bash commands',
  );
});
