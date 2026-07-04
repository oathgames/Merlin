// REGRESSION GUARD (2026-04-24, auth-error-graceful) — onSdkError must
// fail fast on auth errors. No retry loop. Straight to sign-in UI.
//
// Incident: v1.18.0's onSdkError retried every SDK error (including
// 401 Unauthorized) up to 3× on an exponential backoff. Each retry
// re-spawned the SDK session, which 401'd identically. After the 3rd
// failure the user saw "Merlin tried 3 times but couldn't connect"
// with a generic "Retry Connection" button that just re-ran
// startSession() (also 401'd). The user's prompt sat frozen. User
// quote 2026-04-23: "this cannot happen, we need to fail and clear
// gracefully."
//
// The fix: widen isAuthError detection to cover the SDK's exact
// fingerprint strings, and add a short-circuit branch BEFORE the
// retry loop that renders a single "Sign In to Claude" button wired
// to triggerClaudeLogin(). On success, replay the user's original
// message — same contract as onAuthRequired.
//
// This test is source-scan only. renderer.js can't be `require()`d
// without a DOM. We lock down the three critical invariants:
//   (a) isAuthError covers the SDK fingerprint strings
//   (b) the fail-fast branch sits BEFORE the retry-exhausted branch
//   (c) the fail-fast branch calls triggerClaudeLogin (not startSession)
//
// Run with: node --test app/renderer-auth-error-fail-fast.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

test('isAuthError covers Failed to authenticate fingerprint', () => {
  assert.match(
    SRC,
    /errLower\.includes\(\s*['"]failed to authenticate['"]\s*\)/i,
    'isAuthError must check for "failed to authenticate" — the SDK\'s '
      + 'canonical auth-failure prefix. Without this, a thrown error '
      + 'whose message starts "Failed to authenticate. API Error: 401" '
      + 'falls through to the retry loop.',
  );
});

test('isAuthError covers "type":"authentication_error" JSON fingerprint', () => {
  assert.match(
    SRC,
    /errLower\.includes\(\s*['"]"type":"authentication_error"['"]\s*\)/i,
    'isAuthError must match the literal JSON fingerprint from Anthropic\'s '
      + 'API error response. If the raw payload leaks through an upstream '
      + 'layer, this is the ONE string that unambiguously signals auth.',
  );
});

test('isAuthError covers Please run /login fingerprint', () => {
  assert.match(
    SRC,
    /errLower\.includes\(\s*['"]please run \/login['"]\s*\)/i,
    'isAuthError must match "please run /login" — surfaced by the SDK '
      + 'when the CLI detects missing credentials on a non-macOS host.',
  );
});

test('fail-fast auth branch exists at the top of the error-handling block', () => {
  // Locate the onSdkError handler and check that the `if (isAuthError)`
  // branch appears BEFORE the `if (_restartAttempts > MAX_RESTART_ATTEMPTS)`
  // branch. Order matters: if the retry-exhausted branch runs first, the
  // user sees "Merlin tried 3 times" before ever reaching the auth
  // fail-fast path.
  const handlerStart = SRC.indexOf('merlin.onSdkError(');
  assert.ok(handlerStart > 0, 'onSdkError handler not found');

  const handlerSlice = SRC.slice(handlerStart, handlerStart + 30000);
  const failFastIdx = handlerSlice.indexOf('if (isAuthError)');
  const retryExhaustedIdx = handlerSlice.indexOf('if (_restartAttempts > MAX_RESTART_ATTEMPTS)');

  assert.ok(
    failFastIdx > 0,
    'Expected `if (isAuthError)` fail-fast branch in onSdkError — '
      + 'auth errors must NOT fall through to the retry loop.',
  );
  assert.ok(
    retryExhaustedIdx > 0,
    '`if (_restartAttempts > MAX_RESTART_ATTEMPTS)` branch not found — '
      + 'test needs updating if the retry-exhausted branch was renamed.',
  );
  assert.ok(
    failFastIdx < retryExhaustedIdx,
    'The auth fail-fast branch (`if (isAuthError)`) MUST appear BEFORE '
      + 'the retry-exhausted branch. Otherwise the retry loop can fire '
      + '3× on auth errors before the fail-fast even runs.',
  );
});

test('fail-fast branch calls triggerClaudeLogin (not startSession)', () => {
  const handlerStart = SRC.indexOf('merlin.onSdkError(');
  const handlerSlice = SRC.slice(handlerStart, handlerStart + 30000);
  const failFastIdx = handlerSlice.indexOf('if (isAuthError)');
  assert.ok(failFastIdx > 0, 'fail-fast branch not found');

  // Narrow to the fail-fast block — from `if (isAuthError) {` to its
  // matching `}`. We find the opening `{` after the `if (isAuthError)`
  // match and balance braces until depth hits 0 again.
  let i = handlerSlice.indexOf('{', failFastIdx);
  let depth = 0;
  let end = -1;
  for (; i < handlerSlice.length; i++) {
    const c = handlerSlice[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > 0, 'could not balance braces for fail-fast block');
  const block = handlerSlice.slice(failFastIdx, end);

  assert.match(
    block,
    /merlin\.triggerClaudeLogin\(/,
    'Auth fail-fast MUST call merlin.triggerClaudeLogin() — that is '
      + 'what opens the OAuth browser flow. Calling merlin.startSession() '
      + 'instead just re-runs the same 401-producing SDK boot.',
  );
  assert.match(
    block,
    /Sign in to Claude/,
    'Auth fail-fast button label must be "Sign in to Claude" so the '
      + 'user understands what clicking does. Generic "Retry" is what '
      + 'got users stuck in the v1.18.0 loop. (Label sentence-cased in the '
      + '2026-07-04 microcopy-unification pass — was "Sign In to Claude".)',
  );
  assert.match(
    block,
    /_restartAttempts\s*=\s*0/,
    'Auth fail-fast must zero _restartAttempts. Otherwise a later '
      + 'non-auth error lands in the retry loop with a pre-incremented '
      + 'counter and the user sees "attempt 2 of 3" as if something '
      + 'already went wrong.',
  );
});

test('renderErrorToBubble still routes through friendlyError (CLAUDE.md Rule 6)', () => {
  // Belt-and-suspenders: the chat-bubble render path MUST call
  // friendlyError(). The fix in onSdkError widens auth detection but
  // does NOT bypass the universal friendlyError pipe — every raw
  // error string still gets sanitized before it enters the DOM.
  const fnStart = SRC.indexOf('function renderErrorToBubble(');
  assert.ok(fnStart > 0, 'renderErrorToBubble not found');
  const fnSlice = SRC.slice(fnStart, fnStart + 2000);
  assert.match(
    fnSlice,
    /friendlyError\(\s*rawError/,
    'renderErrorToBubble MUST call friendlyError(rawError, platformName) '
      + 'on the raw string before rendering. Rule 6 of CLAUDE.md. Raw '
      + 'stack traces / JSON payloads to paying users is a Rule violation.',
  );
});
