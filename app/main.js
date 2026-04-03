const { app, BrowserWindow, ipcMain, safeStorage, protocol, nativeTheme, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// Remove default menu bar
Menu.setApplicationMenu(null);

// App root — the folder containing CLAUDE.md, .claude/, assets/, etc.
const appRoot = app.isPackaged
  ? path.dirname(app.getPath('exe'))
  : path.join(__dirname, '..');

const keyFile = path.join(appRoot, '.r2-key');
let win = null;
let resolveNextMessage = null;
let pendingApprovals = new Map(); // toolUseID → resolve function
let activeQuery = null;

// ── Window ──────────────────────────────────────────────────

function createWindow() {
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
  protocol.handle('r2', (request) => {
    const filePath = path.join(appRoot, decodeURIComponent(request.url.replace('r2://', '')));
    return new Response(fs.readFileSync(filePath));
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    win.webContents.send('platform', process.platform);
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

// ── SDK Integration ─────────────────────────────────────────

// Tools that never need user approval
const autoApproveTools = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite',
  'Skill', 'Edit', 'Write', 'NotebookEdit', 'Agent',
]);

// Translate tool calls to plain English for approvals
function translateTool(toolName, input) {
  // Parse R2 binary commands
  if (toolName === 'Bash' && input.command && input.command.includes('R2')) {
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
    win.webContents.send('ask-user-question', {
      toolUseID,
      questions: input.questions,
    });
    return new Promise((resolve) => {
      pendingApprovals.set(toolUseID, (answers) => {
        resolve({ behavior: 'allow', updatedInput: { ...input, answers } });
      });
    });
  }

  // Everything else — show translated approval card
  const toolUseID = Date.now().toString();
  const translated = translateTool(toolName, input);

  win.webContents.send('approval-request', {
    toolUseID,
    label: translated.label,
    cost: translated.cost,
  });

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

async function startSession(apiKey) {
  // Dynamic import (ESM module)
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  // Streaming input — async generator that yields user messages on demand
  async function* messageGenerator() {
    // Initial greeting
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: 'Greet the user warmly. You are R2, their AI CMO. Be concise — one short paragraph. Then show 3 options: "Create an Ad", "Connect Ad Accounts", "What can you do?" as an AskUserQuestion.',
      },
    };

    // Subsequent messages from the renderer
    while (true) {
      const msg = await new Promise((resolve) => { resolveNextMessage = resolve; });
      if (msg === null) return;
      yield msg;
    }
  }

  activeQuery = query({
    prompt: messageGenerator(),
    options: {
      cwd: appRoot,
      permissionMode: 'acceptEdits',
      includePartialMessages: true,
      settingSources: ['project'],
      canUseTool: handleToolApproval,
      env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
    },
  });

  try {
    for await (const msg of activeQuery) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('sdk-message', JSON.parse(JSON.stringify(msg)));
      }
    }
  } catch (err) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('sdk-error', err.message || String(err));
    }
  }
}

// ── IPC Handlers ────────────────────────────────────────────

ipcMain.handle('check-setup', () => {
  const key = getApiKey();
  return { hasKey: !!key };
});

ipcMain.handle('save-api-key', (_, key) => {
  saveApiKey(key);
  return { success: true };
});

ipcMain.handle('start-session', () => {
  const apiKey = getApiKey();
  if (!apiKey) return { error: 'No API key' };
  startSession(apiKey); // fire and forget — messages come via events
  return { success: true };
});

ipcMain.handle('send-message', (_, text) => {
  if (resolveNextMessage) {
    resolveNextMessage({
      type: 'user',
      message: { role: 'user', content: text },
    });
  }
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

// ── App Lifecycle ───────────────────────────────────────────

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
