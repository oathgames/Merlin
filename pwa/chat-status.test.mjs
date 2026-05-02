// Source-scan regression test for the PWA's chat-status indicator.
//
// Live incident anchor: 2026-05-01 — Ryan opened the PWA on mobile, sent
// two messages, saw "Let me check actual run history…" then nothing for
// ~minute, sent "?" because he assumed the request didn't go through.
// Root cause: the PWA dropped every `session-phase` WS frame the desktop
// broadcasts (app/main.js emitSessionPhase → wsServer.broadcast). The
// renderer-side already had a chat-status pill since v1.18.x; the PWA
// just never had a `case 'session-phase'` handler in its ws.onmessage
// switch and never had a UI element to render the label in. The fix
// added:
//
//   - <div id="chat-status"> in pwa/index.html (between #chat and
//     #input-bar) with a spinner + label
//   - .chat-status / .chat-status-spinner / .chat-status-label CSS
//     in pwa/style.css with the purple-accent theme + nowrap+ellipsis
//   - setChatStatus(label) / clearChatStatus() helpers in pwa/pwa.js
//   - case 'session-phase': calling setChatStatus(payload.label)
//   - Immediate setChatStatus('Sending to Merlin…') in sendMessage()
//     so users see feedback BEFORE the desktop's first phase event
//     arrives over the WS (200-800ms on relay mode)
//   - clearChatStatus() in handleStreamEvent's content_block_start +
//     message_stop branches to hide the pill once the assistant is
//     replying
//   - clearChatStatus() in approval-request / ask-user-question /
//     sdk-error so the pill doesn't compete with mode-shift UI
//
// Browser-render verification was completed via the launch-preview
// pipeline (mobile preset + setChatStatus eval + screenshot). This test
// locks the source shape so a future copy-edit can't silently delete
// the case statement, the helpers, or the immediate-feedback wedge in
// sendMessage.
//
// Run with: node --test pwa/chat-status.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PWA_HTML = readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const PWA_JS = readFileSync(path.join(__dirname, 'pwa.js'), 'utf8');
const PWA_CSS = readFileSync(path.join(__dirname, 'style.css'), 'utf8');

test('index.html declares the #chat-status element with spinner + label', () => {
  assert.ok(
    /<div\s+id="chat-status"[^>]*class="hidden"/.test(PWA_HTML),
    'index.html must declare <div id="chat-status" class="hidden"> — initially hidden so the pill only appears once setChatStatus fires',
  );
  assert.ok(
    /class="chat-status-spinner"/.test(PWA_HTML),
    'index.html must include the .chat-status-spinner span (renders the pulsing ✦ glyph)',
  );
  assert.ok(
    /class="chat-status-label"/.test(PWA_HTML),
    'index.html must include the .chat-status-label span (where setChatStatus writes the phase text)',
  );
  // aria-live=polite is load-bearing for screen readers — without it the
  // label change is invisible to assistive tech, which is a regression
  // vs the desktop renderer's chat-status row.
  assert.ok(
    /aria-live="polite"/.test(PWA_HTML),
    'index.html #chat-status must have aria-live="polite" so screen readers announce phase changes',
  );
});

test('pwa.js handles session-phase WS frames', () => {
  assert.ok(
    /case\s+['"]session-phase['"]\s*:/.test(PWA_JS),
    'pwa.js ws.onmessage switch must handle case "session-phase" — without it, every status frame the desktop broadcasts is silently dropped (the original 2026-05-01 bug)',
  );
  // The handler must call setChatStatus with the payload label.
  // Match any fallback shape (?? || empty) — what we care about is
  // payload.label flowing into setChatStatus.
  assert.ok(
    /case\s+['"]session-phase['"][\s\S]{0,200}setChatStatus\(/.test(PWA_JS),
    'session-phase case must invoke setChatStatus(...) — bare logging would not surface the label to the user',
  );
});

test('pwa.js exposes setChatStatus and clearChatStatus helpers', () => {
  assert.ok(
    /function\s+setChatStatus\s*\(/.test(PWA_JS),
    'pwa.js must declare function setChatStatus(label) — the single render entry point for the pill',
  );
  assert.ok(
    /function\s+clearChatStatus\s*\(/.test(PWA_JS),
    'pwa.js must declare function clearChatStatus() — used by handleStreamEvent + approval/question/error handlers to hide the pill on mode shifts',
  );
});

// Top-level function-body extractor. The naive `\n}\n` end marker fails
// when the function is followed by another function or top-level
// expression with no blank line between them. Walk the source from
// fnStart, count brace depth (ignoring strings + comments minimally),
// and return the slice up to the matching closing brace. Good enough
// for the well-formatted source we control here.
function extractFnBody(src, fnDecl) {
  const start = src.indexOf(fnDecl);
  if (start < 0) return null;
  const openBrace = src.indexOf('{', start);
  if (openBrace < 0) return null;
  let depth = 1;
  let i = openBrace + 1;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = null; // null | "'" | '"' | '`'
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

test('pwa.js shows the pill IMMEDIATELY on sendMessage (before WS round-trip)', () => {
  // The fix's load-bearing UX detail: the user types, hits send, and
  // sees feedback INSTANTLY — not after a 200-800ms relay round-trip.
  const body = extractFnBody(PWA_JS, 'function sendMessage(');
  assert.ok(body, 'sendMessage function body could not be extracted');
  assert.ok(
    /setChatStatus\(/.test(body),
    'sendMessage must call setChatStatus(...) immediately so users see feedback the moment they hit send, before the desktop\'s first session-phase frame arrives',
  );
  // Also verify the call happens BEFORE send() — otherwise a slow
  // ws.send (e.g. relay reconnect race) delays the user-visible feedback.
  const setIdx = body.search(/setChatStatus\(/);
  const sendIdx = body.search(/\bsend\(\s*\{/);
  assert.ok(
    setIdx > 0 && sendIdx > 0 && setIdx < sendIdx,
    'setChatStatus(...) must run BEFORE send({...}) inside sendMessage so the pill renders even if the WS write blocks',
  );
});

test('handleStreamEvent clears the pill on first assistant text token', () => {
  // The pill must hide once the assistant is producing visible content,
  // otherwise it competes with the streaming bubble for visual attention.
  const body = extractFnBody(PWA_JS, 'function handleStreamEvent(');
  assert.ok(body, 'handleStreamEvent function body could not be extracted');
  // content_block_start of type text → clearChatStatus
  assert.ok(
    /content_block_start[\s\S]{0,400}clearChatStatus\(\)/.test(body),
    'handleStreamEvent\'s content_block_start branch must call clearChatStatus() so the pill yields to the streaming bubble',
  );
  // message_stop → clearChatStatus (belt-and-braces for tool-only turns)
  assert.ok(
    /message_stop[\s\S]{0,200}clearChatStatus\(\)/.test(body),
    'handleStreamEvent\'s message_stop branch must call clearChatStatus() — covers the rare case where a turn returns only tool output with no text content',
  );
});

test('mode-shift UI handlers (approval / question / error) clear the pill', () => {
  // When the desktop sends an approval-request / ask-user-question /
  // sdk-error, that supersedes the working state — the pill should hide
  // so the user focuses on the chip / question / error UI.
  for (const trigger of ['approval-request', 'ask-user-question', 'sdk-error']) {
    const re = new RegExp(`case\\s+['"]${trigger}['"][\\s\\S]{0,200}clearChatStatus\\(\\)`);
    assert.ok(
      re.test(PWA_JS),
      `${trigger} case must call clearChatStatus() so the pill yields to the mode-shift UI`,
    );
  }
});

test('CSS pins the pill to one row with ellipsis (long phase labels do not break layout)', () => {
  // Long labels like "Generating image with fal-ai/flux-pro/v1.1…" must
  // truncate cleanly rather than wrap and push the input bar off-screen
  // on small viewports. Browser-render verified via launch-preview;
  // this lock the CSS contract.
  const m = PWA_CSS.match(/\.chat-status-label\s*\{[^}]*\}/);
  assert.ok(m, '.chat-status-label CSS rule must exist in style.css');
  const rule = m[0];
  assert.ok(/white-space\s*:\s*nowrap/.test(rule), '.chat-status-label must set white-space:nowrap');
  assert.ok(/overflow\s*:\s*hidden/.test(rule), '.chat-status-label must set overflow:hidden');
  assert.ok(/text-overflow\s*:\s*ellipsis/.test(rule), '.chat-status-label must set text-overflow:ellipsis — the three CSS props together produce the truncation behavior');
});

test('CSS uses the existing accent-color tokens (theme parity with rest of UI)', () => {
  // Pill should match Merlin's purple-accent theme — matches the
  // user-bubble background + the connection dot + every other
  // brand-feeling element. Matches the contract that "every new UI
  // surface uses var(--accent*) tokens, never hardcoded colors".
  const m = PWA_CSS.match(/#chat-status\s*\{[^}]*\}/);
  assert.ok(m, '#chat-status CSS rule must exist');
  const rule = m[0];
  assert.ok(
    /var\(--accent/.test(rule),
    '#chat-status must use var(--accent*) tokens (matches the rest of the PWA\'s accent theme); hardcoded colors break theme parity',
  );
});
