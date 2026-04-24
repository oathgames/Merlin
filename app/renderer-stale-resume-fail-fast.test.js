// REGRESSION GUARD (2026-04-24, stale-resume-graceful) — renderer.js's
// onSdkError must fail fast on stale-resume errors. No retry loop.
// Straight to "Start Fresh Session" button wired to startFreshSession()
// (clears the stale sessionId, restarts clean, replays last message).
//
// Incident: v1.18.1's onSdkError retried every non-auth SDK error
// (including stale-resume "No conversation found with session ID: …")
// up to 3× on exponential backoff. Each retry re-read the same stale
// UUID from thread storage, hit the same 404 error, and ended with
// "Merlin tried 3 times but couldn't connect" and a useless "Retry
// Connection" button that just re-ran the same doomed path.
//
// The fix: new `isStaleResumeError` classifier covers SDK wordings
// ("no conversation found", "session not found", etc.) and a fail-fast
// branch BEFORE the retry-exhausted branch renders a single "Start
// Fresh Session" button that calls merlin.startFreshSession() — which
// in main.js clears the thread + restarts — and replays the user's
// last message on success.
//
// This test is source-scan only. renderer.js can't be `require()`d
// without a DOM. We lock down the five critical invariants:
//   (a) isStaleResumeError covers the SDK fingerprint strings
//   (b) fail-fast branch sits BEFORE the retry-exhausted branch
//   (c) fail-fast calls merlin.startFreshSession (NOT startSession)
//   (d) "Start Fresh Session" label is present (user-recognizable action)
//   (e) _restartAttempts is zeroed (same post-recovery contract as auth)
//   (f) renderErrorToBubble still routes through friendlyError (Rule 6)
//
// Run with: node --test app/renderer-stale-resume-fail-fast.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

test('isStaleResumeError covers "no conversation found" fingerprint', () => {
  assert.match(
    SRC,
    /errLower\.includes\(\s*['"]no conversation found['"]\s*\)/i,
    'isStaleResumeError MUST match "no conversation found" — the SDK\'s '
      + 'exact prefix from the v1.18.1 incident: "Claude Code returned '
      + 'an error result: No conversation found with session ID: <uuid>". '
      + 'Without this, stale-resume errors fall through to the retry loop '
      + 'and the user sees the useless generic "Retry Connection" button.',
  );
});

test('isStaleResumeError covers legacy "session not found" fingerprint', () => {
  assert.match(
    SRC,
    /errLower\.includes\(\s*['"]session not found['"]\s*\)/i,
    'isStaleResumeError must match the older "session not found" '
      + 'wording. SDK has historically used both wordings for the same '
      + 'class of failure.',
  );
});

test('isStaleResumeError covers "no such session" + "cannot resume"', () => {
  assert.match(SRC, /errLower\.includes\(\s*['"]no such session['"]\s*\)/i);
  assert.match(SRC, /errLower\.includes\(\s*['"]cannot resume['"]\s*\)/i);
});

test('fail-fast stale-resume branch exists in onSdkError handler', () => {
  const handlerStart = SRC.indexOf('merlin.onSdkError(');
  assert.ok(handlerStart > 0, 'onSdkError handler not found');
  const handlerSlice = SRC.slice(handlerStart, handlerStart + 30000);

  const failFastIdx = handlerSlice.indexOf('if (isStaleResumeError)');
  assert.ok(
    failFastIdx > 0,
    'Expected `if (isStaleResumeError)` fail-fast branch in onSdkError. '
      + 'Missing branch means stale-resume errors fall into the retry '
      + 'loop, which CANNOT possibly succeed (same stale UUID, same 404). '
      + 'This is the core anti-retry rule for this class of error.',
  );
});

test('fail-fast branch sits BEFORE the retry-exhausted branch', () => {
  const handlerStart = SRC.indexOf('merlin.onSdkError(');
  const handlerSlice = SRC.slice(handlerStart, handlerStart + 30000);
  const failFastIdx = handlerSlice.indexOf('if (isStaleResumeError)');
  const retryExhaustedIdx = handlerSlice.indexOf('if (_restartAttempts > MAX_RESTART_ATTEMPTS)');

  assert.ok(failFastIdx > 0);
  assert.ok(retryExhaustedIdx > 0);
  assert.ok(
    failFastIdx < retryExhaustedIdx,
    'Stale-resume fail-fast branch MUST appear BEFORE the retry-exhausted '
      + 'branch. If the ordering inverts, retry-exhausted fires first on '
      + 'the 4th error and shows the useless "Retry Connection" banner '
      + 'before the fail-fast even runs — which is the exact v1.18.1 '
      + 'incident the fix prevents.',
  );
});

test('fail-fast branch sits AFTER the auth fail-fast branch', () => {
  // Ordering-within-fail-fasts matters. Auth and stale-resume are both
  // non-retryable, but an expired token error should route to sign-in
  // (auth) — not to "Start Fresh Session" (stale-resume). The two
  // classifiers don't overlap on SDK wordings as they stand today, but
  // keeping auth first preserves the "sign in > clear thread" priority
  // in case a future SDK error message triggers both.
  const handlerStart = SRC.indexOf('merlin.onSdkError(');
  const handlerSlice = SRC.slice(handlerStart, handlerStart + 30000);
  const authIdx = handlerSlice.indexOf('if (isAuthError)');
  const staleIdx = handlerSlice.indexOf('if (isStaleResumeError)');
  assert.ok(authIdx > 0 && staleIdx > 0);
  assert.ok(
    authIdx < staleIdx,
    'Auth fail-fast MUST appear before stale-resume fail-fast. On '
      + 'ambiguous errors, sign-in is the safer recovery — clearing a '
      + 'thread on what is actually an auth error would discard '
      + 'conversation history without reason.',
  );
});

test('fail-fast branch calls merlin.startFreshSession (NOT startSession)', () => {
  const handlerStart = SRC.indexOf('merlin.onSdkError(');
  const handlerSlice = SRC.slice(handlerStart, handlerStart + 30000);
  const failFastIdx = handlerSlice.indexOf('if (isStaleResumeError)');
  assert.ok(failFastIdx > 0);

  // Narrow to the fail-fast block — from `if (isStaleResumeError) {` to
  // its matching `}`. Brace-balance walk.
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
  assert.ok(end > 0, 'could not balance braces for stale-resume fail-fast block');
  const block = handlerSlice.slice(failFastIdx, end);

  assert.match(
    block,
    /merlin\.startFreshSession\(/,
    'Stale-resume fail-fast MUST call merlin.startFreshSession() — that '
      + 'is the IPC path that clears the stale thread UUID before '
      + 'starting. Calling merlin.startSession() instead would re-read '
      + 'the same stale UUID from storage and hit the exact same 404.',
  );
  assert.match(
    block,
    /Start Fresh Session/,
    'Button label MUST be "Start Fresh Session" — tells the user '
      + 'what clicking will do (start over, not retry the broken thing). '
      + 'Generic "Retry" is what left v1.18.1 users stuck.',
  );
  assert.match(
    block,
    /_restartAttempts\s*=\s*0/,
    'Stale-resume fail-fast must zero _restartAttempts. Otherwise a '
      + 'later non-stale error lands in the retry loop with a pre-'
      + 'incremented counter and the user sees "attempt 2 of 3" as if '
      + 'something had already gone wrong.',
  );
});

test('fail-fast branch replays _lastUserMessage on successful fresh start', () => {
  const handlerStart = SRC.indexOf('merlin.onSdkError(');
  const handlerSlice = SRC.slice(handlerStart, handlerStart + 30000);
  const failFastIdx = handlerSlice.indexOf('if (isStaleResumeError)');
  let i = handlerSlice.indexOf('{', failFastIdx);
  let depth = 0;
  let end = -1;
  for (; i < handlerSlice.length; i++) {
    if (handlerSlice[i] === '{') depth++;
    else if (handlerSlice[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const block = handlerSlice.slice(failFastIdx, end);

  assert.match(
    block,
    /_lastUserMessage.*merlin\.sendMessage\(_lastUserMessage\)/s,
    'Stale-resume fail-fast MUST replay _lastUserMessage after a '
      + 'successful fresh start. Otherwise the user is left staring at '
      + 'an empty chat with their original prompt lost — same UX '
      + 'regression as the v1.18.1 auth path (fixed in that release).',
  );
});

test('startFreshSession is exposed in preload.js', () => {
  const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  assert.match(
    preload,
    /startFreshSession:\s*\(\s*\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]start-fresh-session['"]\s*\)/,
    'preload.js MUST expose startFreshSession on the merlin bridge. '
      + 'Without this, merlin.startFreshSession is undefined at runtime, '
      + 'the fail-fast branch early-returns, and the user is stuck with '
      + 'a dead button.',
  );
});

test('renderErrorToBubble still routes through friendlyError (CLAUDE.md Rule 6)', () => {
  // Belt-and-suspenders: the chat-bubble render path MUST call
  // friendlyError() for stale-resume errors too — every raw error
  // string still gets sanitized before the DOM. Rule 6 is universal.
  const fnStart = SRC.indexOf('function renderErrorToBubble(');
  assert.ok(fnStart > 0, 'renderErrorToBubble not found');
  const fnSlice = SRC.slice(fnStart, fnStart + 2000);
  assert.match(
    fnSlice,
    /friendlyError\(\s*rawError/,
    'renderErrorToBubble MUST call friendlyError(rawError, platformName) '
      + 'on the raw string before rendering. Rule 6 of CLAUDE.md. Raw '
      + 'SDK stack traces to paying users is a Rule violation — true for '
      + 'auth errors, stale-resume errors, and any future error class.',
  );
});

test('REGRESSION GUARD (2026-04-24, stale-resume-graceful) comment present', () => {
  assert.match(
    SRC,
    /REGRESSION GUARD \(2026-04-24, stale-resume-graceful\)/,
    'REGRESSION GUARD comment must be present in renderer.js so a future '
      + 'edit sees the full incident context before touching the '
      + 'fail-fast branch or the isStaleResumeError classifier.',
  );
});
