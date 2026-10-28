// REGRESSION GUARD (2026-10-05, ipc-sidecar-before-auth)
//
// The MCP IPC sidecar endpoint (Claude Desktop / Codex / merlin-mcp-shim.js)
// must come up even when the in-app Claude session cannot authenticate.
// Live incident: after a local-build relaunch, the boot startSession() hit a
// transient "Not logged in", returned early through requireAuth(), and the
// sidecar block (which sat AFTER the credential gate) never ran. The shim
// kept reading a days-old mcp-shim-token pointing at a dead pipe (ENOENT)
// until the user sent an in-app message.
//
// Source-scan: inside startSession, the MCP server + sidecar start must
// precede the credential gate's requireAuth() early return, and must still
// follow the subscription gate and the concurrent-session guard.
//
// Run with: node --test app/ipc-sidecar-before-auth.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// 2026-10-05 (ipc-boot): startSession reaches the endpoint through
// ensureMcpIpcEndpoint(), which also serves the boot-time start, so the
// sidecar anchor below is that call rather than the inline require.
function startSessionBody() {
  const start = MAIN_JS.indexOf('async function startSession(');
  assert.ok(start > 0, 'startSession found');
  const end = MAIN_JS.indexOf('\nasync function ', start + 10);
  return MAIN_JS.slice(start, end > 0 ? end : undefined);
}

test('sidecar endpoint starts before the credential gate early return', () => {
  const body = startSessionBody();
  const mcpCreate = body.indexOf('await createMerlinMcpServer(');
  const ipcStart = body.indexOf('ensureMcpIpcEndpoint(merlinMcp');
  const authReturn = body.indexOf("requireAuth('session start: no credentials')");
  assert.ok(mcpCreate > 0, 'createMerlinMcpServer call found in startSession');
  assert.ok(ipcStart > 0, 'IPC endpoint start found in startSession');
  assert.ok(authReturn > 0, 'credential-gate requireAuth found in startSession');
  assert.ok(mcpCreate < authReturn, 'MCP server must be created before the credential gate');
  assert.ok(ipcStart < authReturn, 'IPC sidecar must start before the credential gate');
});

test('sidecar still sits behind the subscription gate and concurrent-session guard', () => {
  const body = startSessionBody();
  const subGate = body.indexOf('ensureSubscriptionAccess(');
  const dupGuard = body.indexOf('Session already active, skipping duplicate start');
  const ipcStart = body.indexOf('ensureMcpIpcEndpoint(merlinMcp');
  assert.ok(subGate > 0 && dupGuard > 0, 'gates found');
  assert.ok(subGate < ipcStart, 'subscription gate must still precede the sidecar');
  assert.ok(dupGuard < ipcStart, 'duplicate-session guard must still precede the sidecar');
});

test('the credential gate still runs before the SDK query is constructed', () => {
  const body = startSessionBody();
  const authReturn = body.indexOf("requireAuth('session start: no credentials')");
  const queryCall = body.search(/activeQuery\s*=\s*query\(/);
  assert.ok(queryCall > 0, 'query() assignment found');
  assert.ok(authReturn < queryCall, 'credential gate must precede query()');
});
