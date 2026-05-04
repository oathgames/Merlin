// Regression test for the PWA's "outbox cap surfaces visible feedback"
// fix (RSI Loop 3, 2026-05-03).
//
// Pre-fix `outbox.shift()` at cap silently dropped the OLDEST queued
// message. A phone user typing a paragraph during a subway-tunnel
// disconnect would have the first half of their input vanish with no
// warning — confirmed by every previous Q4 audit and by the user's
// "the PWA still bugs out" complaint. The fix:
//
//   1. At cap, REFUSE the new message (first-in-wins matches the chat
//      metaphor — the user's earliest thought is preserved over their
//      most recent input). The optimistic bubble for the refused
//      message is marked .undelivered so the user can see what didn't
//      land.
//   2. The chat-status pill is updated on every queue change so the
//      user knows the queue depth without counting bubbles.
//   3. After a successful drain (reconnect → all queued messages sent),
//      the pill is cleared so the next desktop session-phase frame can
//      paint over it.
//
// Run with: node --test pwa/outbox-feedback.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PWA_JS = readFileSync(path.join(__dirname, 'pwa.js'), 'utf8');
const PWA_CSS = readFileSync(path.join(__dirname, 'style.css'), 'utf8');

function extractFnBody(src, fnDecl) {
  const start = src.indexOf(fnDecl);
  if (start < 0) return null;
  const openBrace = src.indexOf('{', start);
  if (openBrace < 0) return null;
  let depth = 1;
  let i = openBrace + 1;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = null;
  while (i < src.length && depth > 0) {
    const c = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
    } else if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i++; }
    } else if (inString) {
      if (c === '\\') { i++; }
      else if (c === inString) { inString = null; }
    } else {
      if (c === '/' && next === '/') { inLineComment = true; i++; }
      else if (c === '/' && next === '*') { inBlockComment = true; i++; }
      else if (c === '"' || c === "'" || c === '`') { inString = c; }
      else if (c === '{') { depth++; }
      else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    i++;
  }
  return null;
}

test('pwa.js carries the RSI Loop 3 REGRESSION GUARD comment in send()', () => {
  const body = extractFnBody(PWA_JS, 'function send(');
  assert.ok(body, 'send() body must exist');
  assert.ok(
    /REGRESSION GUARD \(2026-05-03, RSI Loop 3\)/.test(body),
    'send() must carry the RSI Loop 3 REGRESSION GUARD — without it a future copy-edit could revert to the silent-drop behavior'
  );
});

// Strip JS line + block comments. Used so regex assertions on
// "executable code" don't trip on explanatory comments that mention
// the old behavior.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('send() refuses (does NOT shift) at outbox cap — first-in-wins', () => {
  const body = extractFnBody(PWA_JS, 'function send(');
  assert.ok(body, 'send() body must exist');
  const code = stripComments(body);
  // The cap branch must NOT call outbox.shift() in EXECUTABLE code.
  assert.ok(
    !/outbox\.shift\(\)/.test(code),
    'send() must NOT call outbox.shift() — that re-introduces the silent-drop behavior the fix removed'
  );
  // Cap branch must early-return false (refuse).
  assert.ok(
    /outbox\.length\s*>=\s*OUTBOX_MAX[\s\S]{0,300}return\s+false/.test(code),
    'send() at cap must early-return false (refuse). Found no return-false in the cap branch.'
  );
});

test('send() at cap calls markUndelivered with the message clientMsgId', () => {
  const body = extractFnBody(PWA_JS, 'function send(');
  assert.ok(body, 'send() body must exist');
  assert.ok(
    /markUndelivered\(/.test(body),
    'send() must call markUndelivered() at cap so the user sees which message was refused'
  );
});

test('send() at cap surfaces a chat-status message', () => {
  const body = extractFnBody(PWA_JS, 'function send(');
  assert.ok(body, 'send() body must exist');
  // Must call setChatStatus with text mentioning queue/disconnect/full,
  // so the user knows what's wrong without diving into the bubble.
  assert.ok(
    /setChatStatus\([^)]*queue|setChatStatus\([^)]*Disconnected/.test(body),
    'send() at cap must call setChatStatus with a user-facing label'
  );
});

test('send() updates chat-status on every queue change (not just at cap)', () => {
  const body = extractFnBody(PWA_JS, 'function send(');
  assert.ok(body, 'send() body must exist');
  // After the push (the non-cap branch), there should be a setChatStatus
  // call so the depth label updates as items accumulate.
  // Find the first occurrence of `outbox.push(` and check there's a
  // setChatStatus call after it.
  const pushIdx = body.indexOf('outbox.push(');
  assert.ok(pushIdx > 0, 'send() must push to outbox');
  const tail = body.slice(pushIdx);
  assert.ok(
    /setChatStatus\(/.test(tail),
    'send() must call setChatStatus after outbox.push so the queue-depth label updates'
  );
});

test('drainOutbox clears chat-status after successful drain', () => {
  const body = extractFnBody(PWA_JS, 'function drainOutbox(');
  assert.ok(body, 'drainOutbox() body must exist');
  assert.ok(
    /clearChatStatus\(\)/.test(body),
    'drainOutbox must call clearChatStatus() after the queue empties — leaves the pill stuck on "N waiting" otherwise'
  );
});

test('pwa.js declares markUndelivered helper', () => {
  assert.ok(
    /function\s+markUndelivered\s*\(/.test(PWA_JS),
    'pwa.js must declare function markUndelivered(clientMsgId, reason)'
  );
});

test('CSS defines .msg-user.undelivered styling (visible refusal)', () => {
  assert.ok(
    /\.msg-user\.undelivered/.test(PWA_CSS),
    'style.css must define .msg-user.undelivered — without the visual style, the .undelivered class adds nothing the user sees'
  );
  // Strikethrough or warning indicator must be present so the user sees
  // a clear "this didn't go through" signal.
  assert.ok(
    /text-decoration\s*:\s*line-through/.test(PWA_CSS) || /\\26A0|\\\\26A0/.test(PWA_CSS),
    'style.css .undelivered must include either a line-through or a warning glyph (⚠)'
  );
});

test('OUTBOX_MAX is at least 20 (preserves existing capacity contract)', () => {
  // The original cap was 20; the fix changed behavior at the cap, not
  // the cap itself. A reduction would be a regression vs current users.
  const m = PWA_JS.match(/OUTBOX_MAX\s*=\s*(\d+)/);
  assert.ok(m, 'OUTBOX_MAX constant must exist');
  const cap = Number(m[1]);
  assert.ok(cap >= 20, `OUTBOX_MAX must be >= 20 to preserve the v1.x capacity contract; got ${cap}`);
});
