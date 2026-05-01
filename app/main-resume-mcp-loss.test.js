// Source-scan regression test for the SDK 0.2.123 resume-MCP-loss workaround
// landed in v1.21.1.
//
// Live incident anchor: v1.21.0 bumped @anthropic-ai/claude-agent-sdk to
// 0.2.123, which has a regression in its session-resume path. Passing
// `resume:` to query() causes in-process MCP servers (registered via
// createSdkMcpServer) to silently disappear from Claude's tool list. The
// SDK's init message still reports `merlin: connected`, so cursory checks
// look healthy — but the actual tool definitions never reach the spawned
// subprocess's tool registry, and Claude reports zero mcp__merlin__* tools.
//
// Repro inside a packaged Electron-as-Node harness (the user's own install,
// not a synthetic test rig):
//
//   * Build merlinMcp via createMerlinMcpServer (47 tools registered)
//   * Run sdk.query({ mcpServers: { merlin: merlinMcp }, ...rest })
//     - Without `resume:` → init says merlin: connected AND Claude lists
//       all 16+ mcp__merlin__* tools by name when asked
//     - With    `resume:` → init still says merlin: connected, but Claude
//       answers "None — I don't see any mcp__merlin__* tools"
//
// Every paying user on v1.21.0 hit this on their second message in any
// brand because per-brand sessionId persistence in .merlin-threads.json
// triggers resume on every turn. The first message of a fresh session
// might still see the tools (because resumeSessionId is null until the
// SDK returns the new session UUID and threads.persistSessionId writes it
// back to disk).
//
// Workaround: skip the `queryOptions.resume = resumeSessionId` assignment
// in startSession's pre-query block. Trade-off: each user turn becomes a
// fresh SDK session — Claude no longer carries SDK-level conversation
// memory between turns. Per-turn context still reaches Claude through:
//   - the bubble history rendered by the renderer (visual)
//   - the system-prompt brand-active hint
//   - the auto-memory layer
//   - ~/.claude/projects/<cwd>/<sessionId>.jsonl tool-call history that
//     the SDK still references
//
// This test locks the workaround in place so a future drive-by edit can't
// re-enable resume without an explicit conscious revert (which would also
// have to remove the REGRESSION GUARD comment block this test asserts).
//
// When Anthropic ships the SDK fix, restore: replace the patched block in
// app/main.js around line 3102 with the original
//   `if (resumeSessionId) { queryOptions.resume = resumeSessionId; … }`
// and delete this test in the same PR.
//
// Run with: node app/main-resume-mcp-loss.test.js

const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;
const MAIN_JS = path.join(APP_DIR, 'main.js');

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

function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.split('\n').map((line) => {
    const idx = line.indexOf('//');
    if (idx < 0) return line;
    const before = line.slice(0, idx);
    const sq = (before.match(/'/g) || []).length;
    const dq = (before.match(/"/g) || []).length;
    const bt = (before.match(/`/g) || []).length;
    if (sq % 2 === 1 || dq % 2 === 1 || bt % 2 === 1) return line;
    return before;
  }).join('\n');
  return out;
}

if (!fs.existsSync(MAIN_JS)) { console.error('main.js missing at', MAIN_JS); process.exit(1); }
const RAW = fs.readFileSync(MAIN_JS, 'utf8');
const SRC = stripComments(RAW);

test('main.js keeps the SDK-0.2.123 resume-MCP-loss REGRESSION GUARD marker', () => {
  if (!RAW.includes('REGRESSION GUARD (2026-05-01, sdk-0.2.123-resume-mcp-loss)')) {
    throw new Error(
      'main.js lost the "REGRESSION GUARD (2026-05-01, sdk-0.2.123-resume-mcp-loss)" ' +
      'comment block. Do not delete it without simultaneously restoring the ' +
      'original `queryOptions.resume = resumeSessionId` branch — and only do that ' +
      'after Anthropic confirms the SDK fix has shipped. Restoring resume without ' +
      'the SDK fix re-introduces the P0 mcp__merlin__* tool-loss bug that bricked ' +
      'every paying user on v1.21.0.',
    );
  }
});

test('queryOptions.resume = resumeSessionId is NOT assigned anywhere in main.js', () => {
  // The whole point of the workaround. Any restoration of this assignment
  // re-enables the SDK bug. If you genuinely need resume back (because the
  // SDK is fixed), delete this test in the same PR — the test deletion is a
  // load-bearing signal that the restoration was intentional.
  if (/queryOptions\.resume\s*=\s*resumeSessionId/.test(SRC)) {
    throw new Error(
      '`queryOptions.resume = resumeSessionId` is back in main.js. This re-enables ' +
      'SDK 0.2.123\'s in-process MCP loss on resume — every Merlin tool will silently ' +
      'disappear from Claude\'s tool list on the second user turn in any brand. ' +
      'If the SDK has shipped a fix and you intend to restore resume, delete this ' +
      'test file in the same commit so the deletion is a visible signal.',
    );
  }
});

test('the patched branch still LOGS the skip so users can see it in stdout', () => {
  // The diagnostic log line is load-bearing — it tells anyone tail-ing
  // Merlin's stdout that resume is being skipped on purpose, not by accident.
  if (!/skipping resume of session/.test(SRC)) {
    throw new Error(
      'The patched resume block must still log "[threads] skipping resume of session …" ' +
      'when resumeSessionId is set, so future debugging is one grep away from seeing ' +
      'that the skip is intentional. Without this log, future investigators will not ' +
      'know whether the skip is a bug or the workaround.',
    );
  }
});

test('emitSessionPhase("query-start", …) still fires unconditionally on every turn', () => {
  // Pre-fix this was inside the else branch of `if (resumeSessionId) {…}`.
  // Post-fix it must fire unconditionally so the renderer still gets the
  // phase signal that drives the chat-status row.
  if (!/emitSessionPhase\(['"]query-start['"]/.test(SRC)) {
    throw new Error(
      'emitSessionPhase("query-start", …) is missing from main.js. The renderer ' +
      'depends on this IPC event to update the chat-status row. The post-fix code ' +
      'must call it unconditionally — this is the signal users see when their ' +
      'message was actually sent to Claude.',
    );
  }
});

test('main.js still consults resumeSessionId for the diagnostic log only', () => {
  // The skip-but-log pattern requires that resumeSessionId still be read.
  // If a future refactor deletes the variable entirely, the diagnostic log
  // becomes silent and we lose the ability to confirm the workaround is
  // active in field installs.
  if (!/if\s*\(\s*resumeSessionId\s*\)/.test(SRC)) {
    throw new Error(
      'The `if (resumeSessionId)` guard around the diagnostic log is gone. ' +
      'Without it, we lose the field-debuggable signal that the resume-skip ' +
      'workaround is active. Restore the guard or document the change in a ' +
      'replacement REGRESSION GUARD block.',
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
