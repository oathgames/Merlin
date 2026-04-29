// Unit tests for app/merlin-mcp-shim.js. Run with:
//   node app/merlin-mcp-shim.test.js
//
// Coverage:
//   1. resolveStateDir respects MERLIN_STATE_DIR env var
//   2. resolveStateDir returns per-OS default
//   3. resolveContentDir env var override
//   4. readEndpointHandshake: missing file → null
//   5. readEndpointHandshake: malformed JSON → null
//   6. readEndpointHandshake: missing token field → null
//   7. readEndpointHandshake: bad token format → null
//   8. readEndpointHandshake: valid → returns parsed object
//   9. readActiveBrand: missing file → ''
//  10. readActiveBrand: valid file → activeBrand
//  11. injectActiveBrand: missing brand + active set → injects
//  12. injectActiveBrand: explicit brand → preserved
//  13. injectActiveBrand: no active brand → returns args unchanged
//  14. rpcOk / rpcError envelope shape
//  15. notRunningPlaceholderTools surfaces the friendly fallback
//  16. notRunningCallResult is isError + clear text
//  17. dispatch: initialize → protocolVersion
//  18. dispatch: ping → empty result
//  19. dispatch: notifications/initialized → no response
//  20. dispatch: unknown method → method-not-found error
//  21. End-to-end via a fake socket: tools/list round-trip

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const shim = require('./merlin-mcp-shim');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { console.log('  ✓', name); passed++; },
        (err) => { console.log('  ✗', name); console.log('    ', err.stack || err.message); failed++; }
      );
    }
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.log('  ✗', name);
    console.log('    ', err.stack || err.message);
    failed++;
  }
}

function tmpDir() {
  const d = path.join(os.tmpdir(), 'merlin-mcp-shim-test-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function rmTmp(d) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

// ── State + content dir resolution ────────────────────────────

test('resolveStateDir: MERLIN_STATE_DIR env var wins', () => {
  const d = tmpDir();
  const orig = process.env.MERLIN_STATE_DIR;
  try {
    process.env.MERLIN_STATE_DIR = d;
    assert.strictEqual(shim.resolveStateDir(), d);
  } finally {
    if (orig === undefined) delete process.env.MERLIN_STATE_DIR;
    else process.env.MERLIN_STATE_DIR = orig;
    rmTmp(d);
  }
});

test('resolveStateDir: per-OS default contains "Merlin"', () => {
  const orig = process.env.MERLIN_STATE_DIR;
  try {
    delete process.env.MERLIN_STATE_DIR;
    const d = shim.resolveStateDir();
    assert.ok(d.includes('Merlin'), 'expected Merlin in path: ' + d);
  } finally {
    if (orig !== undefined) process.env.MERLIN_STATE_DIR = orig;
  }
});

test('resolveContentDir: MERLIN_CONTENT_DIR env var wins', () => {
  const d = tmpDir();
  const orig = process.env.MERLIN_CONTENT_DIR;
  try {
    process.env.MERLIN_CONTENT_DIR = d;
    assert.strictEqual(shim.resolveContentDir(), d);
  } finally {
    if (orig === undefined) delete process.env.MERLIN_CONTENT_DIR;
    else process.env.MERLIN_CONTENT_DIR = orig;
    rmTmp(d);
  }
});

// ── Handshake reading ─────────────────────────────────────────

test('readEndpointHandshake: missing file → null', () => {
  const d = tmpDir();
  try {
    assert.strictEqual(shim.readEndpointHandshake(d), null);
  } finally { rmTmp(d); }
});

test('readEndpointHandshake: malformed JSON → null', () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, 'mcp-shim-token'), '{not-json');
    assert.strictEqual(shim.readEndpointHandshake(d), null);
  } finally { rmTmp(d); }
});

test('readEndpointHandshake: missing token field → null', () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, 'mcp-shim-token'), JSON.stringify({ socketPath: '/tmp/foo.sock' }));
    assert.strictEqual(shim.readEndpointHandshake(d), null);
  } finally { rmTmp(d); }
});

test('readEndpointHandshake: bad token format (not 32 hex) → null', () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, 'mcp-shim-token'), JSON.stringify({ token: 'tooshort', socketPath: '/tmp/foo.sock' }));
    assert.strictEqual(shim.readEndpointHandshake(d), null);
  } finally { rmTmp(d); }
});

test('readEndpointHandshake: valid → returns parsed object', () => {
  const d = tmpDir();
  try {
    const token = 'a'.repeat(32);
    fs.writeFileSync(path.join(d, 'mcp-shim-token'), JSON.stringify({ token, socketPath: '/tmp/foo.sock', pid: 4242 }));
    const out = shim.readEndpointHandshake(d);
    assert.ok(out);
    assert.strictEqual(out.token, token);
    assert.strictEqual(out.socketPath, '/tmp/foo.sock');
    assert.strictEqual(out.pid, 4242);
  } finally { rmTmp(d); }
});

// ── Active brand reading + injection ─────────────────────────

test('readActiveBrand: missing file → empty string', () => {
  assert.strictEqual(shim.readActiveBrand(tmpDir()), '');
});

test('readActiveBrand: valid file → activeBrand', () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, '.merlin-state.json'), JSON.stringify({ activeBrand: 'pog', other: 'x' }));
    assert.strictEqual(shim.readActiveBrand(d), 'pog');
  } finally { rmTmp(d); }
});

test('injectActiveBrand: missing brand + active set → injects', () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, '.merlin-state.json'), JSON.stringify({ activeBrand: 'pog' }));
    const out = shim.injectActiveBrand({ action: 'insights' }, d);
    assert.deepStrictEqual(out, { action: 'insights', brand: 'pog' });
  } finally { rmTmp(d); }
});

test('injectActiveBrand: explicit brand → preserved', () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, '.merlin-state.json'), JSON.stringify({ activeBrand: 'pog' }));
    const out = shim.injectActiveBrand({ action: 'insights', brand: 'mog' }, d);
    assert.strictEqual(out.brand, 'mog', 'explicit brand must win');
  } finally { rmTmp(d); }
});

test('injectActiveBrand: no active brand → returns args unchanged (no brand key added)', () => {
  const d = tmpDir();
  try {
    const out = shim.injectActiveBrand({ action: 'insights' }, d);
    assert.deepStrictEqual(out, { action: 'insights' });
    assert.ok(!Object.prototype.hasOwnProperty.call(out, 'brand'));
  } finally { rmTmp(d); }
});

// ── RPC envelope shape ────────────────────────────────────────

test('rpcOk: returns JSON-RPC 2.0 success envelope', () => {
  const r = shim.rpcOk(7, { foo: 'bar' });
  assert.deepStrictEqual(r, { jsonrpc: '2.0', id: 7, result: { foo: 'bar' } });
});

test('rpcError: returns JSON-RPC 2.0 error envelope', () => {
  const r = shim.rpcError(7, -32601, 'method not found');
  assert.strictEqual(r.jsonrpc, '2.0');
  assert.strictEqual(r.id, 7);
  assert.strictEqual(r.error.code, -32601);
  assert.strictEqual(r.error.message, 'method not found');
});

test('notRunningPlaceholderTools: returns single placeholder tool', () => {
  const tools = shim.notRunningPlaceholderTools();
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].name, 'merlin_app_not_running');
  assert.ok(/desktop app/i.test(tools[0].description));
});

test('notRunningCallResult: isError + clear text', () => {
  const r = shim.notRunningCallResult();
  assert.strictEqual(r.isError, true);
  assert.strictEqual(r.content[0].type, 'text');
  assert.ok(/Open Merlin/i.test(r.content[0].text));
});

// ── dispatch() ────────────────────────────────────────────────

test('dispatch: initialize → protocolVersion + tools capability', async () => {
  const fakeIpc = { send: async () => { throw new Error('no-op'); } };
  const r = await shim.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, fakeIpc, tmpDir());
  assert.strictEqual(r.jsonrpc, '2.0');
  assert.strictEqual(r.id, 1);
  assert.strictEqual(r.result.protocolVersion, shim.PROTOCOL_VERSION);
  assert.ok(r.result.capabilities.tools);
  assert.strictEqual(r.result.serverInfo.name, 'merlin');
});

test('dispatch: ping → empty result', async () => {
  const fakeIpc = { send: async () => { throw new Error('no-op'); } };
  const r = await shim.dispatch({ jsonrpc: '2.0', id: 2, method: 'ping' }, fakeIpc, tmpDir());
  assert.strictEqual(r.id, 2);
  assert.deepStrictEqual(r.result, {});
});

test('dispatch: notifications/initialized → no response', async () => {
  const fakeIpc = { send: async () => { throw new Error('no-op'); } };
  const r = await shim.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, fakeIpc, tmpDir());
  assert.strictEqual(r, null);
});

test('dispatch: unknown method → JSON-RPC method-not-found', async () => {
  const fakeIpc = { send: async () => { throw new Error('no-op'); } };
  const r = await shim.dispatch({ jsonrpc: '2.0', id: 3, method: 'nuke_my_vault' }, fakeIpc, tmpDir());
  assert.ok(r.error);
  assert.strictEqual(r.error.code, -32601);
});

test('dispatch: tools/list — desktop app down → returns placeholder tool', async () => {
  const fakeIpc = { send: async () => { throw new Error('connect failed'); } };
  const r = await shim.dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, fakeIpc, tmpDir());
  assert.ok(r.result.tools);
  assert.strictEqual(r.result.tools.length, 1);
  assert.strictEqual(r.result.tools[0].name, 'merlin_app_not_running');
});

test('dispatch: tools/list — desktop app up → forwards tool list', async () => {
  const fakeTools = [
    { name: 'connection_status', description: 'check', inputSchema: { type: 'object' }, annotations: {} },
    { name: 'meta_ads', description: 'ads', inputSchema: { type: 'object' }, annotations: {} },
  ];
  const fakeIpc = {
    send: async (method) => {
      if (method === 'tools/list') return { ok: true, result: { tools: fakeTools } };
      return { ok: false, error: { code: 'METHOD_NOT_FOUND', message: 'x' } };
    },
  };
  const r = await shim.dispatch({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, fakeIpc, tmpDir());
  assert.strictEqual(r.result.tools.length, 2);
  assert.strictEqual(r.result.tools[0].name, 'connection_status');
});

test('dispatch: tools/call placeholder → returns notRunningCallResult', async () => {
  const fakeIpc = { send: async () => { throw new Error('should not be called'); } };
  const r = await shim.dispatch({
    jsonrpc: '2.0', id: 6,
    method: 'tools/call',
    params: { name: 'merlin_app_not_running', arguments: {} },
  }, fakeIpc, tmpDir());
  assert.strictEqual(r.result.isError, true);
});

test('dispatch: tools/call forwards args to IPC and returns result unchanged', async () => {
  let captured = null;
  const fakeIpc = {
    send: async (method, params) => {
      captured = { method, params };
      return { ok: true, result: { content: [{ type: 'text', text: 'hi' }] } };
    },
  };
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, '.merlin-state.json'), JSON.stringify({ activeBrand: 'pog' }));
    const r = await shim.dispatch({
      jsonrpc: '2.0', id: 7,
      method: 'tools/call',
      params: { name: 'meta_ads', arguments: { action: 'insights' } },
    }, fakeIpc, d);
    assert.strictEqual(r.result.content[0].text, 'hi');
    assert.strictEqual(captured.method, 'tools/call');
    assert.strictEqual(captured.params.name, 'meta_ads');
    // Brand was injected by the shim before forwarding.
    assert.strictEqual(captured.params.arguments.brand, 'pog');
  } finally { rmTmp(d); }
});

test('dispatch: tools/call IPC failure → friendly text + isError', async () => {
  const fakeIpc = { send: async () => { throw new Error('socket reset'); } };
  const r = await shim.dispatch({
    jsonrpc: '2.0', id: 8,
    method: 'tools/call',
    params: { name: 'meta_ads', arguments: {} },
  }, fakeIpc, tmpDir());
  assert.strictEqual(r.result.isError, true);
  assert.ok(/socket reset/.test(r.result.content[0].text));
});

test('dispatch: tools/call missing params.name → JSON-RPC error', async () => {
  const fakeIpc = { send: async () => { throw new Error('x'); } };
  const r = await shim.dispatch({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: {} }, fakeIpc, tmpDir());
  assert.ok(r.error);
  assert.strictEqual(r.error.code, -32602);
});

// ── End-to-end via a real local socket ────────────────────────

test('createIpcClient: connects to a fake server, exchanges a message round-trip', async () => {
  const d = tmpDir();
  try {
    const token = 'b'.repeat(32);
    let socketPath;
    if (process.platform === 'win32') {
      socketPath = `\\\\.\\pipe\\merlin-mcp-shim-test-${crypto.randomBytes(4).toString('hex')}`;
    } else {
      socketPath = path.join(d, 'mcp.sock');
    }

    // Stand up a tiny line-delimited JSON echo server.
    const server = net.createServer((sock) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => {
        buf += chunk;
        const idx = buf.indexOf('\n');
        if (idx >= 0) {
          const req = JSON.parse(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
          // Reply with ok/echo.
          sock.write(JSON.stringify({ id: req.id, ok: true, result: { echoed: req.method, auth: req.auth } }) + '\n');
        }
      });
    });
    await new Promise((r) => server.listen(socketPath, r));

    fs.writeFileSync(path.join(d, 'mcp-shim-token'), JSON.stringify({ token, socketPath, pid: process.pid }));

    const client = shim.createIpcClient(d);
    const resp = await client.send('tools/list', {});
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(resp.result.echoed, 'tools/list');
    assert.strictEqual(resp.result.auth, token);

    client.destroy();
    server.close();
  } finally { rmTmp(d); }
});

// ── Run async tests sequentially ─────────────────────────────

(async () => {
  await new Promise((r) => setTimeout(r, 50));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
