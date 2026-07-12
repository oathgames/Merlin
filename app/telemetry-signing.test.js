// REGRESSION GUARDS for the signed-telemetry proxy (2026-07-11 audit fix).
//
// The wisdom worker (api.merlingotme.com/api/ping) requires an X-Merlin-Sig
// HMAC header and hard-401s unsigned posts. main.js used to fire four
// direct https.request pings (crash, unhandled_rejection, spell-<status>,
// bypass_blocked, launch) with no signature, so every one of them was
// silently dropped at the worker. The fix routes all four sites through
// sendSignedPing, which hands the exact HTTP body to the Go engine via
// {"action":"telemetry-ping","payload":"<JSON object string>"}; the engine
// signs and POSTs best-effort.
//
// These are source-scan tests (main.js requires electron, so it cannot be
// loaded under node --test). They pin:
//   (1) No direct https.request to /api/ping survives in main.js.
//   (2) The sendSignedPing helper exists, uses the telemetry-ping action,
//       runs fire-and-forget with a 5s timeout, and never joins
//       activeChildProcesses (app-exit cleanup must not kill an in-flight
//       crash ping).
//   (3) Every event string ("e" value) the four sites emit stays inside a
//       literal allowlist. wisdom-api/worker.js's ALLOWED_PING_EVENTS must
//       be a SUPERSET of this list: a concurrent worker change extends its
//       allowlist from these exact strings. Renaming any value here without
//       updating the worker drops that event class at the 401/400 boundary.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The complete set of event strings main.js sends through sendSignedPing.
// 'spell-<status>' is dynamic: status comes from the SDK task_notification
// message and is 'completed', 'failed', or 'error' in practice, so all
// three concrete forms are listed. The worker-side ALLOWED_PING_EVENTS
// allowlist (wisdom-api/worker.js) must remain a superset of this constant.
const EXPECTED_PING_EVENTS = [
  'crash',
  'unhandled_rejection',
  'render_crash',
  'spell-completed',
  'spell-failed',
  'spell-error',
  'bypass_blocked',
  'launch',
];

// Worker-side contract on every event string.
const EVENT_RE = /^[a-z][a-z0-9_-]{1,39}$/;

function mainSrc() {
  return fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
}

// ── (1) No direct unsigned pings remain ─────────────────────────────

test('main.js has no direct https.request to api.merlingotme.com/api/ping', () => {
  const src = mainSrc();
  // Strip line comments so the sendSignedPing doc comment (which names the
  // endpoint) does not false-positive the scan.
  const noComments = src.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(
    noComments,
    /https\.request\(\s*['"`]https:\/\/api\.merlingotme\.com\/api\/ping/,
    'main.js must not POST to /api/ping directly: unsigned pings 401 at the worker. Route through sendSignedPing (Go engine adds X-Merlin-Sig).',
  );
  // Belt and braces: no non-comment occurrence of the ping URL outside the
  // helper doc block at all.
  assert.doesNotMatch(
    noComments,
    /['"`]https:\/\/api\.merlingotme\.com\/api\/ping['"`]/,
    'the /api/ping URL must not appear in main.js code: only the Go engine talks to the ping endpoint now.',
  );
});

// ── (2) sendSignedPing contract ──────────────────────────────────────

test('sendSignedPing spawns the engine with the telemetry-ping action', () => {
  const src = mainSrc();
  const fnMatch = src.match(/function sendSignedPing\(payloadObj\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'sendSignedPing(payloadObj) not found in main.js');
  const body = fnMatch[0];
  assert.match(body, /action:\s*'telemetry-ping'/,
    'sendSignedPing must use the binary telemetry-ping action');
  assert.match(body, /timeout:\s*5000/,
    'sendSignedPing must cap the engine spawn at a 5s timeout (fire-and-forget)');
  assert.match(body, /8\s*\*\s*1024/,
    'sendSignedPing must drop payloads over the worker 8KB body cap before spawning');
  assert.doesNotMatch(body, /activeChildProcesses/,
    'sendSignedPing must NOT register the child in activeChildProcesses: app-exit cleanup would kill an in-flight crash ping');
  assert.doesNotMatch(body, /await/,
    'sendSignedPing must stay synchronous-spawn-and-forget: the uncaughtException handler calls it on the way out');
});

test('all four telemetry sites route through sendSignedPing', () => {
  const src = mainSrc();
  // Crash channel: both process-level handlers go through _pingWisdomCrash,
  // which delegates to sendSignedPing.
  assert.match(src, /_pingWisdomCrash\('crash'/, 'uncaughtException site must ping with e=crash');
  assert.match(src, /_pingWisdomCrash\('unhandled_rejection'/, 'unhandledRejection site must ping with e=unhandled_rejection');
  const wisdomCrash = src.match(/function _pingWisdomCrash\(kind, err\)\s*\{[\s\S]*?\n\}/);
  assert.ok(wisdomCrash, '_pingWisdomCrash not found');
  assert.match(wisdomCrash[0], /sendSignedPing\(/, '_pingWisdomCrash must delegate to sendSignedPing');
  // The other three sites call sendSignedPing with their literal event.
  assert.match(src, /sendSignedPing\(\{[\s\S]{0,400}?e:\s*`spell-\$\{status\}`/, 'spell completion site must route through sendSignedPing');
  assert.match(src, /sendSignedPing\(\{[\s\S]{0,400}?e:\s*'bypass_blocked'/, 'bypass telemetry site must route through sendSignedPing');
  assert.match(src, /sendSignedPing\(\{[\s\S]{0,400}?e:\s*'launch'/, 'launch telemetry site must route through sendSignedPing');
});

// ── (3) Event-string allowlist ───────────────────────────────────────

test('every emitted event string is in the literal allowlist and worker-shape-valid', () => {
  const src = mainSrc();
  // Collect literal "e" values passed near sendSignedPing / _pingWisdomCrash
  // call sites: e: 'x' object fields plus the two _pingWisdomCrash kinds.
  const emitted = new Set();
  for (const m of src.matchAll(/_pingWisdomCrash\('([a-z0-9_-]+)'/g)) emitted.add(m[1]);
  for (const m of src.matchAll(/sendSignedPing\(\{[\s\S]{0,400}?e:\s*'([a-z0-9_-]+)'/g)) emitted.add(m[1]);
  // Dynamic spell event: expand to the three statuses task_notification emits.
  if (/e:\s*`spell-\$\{status\}`/.test(src)) {
    emitted.add('spell-completed');
    emitted.add('spell-failed');
    emitted.add('spell-error');
  }
  assert.ok(emitted.size >= 5, `expected at least 5 distinct event strings, found ${emitted.size}: ${[...emitted].join(', ')}`);
  for (const e of emitted) {
    assert.ok(EXPECTED_PING_EVENTS.includes(e),
      `event '${e}' is emitted by main.js but missing from EXPECTED_PING_EVENTS: add it here AND to wisdom-api/worker.js ALLOWED_PING_EVENTS (worker must stay a superset)`);
    assert.match(e, EVENT_RE, `event '${e}' violates the worker shape ^[a-z][a-z0-9_-]{1,39}$ and would 400 at the worker`);
  }
  // And the inverse: nothing in the allowlist has silently stopped being
  // emitted (a rename on the main.js side would strand the worker entry).
  for (const e of EXPECTED_PING_EVENTS) {
    assert.ok(emitted.has(e),
      `EXPECTED_PING_EVENTS lists '${e}' but main.js no longer emits it: update both this test and the worker allowlist together`);
  }
});
