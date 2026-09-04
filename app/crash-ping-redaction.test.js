// REGRESSION GUARD (2026-09-04, crash-ping-unredacted):
//
// `_pingWisdomCrash` in app/main.js POSTs the crash message and stack to the
// wisdom API (api.merlingotme.com) via the signed telemetry ping. Both strings
// were sent RAW. A crash message routinely carries the credential that caused
// it — a Meta EAA token in the rejected URL, a `Bearer …` header echoed back by
// an HTTP client, a Shopify Admin key in a serialized request config — so the
// one code path that fires when the process is least trustworthy was also the
// one path that shipped secrets off the machine unredacted.
//
// Two locks:
//   1. SOURCE — _pingWisdomCrash must route both fields through redactOutput,
//      and must do it BEFORE the 500-char slice (a truncated token is still a
//      leaked token prefix).
//   2. BEHAVIOR — run the real redactOutput over token-shaped crash strings
//      and assert nothing token-shaped survives.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { redactOutput } = require('./mcp-redact.js');

function pingFnSource() {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = src.indexOf('function _pingWisdomCrash(');
  assert.ok(start > 0, '_pingWisdomCrash not found in main.js');
  const end = src.indexOf('\nprocess.on(', start);
  assert.ok(end > start, 'could not find the end of _pingWisdomCrash');
  return src.slice(start, end);
}

test('SOURCE: _pingWisdomCrash redacts both error and stack before sending', () => {
  const fn = pingFnSource();
  assert.match(fn, /require\('\.\/mcp-redact'\)/, 'must pull redactOutput from app/mcp-redact.js');
  assert.match(
    fn,
    /error:\s*redactOutput\([^)]*\)\.slice\(0,\s*500\)/,
    'the error field must be redacted, and redacted BEFORE the 500-char slice',
  );
  assert.match(
    fn,
    /stack:\s*redactOutput\([^)]*\)\.slice\(0,\s*500\)/,
    'the stack field must be redacted, and redacted BEFORE the 500-char slice',
  );
  assert.ok(
    !/error:\s*msg\.slice/.test(fn) && !/stack:\s*stack\.slice/.test(fn),
    'no raw msg/stack may reach sendSignedPing',
  );
});

test('BEHAVIOR: a Meta token in a crash message is scrubbed before the POST', () => {
  const raw = 'Error: request failed https://graph.facebook.com/v21.0/act_123/ads'
    + '?access_token=EAAGm0PX4ZCpsBO1234567890abcdefghijklmnopqrstuvwxyzABCDEFGH';
  const out = redactOutput(raw, '');
  assert.ok(!/EAAGm0PX4ZCpsBO/.test(out), 'the token must not survive redaction');
  assert.match(out, /REDACTED/);
});

test('BEHAVIOR: a Bearer header echoed in a stack trace is scrubbed', () => {
  const raw = 'TypeError: bad response\n'
    + '    at fetchWithAuth (app/main.js:1:1) { authorization: "Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789" }';
  const out = redactOutput(raw, '');
  assert.ok(!/abcdefghijklmnopqrstuvwxyz0123456789/.test(out), 'the bearer value must not survive redaction');
});

test('BEHAVIOR: an ordinary crash message survives intact (redaction is not a blanket wipe)', () => {
  assert.strictEqual(redactOutput('TypeError: win is not defined', ''), 'TypeError: win is not defined');
});
