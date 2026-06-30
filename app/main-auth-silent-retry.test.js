// REGRESSION GUARD (2026-06-28, engine-auth hardening + silent-retry REVERT)
//
// v1.31.3 added a one-shot "silent session restart" on auth error. It re-entered
// startSession() at a fixed 250ms delay, but activeQuery only clears when the SDK
// closes the stream (later), so the restart raced the "session already active"
// guard and no-op'd — leaving the user hung on "Starting session…" with NO
// sign-in prompt (live incident: could not add a brand). v1.31.4 REVERTED the
// silent-retry: an auth error now opens the sign-in IMMEDIATELY (requireAuth), the
// proven behavior that always reaches a resolution.
//
// The THREE Tier-1 fixes from v1.31.3 are KEPT (they reduce re-auth frequency and
// carry zero hang risk): persistCredentials refuses non-refreshable blobs, Windows
// alt-path -> Tier-1 promotion (tested in auth-credentials.test.js), and the
// narrowed isClaudeAuthError. This file locks the revert + the kept fixes.
//
// main.js can't be require()d without Electron, so these are source-scans.
//
// Run: node --test app/main-auth-silent-retry.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('the v1.31.3 silent-retry flag is GONE (it caused the startup hang)', () => {
  assert.doesNotMatch(
    SRC,
    /_authRetryArmed/,
    'the _authRetryArmed silent-retry must stay reverted — re-entering startSession '
      + 'on a timer raced the activeQuery guard and hung the app at "Starting session".',
  );
});

test('an auth error opens the sign-in IMMEDIATELY (no timer-restart in the interceptor)', () => {
  const idx = SRC.indexOf('!_authFailureIntercepted && isSdkAuthErrorMessage(msg)');
  assert.ok(idx > 0, 'stream interceptor call site not found');
  const block = SRC.slice(idx, idx + 400);
  assert.match(
    block,
    /requireAuth\('session error: authentication failed'\)/,
    'the stream auth interceptor must call requireAuth immediately so the user '
      + 'always reaches the sign-in prompt.',
  );
  assert.doesNotMatch(
    block,
    /setTimeout\([^)]*startSession/,
    'the interceptor must NOT re-enter startSession on a timer (the hang cause).',
  );
});

test('persistCredentials REFUSES a non-refreshable blob (kept Tier-1 fix)', () => {
  const idx = SRC.indexOf('function persistCredentials(');
  assert.ok(idx > 0, 'persistCredentials not found');
  const fn = SRC.slice(idx, idx + 1300); // long REGRESSION GUARD comment precedes the body
  assert.match(fn, /extractToken\(raw\)/, 'persistCredentials must inspect the blob before writing');
  assert.match(
    fn,
    /!parsed\.refreshable[\s\S]{0,160}?return false/,
    'persistCredentials must return WITHOUT writing a non-refreshable blob '
      + '(writing a bare token to the Tier-1 file strips silent-refresh).',
  );
});

test('the Mac anti-deletion guard no longer writes a bare accessToken blob (kept fix)', () => {
  assert.doesNotMatch(
    SRC,
    /persistCredentials\(JSON\.stringify\(\{\s*claudeAiOauth:\s*\{\s*accessToken:[^}]*\}\s*\}\)\)/,
    'the bare accessToken-only anti-deletion re-persist must stay removed.',
  );
});

test('isClaudeAuthError stays narrowed (no bare "token"/"account" match) (kept fix)', () => {
  const idx = SRC.indexOf('function isClaudeAuthError(');
  assert.ok(idx > 0, 'isClaudeAuthError not found');
  const fn = SRC.slice(idx, idx + 700);
  assert.doesNotMatch(fn, /\/auth\|authorization\|token\|/,
    'the broad token/account matcher must stay narrowed.');
  assert.match(fn, /not logged in|invalid api key|authentication/i,
    'the narrowed matcher must still catch genuine credential-failure language.');
});
