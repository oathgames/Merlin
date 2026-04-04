const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Generate a session token — random, never stored to disk
const sessionToken = crypto.randomBytes(16).toString('hex');

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

function getOrCreateCert() {
  const certDir = path.join(os.tmpdir(), '.merlin-certs');
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    try {
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    } catch { /* regenerate */ }
  }

  try {
    fs.mkdirSync(certDir, { recursive: true });
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=localhost" 2>/dev/null`, { stdio: 'pipe' });
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
      const fullPath = path.join(pwaDir, filePath);
      const ext = path.extname(fullPath);
      if (fs.existsSync(fullPath)) {
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain', 'Access-Control-Allow-Origin': allowedOrigin });
        res.end(fs.readFileSync(fullPath));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': allowedOrigin });
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

    wss = new WebSocketServer({ server: httpServer });

    httpServer.listen(0, '0.0.0.0', () => {
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

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // Auth handshake — must be first message
      if (!authed) {
        if (msg.type === 'auth' && msg.token === sessionToken) {
          authed = true;
          authenticatedClients.add(ws);
          ws.send(JSON.stringify({ type: 'auth-ok' }));
          console.log('[WS] Client authenticated');
        } else {
          ws.send(JSON.stringify({ type: 'auth-fail' }));
          ws.close();
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

// Broadcast to all authenticated PWA clients
function broadcast(type, payload) {
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
};
