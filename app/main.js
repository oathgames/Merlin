const { app, BrowserWindow, ipcMain, protocol, nativeTheme, Menu, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const wsServer = require('./ws-server');
const { generateQRDataUri } = require('./qr');

Menu.setApplicationMenu(null);

const appRoot = app.isPackaged
  ? (process.platform === 'darwin'
    ? path.join(path.dirname(app.getPath('exe')), '..', 'Resources')
    : path.dirname(app.getPath('exe')))
  : path.join(__dirname, '..');

let win = null;
let resolveNextMessage = null;
let pendingApprovals = new Map();
let activeQuery = null;

// Auto-expire pending approvals after 5 minutes to prevent memory leaks
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;

// ── Window ──────────────────────────────────────────────────

async function createWindow() {
  nativeTheme.themeSource = 'dark';

  win = new BrowserWindow({
    width: 900,
    height: 670,
    minWidth: 500,
    minHeight: 400,
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#1a1a1c',
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: process.platform === 'darwin' ? { x: 12, y: 12 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

  // Grant microphone permission for voice input (Web Speech API)
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') { callback(true); return; }
    callback(false);
  });

  // Enable DevTools in dev mode (Ctrl+Shift+I on Windows, Cmd+Option+I on Mac)
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (event, input) => {
      const devToolsTriggered = process.platform === 'darwin'
        ? (input.meta && input.alt && input.key.toLowerCase() === 'i')
        : (input.control && input.shift && input.key === 'I');
      if (devToolsTriggered) win.webContents.toggleDevTools();
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
      'amazon-login':  { label: 'Connect to your Amazon account', cost: 'Free' },
      'amazon-ads-push': { label: 'Create a Sponsored Products ad on Amazon', cost: '$10/day budget' },
      'amazon-ads-kill': { label: 'Pause this Amazon campaign', cost: 'Free' },
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

  // Auto-approve OAuth login flows — user already clicked the tile to connect
  if (toolName === 'Bash' && input.command && input.command.includes('Merlin')) {
    const cmdMatch = input.command.match(/"action"\s*:\s*"([^"]+)"/);
    const action = cmdMatch ? cmdMatch[1] : '';
    if (action.endsWith('-login')) {
      return { behavior: 'allow', updatedInput: input };
    }
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

// Personal email domains — if user's email is on one of these, we can't infer their brand
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com',
  'mail.com','protonmail.com','proton.me','zoho.com','yandex.com','live.com',
  'msn.com','me.com','mac.com','hey.com','fastmail.com','tutanota.com',
]);

function inferBrandDomain() {
  try {
    const cfg = readConfig();
    const email = cfg._userEmail;
    if (!email || !email.includes('@')) return null;
    const domain = email.split('@')[1].toLowerCase();
    if (PERSONAL_EMAIL_DOMAINS.has(domain)) return null;
    return domain;
  } catch { return null; }
}

async function startSession() {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  // Try to infer brand domain from cached Claude account email
  const inferredDomain = inferBrandDomain();
  const domainHint = inferredDomain
    ? ` DOMAIN HINT: The user's email domain is "${inferredDomain}". When asking for their website, pre-fill the first AskUserQuestion option as: label: "${inferredDomain}", description: "Is this your brand? We'll scan it automatically". Add a second option: label: "Different website", description: "Enter a different URL". And a third: label: "Just exploring", description: "See what Merlin can do — no setup needed".`
    : '';

  async function* messageGenerator() {
    yield { type: 'user', message: { role: 'user', content: `Run /merlin silently — do the preflight checks but do NOT print anything. No greetings, no banners, no feature lists. The app UI already showed my welcome message. Check assets/brands/ for existing brand folders (ignore "example"). If a brand ALREADY exists, skip setup — just say "✦ [Brand] is ready — [X] products loaded. What would you like to create?" If NO brands exist, use the AskUserQuestion tool to ask "What's your website?" with these options: (1) label: "Set up my brand", description: "Enter your website URL and we'll auto-detect your brand, products, and colors" (2) label: "Just exploring", description: "See what Merlin can do — no setup needed".${domainHint} IMPORTANT: When the user provides their website URL (or picks their domain from the options), start working IMMEDIATELY — scrape the site with WebFetch, extract brand colors, find products, identify competitors with WebSearch. Do ALL of this in parallel with the binary download. Don't wait for the binary. Show results as you find them: "Found your brand colors: #xxx, #yyy", "Spotted 12 products", "Your top competitors look like X, Y, Z". This gives the user instant value. The binary download and config setup happen in the background via preflight. If the user selects "Just exploring", give a 3-sentence pitch of what Merlin does and ask what they'd like to try. IMPORTANT RULE: When showing images, include the full file path in your response text like this: results/img_20260403_164511/image_1_portrait.jpg — the app will render it inline automatically. Always include the path, never just describe the image.` } };
    while (true) {
      const msg = await new Promise((resolve) => { resolveNextMessage = resolve; });
      if (msg === null) return;
      yield msg;
    }
  }

  // Guard against concurrent sessions
  if (activeQuery) {
    console.warn('[SDK] Session already active, skipping duplicate start');
    return;
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

  // Capture user email from Claude account (for telemetry + Stripe pre-fill + domain inference)
  try {
    const acctInfo = await activeQuery.accountInfo();
    if (acctInfo?.email) {
      const cfg = readConfig();
      const isNewEmail = !cfg._userEmail || cfg._userEmail !== acctInfo.email;
      if (isNewEmail) {
        cfg._userEmail = acctInfo.email;
        writeConfig(cfg);
        // First-time user: if we can infer a brand domain and no brands exist yet,
        // send a hint so Claude can suggest it mid-conversation
        const domain = acctInfo.email.split('@')[1]?.toLowerCase();
        if (domain && !PERSONAL_EMAIL_DOMAINS.has(domain) && !inferredDomain) {
          const brandsDir = path.join(appRoot, 'assets', 'brands');
          let hasBrands = false;
          try {
            hasBrands = fs.readdirSync(brandsDir, { withFileTypes: true })
              .some(d => d.isDirectory() && d.name !== 'example');
          } catch {}
          if (!hasBrands && resolveNextMessage) {
            resolveNextMessage({ type: 'user', message: { role: 'user', content:
              `(System note: I just detected the user's email domain is "${domain}". If you haven't already asked for their website, suggest this domain as their brand. If you already asked, ignore this.)`
            }});
          }
        }
      }
    }
  } catch {}

  try {
    for await (const msg of activeQuery) {
      if (win && !win.isDestroyed()) {
        const serialized = JSON.parse(JSON.stringify(msg));
        win.webContents.send('sdk-message', serialized);
        wsServer.broadcast('sdk-message', serialized);

        // Spellbook: detect task-related MCP tool calls and task lifecycle events
        if (msg.type === 'tool_use' && msg.tool_name && msg.tool_name.includes('scheduled-tasks')) {
          win.webContents.send('spell-activity', { tool: msg.tool_name, input: msg.input });
        }
        if (msg.type === 'system' && msg.subtype === 'task_notification') {
          const taskId = msg.task_id || '';
          const status = msg.status || '';
          win.webContents.send('spell-completed', {
            taskId, status,
            summary: msg.summary, timestamp: Date.now()
          });
          // Report spell completion to wisdom API for aggregate insights
          try {
            const https = require('https');
            const req = https.request('https://api.merlingotme.com/api/ping', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000,
            });
            req.write(JSON.stringify({
              id: getMachineId(), v: getCurrentVersion(), p: process.platform,
              e: `spell-${status}`, vt: readConfig().vertical || '',
              t: getSubscriptionState().subscribed ? 'pro' : 'trial',
              spell: taskId.replace(/^merlin-/, ''),
            }));
            req.end();
            req.on('error', () => {});
          } catch {}
        }
      }
    }
  } catch (err) {
    if (win && !win.isDestroyed()) {
      const errMsg = err.message || String(err);
      win.webContents.send('sdk-error', errMsg);
      wsServer.broadcast('sdk-error', errMsg);
    }
  } finally {
    // Always reset so session can be restarted after error or completion
    activeQuery = null;
    resolveNextMessage = null;
  }
}

// ── IPC Handlers ────────────────────────────────────────────

ipcMain.handle('check-setup', async () => {
  const { exec } = require('child_process');

  // On macOS, Claude CLI may not be on PATH — check common locations
  const candidates = ['claude'];
  if (process.platform === 'darwin') {
    candidates.push(
      '/usr/local/bin/claude',
      path.join(os.homedir(), '.claude', 'bin', 'claude'),
      path.join(os.homedir(), '.local', 'bin', 'claude')
    );
  }

  for (const cmd of candidates) {
    const found = await new Promise((resolve) => {
      const child = exec(`"${cmd}" --version`, { timeout: 10000 });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
    if (found) return { ready: true };
  }

  const macTip = process.platform === 'darwin'
    ? '\n\nAlready have Claude Desktop? Open it → Settings → Developer → "Install Claude Code CLI"'
    : '';
  return { ready: false, reason: 'Merlin\'s AI engine isn\'t installed yet.' + macTip };
});

ipcMain.handle('start-session', () => { startSession(); return { success: true }; });

// Morning briefing — reads cached briefing generated by scheduled spells
ipcMain.handle('get-briefing', () => {
  const briefingFile = path.join(appRoot, '.merlin-briefing.json');
  try {
    if (!fs.existsSync(briefingFile)) return null;
    const data = JSON.parse(fs.readFileSync(briefingFile, 'utf8'));
    // Only show if briefing is from today or yesterday (not stale)
    const briefingDate = new Date(data.date);
    const now = new Date();
    const ageHours = (now - briefingDate) / (1000 * 60 * 60);
    if (ageHours > 36) return null; // stale — more than 36 hours old
    // Only show once per day — check if already dismissed today
    const stateFile = path.join(appRoot, '.merlin-state.json');
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.lastBriefingDismissed === now.toISOString().slice(0, 10)) return null;
    } catch {}
    return data;
  } catch { return null; }
});

ipcMain.handle('dismiss-briefing', () => {
  const stateFile = path.join(appRoot, '.merlin-state.json');
  try {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    state.lastBriefingDismissed = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch {}
  return { success: true };
});

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
  try {
    const entry = pendingApprovals.get(toolUseID);
    if (entry) { clearTimeout(entry.timer); pendingApprovals.delete(toolUseID); entry.fn(true); }
  } catch (err) { console.error('[approve]', err.message); }
});

ipcMain.handle('deny-tool', (_, toolUseID) => {
  try {
    const entry = pendingApprovals.get(toolUseID);
    if (entry) { clearTimeout(entry.timer); pendingApprovals.delete(toolUseID); entry.fn(false); }
  } catch (err) { console.error('[deny]', err.message); }
});

ipcMain.handle('answer-question', (_, toolUseID, answers) => {
  try {
    const entry = pendingApprovals.get(toolUseID);
    if (entry) { clearTimeout(entry.timer); pendingApprovals.delete(toolUseID); entry.fn(answers); }
  } catch (err) { console.error('[answer]', err.message); }
});

ipcMain.handle('open-claude-download', () => { shell.openExternal('https://claude.ai/download'); });

ipcMain.handle('check-claude-running', async () => {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? 'tasklist /FI "IMAGENAME eq Claude.exe" /NH'
      : 'pgrep -x "Claude" || pgrep -f "Claude Desktop"';
    const child = exec(cmd, { timeout: 5000 });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.on('close', () => {
      if (process.platform === 'win32') {
        resolve(output.toLowerCase().includes('claude.exe'));
      } else {
        resolve(output.trim().length > 0);
      }
    });
    child.on('error', () => resolve(false));
  });
});

// ── Session State Persistence ───────────────────────────────
const stateFile = path.join(appRoot, '.merlin-state.json');

ipcMain.handle('save-state', (_, data) => {
  try {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    Object.assign(state, data);
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    return { success: true };
  } catch { return { success: false }; }
});

ipcMain.handle('load-state', () => {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
});

// ── Config helpers ──────────────────────────────────────────
function readConfig() {
  const configPath = path.join(appRoot, '.claude', 'tools', 'merlin-config.json');
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  const configPath = path.join(appRoot, '.claude', 'tools', 'merlin-config.json');
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Atomic write: write to temp file, then rename (prevents corruption on crash)
    const tmpPath = configPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmpPath, configPath);
  } catch (err) { console.error('[config] write failed:', err.message); }
}

// Encrypted read/write for sensitive local state (subscription, machine ID)
// Uses OS keychain via Electron safeStorage — not readable by other processes
function readSecureFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
    return buf.toString('utf8'); // fallback if encryption unavailable
  } catch { return null; }
}
function writeSecureFile(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(filePath, safeStorage.encryptString(data));
    } else {
      fs.writeFileSync(filePath, data);
    }
  } catch {}
}

// Check which platforms are connected by reading the config
ipcMain.handle('get-connected-platforms', () => {
  const configPath = path.join(appRoot, '.claude', 'tools', 'merlin-config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const connected = [];
    if (cfg.metaAccessToken) connected.push('meta');
    if (cfg.tiktokAccessToken) connected.push('tiktok');
    if (cfg.shopifyAccessToken && cfg.shopifyStore) connected.push('shopify');
    if (cfg.klaviyoApiKey || cfg.klaviyoAccessToken) connected.push('klaviyo');
    if (cfg.googleAccessToken || cfg.googleAdsCustomerId) connected.push('google');
    if (cfg.pinterestAccessToken) connected.push('pinterest');
    if (cfg.falApiKey) connected.push('fal');
    if (cfg.elevenLabsApiKey) connected.push('elevenlabs');
    if (cfg.heygenApiKey) connected.push('heygen');
    if (cfg.amazonAccessToken) connected.push('amazon');
    if (cfg.slackBotToken || cfg.slackWebhookUrl) connected.push('slack');
    return connected;
  } catch { return []; }
});

// ── Spellbook (Scheduled Tasks) ────────────────────────────
ipcMain.handle('list-spells', () => {
  const tasksDir = path.join(os.homedir(), '.claude', 'scheduled-tasks');
  if (!fs.existsSync(tasksDir)) return [];

  const cfg = readConfig();
  const spellMeta = cfg.spells || {};

  try {
    const dirs = fs.readdirSync(tasksDir, { withFileTypes: true }).filter(d => d.isDirectory());
    return dirs.map(d => {
      let name = d.name, description = '';
      const skillPath = path.join(tasksDir, d.name, 'SKILL.md');
      try {
        const content = fs.readFileSync(skillPath, 'utf8');
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const nameMatch = fmMatch[1].match(/name:\s*(.+)/);
          const descMatch = fmMatch[1].match(/description:\s*["']?(.+?)["']?\s*$/m);
          if (nameMatch) name = nameMatch[1].trim();
          if (descMatch) description = descMatch[1].trim();
        }
      } catch {}

      const meta = spellMeta[d.name] || {};
      return {
        id: d.name,
        name,
        description,
        cron: meta.cron || null,
        enabled: meta.enabled !== false,
        lastRun: meta.lastRun || null,
        isMerlin: d.name.startsWith('merlin-'),
      };
    }).filter(t => t.isMerlin);
  } catch { return []; }
});

ipcMain.handle('update-spell-meta', (_, taskId, meta) => {
  const cfg = readConfig();
  if (!cfg.spells) cfg.spells = {};
  cfg.spells[taskId] = { ...cfg.spells[taskId], ...meta };
  writeConfig(cfg);
  return { success: true };
});

ipcMain.handle('toggle-spell', (_, taskId, enabled) => {
  if (!taskId || typeof taskId !== 'string') return { success: false, error: 'invalid taskId' };

  // Update local meta
  const cfg = readConfig();
  if (!cfg.spells) cfg.spells = {};
  cfg.spells[taskId] = { ...cfg.spells[taskId], enabled };
  writeConfig(cfg);

  // Ask Claude to actually enable/disable via MCP
  if (resolveNextMessage) {
    resolveNextMessage({
      type: 'user',
      message: { role: 'user', content:
        `Silently ${enabled ? 'enable' : 'disable'} the scheduled task "${taskId}" using update_scheduled_task. Don't explain, just do it and confirm in one short sentence.`
      }
    });
    return { success: true, synced: true };
  }
  // Session not active — local state updated but MCP not called
  return { success: true, synced: false };
});

// Read brands from filesystem
ipcMain.handle('get-brands', () => {
  const brandsDir = path.join(appRoot, 'assets', 'brands');
  try {
    const dirs = fs.readdirSync(brandsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'example')
      .map(d => {
        const brandPath = path.join(brandsDir, d.name);
        const brandMd = path.join(brandPath, 'brand.md');
        let vertical = '';
        if (fs.existsSync(brandMd)) {
          const content = fs.readFileSync(brandMd, 'utf8');
          const match = content.match(/vertical[:\s]+(\w+)/i);
          if (match) vertical = match[1];
        }
        // Count products
        const productsDir = path.join(brandPath, 'products');
        let productCount = 0;
        try { productCount = fs.readdirSync(productsDir, { withFileTypes: true }).filter(d => d.isDirectory()).length; } catch {}

        // Human-readable display name from brand.md, fall back to smart title case
        let displayName = d.name;
        if (fs.existsSync(brandMd)) {
          const content = fs.readFileSync(brandMd, 'utf8');
          // Try: "# BrandName" (markdown heading, most common)
          const h1Match = content.match(/^#\s+(.+)$/m);
          if (h1Match) {
            displayName = h1Match[1].trim();
          } else {
            // Try: "Brand: X" or "Name: X"
            const fieldMatch = content.match(/^(?:Brand|Name)[:\s]+["']?([^\n"']+)/im);
            if (fieldMatch) displayName = fieldMatch[1].trim();
          }
        }
        if (displayName === d.name) {
          // Smart title case: "ivory-ella" → "Ivory Ella", "mad-chill" → "Mad Chill"
          displayName = d.name.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        }

        return { name: d.name, displayName, vertical, productCount };
      });
    return dirs;
  } catch { return []; }
});

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
ipcMain.handle('get-version', () => getCurrentVersion());
ipcMain.handle('win-minimize', () => { if (win) win.minimize(); });
ipcMain.handle('win-maximize', () => { if (win) { win.isMaximized() ? win.unmaximize() : win.maximize(); } });
ipcMain.handle('win-close', () => { if (win) win.close(); });

ipcMain.handle('get-mobile-qr', async () => {
  const info = wsServer.getConnectionInfo();
  const protocol = info.secure ? 'https' : 'http';
  const pwaUrl = `${protocol}://${info.host}:${info.port}`;
  const qrDataUri = await generateQRDataUri(`${pwaUrl}#${info.token}`);
  return { qrDataUri, pwaUrl, ...info };
});

ipcMain.handle('save-pasted-media', (_, dataUrl, filename) => {
  try {
    // Sanitize filename — strip path traversal, keep only the basename
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!safeName || safeName.startsWith('.')) return null;
    const resultsDir = path.join(appRoot, 'results');
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
    const filePath = path.join(resultsDir, safeName);
    const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return `results/${safeName}`;
  } catch (err) {
    console.error('[media-save]', err.message);
    return null;
  }
});

// ── Subscription / Trial / License ──────────────────────────

// Whitelist keys for testers — stored as HMAC hashes, never plaintext
// Whitelist keys validated via HMAC hash comparison
const VALID_KEY_HASHES = {
  'dd1a602f79a5fd7d': 5,  // test key — 5 uses max
  'cd1c3ef01b913d64': 99, // beta key
};

function hashKey(key) {
  const crypto = require('crypto');
  return crypto.createHmac('sha256', 'merlin-salt-2026').update(key).digest('hex').slice(0, 16);
}

// Machine fingerprint for Stripe checkout + license polling (persistent)
function getMachineId() {
  const machineIdFile = path.join(appRoot, '.merlin-machine-id');
  try {
    const existing = fs.readFileSync(machineIdFile, 'utf8').trim();
    if (existing && existing.length >= 16) return existing;
  } catch {}

  const crypto = require('crypto');
  const raw = `${os.hostname()}|${os.userInfo().username}|${os.platform()}|${os.arch()}|${Date.now()}`;
  const id = crypto.createHash('sha256').update(raw).digest('hex');
  try {
    fs.mkdirSync(path.dirname(machineIdFile), { recursive: true });
    fs.writeFileSync(machineIdFile, id);
  } catch {}
  return id;
}

function getSubscriptionState() {
  const subFile = path.join(appRoot, '.merlin-subscription');
  try {
    if (fs.existsSync(subFile)) {
      // Try encrypted read first, fallback to plaintext for migration
      let raw = readSecureFile(subFile);
      if (!raw) raw = fs.readFileSync(subFile, 'utf8');
      const data = JSON.parse(raw);
      if (data.subscribed) return { subscribed: true, tier: data.tier || 'pro', key: data.key || '' };
    }
  } catch {}

  // Trial: 7-day from first launch
  const trialFile = path.join(appRoot, '.merlin-trial');
  let trialStart;
  if (fs.existsSync(trialFile)) {
    trialStart = parseInt(fs.readFileSync(trialFile, 'utf8'));
  } else {
    trialStart = Date.now();
    try { fs.writeFileSync(trialFile, String(trialStart)); } catch {}
  }
  // Add referral bonus days (max 70 = 10 referrals)
  let bonusDays = 0;
  try { bonusDays = parseInt(fs.readFileSync(path.join(appRoot, '.merlin-referral-bonus'), 'utf8')) || 0; } catch {}
  bonusDays = Math.min(Math.max(bonusDays, 0), 70);
  const totalTrialDays = 7 + bonusDays;
  const daysLeft = Math.max(0, totalTrialDays - Math.floor((Date.now() - trialStart) / (1000 * 60 * 60 * 24)));
  return { subscribed: false, daysLeft, bonusDays, trialStart, expired: daysLeft === 0 };
}

ipcMain.handle('get-subscription', () => getSubscriptionState());

ipcMain.handle('activate-key', (_, key) => {
  if (!key || typeof key !== 'string') return { success: false, error: 'Invalid key' };
  const trimmed = key.trim().toLowerCase();
  const hashed = hashKey(trimmed);

  // Check whitelist (hash the input, compare against stored hashes)
  const maxUses = VALID_KEY_HASHES[hashed];
  if (maxUses !== undefined) {
    // Track usage count in a local file
    const usageFile = path.join(appRoot, '.merlin-key-usage.json');
    let usage = {};
    try { usage = JSON.parse(fs.readFileSync(usageFile, 'utf8')); } catch {}
    const used = usage[hashed] || 0;
    if (used >= maxUses) {
      return { success: false, error: 'This key has reached its activation limit.' };
    }
    usage[hashed] = used + 1;
    try { fs.writeFileSync(usageFile, JSON.stringify(usage, null, 2)); } catch {}

    const subFile = path.join(appRoot, '.merlin-subscription');
    try {
      writeSecureFile(subFile, JSON.stringify({ subscribed: true, tier: 'pro', activatedAt: Date.now() }));
    } catch (err) {
      return { success: false, error: 'Could not save activation' };
    }
    return { success: true, tier: 'pro' };
  }

  return { success: false, error: 'Invalid key. Check your email or visit merlingotme.com' };
});

let _activationPoller = null;

ipcMain.handle('open-subscribe', async () => {
  const machineId = getMachineId();
  // Pre-fill email from Claude account if available
  let emailParam = '';
  try {
    if (activeQuery) {
      const info = await activeQuery.accountInfo();
      if (info?.email) emailParam = `&prefilled_email=${encodeURIComponent(info.email)}`;
    }
  } catch {}
  // Append attribution if present
  let attrSuffix = '';
  try {
    const attrFile = path.join(appRoot, '.merlin-attribution');
    if (fs.existsSync(attrFile)) {
      const attr = JSON.parse(fs.readFileSync(attrFile, 'utf8'));
      const safeCode = encodeURIComponent(attr.code || '');
      if (attr.type === 'affiliate') attrSuffix = `__aff_${safeCode}`;
      else if (attr.type === 'referral') attrSuffix = `__ref_${safeCode}`;
    }
  } catch {}
  shell.openExternal(`https://buy.stripe.com/5kQfZggqt73f7MMca85wI00?client_reference_id=${machineId}${attrSuffix}${emailParam}`);

  // Poll for activation every 10s for 10 minutes after opening checkout
  if (_activationPoller) clearInterval(_activationPoller);
  let attempts = 0;
  _activationPoller = setInterval(async () => {
    attempts++;
    if (attempts > 60) { clearInterval(_activationPoller); _activationPoller = null; return; }

    try {
      const raw = await httpsGet(`https://merlingotme.com/api/check-license?id=${machineId}`);
      const data = JSON.parse(raw.toString());
      if (data.activated) {
        clearInterval(_activationPoller);
        _activationPoller = null;
        // Write encrypted subscription file
        const subFile = path.join(appRoot, '.merlin-subscription');
        writeSecureFile(subFile, JSON.stringify({ subscribed: true, tier: 'pro', activatedAt: Date.now(), via: 'stripe' }));
        // Notify renderer
        if (win && !win.isDestroyed()) {
          win.webContents.send('subscription-activated', { tier: 'pro' });
        }
      }
    } catch {}
  }, 10000);
});

ipcMain.handle('open-manage', () => {
  shell.openExternal('https://billing.stripe.com/p/login/5kQfZggqt73f7MMca85wI00');
});

// ── Referral System ────────────────────────────────────────
ipcMain.handle('get-referral-info', async () => {
  try {
    const machineId = getMachineId();
    const raw = await httpsGet(`https://merlingotme.com/api/check-referral?id=${machineId}`);
    return JSON.parse(raw.toString());
  } catch { return { referralCode: getMachineId().slice(0, 8), referralCount: 0, trialExtensionDays: 0 }; }
});

ipcMain.handle('apply-referral-code', async (_, code) => {
  if (!code || typeof code !== 'string') return { success: false, error: 'Invalid code' };
  const trimmed = code.trim().toLowerCase().slice(0, 8);
  if (!/^[0-9a-f]{8}$/.test(trimmed)) return { success: false, error: 'Invalid referral code format' };

  const machineId = getMachineId();
  try {
    const https = require('https');
    const payload = JSON.stringify({ referrer: trimmed, referred: machineId });
    const raw = await new Promise((resolve, reject) => {
      const req = https.request('https://merlingotme.com/api/register-referral', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 10000,
      }, (res) => {
        let body = []; res.on('data', c => body.push(c)); res.on('end', () => resolve(Buffer.concat(body)));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(payload);
      req.end();
    });
    const result = JSON.parse(raw.toString());
    if (result.ok) {
      // Save attribution for Stripe checkout
      const attrFile = path.join(appRoot, '.merlin-attribution');
      fs.writeFileSync(attrFile, JSON.stringify({ type: 'referral', code: trimmed }));
      return { success: true, bonus: result.bonus };
    }
    return { success: false, error: result.error || 'Could not register referral' };
  } catch (err) {
    return { success: false, error: 'Network error — try again' };
  }
});

ipcMain.handle('apply-update', () => { downloadAndApplyUpdate(); });
ipcMain.handle('restart-app', () => { app.relaunch(); app.exit(0); });

// ── Auto-Update ─────────────────────────────────────────────

function httpsGet(url, _depth = 0) {
  if (_depth > 10) return Promise.reject(new Error('Too many redirects'));
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Merlin-Desktop' }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, _depth + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = [];
      res.on('data', (c) => body.push(c));
      res.on('end', () => resolve(Buffer.concat(body)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function getCurrentVersion() {
  // Read fresh from disk every time — require() caches the old version
  try {
    return JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
  } catch {
    return require('../package.json').version;
  }
}

async function checkForUpdates() {
  try {
    const currentVersion = getCurrentVersion();
    const raw = await httpsGet('https://api.github.com/repos/oathgames/Merlin/releases/latest');
    const data = JSON.parse(raw.toString());
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
    const currentVersion = getCurrentVersion();
    const raw = await httpsGet('https://api.github.com/repos/oathgames/Merlin/releases/latest');
    const data = JSON.parse(raw.toString());
    if (!data || !data.tag_name) throw new Error('Invalid release data');
    const latestVersion = data.tag_name.replace(/^v/, '');
    if (!latestVersion || latestVersion === currentVersion) return;

    if (win && !win.isDestroyed()) win.webContents.send('update-progress', 'Downloading...');

    const versionJson = JSON.parse((await httpsGet(`https://raw.githubusercontent.com/oathgames/Merlin/${data.tag_name}/version.json`)).toString());

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
      // Verify binary is valid (at least 1MB, not an error page)
      if (binary.length < 1024 * 1024) {
        throw new Error('Downloaded binary too small — possible corrupted download');
      }
      // Check for SHA256 checksum if published in release
      const checksumAsset = (data.assets || []).find(a => a.name === 'checksums.txt');
      if (checksumAsset) {
        try {
          const checksumFile = (await httpsGet(checksumAsset.browser_download_url)).toString();
          const expectedHash = checksumFile.split('\n')
            .map(l => l.trim().split(/\s+/))
            .find(parts => parts[1] === binaryName)?.[0];
          if (expectedHash) {
            const crypto = require('crypto');
            const actualHash = crypto.createHash('sha256').update(binary).digest('hex');
            if (actualHash !== expectedHash) {
              throw new Error(`Binary checksum mismatch: expected ${expectedHash.slice(0,12)}..., got ${actualHash.slice(0,12)}...`);
            }
          }
        } catch (e) {
          if (e.message.includes('checksum mismatch')) throw e;
          // Checksum file couldn't be fetched — continue without verification
        }
      }
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

// Single instance lock — prevent multiple windows
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  await createWindow();
  setTimeout(checkForUpdates, 10000);
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);

  // Lightweight telemetry — one ping on launch, no PII
  setTimeout(() => {
    try {
      const sub = getSubscriptionState();
      const cfg = readConfig();
      const payload = JSON.stringify({
        id: getMachineId(),
        v: getCurrentVersion(),
        p: process.platform,
        e: 'launch',
        vt: cfg.vertical || '',
        t: sub.subscribed ? 'pro' : 'trial',
      });
      const https = require('https');
      const req = https.request('https://api.merlingotme.com/api/ping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000,
      });
      req.write(payload);
      req.end();
      req.on('error', () => {});
    } catch {}
  }, 5000);

  // Register referral code on startup + hourly bonus check
  setTimeout(async () => {
    try {
      const machineId = getMachineId();
      const https = require('https');
      // Register our referral code
      const req = https.request('https://merlingotme.com/api/register-referral-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000,
      });
      req.write(JSON.stringify({ machineId }));
      req.end();
      req.on('error', () => {});

      // Check for bonus days
      const raw = await httpsGet(`https://merlingotme.com/api/check-referral?id=${machineId}`);
      const data = JSON.parse(raw.toString());
      if (data.trialExtensionDays > 0) {
        fs.writeFileSync(path.join(appRoot, '.merlin-referral-bonus'), String(data.trialExtensionDays));
      }
    } catch {}
  }, 8000);

  // Hourly referral bonus refresh
  setInterval(async () => {
    try {
      const raw = await httpsGet(`https://merlingotme.com/api/check-referral?id=${getMachineId()}`);
      const data = JSON.parse(raw.toString());
      if (data.trialExtensionDays > 0) {
        fs.writeFileSync(path.join(appRoot, '.merlin-referral-bonus'), String(data.trialExtensionDays));
      }
    } catch {}
  }, 60 * 60 * 1000);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
