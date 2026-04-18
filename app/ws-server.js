const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { app } = require('electron');

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

// Optional outbound mirror — set by relay-client.js to fan every LAN
// broadcast out to the merlin-relay Worker so roaming PWAs see the same
// stream. Returning false from this hook means "not connected right now";
// LAN delivery is independent.
let relayForward = null;
function setRelayForward(fn) { relayForward = (typeof fn === 'function') ? fn : null; }

function getCertDir() {
  // Prefer the per-user Electron userData dir so the private key never lands
  // in a world-readable /tmp. Fall back to tmpdir only if userData is not
  // available (unit tests, non-Electron context).
  try {
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), '.merlin-certs');
    }
  } catch { /* fall through */ }
  return path.join(os.tmpdir(), '.merlin-certs');
}

function getOrCreateCert() {
  const certDir = getCertDir();
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    try {
      // Best-effort tightening in case an earlier version created the files
      // with default umask. chmod is a no-op on Windows but harmless.
      try { fs.chmodSync(keyPath, 0o600); } catch {}
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    } catch { /* regenerate */ }
  }

  try {
    // 0700 on the dir so only the current user can enumerate cert files.
    fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(certDir, 0o700); } catch {}
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=localhost" 2>/dev/null`, { stdio: 'pipe' });
    // openssl writes key.pem with default umask (typically 0644). Tighten to
    // 0600 so other local users cannot read the RSA private key.
    try { fs.chmodSync(keyPath, 0o600); } catch {}
    try { fs.chmodSync(certPath, 0o644); } catch {}
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  } catch {
    return null; // openssl not available, fall back to HTTP
  }
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

    // Try HTTPS/WSS first, fall back to HTTP/WS
    const certs = getOrCreateCert();
    if (certs) {
      const https = require('https');
      httpServer = https.createServer(certs, requestHandler);
      useTLS = true;
    } else {
      httpServer = http.createServer(requestHandler);
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
function broadcast(type, payload) {
  if (relayForward) {
    try { relayForward(type, payload); } catch { /* relay errors never break LAN */ }
  }
  if (authenticatedClients.size === 0) return;
  const msg = JSON.stringify({ type, payload });
  for (const client of authenticatedClients) {
    try {
      if (client.readyState === 1) client.send(msg);
    } catch { authenticatedClients.delete(client); }
  }
}

// Broadcast to all clients EXCEPT the sender
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
  },
  setRelayForward,
};
