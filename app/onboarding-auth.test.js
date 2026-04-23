// Tests for RSI §3 onboarding / auth hygiene tasks (Cluster-L, group 3).
//
// Covers:
//   3.3 — CLAUDE_LOGIN_TIMEOUT_MS is 5 minutes (not the old 2-min cap).
//   3.4 — PERSONAL_EMAIL_DOMAINS recognises `pm.me` (ProtonMail alias).
//   3.6 — emitProgress is plumbed into the MCP server ctx + preload exposes onMcpProgress.
//   3.9 — runOAuthPendingPoll + setInterval + oauth-pending-refresh IPC +
//         preload onOAuthPending subscription.
//   3.10 — onboarding checkpoint: read/write helpers, setup_step whitelist,
//          schema version stamp, IPC handlers.
//
// Source-scans main.js + preload.js — main.js imports `app` and won't boot
// under `node --test`.
//
// Run with: node --test app/onboarding-auth.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const PRELOAD_JS = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');

// ─── §3.3 ────────────────────────────────────────────────────────────
test('3.3 — Claude login timeout is 5 minutes', () => {
  assert.ok(
    MAIN_JS.includes('const CLAUDE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;'),
    'CLAUDE_LOGIN_TIMEOUT_MS defined as 5*60*1000',
  );
  // The setTimeout that kills the login process must reference that symbol,
  // not a hard-coded number — otherwise bumping the constant does nothing.
  // Scan for `}, CLAUDE_LOGIN_TIMEOUT_MS)` (the tail of the setTimeout call)
  // rather than `setTimeout(..., CLAUDE_LOGIN_TIMEOUT_MS)` because the
  // callback body spans ~7 lines.
  assert.ok(
    /},\s*CLAUDE_LOGIN_TIMEOUT_MS\)/.test(MAIN_JS),
    'timeout callback passes CLAUDE_LOGIN_TIMEOUT_MS to setTimeout',
  );
});

// ─── §3.4 ────────────────────────────────────────────────────────────
test('3.4 — pm.me is a recognised personal email domain', () => {
  const setIdx = MAIN_JS.indexOf('const PERSONAL_EMAIL_DOMAINS = new Set([');
  assert.ok(setIdx > 0, 'PERSONAL_EMAIL_DOMAINS defined');
  const endIdx = MAIN_JS.indexOf(']);', setIdx);
  const body = MAIN_JS.slice(setIdx, endIdx);
  // pm.me is ProtonMail's short-alias domain — users who create a brand
  // from a pm.me mailbox previously had Merlin scrape ProtonMail as the
  // "brand" site. Defensive: also confirm proton.me is there.
  assert.ok(/['"]pm\.me['"]/.test(body), 'pm.me present in PERSONAL_EMAIL_DOMAINS');
  assert.ok(/['"]proton\.me['"]/.test(body), 'proton.me still present (regression guard)');
});

test('3.4 — inferBrandDomain returns null for pm.me mailboxes', () => {
  // Source-scan: the function must early-return when the domain is in
  // PERSONAL_EMAIL_DOMAINS, BEFORE returning the domain.
  const fnStart = MAIN_JS.indexOf('function inferBrandDomain()');
  const fnEnd = MAIN_JS.indexOf('\nfunction ', fnStart + 1);
  const body = MAIN_JS.slice(fnStart, fnEnd);
  const guardIdx = body.indexOf('PERSONAL_EMAIL_DOMAINS.has(domain)');
  const returnIdx = body.indexOf('return domain;');
  assert.ok(guardIdx > 0 && returnIdx > guardIdx, 'personal-domain guard precedes return');
});

// ─── §3.6 ────────────────────────────────────────────────────────────
test('3.6 — emitProgress is passed into createMerlinMcpServer ctx', () => {
  // The ctx object passed to createMerlinMcpServer must expose emitProgress
  // as a function that forwards to win.webContents.send('mcp-progress', ...).
  const ctxIdx = MAIN_JS.indexOf('emitProgress: (payload) => {');
  assert.ok(ctxIdx > 0, 'emitProgress defined in MCP ctx');
  const end = MAIN_JS.indexOf('},', ctxIdx);
  const body = MAIN_JS.slice(ctxIdx, end);
  assert.ok(
    body.includes("win.webContents.send('mcp-progress'"),
    'emitProgress forwards to mcp-progress channel',
  );
  // Defensive: the emit MUST no-op when the window is gone so scheduled
  // / post-quit tool calls don't crash.
  assert.ok(
    body.includes('win.isDestroyed()'),
    'destroyed-window guard present',
  );
});

test('3.6 — preload exposes onMcpProgress(cb) subscription', () => {
  assert.ok(PRELOAD_JS.includes('onMcpProgress'), 'onMcpProgress exported');
  assert.ok(
    PRELOAD_JS.includes("ipcRenderer.on('mcp-progress'"),
    'onMcpProgress wires the main-process channel',
  );
});

// ─── §3.9 ────────────────────────────────────────────────────────────
test('3.9 — runOAuthPendingPoll polls the Go binary via oauth-pending-list', () => {
  const fnIdx = MAIN_JS.indexOf('const runOAuthPendingPoll = async () => {');
  assert.ok(fnIdx > 0, 'runOAuthPendingPoll defined');
  const end = MAIN_JS.indexOf('  };\n', fnIdx);
  const body = MAIN_JS.slice(fnIdx, end);
  assert.ok(body.includes("action: 'oauth-pending-list'"), 'invokes oauth-pending-list action');
  assert.ok(body.includes('_oauthPendingInflight'), 'overlap guard present');
  assert.ok(
    body.includes("win.webContents.send('oauth-pending'"),
    'pushes results to renderer via oauth-pending channel',
  );
});

test('3.9 — runOAuthPendingPoll runs on a 30s setInterval after an initial 5s tick', () => {
  // The call sites live on two adjacent lines:
  //   setTimeout(() => { runOAuthPendingPoll().catch(() => {}); }, 5000);
  //   setInterval(() => { runOAuthPendingPoll().catch(() => {}); }, 30000);
  assert.ok(
    /setTimeout\([\s\S]*?runOAuthPendingPoll[\s\S]*?,\s*5000\)/.test(MAIN_JS),
    'initial 5s delayed tick',
  );
  assert.ok(
    /setInterval\([\s\S]*?runOAuthPendingPoll[\s\S]*?,\s*30000\)/.test(MAIN_JS),
    '30s interval tick',
  );
});

test('3.9 — oauth-pending-refresh IPC handler triggers an immediate poll', () => {
  const handlerIdx = MAIN_JS.indexOf("ipcMain.handle('oauth-pending-refresh'");
  assert.ok(handlerIdx > 0, 'oauth-pending-refresh handler registered');
  const end = MAIN_JS.indexOf('});', handlerIdx);
  const body = MAIN_JS.slice(handlerIdx, end);
  assert.ok(body.includes('runOAuthPendingPoll()'), 'handler invokes runOAuthPendingPoll');
});

test('3.9 — preload exposes onOAuthPending subscription', () => {
  assert.ok(PRELOAD_JS.includes('onOAuthPending'), 'onOAuthPending exported');
  assert.ok(
    PRELOAD_JS.includes("ipcRenderer.on('oauth-pending'"),
    'onOAuthPending wires the main-process channel',
  );
});

// ─── §3.10 ───────────────────────────────────────────────────────────
test('3.10 — onboarding checkpoint file is .merlin-onboarding.json under StateDir', () => {
  assert.ok(
    MAIN_JS.includes("const ONBOARDING_CHECKPOINT_FILE = '.merlin-onboarding.json';"),
    'checkpoint filename matches hook-blocklist pattern',
  );
  // Resolved via stateFile() so it sits next to merlin-config.json, not
  // at a legacy nested path.
  assert.ok(
    MAIN_JS.includes('return stateFile(ONBOARDING_CHECKPOINT_FILE);'),
    'path resolved through StateDir helper (FLAT layout)',
  );
});

test('3.10 — writeOnboardingCheckpoint whitelists setup_step values', () => {
  // Source-scan: the whitelist must contain every step the onboarding
  // skills bump to. An invalid value MUST be rejected, not silently
  // persisted (otherwise a future renderer bug could overwrite a real
  // step with `"null"` / `"undefined"` strings).
  const wlIdx = MAIN_JS.indexOf('const ONBOARDING_ALLOWED_STEPS = new Set([');
  assert.ok(wlIdx > 0, 'whitelist defined');
  const end = MAIN_JS.indexOf(']);', wlIdx);
  const body = MAIN_JS.slice(wlIdx, end);
  for (const step of ['goal', 'brand', 'products', 'connect', 'tos', 'autopilot', 'done']) {
    assert.ok(body.includes(`'${step}'`), `${step} is a recognised step`);
  }
  // And the writer MUST drop unrecognised values.
  const fnIdx = MAIN_JS.indexOf('function writeOnboardingCheckpoint(');
  const fnEnd = MAIN_JS.indexOf('\nfunction ', fnIdx + 1);
  const fnBody = MAIN_JS.slice(fnIdx, fnEnd);
  assert.ok(
    fnBody.includes('!ONBOARDING_ALLOWED_STEPS.has(merged.setup_step)'),
    'writer validates setup_step against whitelist',
  );
  assert.ok(
    fnBody.includes('delete merged.setup_step'),
    'writer drops invalid setup_step instead of persisting it',
  );
});

test('3.10 — checkpoint writes are stamped with schema version + timestamp', () => {
  const fnIdx = MAIN_JS.indexOf('function writeOnboardingCheckpoint(');
  const fnEnd = MAIN_JS.indexOf('\nfunction ', fnIdx + 1);
  const body = MAIN_JS.slice(fnIdx, fnEnd);
  assert.ok(
    body.includes('merged._schema_version = ONBOARDING_SCHEMA_VERSION'),
    '_schema_version stamped on write',
  );
  assert.ok(
    body.includes('merged._updated_at = new Date().toISOString()'),
    '_updated_at stamped on write',
  );
  // Atomic write — tmp + rename — so a crash mid-write doesn't corrupt
  // the checkpoint file.
  assert.ok(body.includes("const tmp = full + '.tmp';"), 'atomic tmp file');
  assert.ok(body.includes('fs.renameSync(tmp, full)'), 'atomic rename into place');
  assert.ok(/mode:\s*0o600/.test(body), 'mode 0600 for user-only read');
});

test('3.10 — IPC handlers for onboarding-checkpoint-read / -write', () => {
  assert.ok(
    MAIN_JS.includes("ipcMain.handle('onboarding-checkpoint-read'"),
    'read handler registered',
  );
  assert.ok(
    MAIN_JS.includes("ipcMain.handle('onboarding-checkpoint-write'"),
    'write handler registered',
  );
  // The write handler must validate its partial — an array or non-object
  // MUST be rejected (a malicious renderer could otherwise overwrite the
  // whole file with junk).
  const wIdx = MAIN_JS.indexOf("ipcMain.handle('onboarding-checkpoint-write'");
  const end = MAIN_JS.indexOf('});', wIdx);
  const body = MAIN_JS.slice(wIdx, end);
  assert.ok(
    body.includes("typeof partial !== 'object'") && body.includes('Array.isArray(partial)'),
    'write handler rejects non-object / array partials',
  );
});

test('3.10 — readOnboardingCheckpoint never throws on missing / malformed JSON', () => {
  // Load the function in isolation and exercise it against a
  // nonexistent path + a malformed file. This is the one Group 3
  // invariant worth testing with real execution — the rest are
  // source-scans because they require Electron's app module.
  const fnStart = MAIN_JS.indexOf('function readOnboardingCheckpoint()');
  const fnEnd = MAIN_JS.indexOf('\nfunction writeOnboardingCheckpoint', fnStart);
  const block = MAIN_JS.slice(fnStart, fnEnd);

  // Stub dependencies via a factory.
  const os = require('node:os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-onboarding-'));
  const missingPath = path.join(tmpDir, 'missing.json');
  const malformedPath = path.join(tmpDir, 'malformed.json');
  fs.writeFileSync(malformedPath, '{not json');

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'fs', 'onboardingCheckpointPath',
    `${block}\nreturn readOnboardingCheckpoint;`,
  );

  const readMissing = factory(fs, () => missingPath);
  assert.deepEqual(readMissing(), {}, 'missing file → empty object');

  const readMalformed = factory(fs, () => malformedPath);
  assert.deepEqual(readMalformed(), {}, 'malformed file → empty object');

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
