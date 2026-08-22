// REGRESSION GUARD (2026-08-22, Benebone 7-Pack push): an error envelope must
// never come back without the evidence behind it.
//
// The incident: a Meta bulk-push failed 8/8 with
//
//   "Meta API HTTP 400: Permissions error - Ad Account Has No Access To
//    Instagram Account - ... (code 200/1815199)"
//
// and the agent received exactly this and nothing else:
//
//   { code: 'PERMISSION_DENIED',
//     message: 'Access denied - the platform refused this request.',
//     next_action: 'check_permissions' }
//
// The word "permissions" inside Meta's string tripped the PERMISSION_DENIED
// classifier arm, which returned a canned message and discarded every id,
// noun and subcode in the raw text. The real cause (a cross-brand Instagram
// id leaking through the global config) was undiagnosable from the envelope;
// it took invoking the Go engine directly, outside the app, to see it.
//
// These tests lock the contract: EVERY error envelope carries `detail` with
// the raw, redacted platform text, and `detail` never leaks credentials.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const errors = require('./mcp-errors');
const envelope = require('./mcp-envelope');

const META_IG_FAILURE =
  '  [1/8] 7 Chews. One Box.... creative: Meta API HTTP 400: Permissions error ' +
  '- Ad Account Has No Access To Instagram Account - Ad account has no access ' +
  'to this Instagram account. (code 200/1815199)';

// ── The incident itself ─────────────────────────────────────

test('the exact Meta Instagram failure carries its raw text on detail', () => {
  const err = errors.classifyOrFallback(META_IG_FAILURE, 'Action failed');
  assert.strictEqual(err.code, 'PERMISSION_DENIED');
  assert.match(err.detail, /Ad Account Has No Access To Instagram Account/);
  assert.match(err.detail, /1815199/, 'the Meta subcode must survive classification');
});

test('a failure envelope exposes detail to the caller', () => {
  const err = errors.classifyOrFallback(META_IG_FAILURE, 'Action failed');
  const env = envelope.fail(err);
  assert.strictEqual(env.ok, false);
  assert.match(env.error.detail, /1815199/);
});

test('the rendered summary line names the real failure, not just the category', () => {
  const env = envelope.fail(errors.classifyOrFallback(META_IG_FAILURE, 'Action failed'));
  const summary = envelope.summarize(env);
  assert.match(summary, /Instagram/,
    'a reader scanning the summary must see the cause, not only "Access denied"');
});

// ── The general contract ────────────────────────────────────

test('every classifier arm attaches detail', () => {
  // One raw string per arm in CLASSIFIERS. If an arm is added without a
  // detail, add it here too - a classification with no evidence behind it is
  // a guess the next session cannot check.
  const samples = [
    'merlin rate limit: safe mode engaged, 3h remaining',
    'merlin rate limit: meta minute cap reached, try again in 12s',
    'HTTP 429 too many requests',
    'token has expired, please re-authenticate',
    'no access token configured for this brand',
    'HTTP 403 forbidden',
    'budget exceeds maxDailyAdBudget',
    'HTTP 404 object not found',
    'context deadline exceeded',
    'HTTP 502 bad gateway',
    'error subcode 1885183 development mode',
    'missing required parameter targetAdSetId',
  ];
  for (const raw of samples) {
    const err = errors.classifyBinaryError(raw);
    assert.ok(err, `no classifier matched: ${raw}`);
    assert.ok(err.detail, `classified "${raw}" as ${err.code} but dropped the raw text`);
    assert.match(err.detail, /\S/);
  }
});

test('the unclassified fallback carries detail too', () => {
  // This path matters most: no pattern matched, so `message` carries nothing
  // the caller did not already know.
  const err = errors.classifyOrFallback('engine exploded in an entirely novel way');
  assert.strictEqual(err.code, 'INTERNAL_ERROR');
  assert.match(err.detail, /entirely novel way/);
});

test('detail is null, never an empty string, when there is nothing to report', () => {
  assert.strictEqual(errors.makeError('INVALID_INPUT').detail, null);
  assert.strictEqual(errors.makeError('INVALID_INPUT', { detail: '' }).detail, null);
  assert.strictEqual(errors.makeError('INVALID_INPUT', { detail: '   \n  ' }).detail, null);
  assert.strictEqual(errors.makeError('INVALID_INPUT', { detail: 42 }).detail, null);
  assert.strictEqual(envelope.fail(errors.makeError('INVALID_INPUT')).error.detail, null);
});

// ── Safety: detail must not become a credential exfiltration path ──

test('detail redacts credential material', () => {
  const raw = 'push failed: Authorization: Bearer EAAG1234567890abcdefghijklmnopqrstuvwxyz098765';
  const err = errors.classifyOrFallback(raw);
  assert.ok(!err.detail.includes('EAAG1234567890abcdefghijklmnopqrstuvwxyz098765'),
    'a token present in engine output must not ride out on detail');
  assert.match(err.detail, /REDACTED/);
});

test('detail is capped so a large failure log cannot flood the caller', () => {
  const huge = Array.from({ length: 500 }, (_, i) => `line ${i} of engine noise`).join('\n');
  const err = errors.classifyOrFallback(huge);
  assert.ok(err.detail.length <= errors.DETAIL_MAX_CHARS + 32,
    `detail was ${err.detail.length} chars`);
  // The TAIL is kept: the engine prints progress first and the failure last.
  assert.match(err.detail, /line 499 of engine noise/);
  assert.match(err.detail, /truncated/);
});

test('detail drops blank lines but preserves multi-line structure', () => {
  const err = errors.classifyOrFallback('first line\n\n\nsecond line');
  assert.strictEqual(err.detail, 'first line\nsecond line');
});

// ── Source scan: nothing may strip detail back out ──────────

test('envelope.fail copies detail onto the error object', () => {
  const src = fs.readFileSync(path.join(__dirname, 'mcp-envelope.js'), 'utf8');
  const failBody = src.slice(src.indexOf('function fail('), src.indexOf('function render('));
  assert.match(failBody, /detail:/,
    'fail() must copy detail through - dropping it here silently undoes the whole fix');
});
