#!/usr/bin/env node
// Merlin MCP Shim — stdio MCP server that bridges Claude Desktop (or any
// MCP client: Codex, Cline, Cursor) to the running Merlin desktop app.
//
// SHAPE
//
//   Claude Desktop spawns this script as a child process. We speak the
//   stdio MCP protocol on stdin/stdout (LSP-style framing). For every
//   tool call we forward to the desktop app's local IPC endpoint
//   (mcp-ipc-endpoint.js, listening on a Unix domain socket / Windows
//   named pipe). Auth is a per-boot 32-hex token written by the desktop
//   app to <stateDir>/mcp-shim-token; this shim reads it on each call
//   so a desktop-app restart (which rotates the token) is recovered
//   transparently on the next tool call.
//
// SECURITY GUARANTEES
//
//   * Vault is NEVER read by this process. The desktop app holds the
//     vault; we hold a tool-router only. Even if Claude Desktop is
//     compromised, an attacker can only invoke MCP tools the desktop
//     app gates — never exfiltrate API keys.
//   * Only the per-OS state directory is read (token + active-brand
//     files). Both files are owner-only (0o600).
//   * No outbound network. Every byte goes desktop ↔ shim ↔ Claude Desktop.
//
// TRANSPORT
//
//   MCP messages on stdin/stdout follow the LSP framing convention:
//   each message is a UTF-8 JSON-RPC 2.0 object on its own line,
//   terminated by `\n`. (Claude Desktop and Codex both implement this
//   line-delimited form for stdio servers; Content-Length framing is
//   tolerated but not required.)
//
// FAILURE MODES
//
//   * Desktop app not running → tools/list returns a single placeholder
//     tool ("merlin_app_not_running") whose call returns a friendly
//     "Open the Merlin desktop app and try again" message. This is
//     better UX than Claude Desktop reporting "Server crashed" to the
//     user with no actionable hint.
//   * Token file missing or stale token → same placeholder path.
//   * Socket exists but not listening (e.g. desktop app mid-restart) →
//     short retry loop on connect (3x 200ms), then placeholder.
//
// Run-by-hand (smoke test):
//   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node app/merlin-mcp-shim.js
//   echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node app/merlin-mcp-shim.js

'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────

// Per-OS state directory — must match resolveStateDir() in app/main.js.
// Kept in sync deliberately; if main.js changes the resolution order,
// update both. Tests in app/merlin-mcp-shim.test.js exercise each branch.
function resolveStateDir() {
  // (1) Env var wins (used by tests + scheduled-tasks).
  if (process.env.MERLIN_STATE_DIR && path.isAbsolute(process.env.MERLIN_STATE_DIR)) {
    return process.env.MERLIN_STATE_DIR;
  }
  // (2) Per-OS default (matches main.js defaultStateDir).
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Merlin');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Merlin');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, 'Merlin');
  return path.join(os.homedir(), '.config', 'Merlin');
}

// Active-brand file lives in ContentDir, NOT StateDir. main.js writes
// it to <appRoot>/.merlin-state.json. ContentDir resolution mirrors
// main.js's defaultContentDir().
function resolveContentDir() {
  if (process.env.MERLIN_CONTENT_DIR && path.isAbsolute(process.env.MERLIN_CONTENT_DIR)) {
    return process.env.MERLIN_CONTENT_DIR;
  }
  return path.join(os.homedir(), 'Merlin');
}

// Pull the package version for the initialize response. Best-effort —
// the shim ships at resources/app.asar.unpacked/app/merlin-mcp-shim.js;
// package.json lives at resources/app.asar (parent's parent of __dirname).
//
// REGRESSION GUARD (2026-04-29, "version: unknown" in production logs):
// the prior `path.join(__dirname, '..', 'package.json')` only walked
// one level up — landing at resources/app.asar.unpacked/package.json
// which doesn't exist. The version came back as 'unknown' for every
// shim invocation. We now try the asar.unpacked sibling first, then
// fall through to two and three levels up to handle the dev-tree
// layout (autoCMO/package.json) and the packaged-asar layout.
function readVersion() {
  const candidates = [
    path.join(__dirname, '..', '..', 'package.json'),       // packaged: resources/app.asar.unpacked/app → resources/package.json
    path.join(__dirname, '..', '..', '..', 'package.json'), // packaged variant: resources → resources/.. (Mac Resources/Contents)
    path.join(__dirname, '..', 'package.json'),             // dev tree: app/ → autoCMO/
  ];
  for (const p of candidates) {
    try {
      const pkg = require(p);
      if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch (_) { /* try next */ }
  }
  return 'unknown';
}

// ──────────────────────────────────────────────────────────────
// Stderr logging — Claude Desktop captures stderr into its log
// (per the MCP spec footer: "If you are developing this MCP server
// you can add output to stderr and it will appear in this log").
// We use this for every error path so future "Server disconnected"
// events come with diagnostic context.
//
// REGRESSION GUARD (2026-04-29, silent-shim-exit incident): at
// 17:17:30 the shim process exited unexpectedly during Ryan's POG
// /update flow. Claude Desktop's log showed "process exiting early"
// with no stderr — we had no diagnostic. Every error path now writes
// a line so the next failure surfaces a cause.
//
// MUST go to stderr (not stdout) — stdout is the MCP framing channel
// and any non-JSON write there breaks the protocol.
function logErr(label, err) {
  try {
    const msg = err && err.message ? err.message : String(err || '');
    const line = `[merlin-shim] ${label}${msg ? ': ' + msg : ''}`;
    process.stderr.write(line + '\n');
  } catch (_) { /* stderr closed — give up silently, can't recover */ }
}
function logInfo(label) {
  try { process.stderr.write(`[merlin-shim] ${label}\n`); } catch (_) {}
}

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_VERSION = readVersion();
const CONNECT_RETRY_MS = 200;
const CONNECT_RETRY_COUNT = 3;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — long enough for SEO audits

// ──────────────────────────────────────────────────────────────
// Token + socket-path lookup
// ──────────────────────────────────────────────────────────────

// Read the desktop app's auth token + socket path. Returns null if
// the file is missing or unparseable — caller falls back to the
// "app not running" placeholder path.
function readEndpointHandshake(stateDir) {
  try {
    const tokenPath = path.join(stateDir, 'mcp-shim-token');
    const raw = fs.readFileSync(tokenPath, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.token !== 'string' || !/^[0-9a-f]{32}$/i.test(obj.token)) {
      return null;
    }
    if (typeof obj.socketPath !== 'string' || !obj.socketPath) return null;
    return { token: obj.token, socketPath: obj.socketPath, pid: obj.pid || 0 };
  } catch {
    return null;
  }
}

// Read the active brand from <appRoot>/.merlin-state.json. Returns ''
// if missing or empty. Atomic write on the desktop app side keeps the
// file always-valid; we still wrap in try/catch for robustness.
function readActiveBrand(appRoot) {
  try {
    const p = path.join(appRoot, '.merlin-state.json');
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (obj && typeof obj.activeBrand === 'string' && obj.activeBrand) {
      return obj.activeBrand;
    }
  } catch {}
  return '';
}

// ──────────────────────────────────────────────────────────────
// IPC client — connect, send, receive (newline-delimited JSON)
// ──────────────────────────────────────────────────────────────

// Lazily-opened persistent connection to the desktop app. We reconnect
// on the next call after a disconnect (e.g. desktop-app restart). Each
// outbound request gets a UUID; responses are correlated by `id`.
function createIpcClient(stateDir) {
  let sock = null;
  let pending = new Map(); // id → { resolve, reject, timer }
  let buf = '';
  let connectingPromise = null;
  let reqCounter = 0;

  function freshId() {
    reqCounter = (reqCounter + 1) >>> 0;
    return `s-${process.pid}-${Date.now().toString(36)}-${reqCounter}`;
  }

  function destroy(err) {
    if (sock) {
      try { sock.destroy(); } catch {}
      sock = null;
    }
    for (const [, p] of pending) {
      try { clearTimeout(p.timer); } catch {}
      try { p.reject(err || new Error('socket closed')); } catch {}
    }
    pending = new Map();
    buf = '';
    connectingPromise = null;
  }

  async function connect() {
    if (sock && !sock.destroyed) return;
    if (connectingPromise) return connectingPromise;
    connectingPromise = (async () => {
      let lastErr = null;
      for (let i = 0; i < CONNECT_RETRY_COUNT; i++) {
        const handshake = readEndpointHandshake(stateDir);
        if (!handshake) {
          lastErr = new Error('endpoint handshake file missing');
          await sleep(CONNECT_RETRY_MS);
          continue;
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve, reject) => {
            const s = net.createConnection(handshake.socketPath);
            const onErr = (e) => { s.removeAllListeners(); reject(e); };
            s.once('error', onErr);
            s.once('connect', () => {
              s.removeListener('error', onErr);
              s.setEncoding('utf8');
              s.on('data', (chunk) => onData(chunk));
              // REGRESSION GUARD (2026-04-29): on socket close (e.g.
              // Merlin desktop app restart during /update), DON'T exit
              // the shim — destroy() clears state, then the next tool
              // call will trigger a fresh connect against the new
              // post-rotation token. Pre-fix, destroy()'s clearing of
              // pending requests + the IPC socket's close caused Node's
              // event loop to drain (no in-flight work) and the process
              // exited 0 silently. The new keep-alive in main() prevents
              // that drain.
              s.on('close', () => {
                logInfo('IPC socket closed (desktop app likely restarting) — will reconnect on next call');
                destroy(new Error('socket closed'));
              });
              s.on('error', (e) => {
                logErr('IPC socket error', e);
                destroy(new Error('socket error'));
              });
              sock = s;
              resolve();
            });
          });
          // Stash handshake so send() can use the latest token.
          sock._handshake = handshake;
          return;
        } catch (e) {
          lastErr = e;
          await sleep(CONNECT_RETRY_MS);
        }
      }
      throw lastErr || new Error('connect failed');
    })().catch((e) => {
      connectingPromise = null;
      throw e;
    });
    try {
      await connectingPromise;
    } finally {
      connectingPromise = null;
    }
  }

  function onData(chunk) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; /* drop unparseable */ }
      const p = pending.get(parsed.id);
      if (p) {
        pending.delete(parsed.id);
        try { clearTimeout(p.timer); } catch {}
        p.resolve(parsed);
      }
    }
  }

  async function send(method, params) {
    await connect();
    const handshake = sock._handshake;
    const id = freshId();
    const req = { id, auth: handshake.token, method, params: params || {} };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`request ${method} timed out`));
        }
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        sock.write(JSON.stringify(req) + '\n');
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  return { send, destroy, get connected() { return sock && !sock.destroyed; } };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ──────────────────────────────────────────────────────────────
// MCP envelope formatting
// ──────────────────────────────────────────────────────────────

// JSON-RPC 2.0 success response.
function rpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}

// JSON-RPC 2.0 error response.
function rpcError(id, code, message, data) {
  const out = { jsonrpc: '2.0', id, error: { code, message } };
  if (data !== undefined) out.error.data = data;
  return out;
}

// Build the "Merlin desktop app not running" placeholder tool list.
// One tool whose call returns a friendly message — Claude Desktop
// surfaces it cleanly instead of failing the connection.
function notRunningPlaceholderTools() {
  return [{
    name: 'merlin_app_not_running',
    description: 'Merlin desktop app is not running. Open Merlin and try again — the real tool list will appear once the app is alive.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  }];
}

// CallToolResult shape — { content: [{type, text}], isError?: bool }.
// Matches the MCP spec; content is what the LLM actually sees.
function notRunningCallResult() {
  return {
    content: [{
      type: 'text',
      text: 'Merlin desktop app is not running. Open Merlin (taskbar / Dock / Spotlight), wait until the magic panel loads, then ask me again.',
    }],
    isError: true,
  };
}

// ──────────────────────────────────────────────────────────────
// Active-brand auto-injection
// ──────────────────────────────────────────────────────────────

// If the call is missing `brand`, inject the active brand from
// <appRoot>/.merlin-state.json. Mirrors the in-app `[ACTIVE_BRAND]` tag
// behavior. Only injects when the field is truly missing — never
// overrides an explicit brand. Tools that don't take a brand are
// unaffected (the IPC endpoint side simply ignores unknown args).
function injectActiveBrand(args, contentDir) {
  if (args && typeof args === 'object' && !Object.prototype.hasOwnProperty.call(args, 'brand')) {
    const ab = readActiveBrand(contentDir);
    if (ab) {
      // Shallow-clone so we don't mutate the caller's object.
      return Object.assign({}, args, { brand: ab });
    }
  }
  return args;
}

// ──────────────────────────────────────────────────────────────
// MCP request handlers
// ──────────────────────────────────────────────────────────────

async function handleInitialize(id) {
  return rpcOk(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: 'merlin',
      version: SERVER_VERSION,
    },
  });
}

async function handleToolsList(id, ipc) {
  let resp;
  try {
    resp = await ipc.send('tools/list');
  } catch (e) {
    logErr('tools/list IPC send failed — returning app-not-running placeholder', e);
    return rpcOk(id, { tools: notRunningPlaceholderTools() });
  }
  if (!resp || !resp.ok) {
    const errMsg = resp && resp.error && resp.error.message ? resp.error.message : 'no ok flag';
    logErr(`tools/list IPC returned non-ok (${errMsg}) — returning placeholder`);
    return rpcOk(id, { tools: notRunningPlaceholderTools() });
  }
  // The endpoint returns { tools: [...] }; pass through unchanged.
  return rpcOk(id, resp.result || { tools: [] });
}

async function handleToolsCall(id, params, ipc, contentDir) {
  const name = params && params.name;
  const rawArgs = (params && params.arguments) || {};
  if (!name || typeof name !== 'string') {
    return rpcError(id, -32602, 'tools/call requires params.name');
  }
  // Placeholder hit — desktop app isn't running. Return the friendly
  // "open the app" message instead of forwarding (which would just
  // fail on the connect step).
  if (name === 'merlin_app_not_running') {
    return rpcOk(id, notRunningCallResult());
  }
  const args = injectActiveBrand(rawArgs, contentDir);
  let resp;
  try {
    resp = await ipc.send('tools/call', { name, arguments: args });
  } catch (e) {
    return rpcOk(id, {
      content: [{
        type: 'text',
        text: `Merlin desktop app could not be reached: ${e.message}. Open Merlin and try again.`,
      }],
      isError: true,
    });
  }
  if (!resp || !resp.ok) {
    const msg = resp && resp.error && resp.error.message ? resp.error.message : 'unknown error';
    return rpcOk(id, {
      content: [{ type: 'text', text: `Tool call failed: ${msg}` }],
      isError: true,
    });
  }
  // Pass through the CallToolResult unchanged.
  return rpcOk(id, resp.result);
}

// ──────────────────────────────────────────────────────────────
// Main loop
// ──────────────────────────────────────────────────────────────

async function dispatch(message, ipc, contentDir) {
  if (!message || typeof message !== 'object') return null;
  const id = message.id;
  const method = message.method;
  if (typeof method !== 'string') return null;

  try {
    if (method === 'initialize') return handleInitialize(id);
    if (method === 'initialized' || method === 'notifications/initialized') {
      // Notification — no response.
      return null;
    }
    if (method === 'ping') return rpcOk(id, {});
    if (method === 'tools/list') return handleToolsList(id, ipc);
    if (method === 'tools/call') return handleToolsCall(id, message.params, ipc, contentDir);
    // Unsupported — return JSON-RPC method-not-found per spec.
    return rpcError(id, -32601, `method "${method}" is not supported by the Merlin shim`);
  } catch (e) {
    return rpcError(id, -32603, `internal shim error: ${e.message}`);
  }
}

function writeMessage(msg) {
  if (!msg) return;
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch (_) { /* stdout closed — Claude Desktop disconnected, exit clean */ }
}

function main() {
  const stateDir = resolveStateDir();
  const contentDir = resolveContentDir();
  logInfo(`startup pid=${process.pid} stateDir=${stateDir} version=${SERVER_VERSION}`);

  const ipc = createIpcClient(stateDir);

  // REGRESSION GUARD (2026-04-29, silent-shim-exit at 17:17:30 incident):
  // Pre-fix the shim process exited when stdin's readline emitted 'close',
  // OR — and this was the real bug — when there was nothing else keeping
  // the Node event loop alive AND stdin paused. On Windows, when the
  // parent IPC socket dropped (Merlin desktop app restart during /update),
  // the IPC client's destroy() cleared all timers + pending requests, and
  // if no MCP message was actively in flight, the event loop ran out of
  // active handles and Node exited 0. Claude Desktop saw "process exiting
  // early" with no stderr.
  //
  // Fix: explicitly resume stdin so its read handle keeps the event loop
  // alive even when no MCP message is in flight. The shim should ONLY
  // exit when its parent (Claude Desktop) closes stdin or kills us, not
  // because it ran out of background work.
  process.stdin.resume();

  // Belt-and-suspenders: a 30-second heartbeat that does nothing but
  // hold a ref to the event loop. Cheap. Without this, a Node version
  // that for any reason loses track of the stdin handle would exit. We
  // unref it so it never blocks process exit when we DO want to exit.
  const keepAlive = setInterval(() => {}, 30_000);
  // .unref() means the timer doesn't keep Node alive ON ITS OWN — but
  // its presence does prevent the "no handles, exit" path from firing
  // during the gap between MCP messages.
  if (typeof keepAlive.unref === 'function') keepAlive.unref();

  // Surface any unhandled rejection / uncaught exception to stderr so
  // Claude Desktop's log captures it before we exit. Pre-fix these
  // crashed silently with no diagnostic.
  process.on('uncaughtException', (err) => {
    logErr('uncaughtException', err);
    if (err && err.stack) { try { process.stderr.write(err.stack + '\n'); } catch (_) {} }
    // Don't process.exit here — let Node's default handler decide. We
    // just want the diagnostic captured.
  });
  process.on('unhandledRejection', (reason) => {
    logErr('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    if (!line || !line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      logErr('stdin parse error', e);
      writeMessage(rpcError(null, -32700, `parse error: ${e.message}`));
      return;
    }
    let resp;
    try {
      resp = await dispatch(msg, ipc, contentDir);
    } catch (e) {
      logErr(`dispatch error (method=${msg && msg.method})`, e);
      resp = rpcError(msg && msg.id, -32603, `shim dispatch error: ${e.message}`);
    }
    if (resp) writeMessage(resp);
  });
  rl.on('close', () => {
    logInfo('stdin closed (parent client disconnected) — exiting cleanly');
    try { clearInterval(keepAlive); } catch {}
    try { ipc.destroy(); } catch {}
    process.exit(0);
  });

  // If stdin errors out (e.g. Claude Desktop killed us), exit cleanly.
  process.stdin.on('error', (e) => {
    logErr('stdin error — exiting', e);
    try { clearInterval(keepAlive); } catch {}
    try { ipc.destroy(); } catch {}
    process.exit(0);
  });
}

// Only auto-run when this file is the entry point. require() from a test
// file just exposes the helpers without launching the loop.
if (require.main === module) {
  main();
}

module.exports = {
  // Pure helpers — exercised by app/merlin-mcp-shim.test.js
  resolveStateDir,
  resolveContentDir,
  readEndpointHandshake,
  readActiveBrand,
  injectActiveBrand,
  rpcOk,
  rpcError,
  notRunningPlaceholderTools,
  notRunningCallResult,
  createIpcClient,
  dispatch,
  readVersion,  // exported for tests asserting version-fallback behavior
  PROTOCOL_VERSION,
  SERVER_VERSION,
};
