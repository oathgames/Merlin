// mcp-ipc-boot.test.js: REGRESSION GUARD (2026-10-05, ipc-boot)
//
// Live incident: Merlin restarted, nobody sent a chat message, and
// <stateDir>/mcp-shim-token still pointed at a named pipe owned by a process
// that no longer existed. The sidecar IPC endpoint only started on the first
// successful chat startSession, so every external tool call (Claude Desktop,
// Codex, Claude Code via the shim) failed ENOENT until a human opened the chat.
//
// Locks three things:
//   1. main.js starts the endpoint at app boot (bootMcpIpcEndpoint from
//      app.whenReady), not gated on startSession, with the approval policy and
//      subscription gate unchanged.
//   2. The endpoint rewrites the handshake on every start with a fresh token,
//      serves a tools/call with no chat session, and stop() never deletes a
//      handshake a newer endpoint wrote.
//   3. The shim re-reads a stale handshake on ENOENT / AUTH_FAILED and retries
//      exactly once.

process.env.MERLIN_SHIM_STALE_RETRY_MS = '300';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const ipc = require('./mcp-ipc-endpoint');
const shim = require('./merlin-mcp-shim');

const MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function sliceFn(src, header) {
  const i = src.indexOf(header);
  assert.ok(i >= 0, `anchor not found: ${header}`);
  // Functions in main.js close with a column-0 "}" line.
  const end = src.indexOf('\n}', i);
  assert.ok(end > i, `end of ${header} not found`);
  return src.slice(i, end + 2);
}

function tmpDir() {
  const d = path.join(os.tmpdir(), 'merlin-ipc-boot-test-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const ALLOW_ALL = async (_name, input) => ({ behavior: 'allow', updatedInput: input });

function fakeTools(calls) {
  return [{
    name: 'brand_list',
    description: 'List brands',
    inputSchema: {},
    annotations: { destructive: false, idempotent: true },
    handler: async (args) => {
      calls.push(args);
      return { content: [{ type: 'text', text: 'brands: alpha, beta' }] };
    },
  }];
}

// Resolves once the endpoint has written ITS handshake (the write happens in
// the listen callback, after the pipe accepts connections).
async function listening(ep) {
  for (let i = 0; i < 200; i++) {
    try {
      const hs = JSON.parse(fs.readFileSync(ep.tokenPath, 'utf8'));
      if (hs.token === ep.token) return;
    } catch (_) { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('endpoint never wrote its handshake');
}

function rawCall(socketPath, req) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    const t = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 3000);
    sock.setEncoding('utf8');
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (c) => {
      buf += c;
      const i = buf.indexOf('\n');
      if (i >= 0) { clearTimeout(t); sock.end(); resolve(JSON.parse(buf.slice(0, i))); }
    });
  });
}

// ── 1. main.js wiring (source scan) ─────────────────────────────────────

test('startSession never starts the endpoint itself; it calls ensureMcpIpcEndpoint', () => {
  const body = sliceFn(MAIN, 'async function startSession(brandOverride) {');
  assert.ok(!/startMcpIpc\s*\(/.test(body), 'startSession must not call startMcpIpc directly');
  assert.ok(/ensureMcpIpcEndpoint\(merlinMcp, mcpCtx, \{ refresh: true \}\)/.test(body),
    'startSession must refresh (or late-start) the endpoint via ensureMcpIpcEndpoint');
  assert.ok(/const mcpCtx = buildMcpCtx\(sdkModule\);/.test(body),
    'startSession must build its ctx through the shared buildMcpCtx');
});

test('the endpoint is booted from app.whenReady, not from a chat session', () => {
  const i = MAIN.indexOf('app.whenReady().then(');
  assert.ok(i >= 0, 'app.whenReady anchor');
  const ready = MAIN.slice(i);
  assert.ok(/\n\s+bootMcpIpcEndpoint\(\);/.test(ready), 'app.whenReady must call bootMcpIpcEndpoint()');
  // It must run after the vault migrations so the first call sees migrated creds.
  const mig = ready.indexOf('migrateUniversalKeysToGlobal();');
  const boot = ready.indexOf('bootMcpIpcEndpoint();');
  assert.ok(mig >= 0 && boot > mig, 'bootMcpIpcEndpoint must run after migrateUniversalKeysToGlobal');
});

test('bootMcpIpcEndpoint: same subscription gate, same ctx builder, single-flight, no session dependency', () => {
  const body = sliceFn(MAIN, 'function bootMcpIpcEndpoint() {');
  assert.ok(/ensureSubscriptionAccess\(\{ via: 'mcp-ipc-boot' \}\)/.test(body), 'boot must apply the subscription gate');
  assert.ok(/buildMcpCtx\(sdkModule\)/.test(body), 'boot must build ctx via buildMcpCtx');
  assert.ok(/_mcpIpcBootPromise/.test(body), 'boot must be single-flight');
  assert.ok(/refresh: false/.test(body), 'boot must never replace a registry a chat session installed');
  assert.ok(!/activeQuery|resolveNextMessage|pendingMessageQueue|sessionEnv/.test(body), 'boot must not depend on chat session state');
});

test('ensureMcpIpcEndpoint keeps the approval policy exactly: handleToolApproval on the ipc surface', () => {
  const body = sliceFn(MAIN, 'function ensureMcpIpcEndpoint(merlinMcp, mcpCtx, opts = {}) {');
  assert.ok(/approve: \(toolName, input\) =>\s*handleToolApproval\(toolName, input, \{ merlinApprovalSurface: 'ipc' \}\)/.test(body),
    'sidecar approve must stay handleToolApproval with merlinApprovalSurface ipc');
  assert.ok(/getCtx: \(\) => _lastMcpCtx/.test(body), 'live ctx must follow the latest session');
  // Exactly one startMcpIpc call site in the whole file.
  assert.strictEqual((MAIN.match(/startMcpIpc\(\{/g) || []).length, 1, 'exactly one startMcpIpc call site');
});

test('buildMcpCtx shares the live JobStore instead of leaking one per session', () => {
  const body = sliceFn(MAIN, 'function buildMcpCtx(sdkModule) {');
  assert.ok(/if \(_lastMcpCtx && _lastMcpCtx\.jobStore\) ctx\.jobStore = _lastMcpCtx\.jobStore;/.test(body));
  assert.ok(/buildStrictBrandConfig,/.test(body), 'ctx must keep buildStrictBrandConfig');
  assert.ok(/sdkModule,/.test(body), 'ctx must carry the pre-imported sdkModule');
});

// ── 2. endpoint lifecycle ───────────────────────────────────────────────

test('tools/call works on a freshly booted endpoint with no chat session', async () => {
  const d = tmpDir();
  const calls = [];
  const ep = ipc.start({ stateDir: d, tools: fakeTools(calls), getCtx: () => null, ctx: { appRoot: d }, approve: ALLOW_ALL });
  try {
    await listening(ep);
    const hs = JSON.parse(fs.readFileSync(path.join(d, 'mcp-shim-token'), 'utf8'));
    const resp = await rawCall(hs.socketPath, { id: '1', auth: hs.token, method: 'tools/call', params: { name: 'brand_list', arguments: {} } });
    assert.strictEqual(resp.ok, true, JSON.stringify(resp));
    assert.match(resp.result.content[0].text, /alpha/);
    assert.strictEqual(calls.length, 1);
  } finally { ep.stop(); fs.rmSync(d, { recursive: true, force: true }); }
});

test('restart rewrites the handshake with a fresh token; old stop() leaves the new file alone', async () => {
  const d = tmpDir();
  const tokenPath = path.join(d, 'mcp-shim-token');
  // A stale handshake from a dead process (the 2026-10-05 incident shape).
  fs.writeFileSync(tokenPath, JSON.stringify({ token: 'f'.repeat(32), socketPath: path.join(d, 'dead-pipe'), pid: 1 }));
  const ep1 = ipc.start({ stateDir: d, tools: fakeTools([]), ctx: { appRoot: d }, approve: ALLOW_ALL });
  await listening(ep1);
  const hs1 = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  assert.notStrictEqual(hs1.token, 'f'.repeat(32), 'boot must overwrite the stale handshake');
  assert.strictEqual(hs1.socketPath, ep1.socketPath);
  assert.strictEqual(hs1.pid, process.pid);

  const ep2 = ipc.start({ stateDir: d, tools: fakeTools([]), ctx: { appRoot: d }, approve: ALLOW_ALL });
  await listening(ep2);
  const hs2 = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  assert.notStrictEqual(hs2.token, hs1.token, 'every start mints a fresh token');
  assert.strictEqual(hs2.socketPath, ep2.socketPath);

  ep1.stop();
  assert.ok(fs.existsSync(tokenPath), 'a stale endpoint stop() must not delete the newer handshake');
  ep2.stop();
  assert.ok(!fs.existsSync(tokenPath), 'the owning endpoint stop() removes its handshake');
  fs.rmSync(d, { recursive: true, force: true });
});

test('removeTokenFileIfOwned: only deletes on a token match', () => {
  const d = tmpDir();
  const p = path.join(d, 'mcp-shim-token');
  fs.writeFileSync(p, JSON.stringify({ token: 'a'.repeat(32) }));
  assert.strictEqual(ipc.removeTokenFileIfOwned(p, 'b'.repeat(32)), false);
  assert.ok(fs.existsSync(p));
  assert.strictEqual(ipc.removeTokenFileIfOwned(p, 'a'.repeat(32)), true);
  assert.ok(!fs.existsSync(p));
  assert.strictEqual(ipc.removeTokenFileIfOwned(p, 'a'.repeat(32)), false, 'missing file is a no-op');
  fs.rmSync(d, { recursive: true, force: true });
});

// ── 3. shim stale-handshake retry ───────────────────────────────────────

test('shim: stale handshake (dead pipe) is re-read after the app reboots, call succeeds', async () => {
  const d = tmpDir();
  const tokenPath = path.join(d, 'mcp-shim-token');
  const dead = ipc.resolveSocketPath(d, 'dead' + crypto.randomBytes(2).toString('hex'));
  fs.writeFileSync(tokenPath, JSON.stringify({ token: 'e'.repeat(32), socketPath: dead, pid: 1 }));
  const calls = [];
  let ep = null;
  // The app comes up while the shim is between its connect attempts.
  const bootTimer = setTimeout(() => {
    ep = ipc.start({ stateDir: d, tools: fakeTools(calls), ctx: { appRoot: d }, approve: ALLOW_ALL });
  }, 700);
  const client = shim.createIpcClient(d);
  try {
    const resp = await client.send('tools/call', { name: 'brand_list', arguments: {} });
    assert.strictEqual(resp.ok, true, JSON.stringify(resp));
    assert.strictEqual(calls.length, 1, 'the tool ran exactly once');
  } finally {
    clearTimeout(bootTimer);
    client.destroy();
    if (ep) ep.stop();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('shim: AUTH_FAILED (token rotated) re-reads the handshake and retries exactly once', async () => {
  const d = tmpDir();
  const tokenPath = path.join(d, 'mcp-shim-token');
  const calls = [];
  const ep = ipc.start({ stateDir: d, tools: fakeTools(calls), ctx: { appRoot: d }, approve: ALLOW_ALL });
  await listening(ep);
  const good = fs.readFileSync(tokenPath, 'utf8');
  const hs = JSON.parse(good);
  // Client first sees a wrong token for the live pipe.
  fs.writeFileSync(tokenPath, JSON.stringify({ ...hs, token: '0'.repeat(32) }));
  const client = shim.createIpcClient(d);
  // The rewrite lands while the client waits before its retry.
  const fix = setTimeout(() => fs.writeFileSync(tokenPath, good), 100);
  try {
    const resp = await client.send('tools/call', { name: 'brand_list', arguments: {} });
    assert.strictEqual(resp.ok, true, JSON.stringify(resp));
    assert.strictEqual(calls.length, 1);
  } finally {
    clearTimeout(fix);
    client.destroy();
    ep.stop();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('shim: a persistent auth failure is retried once, then surfaced (no loop)', async () => {
  const d = tmpDir();
  const tokenPath = path.join(d, 'mcp-shim-token');
  const ep = ipc.start({ stateDir: d, tools: fakeTools([]), ctx: { appRoot: d }, approve: ALLOW_ALL });
  await listening(ep);
  const hs = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  fs.writeFileSync(tokenPath, JSON.stringify({ ...hs, token: '0'.repeat(32) }));
  const client = shim.createIpcClient(d);
  try {
    const resp = await client.send('tools/list');
    assert.strictEqual(resp.ok, false);
    assert.strictEqual(resp.error.code, 'AUTH_FAILED');
  } finally {
    client.destroy();
    ep.stop();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
