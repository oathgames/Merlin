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
