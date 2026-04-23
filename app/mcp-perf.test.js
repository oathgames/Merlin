// Tests for RSI §4 latency tasks (Cluster-L, group 4).
//
// Covers:
//   4.1 — main.js half of "Kill deep-clone storm" — structuredClone is
//         GONE from the sdk-message dispatch path; shallow spread is
//         used ONLY when suppression is active.
//   4.6 — MCP tool-block bytes are stable across releases:
//         * Server name pinned to literal 'merlin' (not computed).
//         * Server version pinned to a stable sentinel literal (not
//           re-read from package.json) so a release bump does not
//           invalidate Anthropic's prompt cache breakpoint on the
//           tool-definitions prefix.
//
// These are source-scan tests — main.js imports electron's `app` module
// which cannot boot under `node --test`.
//
// Run with: node --test app/mcp-perf.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const MCP_SERVER_JS = fs.readFileSync(path.join(__dirname, 'mcp-server.js'), 'utf8');

// ─── §4.1 ────────────────────────────────────────────────────────────
test('4.1 — structuredClone is NOT used in the sdk-message dispatch path', () => {
  // Anchor on the sdk-message send site, then scan a narrow window.
  const anchor = MAIN_JS.indexOf("win.webContents.send('sdk-message'");
  assert.ok(anchor > 0, 'sdk-message send site found');
  // Walk backward 40 lines to find the enclosing branch.
  const branchStart = MAIN_JS.lastIndexOf("if (win && !win.isDestroyed()) {", anchor);
  assert.ok(branchStart > 0, 'enclosing win-gate branch found');
  const region = MAIN_JS.slice(branchStart, anchor + 200);
  // Strip // line comments + /* */ block comments — the guard comment
  // legitimately mentions the old API by name.
  const codeOnly = region
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(
    !codeOnly.includes('structuredClone'),
    'structuredClone has been removed from the hot path',
  );
});

test('4.1 — _internal tag uses shallow spread, bounded to the suppression branch', () => {
  const anchor = MAIN_JS.indexOf("win.webContents.send('sdk-message'");
  const branchStart = MAIN_JS.lastIndexOf("if (win && !win.isDestroyed()) {", anchor);
  const region = MAIN_JS.slice(branchStart, anchor + 200);
  // Suppression path uses shallow spread — O(top-level keys) — instead
  // of deep clone.
  assert.ok(
    /\{\s*\.\.\.msg\s*,\s*_internal:\s*true\s*\}/.test(region),
    'shallow spread with _internal: true in suppression path',
  );
  // Common path: `outbound = msg` (no allocation, not a clone).
  assert.ok(
    /let\s+outbound\s*=\s*msg\s*;/.test(region),
    'default outbound variable aliases msg without cloning',
  );
  // Suppression flag clears on result INSIDE the suppression branch —
  // ensures we don't clear on every message, which would break the
  // multi-message-suppression case (spell notifications).
  assert.ok(
    /if\s*\(\s*_suppressNextResponse\s*\)\s*\{[\s\S]*?if\s*\(\s*msg\.type\s*===\s*'result'\s*\)\s*_suppressNextResponse\s*=\s*false\s*;[\s\S]*?\}/.test(region),
    'suppression clears only on result, only inside the suppression branch',
  );
});

test('4.1 — broadcast receives the same outbound object as webContents.send', () => {
  // Guarantees that the ws-server gate (zero-listeners short-circuit)
  // sees the exact object structure. A divergence here — sending `msg`
  // to webContents but a cloned variant to broadcast — would re-
  // introduce the allocation storm for every WS-connected session.
  const anchor = MAIN_JS.indexOf("win.webContents.send('sdk-message'");
  const branchStart = MAIN_JS.lastIndexOf("if (win && !win.isDestroyed()) {", anchor);
  const region = MAIN_JS.slice(branchStart, anchor + 400);
  assert.ok(
    /win\.webContents\.send\(\s*'sdk-message'\s*,\s*outbound\s*\)/.test(region),
    'webContents.send passes outbound',
  );
  assert.ok(
    /wsServer\.broadcast\(\s*'sdk-message'\s*,\s*outbound\s*\)/.test(region),
    'wsServer.broadcast passes outbound',
  );
});

// ─── §4.6 ────────────────────────────────────────────────────────────
test('4.6 — MCP server name is the stable literal "merlin"', () => {
  // Server name becomes `mcp__merlin__<tool>` in the tool schema sent to
  // the model. A computed name would bake runtime values into the cached
  // tool-block prefix.
  assert.ok(
    /createSdkMcpServer\(\s*\{\s*[\s\S]*?name:\s*'merlin'/.test(MCP_SERVER_JS),
    'createSdkMcpServer called with name: \'merlin\' (literal)',
  );
});

test('4.6 — MCP server version is a pinned sentinel, NOT computed from package.json', () => {
  // Reading from package.json would tie cache_control stability to the
  // release number. Every version bump would invalidate the tool-block
  // prefix and make the first turn of every session after a release
  // pay full tokenization cost.
  const fnStart = MCP_SERVER_JS.indexOf('async function createMerlinMcpServer');
  const fnEnd = MCP_SERVER_JS.indexOf('\nmodule.exports', fnStart);
  const body = MCP_SERVER_JS.slice(fnStart, fnEnd);

  // Must NOT pass require('../package.json').version into the server
  // config. A `require('../package.json')` elsewhere in the file is
  // fine (JobStore / diagnostics) — the ban is specifically on using
  // the resolved version as the server version field.
  const serverCallStart = body.indexOf('createSdkMcpServer(');
  const serverCallEnd = body.indexOf('});', serverCallStart);
  const serverArgs = body.slice(serverCallStart, serverCallEnd);
  assert.ok(
    !/version:\s*require\(['"]\.\.\/package\.json['"]\)/.test(serverArgs),
    'server version is NOT sourced from package.json',
  );

  // And there MUST be a stable sentinel constant.
  assert.ok(
    /const\s+MCP_TOOL_SCHEMA_VERSION\s*=\s*['"][\d.]+['"]\s*;/.test(body),
    'MCP_TOOL_SCHEMA_VERSION sentinel defined as a string literal',
  );
  assert.ok(
    /version:\s*MCP_TOOL_SCHEMA_VERSION/.test(serverArgs),
    'server version field references the sentinel',
  );
});

test('4.6 — tool-block bytes stay stable across hypothetical package.json bumps', () => {
  // Simulation: extract the createSdkMcpServer arg block and confirm
  // its source form contains no reference to a dynamically-resolved
  // value. Any future refactor that slips one in gets caught here.
  const callIdx = MCP_SERVER_JS.indexOf('createSdkMcpServer({');
  assert.ok(callIdx > 0);
  const end = MCP_SERVER_JS.indexOf('});', callIdx);
  const args = MCP_SERVER_JS.slice(callIdx, end);
  // Defensive: no template literals, no process.env, no Date, no
  // Math.random in the arg block — anything that resolves at runtime
  // would defeat the cache_control prefix stability.
  for (const forbidden of ['process.env', 'Date.now', 'Math.random', '${']) {
    assert.ok(
      !args.includes(forbidden),
      `tool-block args do not reference ${forbidden} (would destabilise cache)`,
    );
  }
});
