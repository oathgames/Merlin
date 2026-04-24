// REGRESSION GUARD (2026-04-24, stale-resume-graceful) — main.js's
// catch-block `isResumeFailure` classifier must match the SDK's actual
// wording for missing-session errors. v1.18.1 shipped with a regex
// keyed on the word "session" as head noun ("session not found"), but
// the SDK emits "No conversation found with session ID: <uuid>" —
// "conversation" is the head noun. That one-word mismatch defeated
// the auto-recovery and landed a paying user on the generic 3× retry
// "Merlin tried 3 times but couldn't connect" banner.
//
// This test source-scans the regex inside the `isResumeFailure =
// resumeSessionId && /…/i.test(errMsg);` expression and exercises it
// against every SDK wording we've confirmed in @anthropic-ai/claude-
// agent-sdk/cli.js (grep for "No conversation found"). If the regex
// is later narrowed, the assertions that exercise real SDK wordings
// fail — which is the intended blast-radius check.
//
// Run with: node --test app/main-stale-resume-regex.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// Extract the regex literal inside the `isResumeFailure = resumeSessionId
// && /…/i.test(errMsg)` expression.
function extractIsResumeFailureRegex() {
  // Anchor on the assignment signature, then walk forward to the first
  // regex literal. Defensive against whitespace/newlines between tokens.
  const anchor = SRC.indexOf('const isResumeFailure = resumeSessionId');
  assert.ok(anchor > 0, 'isResumeFailure declaration not found — test needs updating if renamed');
  const slice = SRC.slice(anchor, anchor + 4000);
  const m = slice.match(/&&\s*(\/(?:\\\/|[^\/\n])+\/i)\s*\.test\(errMsg\)/);
  assert.ok(m, 'could not extract regex from isResumeFailure expression');
  // Pull out the regex body + flags separately so we can new RegExp it.
  const lit = m[1];
  const body = lit.slice(1, lit.lastIndexOf('/'));
  const flags = lit.slice(lit.lastIndexOf('/') + 1);
  return new RegExp(body, flags);
}

test('regex matches "No conversation found with session ID" (v1.18.1 incident)', () => {
  const re = extractIsResumeFailureRegex();
  const msg = 'Claude Code returned an error result: No conversation found with session ID: 2f5a1d1a-90e6-48d6-bd3d-2decc60178bf';
  assert.ok(
    re.test(msg),
    'REGEX MUST match the SDK wording from the v1.18.1 incident — if it '
      + 'does not, stale resume UUIDs get retried 3x instead of cleared '
      + 'silently. This is the one string the user saw in production.',
  );
});

test('regex matches "No conversation found to continue" (SDK --continue path)', () => {
  const re = extractIsResumeFailureRegex();
  assert.ok(
    re.test('Claude Code returned an error result: No conversation found to continue'),
    'The SDK emits this wording for the --continue path (not --resume). '
      + 'Same recovery logic applies: clear thread, restart fresh.',
  );
});

test('regex still matches legacy "session not found" wording', () => {
  const re = extractIsResumeFailureRegex();
  assert.ok(re.test('session not found'));
  assert.ok(re.test('Session Not Found')); // case-insensitive
  assert.ok(re.test('the requested session does not exist'));
  assert.ok(re.test('no such session exists on disk'));
  assert.ok(re.test('cannot resume session'));
  assert.ok(re.test('invalid session id'));
});

test('regex does NOT match unrelated auth errors', () => {
  const re = extractIsResumeFailureRegex();
  // These would be false-positive if the regex were too broad — they
  // should route to the auth fail-fast path, NOT to the thread-clearing
  // recovery (which would silently wipe the brand's conversation
  // history on a transient 401).
  assert.ok(!re.test('401 Unauthorized'));
  assert.ok(!re.test('Failed to authenticate. API Error: 401'));
  assert.ok(!re.test('{"type":"authentication_error"}'));
  assert.ok(!re.test('Please run /login to authenticate'));
});

test('regex does NOT match unrelated API errors', () => {
  const re = extractIsResumeFailureRegex();
  assert.ok(!re.test('rate limit exceeded'));
  assert.ok(!re.test('ECONNREFUSED 127.0.0.1:8080'));
  assert.ok(!re.test('timeout after 30s'));
  assert.ok(!re.test('invalid_request: malformed payload'));
  assert.ok(!re.test('billing error: insufficient balance'));
  assert.ok(!re.test('HTTP 500 Internal Server Error'));
});

test('isResumeFailure gate requires resumeSessionId (not set → false)', () => {
  // Source-scan only: confirm the expression short-circuits on a
  // falsy resumeSessionId. Without this gate the regex would fire on
  // any message mentioning "no conversation found" even when we never
  // asked for a resume — a false-positive that would wipe the brand's
  // thread without reason.
  const anchor = SRC.indexOf('const isResumeFailure = resumeSessionId');
  assert.ok(anchor > 0);
  const slice = SRC.slice(anchor, anchor + 300);
  assert.match(
    slice,
    /resumeSessionId\s*\n?\s*&&\s*\//,
    'isResumeFailure MUST short-circuit on falsy resumeSessionId — the '
      + 'regex alone is too broad. Reverting to regex-only is a code-review '
      + 'blocker.',
  );
});

test('recovery path calls threads.clearThread AND re-runs startSession', () => {
  // Belt-and-suspenders: the whole POINT of catching this is to clear
  // the stale UUID. If the recovery block stops calling clearThread,
  // the next send-message will re-read the same stale ID and loop.
  const anchor = SRC.indexOf('if (isResumeFailure && activeBrand)');
  assert.ok(anchor > 0, 'isResumeFailure recovery block not found');
  const block = SRC.slice(anchor, anchor + 800);
  assert.match(
    block,
    /threads\.clearThread\(appRoot,\s*activeBrand\)/,
    'Recovery MUST clear the stored thread — otherwise the next '
      + 'startSession re-reads the same stale sessionId and hits the '
      + 'same error. This is the primary recovery action, not the retry.',
  );
  assert.match(
    block,
    /startSession\(activeBrand\)/,
    'Recovery MUST call startSession after clearing the thread — silent '
      + 'recovery is the whole UX goal. If we clear and do nothing, the '
      + 'brand is stuck with no session until the user hits the mic.',
  );
  assert.match(
    block,
    /return;\s*\/\/\s*skip the sdk-error broadcast/,
    'Recovery MUST return BEFORE the sdk-error broadcast — otherwise the '
      + 'renderer still sees the error and fires its retry loop (the '
      + 'duplicate path that creates the "Merlin tried 3 times" banner).',
  );
});

test('start-fresh-session IPC handler exists and clears thread before startSession', () => {
  const anchor = SRC.indexOf("ipcMain.handle('start-fresh-session'");
  assert.ok(
    anchor > 0,
    'start-fresh-session IPC handler missing — renderer fail-fast '
      + 'relies on this path to force a clean boot when the main.js '
      + 'catch-block recovery misses.',
  );
  const block = SRC.slice(anchor, anchor + 1500);
  const clearIdx = block.indexOf('threads.clearThread');
  const startIdx = block.indexOf('startSession()');
  assert.ok(clearIdx > 0, 'handler must call threads.clearThread');
  assert.ok(startIdx > 0, 'handler must call startSession');
  assert.ok(
    clearIdx < startIdx,
    'clearThread MUST run BEFORE startSession — reversed order would '
      + 'mean the first startSession resumes the stale UUID, fails, '
      + 'and the clearThread runs on an already-dead session.',
  );
});

test('REGRESSION GUARD (2026-04-24, stale-resume-graceful) comment exists', () => {
  // Future edit discoverability: any simplification PR must see the
  // comment block and read it before touching the regex.
  assert.match(
    SRC,
    /REGRESSION GUARD \(2026-04-24, stale-resume-graceful\)/,
    'REGRESSION GUARD comment must be present in main.js so a future '
      + 'edit does not silently revert the widened regex or the '
      + 'start-fresh-session IPC handler.',
  );
});
