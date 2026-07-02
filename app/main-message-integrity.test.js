// main-message-integrity.test.js — REGRESSION GUARD (2026-06-30, message-integrity sweep)
//
// Locks two message-integrity fixes:
//  1. resolveNextMessage is a single-shot resolver. It must be nulled the instant
//     it is consumed, or a stale truthy resolver makes the send-message fast path
//     a no-op that returns {success:true} while the message silently vanishes
//     (post-Escape / dying-auth-session drop). Every INVOCATION now goes through
//     settleNextMessage(value); the ONLY place that may hold a bare
//     `resolveNextMessage(...)` call is inside settleNextMessage itself.
//  2. The two voice subprocesses (ffmpeg + whisper-cli) must carry a timeout so a
//     wedged process can never hang the transcribe-audio IPC forever.
//
// Pure source-scan.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('settleNextMessage exists and nulls the resolver before invoking it', () => {
  const i = MAIN.indexOf('function settleNextMessage(');
  assert.ok(i >= 0, 'settleNextMessage helper must exist');
  const body = MAIN.slice(i, i + 220);
  // Must capture the current resolver, null the variable, THEN call it.
  assert.ok(/const fn = resolveNextMessage;\s*resolveNextMessage = null;/.test(body),
    'settleNextMessage must null resolveNextMessage BEFORE invoking the captured fn');
});

test('no bare resolveNextMessage(...) invocation exists outside the helper', () => {
  // Strip the settleNextMessage helper body, then assert there is no remaining
  // `resolveNextMessage(` CALL anywhere (assignments `resolveNextMessage =` are fine).
  const i = MAIN.indexOf('function settleNextMessage(');
  const end = MAIN.indexOf('}', i) + 1;
  const withoutHelper = MAIN.slice(0, i) + MAIN.slice(end);
  // A call looks like `resolveNextMessage(` NOT preceded by `function ` and NOT `resolveNextMessage =`.
  const callRe = /resolveNextMessage\s*\(/g;
  const matches = withoutHelper.match(callRe) || [];
  assert.strictEqual(matches.length, 0,
    `every resolveNextMessage invocation must route through settleNextMessage; found ${matches.length} bare call(s)`);
});

test('the generator still assigns resolveNextMessage exactly once (the await)', () => {
  const assigns = (MAIN.match(/resolveNextMessage\s*=\s*resolve\b/g) || []).length;
  assert.strictEqual(assigns, 1,
    'the message generator must be the single point that arms resolveNextMessage');
});

test('ffmpeg and whisper-cli spawns both carry a timeout', () => {
  // Constants declared at the top of transcribeAudioImpl.
  assert.ok(/FFMPEG_TIMEOUT_MS\s*=\s*\d+/.test(MAIN), 'FFMPEG_TIMEOUT_MS constant must exist');
  assert.ok(/WHISPER_TIMEOUT_MS\s*=\s*\d+/.test(MAIN), 'WHISPER_TIMEOUT_MS constant must exist');
  // ffmpeg spawn options must include the timeout.
  const ff = MAIN.slice(MAIN.indexOf('spawn(ffmpegPath'), MAIN.indexOf('spawn(ffmpegPath') + 160);
  assert.ok(/timeout:\s*FFMPEG_TIMEOUT_MS/.test(ff), 'ffmpeg spawn must pass timeout: FFMPEG_TIMEOUT_MS');
  assert.ok(/killSignal:\s*'SIGKILL'/.test(ff), 'ffmpeg spawn must SIGKILL on timeout');
  const w = MAIN.slice(MAIN.indexOf('spawn(whisperBin'), MAIN.indexOf('spawn(whisperBin') + 160);
  assert.ok(/timeout:\s*WHISPER_TIMEOUT_MS/.test(w), 'whisper spawn must pass timeout: WHISPER_TIMEOUT_MS');
  assert.ok(/killSignal:\s*'SIGKILL'/.test(w), 'whisper spawn must SIGKILL on timeout');
});
