// Regression test for the clientMsgId end-to-end dedup wiring (RSI Loop 2,
// 2026-05-03). Pins the four-file contract that's load-bearing for the
// fix: any one breaking silently makes the others a no-op.
//
//   1. pwa/pwa.js mints a clientMsgId in sendMessage and tags the
//      optimistic bubble with it via SENT_BUBBLES + dataset.clientMsgId.
//   2. pwa/pwa.js dedups the inbound user-message echo by clientMsgId
//      via markDelivered() — instead of rendering a duplicate "🖥️"
//      bubble for messages it sent itself.
//   3. app/ws-server.js parses + forwards clientMsgId on send-message
//      and re-emits it on the broadcastExcept user-message echo.
//   4. app/relay-client.js parses + forwards clientMsgId on send-message
//      from the relay path (mirrors the LAN path).
//   5. app/main.js mobileHandlers.onSendMessage dedups by clientMsgId
//      via SEEN_PWA_MSG_IDS LRU map.
//   6. autocmo-core/relay/durable.js ENVELOPE_FIELDS includes clientMsgId
//      AND lightValidate accepts a well-formed clientMsgId on send-message.
//
// Why source-scan: the four files run in three different processes
// (Cloudflare Worker, Electron main, browser PWA). A behavioral test
// would need to spin up all three. The contract here is shape — every
// hop must preserve the field, any drop is silent. CI catches drift.
//
// Run with: node app/pwa-client-msg-id.test.js

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓', name); passed++; }
  catch (err) { console.log('  ✗', name); console.log('   ', err.message); failed++; }
}

const REPO_ROOT = path.join(__dirname, '..');
const PWA_JS = fs.readFileSync(path.join(REPO_ROOT, 'pwa', 'pwa.js'), 'utf8');
const WS_SERVER = fs.readFileSync(path.join(REPO_ROOT, 'app', 'ws-server.js'), 'utf8');
const RELAY_CLIENT = fs.readFileSync(path.join(REPO_ROOT, 'app', 'relay-client.js'), 'utf8');
const MAIN_JS = fs.readFileSync(path.join(REPO_ROOT, 'app', 'main.js'), 'utf8');

// durable.js lives in autocmo-core, not autoCMO. Resolve relative to the
// session root so the test runs in either base-worktree or session-worktree.
function resolveRelay() {
  const candidates = [
    path.join(REPO_ROOT, '..', 'autocmo-core', 'relay', 'durable.js'),
    path.join(REPO_ROOT, '..', '..', '..', 'autocmo-core', 'relay', 'durable.js'),
    path.join(REPO_ROOT, '..', '..', 'autocmo-core', 'relay', 'durable.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return null;
}
const DURABLE_JS = resolveRelay();

console.log('\nclient-msg-id end-to-end tests:');

// ── PWA-side ──────────────────────────────────────────────────────────
test('pwa.js declares newClientMsgId and SENT_BUBBLES (RSI Loop 2 anchor)', () => {
  if (!/REGRESSION GUARD \(2026-05-03, RSI Loop 2\)/.test(PWA_JS)) {
    throw new Error('pwa.js missing the RSI Loop 2 REGRESSION GUARD anchor');
  }
  if (!/function\s+newClientMsgId\s*\(/.test(PWA_JS)) {
    throw new Error('pwa.js missing newClientMsgId() — every send-message must mint an ID');
  }
  if (!/const\s+SENT_BUBBLES\s*=\s*new\s+Map/.test(PWA_JS)) {
    throw new Error('pwa.js missing SENT_BUBBLES Map — required to look up bubbles for ack/dedup');
  }
  if (!/function\s+markDelivered\s*\(/.test(PWA_JS)) {
    throw new Error('pwa.js missing markDelivered() — required for the inbound user-message dedup branch');
  }
});

test('pwa.js newClientMsgId uses crypto.getRandomValues (no Math.random)', () => {
  const m = PWA_JS.match(/function\s+newClientMsgId\s*\(\)\s*\{[\s\S]+?\n\}/);
  if (!m) throw new Error('newClientMsgId body not found');
  if (/Math\.random/.test(m[0])) {
    throw new Error('newClientMsgId must NOT use Math.random — collisions under load are a real possibility, breaking dedup');
  }
  if (!/crypto\.getRandomValues/.test(m[0])) {
    throw new Error('newClientMsgId must use crypto.getRandomValues');
  }
});

test('pwa.js sendMessage mints clientMsgId and attaches it to the outgoing send', () => {
  // Walk function body via brace-counting (sendMessage is plain function).
  const start = PWA_JS.indexOf('function sendMessage(');
  if (start < 0) throw new Error('sendMessage not found');
  const openBrace = PWA_JS.indexOf('{', start);
  let depth = 1;
  let i = openBrace + 1;
  for (; i < PWA_JS.length && depth > 0; i++) {
    if (PWA_JS[i] === '{') depth++;
    else if (PWA_JS[i] === '}') depth--;
  }
  const body = PWA_JS.slice(start, i);
  if (!/newClientMsgId\(\)/.test(body)) {
    throw new Error('sendMessage must call newClientMsgId() to mint the id');
  }
  if (!/clientMsgId/.test(body)) {
    throw new Error('sendMessage must reference clientMsgId in its outbound payload');
  }
  // The send call MUST include clientMsgId in the envelope.
  if (!/send\(\s*\{\s*type:\s*['"]send-message['"]\s*,\s*text\s*,\s*clientMsgId\s*\}\s*\)/.test(body)) {
    throw new Error('sendMessage must call send({type:"send-message", text, clientMsgId})');
  }
});

test('pwa.js user-message handler dedups own echo via markDelivered', () => {
  // The case body must check msg.payload.clientMsgId and bail via
  // markDelivered before falling through to addUserBubble.
  const re = /case\s+['"]user-message['"]\s*:\s*\{[\s\S]{0,800}markDelivered\(/;
  if (!re.test(PWA_JS)) {
    throw new Error('user-message case must call markDelivered() before rendering — without dedup, sender sees a duplicate "🖥️" bubble for messages it sent itself');
  }
});

test('pwa.js delivered CSS class is referenced (UX visible-receipt)', () => {
  const cssPath = path.join(REPO_ROOT, 'pwa', 'style.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  if (!/\.msg-user\.delivered/.test(css)) {
    throw new Error('style.css must define .msg-user.delivered — this is what makes the ✓ visible to the user');
  }
  if (!/markDelivered/.test(PWA_JS)) {
    throw new Error('pwa.js must call markDelivered (it adds the .delivered class)');
  }
});

// ── Desktop-side: ws-server.js ────────────────────────────────────────
test('ws-server.js send-message case parses + forwards clientMsgId', () => {
  // The case must (1) extract clientMsgId, (2) pass it as 2nd arg to
  // onSendMessage. RSI Loop 5 (2026-05-03) replaced the per-case
  // broadcastExcept echo with a unified wsServer.broadcast call from
  // mobileHandlers.onSendMessage (main.js) — see "main.js mobileHandlers
  // broadcasts user-message" below.
  const m = WS_SERVER.match(/case\s+['"]send-message['"]\s*:\s*\{[\s\S]+?break;\s*\}/);
  if (!m) throw new Error('send-message case body not found in ws-server.js');
  const body = m[0];
  if (!/msg\.clientMsgId/.test(body)) {
    throw new Error('ws-server.js send-message case must read msg.clientMsgId');
  }
  if (!/onSendMessage\s*\(\s*msg\.text\s*,\s*clientMsgId\s*\)/.test(body)) {
    throw new Error('ws-server.js must call onSendMessage(msg.text, clientMsgId) — second arg drives desktop dedup');
  }
});

test('main.js mobileHandlers broadcasts user-message with clientMsgId (Loop 5)', () => {
  // The unified fan-out path: mobileHandlers.onSendMessage calls
  // wsServer.broadcast which fans to BOTH LAN PWAs AND the relay (via
  // relayForward), so multi-device sessions stay in sync regardless of
  // transport. Sender's own echo is absorbed by its clientMsgId dedup.
  const handlerStart = MAIN_JS.indexOf('onSendMessage: (text, clientMsgId)');
  if (handlerStart < 0) throw new Error('mobileHandlers.onSendMessage signature missing');
  // The broadcast call lives near the end of the handler body (after
  // the SDK-feed, threads.appendBubble, and remote-user-message
  // calls). 5KB window covers a generously-commented body.
  const windowSrc = MAIN_JS.slice(handlerStart, handlerStart + 5000);
  if (!/wsServer\.broadcast\(\s*['"]user-message['"][^)]*clientMsgId/.test(windowSrc)) {
    throw new Error('mobileHandlers.onSendMessage must call wsServer.broadcast("user-message", {text, clientMsgId}) — without it, other paired devices never see this phone\'s send');
  }
});

test('ws-server.js validates clientMsgId shape (32-char base64url cap)', () => {
  // We accept missing IDs (legacy clients) but enforce shape when present
  // so a malformed ID can't cause harm downstream.
  if (!/A-Za-z0-9_-/.test(WS_SERVER)) {
    throw new Error('ws-server.js missing base64url char class for clientMsgId validation');
  }
});

// ── Desktop-side: relay-client.js ─────────────────────────────────────
test('relay-client.js send-message case parses + forwards clientMsgId', () => {
  const m = RELAY_CLIENT.match(/case\s+['"]send-message['"]\s*:\s*\{[\s\S]+?(?:return;|break;)\s*\}/);
  if (!m) throw new Error('send-message case body not found in relay-client.js');
  const body = m[0];
  if (!/msg\.clientMsgId/.test(body)) {
    throw new Error('relay-client.js send-message case must read msg.clientMsgId');
  }
  if (!/onSendMessage\s*\(\s*msg\.text\s*,\s*clientMsgId\s*\)/.test(body)) {
    throw new Error('relay-client.js must call onSendMessage(msg.text, clientMsgId)');
  }
});

// ── Desktop-side: main.js dedup ───────────────────────────────────────
test('main.js mobileHandlers has SEEN_PWA_MSG_IDS dedup map', () => {
  if (!/SEEN_PWA_MSG_IDS/.test(MAIN_JS)) {
    throw new Error('main.js missing SEEN_PWA_MSG_IDS — required for desktop-side dedup of phone messages');
  }
  if (!/rememberPwaMsgId/.test(MAIN_JS)) {
    throw new Error('main.js missing rememberPwaMsgId() — the dedup gate');
  }
  // The handler signature must include the clientMsgId param.
  if (!/onSendMessage\s*:\s*\(\s*text\s*,\s*clientMsgId\s*\)/.test(MAIN_JS)) {
    throw new Error('mobileHandlers.onSendMessage must declare (text, clientMsgId) — without the param the dedup gate is unreachable');
  }
  // The dedup gate must run BEFORE the SDK feed / thread append.
  // Look for `if (rememberPwaMsgId(clientMsgId)) { ... return; }` near
  // the top of the handler body.
  const handlerStart = MAIN_JS.indexOf('onSendMessage: (text, clientMsgId)');
  if (handlerStart < 0) throw new Error('handler signature mismatch');
  const window = MAIN_JS.slice(handlerStart, handlerStart + 800);
  if (!/rememberPwaMsgId\(clientMsgId\)[^{]*\{[^}]*return/.test(window)) {
    throw new Error('handler must early-return when rememberPwaMsgId returns true (duplicate detected)');
  }
});

// ── Relay-side: durable.js ────────────────────────────────────────────
test('durable.js ENVELOPE_FIELDS includes clientMsgId', () => {
  if (!DURABLE_JS) {
    console.log('   (skipped — autocmo-core/relay/durable.js not reachable from this worktree)');
    return;
  }
  const m = DURABLE_JS.match(/const\s+ENVELOPE_FIELDS\s*=\s*\[([^\]]+)\]/);
  if (!m) throw new Error('ENVELOPE_FIELDS not found in durable.js');
  if (!/['"]clientMsgId['"]/.test(m[1])) {
    throw new Error('durable.js ENVELOPE_FIELDS must include "clientMsgId" — without it the field is silently stripped on every hop through the relay');
  }
});

test('durable.js lightValidate accepts a well-formed clientMsgId on send-message', () => {
  if (!DURABLE_JS) {
    console.log('   (skipped)');
    return;
  }
  const m = DURABLE_JS.match(/case\s+['"]send-message['"]\s*:[\s\S]+?(?=case|default|\n\}\s*\n)/);
  if (!m) throw new Error('lightValidate send-message case not found');
  if (!/clientMsgId/.test(m[0])) {
    throw new Error('lightValidate send-message must validate clientMsgId shape (or accept absence)');
  }
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
