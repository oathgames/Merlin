const { app, BrowserWindow, ipcMain, safeStorage, protocol, nativeTheme, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const wsServer = require('./ws-server');
const { generateQRDataUri } = require('./qr');

// Remove default menu bar
Menu.setApplicationMenu(null);

// App root — the folder containing CLAUDE.md, .claude/, assets/, etc.
const appRoot = app.isPackaged
  ? path.dirname(app.getPath('exe'))
  : path.join(__dirname, '..');

const keyFile = path.join(appRoot, '.merlin-key');
let win = null;
let resolveNextMessage = null;
let pendingApprovals = new Map(); // toolUseID → resolve function
let activeQuery = null;

// ── Window ──────────────────────────────────────────────────

async function createWindow() {
  nativeTheme.themeSource = 'dark';

  win = new BrowserWindow({
    width: 480,
    height: 720,
    minWidth: 380,
    minHeight: 500,
    // Native OS window controls (close/minimize/maximize)
    backgroundColor: '#08080a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Register protocol for inline images
  protocol.handle('merlin', (request) => {
    const filePath = path.join(appRoot, decodeURIComponent(request.url.replace('merlin://', '')));
    return new Response(fs.readFileSync(filePath));
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    win.webContents.send('platform', process.platform);
  });

  // Start WebSocket server for PWA mobile clients
  await wsServer.startServer();
  wsServer.setHandlers({
    onSendMessage: (text) => {
      if (resolveNextMessage) {
        resolveNextMessage({ type: 'user', message: { role: 'user', content: text } });
      }
      // Show PWA user's message on desktop
      if (win && !win.isDestroyed()) {
        win.webContents.send('remote-user-message', text);
      }
    },
    onApproveTool: (toolUseID) => {
      const resolve = pendingApprovals.get(toolUseID);
      if (resolve) { resolve(true); pendingApprovals.delete(toolUseID); }
    },
    onDenyTool: (toolUseID) => {
      const resolve = pendingApprovals.get(toolUseID);
      if (resolve) { resolve(false); pendingApprovals.delete(toolUseID); }
    },
    onAnswerQuestion: (toolUseID, answers) => {
      const resolve = pendingApprovals.get(toolUseID);
      if (resolve) { resolve(answers); pendingApprovals.delete(toolUseID); }
    },
  });
}

// ── API Key (encrypted) ─────────────────────────────────────

function getApiKey() {
  try {
    if (!fs.existsSync(keyFile)) return null;
    const encrypted = fs.readFileSync(keyFile);
    return safeStorage.decryptString(encrypted);
  } catch { return null; }
}

function saveApiKey(key) {
  const encrypted = safeStorage.encryptString(key);
  fs.writeFileSync(keyFile, encrypted);
}

// Open Claude Desktop download page in user's default browser
function openClaudeDownload() {
  shell.openExternal('https://claude.ai/download');
}

ipcMain.handle('open-claude-download', () => {
  openClaudeDownload();
});

ipcMain.handle('get-mobile-qr', async () => {
  const info = wsServer.getConnectionInfo();
  // PWA served from the same HTTP server as WebSocket — no mixed-content issues
  const pwaUrl = `http://${info.host}:${info.port}?token=${info.token}`;
  const qrDataUri = await generateQRDataUri(pwaUrl);
  return { qrDataUri, pwaUrl, ...info };
});

// ── SDK Integration ─────────────────────────────────────────

// Tools that never need user approval
const autoApproveTools = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite',
  'Skill', 'Edit', 'Write', 'NotebookEdit', 'Agent',
]);

// Translate tool calls to plain English for approvals
function translateTool(toolName, input) {
  // Parse Merlin binary commands
  if (toolName === 'Bash' && input.command && input.command.includes('Merlin')) {
    const cmdMatch = input.command.match(/"action"\s*:\s*"([^"]+)"/);
    const action = cmdMatch ? cmdMatch[1] : null;
    const translations = {
      'meta-push':    { label: 'Publish this ad to Facebook', cost: '$5/day budget' },
      'meta-setup':   { label: 'Set up your ad campaigns on Facebook', cost: 'Free' },
      'meta-kill':    { label: 'Pause this ad', cost: 'Free' },
      'meta-duplicate': { label: 'Scale this winning ad', cost: 'Increases budget' },
      'meta-login':   { label: 'Connect to your Facebook Ads account', cost: 'Free' },
      'meta-discover': { label: 'Find your ad accounts', cost: 'Free' },
      'image':        { label: 'Generate an ad image', cost: '~$0.04' },
      'generate':     { label: 'Create a video ad', cost: '~$0.50' },
      'batch':        { label: 'Generate multiple ad variations', cost: '~$0.04 each' },
      'blog-post':    { label: 'Publish a blog post to Shopify', cost: 'Free' },
      'seo-audit':    { label: 'Run an SEO audit on your store', cost: 'Free' },
      'tiktok-push':  { label: 'Publish this ad to TikTok', cost: '$5/day budget' },
      'tiktok-login': { label: 'Connect to your TikTok Ads account', cost: 'Free' },
      'shopify-login':{ label: 'Connect to your Shopify store', cost: 'Free' },
      'api-key-setup':{ label: 'Set up an image generation account', cost: 'Free' },
      'verify-key':   { label: 'Verify your API connection', cost: 'Free' },
    };
    if (action && translations[action]) return translations[action];
  }

  // Generic bash commands
  if (toolName === 'Bash') {
    const desc = input.description || input.command;
    return { label: desc, cost: null };
  }

  return { label: `${toolName}: ${JSON.stringify(input).substring(0, 100)}`, cost: null };
}

async function handleToolApproval(toolName, input, context) {
  // Auto-approve safe tools
  if (autoApproveTools.has(toolName)) {
    return { behavior: 'allow', updatedInput: input };
  }

  // AskUserQuestion — forward to renderer as interactive chips
  if (toolName === 'AskUserQuestion') {
    const toolUseID = Date.now().toString();
    const askPayload = { toolUseID, questions: input.questions };
    win.webContents.send('ask-user-question', askPayload);
    wsServer.broadcast('ask-user-question', askPayload);
    return new Promise((resolve) => {
      pendingApprovals.set(toolUseID, (answers) => {
        resolve({ behavior: 'allow', updatedInput: { ...input, answers } });
      });
    });
  }

  // Everything else — show translated approval card
  const toolUseID = Date.now().toString();
  const translated = translateTool(toolName, input);

  const approvalPayload = { toolUseID, label: translated.label, cost: translated.cost };
  win.webContents.send('approval-request', approvalPayload);
  wsServer.broadcast('approval-request', approvalPayload);

  return new Promise((resolve) => {
    pendingApprovals.set(toolUseID, (approved) => {
      if (approved) {
        resolve({ behavior: 'allow', updatedInput: input });
      } else {
        resolve({ behavior: 'deny', message: 'User declined' });
      }
    });
  });
}

async function startSession() {
  // Dynamic import (ESM module)
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  // Streaming input — async generator that yields user messages on demand
  async function* messageGenerator() {
    // Fire /cmo immediately — get right into the value
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: '/cmo',
      },
    };

    // Subsequent messages from the renderer
    while (true) {
      const msg = await new Promise((resolve) => { resolveNextMessage = resolve; });
      if (msg === null) return;
      yield msg;
    }
  }

  // No API key needed — uses the user's existing Claude Pro/Max auth
  // via the Claude Code CLI that's already installed and authenticated
  activeQuery = query({
    prompt: messageGenerator(),
    options: {
      cwd: appRoot,
      permissionMode: 'acceptEdits',
      includePartialMessages: true,
      settingSources: ['project'],
      canUseTool: handleToolApproval,
    },
  });

  try {
    for await (const msg of activeQuery) {
      if (win && !win.isDestroyed()) {
        const serialized = JSON.parse(JSON.stringify(msg));
        win.webContents.send('sdk-message', serialized);
        wsServer.broadcast('sdk-message', serialized);
      }
    }
  } catch (err) {
    if (win && !win.isDestroyed()) {
      const errMsg = err.message || String(err);
      win.webContents.send('sdk-error', errMsg);
      wsServer.broadcast('sdk-error', errMsg);
    }
  }
}

// ── IPC Handlers ────────────────────────────────────────────

ipcMain.handle('check-setup', () => {
  // Check if claude CLI is available (user has Claude Desktop installed)
  const { execSync } = require('child_process');
  try {
    execSync('claude --version', { stdio: 'ignore', timeout: 5000 });
    return { ready: true };
  } catch {
    return { ready: false, reason: 'Claude Desktop not found. Install it from claude.ai/download' };
  }
});

ipcMain.handle('start-session', () => {
  startSession(); // No API key — uses existing Claude auth
  return { success: true };
});

ipcMain.handle('send-message', (_, text) => {
  if (resolveNextMessage) {
    resolveNextMessage({
      type: 'user',
      message: { role: 'user', content: text },
    });
  }
  // Show desktop user's message on PWA
  wsServer.broadcast('user-message', { text });
  return { success: true };
});

ipcMain.handle('approve-tool', (_, toolUseID) => {
  const resolve = pendingApprovals.get(toolUseID);
  if (resolve) {
    resolve(true);
    pendingApprovals.delete(toolUseID);
  }
});

ipcMain.handle('deny-tool', (_, toolUseID) => {
  const resolve = pendingApprovals.get(toolUseID);
  if (resolve) {
    resolve(false);
    pendingApprovals.delete(toolUseID);
  }
});

ipcMain.handle('answer-question', (_, toolUseID, answers) => {
  const resolve = pendingApprovals.get(toolUseID);
  if (resolve) {
    resolve(answers);
    pendingApprovals.delete(toolUseID);
  }
});

// ── Auto-Update ─────────────────────────────────────────────

async function checkForUpdates() {
  try {
    const https = require('https');
    const currentVersion = require('../package.json').version;

    const data = await new Promise((resolve, reject) => {
      https.get('https://api.github.com/repos/oathgames/Merlin/releases/latest', {
        headers: { 'User-Agent': 'Merlin-Desktop' }
      }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });

    const latestVersion = (data.tag_name || '').replace(/^v/, '');
    if (latestVersion && latestVersion !== currentVersion) {
      // Notify renderer
      if (win && !win.isDestroyed()) {
        win.webContents.send('update-available', {
          current: currentVersion,
          latest: latestVersion,
          url: data.html_url,
        });
      }
    }
  } catch { /* silent — don't break the app if update check fails */ }
}

// ── App Lifecycle ───────────────────────────────────────────

app.whenReady().then(async () => {
  await createWindow();
  // Check for updates on launch + every 4 hours
  checkForUpdates();
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
