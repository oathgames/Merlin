// Unit tests for app/mcp-ipc-endpoint.js. Run with:
//   node app/mcp-ipc-endpoint.test.js
//
// Coverage targets (Hard-Won Security Rule 5 + Rule 11 spirit):
//   1. resolveSocketPath is per-OS (named pipe / unix socket)
//   2. generateAuthToken returns 32 hex chars from crypto.randomBytes
//   3. constantTimeEqual: equal strings → true, mismatched → false,
//      length mismatch → false (no leak via length-only branch)
//   4. atomicWrite: tmp + rename, mode 0o600, owner-only on POSIX
//   5. dispatchRequest rejects missing/wrong auth token (AUTH_FAILED)
//   6. dispatchRequest rejects unknown method (METHOD_NOT_FOUND)
//   7. dispatchRequest 'ping' returns pong + ts
//   8. dispatchRequest 'tools/list' returns the wrapped tools array
//      with name/description/inputSchema/annotations only — no handler
//   9. dispatchRequest 'tools/call' routes to the matching tool handler
//  10. dispatchRequest 'tools/call' on unknown tool → TOOL_NOT_FOUND
//  11. dispatchRequest auto-injects active brand from .merlin-state.json
//  12. dispatchRequest does NOT override an explicit brand
//  13. start() creates socket + token file, stop() removes both
//  14. End-to-end: connect to live socket, send tools/list, receive payload

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ipc = require('./mcp-ipc-endpoint');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      // async — handled by the harness below
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

// ── Helpers ──────────────────────────────────────────────────

function tmpDir() {
  const d = path.join(os.tmpdir(), 'merlin-mcp-ipc-test-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function rmTmp(d) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

// Build a minimal fake "wrapped tools array" matching the shape
// mcp-tools.js produces. Each tool has { name, description, inputSchema, annotations, handler }.
function fakeTools() {
  const calls = [];
  return {
    calls,
    tools: [
      {
        name: 'connection_status',
        description: 'Check connections',
        inputSchema: { brand: { _zod: true, description: 'Brand' } },
        annotations: { destructive: false, idempotent: true },
        handler: async (args) => {
          calls.push({ tool: 'connection_status', args });
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, brand: args.brand || '', meta: 1 }) }] };
        },
      },
      {
        name: 'meta_ads',
        description: 'Manage Meta ads',
        inputSchema: { action: { _zod: true }, brand: { _zod: true } },
        annotations: { destructive: true, idempotent: true, costImpact: 'spend' },
        handler: async (args) => {
          calls.push({ tool: 'meta_ads', args });
          return { content: [{ type: 'text', text: 'ran ' + (args.action || '?') + ' for ' + (args.brand || '?') }] };
        },
      },
    ],
  };
}

// ── Pure-helper tests ────────────────────────────────────────

test('resolveSocketPath returns a Windows named-pipe path on win32', () => {
  // Force-check by inspecting what happens on the actual platform.
  // We can't easily mock process.platform mid-process, so just verify
  // the path is well-formed for THIS platform.
  const stateDir = tmpDir();
  try {
    const p = ipc.resolveSocketPath(stateDir);
    if (process.platform === 'win32') {
      assert.ok(p.startsWith('\\\\.\\pipe\\merlin-mcp-'), 'expected \\\\.\\pipe\\merlin-mcp- prefix, got: ' + p);
    } else {
      assert.ok(p.endsWith('/mcp.sock'), 'expected mcp.sock suffix, got: ' + p);
      assert.ok(p.startsWith(stateDir), 'expected stateDir prefix');
    }
  } finally {
    rmTmp(stateDir);
  }
});

test('generateAuthToken returns 32 hex chars (16 random bytes)', () => {
  const t = ipc.generateAuthToken();
  assert.strictEqual(typeof t, 'string');
  assert.strictEqual(t.length, 32);
  assert.ok(/^[0-9a-f]{32}$/.test(t), 'expected 32 hex chars, got: ' + t);
  // Two calls should differ (collision probability ≈ 2^-128).
  assert.notStrictEqual(t, ipc.generateAuthToken());
});

test('constantTimeEqual: equal strings → true', () => {
  const a = 'a'.repeat(32);
  const b = 'a'.repeat(32);
  assert.strictEqual(ipc.constantTimeEqual(a, b), true);
});

test('constantTimeEqual: mismatched strings same length → false', () => {
  const a = 'a'.repeat(32);
  const b = 'b'.repeat(32);
  assert.strictEqual(ipc.constantTimeEqual(a, b), false);
});

test('constantTimeEqual: length mismatch → false (no length-leak via crash)', () => {
  assert.strictEqual(ipc.constantTimeEqual('abc', 'abcd'), false);
  assert.strictEqual(ipc.constantTimeEqual('', 'a'), false);
  assert.strictEqual(ipc.constantTimeEqual(null, 'a'), false);
  assert.strictEqual(ipc.constantTimeEqual(undefined, undefined), false);
});

test('atomicWrite: tmp + rename, mode 0o600 on POSIX', () => {
  const d = tmpDir();
  try {
    const p = path.join(d, 'token');
    ipc.atomicWrite(p, 'secret-payload', 0o600);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'secret-payload');
    if (process.platform !== 'win32') {
      const mode = fs.statSync(p).mode & 0o777;
      assert.strictEqual(mode, 0o600, 'expected 0o600 mode, got 0o' + mode.toString(8));
    }
    // No tmp leftover with the well-known prefix.
    const leftover = fs.readdirSync(d).filter((n) => n.startsWith('token.tmp-'));
    assert.strictEqual(leftover.length, 0, 'tmp leftovers: ' + leftover.join(','));
  } finally {
    rmTmp(d);
  }
});

// ── dispatchRequest tests ────────────────────────────────────

test('dispatchRequest: missing auth → AUTH_FAILED', async () => {
  const { tools } = fakeTools();
  const resp = await ipc.dispatchRequest({ id: '1', method: 'ping' }, { tools, expectedToken: 'abc', ctx: { appRoot: tmpDir() } });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'AUTH_FAILED');
});

test('dispatchRequest: wrong auth → AUTH_FAILED', async () => {
  const { tools } = fakeTools();
  const resp = await ipc.dispatchRequest({ id: '1', auth: 'wrong', method: 'ping' }, { tools, expectedToken: 'abc', ctx: { appRoot: tmpDir() } });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'AUTH_FAILED');
});

test('dispatchRequest: empty expectedToken → AUTH_FAILED (fail-closed)', async () => {
  const { tools } = fakeTools();
  const resp = await ipc.dispatchRequest({ id: '1', auth: 'anything', method: 'ping' }, { tools, expectedToken: '', ctx: { appRoot: tmpDir() } });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'AUTH_FAILED');
});

test('dispatchRequest: unknown method → METHOD_NOT_FOUND', async () => {
  const { tools } = fakeTools();
  const resp = await ipc.dispatchRequest(
    { id: '1', auth: 'abc', method: 'vault/get' },
    { tools, expectedToken: 'abc', ctx: { appRoot: tmpDir() } }
  );
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'METHOD_NOT_FOUND');
  // Hard-Won Security Rule 2 spirit: vault/get is NOT in the allowlist.
  assert.ok(!ipc.ALLOWED_METHODS.has('vault/get'));
  assert.ok(!ipc.ALLOWED_METHODS.has('config/read'));
});

test('dispatchRequest: ping → pong + timestamp', async () => {
  const { tools } = fakeTools();
  const before = Date.now();
  const resp = await ipc.dispatchRequest(
    { id: 'x', auth: 'abc', method: 'ping' },
    { tools, expectedToken: 'abc', ctx: { appRoot: tmpDir() } }
  );
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(resp.result.pong, true);
  assert.ok(resp.result.ts >= before);
});

test('dispatchRequest: tools/list returns name/description/inputSchema/annotations only — no handler', async () => {
  const { tools } = fakeTools();
  const resp = await ipc.dispatchRequest(
    { id: 'l', auth: 'abc', method: 'tools/list' },
    { tools, expectedToken: 'abc', ctx: { appRoot: tmpDir() } }
  );
  assert.strictEqual(resp.ok, true);
  assert.ok(Array.isArray(resp.result.tools));
  assert.strictEqual(resp.result.tools.length, 2);
  for (const t of resp.result.tools) {
    assert.ok(t.name);
    assert.ok(t.description);
    assert.ok(t.inputSchema);
    // Crucial: handler is NEVER serialized — that would expose closure
    // state via JSON.stringify if any handler held secrets in scope.
    assert.strictEqual(t.handler, undefined);
  }
});

test('dispatchRequest: tools/call routes to handler and returns result', async () => {
  const { tools, calls } = fakeTools();
  const resp = await ipc.dispatchRequest(
    { id: 'c', auth: 'abc', method: 'tools/call', params: { name: 'meta_ads', arguments: { action: 'insights', brand: 'pog' } } },
    { tools, expectedToken: 'abc', ctx: { appRoot: tmpDir() } }
  );
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].tool, 'meta_ads');
  assert.strictEqual(calls[0].args.brand, 'pog');
  assert.strictEqual(calls[0].args.action, 'insights');
});

test('dispatchRequest: tools/call on unknown tool → TOOL_NOT_FOUND', async () => {
  const { tools } = fakeTools();
  const resp = await ipc.dispatchRequest(
    { id: 'c', auth: 'abc', method: 'tools/call', params: { name: 'nuke_database', arguments: {} } },
    { tools, expectedToken: 'abc', ctx: { appRoot: tmpDir() } }
  );
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'TOOL_NOT_FOUND');
});

test('dispatchRequest: tools/call auto-injects active brand when missing', async () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, '.merlin-state.json'), JSON.stringify({ activeBrand: 'pog' }));
    const { tools, calls } = fakeTools();
    const resp = await ipc.dispatchRequest(
      { id: 'c', auth: 'abc', method: 'tools/call', params: { name: 'meta_ads', arguments: { action: 'insights' } } },
      { tools, expectedToken: 'abc', ctx: { appRoot: d } }
    );
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(calls[0].args.brand, 'pog', 'expected brand auto-injected');
  } finally {
    rmTmp(d);
  }
});

test('dispatchRequest: tools/call does NOT override an explicit brand', async () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, '.merlin-state.json'), JSON.stringify({ activeBrand: 'pog' }));
    const { tools, calls } = fakeTools();
    const resp = await ipc.dispatchRequest(
      { id: 'c', auth: 'abc', method: 'tools/call', params: { name: 'meta_ads', arguments: { action: 'insights', brand: 'mog' } } },
      { tools, expectedToken: 'abc', ctx: { appRoot: d } }
    );
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(calls[0].args.brand, 'mog', 'explicit brand must win over active');
  } finally {
    rmTmp(d);
  }
});

test('dispatchRequest: handler throw → INTERNAL_ERROR with message', async () => {
  const { tools } = fakeTools();
  tools.push({
    name: 'broken',
    description: '',
    inputSchema: {},
    annotations: {},
    handler: async () => { throw new Error('boom'); },
  });
  const resp = await ipc.dispatchRequest(
    { id: 'c', auth: 'abc', method: 'tools/call', params: { name: 'broken', arguments: {} } },
    { tools, expectedToken: 'abc', ctx: { appRoot: tmpDir() } }
  );
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'INTERNAL_ERROR');
  assert.ok(/boom/.test(resp.error.message));
});

test('readActiveBrand: missing file → empty string', () => {
  assert.strictEqual(ipc.readActiveBrand({ appRoot: tmpDir() }), '');
});

test('readActiveBrand: valid file → activeBrand', () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, '.merlin-state.json'), JSON.stringify({ activeBrand: 'mog' }));
    assert.strictEqual(ipc.readActiveBrand({ appRoot: d }), 'mog');
  } finally {
    rmTmp(d);
  }
});

test('makeLineReader: splits by newline, drops trailing partial', () => {
  const lines = [];
  const reader = ipc.makeLineReader((l) => lines.push(l), () => {});
  reader.feed('one\ntwo\nthree');
  reader.feed('-final\nfour\n');
  reader.end();
  assert.deepStrictEqual(lines, ['one', 'two', 'three-final', 'four']);
});

test('makeLineReader: line over MAX_LINE_BYTES → onError', () => {
  let err = null;
  const reader = ipc.makeLineReader((l) => {}, (e) => { err = e; });
  // Stream past the cap without sending a newline.
  const chunk = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 5; i++) reader.feed(chunk);
  assert.ok(err, 'expected onError to fire on overrun');
  assert.ok(/MAX_LINE_BYTES/.test(err.message));
});

test('toJsonSchema: empty input → permissive object', () => {
  const s = ipc.toJsonSchema(null);
  assert.strictEqual(s.type, 'object');
});

test('toJsonSchema: shallow shape returns object schema with properties', () => {
  // We don't import zod here — pass a fallback shape that triggers
  // the catch path in toJsonSchema (zod will fail to wrap it).
  const fake = { foo: { not_a_zod_type: true }, bar: { not_a_zod_type: true } };
  const s = ipc.toJsonSchema(fake);
  assert.strictEqual(s.type, 'object');
  assert.ok(s.properties);
});

// ── End-to-end socket test ──────────────────────────────────

test('start/stop: token + socket created, socket accepts a tools/list call, stop cleans up', async () => {
  const d = tmpDir();
  try {
    const { tools } = fakeTools();
    const ep = ipc.start({ stateDir: d, tools, ctx: { appRoot: d } });
    // Token file written.
    const tokenPath = path.join(d, 'mcp-shim-token');
    assert.ok(fs.existsSync(tokenPath));
    const { token, socketPath } = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    assert.ok(/^[0-9a-f]{32}$/.test(token));
    assert.strictEqual(socketPath, ep.socketPath);

    // Connect, send a tools/list, await the response.
    const result = await new Promise((resolve, reject) => {
      const sock = net.createConnection(ep.socketPath);
      let buf = '';
      const timeout = setTimeout(() => { sock.destroy(); reject(new Error('e2e timeout')); }, 3000);
      sock.setEncoding('utf8');
      sock.on('error', (e) => { clearTimeout(timeout); reject(e); });
      sock.on('connect', () => {
        sock.write(JSON.stringify({ id: 'e2e', auth: token, method: 'tools/list' }) + '\n');
      });
      sock.on('data', (chunk) => {
        buf += chunk;
        const idx = buf.indexOf('\n');
        if (idx >= 0) {
          clearTimeout(timeout);
          try { resolve(JSON.parse(buf.slice(0, idx))); } catch (e) { reject(e); }
          sock.end();
        }
      });
    });
    assert.strictEqual(result.ok, true);
    assert.ok(Array.isArray(result.result.tools));
    assert.strictEqual(result.result.tools.length, 2);

    ep.stop();
    // Socket file is removed on POSIX; token file is removed everywhere.
    assert.ok(!fs.existsSync(tokenPath), 'token file should be removed by stop()');
    if (process.platform !== 'win32') {
      assert.ok(!fs.existsSync(ep.socketPath), 'socket file should be removed by stop()');
    }
  } finally {
    rmTmp(d);
  }
});

// ── Run async tests sequentially ─────────────────────────────

(async () => {
  // Wait a tick for any async test promises queued by the harness.
  await new Promise((r) => setTimeout(r, 50));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
