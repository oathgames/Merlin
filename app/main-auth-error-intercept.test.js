// REGRESSION GUARD (2026-04-24, auth-error-graceful) — the SDK
// auth-error interceptor must swallow the synthetic assistant payload
// BEFORE it hits the `sdk-message` fan-out.
//
// Incident: v1.18.0 shipped with no interceptor. When the Claude
// Agent SDK hit a 401 mid-session, it yielded a synthetic assistant
// message with `isApiErrorMessage: true, error: "authentication_failed"`
// whose content carried the verbatim Anthropic API JSON payload
// (`{"type":"error","error":{"type":"authentication_error",...}`).
// That text streamed through the renderer's normal text pipeline and
// landed — raw — in a chat bubble, followed by "Merlin tried 3 times"
// when the retry loop exhausted. User quote 2026-04-23:
// "this cannot happen, we need to fail and clear gracefully."
//
// The fix lives in two places — isSdkAuthErrorMessage() and the
// interception block at the fan-out site. This test locks both down
// by source-scanning main.js. We do NOT exercise the async loop
// directly because the SDK import chain requires Electron, which
// doesn't load in `node --test`. Source-scan + behavioural unit test
// of the pure classifier covers the contract without booting Electron.
//
// Run with: node --test app/main-auth-error-intercept.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_PATH = path.join(__dirname, 'main.js');
const SRC = fs.readFileSync(MAIN_PATH, 'utf8');

test('main.js defines isSdkAuthErrorMessage helper at module scope', () => {
  assert.match(
    SRC,
    /^function\s+isSdkAuthErrorMessage\s*\(/m,
    'isSdkAuthErrorMessage must be defined at top level so the fan-out '
      + 'site can call it without a closure hop. See REGRESSION GUARD '
      + '(2026-04-24, auth-error-graceful) in app/main.js.',
  );
});

test('main.js defines authErrorFingerprint helper at module scope', () => {
  assert.match(
    SRC,
    /^function\s+authErrorFingerprint\s*\(/m,
    'authErrorFingerprint must be defined at top level. It is the narrow, '
      + 'side-effect-free classifier used by BOTH the stream interceptor '
      + 'AND the catch-block auth check.',
  );
});

test('interception block sits in the for-await loop BEFORE the sdk-message send', () => {
  // The order matters: if the interceptor is after
  // `win.webContents.send('sdk-message', outbound)` the renderer has
  // already rendered the raw JSON by the time we swallow it.
  // Anchor on the interceptor CALL SITE, not the function definition.
  // The definition contains `isSdkAuthErrorMessage(msg) {` too, so a
  // loose indexOf would match the wrong occurrence.
  const interceptMarker = '!_authFailureIntercepted && isSdkAuthErrorMessage(msg)';
  const sendMarker = "win.webContents.send('sdk-message'";
  const interceptIdx = SRC.indexOf(interceptMarker);
  const sendIdx = SRC.indexOf(sendMarker);
  assert.ok(interceptIdx > 0, `expected interceptor call (\`${interceptMarker}\`) in main.js`);
  assert.ok(sendIdx > 0, `expected fan-out call (\`${sendMarker}\`) in main.js`);
  assert.ok(
    interceptIdx < sendIdx,
    'The isSdkAuthErrorMessage interceptor MUST precede the sdk-message '
      + 'send in source order — otherwise the raw auth-error payload '
      + 'reaches the renderer BEFORE we swallow it. See REGRESSION GUARD '
      + '(2026-04-24, auth-error-graceful).',
  );
});

test('interceptor calls requireAuth AND sets _queueFrozenForAuth', () => {
  // Extract the interceptor block: from the CALL SITE (not the function
  // definition) to the closing `}` of its `if`. We look at an 800-char
  // window after the call — plenty for the current block.
  const markerIdx = SRC.indexOf('!_authFailureIntercepted && isSdkAuthErrorMessage(msg)');
  assert.ok(markerIdx > 0, 'interceptor call site not found');
  const block = SRC.slice(markerIdx, markerIdx + 800);

  assert.match(
    block,
    /_queueFrozenForAuth\s*=\s*true/,
    'Interceptor must set _queueFrozenForAuth=true so the pending user '
      + 'message replays after sign-in completes. Without this, the user '
      + 'loses their original prompt and has to re-type it.',
  );
  assert.match(
    block,
    /requireAuth\(/,
    'Interceptor must call requireAuth() — that is what surfaces the '
      + 'sign-in UI. Dropping this call = silent failure.',
  );
  assert.match(
    block,
    /_authFailureIntercepted\s*=\s*true/,
    'Interceptor must set _authFailureIntercepted=true so trailing '
      + 'result/error_during_execution messages in the same iteration '
      + 'are also swallowed — otherwise a "session ended" bubble '
      + 'shows up on top of the sign-in UI.',
  );
});

test('catch-block auth check honors the interceptor sentinel to avoid duplicate requireAuth', () => {
  // After the interceptor fires once, the SDK's for-await may still
  // throw (session teardown). The catch block must detect that auth
  // was already handled and NOT fire requireAuth a second time.
  assert.match(
    SRC,
    /_authFailureIntercepted\s*\n?\s*\|\|\s*isClaudeAuthError/,
    'Catch-block isAuth detection must short-circuit on '
      + '_authFailureIntercepted so requireAuth is not fired twice for '
      + 'the same failure.',
  );
  // (v1.31.4) the v1.31.3 silent-retry branch was reverted, so requireAuth is
  // called immediately inside the !_authFailureIntercepted guard again.
  assert.match(
    SRC,
    /if\s*\(!_authFailureIntercepted\)\s*\{\s*requireAuth/,
    'Catch block must guard the requireAuth call with '
      + '!_authFailureIntercepted to prevent duplicate fires.',
  );
});

// ── Pure classifier behaviour ──────────────────────────────────────
//
// We can't `require('./main.js')` without Electron, but we CAN extract
// both helper bodies via regex and re-evaluate them in isolation to
// unit-test the classification contract directly. This pattern is used
// elsewhere in the test suite (see ws-server.test.js) and catches
// logic bugs that a pure source-scan would miss.

function extractFn(src, name) {
  const re = new RegExp(`^function\\s+${name}\\s*\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name}() not found`);
  // Balance braces starting from the function's opening `{`.
  let i = src.indexOf('{', m.index);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error(`function ${name}() body unbalanced`);
}

const authErrorFingerprintSrc = extractFn(SRC, 'authErrorFingerprint');
const isSdkAuthErrorMessageSrc = extractFn(SRC, 'isSdkAuthErrorMessage');
// eslint-disable-next-line no-new-func
const authErrorFingerprint = new Function(
  `${authErrorFingerprintSrc}\nreturn authErrorFingerprint;`,
)();
// eslint-disable-next-line no-new-func
const isSdkAuthErrorMessage = new Function(
  `${authErrorFingerprintSrc}\n${isSdkAuthErrorMessageSrc}\nreturn isSdkAuthErrorMessage;`,
)();

test('authErrorFingerprint matches the SDK auth-failure strings', () => {
  assert.equal(authErrorFingerprint('Failed to authenticate. API Error: 401 {...}'), true);
  assert.equal(authErrorFingerprint('{"type":"authentication_error","message":"OAuth token expired"}'), true);
  assert.equal(authErrorFingerprint('Please run /login to continue.'), true);
  assert.equal(authErrorFingerprint('OAuth token has been revoked'), true);
  assert.equal(authErrorFingerprint('OAuth token expired'), true);
});

test('authErrorFingerprint does NOT match non-auth failures', () => {
  // Rate limit, billing, permission, generic network — all MUST still
  // stream normally so friendlyError classifies them. Widening this
  // regex to eat non-auth errors would trap users in sign-in loops on
  // every transient hiccup.
  assert.equal(authErrorFingerprint('rate limit exceeded'), false);
  assert.equal(authErrorFingerprint('exhausted balance'), false);
  assert.equal(authErrorFingerprint('403 forbidden'), false);
  assert.equal(authErrorFingerprint('ECONNREFUSED'), false);
  assert.equal(authErrorFingerprint('Your credit balance is too low'), false);
  assert.equal(authErrorFingerprint('invalid_request'), false);
  assert.equal(authErrorFingerprint(''), false);
  assert.equal(authErrorFingerprint(null), false);
  assert.equal(authErrorFingerprint(undefined), false);
});

test('isSdkAuthErrorMessage classifies the canonical SDK wrapper (error field)', () => {
  const msg = {
    type: 'assistant',
    error: 'authentication_failed',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401' }],
    },
  };
  assert.equal(isSdkAuthErrorMessage(msg), true);
});

test('isSdkAuthErrorMessage classifies by text content when only isApiErrorMessage is set', () => {
  const msg = {
    type: 'assistant',
    isApiErrorMessage: true,
    // No `error` field — simulates a future SDK version
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Failed to authenticate. ANTHROPIC_API_KEY: ...' }],
    },
  };
  assert.equal(isSdkAuthErrorMessage(msg), true);
});

test('isSdkAuthErrorMessage does NOT match billing-error assistant messages', () => {
  // Billing errors ALSO travel as `isApiErrorMessage: true, error:
  // "billing_error"`. They have a different recovery path (add credits)
  // and must NOT be rerouted to sign-in.
  const msg = {
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'billing_error',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Your credit balance is too low' }],
    },
  };
  assert.equal(isSdkAuthErrorMessage(msg), false);
});

test('isSdkAuthErrorMessage does NOT match invalid_request assistant messages', () => {
  const msg = {
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'invalid_request',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'organization has been disabled' }],
    },
  };
  assert.equal(isSdkAuthErrorMessage(msg), false);
});

test('isSdkAuthErrorMessage classifies stream_event text_delta fallback', () => {
  // Defence in depth: if a future SDK version streams the auth error
  // as text chunks (content_block_delta) instead of bundling it in a
  // one-shot assistant wrapper, the interceptor still catches it.
  const msg = {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Failed to authenticate. API Error: 401' },
    },
  };
  assert.equal(isSdkAuthErrorMessage(msg), true);
});

test('isSdkAuthErrorMessage does NOT match normal assistant text', () => {
  const msg = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Here is your ad copy...' }],
    },
  };
  assert.equal(isSdkAuthErrorMessage(msg), false);
});

test('isSdkAuthErrorMessage does NOT match normal stream text_delta', () => {
  const msg = {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Sure — let me draft that email for you.' },
    },
  };
  assert.equal(isSdkAuthErrorMessage(msg), false);
});

test('isSdkAuthErrorMessage is robust to malformed inputs', () => {
  assert.equal(isSdkAuthErrorMessage(null), false);
  assert.equal(isSdkAuthErrorMessage(undefined), false);
  assert.equal(isSdkAuthErrorMessage('a string'), false);
  assert.equal(isSdkAuthErrorMessage(42), false);
  assert.equal(isSdkAuthErrorMessage({}), false);
  assert.equal(isSdkAuthErrorMessage({ type: 'assistant' }), false);
  assert.equal(isSdkAuthErrorMessage({ type: 'assistant', message: null }), false);
  assert.equal(isSdkAuthErrorMessage({ type: 'assistant', isApiErrorMessage: true }), false);
  assert.equal(isSdkAuthErrorMessage({ type: 'assistant', isApiErrorMessage: true, message: { content: [] } }), false);
});
