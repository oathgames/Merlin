// Source-scan regression test for the mobileHandlers.onSendMessage block in
// app/main.js. Locks the fix from the 2026-04-20 pwa-message-queue incident:
// PWA-origin messages used to silently drop when no SDK turn was awaiting
// input — the phone showed its own bubble locally but Claude never received
// the text, so no reply ever came back. Both transports (LAN ws-server.js and
// relay relay-client.js) share this handler, so every phone message went
// through the broken path.
//
// Why source-scan: main.js is a ~9k-line Electron entry point that spawns
// processes, registers IPC handlers, and opens windows on load. Unit-testing
// the handler in isolation would require either shipping a refactor that
// doesn't belong in the bug-fix PR, or stubbing so much of the Electron
// surface that the test becomes fiction. Source-scan is the same tripwire
// ws-server.test.js uses for the 127.0.0.1 bind rule — if a future edit
// reverts the queue/start-session fallback, CI fails and the committer has
// to read this file to understand why.
//
// Contract (all must hold):
//   1. main.js contains a REGRESSION GUARD (2026-04-20, pwa-message-queue)
//      block. Comment is the contract with humans; this test is with CI.
//   2. The mobileHandlers.onSendMessage body references pendingMessageQueue
//      AND calls startSession() in its else-branch — matches the desktop
//      IPC path's fallback (ipcMain.handle('send-message', ...)).
//   3. main.js appends the phone user's bubble to the brand thread via
//      threads.appendBubble so the bubble rehydrates on brand switch —
//      matches the desktop IPC path's thread log.
//
// Run with: node app/pwa-message-queue.test.js

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.log('  ✗', name);
    console.log('   ', err.message);
    failed++;
  }
}

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// Extract the mobileHandlers.onSendMessage handler body. We locate the
// object-literal `const mobileHandlers = {` and walk braces until matched
// to get the full object, then slice out the onSendMessage arrow body.
function extractMobileHandlersBlock(src) {
  const start = src.indexOf('const mobileHandlers = {');
  if (start < 0) throw new Error('mobileHandlers declaration not found in main.js');
  // Walk from the first { after the declaration.
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('mobileHandlers object literal not balanced');
}

function extractOnSendMessageBody(block) {
  // Accept (text) or (text, clientMsgId) — RSI Loop 2 (2026-05-03) added
  // the clientMsgId param for end-to-end dedup of phone-originated
  // messages. A future param addition will require widening this regex
  // again, but the contract is the FIRST arg is `text`.
  const m = block.match(/onSendMessage\s*:\s*\(\s*text\s*(?:,\s*[A-Za-z0-9_]+\s*)?\)\s*=>\s*\{/);
  if (!m) throw new Error('onSendMessage arrow not found in mobileHandlers');
  const start = m.index + m[0].length - 1; // position of the opening {
  let depth = 0;
  for (let i = start; i < block.length; i++) {
    const c = block[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return block.slice(start, i + 1); }
  }
  throw new Error('onSendMessage body not balanced');
}

console.log('\npwa-message-queue tests:');

test('main.js carries the REGRESSION GUARD (2026-04-20, pwa-message-queue) block', () => {
  if (!/REGRESSION GUARD \(2026-04-20, pwa-message-queue\)/.test(MAIN_JS)) {
    throw new Error('regression guard comment missing — if the guard is obsolete, add a note in CLAUDE.md explaining why before removing');
  }
});

test('mobileHandlers.onSendMessage queues to pendingMessageQueue when resolveNextMessage is null', () => {
  const block = extractMobileHandlersBlock(MAIN_JS);
  const body = extractOnSendMessageBody(block);
  if (!/pendingMessageQueue\.push\s*\(/.test(body)) {
    throw new Error('pendingMessageQueue.push(...) missing from onSendMessage — phone messages will drop when no SDK turn is awaiting');
  }
});

test('mobileHandlers.onSendMessage starts a session if none is running', () => {
  const block = extractMobileHandlersBlock(MAIN_JS);
  const body = extractOnSendMessageBody(block);
  if (!/if\s*\(\s*!\s*activeQuery\s*\)\s*startSession\s*\(\s*\)/.test(body)) {
    throw new Error('!activeQuery → startSession() missing from onSendMessage — queued phone messages will sit in the queue forever with no SDK to consume them');
  }
});

test('mobileHandlers.onSendMessage appends the phone user bubble to the brand thread', () => {
  const block = extractMobileHandlersBlock(MAIN_JS);
  const body = extractOnSendMessageBody(block);
  if (!/threads\.appendBubble\s*\(\s*appRoot\s*,\s*activeBrand\s*,\s*['"]user['"]\s*,\s*text\s*\)/.test(body)) {
    throw new Error('threads.appendBubble(..., \'user\', text) missing from onSendMessage — phone bubble will not rehydrate on brand switch');
  }
});

test('mobileHandlers.onSendMessage resolves resolveNextMessage when one is waiting', () => {
  const block = extractMobileHandlersBlock(MAIN_JS);
  const body = extractOnSendMessageBody(block);
  if (!/if\s*\(\s*resolveNextMessage\s*\)\s*\{[^}]*resolveNextMessage\s*\(\s*msg\s*\)/s.test(body)) {
    throw new Error('fast-path resolveNextMessage(msg) missing from onSendMessage — breaks the hot path used during an active SDK turn');
  }
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
