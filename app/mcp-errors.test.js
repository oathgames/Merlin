'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const errors = require('./mcp-errors');

test('makeError returns a canonical error shape', () => {
  const e = errors.makeError('RATE_LIMITED');
  assert.equal(e.code, 'RATE_LIMITED');
  assert.equal(typeof e.message, 'string');
  assert.equal(e.next_action, 'wait_and_retry');
  assert.equal(e.retry_after_sec, null);
});

test('makeError allows overrides but keeps code stable', () => {
  const e = errors.makeError('RATE_LIMITED', { message: 'custom', retry_after_sec: 42 });
  assert.equal(e.code, 'RATE_LIMITED');
  assert.equal(e.message, 'custom');
  assert.equal(e.retry_after_sec, 42);
});

test('makeError falls back to INTERNAL_ERROR on unknown code', () => {
  const originalWarn = console.warn;
  console.warn = () => {}; // silence
  const e = errors.makeError('NOT_A_REAL_CODE');
  console.warn = originalWarn;
  assert.equal(e.code, 'INTERNAL_ERROR');
});

test('classifyBinaryError recognizes merlin rate limits and pulls retry_after', () => {
  const e = errors.classifyBinaryError('merlin rate limit: meta minute cap reached, try again in 12s');
  assert.equal(e.code, 'RATE_LIMITED');
  assert.equal(e.retry_after_sec, 12);
});

test('classifyBinaryError recognizes minute-unit retry_after', () => {
  const e = errors.classifyBinaryError('merlin rate limit: tiktok daily cap reached, resets in 45m');
  assert.equal(e.code, 'RATE_LIMITED');
  assert.equal(e.retry_after_sec, 45 * 60);
});

test('classifyBinaryError maps HTTP 429 to RATE_LIMITED', () => {
  const e = errors.classifyBinaryError('HTTP 429 Too Many Requests from api.meta.com');
  assert.equal(e.code, 'RATE_LIMITED');
  assert.equal(e.retry_after_sec, 60);
});

test('classifyBinaryError honors Retry-After header when present', () => {
  const e = errors.classifyBinaryError('HTTP 429: Retry-After: 120');
  assert.equal(e.code, 'RATE_LIMITED');
  assert.equal(e.retry_after_sec, 120);
});

test('classifyBinaryError maps token-expired patterns', () => {
  const patterns = [
    'access token has expired',
    'Invalid token',
    'oauth token expired, reauthenticate',
  ];
  for (const p of patterns) {
    const e = errors.classifyBinaryError(p);
    assert.equal(e.code, 'TOKEN_EXPIRED', `expected TOKEN_EXPIRED for "${p}", got ${e && e.code}`);
  }
});

test('classifyBinaryError maps HTTP 401/403 to PERMISSION_DENIED', () => {
  assert.equal(errors.classifyBinaryError('HTTP 403 Forbidden').code, 'PERMISSION_DENIED');
  assert.equal(errors.classifyBinaryError('unauthorized request').code, 'PERMISSION_DENIED');
});

test('classifyBinaryError maps budget language to BUDGET_REJECTED', () => {
  const e = errors.classifyBinaryError('dailyBudget=2000 exceeds maxDailyAdBudget cap of 100');
  assert.equal(e.code, 'BUDGET_REJECTED');
});

test('classifyBinaryError maps timeout/deadline language', () => {
  assert.equal(errors.classifyBinaryError('context deadline exceeded').code, 'TIMEOUT');
  assert.equal(errors.classifyBinaryError('request timed out after 60s').code, 'TIMEOUT');
});

test('classifyBinaryError maps 5xx family to PLATFORM_DOWN with retry_after', () => {
  const e = errors.classifyBinaryError('HTTP 503 Service Unavailable');
  assert.equal(e.code, 'PLATFORM_DOWN');
  assert.equal(e.retry_after_sec, 30);
});

test('classifyBinaryError maps Meta dev-mode subcode 1885183', () => {
  const e = errors.classifyBinaryError('Meta API error subcode 1885183: app in development mode');
  assert.equal(e.code, 'PRECONDITION_FAILED');
});

test('classifyBinaryError returns null on unrecognized strings', () => {
  assert.equal(errors.classifyBinaryError('totally normal success output'), null);
  assert.equal(errors.classifyBinaryError(''), null);
  assert.equal(errors.classifyBinaryError(null), null);
});

test('classifyOrFallback always returns a valid error', () => {
  const e = errors.classifyOrFallback('some unrecognized binary output');
  assert.equal(e.code, 'INTERNAL_ERROR');
  assert.equal(typeof e.message, 'string');
});

test('parseRetryAfter handles hours', () => {
  assert.equal(errors.parseRetryAfter('resets in 3h'), 3 * 3600);
});

test('parseRetryAfter returns null on unparseable input', () => {
  assert.equal(errors.parseRetryAfter('no duration here'), null);
  assert.equal(errors.parseRetryAfter(null), null);
});

test('every code in CODES has required shape', () => {
  for (const [code, row] of Object.entries(errors.CODES)) {
    assert.equal(typeof row.message, 'string', `${code} missing message`);
    assert.equal(typeof row.next_action, 'string', `${code} missing next_action`);
    assert.ok(row.message.length > 0, `${code} has empty message`);
  }
});

test('rate-limit classifier catches every merlin-rate-limit phrasing emitted by ratelimit_preflight.go', () => {
  // Every arm of rateLimitError.Error() in autocmo-core/ratelimit_preflight.go
  const arms = [
    'merlin rate limit: meta minute cap reached, try again in 30s',
    'merlin rate limit: tiktok hour cap reached, try again in 15m',
    'merlin rate limit: google daily cap reached, resets in 4h',
    'merlin rate limit: backing off from shopify, 60s remaining',
  ];
  for (const arm of arms) {
    const e = errors.classifyBinaryError(arm);
    assert.equal(e.code, 'RATE_LIMITED', `arm did not classify: ${arm}`);
    assert.ok(e.retry_after_sec > 0, `arm missing retry_after: ${arm}`);
  }
});

// ── Safe-mode classification (2026-07-11 audit fix) ──────────────────
// The engine's tamper/rollback safe mode lasts 24 hours, but the generic
// rate-limit arm mapped its error string to "Retrying in ~30s": a lie that
// left users watching an endless retry loop. Safe mode must classify FIRST
// and tell the truth.

test('safe-mode string classifies distinctly, not as the ~30s retry copy', () => {
  const e = errors.classifyBinaryError('merlin rate limit: safe mode engaged');
  assert.equal(e.code, 'RATE_LIMITED');
  assert.match(e.message, /paused this platform to keep your account safe/i,
    'safe mode must get the truthful pause copy');
  assert.match(e.message, /start working again on its own/i,
    'copy must say it resumes automatically');
  assert.doesNotMatch(e.message, /Retrying in ~/,
    'the generic 30s retry copy is a lie for a 24h pause');
  assert.equal(e.retry_after_sec, 24 * 3600,
    'no remaining time in the raw string means the full 24h window');
});

test('safe-mode copy carries the remaining duration when the raw error has one', () => {
  const e = errors.classifyBinaryError('merlin rate limit: safe mode engaged, resets in 18h');
  assert.equal(e.code, 'RATE_LIMITED');
  assert.equal(e.retry_after_sec, 18 * 3600);
  assert.match(e.message, /in about 18 hours/, 'copy must surface the real remaining time');
});

test('safe-mode marker variants (safe-mode, safe_mode) also classify as the pause copy', () => {
  for (const raw of ['engine entered safe-mode after tamper check', 'ratelimit safe_mode active']) {
    const e = errors.classifyBinaryError(raw);
    assert.equal(e.code, 'RATE_LIMITED', raw);
    assert.match(e.message, /paused this platform/i, raw);
  }
});

test('ordinary 429 and merlin rate limits still map to the retry copy, not the safe-mode copy', () => {
  const plain = errors.classifyBinaryError('merlin rate limit: meta minute cap reached, try again in 12s');
  assert.match(plain.message, /Retrying in ~12s/);
  assert.doesNotMatch(plain.message, /paused this platform/i);
  const http = errors.classifyBinaryError('HTTP 429 Too Many Requests');
  assert.equal(http.code, 'RATE_LIMITED');
  assert.doesNotMatch(http.message, /paused this platform/i);
});

test('describeDuration reads like plain English at every magnitude', () => {
  assert.equal(errors.describeDuration(24 * 3600), 'in about 24 hours');
  assert.equal(errors.describeDuration(3600), 'in about an hour');
  assert.equal(errors.describeDuration(300), 'in about 5 minutes');
  assert.equal(errors.describeDuration(60), 'in about a minute');
  assert.equal(errors.describeDuration(12), 'in about 12 seconds');
  assert.equal(errors.describeDuration(0), 'soon');
  assert.equal(errors.describeDuration(NaN), 'soon');
});
