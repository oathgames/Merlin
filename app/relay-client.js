// relay-client.js — outbound WebSocket dialer to merlin-relay.
//
// Bridges the desktop Electron app to the relay Worker so the PWA (phone)
// can reach Merlin while roaming. NO PORTS EXPOSED ON THIS MACHINE — the
// connection is outbound-only and NAT-friendly.
//
// Security:
//   - Session credentials (sessionId + desktopToken) are persisted encrypted
//     via Electron safeStorage. If safeStorage is unavailable the module
//     stays in-memory only and the user re-pairs next launch.
//   - The token is NEVER logged — even at verbose log level.
//   - Outbound WSS only (TLS); plain ws:// is refused.
//   - Auto-reconnect uses bounded exponential backoff capped at 60s so we
//     don't flood the relay during extended outages.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');
const { app, safeStorage } = require('electron');

const RELAY_BASE = process.env.MERLIN_RELAY_BASE || 'https://relay.merlingotme.com';
const CREDS_FILENAME = '.merlin-relay-creds';
const RECONNECT_MIN_MS = 1500;
const RECONNECT_MAX_MS = 60_000;
const MAX_MSG_BYTES = 128 * 1024;

// REGRESSION GUARD (2026-05-01): app-level WebSocket keepalive.
//
// Mobile carrier NAT idle timeouts (typical 1–5 min) silently drop WS
// TCP connections when no bytes flow. The browser WebSocket spec does
// NOT expose ping/pong control to JS, the `ws` Node library has NO
// default ping (this file's pre-2026-05-01 comment that "the runtime
// sends WS pings automatically" was wrong), and Cloudflare's
// hibernatable WebSockets do NOT auto-PING. So WITHOUT this app-level
// keepalive, an idle desktop↔relay connection looks alive on every
// layer and silently dies on first send-attempt.
//
// 25s ping cadence is below the floor of every common NAT idle timeout
// (carrier NATs ≥30s, home routers ≥60s, Cloudflare's edge keepalive
// is ~100s). 60s pong-deadline forces a fast reconnect on a dead leg
// rather than waiting for the OS to detect it (often 2–10 min).
const PING_INTERVAL_MS = 25_000;
const PONG_DEADLINE_MS = 60_000;
const PING_FRAME = '{"type":"ping"}';

let ws = null;
let creds = null;            // { sessionId, desktopToken }  in-memory, NEVER logged
let reconnectTimer = null;
let reconnectAttempts = 0;
let stopping = false;
let connected = false;
let pingTimer = null;        // setInterval handle; cleared on close
let lastPongAt = 0;          // monotonic ms; updated on every inbound frame

// Handlers injected from main.js (same shape as ws-server.setHandlers).
let onSendMessage = null;
let onApproveTool = null;
let onDenyTool = null;
let onAnswerQuestion = null;
let onTranscribeAudio = null;

// PWA-originated audio frames. Matches ws-server's limit so the LAN and
// relay paths enforce the same ceiling.
const MAX_TRANSCRIBE_BYTES = 192 * 1024;

// ── Credential persistence ──────────────────────────────────────────
function getCredsPath() {
  try {
    return path.join(app.getPath('userData'), CREDS_FILENAME);
  } catch {
    return null;
  }
}

function loadCreds() {
  const p = getCredsPath();
  if (!p || !fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p);
    // File format: 1 byte marker (0x01 = safeStorage-encrypted, 0x00 = plain
    // JSON) then the blob. We avoid a plain-JSON-by-default path entirely —
    // if safeStorage isn't available we simply don't persist.
    if (raw.length < 2) return null;
    const marker = raw[0];
    const body = raw.slice(1);
    if (marker !== 0x01) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const json = safeStorage.decryptString(body);
    const parsed = JSON.parse(json);
    if (typeof parsed?.sessionId !== 'string' || typeof parsed?.desktopToken !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCreds(next) {
  const p = getCredsPath();
  if (!p) return false;
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    const enc = safeStorage.encryptString(JSON.stringify(next));
    const out = Buffer.concat([Buffer.from([0x01]), enc]);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, out, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function clearCreds() {
  creds = null;
  const p = getCredsPath();
  if (p && fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch {}
  }
}

// ── Connection lifecycle ────────────────────────────────────────────
function logSafe(...args) {
  // Redact anything that looks like a 43-char base64url token. The desktop
  // token and any pwa tokens we happen to see in payloads should never
  // land in logs.
  try {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const redacted = msg.replace(/[A-Za-z0-9_-]{40,64}/g, '[REDACTED]');
    console.log('[relay]', redacted);
  } catch { /* never throw from a logger */ }
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_MIN_MS * Math.pow(2, Math.min(reconnectAttempts, 6)) + Math.floor(Math.random() * 500),
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (stopping) return;
  if (!creds || !creds.sessionId || !creds.desktopToken) return;
  if (!RELAY_BASE.startsWith('https://')) {
    logSafe('refusing relay base URL without TLS');
    return;
  }
  const wsBase = RELAY_BASE.replace(/^https:/, 'wss:');
  const url = `${wsBase}/ws/desktop?session=${encodeURIComponent(creds.sessionId)}&t=${encodeURIComponent(creds.desktopToken)}`;

  try {
    ws = new WebSocket(url, {
      maxPayload: MAX_MSG_BYTES,
      handshakeTimeout: 15_000,
      // Electron bundles CA roots; verify TLS (default). The `ws` library
      // does NOT auto-PING; we send app-level {type:"ping"} frames every
      // PING_INTERVAL_MS — see REGRESSION GUARD (2026-05-01) at the top
      // of this file.
    });
  } catch (e) {
    logSafe('ws construction failed');
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    connected = true;
    reconnectAttempts = 0;
    lastPongAt = Date.now();
    startKeepalive();
    logSafe('connected');
  });

  ws.on('message', (raw) => {
    // Any inbound frame counts as liveness — even a non-pong message means
    // the leg is healthy. This is correct because the relay's hibernatable
    // WS won't deliver anything if the TCP path is dead. Updating
    // lastPongAt on every message also avoids edge cases where the relay
    // is forwarding a high-volume sdk-message stream and our 25s ping
    // happens to be in flight when the stream arrives.
    lastPongAt = Date.now();

    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'pong':
        return; // Keepalive ack from relay — already updated lastPongAt above.
      case 'auth-ok':
        return; // Sent by DO on connect — informational.
      case 'send-message':
        if (typeof msg.text !== 'string' || msg.text.length > 50_000) return;
        if (onSendMessage) onSendMessage(msg.text);
        return;
      case 'approve-tool':
        if (typeof msg.toolUseID !== 'string' || msg.toolUseID.length > 64) return;
        if (onApproveTool) onApproveTool(msg.toolUseID);
        return;
      case 'deny-tool':
        if (typeof msg.toolUseID !== 'string' || msg.toolUseID.length > 64) return;
        if (onDenyTool) onDenyTool(msg.toolUseID);
        return;
      case 'answer-question':
        if (typeof msg.toolUseID !== 'string' || msg.toolUseID.length > 64) return;
        if (!msg.answers || typeof msg.answers !== 'object') return;
        if (onAnswerQuestion) onAnswerQuestion(msg.toolUseID, msg.answers);
        return;
      case 'transcribe-audio': {
        if (typeof msg.requestId !== 'string' || msg.requestId.length > 64) return;
        if (typeof msg.mime !== 'string' || msg.mime.length > 64) return;
        if (typeof msg.data !== 'string' || msg.data.length > MAX_TRANSCRIBE_BYTES) {
          forward('transcription', { requestId: msg.requestId, error: 'too-large' });
          return;
        }
        if (!onTranscribeAudio) return;
        Promise.resolve(onTranscribeAudio(msg.data, msg.mime))
          .then((result) => {
            const payload = { requestId: msg.requestId };
            if (result && typeof result.text === 'string') payload.text = result.text;
            if (result && typeof result.error === 'string') payload.error = result.error;
            forward('transcription', payload);
          })
          .catch(() => forward('transcription', { requestId: msg.requestId, error: 'internal' }));
        return;
      }
      default:
        return; // drop unknown types
    }
  });

  ws.on('close', (code) => {
    connected = false;
    ws = null;
    stopKeepalive();
    // 1008 (auth) / 4401 (custom) = creds are permanently bad. Bail out and
    // let the user re-pair.
    if (code === 1008 || code === 4401) {
      logSafe('auth rejected — clearing creds and stopping');
      clearCreds();
      stopping = true;
      return;
    }
    scheduleReconnect();
  });

  ws.on('error', () => {
    // Logged via the close event; avoid duplicate noise. Never log the URL —
    // it contains the token.
  });
}

// ── Keepalive ───────────────────────────────────────────────────────
//
// Sends {type:"ping"} every PING_INTERVAL_MS while connected. The relay
// short-circuits ping in durable.js's webSocketMessage and replies with
// {type:"pong"} (see relay/durable.js REGRESSION GUARD 2026-05-01). If
// no inbound frame arrives within PONG_DEADLINE_MS of the last one, the
// leg is considered dead and we force a close — the close handler then
// runs the standard reconnect path. Without this, a NAT-killed
// connection sits in a "looks alive" state until the user tries to send.
function startKeepalive() {
  stopKeepalive();
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Liveness check first — if we haven't seen ANY frame (pong or
    // otherwise) in PONG_DEADLINE_MS, the leg is dead. Force a close
    // so the reconnect path runs.
    if (Date.now() - lastPongAt > PONG_DEADLINE_MS) {
      logSafe('keepalive deadline exceeded — forcing reconnect');
      try { ws.close(4000, 'keepalive_timeout'); } catch {}
      return;
    }
    try { ws.send(PING_FRAME); } catch {
      // Send failure is itself a signal the socket is dead. Close
      // handler will pick up; no-op here.
    }
  }, PING_INTERVAL_MS);
  // Don't keep the Electron event loop alive solely for keepalive —
  // when the user quits, this should not block process exit. unref()
  // is a no-op on already-unref'd timers, safe to call.
  if (pingTimer && typeof pingTimer.unref === 'function') {
    pingTimer.unref();
  }
}

function stopKeepalive() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function forward(type, payload) {
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return false;
  // Only forward types the DO accepts from desktop. Prevents a renderer bug
  // from emitting PWA-origin envelopes into the relay.
  const DESKTOP_TYPES = new Set(['sdk-message', 'approval-request', 'ask-user-question', 'sdk-error', 'user-message', 'transcription']);
  if (!DESKTOP_TYPES.has(type)) return false;
  try {
    const frame = JSON.stringify({ type, payload });
    if (frame.length > MAX_MSG_BYTES) return false;
    ws.send(frame);
    return true;
  } catch {
    return false;
  }
}

// ── Pairing ─────────────────────────────────────────────────────────
async function initPairing() {
  // If we already have valid creds we re-use them: this means the existing
  // paired phone(s) stay paired. The user explicitly has to call
  // `rotatePairing()` to force-rotate.
  if (creds) {
    // Still need a fresh pair code for the new phone.
    return mintPairCode();
  }
  const resp = await httpPostJson('/pair/init', {});
  if (!resp || !resp.sessionId || !resp.desktopToken || !resp.pairUrl) {
    throw new Error('pair_init_failed');
  }
  creds = { sessionId: resp.sessionId, desktopToken: resp.desktopToken };
  saveCreds(creds);
  stopping = false;
  reconnectAttempts = 0;
  connect();
  return { sessionId: resp.sessionId, pairCode: resp.pairCode, pairUrl: resp.pairUrl, expiresInSec: resp.expiresInSec };
}

// Mint an additional pair code for an already-known session so the user
// can pair a second device (or re-display the QR after dismissing it)
// without rotating the desktop token and without kicking paired phones.
//
// REGRESSION GUARD (2026-04-19, pwa-roaming-relay): this path is the common
// case — every QR modal re-open after the first pair lands here. Before the
// relay-deploy session shipped /pair/mint, this function threw and forced
// the UI into the LAN fallback on every subsequent open. Do not revert to
// the old "throw multi_device_pairing_pending" — users stop getting relay
// QR codes entirely and think remote access is broken.
async function mintPairCode() {
  if (!creds) throw new Error('no_session');
  const resp = await httpPostJson('/pair/mint', {
    sessionId: creds.sessionId,
    desktopToken: creds.desktopToken,
  });
  if (!resp || !resp.pairUrl || !resp.pairCode) {
    throw new Error('pair_mint_failed');
  }
  return {
    sessionId: resp.sessionId || creds.sessionId,
    pairCode: resp.pairCode,
    pairUrl: resp.pairUrl,
    expiresInSec: resp.expiresInSec,
  };
}

async function rotatePairing() {
  clearCreds();
  stopping = false;
  return initPairing();
}

function getState() {
  return {
    paired: !!creds,
    connected,
    sessionId: creds?.sessionId || null,  // NEVER returns desktopToken
  };
}

// ── HTTP helper (for /pair/init) ────────────────────────────────────
async function httpPostJson(pathStr, body) {
  const url = `${RELAY_BASE}${pathStr}`;
  if (!url.startsWith('https://')) throw new Error('tls_required');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch {}
    throw new Error(err.error || `http_${res.status}`);
  }
  return res.json();
}

// ── Lifecycle ───────────────────────────────────────────────────────
async function start() {
  stopping = false;
  creds = loadCreds();
  if (creds) {
    reconnectAttempts = 0;
    connect();
  }
}

function stop() {
  stopping = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    try { ws.close(1000, 'shutdown'); } catch {}
    ws = null;
  }
  connected = false;
}

function setHandlers(h) {
  onSendMessage      = h.onSendMessage      || null;
  onApproveTool      = h.onApproveTool      || null;
  onDenyTool         = h.onDenyTool         || null;
  onAnswerQuestion   = h.onAnswerQuestion   || null;
  onTranscribeAudio  = h.onTranscribeAudio  || null;
}

// Revoke a specific paired device.
async function revokeDevice(deviceId) {
  if (!creds) throw new Error('no_session');
  await httpPostJson('/session/revoke-device', {
    sessionId: creds.sessionId,
    desktopToken: creds.desktopToken,
    deviceId,
  });
}

module.exports = {
  start,
  stop,
  setHandlers,
  forward,
  initPairing,
  rotatePairing,
  revokeDevice,
  getState,
  // Test hooks — not documented in the public API.
  _setCredsForTest(c) { creds = c ? { ...c } : null; },
  // Keepalive constants exported for test pinning. Bumping these is a
  // ship decision — see REGRESSION GUARD (2026-05-01) at the top of
  // this file before changing.
  PING_INTERVAL_MS,
  PONG_DEADLINE_MS,
  PING_FRAME,
};
