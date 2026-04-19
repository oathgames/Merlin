// Tests for tts-worker.js input validation.
//
// The worker is normally forked as an Electron utility process. These
// tests import it as a plain module — the parentPort guard added in
// REGRESSION GUARD (2026-04-19) keeps the message-handler registration
// off unless parentPort exists, so requiring the module here is safe.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateSpeechText, MAX_SPEECH_TEXT_CHARS } = require('./tts-worker');

test('validateSpeechText accepts typical sentence', () => {
  const r = validateSpeechText('Hello, world.');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Hello, world.');
});

test('validateSpeechText rejects null', () => {
  const r = validateSpeechText(null);
  assert.equal(r.ok, false);
  assert.match(r.error, /No speech text/);
});

test('validateSpeechText rejects undefined', () => {
  const r = validateSpeechText(undefined);
  assert.equal(r.ok, false);
  assert.match(r.error, /No speech text/);
});

test('validateSpeechText rejects numeric input', () => {
  const r = validateSpeechText(42);
  assert.equal(r.ok, false);
  assert.match(r.error, /must be a string/);
});

test('validateSpeechText rejects boolean input', () => {
  const r = validateSpeechText(true);
  assert.equal(r.ok, false);
  assert.match(r.error, /must be a string/);
});

test('validateSpeechText rejects object input', () => {
  const r = validateSpeechText({ sentence: 'hi' });
  assert.equal(r.ok, false);
  assert.match(r.error, /must be a string/);
});

test('validateSpeechText rejects empty string', () => {
  const r = validateSpeechText('');
  assert.equal(r.ok, false);
  assert.match(r.error, /empty/);
});

test('validateSpeechText rejects whitespace-only string', () => {
  const r = validateSpeechText('   \n\t  ');
  assert.equal(r.ok, false);
  assert.match(r.error, /empty/);
});

test('validateSpeechText rejects text over the length ceiling', () => {
  const oversized = 'a'.repeat(MAX_SPEECH_TEXT_CHARS + 1);
  const r = validateSpeechText(oversized);
  assert.equal(r.ok, false);
  assert.match(r.error, /too long/);
  // Error should NOT echo the full payload back — it'd defeat the point
  // of guarding on length.
  assert.ok(!r.error.includes(oversized));
});

test('validateSpeechText accepts text exactly at the length ceiling', () => {
  const atLimit = 'a'.repeat(MAX_SPEECH_TEXT_CHARS);
  const r = validateSpeechText(atLimit);
  assert.equal(r.ok, true);
  assert.equal(r.text.length, MAX_SPEECH_TEXT_CHARS);
});

test('validateSpeechText NFC-normalizes decomposed Unicode', () => {
  // "é" composed vs "e" + combining acute. Same visible character, two
  // different code-point sequences. NFC collapses to the composed form.
  const decomposed = 'caf\u0065\u0301'; // "café" with combining mark
  const r = validateSpeechText(decomposed);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'café');
  // The normalized string should be shorter than the decomposed input.
  assert.ok(r.text.length < decomposed.length);
});
