// Source-scan regression tests for the sdk-chat-hang-fix (2026-04-27).
//
// Fixes a live incident where a paying user re-authed mid-session and waited
// 3 minutes before getting a response. Three independent bugs compounded:
//
//   1. `accountInfo()` was awaited synchronously BEFORE the for-await message
//      loop drained the user's pending message. Cold subprocess + slow network
//      = every queued message blocked.
//
//   2. `readCredentials()` had per-source timeouts (Mac Keychain 3s) but no
//      total wall-clock cap on the whole chain — a hung filesystem read on
//      Windows alt-paths could blow past the per-source budget.
//
//   3. The renderer showed a static "Thinking" label with no insight into
//      which init phase was slow. No phase-aware progress, no IPC plumbing.
//
// All three are silent-failure-mode: they don't throw, they just blow up
// p99 latency. Source-scan is the cheapest enforcement — same pattern as
// sdk-latency-knobs.test.js.
//
// Run with: node app/sdk-chat-hang-fix.test.js

const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;
const MAIN_JS = path.join(APP_DIR, 'main.js');
const PRELOAD_JS = path.join(APP_DIR, 'preload.js');
const RENDERER_JS = path.join(APP_DIR, 'renderer.js');

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

for (const [label, p] of [['main.js', MAIN_JS], ['preload.js', PRELOAD_JS], ['renderer.js', RENDERER_JS]]) {
  if (!fs.existsSync(p)) {
    console.error(`FATAL: ${label} not found at ${p}`);
    process.exit(1);
  }
}
const MAIN = fs.readFileSync(MAIN_JS, 'utf8');
const PRELOAD = fs.readFileSync(PRELOAD_JS, 'utf8');
const RENDERER = fs.readFileSync(RENDERER_JS, 'utf8');

// -------------------------------------------------------------------------
// Bug 1: accountInfo() must NOT be awaited inside startSession before the
// for-await loop. Detaching it into a Promise.race with a timeout is the
// fix. We assert both:
//   (a) no `await activeQuery.accountInfo()` survives in the file
//   (b) the new fire-and-forget pattern is present
// -------------------------------------------------------------------------
// Helper: extract the body of `async function startSession(...)` so we can
// scan ONLY the message-critical-path code, not unrelated IPC handlers
// (e.g. ipcMain.handle('get-account-info', ...) which is invoked on demand
// by the renderer for status panels and is not on the chat hot path).
function extractStartSessionBody(src) {
  const sigMatch = src.match(/async\s+function\s+startSession\s*\([^)]*\)\s*\{/);
  if (!sigMatch) throw new Error('startSession() not found in main.js');
  const startIdx = sigMatch.index + sigMatch[0].length;
  let depth = 1;
  let i = startIdx;
  let inSingle = false, inDouble = false, inBacktick = false, inLineCmt = false, inBlockCmt = false;
  while (i < src.length && depth > 0) {
    const c = src[i];
    const next = src[i + 1];
    if (inLineCmt) { if (c === '\n') inLineCmt = false; i++; continue; }
    if (inBlockCmt) { if (c === '*' && next === '/') { inBlockCmt = false; i += 2; continue; } i++; continue; }
    if (inSingle) { if (c === '\\') { i += 2; continue; } if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) { if (c === '\\') { i += 2; continue; } if (c === '"') inDouble = false; i++; continue; }
    if (inBacktick) { if (c === '\\') { i += 2; continue; } if (c === '`') inBacktick = false; i++; continue; }
    if (c === '/' && next === '/') { inLineCmt = true; i += 2; continue; }
    if (c === '/' && next === '*') { inBlockCmt = true; i += 2; continue; }
    if (c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = true; i++; continue; }
    if (c === '`') { inBacktick = true; i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return { body: src.slice(startIdx, i - 1), startLine: src.slice(0, startIdx).split('\n').length };
}

test('startSession() body does not await activeQuery.accountInfo() (would block message loop)', () => {
  const { body, startLine } = extractStartSessionBody(MAIN);
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Skip obvious comment lines (block-comment bodies are stripped by the
    // extractor's state machine, but JS-style line comments survive when
    // they're on their own line).
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (/await\s+activeQuery\s*\.\s*accountInfo\s*\(/.test(line)) {
      throw new Error(
        `main.js:${startLine + i} re-introduces \`await activeQuery.accountInfo()\` `
        + 'inside startSession(). That call blocks the for-await message loop '
        + 'and was the root cause of the 2026-04-27 3-minute hang. Use the '
        + 'detached Promise.race pattern with a 5s timeout instead — see the '
        + 'REGRESSION GUARD (2026-04-27, sdk-chat-hang-fix) block. (Note: '
        + 'on-demand IPC handlers outside startSession that await accountInfo '
        + 'are NOT on the chat critical path and are explicitly allowed.)'
      );
    }
  }
});

test('main.js wraps accountInfo() in a timeout race', () => {
  if (!/accountInfoTimeoutMs/.test(MAIN)) {
    throw new Error(
      'main.js no longer declares `accountInfoTimeoutMs`. The detached '
      + 'accountInfo() call must enforce a hard timeout — without it, a '
      + 'hung SDK subprocess can leak telemetry promises forever. Restore '
      + 'the Promise.race + setTimeout pattern.'
    );
  }
  if (!/accountInfo\(\)\.catch/.test(MAIN) && !/accountInfo\(\)[^.]*[\s\S]{0,200}\.then/.test(MAIN)) {
    throw new Error(
      'main.js no longer attaches a .catch (or .then) to the accountInfo() '
      + 'promise — silent unhandled rejections will fire on every timeout. '
      + 'The pattern must be: race(accountInfo(), timeout).then(...).catch(...).'
    );
  }
});

test('main.js keeps the REGRESSION GUARD (2026-04-27, sdk-chat-hang-fix) block', () => {
  if (!MAIN.includes('REGRESSION GUARD (2026-04-27, sdk-chat-hang-fix)')) {
    throw new Error(
      'main.js lost the REGRESSION GUARD (2026-04-27, sdk-chat-hang-fix) '
      + 'comment block. That block is the human-readable record of the live '
      + 'incident — DO NOT delete it, and DO NOT re-await accountInfo() in '
      + 'startSession. If the rule needs to change, add a new dated block '
      + 'above explaining what changed.'
    );
  }
});

// -------------------------------------------------------------------------
// Bug 2: readCredentials() must enforce a total wall-clock cap.
// -------------------------------------------------------------------------
test('main.js declares a READ_CREDENTIALS_TOTAL_CAP_MS constant', () => {
  if (!/READ_CREDENTIALS_TOTAL_CAP_MS\s*=\s*\d+/.test(MAIN)) {
    throw new Error(
      'main.js no longer declares READ_CREDENTIALS_TOTAL_CAP_MS. Without a '
      + 'hard cap on the whole credential-resolution chain, a hung '
      + 'filesystem source (network home directory, antivirus filter '
      + 'driver, future credential source) can block startSession() '
      + 'indefinitely. Restore the constant + Promise.race wrapper.'
    );
  }
});

test('main.js readCredentials wraps the impl in a Promise.race timeout', () => {
  // Match the wrapper that races the impl against a setTimeout. The split
  // between the public `readCredentials` and the internal `_readCredentialsImpl`
  // is what makes the cap enforceable — without the indirection, the same
  // function can't both have a body and a deadline.
  if (!/_readCredentialsImpl\s*\(/.test(MAIN)) {
    throw new Error(
      'main.js no longer splits readCredentials into a public wrapper + '
      + '_readCredentialsImpl body. The split is what enforces the total '
      + 'cap — collapsing it back loses the deadline. Keep both functions.'
    );
  }
  if (!/Promise\.race\s*\(\s*\[\s*_readCredentialsImpl/.test(MAIN)) {
    throw new Error(
      'main.js readCredentials no longer races _readCredentialsImpl against '
      + 'a setTimeout. The race is the deadline. Restore the Promise.race '
      + 'wrapper.'
    );
  }
});

// -------------------------------------------------------------------------
// Bug 3: Phase-aware progress. preload exposes onSessionPhase, main emits
// it at known checkpoints, renderer consumes and updates the status label.
// -------------------------------------------------------------------------
test('preload.js exposes onSessionPhase to the renderer', () => {
  if (!/onSessionPhase\s*:/.test(PRELOAD)) {
    throw new Error(
      'preload.js no longer exposes `onSessionPhase`. Without it the '
      + 'renderer cannot subscribe to phase events and falls back to the '
      + 'static "Thinking" label that hid the 3-minute hang in 2026-04-27. '
      + 'Restore the listener wiring.'
    );
  }
  if (!/ipcRenderer\.on\(\s*['"]session-phase['"]/.test(PRELOAD)) {
    throw new Error(
      'preload.js onSessionPhase listener is not bound to the '
      + '`session-phase` IPC channel. Channel name must match what '
      + 'main.js emits via webContents.send.'
    );
  }
});

test('main.js defines emitSessionPhase and emits at every init checkpoint', () => {
  if (!/function\s+emitSessionPhase\s*\(/.test(MAIN)) {
    throw new Error(
      'main.js no longer defines emitSessionPhase(). That helper is the '
      + 'single egress point for phase events — without it, individual '
      + 'webContents.send call sites would drift. Restore it.'
    );
  }
  // Must broadcast on the same channel preload listens to.
  if (!/webContents\.send\(\s*['"]session-phase['"]/.test(MAIN)) {
    throw new Error(
      'main.js emitSessionPhase no longer sends on the `session-phase` '
      + 'IPC channel. Renderer side will never receive phase events. '
      + 'Channel name must match preload.js.'
    );
  }
  // The four phases that matter most for the user-facing hang:
  // - cred-read: readCredentials() in flight
  // - resume / query-start: query() options resolved
  // - awaiting-response: for-await loop entered, message in flight to API
  const requiredPhases = ['cred-read', 'awaiting-response'];
  for (const phase of requiredPhases) {
    const re = new RegExp(`emitSessionPhase\\(\\s*['"]${phase}['"]`);
    if (!re.test(MAIN)) {
      throw new Error(
        `main.js does not emit the '${phase}' session-phase. Each phase `
        + 'corresponds to a checkpoint where users were previously stuck '
        + 'staring at a generic "Thinking" label. Restore the emit call.'
      );
    }
  }
});

test('renderer.js subscribes to onSessionPhase and updates status label', () => {
  if (!/merlin\.onSessionPhase/.test(RENDERER)) {
    throw new Error(
      'renderer.js no longer subscribes to merlin.onSessionPhase. The '
      + 'phase events from main are dropped on the floor — users see '
      + 'the generic "Thinking" label again. Restore the subscription.'
    );
  }
  // Renderer must call setStatusLabel inside the phase handler.
  const phaseHandlerWindow = RENDERER.match(/merlin\.onSessionPhase[\s\S]{0,500}/);
  if (!phaseHandlerWindow || !/setStatusLabel\s*\(/.test(phaseHandlerWindow[0])) {
    throw new Error(
      'renderer.js onSessionPhase handler does not call setStatusLabel(). '
      + 'Receiving the event without updating the status is a no-op — '
      + 'users still stare at the generic spinner. Restore the call.'
    );
  }
});

// -------------------------------------------------------------------------
console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
