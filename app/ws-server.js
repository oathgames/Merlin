const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
// `app` is only available when this module is required inside an Electron
// main process. Unit tests require ws-server.js directly under plain node,
// which would otherwise crash at load time. Swallow the failure and fall
// back to tmpdir in getCertDir() — the test suite exercises the no-Electron
// branch explicitly.
let electronApp = null;
try { electronApp = require('electron').app; } catch { electronApp = null; }

// Generate a session token — random, never stored to disk
const sessionToken = crypto.randomBytes(16).toString('hex');
const sessionTokenBuf = Buffer.from(sessionToken, 'utf8');

// Constant-time comparison for the session token. String `===` short-circuits
// on the first differing byte which leaks per-byte timing. The listener is
// pinned to 127.0.0.1 (see REGRESSION GUARD in startServer), so an attacker
// needs local code execution to probe timing — but we keep constant-time
// compare anyway: defense in depth, and it removes a landmine if a future
// edit widens the bind.
function tokensMatch(candidate) {
  if (typeof candidate !== 'string') return false;
  const candBuf = Buffer.from(candidate, 'utf8');
  if (candBuf.length !== sessionTokenBuf.length) return false;
  return crypto.timingSafeEqual(candBuf, sessionTokenBuf);
}

let wss = null;
let httpServer = null;
let wsPort = 0;
let useTLS = false;
const authenticatedClients = new Set();
const pwaDir = path.join(__dirname, '..', 'pwa');

// Message handlers — set by main.js to bridge into SDK
let onSendMessage = null;
let onApproveTool = null;
let onDenyTool = null;
let onAnswerQuestion = null;
let onTranscribeAudio = null;

// Per-frame ceiling for base64-encoded voice audio coming from the PWA. A
// 15s opus recording base64s to ~60-90 KB; 192 KB gives headroom for iOS's
// heavier mp4 fallback without opening the door to arbitrary uploads.
const MAX_TRANSCRIBE_BYTES = 192 * 1024;

// Cert validity window. Long enough that regen effectively never happens on
// a healthy install — the cached cert just keeps working. A background
// regen fires if the cached cert is within CERT_RENEW_THRESHOLD_MS of
// expiry, so users never see a hard failure at the boundary.
const CERT_VALIDITY_DAYS = 3650;
const CERT_RENEW_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Test seam: when set, replaces the child_process.execFile used for openssl
// invocations. Production code never reaches this path. Kept as a
// module-local let (not an export mutation site) to keep the surface
// small — tests reach it through the `_testHooks` bundle exported at the
// bottom of this file.
let _execFileImpl = execFile;

// Counters exposed to tests to verify broadcast short-circuiting. These
// are cheap (two integer increments per call) and production code keeps
// them enabled so crash reports can carry the aggregate.
const broadcastStats = {
  totalCalls: 0,
  stringifiedCalls: 0,
  skippedNoListeners: 0,
};

// Optional outbound mirror — set by relay-client.js to fan every LAN
// broadcast out to the merlin-relay Worker so roaming PWAs see the same
// stream. Returning false from this hook means "not connected right now";
// LAN delivery is independent.
let relayForward = null;
function setRelayForward(fn) { relayForward = (typeof fn === 'function') ? fn : null; }

function getCertDir() {
  // Honor the Cluster-B / Cluster-L StateDir contract (see KNOWLEDGE.md §D1):
  // if `MERLIN_STATE_DIR` is set by the bootstrapper, the cert lives
  // alongside the vault + rate-limit state under StateDir. This keeps a
  // single consistent location across the Go binary and Electron shell.
  const envDir = process.env.MERLIN_STATE_DIR;
  if (typeof envDir === 'string' && envDir.trim().length > 0) {
    return path.join(envDir, '.merlin-certs');
  }
  // Electron's userData path is `%APPDATA%\Merlin` on Windows and
  // `~/Library/Application Support/Merlin` on macOS — both identical to
  // the Cluster-B StateDir for app name "Merlin", so this branch stays
  // correct even when the env var is absent (e.g. dev tree / non-bootstrap
  // installs).
  try {
    if (electronApp && typeof electronApp.getPath === 'function') {
      return path.join(electronApp.getPath('userData'), '.merlin-certs');
    }
  } catch { /* fall through */ }
  // Unit tests / non-Electron: tmp is fine because no real cert lives here.
  return path.join(os.tmpdir(), '.merlin-certs');
}

// Parse a PEM-encoded X.509 cert and return its notAfter timestamp (ms
// since epoch) or null if the cert can't be parsed. Uses the public
// `crypto.X509Certificate` API (Node 15.6+).
function certNotAfterMs(certPem) {
  try {
    const x509 = new crypto.X509Certificate(certPem);
    const t = Date.parse(x509.validTo);
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

// Return the cached cert+key if a valid pair exists on disk, else null.
// "Valid" means: both files exist, PEMs parse, and notAfter is in the
// future. Expired certs return null so the caller regenerates. This is a
// sync call — but all it does is read two small files. On the cold path
// it replaces a ~200-1500ms openssl spawn.
function readCachedCert() {
  const certDir = getCertDir();
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) return null;
  try {
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);
    const notAfter = certNotAfterMs(cert);
    if (notAfter === null) return null;
    if (notAfter <= Date.now()) return null; // hard-expired
    // Tighten perms defensively in case an older version created the key
    // with a default umask of 0644. chmod is a no-op on Windows.
    try { fs.chmodSync(keyPath, 0o600); } catch {}
    return { key, cert, notAfter };
  } catch { return null; }
}

// Async cert generation. Resolves to { key, cert } on success, null on
// failure (openssl missing, spawn error, write error). Never throws —
// the startup path must not crash if openssl is absent. Writes 0600 on
// the key file so a multi-user host cannot read it back.
function generateCertAsync() {
  return new Promise((resolve) => {
    const certDir = getCertDir();
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');
    try {
      fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(certDir, 0o700); } catch {}
    } catch {
      resolve(null);
      return;
    }
    const args = [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', String(CERT_VALIDITY_DAYS),
      '-nodes',
      '-subj', '/CN=localhost',
    ];
    // 30s timeout guards against a wedged openssl (CI / AV interference).
    _execFileImpl('openssl', args, { timeout: 30_000 }, (err) => {
      if (err) {
        console.log('[WS] openssl cert generation failed:', err.code || err.message || 'unknown');
        resolve(null);
        return;
      }
      try {
        try { fs.chmodSync(keyPath, 0o600); } catch {}
        try { fs.chmodSync(certPath, 0o644); } catch {}
        const key = fs.readFileSync(keyPath);
        const cert = fs.readFileSync(certPath);
        resolve({ key, cert });
      } catch (e) {
        console.log('[WS] cert read-back failed:', e.message);
        resolve(null);
      }
    });
  });
}

// Kick off a background regen if the cached cert is within the renew
// threshold. Swallows all errors — a failed background regen just means
// the current cert keeps serving until a future launch succeeds.
function maybeBackgroundRegen(notAfter) {
  if (typeof notAfter !== 'number') return;
  const msUntilExpiry = notAfter - Date.now();
  if (msUntilExpiry > CERT_RENEW_THRESHOLD_MS) return;
  // Fire and forget. The new cert is picked up on the NEXT launch; we
  // don't swap the listener under live traffic.
  generateCertAsync().catch(() => {});
}

function startServer() {
  return new Promise((resolve) => {
    const mimeTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

    const requestHandler = (req, res) => {
      // S10: Restrict CORS to localhost and local network
      const origin = req.headers.origin || '';
      const allowedOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin) ? origin : '';

      let filePath = req.url.split('?')[0];
      if (filePath === '/') filePath = '/index.html';
      // Decode percent-encoded traversal attempts (`..%2F..%2F` etc.) and
      // resolve under pwaDir. Any resolved path that escapes pwaDir (via
      // `..`, absolute paths, or Windows drive letters) falls through to
      // the SPA index — never reads arbitrary files off disk.
      let decoded;
      try { decoded = decodeURIComponent(filePath); } catch { decoded = filePath; }
      const resolved = path.resolve(pwaDir, '.' + decoded);
      const pwaPrefix = pwaDir + path.sep;
      const insidePwa = resolved === pwaDir || resolved.startsWith(pwaPrefix);
      const ext = path.extname(resolved);
      const secHeaders = { 'Access-Control-Allow-Origin': allowedOrigin, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' };
      if (insidePwa && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain', ...secHeaders });
        res.end(fs.readFileSync(resolved));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html', ...secHeaders });
        res.end(fs.readFileSync(path.join(pwaDir, 'index.html')));
      }
    };

    // Cert path — synchronous cache read only. The old execSync openssl
    // spawn is GONE from the startup hot path (task 4.7): it blocked the
    // Electron main process 200-1500ms on first launch, and longer on
    // Windows AV cold-starts. The new flow:
    //   1. Read cached cert (a pair of small file reads).
    //   2a. Hit + not expired → HTTPS, done. Kick off background regen if
    //       the cert is within 30d of expiry (no user impact either way).
    //   2b. Miss or expired → HTTP now, fire async openssl regen so the
    //       NEXT launch gets HTTPS. We never swap the listener under live
    //       traffic; that would invalidate any already-connected PWA
    //       socket for a marginal security gain (all PWA traffic is
    //       loopback-only per Rule 11, and the session token is the real
    //       auth boundary, not the TLS channel).
    const cached = readCachedCert();
    if (cached) {
      const https = require('https');
      httpServer = https.createServer({ key: cached.key, cert: cached.cert }, requestHandler);
      useTLS = true;
      maybeBackgroundRegen(cached.notAfter);
    } else {
      httpServer = http.createServer(requestHandler);
      useTLS = false;
      console.log('[WS] No cached cert — serving HTTP on loopback. Generating cert in background for next launch.');
      // Fire-and-forget. We intentionally don't await — the whole point of
      // 4.7 is to un-block startup.
      generateCertAsync().then((result) => {
        if (result) console.log('[WS] Cert generated; HTTPS will be used on next launch.');
        else console.log('[WS] Background cert generation failed; HTTP fallback will persist.');
      }).catch(() => {});
    }

    wss = new WebSocketServer({ server: httpServer, maxPayload: 256 * 1024 }); // 256KB limit

    // REGRESSION GUARD (2026-04-18): LAN server MUST bind to 127.0.0.1 only.
    // An earlier TODO here proposed flipping to '0.0.0.0' when the PWA went
    // live — DO NOT. Roaming is now handled by merlin-relay (outbound WSS to
    // relay.merlingotme.com), which never opens an inbound port and therefore
    // never triggers a Windows Firewall / macOS firewall prompt. Binding this
    // listener to 0.0.0.0 would re-introduce the prompt for every user on
    // first launch with zero product benefit, since the PWA reaches the
    // desktop via the relay regardless of network. Same-WiFi fallback still
    // works over loopback because the phone talks to the relay, not to this
    // port directly. If a future contributor is tempted to widen the bind,
    // read CLAUDE.md's firewall-silence guarantee first.
    //
    // HTTP fallback reminder (task 4.7, 2026-04-23): even when cert
    // generation fails and we serve plain HTTP, this bind MUST stay on
    // 127.0.0.1 — never widen it. Rule 11's source-scan enforces the
    // literal '127.0.0.1' second-arg string; don't refactor it into a
    // variable or add a branch that uses a different host.
    httpServer.listen(0, '127.0.0.1', () => {
      wsPort = httpServer.address().port;
      const protocol = useTLS ? 'WSS+HTTPS' : 'WS+HTTP';
      console.log(`[${protocol}] Server listening on port ${wsPort}`);
      resolve(wsPort);
    });
  });
}

function setupConnectionHandler() {
  wss.on('connection', (ws) => {
    let authed = false;
    let authAttempts = 0;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // Auth handshake — must be first message
      if (!authed) {
        if (msg.type === 'auth' && tokensMatch(msg.token)) {
          authed = true;
          authenticatedClients.add(ws);
          ws.send(JSON.stringify({ type: 'auth-ok' }));
          console.log('[WS] Client authenticated');
        } else {
          authAttempts++;
          ws.send(JSON.stringify({ type: 'auth-fail' }));
          if (authAttempts >= 5) { ws.close(1008, 'Too many auth failures'); return; }
        }
        return;
      }

      // Route authenticated messages
      switch (msg.type) {
        case 'send-message':
          if (typeof msg.text !== 'string' || msg.text.length > 50000) break;
          if (onSendMessage) onSendMessage(msg.text);
          broadcastExcept(ws, 'user-message', { text: msg.text });
          break;
        case 'approve-tool':
          if (typeof msg.toolUseID !== 'string' || msg.toolUseID.length > 64) break;
          if (onApproveTool) onApproveTool(msg.toolUseID);
          break;
        case 'deny-tool':
          if (typeof msg.toolUseID !== 'string' || msg.toolUseID.length > 64) break;
          if (onDenyTool) onDenyTool(msg.toolUseID);
          break;
        case 'answer-question':
          if (typeof msg.toolUseID !== 'string' || msg.toolUseID.length > 64) break;
          if (typeof msg.answers !== 'object' || msg.answers === null) break;
          if (onAnswerQuestion) onAnswerQuestion(msg.toolUseID, msg.answers);
          break;
        case 'transcribe-audio': {
          // PWA mic hand-off: phone captures audio, desktop runs whisper.
          // We reply only to the requesting client, not broadcast, so the
          // transcript never leaks to other paired phones.
          if (typeof msg.requestId !== 'string' || msg.requestId.length > 64) break;
          if (typeof msg.mime !== 'string' || msg.mime.length > 64) break;
          if (typeof msg.data !== 'string' || msg.data.length > MAX_TRANSCRIBE_BYTES) {
            try { ws.send(JSON.stringify({ type: 'transcription', payload: { requestId: msg.requestId, error: 'too-large' } })); } catch {}
            break;
          }
          if (!onTranscribeAudio) break;
          Promise.resolve(onTranscribeAudio(msg.data, msg.mime))
            .then((result) => {
              const payload = { requestId: msg.requestId };
              if (result && typeof result.text === 'string') payload.text = result.text;
              if (result && typeof result.error === 'string') payload.error = result.error;
              try { ws.send(JSON.stringify({ type: 'transcription', payload })); } catch {}
            })
            .catch(() => {
              try { ws.send(JSON.stringify({ type: 'transcription', payload: { requestId: msg.requestId, error: 'internal' } })); } catch {}
            });
          break;
        }
      }
    });

    ws.on('close', () => {
      authenticatedClients.delete(ws);
      console.log('[WS] Client disconnected');
    });
  });
}

async function start() {
  await startServer();
  setupConnectionHandler();
}

// Broadcast to all authenticated PWA clients AND (if configured) out to the
// relay Worker so roaming phones see the same stream.
//
// Short-circuit discipline (task 4.1): if nothing is listening — no
// paired PWA AND no relay hook — return without ANY work (no try/catch
// entry, no JSON.stringify, no object-shape clone). Historical incident:
// before this gate, every stream chunk from main.js paid a full
// JSON.stringify even when zero clients were connected, which on a busy
// renderer (100+ stream events/s) added measurable latency to tool
// execution. Stringify is ALSO done once per broadcast (not once per
// client) — the existing loop already honored that, confirmed in situ.
function broadcast(type, payload) {
  broadcastStats.totalCalls++;
  const hasRelay = typeof relayForward === 'function';
  const hasClients = authenticatedClients.size > 0;
  if (!hasRelay && !hasClients) {
    broadcastStats.skippedNoListeners++;
    return;
  }
  if (hasRelay) {
    try { relayForward(type, payload); } catch { /* relay errors never break LAN */ }
  }
  if (!hasClients) return;
  const msg = JSON.stringify({ type, payload });
  broadcastStats.stringifiedCalls++;
  for (const client of authenticatedClients) {
    try {
      if (client.readyState === 1) client.send(msg);
    } catch { authenticatedClients.delete(client); }
  }
}

// Broadcast to all clients EXCEPT the sender. Same short-circuit as
// broadcast(): no clients → no work. broadcastExcept is only called from
// the auth'd message switch, so the sender itself is already in the set
// and size >= 1 in practice — but guard anyway for the "last client
// disconnected mid-message" race.
function broadcastExcept(sender, type, payload) {
  if (authenticatedClients.size === 0) return;
  const msg = JSON.stringify({ type, payload });
  for (const client of authenticatedClients) {
    try {
      if (client !== sender && client.readyState === 1) client.send(msg);
    } catch { authenticatedClients.delete(client); }
  }
}

// Get the local IP for QR code (same WiFi)
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function getConnectionInfo() {
  return {
    host: getLocalIP(),
    port: wsPort,
    token: sessionToken,
    secure: useTLS,
  };
}

module.exports = {
  startServer: start,
  broadcast,
  getConnectionInfo,
  setHandlers(handlers) {
    onSendMessage = handlers.onSendMessage;
    onApproveTool = handlers.onApproveTool;
    onDenyTool = handlers.onDenyTool;
    onAnswerQuestion = handlers.onAnswerQuestion;
    onTranscribeAudio = handlers.onTranscribeAudio;
  },
  setRelayForward,
  // Test-only hooks. NOT part of the public API — anything here can be
  // deleted or renamed without a version bump. Tests consume these to
  // verify 4.1 broadcast gating + 4.7 async cert flow without booting
  // a real Electron runtime. Production callers must use the exports
  // above.
  _testHooks: {
    resetBroadcastStats() {
      broadcastStats.totalCalls = 0;
      broadcastStats.stringifiedCalls = 0;
      broadcastStats.skippedNoListeners = 0;
    },
    getBroadcastStats() { return { ...broadcastStats }; },
    getAuthenticatedClients() { return authenticatedClients; },
    setExecFileImpl(fn) { _execFileImpl = (typeof fn === 'function') ? fn : execFile; },
    readCachedCert,
    generateCertAsync,
    getCertDir,
    certNotAfterMs,
    CERT_VALIDITY_DAYS,
    CERT_RENEW_THRESHOLD_MS,
    // Expose start/startServer distinctly so tests can bind the listener
    // without installing the WS connection handler (which would try to
    // attach to the wss global across test cases).
    startServerOnly: startServer,
    closeServer() {
      return new Promise((resolve) => {
        if (!httpServer) { resolve(); return; }
        try { httpServer.close(() => resolve()); }
        catch { resolve(); }
      });
    },
    setRelayForwardForTest(fn) { setRelayForward(fn); },
  },
};
