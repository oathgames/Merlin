// REGRESSION GUARDS for RSI Loop 5 (2026-05-02): spells + PWA bulletproof.
// Three fixes lock here:
//
// (5a) Spell SKILL.md files at ~/.claude/scheduled-tasks/<id>/SKILL.md
//      were NOT in block-api-bypass.js PROTECTED_PATH_PATTERNS. Prompt-
//      injection from a scraped landing page could rewrite Monday's
//      spend logic and the next 9am fire would execute the rewritten body.
//
// (5b) PWA `send()` was a silent no-op when the socket was dead. User
//      types "what's my ROAS" on the subway, sees their bubble appear,
//      and the message goes into the void. Outbox queue (FIFO, capped
//      at 20) drained on auth-ok closes this hole.
//
// (5c) PWA had no visibilitychange / online listener. iOS Safari
//      backgrounded tab → 30-90s silent dead window before the keepalive
//      caught up. Eager reconnect on foreground / network-back closes it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── (5a) Hook protection on scheduled-task SKILL.md ────────────────

test('block-api-bypass.js protects scheduled-task SKILL.md from session writes', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '.claude', 'hooks', 'block-api-bypass.js'),
    'utf8',
  );
  // The pattern must match the canonical path
  // ~/.claude/scheduled-tasks/<id>/SKILL.md (Windows or POSIX separator).
  assert.match(
    src,
    /scheduled-tasks[^\n]*SKILL\\\.md/,
    'block-api-bypass.js must list a regex matching ~/.claude/scheduled-tasks/<id>/SKILL.md — without it a prompt-injection during a session can rewrite Monday\'s spend logic',
  );
  assert.match(
    src,
    /scheduled-tasks[^\n]*config\\\.json/,
    'block-api-bypass.js must also protect the per-task config.json (cron + status state).',
  );
  // Hard-Won Rule 7: the patterns must use (\.|$) not bare $ so .bak /
  // .tmp atomic-write siblings are caught too. The audit pass-2
  // reviewer flagged this as a BLOCK; this regression-guard pins it.
  assert.match(
    src,
    /scheduled-tasks[^\n]*SKILL\\\.md\(\\\.\|\$\)/,
    "scheduled-tasks SKILL.md pattern must end in (\\.|$) per Hard-Won Rule 7 — bare $ leaves SKILL.md.bak / SKILL.md.tmp unprotected",
  );
  assert.match(
    src,
    /scheduled-tasks[^\n]*config\\\.json\(\\\.\|\$\)/,
    "scheduled-tasks config.json pattern must end in (\\.|$) per Hard-Won Rule 7",
  );
});

// Functional probe: load the hook module, simulate a Write tool call
// against ~/.claude/scheduled-tasks/X/SKILL.md, assert it's BLOCKED.
test('hook denies a Write to scheduled-task SKILL.md', () => {
  const hookPath = path.join(__dirname, '..', '.claude', 'hooks', 'block-api-bypass.js');
  // The hook is an executable Node script that reads JSON from stdin and
  // exits non-zero on block. We can't easily exec it from this test
  // process without a child_process.spawn, so we exercise the regex
  // table directly by re-requiring the file's classify function. The
  // hook is a single-file CommonJS module — a hard require will run
  // its top-level main() unless the env says otherwise. We do a
  // source-level pattern check instead, which is the same protection
  // pattern other regression-guard tests use for this hook.
  const src = fs.readFileSync(hookPath, 'utf8');
  // Build a synthetic candidate path string and check that AT LEAST
  // one of the file's protected patterns matches it.
  const candidates = [
    '/Users/x/.claude/scheduled-tasks/merlin-daily-acme/SKILL.md',
    'C:\\Users\\x\\.claude\\scheduled-tasks\\merlin-optimize-acme\\SKILL.md',
    '/home/u/.claude/scheduled-tasks/merlin-digest-acme/config.json',
  ];
  // Extract the regex literals from PROTECTED_PATH_PATTERNS (best-
  // effort string parsing — robust enough for the pattern shapes we use).
  const arrMatch = src.match(/const PROTECTED_PATH_PATTERNS = \[([\s\S]*?)\];/);
  assert.ok(arrMatch, 'PROTECTED_PATH_PATTERNS array not found in hook source');
  const body = arrMatch[1];
  const regexLiterals = [...body.matchAll(/\/((?:\\\/|[^\/\n])+)\/(i?)/g)].map((m) => {
    try { return new RegExp(m[1], m[2]); } catch (_) { return null; }
  }).filter(Boolean);
  for (const cand of candidates) {
    const matched = regexLiterals.some((r) => r.test(cand));
    assert.equal(matched, true, `path ${cand} must be matched by at least one PROTECTED_PATH_PATTERNS entry — currently isn't, hook would let a session rewrite this file`);
  }
});

// ── (5b) PWA outbox queue ──────────────────────────────────────────

test('pwa.js declares an outbox queue with bounded size', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'pwa', 'pwa.js'),
    'utf8',
  );
  assert.match(src, /OUTBOX_MAX\s*=\s*20\b/, 'pwa.js must cap the outbox at 20 entries (bounded growth on long disconnect)');
  assert.match(src, /const outbox = \[\]/, 'pwa.js must declare the outbox queue array');
  assert.match(src, /function drainOutbox\b/, 'pwa.js must declare drainOutbox()');
});

test('pwa.js send() queues when socket is closed', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'pwa', 'pwa.js'),
    'utf8',
  );
  // Anchor on the new send() implementation — it must (a) check
  // ws.readyState === 1 first, (b) on dead socket, push to outbox.
  const sendBody = src.match(/function send\(obj\) \{[\s\S]*?\n\}/);
  assert.ok(sendBody, 'pwa.js send() function not found');
  assert.match(sendBody[0], /readyState === 1/, 'send() must short-circuit on OPEN');
  assert.match(sendBody[0], /outbox\.push\(obj\)/, 'send() must push to outbox when socket is dead');
  assert.match(sendBody[0], /outbox\.shift\(\)/, 'send() must drop oldest when at OUTBOX_MAX');
});

test('pwa.js drainOutbox runs on auth-ok', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'pwa', 'pwa.js'),
    'utf8',
  );
  // Find the auth-ok handler block and assert drainOutbox() is in it.
  const authOk = src.match(/case 'auth-ok':[\s\S]*?break;/);
  assert.ok(authOk, "auth-ok handler not found");
  assert.match(authOk[0], /drainOutbox\(\)/, 'auth-ok handler must call drainOutbox() so queued messages flush after reconnect');
});

// ── (5c) visibilitychange + online listeners ───────────────────────

test('pwa.js wires visibilitychange and online listeners', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'pwa', 'pwa.js'),
    'utf8',
  );
  assert.match(
    src,
    /document\.addEventListener\('visibilitychange'/,
    "pwa.js must listen on visibilitychange — without it iOS Safari background-tab throttling produces a 30-90s silent dead window after foregrounding",
  );
  assert.match(
    src,
    /window\.addEventListener\('online'/,
    "pwa.js must listen on online — network-back must reset reconnectAttempts so the immediate reconnect doesn't sit in backoff",
  );
  // The visibility handler must do a staleness probe, not just
  // unconditionally reconnect.
  const visBody = src.match(/document\.addEventListener\('visibilitychange'[\s\S]*?\}\);/);
  assert.ok(visBody, 'visibilitychange handler not found');
  assert.match(visBody[0], /lastPongAt/, 'visibility handler must consult lastPongAt for staleness probe');
});
