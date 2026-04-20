// Tests for humanizeTranscriptionError in app/renderer.js.
//
// renderer.js is a browser script that relies on `window`/`document`, so
// we can't `require()` it. Instead we extract the helper's source via a
// regex anchor and eval it in an isolated VM context — same trick used by
// app/ws-server.test.js for source-scan regressions.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Normalize CRLF → LF so the regex works on Windows checkouts too.
const rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');

// Match `function humanizeTranscriptionError(code, detail) { ... }` —
// stop at the first `\n}\n` that closes the top-level body. The helper
// has no nested functions so this is safe.
const m = rendererSrc.match(/function humanizeTranscriptionError\(code, detail\) \{[\s\S]*?\n\}\n/);
if (!m) throw new Error('humanizeTranscriptionError not found in renderer.js — update the extraction regex');

const ctx = vm.createContext({});
vm.runInContext(m[0] + '\nglobalThis.humanizeTranscriptionError = humanizeTranscriptionError;', ctx);
const humanize = ctx.humanizeTranscriptionError;

test('empty code → coachable, no jargon', () => {
  const out = humanize('transcribe:empty', 'Recording too short (418 bytes)');
  assert.match(out, /tap the mic|try again/i);
  assert.doesNotMatch(out, /ffmpeg|ebml|whisper|exit \d/i);
  // Regression: the old copy said "hold the mic" — which doesn't match
  // Merlin's tap-to-record UX and left users holding a dead button.
  assert.doesNotMatch(out, /hold the mic/i);
});

test('corrupt code → coaches the retry without push-to-talk language', () => {
  const out = humanize('transcribe:corrupt', 'ffmpeg exit 3199971767: [in#0 @ ...] EBML header parsing failed');
  assert.match(out, /tap the mic|try again/i);
  assert.doesNotMatch(out, /ffmpeg|ebml|exit 3199971767/i);
  // Regression: same "hold the mic" mismatch — Merlin auto-stops on silence.
  assert.doesNotMatch(out, /hold the mic/i);
});

test('too-large code → suggests shorter clip', () => {
  const out = humanize('transcribe:too-large', 'Audio too large (>50MB)');
  assert.match(out, /shorter/i);
});

test('missing-tools surfaces the detail', () => {
  const out = humanize('transcribe:missing-tools', 'Voice input is unavailable — speech engine missing from install.');
  assert.match(out, /speech engine missing|reinstall/i);
});

test('generic ffmpeg / whisper → generic friendly copy', () => {
  for (const code of ['transcribe:ffmpeg', 'transcribe:whisper']) {
    const out = humanize(code, 'internal detail');
    assert.match(out, /try again/i);
    assert.doesNotMatch(out, /ffmpeg|whisper/i);
  }
});

test('legacy ffmpeg exit string (no code) still gets humanized', () => {
  const out = humanize('', 'ffmpeg exit 3199971767: [in#0 @ 00000245130add40] EBML header parsing failed');
  assert.match(out, /cut short|try again/i);
  assert.doesNotMatch(out, /ebml|3199971767/i);
});

test('legacy EBML-only string humanizes to corrupt copy', () => {
  const out = humanize('', 'EBML header parsing failed');
  assert.match(out, /tap the mic|try again|didn't process/i);
  assert.doesNotMatch(out, /hold the mic/i);
});

test('empty input → safe generic fallback', () => {
  assert.match(humanize('', ''), /try again/i);
  assert.match(humanize(null, null), /try again/i);
  assert.match(humanize(undefined, undefined), /try again/i);
});

test('never leaks raw hex addresses or exit codes', () => {
  const raw = 'ffmpeg exit 3199971767: [in#0 @ 00000245130add40] EBML header parsing failed [in#0 @ 00000245130adb00] Error opening input: Invalid data found when processing input Error opening input file C:\\Users\\RYAN\\AppData\\Local\\Temp\\merlin-stt-1776622754871-11kkni.webm';
  for (const code of ['', 'transcribe:corrupt', 'transcribe:ffmpeg']) {
    const out = humanize(code, raw);
    assert.doesNotMatch(out, /0x[0-9a-f]+|0{6,}|3199971767|AppData|Temp\\merlin-stt/i);
  }
});
