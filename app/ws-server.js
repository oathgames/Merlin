const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const os = require('os');

// Generate a session token — random, never stored to disk
const sessionToken = crypto.randomBytes(16).toString('hex');

let wss = null;
let wsPort = 0;
const authenticatedClients = new Set();

// Message handlers — set by main.js to bridge into SDK
let onSendMessage = null;
let onApproveTool = null;
let onDenyTool = null;
let onAnswerQuestion = null;

function startServer() {
  return new Promise((resolve) => {
    wss = new WebSocketServer({ host: '0.0.0.0', port: 0 }, () => {
      wsPort = wss.address().port;
      console.log(`[WS] Server listening on port ${wsPort}`);
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
          if (onSendMessage) onSendMessage(msg.text);
          break;
        case 'approve-tool':
          if (onApproveTool) onApproveTool(msg.toolUseID);
          break;
        case 'deny-tool':
          if (onDenyTool) onDenyTool(msg.toolUseID);
          break;
        case 'answer-question':
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
  const msg = JSON.stringify({ type, payload });
  for (const client of authenticatedClients) {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
    }
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
