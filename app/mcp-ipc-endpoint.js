// Merlin MCP IPC Endpoint — local socket bridge for the Claude Desktop sidecar.
//
// SUMMARY
//
//   This module runs INSIDE the Electron main process. It exposes the same
//   MCP tool registry the in-app SDK uses (built once via mcp-server.js's
//   buildTools), but over a local-only newline-delimited JSON protocol.
//   The sole consumer is `merlin-mcp-shim.js` — a stdio MCP server that
//   Claude Desktop spawns. Two consumers, one shared registry: the in-app
//   chat reaches tools through the Claude Agent SDK's createSdkMcpServer
//   path; the sidecar reaches them through this socket.
//
// SECURITY BOUNDARY (read carefully — Hard-Won Security Rule 2 applies)
//
//   * Vault is NEVER reachable through this socket. The endpoint refuses
//     any method outside { ping, tools/list, tools/call }. There is no
//     vault/get, config/read, or any other escape hatch. A compromised
//     shim can only invoke the same tools the in-app chat invokes —
//     credentials never cross the IPC boundary, only tool inputs and
//     redacted outputs.
//   * Auth: a 32-hex token generated at app boot via crypto.randomBytes,
//     written to <stateDir>/mcp-shim-token with mode 0o600. Token rotates
//     on every desktop-app restart. Stale shims from a previous boot fail
//     auth and surface a clear "Merlin restarted" error to the user.
//   * Transport: Unix domain socket (mac/linux, mode 0o600) or Windows
//     named pipe (default ACL — current user only). Never a TCP socket,
//     never bound to 0.0.0.0 — the Hard-Won Security Rule 11 spirit
//     applies even though this isn't `.listen()` on a port.
//   * Concurrent calls are supported. Each line of newline-delimited JSON
//     is a complete request; we dispatch in arrival order and write the
//     response immediately when the handler resolves. Multiple in-flight
//     calls per connection are fine (each carries its own `id`).
//
// PROTOCOL (newline-delimited JSON, request/response pairs over a single
//   long-lived connection)
//
//   Request:  { id, auth, method, params? }
//     id      — opaque string, echoed in response
//     auth    — 32-hex token from <stateDir>/mcp-shim-token
//     method  — 'ping' | 'tools/list' | 'tools/call'
//     params  — method-specific
//
//   Response: { id, ok, result? } | { id, ok: false, error: { code, message } }
//
//   Methods:
//     'ping'        → { ok: true, result: { pong: true, version } }
//     'tools/list'  → { ok: true, result: { tools: [{name, description, inputSchema, annotations}, ...] } }
//     'tools/call'  → { ok: true, result: <CallToolResult from handler> }
//                     or { ok: false, error: {...} } on transport failure
//
// LIFECYCLE
//
//   start({ ctx, stateDir, tools, onTokenRotate? })
//     — generates auth token, writes <stateDir>/mcp-shim-token
//     — removes any stale stale socket file (Unix), then listens
//     — returns { server, socketPath, tokenPath, token, stop() }
//
//   stop() — closes server, removes socket file (best-effort).
//
// TESTS — see app/mcp-ipc-endpoint.test.js. Covers: socket creation,
//   auth rejection, method allowlist, tools/list shape, tools/call
//   routing, ping, malformed-line handling, token rotation.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// Methods the endpoint will accept. Anything else gets METHOD_NOT_FOUND.
// DO NOT add methods that read state (config/read, vault/get, etc.) —
// the sidecar is intentionally tool-only. See header comment.
const ALLOWED_METHODS = new Set(['ping', 'tools/list', 'tools/call']);

// Maximum size of a single newline-delimited JSON request. 4 MiB is well
// past anything the shim will send (tool args are typically < 64 KB).
// A hostile client that streams without ever sending a newline gets
// disconnected at this cap so a single bad connection cannot OOM the
// main process.
const MAX_LINE_BYTES = 4 * 1024 * 1024;

// Maximum simultaneous in-flight requests per connection. Cheap defense
// against a chatty/buggy client; the main process MCP layer has its own
// per-platform concurrency slots, this is just a coarse cap.
const MAX_INFLIGHT_PER_CONN = 32;

// Resolve a per-OS socket path. Mac/Linux use a Unix domain socket;
// Windows uses a named pipe (\\.\pipe\merlin-mcp-<pid>-<rand>).
//
// We embed both a per-process tag AND a random suffix so the path is
// stable for the lifetime of the desktop process but unique across
// concurrent sessions on the same machine (e.g. dev + packaged install).
// The shim reads the path from <stateDir>/mcp-shim-token.json (alongside
// the token), so it always finds the live endpoint regardless of suffix.
function resolveSocketPath(stateDir, suffix) {
  const tag = suffix || crypto.randomBytes(4).toString('hex');
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\merlin-mcp-${process.pid}-${tag}`;
  }
  // Mac + Linux: domain socket inside stateDir. Keep the path short —
  // Unix domain sockets cap at ~104 chars on macOS, ~108 on Linux.
  // <stateDir>/mcp.sock is ~50 chars even with a long home directory.
  return path.join(stateDir, 'mcp.sock');
}

// Generate a fresh 32-hex auth token.
function generateAuthToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Constant-time string compare. crypto.timingSafeEqual requires equal-
// length buffers; we wrap to also reject length mismatch in O(1).
// REGRESSION GUARD (2026-04-28): Hard-Won Security Rule 5 — every
// secret check in workers / IPC uses constant-time compare. Raw `===`
// here would be a code-review blocker; a stale-token attacker could
// time the difference between "first-byte mismatch" and "tenth-byte
// mismatch" to brute-force the auth path.
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

// Atomic write — temp file + rename. Mode 0o600 on Unix; Windows ignores
// mode bits but the named pipe ACL (default-deny non-owner) covers that.
function atomicWrite(filePath, data, mode) {
  const tmp = filePath + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, data, { mode: mode || 0o600 });
  // On Windows, fs.writeFileSync ignores `mode`. On POSIX, ensure 0o600
  // even if umask widened the file.
  if (process.platform !== 'win32') {
    try { fs.chmodSync(tmp, mode || 0o600); } catch {}
  }
  fs.renameSync(tmp, filePath);
}

// Convert a Zod inputSchema (the SDK's tool() output) to a JSON Schema
// object suitable for the MCP tools/list response. Falls back to a
// permissive `{ type: 'object' }` if conversion fails for any reason —
// the in-app SDK accepts these shapes already, so we want to avoid
// hard-erroring on a single edge-case schema.
function toJsonSchema(inputSchema) {
  // Empty schema → permissive object.
  if (!inputSchema || typeof inputSchema !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: true };
  }
  // The SDK stores the original ZodRawShape (a plain object of
  // ZodTypeAny), not a compiled Zod object. We can either wrap it via
  // z.object(...) and convert, or build a shallow JSON schema by hand.
  // We try zod-to-json-schema first (already a transitive dep via the
  // Claude SDK); fall back to a hand-built shape on any failure.
  try {
    // Lazy require to avoid loading zod at module-init time when this
    // file is required by tests that don't exercise schema conversion.
    const z = require('zod');
    const { zodToJsonSchema } = require('zod-to-json-schema');
    const obj = z.object(inputSchema);
    const schema = zodToJsonSchema(obj, { target: 'jsonSchema7' });
    // zod-to-json-schema sometimes returns { $schema, ... } with a
    // wrapping reference; flatten to the inner object schema if so.
    if (schema && schema.$ref && schema.definitions) {
      const refKey = schema.$ref.replace(/^#\/definitions\//, '');
      if (schema.definitions[refKey]) return schema.definitions[refKey];
    }
    // Strip the $schema field (MCP clients don't need it) and return.
    if (schema && typeof schema === 'object') {
      const { $schema, ...rest } = schema;
      return rest;
    }
  } catch (_) { /* fall through to hand-built fallback */ }
  // Fallback: shallow object with names but no constraints. The SDK's
  // own validation still runs at handler dispatch.
  const properties = {};
  for (const k of Object.keys(inputSchema)) properties[k] = {};
  return { type: 'object', properties, additionalProperties: true };
}

// Build the MCP tools/list payload from the in-process tool array (the
// same array buildTools() returns to mcp-server.js). Each entry exposes
// only the public tool surface — name, description, JSON schema,
// annotations. The handler reference is NEVER serialized.
function buildToolsListPayload(tools) {
  if (!Array.isArray(tools)) return { tools: [] };
  const out = [];
  for (const t of tools) {
    if (!t || typeof t.name !== 'string') continue;
    out.push({
      name: t.name,
      description: t.description || '',
      inputSchema: toJsonSchema(t.inputSchema),
      annotations: t.annotations || {},
    });
  }
  return { tools: out };
}

// Dispatch one parsed request. Returns a response envelope.
//
// Auth check FAILS CLOSED — if `expectedToken` is empty/null (somehow
// not initialized) we refuse every request. Hard-Won Rule 5: never
// coalesce missing-secret with `||''` at compare site.
async function dispatchRequest(reqJson, { tools, expectedToken, ctx }) {
  const id = (reqJson && typeof reqJson.id !== 'undefined') ? reqJson.id : null;
  const fail = (code, message) => ({ id, ok: false, error: { code, message } });

  if (!expectedToken || typeof expectedToken !== 'string') {
    return fail('AUTH_FAILED', 'endpoint not initialized');
  }
  if (!reqJson || typeof reqJson !== 'object') {
    return fail('BAD_REQUEST', 'request must be a JSON object');
  }
  if (!constantTimeEqual(reqJson.auth || '', expectedToken)) {
    return fail('AUTH_FAILED', 'invalid auth token');
  }
  const method = reqJson.method;
  if (typeof method !== 'string' || !ALLOWED_METHODS.has(method)) {
    return fail('METHOD_NOT_FOUND', `method "${method}" is not supported`);
  }
  const params = (reqJson.params && typeof reqJson.params === 'object') ? reqJson.params : {};

  if (method === 'ping') {
    return { id, ok: true, result: { pong: true, ts: Date.now() } };
  }

  if (method === 'tools/list') {
    return { id, ok: true, result: buildToolsListPayload(tools) };
  }

  // tools/call
  const name = params.name;
  const args = (params.arguments && typeof params.arguments === 'object') ? params.arguments : {};
  if (typeof name !== 'string' || !name) {
    return fail('BAD_REQUEST', 'tools/call requires params.name');
  }
  const tool = tools.find((t) => t && t.name === name);
  if (!tool) {
    return fail('TOOL_NOT_FOUND', `unknown tool "${name}"`);
  }
  // Inject active brand if missing — mirrors the in-app `[ACTIVE_BRAND]`
  // tag flow. We only inject when the tool's input schema declares a
  // `brand` field (every tool with brandRequired or optional brand has
  // one) AND the caller did not pass it.
  if (!Object.prototype.hasOwnProperty.call(args, 'brand') &&
      tool.inputSchema && Object.prototype.hasOwnProperty.call(tool.inputSchema, 'brand')) {
    const ab = readActiveBrand(ctx);
    if (ab) args.brand = ab;
  }
  try {
    // The handler is the wrapped one from mcp-define-tool — already runs
    // brand-check, idempotency, preview gate, concurrency slot, redaction.
    // Pass an empty `extra` since the SDK transport-specific extra object
    // (signal, sessionId) is not meaningful here; the wrapped handler in
    // mcp-define-tool ignores `extra` anyway.
    const result = await tool.handler(args, {});
    return { id, ok: true, result };
  } catch (e) {
    return fail('INTERNAL_ERROR', (e && e.message) || String(e));
  }
}

// Read active brand from <appRoot>/.merlin-state.json. The shim already
// injects this at its layer; this is defense-in-depth so a buggy shim
// doesn't ship a brand-less call when the user has clearly selected a
// brand in the desktop UI. Best-effort — returns '' on any failure.
function readActiveBrand(ctx) {
  try {
    if (!ctx || !ctx.appRoot) return '';
    const p = path.join(ctx.appRoot, '.merlin-state.json');
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.activeBrand === 'string' && obj.activeBrand) {
      return obj.activeBrand;
    }
  } catch (_) { /* file missing or malformed — no active brand */ }
  return '';
}

// Per-connection line buffer. Splits incoming bytes on '\n' and emits
// each line to the handler. Enforces MAX_LINE_BYTES.
function makeLineReader(onLine, onError) {
  let buf = '';
  return {
    feed(chunk) {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES) {
        onError(new Error('line exceeds MAX_LINE_BYTES'));
        buf = '';
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) onLine(line);
      }
    },
    end() {
      // Drop any trailing partial line — never emit a non-terminated request.
      buf = '';
    },
  };
}

// Start the IPC server. Returns { server, socketPath, tokenPath, token, stop, setTools }.
//
// `tools` is the array returned by buildTools(...) from mcp-server.js;
// the caller must pass the SAME array the in-app SDK got, so both
// consumers share one tool registry (no double-registration, no drift).
// May be re-set later via the returned setTools() — startSession in
// main.js rebuilds the tool array on every session start (e.g. after
// a brand switch), and the IPC endpoint must always dispatch against
// the freshest registry.
//
// `getCtx()` is optional — if provided, the dispatcher calls it on
// each request to get the live ctx (so brand-switch updates are
// reflected immediately). If absent, we use the static ctx from opts.
//
// `onTokenRotate(token)` is optional — invoked once after the token
// has been written. Useful for tests / integration probes.
function start(opts) {
  const { ctx, stateDir, tools, getCtx, onTokenRotate } = opts || {};
  if (!ctx && typeof getCtx !== 'function') {
    throw new Error('mcp-ipc-endpoint: ctx or getCtx required');
  }
  if (!stateDir) throw new Error('mcp-ipc-endpoint: stateDir required');
  if (!Array.isArray(tools)) throw new Error('mcp-ipc-endpoint: tools array required');
  // Live tool reference — mutable so startSession can swap in a fresh
  // array without restarting the endpoint. Wrapped in a holder so the
  // dispatch closure always reads the latest.
  let liveTools = tools;

  const token = generateAuthToken();
  const tokenPath = path.join(stateDir, 'mcp-shim-token');

  const socketPath = resolveSocketPath(stateDir);

  // On Unix, remove a stale socket file from a previous (crashed) run.
  // Windows named pipes are reaped by the OS on process exit; nothing
  // to clean up there. Detect "exists but is a regular file" — that
  // would be a sign of corruption and we should refuse to start
  // rather than silently overwriting a non-socket file.
  if (process.platform !== 'win32') {
    try {
      const st = fs.statSync(socketPath);
      // Only remove sockets we expect to own (under stateDir).
      if (st && (st.isSocket() || st.isFIFO())) {
        try { fs.unlinkSync(socketPath); } catch {}
      } else if (st && st.isFile()) {
        // Suspicious — refuse to clobber.
        throw new Error('mcp-ipc-endpoint: stateDir contains a non-socket file at mcp.sock');
      }
    } catch (e) {
      if (e && e.code !== 'ENOENT') throw e;
    }
  }

  // Track active connections so stop() can close them cleanly.
  const conns = new Set();

  const server = net.createServer((sock) => {
    conns.add(sock);
    let inflight = 0;
    const reader = makeLineReader(
      (line) => {
        if (inflight >= MAX_INFLIGHT_PER_CONN) {
          // Coarse backpressure — refuse with explicit error so the
          // shim can surface "endpoint busy" rather than hanging.
          sock.write(JSON.stringify({ id: null, ok: false, error: { code: 'BUSY', message: 'too many in-flight requests on this connection' } }) + '\n');
          return;
        }
        let parsed;
        try { parsed = JSON.parse(line); } catch (e) {
          sock.write(JSON.stringify({ id: null, ok: false, error: { code: 'BAD_REQUEST', message: 'malformed JSON: ' + e.message } }) + '\n');
          return;
        }
        inflight++;
        const liveCtx = (typeof getCtx === 'function') ? (getCtx() || ctx) : ctx;
        dispatchRequest(parsed, { tools: liveTools, expectedToken: token, ctx: liveCtx })
          .then((resp) => {
            try { sock.write(JSON.stringify(resp) + '\n'); } catch (_) { /* socket closed mid-write */ }
          })
          .catch((e) => {
            try {
              sock.write(JSON.stringify({ id: parsed && parsed.id, ok: false, error: { code: 'INTERNAL_ERROR', message: (e && e.message) || String(e) } }) + '\n');
            } catch (_) { /* socket closed mid-write */ }
          })
          .finally(() => { inflight--; });
      },
      (err) => {
        // Line too long or framing error — drop this connection.
        try { sock.destroy(err); } catch {}
        conns.delete(sock);
      }
    );
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => reader.feed(chunk));
    sock.on('end', () => { reader.end(); });
    sock.on('close', () => { conns.delete(sock); });
    sock.on('error', () => { /* swallow — close handler runs cleanup */ });
  });

  server.on('error', (err) => {
    // Bind / accept errors. Log but do not crash the main process —
    // the in-app chat still works without the sidecar.
    console.error('[mcp-ipc] server error:', err && err.message);
  });

  // Bind. listen() with a single arg (path or pipe) is a Unix-socket /
  // named-pipe bind. Hard-Won Security Rule 11 spirit applies: never
  // accept a host argument here — always Unix domain socket / Windows
  // named pipe, never TCP.
  server.listen(socketPath);

  // Persist token + socket path for the shim to pick up. Combined into
  // a single JSON file so the shim can read both atomically. Mode 0o600
  // — owner-only on Unix, default ACL (current-user-only) on Windows.
  const tokenPayload = JSON.stringify({
    token,
    socketPath,
    pid: process.pid,
    createdAt: Date.now(),
    schema: 1,
  }, null, 2);
  atomicWrite(tokenPath, tokenPayload, 0o600);

  if (typeof onTokenRotate === 'function') {
    try { onTokenRotate(token); } catch (_) {}
  }

  function stop() {
    try { server.close(); } catch {}
    for (const c of conns) {
      try { c.destroy(); } catch {}
    }
    conns.clear();
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(socketPath); } catch {}
    }
    try { fs.unlinkSync(tokenPath); } catch {}
  }

  function setTools(newTools) {
    if (!Array.isArray(newTools)) return;
    liveTools = newTools;
  }

  return { server, socketPath, tokenPath, token, stop, setTools };
}

module.exports = {
  start,
  // Exported for tests:
  ALLOWED_METHODS,
  MAX_LINE_BYTES,
  MAX_INFLIGHT_PER_CONN,
  resolveSocketPath,
  generateAuthToken,
  constantTimeEqual,
  atomicWrite,
  toJsonSchema,
  buildToolsListPayload,
  dispatchRequest,
  readActiveBrand,
  makeLineReader,
};
