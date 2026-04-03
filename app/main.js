const { app, BrowserWindow, ipcMain, protocol, nativeTheme, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const wsServer = require('./ws-server');
const { generateQRDataUri } = require('./qr');

Menu.setApplicationMenu(null);

const appRoot = app.isPackaged
  ? path.dirname(app.getPath('exe'))
  : path.join(__dirname, '..');

let win = null;
let resolveNextMessage = null;
let pendingApprovals = new Map();
let activeQuery = null;

// Auto-expire pending approvals after 5 minutes to prevent memory leaks
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

// ── Window ──────────────────────────────────────────────────

async function createWindow() {
  nativeTheme.themeSource = 'dark';

  win = new BrowserWindow({
    width: 480,
    height: 720,
    minWidth: 380,
    minHeight: 500,
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#1a1a1c',
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Register protocol for inline images — with path traversal protection
  protocol.handle('merlin', (request) => {
    const requested = decodeURIComponent(request.url.replace('merlin://', ''));
    const filePath = path.resolve(appRoot, requested);
    const resolvedRoot = path.resolve(appRoot);
    if (!filePath.startsWith(resolvedRoot)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      return new Response(fs.readFileSync(filePath));
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  // Enable DevTools in dev mode (Ctrl+Shift+I)
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.control && input.shift && input.key === 'I') {
        win.webContents.toggleDevTools();
      }
    });
  }
  win.once('ready-to-show', () => {
    win.show();
    win.webContents.send('platform', process.platform);
  });

  // Start WebSocket server for PWA mobile clients
  await wsServer.startServer();
  wsServer.setHandlers({
    onSendMessage: (text) => {
      if (typeof text !== 'string' || text.length > 50000) return; // validate input
      if (resolveNextMessage) {
        resolveNextMessage({ type: 'user', message: { role: 'user', content: text } });
      }
      if (win && !win.isDestroyed()) {
        win.webContents.send('remote-user-message', text);
      }
    },
    onApproveTool: (toolUseID) => {
      const resolve = pendingApprovals.get(toolUseID);
      if (resolve) { resolve.fn(true); pendingApprovals.delete(toolUseID); }
    },
    onDenyTool: (toolUseID) => {
      const resolve = pendingApprovals.get(toolUseID);
      if (resolve) { resolve.fn(false); pendingApprovals.delete(toolUseID); }
    },
    onAnswerQuestion: (toolUseID, answers) => {
      const resolve = pendingApprovals.get(toolUseID);
      if (resolve) { resolve.fn(answers); pendingApprovals.delete(toolUseID); }
    },
  });
}

// Store a pending approval with auto-expiry timeout
function setPendingApproval(toolUseID, fn) {
  const timer = setTimeout(() => {
    const entry = pendingApprovals.get(toolUseID);
    if (entry) {
      entry.fn(false); // auto-deny on timeout
      pendingApprovals.delete(toolUseID);
    }
  }, APPROVAL_TIMEOUT_MS);
  pendingApprovals.set(toolUseID, { fn, timer });
}

// ── SDK Integration ─────────────────────────────────────────

const autoApproveTools = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite',
  'Skill', 'Edit', 'Write', 'NotebookEdit', 'Agent',
]);

// Safe Bash patterns that can be auto-approved (read-only or setup operations)
const safeBashPatterns = [
  /^ls\b/, /^cat\b/, /^head\b/, /^tail\b/, /^wc\b/, /^find\b/, /^grep\b/,
  /^mkdir\b/, /^cp\b/, /^mv\b/, /^echo\b/, /^pwd\b/, /^cd\b/, /^test\b/,
  /^curl\s.*-[sS]/, /^curl\s.*download/, /^chmod\b/, /^xattr\b/, /^codesign\b/,
  /^node\s+-e\b/, /^npx\b/,
];

function isSafeBash(command) {
  const cmd = (command || '').trim();
  return safeBashPatterns.some(p => p.test(cmd));
}

// Translate tool calls to plain English for approval cards
function translateTool(toolName, input) {
  // Merlin binary commands — always translate to friendly text
  if (toolName === 'Bash' && input.command && input.command.includes('Merlin')) {
    const cmdMatch = input.command.match(/"action"\s*:\s*"([^"]+)"/);
    const action = cmdMatch ? cmdMatch[1] : null;
    const translations = {
      'meta-push':     { label: 'Publish this ad to Facebook', cost: '$5/day budget' },
      'meta-setup':    { label: 'Set up your ad campaigns on Facebook', cost: 'Free' },
      'meta-kill':     { label: 'Pause this ad', cost: 'Free' },
      'meta-duplicate':{ label: 'Scale this winning ad', cost: 'Increases budget' },
      'meta-login':    { label: 'Connect to your Facebook Ads account', cost: 'Free' },
      'meta-discover': { label: 'Find your ad accounts', cost: 'Free' },
      'image':         { label: 'Generate an ad image', cost: '~$0.04' },
      'generate':      { label: 'Create a video ad', cost: '~$0.50' },
      'batch':         { label: 'Generate multiple ad variations', cost: '~$0.04 each' },
      'blog-post':     { label: 'Publish a blog post to Shopify', cost: 'Free' },
      'seo-audit':     { label: 'Run an SEO audit on your store', cost: 'Free' },
      'tiktok-push':   { label: 'Publish this ad to TikTok', cost: '$5/day budget' },
      'tiktok-login':  { label: 'Connect to your TikTok Ads account', cost: 'Free' },
      'shopify-login': { label: 'Connect to your Shopify store', cost: 'Free' },
      'api-key-setup': { label: 'Set up an image generation account', cost: 'Free' },
      'verify-key':    { label: 'Verify your API connection', cost: 'Free' },
    };
    if (action && translations[action]) return translations[action];
  }

  // Generic Bash — use friendly description, never show raw command
  if (toolName === 'Bash') {
    // Use Claude's description if it provided one, otherwise generic
    const desc = input.description;
    if (desc) {
      // Clean up technical jargon for non-technical users
      return { label: desc, cost: null };
    }
    return { label: 'Merlin needs to run a setup step', cost: null };
  }

  return { label: 'Merlin needs your permission to continue', cost: null };
}

async function handleToolApproval(toolName, input) {
  if (autoApproveTools.has(toolName)) {
    return { behavior: 'allow', updatedInput: input };
  }

  // Auto-approve safe Bash commands (read-only, setup, file management)
  if (toolName === 'Bash' && isSafeBash(input.command)) {
    return { behavior: 'allow', updatedInput: input };
  }

  if (toolName === 'AskUserQuestion') {
    const toolUseID = Date.now().toString();
    const payload = { toolUseID, questions: input.questions };
    win.webContents.send('ask-user-question', payload);
    wsServer.broadcast('ask-user-question', payload);
    return new Promise((resolve) => {
      setPendingApproval(toolUseID, (answers) => {
        resolve({ behavior: 'allow', updatedInput: { ...input, answers } });
      });
    });
  }

  const toolUseID = Date.now().toString();
  const translated = translateTool(toolName, input);
  const payload = { toolUseID, label: translated.label, cost: translated.cost };
  win.webContents.send('approval-request', payload);
  wsServer.broadcast('approval-request', payload);

  return new Promise((resolve) => {
    setPendingApproval(toolUseID, (approved) => {
      if (approved) {
        resolve({ behavior: 'allow', updatedInput: input });
      } else {
        resolve({ behavior: 'deny', message: 'User declined' });
      }
    });
  });
}

async function startSession() {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  async function* messageGenerator() {
    yield { type: 'user', message: { role: 'user', content: 'Run /cmo silently — do the preflight checks but do NOT print anything. No greetings, no banners, no feature lists. The app UI already showed my welcome message. Check assets/brands/ for existing brand folders (ignore "example"). If a brand ALREADY exists, skip setup — just say "✦ [Brand] is ready — [X] products loaded. What would you like to create?" If NO brands exist, wait for my URL. IMPORTANT RULE: When showing images, include the full file path in your response text like this: results/img_20260403_164511/image_1_portrait.jpg — the app will render it inline automatically. Always include the path, never just describe the image.' } };
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

ipcMain.handle('check-setup', async () => {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    const child = exec('claude --version', { timeout: 3000 });
    child.on('close', (code) => {
      resolve(code === 0
        ? { ready: true }
        : { ready: false, reason: 'Claude Desktop not found. Install it from claude.ai/download' });
    });
    child.on('error', () => {
      resolve({ ready: false, reason: 'Claude Desktop not found. Install it from claude.ai/download' });
    });
  });
});

ipcMain.handle('start-session', () => { startSession(); return { success: true }; });

ipcMain.handle('get-account-info', async () => {
  try {
    if (!activeQuery) return null;
    const info = await activeQuery.accountInfo();
    return info;
  } catch { return null; }
});

ipcMain.handle('send-message', (_, text) => {
  if (typeof text !== 'string' || text.length > 50000) return { success: false };
  if (resolveNextMessage) {
    resolveNextMessage({ type: 'user', message: { role: 'user', content: text } });
  }
  wsServer.broadcast('user-message', { text });
  return { success: true };
});

ipcMain.handle('approve-tool', (_, toolUseID) => {
  const entry = pendingApprovals.get(toolUseID);
  if (entry) { clearTimeout(entry.timer); entry.fn(true); pendingApprovals.delete(toolUseID); }
});

ipcMain.handle('deny-tool', (_, toolUseID) => {
  const entry = pendingApprovals.get(toolUseID);
  if (entry) { clearTimeout(entry.timer); entry.fn(false); pendingApprovals.delete(toolUseID); }
});

ipcMain.handle('answer-question', (_, toolUseID, answers) => {
  const entry = pendingApprovals.get(toolUseID);
  if (entry) { clearTimeout(entry.timer); entry.fn(answers); pendingApprovals.delete(toolUseID); }
});

ipcMain.handle('open-claude-download', () => { shell.openExternal('https://claude.ai/download'); });

// Fetch credit balances for connected platforms
ipcMain.handle('get-credits', async () => {
  const configPath = path.join(appRoot, '.claude', 'tools', 'merlin-config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }

  const credits = {};
  const https = require('https');

  function fetchJSON(url, headers) {
    return new Promise((resolve) => {
      const req = https.get(url, { headers: { ...headers, 'User-Agent': 'Merlin' } }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    });
  }

  // HeyGen
  if (cfg.heygenApiKey) {
    const data = await fetchJSON('https://api.heygen.com/v2/user/remaining_quota', { 'X-Api-Key': cfg.heygenApiKey });
    if (data?.data?.remaining_quota != null) credits.heygen = `${data.data.remaining_quota} credits`;
  }

  // ElevenLabs
  if (cfg.elevenLabsApiKey) {
    const data = await fetchJSON('https://api.elevenlabs.io/v1/user', { 'xi-api-key': cfg.elevenLabsApiKey });
    if (data?.subscription) {
      const s = data.subscription;
      const used = s.character_count || 0;
      const limit = s.character_limit || 0;
      const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
      credits.elevenlabs = `${pct}% used`;
    }
  }

  return credits;
});
ipcMain.handle('win-minimize', () => { if (win) win.minimize(); });
ipcMain.handle('win-maximize', () => { if (win) { win.isMaximized() ? win.unmaximize() : win.maximize(); } });
ipcMain.handle('win-close', () => { if (win) win.close(); });

ipcMain.handle('get-mobile-qr', async () => {
  const info = wsServer.getConnectionInfo();
  const pwaUrl = `http://${info.host}:${info.port}?token=${info.token}`;
  const qrDataUri = await generateQRDataUri(pwaUrl);
  return { qrDataUri, pwaUrl, ...info };
});

ipcMain.handle('apply-update', () => { downloadAndApplyUpdate(); });
ipcMain.handle('restart-app', () => { app.relaunch(); app.exit(0); });

// ── Auto-Update ─────────────────────────────────────────────

function httpsGet(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Merlin-Desktop' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      let body = [];
      res.on('data', (c) => body.push(c));
      res.on('end', () => resolve(Buffer.concat(body)));
    }).on('error', reject);
  });
}

async function checkForUpdates() {
  try {
    const currentVersion = require('../package.json').version;
    const raw = await httpsGet('https://api.github.com/repos/oathgames/Merlin/releases/latest');
    const data = JSON.parse(raw);
    if (!data || !data.tag_name) return; // validate response
    const latestVersion = data.tag_name.replace(/^v/, '');
    if (!latestVersion || latestVersion === currentVersion) return;
    if (win && !win.isDestroyed()) {
      win.webContents.send('update-available', { current: currentVersion, latest: latestVersion });
    }
  } catch { /* silent — don't break app if update check fails */ }
}

async function downloadAndApplyUpdate() {
  try {
    const currentVersion = require('../package.json').version;
    const raw = await httpsGet('https://api.github.com/repos/oathgames/Merlin/releases/latest');
    const data = JSON.parse(raw);
    if (!data || !data.tag_name) throw new Error('Invalid release data');
    const latestVersion = data.tag_name.replace(/^v/, '');
    if (!latestVersion || latestVersion === currentVersion) return;

    if (win && !win.isDestroyed()) win.webContents.send('update-progress', 'Downloading...');

    const versionJson = JSON.parse(await httpsGet(`https://raw.githubusercontent.com/oathgames/Merlin/${data.tag_name}/version.json`));

    for (const filePath of (versionJson.updatable || [])) {
      try {
        const content = await httpsGet(`https://raw.githubusercontent.com/oathgames/Merlin/${data.tag_name}/${filePath}`);
        const fullPath = path.join(appRoot, filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
      } catch { /* skip individual file failures */ }
    }

    const binaryName = process.platform === 'win32' ? 'Merlin-windows-amd64.exe'
      : (process.platform === 'darwin' && process.arch === 'arm64') ? 'Merlin-darwin-arm64'
      : process.platform === 'darwin' ? 'Merlin-darwin-amd64'
      : 'Merlin-linux-amd64';

    const binaryAsset = (data.assets || []).find(a => a.name === binaryName);
    if (binaryAsset) {
      if (win && !win.isDestroyed()) win.webContents.send('update-progress', 'Downloading binary...');
      const binary = await httpsGet(binaryAsset.browser_download_url);
      const binaryPath = path.join(appRoot, '.claude', 'tools', process.platform === 'win32' ? 'Merlin.exe' : 'Merlin');
      if (fs.existsSync(binaryPath)) fs.copyFileSync(binaryPath, binaryPath + '.backup');
      fs.writeFileSync(binaryPath, binary);
      if (process.platform !== 'win32') fs.chmodSync(binaryPath, 0o755);
      try { fs.unlinkSync(binaryPath + '.backup'); } catch {}
    }

    const pkgPath = path.join(appRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.version = latestVersion;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    }

    if (win && !win.isDestroyed()) win.webContents.send('update-ready', { latest: latestVersion });
  } catch (err) {
    if (win && !win.isDestroyed()) win.webContents.send('update-error', err.message || String(err));
  }
}

// ── App Lifecycle ───────────────────────────────────────────

app.whenReady().then(async () => {
  await createWindow();
  setTimeout(checkForUpdates, 10000);
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
