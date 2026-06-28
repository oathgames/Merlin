// REGRESSION GUARD (2026-06-28, streamed-auth-error-leak)
//
// Incident: a paying user sent "Set up a new brand named North Swell…" while
// the engine's Claude credential was invalid. The SDK streamed the 401 back as
// ordinary assistant TEXT and the renderer painted the raw payload into a chat
// bubble:
//   Failed to authenticate. API Error: 401 {"type":"error","error":
//   {"type":"authentication_error","message":"Invalid authentication
//   credentials"},"request_id":"req_011CcU1RzwHh8mzvLGBfhYGq"}
// (user reaction: "what the fuck is this? i thought we fixed this?")
//
// #294 fixed the STUCK "Sending to Claude…" bar; it did NOT cover the raw
// payload leaking through the STREAMING TEXT path. main.js's
// isSdkAuthErrorMessage interceptor catches the one-shot wrapper + single-delta
// case, but when the payload fragments across stream deltas no single chunk
// holds the full fingerprint, so it slips through to appendText. The fix is a
// shape-independent renderer backstop: detect the SDK's literal 401 auth
// signature on the ACCUMULATED stream text, wipe the partial bubble, and route
// to the unified sign-in flow (runAuthRequiredFlow) instead of rendering it.
//
// This file does BOTH: a functional test of the pure detector
// (streamedAuthErrorPresent — the heart of the fix, incl. false-positive
// guards) and source-scans of the wiring (renderer.js can't be require()d
// without a DOM).
//
// Run with: node --test app/renderer-streamed-auth-leak.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

// ── Extract the pure detector and exercise it for real ──────────────
function loadDetector() {
  const m = SRC.match(/function streamedAuthErrorPresent\(text\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'streamedAuthErrorPresent(text) function not found in renderer.js');
  // Named function expression in parens → returns the function itself.
  // eslint-disable-next-line no-eval
  return eval('(' + m[0] + ')');
}

test('detector fires on the exact leaked payload from the incident', () => {
  const fn = loadDetector();
  const leaked = 'Failed to authenticate. API Error: 401 {"type":"error","error":'
    + '{"type":"authentication_error","message":"Invalid authentication credentials"},'
    + '"request_id":"req_011CcU1RzwHh8mzvLGBfhYGq"}';
  assert.equal(fn(leaked), true, 'must detect the verbatim leaked 401 payload');
});

test('detector fires on the OAuth-token-expired 401 variant', () => {
  const fn = loadDetector();
  const expired = 'Failed to authenticate. API Error: 401 {"type":"error","error":'
    + '{"type":"authentication_error","message":"OAuth token expired"}}';
  assert.equal(fn(expired), true);
});

test('detector fires even when the signature lands mid-buffer (accumulated stream)', () => {
  const fn = loadDetector();
  // The delta handler passes textBuffer + nextDelta — the prefix may carry
  // earlier streamed characters before the signature completes.
  assert.equal(fn('  \n\nFailed to authenticate. API Error: 401 {'), true);
});

test('detector does NOT fire on benign prose that merely discusses auth', () => {
  const fn = loadDetector();
  // False-positive guard: a real Claude response explaining auth must stream
  // normally. None of these contain the literal "Failed to authenticate. API
  // Error: 401" SDK signature.
  assert.equal(fn('Here is how to handle authentication errors in your Express app.'), false);
  assert.equal(fn('I failed to authenticate the test user in my earlier example, so let us retry.'), false);
  assert.equal(fn('A 401 means unauthorized; an API error like that is common.'), false);
  // Even the bare JSON type string alone must not trip it (a user could ask
  // Claude to explain `"type":"authentication_error"` in a code block).
  assert.equal(fn('The field `"type":"authentication_error"` indicates a bad key.'), false);
});

test('detector does NOT fire on partial fragments that lack the full signature', () => {
  const fn = loadDetector();
  assert.equal(fn('Failed to'), false);
  assert.equal(fn('API Error: 401'), false);
  assert.equal(fn('Failed to authenticate.'), false); // no "API Error: 401" yet
});

test('detector is null/non-string safe', () => {
  const fn = loadDetector();
  assert.equal(fn(null), false);
  assert.equal(fn(undefined), false);
  assert.equal(fn(42), false);
  assert.equal(fn(''), false);
});

// ── Source-scan the wiring ──────────────────────────────────────────

test('the streaming text_delta handler checks the detector BEFORE appendText', () => {
  const handlerIdx = SRC.indexOf("event.type === 'content_block_delta'");
  assert.ok(handlerIdx > 0, 'content_block_delta handler not found');
  const slice = SRC.slice(handlerIdx, handlerIdx + 1200);
  const guardIdx = slice.indexOf('streamedAuthErrorPresent(textBuffer + event.delta.text)');
  const appendIdx = slice.indexOf('appendText(event.delta.text)');
  assert.ok(guardIdx > 0, 'auth guard missing from the text_delta handler');
  assert.ok(appendIdx > 0, 'appendText(event.delta.text) call not found');
  assert.ok(
    guardIdx < appendIdx,
    'the streamedAuthErrorPresent guard MUST run before appendText — otherwise '
      + 'the raw 401 delta paints before the check fires.',
  );
  assert.match(
    slice,
    /interceptStreamedAuthError\(\)\s*;\s*\n\s*return\s*;/,
    'on a detected auth signature the handler must interceptStreamedAuthError() '
      + 'and return (skip the append).',
  );
});

test('appendText drops streamed text once the sign-in flow owns the UI', () => {
  const fnIdx = SRC.indexOf('function appendText(text) {');
  assert.ok(fnIdx > 0, 'appendText not found');
  const slice = SRC.slice(fnIdx, fnIdx + 1100);
  assert.match(
    slice,
    /if \(_authLoginInFlight\) return;/,
    'appendText must early-return while _authLoginInFlight so late deltas from '
      + 'the failed turn cannot paint behind the sign-in bubble.',
  );
});

test('interceptStreamedAuthError wipes the partial bubble and routes to the unified flow', () => {
  const fnIdx = SRC.indexOf('function interceptStreamedAuthError()');
  assert.ok(fnIdx > 0, 'interceptStreamedAuthError not found');
  const slice = SRC.slice(fnIdx, fnIdx + 800);
  assert.match(slice, /currentBubble\.remove\(\)/, 'must remove the partial bubble');
  assert.match(slice, /textBuffer = ''/, 'must reset textBuffer so it cannot re-paint');
  assert.match(
    slice,
    /runAuthRequiredFlow\(\{[^}]*context/,
    'must hand off to runAuthRequiredFlow (the same login + replay path as onAuthRequired)',
  );
});

test('the result/turn-end case is swallowed while the sign-in flow owns the UI', () => {
  const caseIdx = SRC.indexOf("case 'result':");
  assert.ok(caseIdx > 0, "case 'result' not found");
  const slice = SRC.slice(caseIdx, caseIdx + 600);
  assert.match(
    slice,
    /if \(_authLoginInFlight\) break;/,
    'the result case must break early under _authLoginInFlight so the failed '
      + 'turn cannot paint a "stream interrupted" / error marker behind sign-in.',
  );
});

test('runAuthRequiredFlow is a hoisted named function registered with onAuthRequired', () => {
  assert.match(
    SRC,
    /async function runAuthRequiredFlow\(data\)/,
    'runAuthRequiredFlow must be a function DECLARATION (hoisted) so '
      + 'interceptStreamedAuthError — defined earlier in the file — can call it.',
  );
  assert.match(
    SRC,
    /merlin\.onAuthRequired\(runAuthRequiredFlow\)/,
    'runAuthRequiredFlow must still be registered as the onAuthRequired handler '
      + 'so the main-process auth-required event keeps working.',
  );
  // The old inline-arrow registration must be gone (one source of truth).
  assert.doesNotMatch(
    SRC,
    /merlin\.onAuthRequired\(async \(data\) =>/,
    'the inline-arrow onAuthRequired handler must be replaced by the named '
      + 'function — two copies would drift.',
  );
});
