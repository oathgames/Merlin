// REGRESSION GUARD (2026-10-17): the engine's Meta rate-limit errors now name
// the per-ad-account bucket and print Go durations ("try again in 37m0s").
// These strings mirror autocmo-core/ratelimit_preflight.go rateLimitError.Error()
// and meta.go metaProbeFields. Two things must hold for every one of them:
//   1. mcp-errors classifies it RATE_LIMITED with the REAL wait. The old
//      seconds regex read "37m0s" as 0s and fell back to the ~30s retry.
//   2. renderer.js friendlyError maps it to the rate-limit (or safe-mode)
//      copy, never to a budget, token or generic message.
// The token-expired text changed from "Meta token expired (em dash) re-authenticate
// with meta-login" to "Meta token expired, run meta-login ..."; both must
// land on the same classification and the same user copy.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const errors = require('./mcp-errors');

function loadFriendlyError() {
  const src = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  const start = src.indexOf('function friendlyError(raw, platformName)');
  const end = src.indexOf('\nfunction friendlyErrorPlain(', start);
  assert.ok(start >= 0 && end > start, 'friendlyError must exist in renderer.js');
  const ctx = {};
  vm.runInNewContext(`${src.slice(start, end)}\nthis.friendlyError = friendlyError;`, ctx);
  return ctx.friendlyError;
}

const AFFECTED = 'other ad accounts, the other read/write budget, and pausing ads with status=PAUSED are not affected';

const CASES = [
  { name: 'bucket minute cap', wait: 37,
    raw: `merlin rate limit: meta act_42 write minute cap reached, try again in 37s (budget 30/min for meta act_42 write; ${AFFECTED})` },
  { name: 'bucket hour cap (Go duration)', wait: 37 * 60,
    raw: `merlin rate limit: meta act_42 read hour cap reached, try again in 37m0s (budget 300/hour for meta act_42 read; ${AFFECTED})` },
  { name: 'bucket daily cap', wait: 5 * 3600 + 12 * 60,
    raw: `merlin rate limit: meta act_42 read daily cap reached, resets in 5h12m0s (budget 3000/day for meta act_42 read; ${AFFECTED})` },
  { name: 'bucket backoff after a Meta throttle', wait: 64,
    raw: 'merlin rate limit: backing off from meta act_42 read after Meta throttled it, 1m4s remaining' },
  { name: 'usage shed point', wait: 4 * 60 + 12,
    raw: 'merlin rate limit: meta act_42 read: Meta reports 91% usage (X-Business-Use-Case-Usage ads_management), at or above the 75% shed point, try again in 4m12s (the reading expires on its own; pausing ads with status=PAUSED is not affected)' },
  { name: 'regain deadline', wait: 12 * 60,
    raw: 'merlin rate limit: meta act_42 write: Meta reports this budget is throttled (X-Business-Use-Case-Usage estimated_time_to_regain_access), try again in 12m0s. This applies to pauses too, because Meta itself is refusing these calls' },
  { name: 'budget probe wrapped rate limit', wait: 3600,
    raw: 'cannot tell whether 120001 is a campaign or ad set, budget not changed: Meta rate-limited this read (meta act_42 read budget, HTTP 400): User request limit reached; this is a rate limit, not a wrong object type, try again in 1h0m0s' },
];

const SAFE_MODE_RAW = 'merlin rate limit (SAFE MODE): meta act_42 write minute cap reached, try again in 37s. Safe mode is active for 23h59m0s more and caps every bucket at 1/min; it was entered after suspected rate-state tampering or 5 consecutive rate-limit hits. Pausing ads (status=PAUSED) is not blocked by safe mode';

test('parseGoDuration reads Go durations and rejects non-durations', () => {
  assert.equal(errors.parseGoDuration('37m0s'), 2220);
  assert.equal(errors.parseGoDuration('1h0m0s'), 3600);
  assert.equal(errors.parseGoDuration('1h2m3s'), 3723);
  assert.equal(errors.parseGoDuration('45s'), 45);
  assert.equal(errors.parseGoDuration('2m'), 120);
  assert.equal(errors.parseGoDuration('1.5s'), 2);
  assert.equal(errors.parseGoDuration('37m0s.'), 2220);
  assert.equal(errors.parseGoDuration('12'), null);
  assert.equal(errors.parseGoDuration('500ms'), null);
  assert.equal(errors.parseGoDuration(''), null);
});

test('parseRetryAfter no longer reads "37m0s" as zero seconds', () => {
  assert.equal(errors.parseRetryAfter('try again in 37m0s'), 2220);
  assert.equal(errors.parseRetryAfter('1h0m0s remaining'), 3600);
  // Pre-existing phrasings are unchanged.
  assert.equal(errors.parseRetryAfter('try again in 12s'), 12);
  assert.equal(errors.parseRetryAfter('12 seconds'), 12);
  assert.equal(errors.parseRetryAfter('try again in 2m'), 120);
  assert.equal(errors.parseRetryAfter('resets in 3h'), 10800);
  assert.equal(errors.parseRetryAfter('Retry-After: 30'), 30);
});

for (const c of CASES) {
  test(`mcp-errors: ${c.name} is RATE_LIMITED with the real wait`, () => {
    const e = errors.classifyBinaryError(c.raw);
    assert.ok(e, 'must classify');
    assert.equal(e.code, 'RATE_LIMITED');
    assert.equal(e.retry_after_sec, c.wait);
  });
}

test('mcp-errors: SAFE MODE text takes the safe-mode copy with the per-call wait', () => {
  const e = errors.classifyBinaryError(SAFE_MODE_RAW);
  assert.equal(e.code, 'RATE_LIMITED');
  assert.match(e.message, /paused this platform/);
  assert.equal(e.retry_after_sec, 37, 'the next call is allowed after the minute wait, not after 24h');
});

test('friendlyError maps every bucketed Meta rate-limit text to the rate-limit copy', () => {
  const friendlyError = loadFriendlyError();
  const want = friendlyError('merlin rate limit: meta minute cap reached, try again in 12s', 'Meta');
  assert.match(want, /Too many requests/);
  for (const c of CASES) {
    assert.equal(friendlyError(c.raw, 'Meta'), want, c.name);
  }
  assert.match(friendlyError(SAFE_MODE_RAW, 'Meta'), /paused for safety/);
});

test('the new Meta token-expired text classifies and renders like the old one', () => {
  const oldRaw = 'Meta token expired \u2014 re-authenticate with meta-login';
  const newRaw = 'Meta token expired, run meta-login to get a new 60-day token';
  assert.equal(errors.classifyBinaryError(newRaw).code, 'TOKEN_EXPIRED');
  assert.equal(errors.classifyBinaryError(newRaw).code, errors.classifyBinaryError(oldRaw).code);
  const friendlyError = loadFriendlyError();
  assert.equal(friendlyError(newRaw, 'Meta'), friendlyError(oldRaw, 'Meta'));
});
