// REGRESSION GUARD (2026-06-28, engine-auth-never-reauth)
//
// Incident: a Windows user with Claude Desktop signed in was forced to
// re-authenticate Merlin's engine over and over (user: "this issue is still
// not fucking fixed ... the user should NEVER have to auth"). The /rsi deep
// dive found a cluster of root causes that all force a needless full browser
// sign-in even when a valid refreshToken exists:
//   A. A single transient 401 during the SDK's OWN silent refresh fired
//      requireAuth() immediately, with no retry-the-refresh-first.
//   B. A Mac-only "anti-deletion" guard ran on Windows too and re-persisted a
//      bare (refreshToken-less) blob to the Tier-1 credentials file, stripping
//      silent-refresh and pinning the user to re-auth-on-every-expiry.
//   C. isClaudeAuthError matched ANY error mentioning "token"/"account",
//      misclassifying non-auth errors as logout.
//
// main.js cannot be require()d without Electron, so these are source-scans of
// the load-bearing invariants. The pure-helper behaviour (Windows alt-path →
// Tier 1) is covered functionally in auth-credentials.test.js.
//
// Run: node --test app/main-auth-silent-retry.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('a module-level _authRetryArmed flag exists (one-shot silent retry budget)', () => {
  assert.match(
    SRC,
    /^let _authRetryArmed = true;/m,
    '_authRetryArmed must be a MODULE-level let (not per-session) so it survives '
      + 'the silent restart; a per-session flag would reset on restart and loop.',
  );
});

test('the STREAM auth interceptor retries once via silent restart before requireAuth', () => {
  // Anchor on the interceptor CALL SITE, not the function definition (which
  // appears earlier in the file as `function isSdkAuthErrorMessage(msg)`).
  const idx = SRC.indexOf('!_authFailureIntercepted && isSdkAuthErrorMessage(msg)');
  assert.ok(idx > 0, 'stream interceptor call site not found');
  const block = SRC.slice(idx, idx + 1300); // long REGRESSION GUARD comment precedes the if/else
  assert.match(block, /if \(_authRetryArmed\)/,
    'the stream interceptor must check _authRetryArmed before requireAuth');
  assert.match(block, /_authRetryArmed = false/,
    'the retry budget must be consumed (set false) when used');
  assert.match(block, /startSession\(activeBrand\)/,
    'the retry must restart the session so the SDK re-reads creds + re-refreshes');
  // requireAuth only in the else (already-retried) branch.
  assert.match(block, /else \{[\s\S]{0,200}?requireAuth/,
    'requireAuth must be the ELSE branch (only after the one-shot retry failed)');
});

test('the THROWN-error path also retries once before requireAuth', () => {
  const idx = SRC.indexOf('preserve the queue across auth recovery');
  assert.ok(idx > 0, 'thrown-error auth branch not found');
  const block = SRC.slice(idx, idx + 700);
  assert.match(block, /if \(_authRetryArmed\)/, 'thrown path must check _authRetryArmed');
  assert.match(block, /startSession\(activeBrand\)/, 'thrown path must silent-restart');
});

test('_authRetryArmed is RE-ARMED only on confirmed auth (accountInfo success)', () => {
  const idx = SRC.indexOf('accountInfoPromise.then');
  assert.ok(idx > 0, 'accountInfo.then not found');
  const block = SRC.slice(idx, idx + 600);
  assert.match(block, /_authRetryArmed = true/,
    'accountInfo success (proof of auth) must re-arm the one-shot retry for the '
      + 'next genuine expiry — re-arming here (not at session start) is what '
      + 'prevents an auth-error → restart → auth-error infinite loop.');
});

test('persistCredentials REFUSES a non-refreshable blob (no refresh-token strip)', () => {
  const idx = SRC.indexOf('function persistCredentials(');
  assert.ok(idx > 0, 'persistCredentials not found');
  const fn = SRC.slice(idx, idx + 1300); // long REGRESSION GUARD comment precedes the body
  assert.match(fn, /extractToken\(raw\)/,
    'persistCredentials must inspect the blob before writing');
  assert.match(fn, /!parsed\.refreshable[\s\S]{0,160}?return false/,
    'persistCredentials must return WITHOUT writing when the blob lacks a '
      + 'refreshToken — writing a bare token to the Tier-1 file strips silent-refresh.');
});

test('the Mac anti-deletion guard no longer writes a bare accessToken blob', () => {
  // The old guard did persistCredentials(JSON.stringify({claudeAiOauth:{accessToken:...}}))
  // with NO refreshToken. That exact bare-blob write must be gone.
  assert.doesNotMatch(
    SRC,
    /persistCredentials\(JSON\.stringify\(\{\s*claudeAiOauth:\s*\{\s*accessToken:[^}]*\}\s*\}\)\)/,
    'the bare accessToken-only anti-deletion re-persist must be removed — it '
      + 'stripped the refreshToken and pinned users to forced re-auth.',
  );
});

test('isClaudeAuthError no longer matches a bare "token" or "account" mention', () => {
  const idx = SRC.indexOf('function isClaudeAuthError(');
  assert.ok(idx > 0, 'isClaudeAuthError not found');
  const fn = SRC.slice(idx, idx + 700);
  // The old broad alternation /...|token|...|account/ must be gone.
  assert.doesNotMatch(fn, /\/auth\|authorization\|token\|/,
    'the broad token/account matcher must be narrowed (it misclassified '
      + 'rate-limit/quota errors mentioning "token" as auth failures).');
  assert.match(fn, /not logged in|invalid api key|authentication/i,
    'the narrowed matcher must still catch genuine credential-failure language.');
});
