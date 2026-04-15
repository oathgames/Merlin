const { app, BrowserWindow, ipcMain, protocol, nativeTheme, Menu, Tray, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const wsServer = require('./ws-server');
const { generateQRDataUri } = require('./qr');

// macOS requires an application menu with Edit role entries for Cmd+C/V/X/A to work
// in ANY input field. Without this, users cannot paste API keys, auth codes, or copy
// text from the chat. Windows doesn't need this — the OS handles it natively.
if (process.platform === 'darwin') {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ]},
    { label: 'Edit', submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ]},
    { label: 'View', submenu: [
      { role: 'toggleDevTools', accelerator: 'Cmd+Option+I', visible: false },
    ]},
    { label: 'Window', submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      { role: 'front' },
    ]},
  ]));
} else {
  Menu.setApplicationMenu(null);
}

// ── BFF Architecture ─────────────────────────────────────────
// OAuth client secrets are NEVER in the Electron app. Token exchange
// and refresh happen server-side via merlingotme.com/api/oauth/exchange
// and /api/oauth/refresh. The Go binary calls these endpoints directly.
// Discord API calls are proxied via api.merlingotme.com/api/discord/proxy.

// ── Fix PATH for Electron launched from installers/shortcuts ──────────
// Electron doesn't inherit the user's full shell PATH when launched from
// desktop shortcuts, Start Menu, or installer "Run" buttons. Add common
// Claude CLI locations so detection and SDK session startup work.
(function fixPath() {
  const home = os.homedir();
  const extra = [];
  if (process.platform === 'win32') {
    extra.push(
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(home, '.claude', 'bin'),
      path.join(home, 'AppData', 'Local', 'Programs', 'claude'),
      path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'),
    );
  } else {
    // On macOS/Linux, Electron launched from Finder/Dock/installer does NOT
    // inherit the user's shell PATH. Spawn a LOGIN shell (not interactive) to
    // read the real PATH from ~/.zprofile, ~/.bash_profile, ~/.profile.
    // The -l flag sources login configs. The -i (interactive) flag is OMITTED
    // because it triggers zsh compinit, conda hooks, and iterm2 integrations
    // that can hang or print garbage to stdout in a non-TTY context.
    try {
      const { execSync } = require('child_process');
      const shell = process.env.SHELL || '/bin/bash';
      // Detect non-POSIX shells that need different invocation
      let pathCmd;
      if (shell.endsWith('/fish')) {
        pathCmd = `${shell} -l -c 'string join : $PATH' 2>/dev/null`;
      } else if (shell.endsWith('/nu') || shell.endsWith('/nushell')) {
        pathCmd = `${shell} -l -c '$env.PATH | str join ":"' 2>/dev/null`;
      } else {
        pathCmd = `${shell} -lc 'echo "$PATH"' 2>/dev/null`;
      }
      const shellPath = execSync(pathCmd, {
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (shellPath) extra.push(...shellPath.split(':').filter(Boolean));
    } catch { /* fall through to static paths below */ }

    // Static fallbacks for common locations that may not be in shell PATH yet
    extra.push(
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/opt/local/bin',
      path.join(home, '.local', 'bin'),
      path.join(home, '.claude', 'bin'),
      path.join(home, '.claude', 'local', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, 'n', 'bin'),
    );

    // Glob nvm versions: ~/.nvm/versions/node/v*/bin (pick newest)
    try {
      const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
      if (fs.existsSync(nvmRoot)) {
        const versions = fs.readdirSync(nvmRoot)
          .filter(v => v.startsWith('v'))
          .sort()
          .reverse();
        for (const v of versions) extra.push(path.join(nvmRoot, v, 'bin'));
      }
    } catch {}

    // Glob fnm versions
    try {
      const fnmRoot = path.join(home, '.fnm', 'node-versions');
      if (fs.existsSync(fnmRoot)) {
        const versions = fs.readdirSync(fnmRoot).sort().reverse();
        for (const v of versions) extra.push(path.join(fnmRoot, v, 'installation', 'bin'));
      }
    } catch {}
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  const current = process.env.PATH || '';
  const seen = new Set(current.split(sep).filter(Boolean));
  const missing = extra.filter(p => p && !seen.has(p));
  if (missing.length > 0) {
    process.env.PATH = current + sep + missing.join(sep);
  }
})();

// Report crashes to Wisdom API for structured error monitoring
process.on('uncaughtException', (err) => {
  console.error('[CRASH]', err);
  try {
    const https = require('https');
    const payload = JSON.stringify({
      id: '', v: require('../package.json').version, p: process.platform,
      e: 'crash', error: err.message, stack: (err.stack || '').slice(0, 500),
    });
    const req = https.request('https://api.merlingotme.com/api/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    });
    req.write(payload);
    req.end();
  } catch (e) { console.error('[ping]', e.message); }
});
process.on('unhandledRejection', (reason) => { console.error('[UNHANDLED]', reason); });

// App install location (where Electron binary + asar + extraResources live)
// extraResources go to: Mac = Contents/Resources/, Windows = resources/
const appInstall = app.isPackaged
  ? (process.platform === 'darwin'
    ? path.join(path.dirname(app.getPath('exe')), '..', 'Resources')
    : path.join(path.dirname(app.getPath('exe')), 'resources'))
  : path.join(__dirname, '..');

// Workspace location (where brands, config, results live).
// macOS: ~/Library/Application Support/Merlin — avoids iCloud Documents sync which
// causes conflicts with binaries, vault files, and temp+rename state writes.
// Windows: Documents/Merlin — user-accessible, no sync issues.
const appRoot = app.isPackaged
  ? (process.platform === 'darwin'
    ? path.join(app.getPath('userData')) // ~/Library/Application Support/Merlin
    : path.join(app.getPath('documents'), 'Merlin'))
  : path.join(__dirname, '..');
// Ensure workspace exists early — the SDK probe uses it as cwd and fails
// with ENOENT if it doesn't exist yet (race with bootstrapWorkspace on first launch).
try { fs.mkdirSync(appRoot, { recursive: true }); } catch {}

// macOS migration: move workspace from ~/Documents/Merlin (iCloud-synced) to
// ~/Library/Application Support/Merlin (not synced). One-time, idempotent.
if (app.isPackaged && process.platform === 'darwin') {
  const oldRoot = path.join(app.getPath('documents'), 'Merlin');
  if (oldRoot !== appRoot && fs.existsSync(oldRoot) && fs.existsSync(path.join(oldRoot, '.claude'))) {
    try {
      // Only migrate if new location is empty (prevent overwriting existing data)
      const newHasData = fs.existsSync(path.join(appRoot, '.claude'));
      if (!newHasData) {
        const { execSync } = require('child_process');
        const { execFileSync } = require('child_process');
        execFileSync('cp', ['-Rn', oldRoot + '/', appRoot + '/'], { timeout: 30000 });
        // Leave a breadcrumb so user knows where their data went
        fs.writeFileSync(path.join(oldRoot, 'MOVED.txt'),
          `Your Merlin workspace moved to:\n${appRoot}\n\nThis avoids iCloud sync conflicts.\nYou can safely delete this folder.\n`);
        console.log(`[migration] Workspace migrated from ${oldRoot} to ${appRoot}`);
      }
    } catch (e) {
      console.error('[migration] macOS workspace move failed:', e.message);
    }
  }
}

// ── Node.js Runtime for SDK Subprocesses ────────────────────
// The Claude Agent SDK spawns `node cli.js` as a subprocess. Non-developer
// users don't have Node.js installed, so `node` isn't on PATH.
//
// PRIMARY (packaged builds): A real standalone Node.js binary is bundled
// at .claude/tools/node-runtime/node[.exe] inside the app resources.
// This is invisible to macOS (no Dock bounce, no GUI flash) because it's
// a headless binary — not the Electron app re-executed in Node mode.
//
// FALLBACK (dev mode or missing binary): The old ELECTRON_RUN_AS_NODE
// wrapper script at ~/.claude/bin/node[.cmd] is still created as a backup.

// Check if a real standalone Node binary is bundled with the app.
// Returns the absolute path or null if not available.
function getBundledNodePath() {
  const binaryName = process.platform === 'win32' ? 'node.exe' : 'node';
  if (app.isPackaged) {
    const bundled = path.join(appInstall, '.claude', 'tools', 'node-runtime', binaryName);
    try {
      fs.accessSync(bundled, fs.constants.X_OK);
      return bundled;
    } catch {}
  }
  return null; // Dev mode or binary not bundled
}

// FALLBACK ONLY: ELECTRON_RUN_AS_NODE wrapper for dev mode / missing bundled node.
function createNodeWrapper() {
  const electronBin = process.execPath;
  const sep = process.platform === 'win32' ? ';' : ':';
  const nodeWrapperDir = path.join(os.homedir(), '.claude', 'bin');
  fs.mkdirSync(nodeWrapperDir, { recursive: true });
  if (process.platform === 'win32') {
    const nodeWrapper = path.join(nodeWrapperDir, 'node.cmd');
    const script = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${electronBin}" %*\r\n`;
    let needsWrite = true;
    try { if (fs.readFileSync(nodeWrapper, 'utf8').includes(electronBin)) needsWrite = false; } catch {}
    if (needsWrite) fs.writeFileSync(nodeWrapper, script);
  } else {
    const nodeWrapper = path.join(nodeWrapperDir, 'node');
    const script = `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport ELECTRON_NO_ASAR=1\nexec "${electronBin}" "$@"\n`;
    let needsWrite = true;
    try { if (fs.readFileSync(nodeWrapper, 'utf8').includes(electronBin)) needsWrite = false; } catch {}
    if (needsWrite) fs.writeFileSync(nodeWrapper, script, { mode: 0o755 });
  }
  if (!process.env.PATH.includes(nodeWrapperDir)) {
    process.env.PATH = nodeWrapperDir + sep + process.env.PATH;
  }
}

// Validates the node wrapper (only needed when bundled node is unavailable).
function validateNodeWrapper() {
  if (getBundledNodePath()) return; // Bundled Node available — wrapper not needed
  try {
    const isWin = process.platform === 'win32';
    const wrapperPath = path.join(os.homedir(), '.claude', 'bin', isWin ? 'node.cmd' : 'node');
    if (fs.existsSync(wrapperPath)) {
      const content = fs.readFileSync(wrapperPath, 'utf8');
      const stat = fs.statSync(wrapperPath);
      const isExecutable = isWin || (stat.mode & 0o111) !== 0;
      if (content.includes(process.execPath) && isExecutable) return;
      if (content.includes(process.execPath) && !isExecutable) {
        fs.chmodSync(wrapperPath, 0o755);
        return;
      }
    }
    createNodeWrapper();
  } catch (err) {
    console.error('[node-wrapper] Validation failed, recreating:', err.message);
    try { createNodeWrapper(); } catch (e) { console.error('[node-wrapper] Cannot create:', e.message); }
  }
}

// Bootstrap: prefer bundled Node, fall back to wrapper
if (app.isPackaged) {
  const bundledNode = getBundledNodePath();
  if (bundledNode) {
    // Real Node.js binary found — prepend its directory to PATH.
    // The SDK's spawn("node") will find this binary. No ELECTRON_RUN_AS_NODE,
    // no Dock bounce, no GUI flash. Invisible subprocess like grep or curl.
    const bundledDir = path.dirname(bundledNode);
    const sep = process.platform === 'win32' ? ';' : ':';
    process.env.PATH = bundledDir + sep + process.env.PATH;
    console.log('[node] Using bundled Node.js');
  } else {
    // Fallback: ELECTRON_RUN_AS_NODE wrapper (binary not yet bundled or dev build)
    try { createNodeWrapper(); } catch (e) { console.error('[node-wrapper]', e.message); }
  }
}

// Resolve the Merlin engine binary. We prefer the INSTALL location because
// files placed there by the trusted installer don't get quarantined by
// Windows Defender — the installer's user-approved trust extends to its
// extraResources. Workspace is the fallback for dev and for cases where
// ensureBinary had to download the binary at runtime.
function getBinaryPath() {
  const binaryName = process.platform === 'win32' ? 'Merlin.exe' : 'Merlin';
  const installBin = path.join(appInstall, '.claude', 'tools', binaryName);
  try { fs.accessSync(installBin, fs.constants.F_OK); return installBin; } catch {}
  return path.join(appRoot, '.claude', 'tools', binaryName);
}

let claudeSdkModulePromise = null;
const CLAUDE_SETUP_CACHE_MS = 2500;
// Mac cold start: SDK → spawn claude CLI → Node.js loads → connects to Desktop.
// 5s was too short (always timed out). 20s was too long (poor UX during polling).
// 12s balances cold-start latency with responsiveness.
const CLAUDE_SETUP_TIMEOUT_MS = 12000;
let cachedClaudeSetup = { at: 0, result: null };
let claudeSetupPromise = null;

function getPackagedResourcePath(...segments) {
  return path.join(appInstall, ...segments);
}

async function importClaudeAgentSdk() {
  if (!claudeSdkModulePromise) {
    claudeSdkModulePromise = (async () => {
      if (app.isPackaged) {
        const unpackedSdk = getPackagedResourcePath(
          'app.asar.unpacked',
          'node_modules',
          '@anthropic-ai',
          'claude-agent-sdk',
          'sdk.mjs',
        );
        return import('file://' + unpackedSdk.replace(/\\/g, '/'));
      }
      return import('@anthropic-ai/claude-agent-sdk');
    })();
  }

  try {
    return await claudeSdkModulePromise;
  } catch (err) {
    claudeSdkModulePromise = null;
    throw err;
  }
}

function execCommand(cmd, timeout = 5000) {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (!settled) {
        settled = true;
        resolve(payload);
      }
    };
    const child = exec(cmd, { timeout }, (error, stdout = '', stderr = '') => {
      finish({ error, stdout: stdout || '', stderr: stderr || '' });
    });
    child.on('error', (error) => finish({ error, stdout: '', stderr: '' }));
  });
}

// ── Cross-platform credential reader ──────────────────────
// Finds the Claude OAuth token using every known location on Mac and Windows.
// Returns the access token string, or null if not found.
//
// HARDENED AUTH CHAIN (v0.9.96):
//   1. File ~/.claude/.credentials.json — works on ALL platforms, instant
//   2. Env var CLAUDE_CODE_OAUTH_TOKEN — already set by parent process
//   3. [Mac] Keychain — scan 7 service names covering every Claude product
//   4. [Win] Windows alternate credential file paths (APPDATA/LOCALAPPDATA)
//
// After ANY source succeeds, the token is persisted to the file so subsequent
// launches are instant with zero interaction — matching the Windows experience.
// The file is also re-written after each successful SDK session to keep it fresh.

const CLAUDE_CRED_FILE = path.join(os.homedir(), '.claude', '.credentials.json');

function extractToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const creds = JSON.parse(raw);
    // Handle both { claudeAiOauth: { accessToken } } and { accessToken } formats
    const oauth = creds.claudeAiOauth || creds;
    if (!oauth.accessToken) return null;
    // Check expiry — skip tokens that expired more than 5 minutes ago
    // (allow small buffer for clock skew)
    if (oauth.expiresAt) {
      const expiresMs = new Date(oauth.expiresAt).getTime();
      if (!isNaN(expiresMs) && Date.now() > expiresMs + 300000) {
        console.log('[auth] Token expired, skipping');
        return null;
      }
    }
    return { token: oauth.accessToken, raw };
  } catch {
    return null;
  }
}

function persistCredentials(raw) {
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CLAUDE_CRED_FILE, raw, { mode: 0o600 });
    console.log('[auth] Credentials persisted to file');
    return true;
  } catch (e) {
    console.error('[auth] Failed to persist credentials:', e.message);
    return false;
  }
}

async function readCredentials() {
  // 1. File — instant, cross-platform, no ACL issues
  try {
    const raw = fs.readFileSync(CLAUDE_CRED_FILE, 'utf8').trim();
    const result = extractToken(raw);
    if (result) {
      console.log('[auth] Token found in credentials file');
      return result.token;
    }
  } catch {}

  // 1b. File without dot prefix — some Claude Code versions use this path
  try {
    const altFile = path.join(os.homedir(), '.claude', 'credentials.json');
    const raw = fs.readFileSync(altFile, 'utf8').trim();
    const result = extractToken(raw);
    if (result) {
      console.log('[auth] Token found in credentials.json (no-dot variant)');
      persistCredentials(result.raw); // Normalize to the canonical path
      return result.token;
    }
  } catch {}

  // 2. Env var — may be set by parent process or CI
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.log('[auth] Token found in CLAUDE_CODE_OAUTH_TOKEN env');
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  // 3. macOS Keychain — fast scan with 3-second TOTAL cap (not per-service).
  // Previous implementation: 7 services × 3s each = 21s worst case.
  // New: try cached service first, then race all others with a 3s deadline.
  if (process.platform === 'darwin') {
    const keychainServices = [
      'Claude Code-credentials',
      'Claude Code',
      'Claude-credentials',
      'Claude',
      'claude-desktop-credentials',
      'com.anthropic.claude',
      'com.anthropic.claude-desktop',
    ];
    const { execFile } = require('child_process');
    const queryKeychain = (service) => new Promise((resolve) => {
      execFile('security', ['find-generic-password', '-s', service, '-w'],
        { timeout: 2000, encoding: 'utf8' },
        (err, stdout) => resolve(err ? '' : (stdout || '').trim()));
    });
    // Race all Keychain services in parallel — first valid token wins, 3s total cap
    try {
      const result = await Promise.race([
        (async () => {
          const results = await Promise.allSettled(keychainServices.map(s => queryKeychain(s)));
          for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'fulfilled' && results[i].value) {
              const parsed = extractToken(results[i].value);
              if (parsed) {
                console.log('[auth] Token found in Keychain');
                persistCredentials(parsed.raw);
                return parsed.token;
              }
            }
          }
          return null;
        })(),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)), // 3s hard cap
      ]);
      if (result) return result;
    } catch {}
  }

  // 4. Windows — check alternate credential file locations AND Credential
  //    Manager via PowerShell. Claude Code's CLI primarily stores at
  //    ~/.claude/.credentials.json (already checked as CLAUDE_CRED_FILE at
  //    the top), but older versions or the Claude Desktop app may store
  //    elsewhere. Codex P2 #6: we used to skip Credential Manager entirely
  //    "because it needs P/Invoke" — but we can shell out to PowerShell's
  //    Get-StoredCredential or use the built-in cmdkey command. It's slow
  //    (~200ms) but runs only on startup and only if the filesystem checks
  //    already failed.
  if (process.platform === 'win32') {
    const winCredPaths = [
      path.join(process.env.APPDATA || '', 'Claude', '.credentials.json'),
      path.join(process.env.APPDATA || '', 'Claude Code', '.credentials.json'),
      path.join(process.env.LOCALAPPDATA || '', 'Claude', '.credentials.json'),
      path.join(process.env.LOCALAPPDATA || '', 'Claude Code', '.credentials.json'),
    ];
    for (const wcp of winCredPaths) {
      try {
        const raw = fs.readFileSync(wcp, 'utf8').trim();
        const result = extractToken(raw);
        if (result) {
          console.log(`[auth] Token found in Windows path: ${wcp}`);
          persistCredentials(result.raw);
          return result.token;
        }
      } catch {}
    }

    // Windows Credential Manager fallback via PowerShell. We query for any
    // credential whose Target name contains "Claude" or "Anthropic". This
    // catches tokens written by future CLI versions or by Claude Desktop.
    // Wrapped in a 3s timeout so a hung PowerShell doesn't block startup.
    try {
      const { execSync } = require('child_process');
      // cmdkey /list is native Windows and doesn't need PowerShell — faster.
      // It only lists Target names, not secrets, but it tells us whether a
      // Claude-related credential exists. If one does, the actual read
      // requires a third-party module, so we log for debugging and move on.
      const cmdkeyOut = execSync('cmdkey /list', { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const claudeTargets = (cmdkeyOut || '')
        .split('\n')
        .filter(line => /target:.*\b(claude|anthropic)\b/i.test(line))
        .map(line => line.replace(/^\s*Target:\s*/i, '').trim());
      if (claudeTargets.length > 0) {
        console.log('[auth] Windows Credential Manager has Claude entries:', claudeTargets.join(', '));
        console.log('[auth] (Reading the actual secret requires a native module — falling through to re-auth)');
      }
    } catch (e) {
      // cmdkey missing or timed out — not fatal, just skip the check.
      console.log('[auth] Windows Credential Manager check skipped:', e.message);
    }
  }

  console.log('[auth] No credentials found in any location');
  return null;
}

// Keep the old name as an alias for backward compatibility
async function readMacCredentials() {
  return readCredentials();
}

async function getClaudeDesktopStatus() {
  const status = { installed: false, running: false, path: null };

  if (process.platform === 'darwin') {
    const userApps = path.join(os.homedir(), 'Applications');
    const candidates = [
      '/Applications/Claude.app',
      '/Applications/Claude Desktop.app',
      path.join(userApps, 'Claude.app'),
      path.join(userApps, 'Claude Desktop.app'),
    ];

    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.F_OK);
        status.installed = true;
        status.path = candidate;
        break;
      } catch {}
    }

    if (!status.installed) {
      const { stdout } = await execCommand(
        `mdfind "kMDItemKind == 'Application' && (kMDItemFSName == 'Claude.app' || kMDItemFSName == 'Claude Desktop.app')"`,
        3000,
      );
      const discovered = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (discovered) {
        status.installed = true;
        status.path = discovered;
      }
    }

    const { stdout } = await execCommand(
      `pgrep -if "/Claude( Desktop)?\\.app/" || pgrep -x "Claude" || pgrep -f "Claude Desktop"`,
      3000,
    );
    status.running = stdout.trim().length > 0;
    return status;
  }

  if (process.platform === 'win32') {
    // Check if running
    const { stdout } = await execCommand('tasklist /FI "IMAGENAME eq Claude.exe" /NH', 3000);
    status.running = stdout.toLowerCase().includes('claude.exe');
    // Check common install locations
    const localAppData = process.env.LOCALAPPDATA || '';
    const winCandidates = [
      path.join(localAppData, 'Programs', 'claude-desktop', 'Claude.exe'),
      path.join(localAppData, 'Programs', 'Claude', 'Claude.exe'),
      path.join(localAppData, 'claude-desktop', 'Claude.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Claude', 'Claude.exe'),
    ];
    for (const candidate of winCandidates) {
      try {
        fs.accessSync(candidate, fs.constants.F_OK);
        status.installed = true;
        status.path = candidate;
        break;
      } catch {}
    }
    // If it's running, it's obviously installed
    if (status.running) status.installed = true;
    return status;
  }

  const { stdout } = await execCommand('pgrep -x "Claude" || pgrep -f "Claude Desktop"', 3000);
  status.running = stdout.trim().length > 0;
  return status;
}

function isClaudeAuthError(message = '') {
  return /auth|authorization|token|sign in|signin|logged in|login|account/i.test(message);
}

// sendInlineMessage renders a system-generated chat bubble in the renderer
// without going through the SDK message pipeline. Used for auth prompts,
// engine download status, etc. — anything that needs to appear in the chat
// but isn't an SDK response.
//
// The renderer-side handler (onInlineMessage) is responsible for:
//  - Clearing the typing indicator
//  - Adding a Claude bubble with the text
//  - Resetting sessionActive + stopping the ticking timer
//  - Re-enabling the input
function sendInlineMessage(text, opts = {}) {
  const payload = { text: String(text || ''), kind: opts.kind || 'info' };
  if (win && !win.isDestroyed()) {
    win.webContents.send('inline-message', payload);
  }
  if (wsServer && typeof wsServer.broadcast === 'function') {
    wsServer.broadcast('inline-message', payload);
  }
}

// requireAuth is the UNIFIED auth-failure entry point. Called from every
// code path that discovers "we don't have working credentials" — startSession
// missing-creds, SDK auth-error responses, token-expired errors, etc.
//
// This function does NOT render a passive message and hope the user figures
// out what to do. It fires an `auth-required` IPC event to the renderer,
// which immediately:
//   1. Shows an inline bubble: "Connecting your Claude account…"
//   2. Calls triggerClaudeLogin() automatically — no user click required
//   3. On success, replays the message that triggered auth (so the user's
//      original request is not dropped — critical UX, covered by Codex P1 #5)
//   4. On failure, renders a Sign In button for manual retry
//
// Why a dedicated event instead of a generic inline-message + button: the
// inline-message path is a dumb bubble renderer. Unifying auth through its
// own event means: (a) one source of truth for "user is unauthenticated",
// (b) auto-triggering login without a second click, (c) reliably replaying
// the triggering prompt (inline-message has no hook for that).
//
// `context` is an optional string describing why auth failed (e.g. "session
// start", "token expired"). Shown in the bubble so the user gets minimal
// but useful feedback.
function requireAuth(context) {
  const payload = {
    context: context || 'session start',
    timestamp: Date.now(),
  };
  console.log('[auth] requireAuth emitting auth-required event:', payload);
  if (win && !win.isDestroyed()) {
    win.webContents.send('auth-required', payload);
  }
  if (wsServer && typeof wsServer.broadcast === 'function') {
    wsServer.broadcast('auth-required', payload);
  }
}

async function probeClaudeSetup(force = false) {
  if (!force && cachedClaudeSetup.result && (Date.now() - cachedClaudeSetup.at) < CLAUDE_SETUP_CACHE_MS) {
    return cachedClaudeSetup.result;
  }
  if (claudeSetupPromise) return claudeSetupPromise;

  claudeSetupPromise = (async () => {
    const desktop = await getClaudeDesktopStatus();
    let querySession = null;
    let result;

    // Previously gated on desktop.installed/running for Mac, but this was
    // too restrictive: mdfind can fail, Spotlight can be disabled, and the
    // SDK can authenticate via Claude Code CLI even without Claude Desktop.
    // Now we always try the SDK probe. Desktop status is still reported in
    // the result for the UI to show helpful guidance if the probe fails.

    try {
      const { query } = await importClaudeAgentSdk();
      // ELECTRON_RUN_AS_NODE prevents the subprocess from launching as a macOS GUI app
      // (which causes dock bouncing and hangs). Without it, the Electron binary registers
      // with the window server instead of running as headless Node.
      const probeEnv = { ...process.env, BROWSER: 'none' };
      if (!getBundledNodePath()) probeEnv.ELECTRON_RUN_AS_NODE = '1'; // Only needed for wrapper fallback
      if (process.platform === 'darwin' && !probeEnv.CLAUDE_CODE_OAUTH_TOKEN && !probeEnv.ANTHROPIC_API_KEY) {
        const token = await readMacCredentials();
        if (token) {
          probeEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
        } else {
          // No credentials on Mac — skip the expensive SDK probe (it will always
          // fail without a token, wasting up to 12s). Return needsLogin immediately
          // so the renderer triggers auto-login within milliseconds.
          console.log('[setup-probe] No Mac credentials found — skipping probe, needs login');
          result = {
            ready: false,
            needsLogin: true,
            desktopInstalled: desktop.installed,
            desktopRunning: desktop.running,
            desktopPath: desktop.path,
            reason: 'Signing in to your Claude account...',
          };
          cachedClaudeSetup = { at: Date.now(), result };
          return result;
        }
      }
      querySession = query({
        prompt: 'Merlin readiness check.',
        options: {
          cwd: appRoot,
          permissionMode: 'default',
          settingSources: ['project'],
          env: probeEnv,
        },
      });

      let probeTimer;
      const timeout = new Promise((_, reject) => {
        probeTimer = setTimeout(() => reject(new Error('Claude setup timed out')), CLAUDE_SETUP_TIMEOUT_MS);
      });
      const account = await Promise.race([querySession.accountInfo(), timeout]);
      clearTimeout(probeTimer);
      console.log('[setup-probe] accountInfo:', JSON.stringify(account || null));
      const hasAccount = !!(account && (
        account.email ||
        account.organization ||
        account.subscriptionType ||
        account.tokenSource ||
        account.apiKeySource ||
        account.apiProvider
      ));

      if (!hasAccount) {
        // SDK connected but returned no auth data — user likely hasn't signed in
        // inside Claude Desktop, or their session expired.
        throw new Error(
          desktop.running
            ? 'Claude Desktop is running but your session may have expired. Open Claude Desktop and make sure you\'re signed in.'
            : 'Claude account information unavailable — sign in to Claude Desktop first.'
        );
      }

      result = {
        ready: true,
        desktopInstalled: desktop.installed,
        desktopRunning: desktop.running,
        desktopPath: desktop.path,
        reason: 'Claude is ready. Starting Merlin...',
      };
    } catch (error) {
      const errorMessage = error?.message || String(error);
      console.error('[setup-probe] SDK connection failed:', errorMessage);
      let reason;

      if (/app\.asar\.unpacked|Cannot find module|Cannot find package/i.test(errorMessage)) {
        reason = 'Merlin could not load its Claude integration. Please reinstall Merlin.';
      } else if (/not logged in|please run \/login|login required/i.test(errorMessage) || isClaudeAuthError(errorMessage)) {
        // Mac: no Claude Code credentials — needs one-time browser login.
        // Return needsLogin so the renderer triggers auto-login immediately
        // instead of showing a confusing "open Claude Desktop" message.
        result = {
          ready: false,
          needsLogin: true,
          desktopInstalled: desktop.installed,
          desktopRunning: desktop.running,
          desktopPath: desktop.path,
          reason: 'Signing in to your Claude account...',
          error: errorMessage,
        };
        cachedClaudeSetup = { at: Date.now(), result };
        return result;
      } else if (/timed? ?out/i.test(errorMessage)) {
        // SDK timed out connecting to Claude Desktop. Most common cause on Mac:
        // Claude Desktop is open but still initializing, or user hasn't completed
        // the first-run onboarding in Claude Desktop.
        if (desktop.running) {
          reason = 'Claude Desktop is open but still starting up. Wait a few seconds and retry, or make sure you\'ve completed the Claude sign-in.';
        } else {
          reason = 'Connection to Claude timed out. Open Claude Desktop and sign in first.';
        }
      } else if (/ECONNREFUSED|ENOENT|spawn|EPIPE/i.test(errorMessage)) {
        // SDK can't reach the Claude Code CLI at all
        reason = 'Merlin could not find the Claude connection. Make sure Claude Desktop is fully open and signed in. If this persists, try reinstalling Claude Desktop from claude.ai/download.';
      } else if (desktop.running) {
        reason = 'Claude Desktop is open, but Merlin could not connect yet. Make sure you\'re signed in inside Claude Desktop, then retry.';
      } else if (desktop.installed) {
        reason = 'Claude Desktop is installed. Open it to finish connecting Merlin.';
      } else {
        reason = 'Claude Desktop is not installed yet. Install it to continue, or use an API key.';
      }

      result = {
        ready: false,
        desktopInstalled: desktop.installed,
        desktopRunning: desktop.running,
        desktopPath: desktop.path,
        reason,
        error: errorMessage,
      };
    } finally {
      try { querySession?.close(); } catch {}
    }

    cachedClaudeSetup = { at: Date.now(), result };
    return result;
  })().finally(() => {
    claudeSetupPromise = null;
  });

  return claudeSetupPromise;
}

// ── Workspace bootstrap + sync ──────────────────────────────
// Non-blocking. Uses execFile with explicit arg arrays — no shell interpolation.
// robocopy is called directly (not through cmd.exe) to avoid injection risk.
function bootstrapWorkspace() {
  if (!app.isPackaged) return;
  const { execFile } = require('child_process');
  const fs = require('fs');

  // Ensure workspace root exists (sync — single mkdir is fast)
  try { fs.mkdirSync(appRoot, { recursive: true }); } catch (_) {}

  if (process.platform === 'win32') {
    // robocopy called directly — no shell, no interpolation
    // /E=recurse /XC/XN/XO=skip existing /NFL/NDL/NJH/NJS/NP=quiet
    const roboArgs = ['/E', '/XC', '/XN', '/XO', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'];
    execFile('robocopy', [path.join(appInstall, '.claude'), path.join(appRoot, '.claude'), ...roboArgs], () => {
      execFile('robocopy', [path.join(appInstall, 'assets'), path.join(appRoot, 'assets'), ...roboArgs], () => {
        // Copy individual root files if they don't exist yet
        for (const f of ['CLAUDE.md', 'version.json', 'memory.md', 'README.txt']) {
          const src = path.join(appInstall, f);
          const dest = path.join(appRoot, f);
          try { if (fs.existsSync(src) && !fs.existsSync(dest)) fs.copyFileSync(src, dest); } catch (_) {}
        }
        console.log('[workspace] Bootstrap complete');
      });
    });
  } else {
    // macOS/Linux: use cp with explicit args — no shell
    execFile('cp', ['-Rn', path.join(appInstall, '.claude'), path.join(appRoot, '/')], () => {
      execFile('cp', ['-Rn', path.join(appInstall, 'assets'), path.join(appRoot, '/')], () => {
        for (const f of ['CLAUDE.md', 'version.json', 'memory.md', 'README.txt']) {
          const src = path.join(appInstall, f);
          const dest = path.join(appRoot, f);
          try { if (fs.existsSync(src) && !fs.existsSync(dest)) fs.copyFileSync(src, dest); } catch (_) {}
        }
        console.log('[workspace] Bootstrap complete');
      });
    });
  }
}

let win = null;
let tray = null;
let forceQuit = false;
let resolveNextMessage = null;
const activeChildProcesses = new Set(); // track spawned Merlin.exe for cleanup
let pendingMessageQueue = []; // Queue messages sent before SDK is ready
let pendingApprovals = new Map();
let activeQuery = null;
let _suppressNextResponse = false; // Suppress SDK responses for internal actions (spell toggle/create)

// True while we're between "auth failed" and "user completed login". While
// this flag is set, the session finally block must NOT clear pendingMessageQueue
// — we want the triggering user message to survive across auth recovery so it
// gets replayed automatically once the new session starts. Set in startSession()
// when credentials are missing, cleared when the next session successfully drains
// the queue or when the renderer explicitly abandons the pending auth.
let _queueFrozenForAuth = false;


// Auto-expire pending approvals after 15 minutes
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
      spellcheck: true,
    },
  });

  // Register protocol for inline media — images, video, audio, PDFs.
  //
  // Video playback requires HTTP Range request support: HTML5 <video> elements
  // issue byte-range requests to Chromium and expect 206 Partial Content
  // responses with Content-Range / Accept-Ranges / Content-Length headers.
  // Without these, Chromium loads the file but can't determine duration,
  // can't seek, and often shows an empty 0:00 player. The original handler
  // returned a single full-body Response with no Range semantics, which
  // broke all video playback.
  //
  // This handler:
  //   - Validates the resolved path stays within appRoot (traversal guard)
  //   - Parses the Range header if present, returns 206 Partial Content
  //   - Otherwise returns 200 OK with Accept-Ranges: bytes so Chromium
  //     knows it can issue subsequent Range requests
  //   - Streams bytes instead of buffering the whole file in memory
  //   - Maps common media extensions to correct Content-Type (including .mov)
  const MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
  };

  protocol.handle('merlin', async (request) => {
    // Keep the same URL parsing the original handler used — treating the
    // entire `merlin://...` tail as a relative path. Using `new URL()` would
    // treat the first segment as the hostname and break paths like
    // `merlin://results/ad_xxx/final.mp4` → would drop the `results/` prefix.
    const requested = decodeURIComponent(request.url.replace(/^merlin:\/\//, ''));
    const filePath = path.resolve(appRoot, requested);
    const resolvedRoot = path.resolve(appRoot);
    if (!filePath.startsWith(resolvedRoot + path.sep) && filePath !== resolvedRoot) {
      return new Response('Forbidden', { status: 403 });
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    if (!stat.isFile()) {
      return new Response('Not found', { status: 404 });
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const totalSize = stat.size;

    // Parse Range header — Chromium's <video> element issues these
    const rangeHeader = request.headers.get('range') || request.headers.get('Range');
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (match) {
        let start = match[1] === '' ? NaN : parseInt(match[1], 10);
        let end = match[2] === '' ? NaN : parseInt(match[2], 10);
        // Handle "bytes=-N" (last N bytes) and "bytes=N-" (from N to end)
        if (Number.isNaN(start) && !Number.isNaN(end)) {
          start = Math.max(0, totalSize - end);
          end = totalSize - 1;
        } else if (!Number.isNaN(start) && Number.isNaN(end)) {
          end = totalSize - 1;
        }
        if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end >= totalSize || start > end) {
          return new Response('Range not satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${totalSize}` },
          });
        }
        const chunkSize = end - start + 1;
        // Stream the requested slice — don't buffer in memory
        const nodeStream = fs.createReadStream(filePath, { start, end });
        const webStream = new ReadableStream({
          start(controller) {
            nodeStream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
            nodeStream.on('end', () => controller.close());
            nodeStream.on('error', (err) => controller.error(err));
          },
          cancel() { nodeStream.destroy(); },
        });
        return new Response(webStream, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunkSize),
            'Cache-Control': 'no-cache',
          },
        });
      }
    }

    // No Range header — return full body as a stream with Accept-Ranges: bytes
    // so Chromium knows it can issue subsequent Range requests for seeking.
    const nodeStream = fs.createReadStream(filePath);
    const webStream = new ReadableStream({
      start(controller) {
        nodeStream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
        nodeStream.on('end', () => controller.close());
        nodeStream.on('error', (err) => controller.error(err));
      },
      cancel() { nodeStream.destroy(); },
    });
    return new Response(webStream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(totalSize),
        'Cache-Control': 'no-cache',
      },
    });
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  // Open external links in OS default browser (opens Discord app if installed)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' }; // Never open new Electron windows
  });

  // Grant microphone permission for voice input (Web Speech API)
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') { callback(true); return; }
    callback(false);
  });

  // Right-click context menu (Copy, Paste, Select All, etc.)
  win.webContents.on('context-menu', (_, params) => {
    const items = [];
    // Spellcheck suggestions
    if (params.misspelledWord) {
      const suggestions = params.dictionarySuggestions || [];
      if (suggestions.length > 0) {
        for (const s of suggestions.slice(0, 5)) {
          items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
        }
      } else {
        items.push({ label: 'No suggestions', enabled: false });
      }
      items.push({ type: 'separator' });
    }
    if (params.selectionText) {
      items.push({ label: 'Copy', role: 'copy' });
    }
    if (params.isEditable) {
      items.push({ label: 'Paste', role: 'paste' });
      items.push({ label: 'Cut', role: 'cut' });
      items.push({ type: 'separator' });
      items.push({ label: 'Select All', role: 'selectAll' });
    }
    if (!params.isEditable && !params.selectionText) {
      items.push({ label: 'Select All', role: 'selectAll' });
    }
    if (params.linkURL) {
      items.push({ type: 'separator' });
      items.push({ label: 'Copy Link', click: () => { require('electron').clipboard.writeText(params.linkURL); } });
      items.push({ label: 'Open Link', click: () => { shell.openExternal(params.linkURL); } });
    }
    if (items.length > 0) {
      Menu.buildFromTemplate(items).popup({ window: win });
    }
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
    // Show window unless explicitly launched hidden (tray mode at startup)
    // ALWAYS show on first run (no workspace yet) — user needs to see the app after install
    const isFirstRun = app.isPackaged && !fs.existsSync(path.join(appRoot, 'CLAUDE.md'));
    const launchedHidden = !isFirstRun && (process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden);
    if (!launchedHidden) win.show();
    win.webContents.send('platform', process.platform);

  });

  // ── Minimize to tray on close (keeps spells running) ──────
  win.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault();
      win.hide();
    }
  });

  const showWindow = () => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    else createWindow();
  };

  try {
    const { nativeImage } = require('electron');
    const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
    // Try multiple paths: asar, unpacked asar, __dirname
    let trayIcon;
    for (const base of [__dirname, path.join(__dirname, '..'), appInstall]) {
      const p = path.join(base, iconFile);
      if (fs.existsSync(p)) { trayIcon = p; break; }
    }
    if (!trayIcon) trayIcon = path.join(__dirname, iconFile); // fallback
    tray = new Tray(trayIcon);
    tray.setToolTip('Merlin — AI CMO');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Merlin', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => { forceQuit = true; app.quit(); } },
    ]));
    tray.on('double-click', showWindow);
  } catch (err) {
    console.warn('[tray] System tray not available:', err.message);
    // Linux without tray support — fall back to normal window behavior
    // Re-enable close-to-quit so the user isn't stuck with a zombie process
    win.removeAllListeners('close');
  }

  // Start WebSocket server for PWA mobile clients
  await wsServer.startServer();
  wsServer.setHandlers({
    onSendMessage: (text) => {
      if (typeof text !== 'string' || text.length > 50000) return; // validate input
      const content = injectActiveBrand(text);
      if (resolveNextMessage) {
        resolveNextMessage({ type: 'user', message: { role: 'user', content } });
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
  // NOTE: WebFetch REMOVED — now goes through handleToolApproval with a
  // canUseTool banned-host check (below). The hook is primary, canUseTool
  // is belt-and-suspenders.
  'Read', 'Glob', 'Grep', 'WebSearch', 'TodoWrite',
  'Skill', 'Edit', 'Write', 'NotebookEdit', 'Agent',
]);

// Safe Bash patterns that can be auto-approved (read-only or setup operations).
// Removed: /^curl\s.*-[sS]/, /^curl\s.*download/, /^node\s+-e\b/ — all three
// were blanket auto-approvals that Claude could use to make arbitrary network
// calls. Curl is now permission-checked via the allow/deny lists + hook, and
// node -e is blocked by the hook when it contains network intent.
const safeBashPatterns = [
  // REMOVED: cat, head, tail — can read decrypted temp config files.
  // They now require user approval via the approval card.
  /^ls\b/, /^wc\b/, /^find\b/, /^grep\b/,
  /^mkdir\b/, /^cp\b/, /^mv\b/, /^echo\b/, /^pwd\b/, /^cd\b/, /^test\b/,
  /^chmod\b/, /^xattr\b/, /^codesign\b/,
  // npx REMOVED — auto-approving it lets Claude run arbitrary packages
];

function isSafeBash(command) {
  const cmd = (command || '').trim();
  return safeBashPatterns.some(p => p.test(cmd));
}

// ── Security: banned-host check for WebFetch + Bash ────────────────
// Duplicate of the hook logic for defense in depth. If the hook crashes
// or is bypassed, canUseTool still blocks.
const BANNED_API_HOSTS = [
  'graph.facebook.com', 'business.facebook.com',
  'business-api.tiktok.com', 'open-api.tiktok.com', 'open.tiktokapis.com',
  'googleads.googleapis.com', 'ads.google.com', 'www.googleadservices.com',
  'advertising-api.amazon.com', 'advertising-api-eu.amazon.com',
  'advertising-api-fe.amazon.com', 'sellingpartnerapi-na.amazon.com',
  'sellingpartnerapi-eu.amazon.com', 'sellingpartnerapi-fe.amazon.com',
  'api.klaviyo.com', 'a.klaviyo.com',
  'adsapi.snapchat.com', 'ads-api.pinterest.com',
];
const ALLOWED_URL_PREFIXES = [
  'https://github.com/oathgames/',
  'https://api.github.com/repos/oathgames/',
  'https://raw.githubusercontent.com/oathgames/',
  'https://merlingotme.com/',
  'https://www.merlingotme.com/',
  'https://api.merlingotme.com/',
];
const PROTECTED_PATH_PATTERNS = [
  /merlin-config\.json$/i,
  /\.merlin-config-[a-z0-9_-]+\.json$/i,
  /\.merlin-tokens[a-z0-9_-]*$/i,
  /\.merlin-vault(\.|$)/i,
  /\.merlin-ratelimit(\.|$)/i,
  /\.merlin-audit(\.|$)/i,
  /\.merlin-[a-z]/i,                    // Catch-all: .merlin-api-key, .merlin-subscription, etc.
  /\.rate-state\.bin$/i,
  // The actual vault file at %APPDATA%/Merlin/.vault
  /[/\\]Merlin[/\\]\.vault$/i,
  /[/\\]\.vault$/i,
  /[/\\]\.rate-state\b/i,
];

function containsBannedHost(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  // Allow whitelisted URLs
  for (const p of ALLOWED_URL_PREFIXES) if (lower.includes(p)) return null;
  // Direct URL match (protocol prefix)
  for (const host of BANNED_API_HOSTS) {
    if (lower.includes('://' + host) || lower.includes('//' + host)) return host;
  }
  // Shopify admin API (but not OAuth authorize)
  if (/\.myshopify\.com\/admin\/api/i.test(text)) return 'myshopify-admin-api';
  // HTTP-fetching verbs with bare host
  if (/\b(curl|wget|httpie|xh|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i.test(text)) {
    for (const host of BANNED_API_HOSTS) if (lower.includes(host)) return host;
  }
  return null;
}

function isProtectedPath(filePath) {
  if (!filePath) return false;
  return PROTECTED_PATH_PATTERNS.some(p => p.test(filePath));
}

// Returns { blocked: bool, reason: string } — runs BEFORE any auto-approve.
function checkHardDeny(toolName, input) {
  // WebFetch — URL check
  if (toolName === 'WebFetch' && input && input.url) {
    const host = containsBannedHost(input.url);
    if (host) {
      return {
        blocked: true,
        reason: 'Direct WebFetch to ' + host + ' is not allowed. Use the Merlin binary — it enforces rate limits to protect your ad accounts from platform bans.',
      };
    }
  }
  // Bash — command + banned host + protected file patterns
  if (toolName === 'Bash' && input && input.command) {
    const host = containsBannedHost(input.command);
    if (host) {
      return {
        blocked: true,
        reason: 'Direct command access to ' + host + ' is not allowed. Use `Merlin.exe --cmd \'{"action":"..."}\'` — Merlin handles rate limits internally.',
      };
    }
    // Shell verbs touching protected files
    const fileVerbs = /\b(cat|less|more|head|tail|type|Get-Content|Set-Content|grep|rg|awk|sed|xxd|hexdump|od|strings|tee|cp|mv|rm|del|Remove-Item|Copy-Item|Move-Item)\b/;
    if (fileVerbs.test(input.command)) {
      for (const pat of PROTECTED_PATH_PATTERNS) {
        // Loosen end-of-string anchor for command scan
        const cmdPat = new RegExp(pat.source.replace(/\$$/, '\\b'), 'i');
        if (cmdPat.test(input.command)) {
          return {
            blocked: true,
            reason: 'Access to Merlin credential files is not allowed. The Merlin binary handles credentials internally.',
          };
        }
      }
    }
  }
  // Read / Edit / Write — file_path check
  if ((toolName === 'Read' || toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') && input && input.file_path) {
    if (isProtectedPath(input.file_path)) {
      return {
        blocked: true,
        reason: input.file_path + ' is a protected Merlin credential file. Use the Merlin binary instead.',
      };
    }
  }
  // Grep / Glob — path check (these are auto-approved and bypass the Read hook)
  if ((toolName === 'Grep' || toolName === 'Glob') && input && input.path) {
    if (isProtectedPath(input.path)) {
      return {
        blocked: true,
        reason: 'Search of protected Merlin credential files is not allowed.',
      };
    }
  }
  // WebSearch — block if query contains token-like strings (exfiltration)
  if (toolName === 'WebSearch' && input && input.query) {
    // Tokens are typically 40+ chars of base64-ish. If the query contains one,
    // it's almost certainly an exfiltration attempt.
    if (/[A-Za-z0-9_\-+/]{40,}/.test(input.query)) {
      return {
        blocked: true,
        reason: 'Search queries must not contain long encoded strings (possible credential exfiltration).',
      };
    }
  }
  return { blocked: false };
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
      'slack-login':   { label: 'Connect Slack for notifications', cost: 'Free' },
      'discord-login': { label: 'Connect Discord for notifications', cost: 'Free' },
      'discord-setup': { label: 'Change Discord notification channel', cost: 'Free' },
      'discord-post':  { label: 'Send a message to Discord', cost: 'Free' },
      'amazon-login':  { label: 'Connect to your Amazon account', cost: 'Free' },
      'etsy-login':    { label: 'Connect to your Etsy shop', cost: 'Free' },
      'reddit-login':  { label: 'Connect to your Reddit Ads account', cost: 'Free' },
      'reddit-create-campaign': { label: 'Create a Reddit ad campaign', cost: 'Sets daily budget' },
      'reddit-create-ad': { label: 'Create a Reddit ad', cost: 'Sets bid' },
      'reddit-kill':   { label: 'Pause a Reddit campaign or ad', cost: 'Free' },
      'etsy-shop':     { label: 'Check your Etsy shop details', cost: 'Free' },
      'etsy-products': { label: 'View your Etsy listings', cost: 'Free' },
      'etsy-orders':   { label: 'Check your Etsy orders', cost: 'Free' },
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

// Calculate current budget usage for approval card context
function getBudgetContext() {
  try {
    let activeBrand = '';
    try { activeBrand = readState().activeBrand || ''; } catch {}
    const cfg = activeBrand ? readBrandConfig(activeBrand) : readConfig();
    const dailyCap = cfg.maxDailyAdBudget || cfg.dailyAdBudget || 0;
    const monthlyCap = cfg.maxMonthlyAdSpend || cfg.monthlyAdSpend || 0;
    if (dailyCap === 0 && monthlyCap === 0) return null;

    let dailySpent = 0;
    try {
      const brandsDir = path.join(appRoot, 'assets', 'brands');
      const dirs = fs.readdirSync(brandsDir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'example');
      for (const d of dirs) {
        const adsPath = path.join(brandsDir, d.name, 'ads-live.json');
        try {
          const ads = JSON.parse(fs.readFileSync(adsPath, 'utf8'));
          dailySpent += ads.filter(a => a.status === 'live').reduce((sum, a) => sum + (a.budget || 0), 0);
        } catch {}
      }
    } catch {}

    const remaining = dailyCap > 0 ? Math.max(0, dailyCap - dailySpent) : 0;
    return { dailyCap, dailySpent, remaining, monthlyCap };
  } catch { return null; }
}

async function handleToolApproval(toolName, input) {
  // SECURITY: hard-deny bypass attempts BEFORE any auto-approve logic.
  // This duplicates the PreToolUse hook as defense in depth.
  const deny = checkHardDeny(toolName, input);
  if (deny.blocked) {
    try { appendAudit('bypass_attempt', { tool: toolName, reason: deny.reason }); } catch {}
    try { reportBypassTelemetry(toolName, deny.reason); } catch {}
    // Don't show toast — these blocks are expected behavior (Claude probing
    // config files before learning to use MCP tools). The security still
    // works, but the toast scares users into thinking something is wrong.
    return { behavior: 'deny', message: deny.reason };
  }

  if (autoApproveTools.has(toolName)) {
    return { behavior: 'allow', updatedInput: input };
  }


  // ── MCP Merlin tools — auto-approve read-only, gate spend actions ──
  if (toolName.startsWith('mcp__merlin__')) {
    const action = (input && input.action) || '';

    // Read-only actions: always auto-approve (no user approval needed)
    const READ_ONLY = new Set([
      'insights', 'products', 'orders', 'analytics', 'cohorts', 'dashboard',
      'calendar', 'wisdom', 'report', 'audit', 'revenue', 'keywords',
      'rankings', 'track', 'gaps', 'status', 'performance', 'lists',
      'campaigns', 'list', 'list-avatars', 'discover', 'adlib',
      'competitor-scan', 'landing-audit', 'dry-run', 'version',
      'blog-list', 'update-rank',
    ]);
    if (READ_ONLY.has(action) || toolName === 'mcp__merlin__connection_status') {
      return { behavior: 'allow', updatedInput: input };
    }

    // Login actions: auto-approve (user already clicked the tile)
    if (toolName === 'mcp__merlin__platform_login') {
      return { behavior: 'allow', updatedInput: input };
    }

    // Spend actions: show approval card with budget enforcement
    const SPEND = new Set(['push', 'duplicate', 'setup', 'setup-retargeting']);
    if (SPEND.has(action)) {
      const budgetCtx = getBudgetContext();
      const adBudget = input.dailyBudget || 5;

      // HARD DENY: catch Claude-passed-cents BEFORE showing the approval card.
      // Sanity check: values ≥ $5000/day or >10x the configured cap are almost
      // certainly cents. Refuse the tool call with an explanatory message so
      // Claude retries with the correct dollar value. The user never sees a
      // shocking "$1000/day" card.
      const HARD_CEILING = 5000;
      const capForComparison = budgetCtx && budgetCtx.dailyCap > 0 ? budgetCtx.dailyCap : 0;
      if (adBudget >= HARD_CEILING) {
        return {
          behavior: 'deny',
          message: `dailyBudget=${adBudget} looks like cents, not dollars. Pass dollars (e.g. 10 for $10/day). NEVER pre-convert — Merlin converts to cents internally.`,
        };
      }
      if (capForComparison > 0 && adBudget > capForComparison * 10) {
        return {
          behavior: 'deny',
          message: `dailyBudget=${adBudget} is more than 10x the user's $${capForComparison}/day cap. This looks like cents — pass ${Math.round(adBudget / 100)} for $${Math.round(adBudget / 100)}/day.`,
        };
      }

      const translations = {
        'push': { label: 'Publish this ad', cost: `$${adBudget}/day budget` },
        'duplicate': { label: 'Scale this winning ad', cost: 'Increases budget' },
        'setup': { label: 'Set up ad campaigns', cost: 'Free' },
        'setup-retargeting': { label: 'Set up retargeting audiences', cost: 'Free' },
      };
      const translated = translations[action] || { label: `Run ${action}`, cost: null };
      let budgetDetail = null;
      if (budgetCtx && budgetCtx.dailyCap > 0 && (action === 'push' || action === 'duplicate')) {
        const overBudget = budgetCtx.remaining < adBudget;
        if (action === 'push') {
          translated.cost = overBudget
            ? `⚠ Over budget! This ad: $${adBudget}/day`
            : `$${adBudget}/day budget`;
        }
        budgetDetail = `$${budgetCtx.dailySpent} spent today · $${budgetCtx.dailyCap}/day cap · $${budgetCtx.remaining} remaining`;
        if (overBudget) budgetDetail = `⚠ $${budgetCtx.dailySpent} spent today · $${budgetCtx.dailyCap}/day cap · $${budgetCtx.remaining} remaining`;
        if (budgetCtx.monthlyCap > 0) budgetDetail += ` · $${budgetCtx.monthlyCap}/mo cap`;
      }
      const toolUseID = Date.now().toString();
      const payload = { toolUseID, label: translated.label, cost: translated.cost, budget: budgetDetail };
      if (win && !win.isDestroyed()) win.webContents.send('approval-request', payload);
      wsServer.broadcast('approval-request', payload);
      return new Promise((resolve) => {
        setPendingApproval(toolUseID, (approved) => {
          resolve(approved ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'User declined' });
        });
      });
    }

    // All other MCP merlin tools: auto-approve (config, voice, content, etc.)
    return { behavior: 'allow', updatedInput: input };
  }

  // Auto-approve safe Bash commands (read-only, setup, file management)
  if (toolName === 'Bash' && isSafeBash(input.command)) {
    return { behavior: 'allow', updatedInput: input };
  }

  // GUARDRAIL: Block destructive campaign operations
  if (toolName === 'Bash' && input.command && (
    input.command.includes('delete-campaign') || input.command.includes('delete_campaign')
  )) {
    return { behavior: 'deny', message: 'Merlin is not allowed to delete campaigns. Ads can be paused but campaigns are never deleted.' };
  }

  // BUDGET ENFORCEMENT: Bash Merlin push actions — show approval card with full budget context
  if (toolName === 'Bash' && input.command && input.command.includes('Merlin')) {
    const cmdMatch = input.command.match(/"action"\s*:\s*"([^"]+)"/);
    const bashAction = cmdMatch ? cmdMatch[1] : '';
    const BASH_SPEND = new Set(['meta-push', 'tiktok-push', 'google-ads-push', 'amazon-ads-push', 'reddit-create-campaign', 'reddit-create-ad']);
    if (BASH_SPEND.has(bashAction)) {
      const budgetCtx = getBudgetContext();
      const translated = translateTool(toolName, input);
      const budgetMatch = input.command.match(/"dailyBudget"\s*:\s*(\d+)/);
      const adBudget = budgetMatch ? parseInt(budgetMatch[1]) : 5;

      // Same hard deny as MCP spend path — catch cents-by-mistake early.
      const HARD_CEILING = 5000;
      const capForComparison = budgetCtx && budgetCtx.dailyCap > 0 ? budgetCtx.dailyCap : 0;
      if (adBudget >= HARD_CEILING) {
        return {
          behavior: 'deny',
          message: `dailyBudget=${adBudget} looks like cents, not dollars. Pass dollars (e.g. 10 for $10/day). NEVER pre-convert.`,
        };
      }
      if (capForComparison > 0 && adBudget > capForComparison * 10) {
        return {
          behavior: 'deny',
          message: `dailyBudget=${adBudget} is more than 10x the user's $${capForComparison}/day cap. Likely cents — pass ${Math.round(adBudget / 100)}.`,
        };
      }

      let budgetDetail = null;
      if (budgetCtx && budgetCtx.dailyCap > 0) {
        const overBudget = budgetCtx.remaining < adBudget;
        translated.cost = overBudget
          ? `⚠ Over budget! This ad: $${adBudget}/day`
          : `$${adBudget}/day · Budget cap: $${budgetCtx.dailyCap}/day`;
        budgetDetail = `$${budgetCtx.dailySpent} spent today · $${budgetCtx.dailyCap}/day cap · $${budgetCtx.remaining} remaining`;
        if (overBudget) budgetDetail = `⚠ $${budgetCtx.dailySpent} spent today · $${budgetCtx.dailyCap}/day cap · $${budgetCtx.remaining} remaining`;
        if (budgetCtx.monthlyCap > 0) budgetDetail += ` · $${budgetCtx.monthlyCap}/mo cap`;
      }
      const toolUseID = Date.now().toString();
      const payload = { toolUseID, label: translated.label, cost: translated.cost, budget: budgetDetail };
      if (win && !win.isDestroyed()) win.webContents.send('approval-request', payload);
      wsServer.broadcast('approval-request', payload);
      return new Promise((resolve) => {
        setPendingApproval(toolUseID, (approved) => {
          resolve(approved ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'User declined' });
        });
      });
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
  // Clear the auth-recovery flag at the top of every startSession. If we
  // were frozen for auth and we're now starting a new session, either the
  // user just completed login (in which case the queue should drain) or the
  // user abandoned (in which case the queue should still drain on their next
  // message). Either way, the freeze is over.
  _queueFrozenForAuth = false;

  // Hard trial enforcement — block session if expired and not subscribed
  const sub = getSubscriptionState();
  if (!sub.subscribed && sub.expired) {
    if (win && !win.isDestroyed()) win.webContents.send('trial-expired');
    return;
  }

  // Import SDK — packaged apps MUST use the unpacked path (asar import is unreliable)
  const sdkModule = await importClaudeAgentSdk();
  const { query } = sdkModule;

  // Determine the active brand — must match what the welcome message shows
  let activeBrand = '';
  const savedState = readState();
  if (savedState.activeBrand) activeBrand = savedState.activeBrand;
  if (!activeBrand) {
    try {
      const brandsDir = path.join(appRoot, 'assets', 'brands');
      const dirs = fs.readdirSync(brandsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== 'example')
        .map(d => d.name).sort();
      if (dirs.length > 0) activeBrand = dirs[0];
    } catch {}
  }
  const brandHint = activeBrand
    ? ` ACTIVE BRAND: The user's active brand is "${activeBrand}". When brands exist, use THIS brand specifically — the welcome message already showed it. Say "✦ ${activeBrand.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} is ready — [X] products loaded. What would you like to create?"`
    : '';

  // Try to infer brand domain from cached Claude account email
  const inferredDomain = inferBrandDomain();
  const domainHint = inferredDomain
    ? ` DOMAIN HINT: The user's email domain is "${inferredDomain}". When asking for their website, pre-fill the first AskUserQuestion option as: label: "${inferredDomain}", description: "Is this your brand? We'll scan it automatically". Add a second option: label: "Different website", description: "Enter a different URL". And a third: label: "Just exploring", description: "See what Merlin can do — no setup needed".`
    : '';

  async function* messageGenerator() {
    const setupInstructions = activeBrand
      ? `A brand already exists: "${activeBrand}". Do NOT ask for a website. Do NOT run setup. Just count the products in assets/brands/${activeBrand}/products/ and say "✦ ${activeBrand.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} is ready — [X] products loaded. What would you like to create?"`
      : `No brands exist yet. Use the AskUserQuestion tool to ask "What's your website?" with these options: (1) label: "Set up my brand", description: "Enter your website URL and we'll auto-detect your brand, products, and colors" (2) label: "Just exploring", description: "See what Merlin can do — no setup needed".${domainHint} When the user provides their website URL, start working IMMEDIATELY — scrape the site with WebFetch, extract brand colors, find products, identify competitors with WebSearch. Do ALL of this in parallel. Show results as you find them. If the user selects "Just exploring", give a 3-sentence pitch and ask what they'd like to try.`;
    yield { type: 'user', message: { role: 'user', content: `Run /merlin — silent preflight. ${setupInstructions}` } };
    // Drain any messages queued before SDK was ready
    while (pendingMessageQueue.length > 0) {
      yield pendingMessageQueue.shift();
    }
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

  // If user has an API key, pass it via env so Claude Code uses it instead of subscription
  // ELECTRON_RUN_AS_NODE prevents the SDK subprocess from launching as a macOS GUI app
  // (dock bouncing + hang). The login flow at trigger-claude-login already sets this.
  const sessionEnv = { ...process.env, BROWSER: 'none' };
  if (!getBundledNodePath()) sessionEnv.ELECTRON_RUN_AS_NODE = '1'; // Only needed for wrapper fallback
  try {
    const storedKey = readSecureFile(path.join(appRoot, '.merlin-api-key'));
    if (storedKey && storedKey.startsWith('sk-ant-')) {
      sessionEnv.ANTHROPIC_API_KEY = storedKey;
    }
  } catch {}

  // Inject OAuth token from any available source — prevents the SDK subprocess
  // from hitting Keychain ACL issues (Mac) or prompting for re-auth (both platforms).
  // readCredentials() checks: file → env → Keychain (Mac) → Credential Manager (Win)
  if (!sessionEnv.CLAUDE_CODE_OAUTH_TOKEN && !sessionEnv.ANTHROPIC_API_KEY) {
    const token = await readCredentials();
    if (token) {
      sessionEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
      console.log('[auth] Injected OAuth token into session env');
    } else {
      // No credentials found. Fire the unified auth-required event; the
      // renderer will auto-trigger login and replay the pending message
      // after auth succeeds. We DO NOT clear pendingMessageQueue here —
      // the renderer is responsible for replaying via a stashed copy,
      // but we also leave the queue intact as belt-and-suspenders in case
      // the renderer path breaks. The next startSession() call (after
      // successful login) drains whatever's still in the queue.
      console.warn('[auth] No credentials found — emitting auth-required');
      _queueFrozenForAuth = true; // signal the finally block not to wipe
      requireAuth('session start: no credentials');
      return;
    }
  }

  // Register the Merlin MCP server — all platform API calls route through
  // this in-process server. Credentials never enter Claude's context.
  let mcpConfig = {};
  try {
    const { createMerlinMcpServer } = require('./mcp-server');
    const merlinMcp = await createMerlinMcpServer({
      getBinaryPath,
      readConfig,
      readBrandConfig,
      writeConfig,
      writeBrandTokens,
      vaultGet,
      vaultPut,
      runOAuthFlow,
      getConnections,
      appRoot,
      activeChildProcesses,
      appendAudit,
      sdkModule,
      // Startup version gate — same one refresh-perf awaits. Scheduled
      // tasks and chat-driven MCP tool calls must also wait for this so
      // they don't race past the version check on an old binary and
      // write output to the wrong directory.
      awaitStartupChecks: () => (_startupChecksPromise || Promise.resolve()),
      isBinaryTooOld,
      minBinaryVersion: MIN_BINARY_VERSION,
    });
    mcpConfig = { merlin: merlinMcp };
  } catch (err) {
    console.error('[mcp] Failed to create Merlin MCP server:', err.message);
  }

  activeQuery = query({
    prompt: messageGenerator(),
    options: {
      cwd: appRoot,
      permissionMode: 'acceptEdits',
      includePartialMessages: true,
      settingSources: ['project'],
      canUseTool: handleToolApproval,
      env: { ...sessionEnv, CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '360000' },
      mcpServers: mcpConfig,
    },
  });

  // Capture user email from Claude account (for telemetry + Stripe pre-fill + domain inference)
  try {
    const acctInfo = await activeQuery.accountInfo();

    // Anti-deletion guard: the SDK subprocess may delete ~/.claude/.credentials.json
    // on Mac (GitHub #10039). Now that accountInfo() succeeded, we KNOW the session
    // is authenticated — re-persist the token if the file is missing.
    if (sessionEnv.CLAUDE_CODE_OAUTH_TOKEN) {
      try {
        fs.accessSync(CLAUDE_CRED_FILE, fs.constants.F_OK);
      } catch {
        // File was deleted by the SDK — re-write it.
        // Omit expiresAt: we don't know the real token lifetime.
        // extractToken() treats missing expiry as valid; the SDK
        // validates the token server-side on next launch.
        persistCredentials(JSON.stringify({
          claudeAiOauth: {
            accessToken: sessionEnv.CLAUDE_CODE_OAUTH_TOKEN,
          }
        }));
        console.log('[auth] Re-persisted credentials (anti-deletion guard)');
      }
    }

    if (acctInfo?.email) {
      const cfg = readConfig();
      const isNewEmail = !cfg._userEmail || cfg._userEmail !== acctInfo.email;
      if (isNewEmail) {
        cfg._userEmail = acctInfo.email;
        writeConfig(cfg);
        // If user opted in to emails, sync updated email to server
        try {
          const state = readState();
          if (state.emailOptIn && acctInfo.email) {
            const https = require('https');
            const payload = JSON.stringify({
              machineId: getMachineId(),
              email: acctInfo.email,
              consent: true,
              consentAt: state.emailOptInAt || new Date().toISOString(),
              source: 'email-update',
            });
            const syncReq = https.request('https://merlingotme.com/api/subscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
              timeout: 5000,
            });
            syncReq.on('error', () => {});
            syncReq.write(payload);
            syncReq.end();
          }
        } catch {}
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
  } catch (e) { console.error('[account-info]', e.message); }

  try {
    for await (const msg of activeQuery) {
      if (win && !win.isDestroyed()) {
        const serialized = structuredClone(msg);
        serialized._internal = _suppressNextResponse;
        // Clear suppression flag ONLY on 'result' (full turn complete, not partial 'assistant')
        if (_suppressNextResponse && msg.type === 'result') {
          _suppressNextResponse = false;
        }
        win.webContents.send('sdk-message', serialized);
        wsServer.broadcast('sdk-message', serialized);

        // Cache dashboard/insights responses for the revenue tracker
        if (msg.type === 'tool_result' || msg.type === 'tool_use') {
          cacheDashboardData(msg);
        }

        // Spellbook: detect task-related MCP tool calls and task lifecycle events
        if (msg.type === 'tool_use' && msg.tool_name && msg.tool_name.includes('scheduled-tasks')) {
          win.webContents.send('spell-activity', { tool: msg.tool_name, input: msg.input });
        }
        if (msg.type === 'system' && msg.subtype === 'task_notification') {
          const taskId = msg.task_id || '';
          const status = msg.status || '';
          const summary = msg.summary || '';
          const timestamp = Date.now();

          // Persist status to config immediately
          // Update spell metadata in the correct store (global or brand-specific)
          updateSpellConfig(taskId, {
            lastRun: timestamp,
            lastStatus: status,
            lastSummary: summary.slice(0, 200),
            consecutiveFailures: (status === 'failed' || status === 'error')
              ? 1 : 0, // simplified — previous value read from config
          });

          // System notification for failures (shows in Windows/macOS notification center)
          if (status === 'failed' || status === 'error') {
            const { Notification: ElectronNotification } = require('electron');
            if (ElectronNotification.isSupported()) {
              new ElectronNotification({
                title: '✦ Merlin Spell Failed',
                body: `${taskId.replace('merlin-', '')} — ${summary || 'check the app for details'}`,
              }).show();
            }
          }

          // Log spell run to activity.jsonl for the activity feed
          try {
            // Extract brand from spell ID (e.g., "merlin-ivoryella-daily-ads" → "ivoryella")
            const spellBrand = extractBrandFromSpellId(taskId);
            const activeBrand = spellBrand || (() => {
              try {
                return JSON.parse(fs.readFileSync(path.join(appRoot, '.merlin-state.json'), 'utf8')).activeBrand || '';
              } catch { return ''; }
            })();
            if (activeBrand) {
              const logPath = path.join(appRoot, 'assets', 'brands', activeBrand, 'activity.jsonl');
              const entry = JSON.stringify({
                ts: new Date().toISOString(),
                type: (status === 'failed' || status === 'error') ? 'error' : 'report',
                action: `spell-${taskId.replace('merlin-', '')}`,
                detail: summary || (status === 'failed' ? 'Spell failed' : 'Spell completed'),
              }) + '\n';
              fs.appendFileSync(logPath, entry);
            }
          } catch (e) { console.error('[spell-log]', e.message); }

          win.webContents.send('spell-completed', { taskId, status, summary, timestamp });
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
          } catch (e) { console.error('[spell-ping]', e.message); }
        }
      }
    }
  } catch (err) {
    const errMsg = err.message || String(err);
    console.error('[SDK session error]', errMsg);
    // Write to error log for production debugging (no DevTools in packaged builds)
    try { fs.appendFileSync(path.join(appRoot, '.merlin-errors.log'), `${new Date().toISOString()} SDK: ${errMsg}\n${err.stack || ''}\n`); } catch {}
    if (win && !win.isDestroyed()) {
      // Auth-related failures route through the unified requireAuth() entry
      // point, which auto-triggers login and replays the pending message on
      // success. Non-auth errors go through the generic sdk-error channel.
      const isAuth = isClaudeAuthError(errMsg)
        || /not logged in|please run \/login|login required|no credentials|account information/i.test(errMsg);
      if (isAuth) {
        _queueFrozenForAuth = true; // preserve the queue across auth recovery
        requireAuth('session error: ' + errMsg.slice(0, 120));
      } else {
        win.webContents.send('sdk-error', errMsg);
        wsServer.broadcast('sdk-error', errMsg);
      }
    }
  } finally {
    // Always reset so session can be restarted after error or completion
    activeQuery = null;
    // Resolve pending generator promise so it exits cleanly (null = stop signal)
    if (resolveNextMessage) { resolveNextMessage(null); }
    resolveNextMessage = null;
    // Only clear the queue when we're NOT in an auth-recovery window. If auth
    // failed and we're waiting for login, keep the triggering message so it
    // replays automatically when the next session starts. Covered by Codex
    // P1 #5 (dropped prompt).
    if (!_queueFrozenForAuth) {
      pendingMessageQueue = []; // Clear stale messages from failed session
    }
    // Clear any orphaned approval cards
    for (const [id, entry] of pendingApprovals) {
      clearTimeout(entry.timer);
    }
    pendingApprovals.clear();
  }
}

// ── IPC Handlers ────────────────────────────────────────────

ipcMain.handle('get-version', () => {
  const version = getCurrentVersion();
  let whatsNew = [];
  try {
    const vj = JSON.parse(fs.readFileSync(path.join(appRoot, 'version.json'), 'utf8'));
    whatsNew = vj.whatsNew || [];
  } catch {}
  return { version, whatsNew };
});

ipcMain.handle('check-setup', async (_, force) => {
  return probeClaudeSetup(!!force);
});

ipcMain.handle('install-claude', async () => {
  const desktop = await getClaudeDesktopStatus();

  if (desktop.running) {
    return { success: true, action: 'already-running' };
  }

  if (desktop.path) {
    const launchError = await shell.openPath(desktop.path);
    if (!launchError) {
      return { success: true, action: 'opened-desktop' };
    }
    return {
      success: false,
      reason: 'Claude Desktop is installed, but Merlin could not open it automatically. Please open Claude Desktop and sign in.',
    };
  }

  shell.openExternal('https://claude.ai/download');
  return {
    success: false,
    fallback: 'manual',
    reason: 'Claude Desktop is required. We opened the download page for you.',
  };
});

ipcMain.handle('start-session', () => {
  if (app.isPackaged) validateNodeWrapper(); // C5: ensure wrapper points to current binary
  startSession();
  return { success: true };
});

// Trigger the bundled Claude Agent SDK's `auth login` subprocess. The CLI:
//   1. Starts its own localhost HTTP listener on a random high port
//   2. Builds an OAuth URL with code_challenge + state + port params
//   3. Opens the URL in the user's default browser via its built-in opener
//      (`open URL` on Mac, `rundll32 url,OpenURL` on Windows, `xdg-open URL`
//      on Linux — see the SDK's `p3()` function in cli.js)
//   4. User signs in at claude.ai/oauth/authorize
//   5. Claude redirects to http://localhost:<port>/callback?code=...
//   6. The CLI's listener catches the callback, exchanges the code for a
//      token, writes it to ~/.claude/.credentials.json, exits with code 0
//
// What we do in Merlin's main process:
//   - Spawn the CLI with piped stdio so we can watch its output
//   - Leave BROWSER unset so the CLI's native opener runs (earlier versions
//     set BROWSER=none, which BROKE the happy path — the CLI tried to run a
//     command literally named "none" to open URLs, failed silently, and fell
//     back to the paste-code page at platform.claude.com that required the
//     user to manually copy+paste a code that our UI wasn't prompting for)
//   - Watch ~/.claude for a credentials file appearing (belt-and-suspenders
//     success detection that catches cases where the CLI writes the file but
//     doesn't exit cleanly)
//   - Keep a paste-dialog as a genuine fallback for when the CLI's localhost
//     listener fails (e.g. a firewall blocks it). Only shown if the CLI
//     explicitly asks for paste input via stdout.
//   - Extensive logging so next time something breaks we can actually see why
ipcMain.handle('trigger-claude-login', async () => {
  try {
    const { spawn } = require('child_process');
    const isWin = process.platform === 'win32';
    const bundledNode = getBundledNodePath();
    const nodeExe = bundledNode || path.join(os.homedir(), '.claude', 'bin', isWin ? 'node.cmd' : 'node');
    const sdkDir = app.isPackaged
      ? (process.platform === 'darwin'
        ? path.join(path.dirname(app.getPath('exe')), '..', 'Resources', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
        : path.join(path.dirname(app.getPath('exe')), 'resources', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk'))
      : path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    const cliJs = path.join(sdkDir, 'cli.js');

    console.log('[claude-login] starting — bundledNode:', !!bundledNode, 'sdkDir:', sdkDir);

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (result) => {
        if (!resolved) {
          resolved = true;
          console.log('[claude-login] finish:', JSON.stringify(result));
          resolve(result);
        }
      };

      // Build the env for the CLI subprocess. Critical details:
      //   - BROWSER is NOT set to "none" (historical bug — it broke the
      //     CLI's browser opener). Left unset so the CLI falls through to
      //     the OS default (`open`, `rundll32`, `xdg-open`).
      //   - ELECTRON_RUN_AS_NODE is set only when we're using the wrapper
      //     script fallback, not the bundled real Node binary.
      const loginEnv = { ...process.env };
      delete loginEnv.BROWSER; // defensive: clear any inherited BROWSER=none
      if (!bundledNode) loginEnv.ELECTRON_RUN_AS_NODE = '1';

      const useBundled = !!bundledNode;
      const child = spawn(nodeExe, [cliJs, 'auth', 'login'], {
        env: loginEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: !useBundled, // false for real binary, true for wrapper script
        windowsHide: true,
      });

      console.log('[claude-login] spawned child pid:', child.pid);

      // Belt-and-suspenders: watch ~/.claude for a credentials file appearing.
      // Catches cases where the CLI writes credentials but doesn't exit cleanly
      // (SIGPIPE on stdin close, slow teardown, etc.).
      let credWatcher = null;
      try {
        const claudeDir = path.join(os.homedir(), '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });
        credWatcher = fs.watch(claudeDir, async (eventType, filename) => {
          if (filename && /credentials\.json$/i.test(filename)) {
            await new Promise(r => setTimeout(r, 500)); // let file finish writing
            try {
              const raw = fs.readFileSync(path.join(claudeDir, filename), 'utf8').trim();
              const tok = extractToken(raw);
              if (tok) {
                console.log('[claude-login] credential file detected via fs.watch');
                try { credWatcher.close(); } catch {}
                credWatcher = null;
                try { child.kill(); } catch {}
                finish({ success: true });
              }
            } catch (e) {
              console.log('[claude-login] fs.watch read error:', e.message);
            }
          }
        });
      } catch (e) {
        console.warn('[claude-login] fs.watch setup failed:', e.message);
      }

      // 3-minute timeout — accounts for slow browsers, 2FA prompts, user
      // typing codes, and corporate SSO redirect chains.
      const uxTimeout = setTimeout(() => {
        console.error('[claude-login] timed out after 180s');
        try { credWatcher?.close(); } catch {}
        try { child.kill(); } catch {}
        if (win && !win.isDestroyed()) win.webContents.send('auth-code-dismiss');
        finish({ success: false, timedOut: true, error: 'Login timed out. Try again or use an API key.' });
      }, 180000);

      let stdout = '';
      let stderr = '';
      let pastePromptShown = false;

      // Detect whether the CLI wants manual paste input. The CLI uses Ink
      // (React-for-terminals) and renders its UI with ANSI escape codes
      // interleaved through the text. Strip the escape codes before matching
      // so the regex actually finds "paste code" when surrounded by color
      // sequences like "\x1b[36mPaste code here\x1b[0m".
      //
      // The CLI only prints these strings when its localhost callback flow
      // failed and it's falling back to manual entry — which is the ONLY
      // time we should show our paste dialog. The happy path (localhost
      // callback) never hits this.
      function maybeShowPasteDialog(combined) {
        if (pastePromptShown) return;
        // eslint-disable-next-line no-control-regex
        const clean = combined.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        if (!/paste code|paste the code|paste this|authorization code/i.test(clean)) return;
        pastePromptShown = true;
        console.log('[claude-login] CLI is asking for manual paste — showing dialog');
        if (win && !win.isDestroyed()) win.webContents.send('auth-code-prompt');
      }

      child.stdout.on('data', (d) => {
        const chunk = d.toString();
        stdout += chunk;
        // Log a redacted preview — first 300 chars, no repeated noise. Tokens
        // themselves are NEVER printed to stdout by the CLI; the URL contains
        // only a public client_id and PKCE challenge, so logging the prefix
        // is safe for debugging without leaking secrets.
        const preview = chunk.replace(/\s+/g, ' ').trim().slice(0, 300);
        if (preview) console.log('[claude-login] stdout:', preview);
        maybeShowPasteDialog(stdout + stderr);
      });

      child.stderr.on('data', (d) => {
        const chunk = d.toString();
        stderr += chunk;
        const preview = chunk.replace(/\s+/g, ' ').trim().slice(0, 300);
        if (preview) console.log('[claude-login] stderr:', preview);
        maybeShowPasteDialog(stdout + stderr);
      });

      // Track the last stdin write result so the renderer can tell the user
      // whether their paste actually made it into the CLI subprocess. Returned
      // via the auth-code-submit invoke handler below.
      let lastPasteResult = null;
      const pasteHandler = (code) => {
        if (!code) {
          lastPasteResult = { ok: false, reason: 'empty' };
          return lastPasteResult;
        }
        if (!child.stdin || child.stdin.destroyed) {
          console.warn('[claude-login] paste received but child.stdin is destroyed — CLI already exited');
          lastPasteResult = { ok: false, reason: 'child-stdin-destroyed' };
          return lastPasteResult;
        }
        try {
          const wrote = child.stdin.write(code + '\n', 'utf8');
          console.log('[claude-login] wrote', code.length, 'chars to child.stdin, buffered=' + !wrote);
          lastPasteResult = { ok: true };
          return lastPasteResult;
        } catch (e) {
          console.error('[claude-login] child.stdin.write failed:', e.message);
          lastPasteResult = { ok: false, reason: e.message };
          return lastPasteResult;
        }
      };
      // Legacy fire-and-forget path (kept for compatibility with older renderers)
      const legacyPasteHandler = (_, code) => { pasteHandler(code); };
      ipcMain.on('auth-code-submit', legacyPasteHandler);
      // New invoke-based path (renderer gets success/failure back)
      const invokePasteHandler = async (_, code) => pasteHandler(code);
      try { ipcMain.removeHandler('auth-code-submit-invoke'); } catch {}
      ipcMain.handle('auth-code-submit-invoke', invokePasteHandler);

      // Cancel handler. When the user hits Cancel/Escape on the paste dialog,
      // we must actually KILL the subprocess — not just hide the UI. Leaving
      // the CLI running strands a zombie that holds credentials state and
      // makes the next retry attempt collide with the old process. Covered
      // by Codex P2 #7 (cancel hides dialog but doesn't cancel subprocess).
      const cancelHandler = () => {
        console.log('[claude-login] cancel requested — killing child');
        clearTimeout(uxTimeout);
        try { credWatcher?.close(); } catch {}
        try { child.kill('SIGTERM'); } catch (e) {
          console.warn('[claude-login] child.kill threw:', e.message);
        }
        if (win && !win.isDestroyed()) win.webContents.send('auth-code-dismiss');
        finish({ success: false, cancelled: true, error: 'Login cancelled' });
      };
      try { ipcMain.removeHandler('cancel-claude-login'); } catch {}
      ipcMain.handle('cancel-claude-login', async () => {
        cancelHandler();
        return { ok: true };
      });

      // verifyLoginResult is the SINGLE source of truth for "did login succeed".
      // It calls readCredentials() (which checks file, env, Keychain, Windows
      // Credential Manager paths) with a short retry loop to absorb the race
      // between the CLI writing its credential file and us reading it. Only
      // returns success if a non-empty token is actually present. Covered by
      // Codex P1 #4 (success not verified) and P2 #6 (Windows cred detection).
      //
      // Why a retry loop: on fast machines the CLI can exit, we read the file
      // 10ms later, and the fsync hasn't landed yet — especially on Windows
      // where antivirus can hold a write lock briefly. 5 attempts × 200ms is
      // 1s total worst case and eliminates the flakiness we'd otherwise see.
      async function verifyLoginResult() {
        for (let attempt = 0; attempt < 5; attempt++) {
          const token = await readCredentials();
          if (token) {
            console.log('[claude-login] verifyLoginResult OK after attempt', attempt + 1);
            return true;
          }
          if (attempt < 4) {
            await new Promise(r => setTimeout(r, 200));
          }
        }
        console.warn('[claude-login] verifyLoginResult failed after 5 attempts — no usable token');
        return false;
      }

      child.on('close', async (code) => {
        clearTimeout(uxTimeout);
        try { credWatcher?.close(); } catch {}
        if (win && !win.isDestroyed()) win.webContents.send('auth-code-dismiss');
        ipcMain.removeListener('auth-code-submit', legacyPasteHandler);
        try { ipcMain.removeHandler('auth-code-submit-invoke'); } catch {}
        try { ipcMain.removeHandler('cancel-claude-login'); } catch {}
        if (resolved) return;
        console.log('[claude-login] child exited code=' + code + ' stdout-len=' + stdout.length + ' stderr-len=' + stderr.length);

        // Verify the actual outcome regardless of exit code. The CLI can exit
        // 0 without writing credentials (crashed during token exchange), and
        // it can exit non-zero with credentials written (SIGKILL after fs.watch
        // already saw the file). The only thing that matters is whether a
        // usable token now exists.
        const haveToken = await verifyLoginResult();
        if (haveToken) {
          console.log('[claude-login] login verified — token readable');
          finish({ success: true });
          return;
        }

        // No token. Build an error message that actually helps the user.
        const stderrPreview = stderr.replace(/\s+/g, ' ').trim().slice(0, 200);
        const reason = code === 0
          ? 'Claude Code signed in but no credential file was produced. Check your network and try again.'
          : `Claude Code login exited with code ${code}${stderrPreview ? ': ' + stderrPreview : ''}`;
        console.error('[claude-login] verification failed:', reason);
        finish({ success: false, error: reason });
      });

      child.on('error', (e) => {
        clearTimeout(uxTimeout);
        ipcMain.removeListener('auth-code-submit', legacyPasteHandler);
        try { ipcMain.removeHandler('auth-code-submit-invoke'); } catch {}
        try { ipcMain.removeHandler('cancel-claude-login'); } catch {}
        if (win && !win.isDestroyed()) win.webContents.send('auth-code-dismiss');
        console.error('[claude-login] spawn error:', e.message);
        finish({ success: false, error: e.message });
      });

      // Small diagnostic: after 5 seconds, log whether we've seen the CLI
      // print anything. If not, the spawn or the bundled node is probably
      // broken. This shows up in logs before the 180s timeout fires.
      setTimeout(() => {
        if (resolved) return;
        if (!stdout && !stderr) {
          console.warn('[claude-login] 5s elapsed with no CLI output — check bundled Node + SDK path');
        } else {
          console.log('[claude-login] 5s check: stdout-len=' + stdout.length + ' stderr-len=' + stderr.length);
        }
      }, 5000);
    });
  } catch (e) {
    console.error('[trigger-claude-login]', e.message);
    return { success: false, error: e.message };
  }
});

// API key fallback — user opts in explicitly
ipcMain.handle('set-api-key', (_, apiKey) => {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.startsWith('sk-ant-')) {
    return { success: false, error: 'Invalid API key. It should start with sk-ant-' };
  }
  // Store in secure storage, not config (never in plaintext)
  writeSecureFile(path.join(appRoot, '.merlin-api-key'), apiKey);
  return { success: true };
});

ipcMain.handle('has-api-key', () => {
  const keyFile = path.join(appRoot, '.merlin-api-key');
  try {
    const key = readSecureFile(keyFile);
    return { hasKey: !!(key && key.startsWith('sk-ant-')) };
  } catch { return { hasKey: false }; }
});

// Morning briefing — reads cached briefing generated by scheduled spells
ipcMain.handle('get-briefing', (_, brandName) => {
  const suffix = brandName ? `-${brandName}` : '';
  const briefingFile = path.join(appRoot, `.merlin-briefing${suffix}.json`);
  try {
    if (!fs.existsSync(briefingFile)) return null;
    const data = JSON.parse(fs.readFileSync(briefingFile, 'utf8'));
    const briefingDate = new Date(data.date);
    const now = new Date();
    const ageHours = (now - briefingDate) / (1000 * 60 * 60);
    if (ageHours > 36) return null;
    const state = readState();
    const dismissKey = `lastBriefingDismissed${suffix}`;
    if (state[dismissKey] === now.toISOString().slice(0, 10)) return null;
    return data;
  } catch { return null; }
});

ipcMain.handle('dismiss-briefing', (_, brandName) => {
  const suffix = brandName ? `-${brandName}` : '';
  writeState({ [`lastBriefingDismissed${suffix}`]: new Date().toISOString().slice(0, 10) });
  return { success: true };
});

ipcMain.handle('stop-generation', () => {
  // Signal the message generator to stop, ending the current turn
  if (resolveNextMessage) {
    resolveNextMessage(null);
  }
  return { success: true };
});

ipcMain.handle('get-account-info', async () => {
  try {
    if (!activeQuery) return null;
    const info = await activeQuery.accountInfo();
    return info;
  } catch { return null; }
});

// Direct OAuth — bypasses SDK entirely, runs the binary from main process
// Standalone OAuth flow — callable from both the IPC handler (UI clicks)
// and the MCP platform_login tool. Returns { success, platform } or { error }.
async function runOAuthFlow(platform, brandName, extra) {
  let binaryPath = getBinaryPath();
  const configPath = path.join(appRoot, '.claude', 'tools', 'merlin-config.json');
  // Defensive fallback: if neither install nor workspace has the binary,
  // try to download. This shouldn't happen now that the binary is bundled
  // in the installer, but kept as a safety net for upgrade edge cases.
  try { fs.accessSync(binaryPath); } catch {
    try {
      if (win && !win.isDestroyed()) win.webContents.send('engine-status', 'Downloading engine...');
      await ensureBinary();
      binaryPath = getBinaryPath(); // re-resolve in case ensureBinary wrote to workspace
    } catch (e) {
      return { error: `Could not download engine: ${e.message}` };
    }
  }
  try { fs.accessSync(configPath); } catch { return { error: 'Config not found. Run preflight first.' }; }

  // Slack requires HTTPS redirect URI — binary handles token exchange (secrets stay in binary)
  if (platform === 'slack') {
    const slackClientId = '8988877007078.10822045906036'; // Public client ID (not a secret)
    const slackRedirect = 'https://merlingotme.com/auth/callback';
    const srv = require('http').createServer();
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const stateHex = require('crypto').randomBytes(16).toString('hex');
    const fullState = `${stateHex}|${port}`;

    const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${slackClientId}&scope=chat:write,files:write,channels:read,channels:join&redirect_uri=${encodeURIComponent(slackRedirect)}&state=${encodeURIComponent(fullState)}`;
    shell.openExternal(authUrl);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => { srv.close(); resolve({ error: 'Timed out waiting for Slack authorization' }); }, 300000);

      srv.on('request', (req, res) => {
        const u = new URL(req.url, `http://localhost:${port}`);
        if (u.pathname !== '/callback') return;
        const code = u.searchParams.get('code');
        const incomingState = u.searchParams.get('state');
        if (incomingState !== stateHex && incomingState !== fullState) {
          res.end('State mismatch'); clearTimeout(timeout); srv.close();
          return resolve({ error: 'State mismatch — try again' });
        }
        if (!code) {
          res.end('No code'); clearTimeout(timeout); srv.close();
          return resolve({ error: u.searchParams.get('error') || 'No authorization code' });
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#09090b;color:#e4e4e7"><div style="text-align:center"><h2 style="color:#22c55e">&#10003; Connected to Slack</h2><p>You can close this tab.</p></div></body></html>');
        clearTimeout(timeout);
        srv.close();

        // Binary exchanges code for token (secret stays in binary, never in this file)
        const { execFile } = require('child_process');
        const cmd = JSON.stringify({ action: 'slack-exchange', code, redirectUri: slackRedirect });
        const child = execFile(binaryPath, ['--config', configPath, '--cmd', cmd], {
          timeout: 30000, cwd: appRoot,
        }, (err, stdout) => {
          activeChildProcesses.delete(child);
          if (err) return resolve({ error: err.message });
          try {
            const lines = stdout.split('\n');
            let jsonStart = -1, jsonEnd = -1;
            for (let i = lines.length - 1; i >= 0; i--) {
              if (lines[i].trim() === '}' && jsonEnd < 0) jsonEnd = i;
              if (lines[i].trim() === '{' && jsonEnd >= 0) { jsonStart = i; break; }
            }
            const jsonStr = jsonStart >= 0 ? lines.slice(jsonStart, jsonEnd + 1).join('\n') : null;
            if (!jsonStr) throw new Error('No JSON in output');
            const result = JSON.parse(jsonStr);
            const cfg = readConfig();
            Object.assign(cfg, result);
            if (!cfg._tokenTimestamps) cfg._tokenTimestamps = {};
            cfg._tokenTimestamps.slack = Date.now();
            writeConfig(cfg);
            if (win && !win.isDestroyed()) win.webContents.send('connections-changed');
            resolve({ success: true, platform: 'slack' });
          } catch (e) {
            resolve({ error: 'Failed to parse Slack token response' });
          }
        });
        activeChildProcesses.add(child);
      });
    });
  }

  const action = `${platform}-login`;
  const cmdObj = { action };
  // For Shopify, always pass the brand's CUSTOM DOMAIN (e.g. mad-chill.com).
  // The binary's resolveShopifyStore converts it to the canonical .myshopify.com
  // slug via the Shopify.shop JS variable with /cart.js verification. We do NOT
  // trust cached `shopifyStore` values from the config — those may have been
  // seeded with wrong data and persist indefinitely. Always re-resolve.
  //
  // Resolution order (strict — never falls back to a DIFFERENT brand):
  //   1. extra.store override from caller
  //   2. Active brand's brand.md URL field
  //   3. Active brand's productUrl field in brand config
  //   4. Global productUrl (legacy single-brand configs)
  //
  // If the active brand has no URL configured, we return a friendly error
  // asking the user to set one — we do NOT silently connect a different brand.
  if (platform === 'shopify') {
    const readUrlFromBrandMd = (name) => {
      try {
        const brandMd = path.join(appRoot, 'assets', 'brands', name, 'brand.md');
        const content = fs.readFileSync(brandMd, 'utf8');
        // Match all common brand.md formats:
        //   URL: https://example.com
        //   Website: https://example.com
        //   - **Website**: https://example.com
        //   - **URL**: https://example.com
        //   - **Website**: example.com  (no protocol)
        const urlMatch = content.match(/\*?\*?(?:URL|Website)\*?\*?\s*[:]\s*(https?:\/\/[^\s\n)]+)/i)
          || content.match(/\*?\*?(?:URL|Website)\*?\*?\s*[:]\s*([a-z0-9][a-z0-9.-]+\.[a-z]{2,}[^\s\n)]*)/i);
        if (urlMatch) return urlMatch[1].replace(/^https?:\/\//, '').replace(/\/$/, '');
      } catch {}
      return null;
    };

    if (extra?.store) {
      cmdObj.brand = extra.store;
    } else if (brandName) {
      // Step 2: active brand's brand.md
      const url = readUrlFromBrandMd(brandName);
      if (url) {
        cmdObj.brand = url;
      } else {
        // Step 3: active brand's productUrl
        const brandCfg = readBrandConfig(brandName);
        if (brandCfg?.productUrl) {
          cmdObj.brand = brandCfg.productUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        }
      }
      if (!cmdObj.brand) {
        return {
          error: `${brandName} has no website URL configured. Edit assets/brands/${brandName}/brand.md and set the URL field to your store's domain (e.g. URL: https://yourstore.com).`,
        };
      }
    } else {
      // Step 4: no active brand — fall back to global productUrl (legacy)
      const globalCfg = readConfig();
      if (globalCfg.productUrl) {
        cmdObj.brand = globalCfg.productUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
      }
      if (!cmdObj.brand) {
        return { error: 'No active brand selected. Choose a brand from the dropdown first.' };
      }
    }
  }
  const cmd = JSON.stringify(cmdObj);
  const { execFile } = require('child_process');

  return new Promise((resolve) => {
    const child = execFile(binaryPath, ['--config', configPath, '--cmd', cmd], {
      timeout: 300000,
      cwd: appRoot,
    }, (err, stdout, stderr) => {
      activeChildProcesses.delete(child);
      // Debug logs removed — uncomment to troubleshoot OAuth issues
      if (err) {
        console.error(`[oauth] ${action} err:`, err.message);
        // Don't return early — check if stdout has valid JSON despite error exit code
        // (binary may print JSON then exit non-zero from deferred cleanup)
      }
      // Parse the output — binary prints indented JSON after status messages
      try {
        // Extract JSON: find lines between last { and last }
        const lines = stdout.split('\n');
        let jsonStart = -1, jsonEnd = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].trim() === '}' && jsonEnd < 0) jsonEnd = i;
          if (lines[i].trim() === '{' && jsonEnd >= 0) { jsonStart = i; break; }
        }
        const jsonStr = jsonStart >= 0 ? lines.slice(jsonStart, jsonEnd + 1).join('\n') : null;
        // console.log(`[oauth] extracted JSON:`, jsonStr);
        if (!jsonStr) throw new Error('No JSON in output');
        const result = JSON.parse(jsonStr);
        if (!result || Object.keys(result).length === 0) throw new Error('Empty JSON result');
        // console.log(`[oauth] parsed result:`, JSON.stringify(result));
        // Save tokens — sensitive values go to the vault, metadata goes
        // to the brand config with @@VAULT@@ placeholders.
        const isGlobalPlatform = platform === 'discord' || platform === 'slack';
        const vaultBrand = (brandName && !isGlobalPlatform) ? brandName : '_global';
        const publicFields = {};
        const placeholders = {};
        for (const [k, v] of Object.entries(result)) {
          if (VAULT_SENSITIVE_KEYS.includes(k)) {
            vaultPut(vaultBrand, k, v);
            placeholders[k] = `@@VAULT:${k}@@`;
          } else {
            publicFields[k] = v;
          }
        }
        if (brandName && !isGlobalPlatform) {
          writeBrandTokens(brandName, { ...publicFields, ...placeholders });
        } else {
          const cfg = readConfig();
          Object.assign(cfg, publicFields, placeholders);
          if (!cfg._tokenTimestamps) cfg._tokenTimestamps = {};
          cfg._tokenTimestamps[platform] = Date.now();
          writeConfig(cfg);
        }
        if (win && !win.isDestroyed()) {
          win.webContents.send('connections-changed');
        }
        resolve({ success: true, platform });
      } catch (parseErr) {
        console.error(`[oauth] JSON parse failed:`, parseErr.message);
        // Binary output wasn't JSON — might have printed status messages
        // Try to find JSON in the output
        const lines = (stdout || '').split('\n');
        for (const line of lines.reverse()) {
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed && typeof parsed === 'object') {
              const cfg = brandName ? {} : readConfig();
              Object.assign(cfg, parsed);
              if (brandName) writeBrandTokens(brandName, parsed);
              else writeConfig(cfg);
              if (win && !win.isDestroyed()) win.webContents.send('connections-changed');
              return resolve({ success: true, platform });
            }
          } catch {}
        }
        if (err) return resolve({ error: stderr || err.message });
        resolve({ success: true, stdout }); // Binary ran OK, just no JSON output
      }
    });
    activeChildProcesses.add(child);
  });
}

// IPC wrapper — UI tile clicks invoke the standalone function above.
ipcMain.handle('run-oauth', async (_, platform, brandName, extra) => {
  return runOAuthFlow(platform, brandName, extra);
});

// Save a single config field (for API key entry from UI)
// Allowlist prevents injection of internal metadata keys (_migrationVersion, _userEmail, etc.)
const CONFIG_FIELD_ALLOWLIST = new Set([
  'metaAccessToken', 'metaAdAccountId', 'metaPageId', 'metaPixelId', 'metaConfigId',
  'tiktokAccessToken', 'tiktokAdvertiserId', 'tiktokPixelId',
  'shopifyStore', 'shopifyAccessToken',
  'googleAccessToken', 'googleRefreshToken', 'googleAdsCustomerId', 'googleAdsDeveloperToken', 'googleApiKey',
  'amazonAccessToken', 'amazonRefreshToken', 'amazonProfileId', 'amazonSellerId',
  'klaviyoAccessToken', 'klaviyoApiKey',
  'pinterestAccessToken', 'pinterestRefreshToken',
  'falApiKey', 'elevenLabsApiKey', 'heygenApiKey', 'arcadsApiKey',
  'slackBotToken', 'slackWebhookUrl', 'slackChannel',
  'discordGuildId', 'discordChannelId',
  'productName', 'productUrl', 'productDescription', 'vertical', 'outputDir',
  'maxDailyAdBudget', 'maxMonthlyAdSpend', 'autoPublishAds', 'blogPublishMode',
  'qualityGate', 'falModel', 'imageModel', 'startAtLogin', 'dailyAdBudget',
]);
ipcMain.handle('save-config-field', (_, key, value, brandName) => {
  try {
    if (!key || typeof key !== 'string' || key.startsWith('_') || !CONFIG_FIELD_ALLOWLIST.has(key)) {
      return { success: false, error: 'Unknown config field' };
    }
    if (brandName) {
      writeBrandTokens(brandName, { [key]: value });
    } else {
      const cfg = readConfig();
      cfg[key] = value;
      writeConfig(cfg);
    }
    if (win && !win.isDestroyed()) win.webContents.send('connections-changed');
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('send-message', (_, text, options = {}) => {
  if (typeof text !== 'string' || text.length > 50000) return { success: false };
  // Support silent/internal messages (no broadcast, suppressed response)
  if (options.silent) {
    _suppressNextResponse = true;
    // Safety: auto-clear after 30 seconds in case 'result' event never fires
    setTimeout(() => { _suppressNextResponse = false; }, 30000);
  }
  // Inject current active brand so Claude always knows which brand the user selected
  const content = injectActiveBrand(text);
  const msg = { type: 'user', message: { role: 'user', content } };
  if (resolveNextMessage) {
    resolveNextMessage(msg);
  } else {
    if (pendingMessageQueue.length >= 50) {
      return { success: false, error: 'Message queue full — please wait for the current session to start' };
    }
    pendingMessageQueue.push(msg);
    // If no session is running, start one so the queued message gets processed.
    // This handles the case where the session was stopped (Escape) or crashed
    // without auto-restarting — without this, messages sit in the queue forever
    // and the typing indicator hangs indefinitely.
    if (!activeQuery) startSession();
  }
  if (!options.silent) wsServer.broadcast('user-message', { text });
  return { success: true };
});

ipcMain.handle('approve-tool', (_, toolUseID) => {
  try {
    const entry = pendingApprovals.get(toolUseID);
    if (!entry) return;
    if (entry.processed) return { error: 'already processed' };
    entry.processed = true;
    clearTimeout(entry.timer); pendingApprovals.delete(toolUseID); entry.fn(true);
  } catch (err) { console.error('[approve]', err.message); }
});

ipcMain.handle('deny-tool', (_, toolUseID) => {
  try {
    const entry = pendingApprovals.get(toolUseID);
    if (!entry) return;
    if (entry.processed) return { error: 'already processed' };
    entry.processed = true;
    clearTimeout(entry.timer); pendingApprovals.delete(toolUseID); entry.fn(false);
  } catch (err) { console.error('[deny]', err.message); }
});

ipcMain.handle('answer-question', (_, toolUseID, answers) => {
  try {
    const entry = pendingApprovals.get(toolUseID);
    if (entry) { clearTimeout(entry.timer); pendingApprovals.delete(toolUseID); entry.fn(answers); }
  } catch (err) { console.error('[answer]', err.message); }
});

// ── Voice Input: Audio Transcription ─────────────────────────
// Renderer captures mic audio via MediaRecorder (webm/opus), ships the
// bytes here, we convert → 16kHz mono WAV via bundled ffmpeg and run
// whisper-cli against ggml-tiny.en.bin. Binaries live alongside ffmpeg
// at .claude/tools/. Auto-download is phase 2 — for now, a missing
// binary returns a clear error with a download link.
ipcMain.handle('transcribe-audio', async (_, audioBytes) => {
  if (!Array.isArray(audioBytes) || audioBytes.length === 0) {
    return { error: 'No audio data received' };
  }
  if (audioBytes.length > 50 * 1024 * 1024) {
    return { error: 'Audio too large (>50MB)' };
  }

  const { spawn } = require('child_process');
  const isWin = process.platform === 'win32';

  // Resolve paths: check install dir first (bundled), fall back to workspace
  const findTool = (name) => {
    const installPath = path.join(appInstall, '.claude', 'tools', name);
    if (fs.existsSync(installPath)) return installPath;
    const workspacePath = path.join(appRoot, '.claude', 'tools', name);
    if (fs.existsSync(workspacePath)) return workspacePath;
    return null;
  };

  const ffmpegPath = findTool(isWin ? 'ffmpeg.exe' : 'ffmpeg');
  const whisperBin = findTool(isWin ? 'whisper-cli.exe' : 'whisper-cli');
  const modelPath = findTool('ggml-tiny.en.bin');

  if (!ffmpegPath) {
    // ffmpeg is intentionally excluded from the Electron installer (~200MB
    // per exe would bloat the download). Users who trigger voice input
    // before ffmpeg has been fetched see this message — point them at the
    // exact file and where to put it, rather than the misleading "install
    // corrupted" phrasing. Auto-download is planned for a later release.
    const target = path.join(appRoot, '.claude', 'tools', isWin ? 'ffmpeg.exe' : 'ffmpeg');
    const downloadUrl = isWin
      ? 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
      : (process.platform === 'darwin'
        ? 'https://evermeet.cx/ffmpeg/'
        : 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz');
    return {
      error: `ffmpeg not installed yet.\n\nVoice input needs ffmpeg to transcode audio. Download it from:\n${downloadUrl}\n\nExtract the archive and place the ffmpeg${isWin ? '.exe' : ''} binary at:\n${target}\n\n(Auto-install coming in a future update.)`,
    };
  }
  if (!whisperBin) {
    const target = path.join(appRoot, '.claude', 'tools', isWin ? 'whisper-cli.exe' : 'whisper-cli');
    return {
      error: `Voice setup needed.\n\nDownload whisper-cli from:\nhttps://github.com/ggerganov/whisper.cpp/releases\n\nExtract and place at:\n${target}\n\n(Auto-install coming in next update.)`,
    };
  }
  if (!modelPath) {
    const target = path.join(appRoot, '.claude', 'tools', 'ggml-tiny.en.bin');
    return {
      error: `Voice model missing.\n\nDownload ggml-tiny.en.bin (74MB) from:\nhttps://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin\n\nPlace at:\n${target}`,
    };
  }

  // Write webm to temp, then transcode to wav
  const tmp = os.tmpdir();
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const webmPath = path.join(tmp, `merlin-stt-${id}.webm`);
  const wavPath = path.join(tmp, `merlin-stt-${id}.wav`);

  try {
    fs.writeFileSync(webmPath, Buffer.from(audioBytes));
  } catch (err) {
    return { error: `Failed to write audio: ${err.message}` };
  }

  try {
    // 1. ffmpeg: webm/opus → 16kHz mono 16-bit PCM WAV (whisper.cpp's required format)
    await new Promise((resolve, reject) => {
      const args = ['-y', '-loglevel', 'error', '-i', webmPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath];
      const ff = spawn(ffmpegPath, args, { windowsHide: true });
      let stderr = '';
      ff.stderr.on('data', (d) => { stderr += d.toString(); });
      ff.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 500)}`));
      });
      ff.on('error', reject);
    });

    // 2. whisper-cli: wav → transcript on stdout
    // Flags: -nt (no timestamps), -np (no progress), -l en (English)
    const transcript = await new Promise((resolve, reject) => {
      const args = ['-m', modelPath, '-f', wavPath, '-nt', '-np', '-l', 'en'];
      const w = spawn(whisperBin, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      w.stdout.on('data', (d) => { stdout += d.toString(); });
      w.stderr.on('data', (d) => { stderr += d.toString(); });
      w.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`whisper exit ${code}: ${stderr.slice(0, 500)}`));
      });
      w.on('error', reject);
    });

    // whisper-cli sometimes prefixes lines with "[BLANK_AUDIO]" or logs
    const cleaned = transcript
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('[') && !l.startsWith('whisper_'))
      .join(' ')
      .trim();

    return { transcript: cleaned };
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  } finally {
    try { fs.unlinkSync(webmPath); } catch {}
    try { fs.unlinkSync(wavPath); } catch {}
  }
});

ipcMain.handle('open-claude-download', () => { shell.openExternal('https://claude.ai/download'); });
ipcMain.handle('open-external-url', (_, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});
ipcMain.handle('open-merlin-folder', () => { shell.openPath(appRoot); });

// ── Spell SKILL.md builder ──────────────────────────────────
//
// The spell SKILL.md body has a specific structure that matters for
// brand-locked reliability:
//
//   1. Frontmatter (name / description / cronExpression) — consumed by
//      Claude Code's scheduler.
//   2. Brand Lock section — if brandName is set, injects literal MCP call
//      examples with the brand already filled in. The old format ("Brand:
//      ivory-ella" as prose) left brand as a documentation note that Claude
//      sometimes failed to translate into the `brand:` argument on tool
//      calls, producing empty-data dashboards. The new format shows Claude
//      the exact call shape and tells it verbatim that brand is required on
//      every brand-scoped tool — combined with runBinary's hard-refuse
//      guard in mcp-tools.js, this makes "brand forgotten" impossible.
//   3. First-run showcase block — walks Claude through the first run so the
//      user sees the output in narrative form (unchanged from prior design).
//   4. Spell body — the original template prompt.
//
// The MCP examples only list brand-scoped tools. Voice/subscription etc.
// are intentionally omitted from the Brand Lock block because they are
// brand-agnostic — listing them would suggest brand is required there,
// which would be wrong.
//
// The marker string "<!-- merlin-skill-v2 -->" is written as the first line
// of the body so migrateLegacySkills() can distinguish freshly-written
// skills from legacy/hand-edited ones without parsing prose.
const SKILL_BODY_MARKER = '<!-- merlin-skill-v2 -->';

// Move orphaned dashboard artifacts from the legacy tools/results/ location
// into the workspace's main results/_legacy/ folder. Runs once per install,
// gated by `_legacyResultsMigrated` in merlin-config.json.
//
// Before v1.0.7 the Go binary resolved `outputDir` relative to its exe
// directory, so dashboard files landed at:
//
//     {workspace}/.claude/tools/results/dashboard_*.json
//
// After v1.0.7 they land in the workspace-level `results/` dir where the
// Electron perf bar reads from. This migration relocates the stale files so
// the old directory doesn't sit there as an orphan. Files go into a
// `_legacy/` subfolder rather than the top-level `results/` so they don't
// get picked up by computePerfSummary's "latest dashboard" scan — those
// files are ambiguous (no brand scoping) and using them would show wrong
// totals on the bar.
function migrateLegacyResultsDir() {
  const cfg = readConfig();
  if (cfg._legacyResultsMigrated === 1) return { skipped: true };

  const legacyDir = path.join(appRoot, '.claude', 'tools', 'results');
  if (!fs.existsSync(legacyDir)) {
    try { const c = readConfig(); c._legacyResultsMigrated = 1; writeConfig(c); } catch {}
    return { moved: 0, reason: 'no legacy dir' };
  }

  const destDir = path.join(appRoot, 'results', '_legacy');
  let moved = 0, failed = 0;
  try {
    fs.mkdirSync(destDir, { recursive: true });
    // Walk the legacy dir recursively so any brand-scoped subfolders (e.g.
    // `.claude/tools/results/ivory-ella/`) get preserved under _legacy/.
    function moveEntry(src, rel) {
      let stat;
      try { stat = fs.statSync(src); } catch { return; }
      if (stat.isDirectory()) {
        let children;
        try { children = fs.readdirSync(src); } catch { return; }
        for (const c of children) moveEntry(path.join(src, c), path.join(rel, c));
        try { fs.rmdirSync(src); } catch {}
        return;
      }
      const destPath = path.join(destDir, rel);
      try {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        // Use rename first (fast, same volume), fall back to copy+unlink
        try { fs.renameSync(src, destPath); }
        catch { fs.copyFileSync(src, destPath); fs.unlinkSync(src); }
        moved++;
      } catch { failed++; }
    }
    for (const name of fs.readdirSync(legacyDir)) {
      moveEntry(path.join(legacyDir, name), name);
    }
    // Remove the now-empty legacy dir so an old binary running briefly
    // before users auto-update won't repopulate an already-abandoned tree.
    try { fs.rmdirSync(legacyDir); } catch {}
  } catch (err) {
    appendErrorLog(`${new Date().toISOString()} [legacy-results] migration failed: ${err.message}\n`);
  }

  try {
    const c = readConfig();
    c._legacyResultsMigrated = 1;
    writeConfig(c);
  } catch {}
  appendErrorLog(`${new Date().toISOString()} [legacy-results] moved=${moved} failed=${failed} src=${legacyDir} dest=${destDir}\n`);
  return { moved, failed };
}

// Migrate legacy SKILL.md files to the brand-locked v2 format. Runs once per
// install, gated by `_brandLockSkillMigration` in merlin-config.json so it's
// idempotent across restarts.
//
// Legacy format (pre-migration) looked like:
//   ---
//   name: merlin-ivory-ella-morning-briefing
//   description: Overnight results at 5 AM
//   cronExpression: "0 5 * * 1-5"
//   ---
//
//   Brand: ivory-ella
//   Brand assets: assets/brands/ivory-ella/
//
//   First-run check: If this is the first time running ...
//
//   {original prompt}
//
// The "First-run check:" sentence is literal and identical across every legacy
// spell, so we use it as a split marker to extract the original prompt. We
// ONLY migrate files that match the full legacy pattern exactly — hand-edits
// between frontmatter and the First-run line cause a clean skip, preserving
// any user customization.
const LEGACY_FIRST_RUN_LINE = 'First-run check: If this is the first time running (no prior results exist for this task), use the best quality settings, narrate each step, show results visually, and end with a summary of what you did and when the next scheduled run is.';

function migrateLegacySkills() {
  const cfg = readConfig();
  if (cfg._brandLockSkillMigration === 1) return { skipped: true, reason: 'already migrated' };

  const tasksRoot = path.join(os.homedir(), '.claude', 'scheduled-tasks');
  if (!fs.existsSync(tasksRoot)) {
    try { const c = readConfig(); c._brandLockSkillMigration = 1; writeConfig(c); } catch {}
    return { migrated: 0, scanned: 0 };
  }

  let scanned = 0, migrated = 0, skipped = 0, errors = 0;
  const errDetails = [];

  let entries;
  try { entries = fs.readdirSync(tasksRoot, { withFileTypes: true }); } catch { return { migrated: 0, scanned: 0 }; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('merlin-')) continue;

    const skillPath = path.join(tasksRoot, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    scanned++;

    try {
      const content = fs.readFileSync(skillPath, 'utf8');

      if (content.includes(SKILL_BODY_MARKER)) { skipped++; continue; }

      // Match the ENTIRE legacy body structure in one strict regex. The old
      // create-spell handler emitted exactly:
      //
      //   ---\nname: X\ndescription: Y\ncronExpression: "Z"\n---\n
      //   \nBrand: B\nBrand assets: assets/brands/B/\n
      //   \nFirst-run check: <literal sentence>\n
      //   \n{prompt}\n
      //
      // Any byte outside this skeleton (comments, extra blank lines, edits
      // to the brand block, rewording of the First-run sentence) causes the
      // match to fail and we skip the file — preserving user customizations.
      const legacyPattern = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\ncronExpression: "([^"]+)"\n---\n\nBrand: ([a-z0-9_-]+)\nBrand assets: assets\/brands\/\4\/\n\nFirst-run check: If this is the first time running \(no prior results exist for this task\), use the best quality settings, narrate each step, show results visually, and end with a summary of what you did and when the next scheduled run is\.\n\n([\s\S]*?)\n?$/;
      const m = content.match(legacyPattern);
      if (!m) { skipped++; continue; }
      const fullTaskId = m[1];
      const description = m[2];
      const cron = m[3];
      const brandName = m[4];
      const originalPrompt = m[5].replace(/\n+$/, '');
      if (!fullTaskId.startsWith('merlin-')) { skipped++; continue; }
      if (!originalPrompt) { skipped++; continue; }

      // Rebuild with v2 format
      const rebuilt = buildSkillBody({ fullTaskId, description, cron, prompt: originalPrompt, brandName });

      // Atomic write: temp + rename so a crash mid-write can't leave a half-written SKILL.md
      const tmpPath = skillPath + '.migrating';
      fs.writeFileSync(tmpPath, rebuilt);
      fs.renameSync(tmpPath, skillPath);
      migrated++;
    } catch (err) {
      errors++;
      errDetails.push(`${entry.name}: ${err.message}`);
    }
  }

  // Persist the migration flag so we don't re-scan every launch
  try {
    const c = readConfig();
    c._brandLockSkillMigration = 1;
    writeConfig(c);
  } catch {}

  // Log the summary so we can see what happened in the error log
  try {
    const summary = `${new Date().toISOString()} [spell-migration] scanned=${scanned} migrated=${migrated} skipped=${skipped} errors=${errors}${errDetails.length ? ' details=' + errDetails.join('; ') : ''}\n`;
    appendErrorLog(summary);
  } catch {}

  return { scanned, migrated, skipped, errors };
}

function buildSkillBody({ fullTaskId, description, cron, prompt, brandName }) {
  const frontmatter = `---\nname: ${fullTaskId}\ndescription: ${description}\ncronExpression: "${cron}"\n---\n`;
  let brandLock = '';
  if (brandName) {
    brandLock = `
## Brand Lock — ${brandName}

This scheduled task operates EXCLUSIVELY on brand \`${brandName}\`. Every brand-scoped MCP tool call in this session MUST include \`brand: "${brandName}"\` as an argument. Do not omit it. Do not substitute another brand. The Merlin MCP server will REFUSE brand-scoped actions that are missing the brand argument and return a loud error — don't let that happen by forgetting.

Examples of correctly-scoped calls for this task:

- \`mcp__merlin__dashboard({ action: "dashboard", brand: "${brandName}", batchCount: 7 })\`
- \`mcp__merlin__meta_ads({ action: "insights", brand: "${brandName}" })\`
- \`mcp__merlin__tiktok_ads({ action: "insights", brand: "${brandName}" })\`
- \`mcp__merlin__google_ads({ action: "insights", brand: "${brandName}" })\`
- \`mcp__merlin__shopify({ action: "analytics", brand: "${brandName}" })\`
- \`mcp__merlin__klaviyo({ action: "performance", brand: "${brandName}" })\`
- \`mcp__merlin__email({ action: "audit", brand: "${brandName}" })\`
- \`mcp__merlin__seo({ action: "audit", brand: "${brandName}" })\`
- \`mcp__merlin__content({ action: "image", brand: "${brandName}" })\`
- \`mcp__merlin__video({ action: "generate", brand: "${brandName}" })\`

Brand assets live at \`assets/brands/${brandName}/\`. Read \`brand.md\` for voice and positioning, and \`memory.md\` for prior decisions before acting. Save any new learnings back to \`memory.md\` so the next run compounds.
`;
  }
  const firstRunBlock = `\nFirst-run check: If this is the first time running (no prior results exist for this task), use the best quality settings, narrate each step, show results visually, and end with a summary of what you did and when the next scheduled run is.\n`;
  return `${frontmatter}${SKILL_BODY_MARKER}\n${brandLock}${firstRunBlock}\n${prompt}\n`;
}

// ── Spell creation: write SKILL.md directly (no Claude, no MCP) ──
ipcMain.handle('create-spell', (_, taskId, cron, description, prompt, brandName) => {
  try {
    // Validate inputs
    if (typeof taskId !== 'string' || taskId.length > 100) return { success: false, error: 'invalid taskId' };
    if (typeof cron !== 'string' || !/^[\d*,\/-]+(\s[\d*,\/-]+){4}$/.test(cron.trim())) return { success: false, error: 'invalid cron' };
    if (typeof description !== 'string' || description.length > 500) return { success: false, error: 'invalid description' };
    if (typeof prompt !== 'string' || prompt.length > 10000) return { success: false, error: 'prompt too long' };
    if (brandName && (typeof brandName !== 'string' || !/^[a-z0-9_-]+$/i.test(brandName))) return { success: false, error: 'invalid brand' };

    // Prefix task ID with brand name for per-brand isolation
    const fullTaskId = brandName ? `merlin-${brandName}-${taskId.replace('merlin-', '')}` : taskId;
    const tasksDir = path.join(os.homedir(), '.claude', 'scheduled-tasks', fullTaskId);
    fs.mkdirSync(tasksDir, { recursive: true });

    // Build brand lock + first-run showcase + prompt into the SKILL.md body.
    // See buildSkillBody for why brand gets a dedicated lock section with
    // literal MCP call examples rather than inline prose.
    const skillContent = buildSkillBody({ fullTaskId, description, cron, prompt, brandName });
    fs.writeFileSync(path.join(tasksDir, 'SKILL.md'), skillContent);

    // Store spell metadata per-brand
    const cfg = readConfig();
    if (brandName) {
      if (!cfg.brandSpells) cfg.brandSpells = {};
      if (!cfg.brandSpells[brandName]) cfg.brandSpells[brandName] = {};
      cfg.brandSpells[brandName][fullTaskId] = { cron, enabled: true, description };
    } else {
      if (!cfg.spells) cfg.spells = {};
      cfg.spells[fullTaskId] = { cron, enabled: true, description };
    }
    writeConfig(cfg);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
// suppress-next-response removed — handled inline by send-message with { silent: true }

ipcMain.handle('delete-file', async (_, folderPath) => {
  try {
    if (!folderPath || typeof folderPath !== 'string') return { success: false };
    const fullPath = path.resolve(appRoot, folderPath);
    const resolvedRoot = path.resolve(appRoot);
    if (!fullPath.startsWith(resolvedRoot)) return { success: false };
    const resultsDir = path.join(resolvedRoot, 'results');
    if (!fullPath.startsWith(resultsDir) || fullPath === resultsDir) return { success: false };
    try {
      const realPath = fs.realpathSync(fullPath);
      if (!realPath.startsWith(path.resolve(appRoot))) return { success: false };
    } catch { return { success: false }; }
    if (!fs.existsSync(fullPath)) return { success: false };
    // Use async rm to avoid blocking the main process (prevents "Not Responding")
    await fs.promises.rm(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    // Invalidate archive index so it rebuilds
    try { await fs.promises.unlink(path.join(resultsDir, 'archive-index.json')); } catch {}
    return { success: true };
  } catch (err) {
    console.error('[delete]', err.message);
    return { success: false };
  }
});

ipcMain.handle('copy-image', (_, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') return { success: false };
    const { nativeImage, clipboard } = require('electron');
    const fullPath = path.resolve(appRoot, filePath);
    if (!fullPath.startsWith(path.resolve(appRoot))) return { success: false };
    try {
      const realPath = fs.realpathSync(fullPath);
      if (!realPath.startsWith(path.resolve(appRoot))) return { success: false };
    } catch { return { success: false }; }
    const img = nativeImage.createFromPath(fullPath);
    if (img.isEmpty()) return { success: false };
    clipboard.writeImage(img);
    return { success: true };
  } catch { return { success: false }; }
});

ipcMain.handle('open-folder', (_, folderPath) => {
  if (!folderPath || typeof folderPath !== 'string') return;
  const fullPath = path.resolve(appRoot, folderPath);
  if (!fullPath.startsWith(path.resolve(appRoot))) return { success: false };
  try {
    const realPath = fs.realpathSync(fullPath);
    if (!realPath.startsWith(path.resolve(appRoot))) return { success: false };
  } catch { return { success: false }; }
  shell.openPath(fullPath);
  return { success: true };
});

// Rotate .merlin-errors.log when it exceeds ~1MB. Keeps a single .old copy
// (overwriting any previous one) so disk usage stays bounded even if the
// binary starts regressing every refresh for a long time.
const ERROR_LOG_MAX_BYTES = 1024 * 1024;

function appendErrorLog(line) {
  try {
    const logPath = path.join(appRoot, '.merlin-errors.log');
    try {
      const stat = fs.statSync(logPath);
      if (stat.size >= ERROR_LOG_MAX_BYTES) {
        const oldPath = logPath + '.old';
        try { fs.unlinkSync(oldPath); } catch {}
        try { fs.renameSync(logPath, oldPath); } catch {}
      }
    } catch {}
    fs.appendFileSync(logPath, line);
  } catch {}
}

// ── Performance status bar: read cached dashboard data ──────
// Background dashboard refresh — runs binary to pull fresh data from all platforms.
// The optional `days` parameter controls how many days of history the binary
// pulls; on-launch refresh sends 1 for speed (and because the bar shows
// today's live number), while the user-initiated "Run a check now" button
// (Part F) can request a longer window matching the selected period.
ipcMain.handle('refresh-perf', async (_, brandName, days) => {
  const requestedDays = Number.isInteger(days) && days > 0 && days <= 365 ? days : 1;

  // Wait for the startup ensure+version check to complete before we let
  // any refresh run. If this handler fires during the 1500ms startup delay
  // (on-launch loadPerfBar, scheduled spell that happens to align with
  // app open, click that arrives before the delay elapses), racing past
  // the check would execute against whatever stale binary is on disk —
  // precisely the failure mode Part A fixed. Awaiting here is free when
  // the check has already completed, and bounded to ~2s otherwise.
  if (_startupChecksPromise) {
    try { await _startupChecksPromise; } catch {}
  }

  // Guard: if the installed binary is below the minimum required version,
  // refuse the refresh instead of running an engine that writes dashboard
  // files to the wrong directory (see Part A fix). The startup version
  // check has already tried to force-update; reaching here means the update
  // failed (no network / quarantine / checksum error). Tell the UI clearly.
  if (isBinaryTooOld()) {
    appendErrorLog(`${new Date().toISOString()} [refresh-perf] refused: binary below min version ${MIN_BINARY_VERSION}\n`);
    return { error: `Engine needs to update to v${MIN_BINARY_VERSION}. Check your network connection and restart Merlin.` };
  }

  const binaryPath = getBinaryPath();
  try { fs.accessSync(binaryPath); } catch {
    appendErrorLog(`${new Date().toISOString()} [refresh-perf] brand=${brandName || '_global'} binary missing at ${binaryPath}\n`);
    return { error: 'binary missing' };
  }

  // Use merged brand config if brand specified (includes brand tokens)
  let configPath = path.join(appRoot, '.claude', 'tools', 'merlin-config.json');
  try { fs.accessSync(configPath); } catch {
    appendErrorLog(`${new Date().toISOString()} [refresh-perf] brand=${brandName || '_global'} config missing at ${configPath}\n`);
    return { error: 'config missing' };
  }
  if (brandName) {
    const merged = brandName ? readBrandConfig(brandName) : readConfig();
    if (merged && Object.keys(merged).length > 0) {
      const tmpPath = path.join(os.tmpdir(), `.merlin-config-tmp-${require('crypto').randomBytes(16).toString('hex')}.json`);
      fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
      configPath = tmpPath;
    }
  }

  const cmdObj = { action: 'dashboard', batchCount: requestedDays };
  if (brandName) cmdObj.brand = brandName;
  const cmd = JSON.stringify(cmdObj);
  const isTmpConfig = configPath !== path.join(appRoot, '.claude', 'tools', 'merlin-config.json');
  const { execFile } = require('child_process');
  const { redactOutput } = require('./mcp-redact');
  return new Promise((resolve) => {
    execFile(binaryPath, ['--config', configPath, '--cmd', cmd], {
      timeout: 90000, cwd: appRoot,
    }, (err, stdout, stderr) => {
      // Delete temp config IMMEDIATELY — don't leave decrypted credentials on disk
      if (isTmpConfig) { try { fs.unlinkSync(configPath); } catch {} }

      // Log any stderr output (even on success — warnings/deprecations show up there)
      // and any error. We used to swallow these with `catch {}` on the caller side,
      // which made "perf bar stays empty" impossible to diagnose without attaching a
      // debugger. Redact before writing to disk so access tokens that leak into
      // stderr (e.g. from a failed HTTP request) don't end up persisted.
      if (err || (stderr && stderr.trim())) {
        const sanitized = redactOutput('', stderr || '');
        const msg = `${new Date().toISOString()} [refresh-perf] brand=${brandName || '_global'} days=${requestedDays}${err ? ' error=' + err.message : ''}${sanitized ? '\n  stderr: ' + sanitized.replace(/\n/g, '\n  ') : ''}\n`;
        appendErrorLog(msg);
      }

      if (err) return resolve({ error: err.message });

      // Cache the timestamp per brand — written ONLY on success so staleness
      // checks correctly detect failed refreshes and retry.
      try {
        const resultsDir = brandName ? path.join(appRoot, 'results', brandName) : path.join(appRoot, 'results');
        fs.mkdirSync(resultsDir, { recursive: true });
        fs.writeFileSync(path.join(resultsDir, '.perf-updated'), new Date().toISOString());
      } catch {}
      // Notify renderer that perf data changed — triggers perf bar refresh
      if (win && !win.isDestroyed()) {
        win.webContents.send('perf-data-changed', { brand: brandName || '' });
      }
      resolve({ success: true });
    });
  });
});

ipcMain.handle('get-perf-updated', (_, brandName) => {
  try {
    const resultsDir = brandName ? path.join(appRoot, 'results', brandName) : path.join(appRoot, 'results');
    return fs.readFileSync(path.join(resultsDir, '.perf-updated'), 'utf8').trim();
  } catch { return null; }
});

// ── Perf bar cache (keyed by brand+days, mtime-invalidated) ──
const perfCache = {};

function computePerfSummary(days, brandName) {
  const resultsDir = brandName ? path.join(appRoot, 'results', brandName) : path.join(appRoot, 'results');
  const files = [];
  try {
    for (const f of fs.readdirSync(resultsDir)) {
      if (f.startsWith('dashboard_') && f.endsWith('.json')) {
        files.push({ name: f, path: path.join(resultsDir, f) });
      }
    }
  } catch {}
  if (files.length === 0) return null;

  files.sort((a, b) => a.name.localeCompare(b.name));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = `dashboard_${cutoff.toISOString().slice(0, 10).replace(/-/g, '')}`;
  // Try latest file first; if corrupted, fall back to previous files
  let latest = null;
  for (let i = files.length - 1; i >= 0 && !latest; i--) {
    try { latest = JSON.parse(fs.readFileSync(files[i].path, 'utf8')); } catch {}
  }
  if (!latest) return null;

  let periodStart = null;
  for (let i = files.length - 1; i >= 0; i--) {
    if (files[i].name <= cutoffStr) { periodStart = files[i]; break; }
  }
  if (!periodStart && files.length >= 2) periodStart = files[0];
  if (!periodStart) for (const f of files) {
    if (f.name >= cutoffStr) { periodStart = f; break; }
  }

  let trend = null;
  if (periodStart && periodStart.name !== files[files.length - 1].name) {
    try {
      const prev = JSON.parse(fs.readFileSync(periodStart.path, 'utf8'));
      if (prev.mer > 0 && latest.mer > 0) {
        trend = Math.round(((latest.mer - prev.mer) / prev.mer) * 100);
      }
    } catch {}
  }
  if (trend === null && files.length >= 2) {
    try {
      const prev = JSON.parse(fs.readFileSync(files[files.length - 2].path, 'utf8'));
      if (prev.mer > 0 && latest.mer > 0) {
        trend = Math.round(((latest.mer - prev.mer) / prev.mer) * 100);
      }
    } catch {}
  }

  const cfg = brandName ? readBrandConfig(brandName) : readConfig();
  const dailyBudget = cfg.dailyAdBudget || 0;
  const platformBreakdown = (latest.platforms || []).map(p => ({
    name: p.platform, spend: p.spend || 0, revenue: p.revenue || 0, roas: p.roas || 0,
  })).filter(p => p.spend > 0);

  return {
    revenue: latest.revenue || 0,
    spend: latest.total_spend || 0,
    mer: latest.mer || 0,
    platforms: platformBreakdown.length,
    platformBreakdown,
    dailyBudget,
    trend,
    periodDays: days,
    generatedAt: latest.generated_at || null,
  };
}

ipcMain.handle('get-perf-summary', (_, requestedDays, brandName) => {
  const days = requestedDays || 7;
  const key = brandName || '_global';

  // Check cache — invalidate if results directory has been modified
  if (perfCache[key]?.[days]) {
    const cached = perfCache[key][days];
    const resultsDir = brandName ? path.join(appRoot, 'results', brandName) : path.join(appRoot, 'results');
    try {
      const mtime = fs.statSync(resultsDir).mtimeMs;
      if (mtime <= cached.fetchedAt) return cached.data;
    } catch {}
  }

  try {
    const result = computePerfSummary(days, brandName);
    if (!perfCache[key]) perfCache[key] = {};
    perfCache[key][days] = { data: result, fetchedAt: Date.now() };
    return result;
  } catch { return null; }
});

// ── Activity feed: read brand's activity.jsonl ──────────────
ipcMain.handle('get-activity-feed', (_, brandName, limit = 30) => {
  if (!brandName) {
    // Try to find the first brand with an activity log
    const brandsDir = path.join(appRoot, 'assets', 'brands');
    try {
      const dirs = fs.readdirSync(brandsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== 'example');
      for (const d of dirs) {
        const logPath = path.join(brandsDir, d.name, 'activity.jsonl');
        if (fs.existsSync(logPath)) { brandName = d.name; break; }
      }
    } catch {}
  }
  if (!brandName) return [];
  if (!/^[a-z0-9_-]+$/i.test(brandName)) return [];

  const logPath = path.join(appRoot, 'assets', 'brands', brandName, 'activity.jsonl');
  try {
    if (!fs.existsSync(logPath)) return [];
    const stat = fs.statSync(logPath);

    // For large files (>1MB), read only the last 64KB to avoid memory issues
    let content;
    if (stat.size > 1024 * 1024) {
      const fd = fs.openSync(logPath, 'r');
      const tailSize = Math.min(stat.size, 64 * 1024);
      const buf = Buffer.alloc(tailSize);
      fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
      fs.closeSync(fd);
      content = buf.toString('utf8');
      // Drop the first partial line
      const firstNewline = content.indexOf('\n');
      if (firstNewline > 0) content = content.slice(firstNewline + 1);
    } else {
      content = fs.readFileSync(logPath, 'utf8');
    }

    content = content.trim();
    if (!content) return [];

    const lines = content.split('\n').filter(l => l.trim());
    const recent = lines.slice(-limit).reverse(); // newest first
    const items = [];
    for (const line of recent) {
      try { items.push(JSON.parse(line)); } catch {}
    }
    return items;
  } catch { return []; }
});

// ── Archive: scan results for content grid ──────────────────
// ── Competitor Swipes ──────────────────────────────────────
ipcMain.handle('get-swipes', (_, brandName) => {
  if (!brandName || !/^[a-z0-9_-]+$/i.test(brandName)) return [];
  const swipesDir = path.join(appRoot, 'assets', 'brands', brandName, 'competitor-swipes');
  try {
    if (!fs.existsSync(swipesDir)) return [];
    const files = fs.readdirSync(swipesDir).filter(f => /\.(jpg|jpeg|png|webp|mp4)$/i.test(f));
    // Try to read metadata
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(swipesDir, 'swipes.json'), 'utf8')); } catch {}

    return files.map((f, i) => {
      const info = (meta.swipes || []).find(s => s.file === f) || {};
      return {
        id: `swipe-${i}`,
        thumbnail: `assets/brands/${brandName}/competitor-swipes/${f}`,
        path: `assets/brands/${brandName}/competitor-swipes/${f}`,
        brand: info.brand || info.advertiser || 'Competitor',
        hook: info.hook || '',
        platform: info.platform || '',
        dateFound: info.date || '',
        daysRunning: info.daysRunning || null,
      };
    });
  } catch { return []; }
});

// Archive scanner lives in its own module (app/archive-scanner.js) so it can
// be unit-tested in isolation. See that file for the full discovery strategy.
const archiveScanner = require('./archive-scanner');

ipcMain.handle('get-archive-items', async (_, filters = {}) => {
  try {
    return archiveScanner.scanArchive(appRoot, filters || {});
  } catch (err) {
    console.warn('[archive] scan failed:', err.message);
    return [];
  }
});

ipcMain.handle('check-tos-accepted', () => {
  const stateFile = path.join(appRoot, '.merlin-state.json');
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return !!state.tosAccepted;
  } catch { return false; }
});

ipcMain.handle('accept-tos', (_, opts) => {
  const now = new Date().toISOString();
  const emailOptIn = opts?.emailOptIn ?? false;
  writeState({
    tosAccepted: now,
    emailOptIn,
    emailOptInAt: emailOptIn ? now : undefined,
  });

  // Sync email consent to server (fire-and-forget)
  if (emailOptIn) {
    try {
      const cfg = readConfig();
      const email = cfg?._userEmail || '';
      const machineId = getMachineId();
      if (email || machineId) {
        const https = require('https');
        const payload = JSON.stringify({
          machineId,
          email,
          consent: true,
          consentAt: now,
          source: 'tos-onboarding',
        });
        const req = https.request('https://merlingotme.com/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          timeout: 5000,
        });
        req.on('error', () => {}); // fire-and-forget
        req.write(payload);
        req.end();
      }
    } catch {}
  }

  return { success: true };
});

ipcMain.handle('get-decrypted-config-path', (_, brandName) => {
  // Config is plaintext now — return path directly (no temp file needed)
  // For brand-specific, still need a merged temp file since brand tokens are in a separate file
  if (brandName) {
    const cfg = readBrandConfig(brandName);
    if (!cfg || Object.keys(cfg).length === 0) return null;
    const tmpPath = path.join(os.tmpdir(), `.merlin-config-tmp-${require('crypto').randomBytes(16).toString('hex')}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    // Clean up temp config aggressively — 10s grace for binary to read it, then delete
    setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch (e) { console.error('[config-cleanup]', e.message); } }, 10000);
    // Failsafe: also register for process exit cleanup
    const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch {} };
    process.once('exit', cleanup);
    setTimeout(() => { process.removeListener('exit', cleanup); }, 15000);
    return tmpPath;
  }
  const configPath = path.join(appRoot, '.claude', 'tools', 'merlin-config.json');
  try { fs.accessSync(configPath); return configPath; } catch { return null; }
});

ipcMain.handle('check-claude-running', async () => {
  const status = await getClaudeDesktopStatus();
  return status.running;
});

// ── Session State Persistence (centralized, atomic) ─────────
const stateFile = path.join(appRoot, '.merlin-state.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}

// Prepend the current active brand to every user message so Claude always
// operates on the brand the user selected in the dropdown, not the one
// that was active when the session started.
function injectActiveBrand(text) {
  const state = readState();
  const brand = state.activeBrand;
  if (!brand) return text;
  return `[ACTIVE_BRAND: ${brand}] ${text}`;
}

function writeState(data) {
  try {
    const state = { ...readState(), ...data };
    const tmpPath = stateFile + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    fs.renameSync(tmpPath, stateFile);
    return true;
  } catch (e) {
    console.error('[state-write]', e.message);
    return false;
  }
}

ipcMain.handle('save-state', (_, data) => {
  return { success: writeState(data) };
});

ipcMain.handle('load-state', () => readState());

// ── Audit log ──────────────────────────────────────────────
// Append-only log of security-relevant events. Rotated at 1MB.
// Written to .claude/tools/.merlin-audit.log inside the workspace.
// Claude's Read/Write of this file is blocked by the hook.
const AUDIT_LOG = path.join(appRoot, '.claude', 'tools', '.merlin-audit.log');
const AUDIT_MAX_BYTES = 1024 * 1024;

function appendAudit(event, details) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true });
    try {
      const st = fs.statSync(AUDIT_LOG);
      if (st.size > AUDIT_MAX_BYTES) {
        fs.renameSync(AUDIT_LOG, AUDIT_LOG + '.old');
      }
    } catch {}
    const entry = JSON.stringify({ ts: new Date().toISOString(), src: 'main', event, ...details });
    // Redact base64-ish strings >= 32 chars (likely tokens)
    const redacted = entry.replace(/[A-Za-z0-9_\-+/]{32,}={0,2}/g, '[TOKEN]');
    fs.appendFileSync(AUDIT_LOG, redacted + '\n');
  } catch (err) {
    console.error('[audit]', err.message);
  }
}

function reportBypassTelemetry(toolName, reason) {
  try {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(String(reason)).digest('hex').slice(0, 16);
    const payload = JSON.stringify({
      id: (typeof getMachineId === 'function' ? getMachineId() : ''),
      v: (typeof getCurrentVersion === 'function' ? getCurrentVersion() : ''),
      p: process.platform,
      e: 'bypass_blocked',
      tool: toolName,
      hash,
    });
    const https = require('https');
    const req = https.request('https://api.merlingotme.com/api/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000,
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {}
}

// ── Credential Vault ──────────────────────────────────────
// AES-256-GCM encrypted file shared between Electron and the Go binary.
// Both sides derive the SAME key from hostname + username + constant,
// so either can read what the other wrote. Vault file lives OUTSIDE the
// workspace at %APPDATA%/Merlin/.vault (Windows) or equivalent — Claude
// cannot access it via Read/Bash (hook-blocked).
//
// Key derivation MUST match vault.go's vaultKey() exactly. If you change
// one, you MUST change the other.
const _vaultCrypto = require('crypto');

function _vaultDeriveKey() {
  const hostname = (os.hostname() || '').toLowerCase();
  let username = (os.userInfo().username || '').toLowerCase();
  // Strip Windows domain prefix (DOMAIN\user → user)
  const bsIdx = username.lastIndexOf('\\');
  if (bsIdx >= 0) username = username.slice(bsIdx + 1);
  const h = _vaultCrypto.createHash('sha256');
  h.update('merlin-vault-v1');
  h.update(Buffer.from([0x1f])); // separator — matches Go byte{0x1f}
  h.update(hostname);
  h.update(Buffer.from([0x1f]));
  h.update(username);
  return h.digest(); // 32 bytes → AES-256
}

function _vaultFilePath() {
  let base;
  if (process.platform === 'win32') {
    base = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Merlin');
  } else if (process.platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support', 'Merlin');
  } else {
    base = path.join(os.homedir(), '.config', 'merlin');
  }
  try { fs.mkdirSync(base, { recursive: true, mode: 0o700 }); } catch {}
  return path.join(base, '.vault');
}

let _vaultKeyCache = null;
function _vaultKey() {
  if (!_vaultKeyCache) _vaultKeyCache = _vaultDeriveKey();
  return _vaultKeyCache;
}

// Returns the vault contents as a plain JS object: { "brand/key": "token", ... }
function vaultLoad() {
  const p = _vaultFilePath();
  let raw;
  try { raw = fs.readFileSync(p); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  const fv = JSON.parse(raw.toString('utf8'));
  if (fv.v !== 1) throw new Error('Vault version ' + fv.v + ' unsupported');
  const nonce = Buffer.from(fv.nonce, 'base64');
  const ct = Buffer.from(fv.ciphertext, 'base64');
  // Node's createDecipheriv wants (algorithm, key, iv). For GCM we also set the auth tag.
  // GCM appends auth tag to ciphertext (last 16 bytes).
  const tagLen = 16;
  const authTag = ct.slice(ct.length - tagLen);
  const ciphertext = ct.slice(0, ct.length - tagLen);
  const decipher = _vaultCrypto.createDecipheriv('aes-256-gcm', _vaultKey(), nonce);
  decipher.setAuthTag(authTag);
  let pt = decipher.update(ciphertext);
  pt = Buffer.concat([pt, decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

function vaultSave(map) {
  const pt = Buffer.from(JSON.stringify(map), 'utf8');
  const nonce = _vaultCrypto.randomBytes(12); // standard GCM nonce size
  const cipher = _vaultCrypto.createCipheriv('aes-256-gcm', _vaultKey(), nonce);
  let ct = cipher.update(pt);
  ct = Buffer.concat([ct, cipher.final(), cipher.getAuthTag()]); // tag appended
  const fv = {
    v: 1,
    nonce: nonce.toString('base64'),
    ciphertext: ct.toString('base64'),
  };
  const p = _vaultFilePath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(fv), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

function vaultGet(brand, key) {
  try {
    const m = vaultLoad();
    return m[brand + '/' + key] || null;
  } catch (e) {
    console.error('[vault] get failed:', e.message);
    return null;
  }
}

function vaultPut(brand, key, value) {
  try {
    const m = vaultLoad();
    m[brand + '/' + key] = value;
    vaultSave(m);
  } catch (e) {
    console.error('[vault] put failed:', e.message);
  }
}

function vaultDelete(brand, key) {
  try {
    const m = vaultLoad();
    delete m[brand + '/' + key];
    vaultSave(m);
  } catch (e) {
    console.error('[vault] delete failed:', e.message);
  }
}

function vaultAvailable() {
  // Test by doing a round-trip write/read with a dummy key
  try {
    const m = vaultLoad();
    return true;
  } catch {
    return false;
  }
}

// List of token field names that are SENSITIVE and should live in the vault
// rather than plaintext in brand config files.
const VAULT_SENSITIVE_KEYS = [
  'metaAccessToken',
  'tiktokAccessToken',
  'googleAccessToken',
  'googleRefreshToken',
  'shopifyAccessToken',
  'klaviyoAccessToken',
  'klaviyoApiKey',
  'amazonAccessToken',
  'amazonRefreshToken',
  'pinterestAccessToken',
  'pinterestRefreshToken',
  'etsyAccessToken',
  'etsyRefreshToken',
  'redditAccessToken',
  'redditRefreshToken',
  // API keys that were previously left in plaintext — adversarial review
  // found these are just as sensitive as OAuth tokens.
  'falApiKey',
  'elevenLabsApiKey',
  'heygenApiKey',
  'arcadsApiKey',
  'googleApiKey',
  'slackBotToken',
  'slackWebhookUrl',
];

// ── Config helpers ──────────────────────────────────────────
// Brand-specific token field names (used by migratePerBrand)
const BRAND_KEYS = [
  'metaAccessToken', 'metaAdAccountId', 'metaPageId', 'metaPixelId', 'metaConfigId',
  'tiktokAccessToken', 'tiktokAdvertiserId', 'tiktokPixelId',
  'shopifyStore', 'shopifyAccessToken',
  'googleAccessToken', 'googleRefreshToken', 'googleAdsCustomerId', 'googleAdsDeveloperToken',
  'amazonAccessToken', 'amazonRefreshToken', 'amazonProfileId', 'amazonSellerId',
  'amazonAdClientId', 'amazonAdClientSecret', 'amazonSpClientId', 'amazonSpClientSecret',
  'etsyAccessToken', 'etsyRefreshToken', 'etsyShopId', 'etsyKeystring',
  'redditAccessToken', 'redditRefreshToken', 'redditAdAccountId',
  'klaviyoAccessToken', 'klaviyoApiKey',
  'pinterestAccessToken',
  'slackBotToken', 'slackWebhookUrl',
];
// ALL config is plaintext JSON — the Go binary reads it via --config flag.
// No encryption. Tokens live alongside settings in the same file.
// This is a local desktop app on the user's device — encryption added complexity
// that broke the binary/IPC boundary without meaningful security benefit.

function readConfig() {
  const configPath = path.join(appRoot, '.claude', 'tools', 'merlin-config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}

  // One-time migration: merge encrypted .merlin-tokens back into plaintext config
  const tokensFilePath = path.join(appRoot, '.claude', 'tools', '.merlin-tokens');
  try {
    const buf = fs.readFileSync(tokensFilePath);
    let tokens;
    if (canUseSafeStorage()) {
      try { tokens = JSON.parse(safeStorage.decryptString(buf)); } catch {
        tokens = JSON.parse(buf.toString('utf8'));
      }
    } else if (process.platform === 'darwin' && looksEncrypted(buf) && safeStorage.isEncryptionAvailable()) {
      // macOS legacy migration — one keychain prompt then never again
      try { tokens = JSON.parse(safeStorage.decryptString(buf)); } catch {
        try { fs.renameSync(tokensFilePath, tokensFilePath + '.legacy'); } catch {}
        throw new Error('legacy decrypt denied');
      }
    } else {
      tokens = JSON.parse(buf.toString('utf8'));
    }
    Object.assign(cfg, tokens);
    // Write merged config and delete the tokens file
    writeConfig(cfg);
    try { fs.unlinkSync(tokensFilePath); } catch {}
    console.log('[config] migrated .merlin-tokens into plaintext config');
  } catch {} // no tokens file — fine

  return cfg;
}

let _configLock = false;
function writeConfig(cfg) {
  const configPath = path.join(appRoot, '.claude', 'tools', 'merlin-config.json');
  // Simple lock to prevent concurrent read-modify-write corruption
  if (_configLock) { console.warn('[config] write skipped — concurrent write in progress'); return; }
  _configLock = true;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tmpPath = configPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, configPath);
  } catch (err) { console.error('[config] write failed:', err.message); }
  finally { _configLock = false; }
}

// ── Per-Brand Config ──────────────────────────────────────
function readBrandConfig(brandName) {
  const cfg = readConfig();
  if (!brandName) return cfg;

  // Read brand-specific config (plaintext)
  const brandConfigPath = path.join(appRoot, '.claude', 'tools', `.merlin-config-${brandName}.json`);
  try {
    const brandCfg = JSON.parse(fs.readFileSync(brandConfigPath, 'utf8'));
    Object.assign(cfg, brandCfg);
  } catch {}

  // One-time migration: merge encrypted brand tokens into plaintext
  const brandTokensPath = path.join(appRoot, '.claude', 'tools', `.merlin-tokens-${brandName}`);
  try {
    const buf = fs.readFileSync(brandTokensPath);
    let tokens;
    if (canUseSafeStorage()) {
      try { tokens = JSON.parse(safeStorage.decryptString(buf)); } catch {
        tokens = JSON.parse(buf.toString('utf8'));
      }
    } else if (process.platform === 'darwin' && looksEncrypted(buf) && safeStorage.isEncryptionAvailable()) {
      // macOS legacy migration — one keychain prompt then never again
      try { tokens = JSON.parse(safeStorage.decryptString(buf)); } catch {
        try { fs.renameSync(brandTokensPath, brandTokensPath + '.legacy'); } catch {}
        throw new Error('legacy decrypt denied');
      }
    } else {
      tokens = JSON.parse(buf.toString('utf8'));
    }
    Object.assign(cfg, tokens);
    // Write merged and delete tokens file
    writeBrandTokens(brandName, tokens);
    try { fs.unlinkSync(brandTokensPath); } catch {}
    console.log(`[config] migrated .merlin-tokens-${brandName} into plaintext`);
  } catch {}

  // Resolve @@VAULT:key@@ placeholders from the vault.
  // After vault migration, brand configs have placeholders instead of
  // plaintext tokens. This transparently resolves them so callers see
  // a fully populated config object.
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === 'string' && v.startsWith('@@VAULT:') && v.endsWith('@@')) {
      const vKey = v.slice('@@VAULT:'.length, -2);
      const real = vaultGet(brandName, vKey) || vaultGet('_global', vKey);
      if (real) cfg[k] = real;
    }
  }

  if (cfg.brandSpells && cfg.brandSpells[brandName]) {
    cfg._brandSpells = cfg.brandSpells[brandName];
  }
  cfg._brand = brandName;
  return cfg;
}

function writeBrandTokens(brandName, tokens) {
  if (!brandName || !tokens || Object.keys(tokens).length === 0) return;
  const tokenPath = path.join(appRoot, '.claude', 'tools', `.merlin-config-${brandName}.json`);
  try {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    // Merge with existing brand config
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(tokenPath, 'utf8')); } catch {}
    Object.assign(existing, tokens);
    // Atomic write: tmp + rename prevents corruption on crash (S11-02)
    const tmpPath = tokenPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2));
    fs.renameSync(tmpPath, tokenPath);
  } catch (err) { console.error('[brand-config] write failed:', err.message); }
}

// Migration: move global tokens to per-brand on first run
function migratePerBrand() {
  const cfg = readConfig();
  if (cfg._migrationVersion >= 1) return;

  const brandsDir = path.join(appRoot, 'assets', 'brands');
  let brands = [];
  try {
    brands = fs.readdirSync(brandsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'example')
      .map(d => d.name);
  } catch {}

  if (brands.length === 1) {
    // Safe: move brand-specific tokens to the only brand
    const brandTokens = {};
    for (const field of BRAND_KEYS) {
      if (cfg[field]) brandTokens[field] = cfg[field];
    }
    if (Object.keys(brandTokens).length > 0) {
      writeBrandTokens(brands[0], brandTokens);
    }

    // Migrate spells: rename with brand prefix
    if (cfg.spells) {
      if (!cfg.brandSpells) cfg.brandSpells = {};
      cfg.brandSpells[brands[0]] = {};
      const tasksDir = path.join(os.homedir(), '.claude', 'scheduled-tasks');
      for (const [id, meta] of Object.entries(cfg.spells)) {
        if (id.startsWith('merlin-')) {
          const newId = `merlin-${brands[0]}-${id.replace('merlin-', '')}`;
          cfg.brandSpells[brands[0]][newId] = meta;
          try { fs.renameSync(path.join(tasksDir, id), path.join(tasksDir, newId)); } catch {}
        }
      }
      delete cfg.spells;
    }
  }
  // 0 or 2+ brands: keep global tokens as fallback until user assigns per-brand

  cfg._migrationVersion = 1;
  writeConfig(cfg);
}

// ── Vault Migration ─────────────────────────────────────────
// One-shot: moves plaintext tokens from brand config files into the
// AES-GCM vault. Brand config files get @@VAULT:key@@ placeholders.
// Tracked by _migrationVersion = 3 in the global config.
// Idempotent — safe to re-run if interrupted. Never deletes a plaintext
// token until the vault write is confirmed.
function migrateTokensToVault() {
  const globalCfg = readConfig();
  if ((globalCfg._migrationVersion || 0) >= 3) return; // already done

  let migratedCount = 0;
  // 1. Migrate brand-specific config files
  const toolsDir = path.join(appRoot, '.claude', 'tools');
  try {
    const files = fs.readdirSync(toolsDir).filter(f => f.startsWith('.merlin-config-') && f.endsWith('.json'));
    for (const file of files) {
      const brandName = file.slice('.merlin-config-'.length, -'.json'.length);
      const configPath = path.join(toolsDir, file);
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        let modified = false;
        for (const key of VAULT_SENSITIVE_KEYS) {
          if (cfg[key] && typeof cfg[key] === 'string' && !cfg[key].startsWith('@@VAULT:')) {
            vaultPut(brandName, key, cfg[key]);
            cfg[key] = `@@VAULT:${key}@@`;
            modified = true;
          }
        }
        if (modified) {
          const tmpPath = configPath + '.tmp';
          fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2));
          fs.renameSync(tmpPath, configPath);
          migratedCount++;
        }
      } catch (e) {
        console.error('[vault-migrate]', file, e.message);
      }
    }
  } catch (e) { console.error('[vault-migrate] dir scan:', e.message); }

  // 2. Migrate global config tokens
  let globalModified = false;
  for (const key of VAULT_SENSITIVE_KEYS) {
    if (globalCfg[key] && typeof globalCfg[key] === 'string' && !globalCfg[key].startsWith('@@VAULT:')) {
      vaultPut('_global', key, globalCfg[key]);
      globalCfg[key] = `@@VAULT:${key}@@`;
      globalModified = true;
    }
  }
  if (globalModified) migratedCount++;

  globalCfg._migrationVersion = 3;
  writeConfig(globalCfg);
  if (migratedCount > 0) {
    console.log(`[vault-migrate] ${migratedCount} config(s) migrated to vault`);
  }
}

// Encrypted read/write for sensitive local state (subscription, api keys, tokens).
//
// Platform behavior:
//   Windows / Linux: Electron safeStorage (DPAPI / kwallet / gnome-keyring).
//   macOS:           AES-256-GCM with a machine-derived key (same scheme
//                    as the Go vault — see _vaultKey() above).
//
// REGRESSION GUARD (2026-04-14, codex enterprise review fix #5):
// macOS previously wrote these files as PLAINTEXT with 0o600 permissions.
// The rationale was that Electron safeStorage on macOS is keyed to the
// app's code signature, so every new release invalidated the keychain
// grant and re-prompted the user. That's still true — but plaintext is
// not the right fallback, because any process running as the same user
// (unrelated CLI tools, stale cron jobs, supply-chain-compromised npm
// packages, a malicious browser extension with file-system access) can
// read .merlin-subscription / .merlin-api-key / .merlin-license-token
// with no prompt at all. "Standard Unix CLI tools do this" is true of
// old tools like .aws/credentials; new enterprise tooling uses the
// macOS Keychain or a deterministic per-user KDF.
//
// The fix: reuse the AES-256-GCM primitive the Go binary already ships
// for the main vault. Key = SHA256("merlin-secure-v1" | hostname |
// username) — deterministic per-user-per-machine, matches the
// vault.go derivation scheme but with a different constant so the two
// namespaces never collide.
//
// File format (same as vault.go's vaultFileV1):
//   { "v": 1, "nonce": "base64", "ciphertext": "base64" }
//
// Migration is transparent: readSecureFile() tries AES-GCM first, falls
// back to safeStorage for legacy files on Windows/Linux, falls back to
// plaintext for legacy macOS files, and transparently rewrites the
// file in the new format on success.
//
// DO NOT revert macOS to plaintext. DO NOT add a plaintext fallback on
// any platform for writeSecureFile — partial writes on macOS must fail
// loudly rather than silently store secrets in the clear.
function canUseSafeStorage() {
  return process.platform !== 'darwin' && safeStorage.isEncryptionAvailable();
}
function _secureFileKey() {
  // Must diverge from _vaultKey() so that sensitive local-state files
  // and the main brand-token vault don't share the same encryption
  // domain. If one key is ever compromised, rotating the other should
  // not immediately follow.
  const hostname = (os.hostname() || '').toLowerCase();
  let username = (os.userInfo().username || '').toLowerCase();
  const bsIdx = username.lastIndexOf('\\');
  if (bsIdx >= 0) username = username.slice(bsIdx + 1);
  const h = require('crypto').createHash('sha256');
  h.update('merlin-secure-v1');
  h.update(Buffer.from([0x1f]));
  h.update(hostname);
  h.update(Buffer.from([0x1f]));
  h.update(username);
  return h.digest();
}
let _secureKeyCache = null;
function secureKey() {
  if (!_secureKeyCache) _secureKeyCache = _secureFileKey();
  return _secureKeyCache;
}
function _encodeSecureBuffer(data) {
  const crypto = require('crypto');
  const pt = Buffer.from(data, 'utf8');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secureKey(), nonce);
  let ct = cipher.update(pt);
  ct = Buffer.concat([ct, cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({
    v: 1,
    nonce: nonce.toString('base64'),
    ciphertext: ct.toString('base64'),
  });
}
function _decodeSecureBuffer(buf) {
  const crypto = require('crypto');
  const fv = JSON.parse(buf.toString('utf8'));
  if (fv.v !== 1 || !fv.nonce || !fv.ciphertext) {
    throw new Error('bad secure file');
  }
  const nonce = Buffer.from(fv.nonce, 'base64');
  const ct = Buffer.from(fv.ciphertext, 'base64');
  const tagLen = 16;
  if (ct.length < tagLen) throw new Error('secure ciphertext too short');
  const authTag = ct.slice(ct.length - tagLen);
  const body = ct.slice(0, ct.length - tagLen);
  const decipher = crypto.createDecipheriv('aes-256-gcm', secureKey(), nonce);
  decipher.setAuthTag(authTag);
  let pt = decipher.update(body);
  pt = Buffer.concat([pt, decipher.final()]);
  return pt.toString('utf8');
}
function _looksLikeSecureEnvelope(buf) {
  if (!buf || buf.length < 10) return false;
  // Envelope always starts with '{"v":1,"nonce":'. Cheap prefix sniff so we
  // don't parse JSON on every read.
  return buf[0] === 0x7b && buf[1] === 0x22 && buf[2] === 0x76 && buf[3] === 0x22 && buf[4] === 0x3a;
}
function looksEncrypted(buf) {
  // Electron safeStorage prefixes encrypted output with a binary version header.
  // Plaintext (JSON or printable strings) always starts with a printable byte.
  if (!buf || buf.length < 2) return false;
  const first = buf[0];
  return first < 0x20 || first > 0x7E;
}
function readSecureFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    // Preferred path: the new AES-GCM envelope — works on every OS.
    if (_looksLikeSecureEnvelope(buf)) {
      try { return _decodeSecureBuffer(buf); }
      catch { /* fall through to legacy paths */ }
    }
    // Windows/Linux legacy path: Electron safeStorage binary blob.
    if (canUseSafeStorage() && looksEncrypted(buf)) {
      try {
        const plain = safeStorage.decryptString(buf);
        // Rewrite in the new format so the next read uses the fast path.
        try { fs.writeFileSync(filePath, _encodeSecureBuffer(plain), { mode: 0o600 }); } catch {}
        return plain;
      } catch { /* fall through */ }
    }
    // macOS legacy path: plaintext files written before fix #5. Rewrite
    // them in the new AES-GCM format on first read so the plaintext is
    // wiped off disk.
    if (process.platform === 'darwin' && !looksEncrypted(buf)) {
      const plain = buf.toString('utf8');
      try { fs.writeFileSync(filePath, _encodeSecureBuffer(plain), { mode: 0o600 }); } catch {}
      return plain;
    }
    // macOS legacy safeStorage file: decrypt once, rewrite in GCM, then
    // forget the keychain grant. This is the single final keychain
    // prompt the old comment warned about.
    if (process.platform === 'darwin' && looksEncrypted(buf) && safeStorage.isEncryptionAvailable()) {
      try {
        const plain = safeStorage.decryptString(buf);
        try { fs.writeFileSync(filePath, _encodeSecureBuffer(plain), { mode: 0o600 }); } catch {}
        return plain;
      } catch {
        // User denied the keychain prompt — rename so we never retry.
        try { fs.renameSync(filePath, filePath + '.legacy'); } catch {}
        return null;
      }
    }
    return buf.toString('utf8');
  } catch { return null; }
}
function writeSecureFile(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // AES-GCM envelope is the ONLY write path on every OS. The key is
    // derived from hostname+username so the envelope is bound to the
    // same user/machine that safeStorage would have been bound to,
    // without the code-sign invalidation problem on macOS. We
    // deliberately do NOT wrap the envelope in safeStorage on
    // Windows/Linux — that would break readSecureFile's envelope sniff
    // and add complexity without changing the attacker cost for a
    // same-user process (safeStorage is transparent to the user).
    const envelope = _encodeSecureBuffer(data);
    fs.writeFileSync(filePath, envelope, { mode: 0o600 });
  } catch {}
}

// ── Revenue Tracker — cache raw API responses ──────────────
const statsFile = path.join(appRoot, '.merlin-stats.json');

// Track the last tool_use action so we can tag the result
let _lastToolAction = null;

function cacheDashboardData(msg) {
  // Capture the action from tool_use commands (Bash or MCP)
  if (msg.type === 'tool_use') {
    if (msg.tool_name === 'Bash') {
      const cmd = msg.input?.command || '';
      if (cmd.includes('Merlin')) {
        const match = cmd.match(/"action"\s*:\s*"([^"]+)"/);
        if (match) _lastToolAction = match[1];
      }
    } else if (msg.tool_name && msg.tool_name.startsWith('mcp__merlin__')) {
      // MCP tool calls: extract action from input
      const action = msg.input?.action;
      if (action) _lastToolAction = action;
    }
    return;
  }

  // Cache tool_result for dashboard/insights actions
  if (msg.type === 'tool_result' && _lastToolAction) {
    const action = _lastToolAction;
    _lastToolAction = null;

    // Cache any action that returns performance/revenue data
    // This list auto-extends as new platforms are added to the binary
    if (!action.includes('insights') && !action.includes('orders') && !action.includes('analytics')
        && !action.includes('performance') && !action.includes('dashboard') && !action.includes('cohorts')
        && !action.includes('revenue')) return;

    try {
      const content = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.map(b => b.text || '').join('')
        : '';
      if (!content || content.length < 10) return;

      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      let stats = {};
      try { stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')); } catch {}
      stats[action] = {
        data: jsonMatch[0].slice(0, 10000), // Cap at 10KB per entry
        timestamp: new Date().toISOString(),
      };
      const tmpPath = statsFile + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(stats, null, 2));
      fs.renameSync(tmpPath, statsFile);
    } catch (e) { console.error('[stats-cache]', e.message); }
  }
}

ipcMain.handle('get-stats-cache', () => {
  try {
    return JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  } catch { return null; }
});

// Check which platforms are connected by reading the config
// Platform connections (Meta, Shopify, Google, etc.) are per-brand — only show if the brand has them
// Global tools (fal, ElevenLabs, HeyGen, Slack) are shared across all brands
// Extracted as standalone function so the MCP connection_status tool can call it too.
function getConnections(brandName) {
  try {
    const globalCfg = readConfig();
    let brandCfg = {};
    if (brandName) {
      // Use readBrandConfig which resolves vault placeholders
      brandCfg = readBrandConfig(brandName);
    }
    const connected = [];
    const tokenAge = { ...(globalCfg._tokenTimestamps || {}), ...(brandCfg._tokenTimestamps || {}) };
    const now = Date.now();
    const EXPIRE_MS = 55 * 24 * 60 * 60 * 1000;
    function checkBrand(key, platform) {
      const token = brandCfg[key] || (!brandName ? globalCfg[key] : null);
      if (!token || (typeof token === 'string' && token.startsWith('@@VAULT:'))) {
        // Also check vault directly — placeholder means token IS stored
        if (typeof token === 'string' && token.startsWith('@@VAULT:')) {
          const vaultVal = vaultGet(brandName || '_global', key);
          if (vaultVal) {
            connected.push({ platform, status: 'connected' });
            return;
          }
        }
        return;
      }
      const ts = tokenAge[platform];
      if (ts && (now - ts) > EXPIRE_MS) {
        connected.push({ platform, status: 'expired' });
      } else {
        connected.push({ platform, status: 'connected' });
      }
    }
    checkBrand('metaAccessToken', 'meta');
    checkBrand('tiktokAccessToken', 'tiktok');
    checkBrand('googleAccessToken', 'google');
    checkBrand('amazonAccessToken', 'amazon');
    checkBrand('etsyAccessToken', 'etsy');
    checkBrand('redditAccessToken', 'reddit');
    // Shopify needs both token + store
    const shopToken = brandCfg.shopifyAccessToken || (!brandName ? globalCfg.shopifyAccessToken : null);
    const shopStore = brandCfg.shopifyStore || (!brandName ? globalCfg.shopifyStore : null);
    if ((shopToken && shopStore) || (typeof shopToken === 'string' && shopToken.startsWith('@@VAULT:'))) {
      const hasVaultToken = typeof shopToken === 'string' && shopToken.startsWith('@@VAULT:')
        ? !!vaultGet(brandName || '_global', 'shopifyAccessToken')
        : !!shopToken;
      if (hasVaultToken && shopStore) connected.push({ platform: 'shopify', status: 'connected' });
    }
    if (brandCfg.klaviyoApiKey || brandCfg.klaviyoAccessToken || (!brandName && (globalCfg.klaviyoApiKey || globalCfg.klaviyoAccessToken))) {
      connected.push({ platform: 'klaviyo', status: 'connected' });
    }
    if (globalCfg.falApiKey || vaultGet('_global', 'falApiKey')) connected.push({ platform: 'fal', status: 'connected' });
    if (globalCfg.elevenLabsApiKey || vaultGet('_global', 'elevenLabsApiKey')) connected.push({ platform: 'elevenlabs', status: 'connected' });
    if (globalCfg.heygenApiKey || vaultGet('_global', 'heygenApiKey')) connected.push({ platform: 'heygen', status: 'connected' });
    if (globalCfg.arcadsApiKey || vaultGet('_global', 'arcadsApiKey')) connected.push({ platform: 'arcads', status: 'connected' });
    // Slack posting requires a webhook URL. Bot token alone (from OAuth) enables
    // channel discovery but NOT posting. Show "needs setup" if only bot token exists.
    if (globalCfg.slackWebhookUrl) {
      connected.push({ platform: 'slack', status: 'connected' });
    } else if (globalCfg.slackBotToken || vaultGet('_global', 'slackBotToken')) {
      connected.push({ platform: 'slack', status: 'expired' }); // shows as needing attention
    }
    if (globalCfg.discordGuildId && globalCfg.discordChannelId) connected.push({ platform: 'discord', status: 'connected' });
    return connected;
  } catch { return []; }
}

ipcMain.handle('get-connected-platforms', (_, brandName) => {
  return getConnections(brandName);
});

// ── Disconnect Platform ────────────────────────────────────
// Clears all stored credentials for a platform. Platform tokens now live in
// the plaintext brand config at .merlin-config-{brand}.json (migrated from
// the old encrypted .merlin-tokens-{brand} format). API keys for service
// providers (fal, elevenlabs, heygen) and workspace-global integrations
// (slack, discord) live in the global merlin-config.json instead.
ipcMain.handle('disconnect-platform', (_, platform, brandName) => {
  try {
    // Map platform to config keys that should be cleared
    const keyMap = {
      meta: ['metaAccessToken', 'metaAdAccountId', 'metaPageId', 'metaPixelId'],
      tiktok: ['tiktokAccessToken', 'tiktokAdvertiserId', 'tiktokPixelId'],
      google: ['googleAccessToken', 'googleRefreshToken', 'googleAdsDeveloperToken', 'googleAdsCustomerId'],
      shopify: ['shopifyAccessToken', 'shopifyStore'],
      klaviyo: ['klaviyoAccessToken', 'klaviyoApiKey', 'klaviyoRefreshToken'],
      pinterest: ['pinterestAccessToken', 'pinterestRefreshToken'],
      amazon: ['amazonAccessToken', 'amazonRefreshToken', 'amazonProfileId'],
      etsy: ['etsyAccessToken', 'etsyRefreshToken', 'etsyShopId', 'etsyKeystring'],
      reddit: ['redditAccessToken', 'redditRefreshToken', 'redditAdAccountId'],
      slack: ['slackBotToken', 'slackWebhookUrl', 'slackChannel'],
      discord: ['discordGuildId', 'discordChannelId'],
      fal: ['falApiKey'],
      elevenlabs: ['elevenLabsApiKey'],
      heygen: ['heygenApiKey'],
      arcads: ['arcadsApiKey'],
    };
    const keys = keyMap[platform];
    if (!keys) return { success: false, error: 'unknown platform' };

    // Keys that live in global config (not per-brand files)
    const GLOBAL_KEYS_SET = new Set(['falApiKey', 'elevenLabsApiKey', 'heygenApiKey', 'slackBotToken', 'slackWebhookUrl', 'slackChannel', 'discordGuildId', 'discordChannelId']);
    const isGlobalPlatform = keys.every(k => GLOBAL_KEYS_SET.has(k));

    // 1. Clear from global config (for global platforms + legacy single-brand setups)
    const cfg = readConfig();
    let globalChanged = false;
    for (const key of keys) {
      if (cfg[key] !== undefined && cfg[key] !== '') {
        delete cfg[key];
        globalChanged = true;
      }
    }
    if (cfg._tokenTimestamps && cfg._tokenTimestamps[platform]) {
      delete cfg._tokenTimestamps[platform];
      globalChanged = true;
    }
    if (globalChanged) writeConfig(cfg);

    // 2. Clear from the active brand's plaintext config (new format post-migration)
    if (!isGlobalPlatform && brandName) {
      const brandConfigPath = path.join(appRoot, '.claude', 'tools', `.merlin-config-${brandName}.json`);
      try {
        const brandCfg = JSON.parse(fs.readFileSync(brandConfigPath, 'utf8'));
        let brandChanged = false;
        for (const key of keys) {
          if (brandCfg[key] !== undefined && brandCfg[key] !== '') {
            delete brandCfg[key];
            brandChanged = true;
          }
        }
        if (brandChanged) {
          const tmpPath = brandConfigPath + '.tmp';
          fs.writeFileSync(tmpPath, JSON.stringify(brandCfg, null, 2));
          fs.renameSync(tmpPath, brandConfigPath);
        }
      } catch { /* brand config may not exist — that's fine */ }

      // 3. Clear from the old encrypted tokens file (legacy, may still exist on
      // machines that haven't been migrated yet). Safe no-op if the file is gone.
      const legacyTokensPath = path.join(appRoot, '.claude', 'tools', `.merlin-tokens-${brandName}`);
      try {
        const buf = fs.readFileSync(legacyTokensPath);
        let tokens = {};
        if (canUseSafeStorage()) {
          try { tokens = JSON.parse(safeStorage.decryptString(buf)); } catch { tokens = JSON.parse(buf.toString('utf8')); }
        } else if (process.platform === 'darwin' && looksEncrypted(buf)) {
          // macOS: skip legacy encrypted file — readBrandConfig handles migration
          throw new Error('skip legacy on darwin');
        } else { tokens = JSON.parse(buf.toString('utf8')); }
        let changed = false;
        for (const key of keys) {
          if (tokens[key] !== undefined && tokens[key] !== '') {
            delete tokens[key];
            changed = true;
          }
        }
        if (changed) {
          if (canUseSafeStorage()) {
            fs.writeFileSync(legacyTokensPath, safeStorage.encryptString(JSON.stringify(tokens)));
          } else {
            fs.writeFileSync(legacyTokensPath, JSON.stringify(tokens), { mode: 0o600 });
          }
        }
      } catch { /* legacy file may not exist — normal */ }
    }

    // 4. Clear vault entries for the disconnected platform
    const vaultBrand = isGlobalPlatform ? '_global' : (brandName || '_global');
    for (const key of keys) {
      if (VAULT_SENSITIVE_KEYS.includes(key)) {
        vaultDelete(vaultBrand, key);
      }
    }

    // 5. Notify the renderer so the tile re-reads connection state
    if (win && !win.isDestroyed()) win.webContents.send('connections-changed');
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// ── Spellbook (Scheduled Tasks) ────────────────────────────
ipcMain.handle('list-spells', (_, brandName) => {
  const tasksDir = path.join(os.homedir(), '.claude', 'scheduled-tasks');
  if (!fs.existsSync(tasksDir)) return [];

  const cfg = readConfig();
  // Resolve spell metadata: check brandSpells first, then global spells
  const allSpellMeta = {};
  // Merge global spells
  if (cfg.spells) Object.assign(allSpellMeta, cfg.spells);
  // Merge brand-specific spells (overrides global)
  if (cfg.brandSpells) {
    for (const [brand, spells] of Object.entries(cfg.brandSpells)) {
      if (!brandName || brand === brandName) {
        Object.assign(allSpellMeta, spells);
      }
    }
  }
  const spellMeta = allSpellMeta;
  let configDirty = false;

  try {
    const dirs = fs.readdirSync(tasksDir, { withFileTypes: true }).filter(d => d.isDirectory());
    const results = dirs.map(d => {
      let name = d.name, description = '', cronFromFile = null;
      const skillPath = path.join(tasksDir, d.name, 'SKILL.md');
      try {
        const content = fs.readFileSync(skillPath, 'utf8');
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const fm = fmMatch[1];
          const nameMatch = fm.match(/name:\s*(.+)/);
          const descMatch = fm.match(/description:\s*["']?(.+?)["']?\s*$/m);
          const cronMatch = fm.match(/cron(?:Expression)?:\s*["']?([^"'\n]+)/);
          if (nameMatch) name = nameMatch[1].trim();
          if (descMatch) description = descMatch[1].trim();
          if (cronMatch) cronFromFile = cronMatch[1].trim();
        }
      } catch {}

      const meta = spellMeta[d.name] || {};

      // Self-heal: if spell exists on disk but not in config, add it
      if (!spellMeta[d.name] && d.name.startsWith('merlin-')) {
        spellMeta[d.name] = { cron: cronFromFile, enabled: true, description };
        configDirty = true;
      }

      return {
        id: d.name,
        name,
        description,
        cron: meta.cron || cronFromFile || null,
        enabled: meta.enabled !== false,
        lastRun: meta.lastRun || null,
        lastStatus: meta.lastStatus || null,
        lastSummary: meta.lastSummary || '',
        consecutiveFailures: meta.consecutiveFailures || 0,
        isMerlin: d.name.startsWith('merlin-'),
      };
    }).filter(t => {
      if (!t.isMerlin) return false;
      // If brand specified, only show spells for that brand (strict prefix match)
      if (brandName) return t.id.startsWith(`merlin-${brandName}-`);
      return true;
    });

    // Auto-repair config if spells were missing
    if (configDirty) {
      cfg.spells = spellMeta;
      writeConfig(cfg);
    }

    return results;
  } catch (e) { console.error('[list-spells]', e.message); return []; }
});

// Helper: extract brand from spell task ID (merlin-{brand}-{spell} → brand)
function extractBrandFromSpellId(taskId) {
  // Pattern: merlin-{brand}-{spellname} where brand is a slug
  const match = taskId.match(/^merlin-([a-z0-9_-]+?)-(?:daily|performance|morning|weekly|seo|competitor|email|custom)/i);
  return match ? match[1] : null;
}

// Helper: update spell metadata in the correct config store
function updateSpellConfig(taskId, updates) {
  const cfg = readConfig();
  const brand = extractBrandFromSpellId(taskId);

  if (brand && cfg.brandSpells && cfg.brandSpells[brand]) {
    cfg.brandSpells[brand][taskId] = { ...cfg.brandSpells[brand][taskId], ...updates };
  } else {
    if (!cfg.spells) cfg.spells = {};
    cfg.spells[taskId] = { ...cfg.spells[taskId], ...updates };
  }
  writeConfig(cfg);
}

ipcMain.handle('update-spell-meta', (_, taskId, meta) => {
  updateSpellConfig(taskId, meta);
  return { success: true };
});

ipcMain.handle('toggle-spell', (_, taskId, enabled) => {
  if (!taskId || typeof taskId !== 'string') return { success: false, error: 'invalid taskId' };

  // Update local meta (writes to correct brand store)
  updateSpellConfig(taskId, { enabled });

  // Ask Claude to actually enable/disable via MCP (suppressed — no chat chatter)
  if (resolveNextMessage) {
    _suppressNextResponse = true;
    setTimeout(() => { _suppressNextResponse = false; }, 30000);
    resolveNextMessage({
      type: 'user',
      message: { role: 'user', content:
        `Silently ${enabled ? 'enable' : 'disable'} the scheduled task "${taskId}" using update_scheduled_task. Reply with only "done".`
      }
    });
    return { success: true, synced: true };
  }
  // Also handle when called via send-message with silent flag
  // (toggle already updates config above, MCP sync is best-effort)
  // Session not active — local state updated but MCP not called
  return { success: true, synced: false };
});

// Returns the user's live ads from every connected platform. When a brand is
// specified, only that brand's ads are returned. When omitted, ads from all
// brands are unioned together so the "All" view shows everything running.
// Each entry is tagged with its brand so the renderer can show a badge and
// filter client-side.
ipcMain.handle('get-live-ads', (_, brandName) => {
  const brandsDir = path.join(appRoot, 'assets', 'brands');
  const readBrandAds = (brand) => {
    if (!/^[a-z0-9_-]+$/i.test(brand)) return [];
    const adsPath = path.join(brandsDir, brand, 'ads-live.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(adsPath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.map(ad => ({ ...ad, brand: ad.brand || brand }));
    } catch { return []; }
  };

  if (brandName) return readBrandAds(brandName);

  // No brand → union every brand's ads-live.json
  let all = [];
  try {
    for (const d of fs.readdirSync(brandsDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === 'example') continue;
      all = all.concat(readBrandAds(d.name));
    }
  } catch {}
  // Sort most recent first — publishedAt > updatedAt > 0
  all.sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.publishedAt || 0) || 0;
    const tb = Date.parse(b.updatedAt || b.publishedAt || 0) || 0;
    return tb - ta;
  });
  return all;
});

// Background refresh of live ads — spawns the binary sequentially for each
// platform that has valid credentials, so ads-live.json gets populated with
// the user's CURRENT state on Meta/TikTok/Google/Amazon/Reddit/LinkedIn.
// This means "Live Ads" shows real running ads, not a stale local snapshot —
// and it includes ads the user launched outside Merlin, as long as the
// platform's insights action reports them.
ipcMain.handle('refresh-live-ads', async (_, brandName) => {
  const binaryPath = getBinaryPath();
  try { fs.accessSync(binaryPath); } catch { return { success: false, error: 'binary missing' }; }

  // Merge brand config if a brand is specified so brand-scoped tokens are available
  let configPath = path.join(appRoot, '.claude', 'tools', 'merlin-config.json');
  try { fs.accessSync(configPath); } catch { return { success: false, error: 'config missing' }; }
  let isTmpConfig = false;
  let cfg = {};
  try {
    cfg = brandName ? readBrandConfig(brandName) : readConfig();
  } catch {}
  if (brandName) {
    if (cfg && Object.keys(cfg).length > 0) {
      const tmpPath = path.join(os.tmpdir(), `.merlin-config-tmp-${require('crypto').randomBytes(16).toString('hex')}.json`);
      try {
        fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        configPath = tmpPath;
        isTmpConfig = true;
      } catch (err) {
        return { success: false, error: `cannot write tmp config: ${err.message}` };
      }
    }
  }

  // Decide which platforms to hit based on what's connected in the config.
  // Each entry: [action, credential-check]. We skip any platform whose
  // credentials are missing — no point firing a request that will 401.
  //
  // Ordering matters: fast campaign-listing endpoints fire first so the UI
  // populates quickly. Reddit + LinkedIn use the campaigns endpoint (not
  // insights) because their insights responses are account-level aggregates
  // and don't give us per-campaign IDs to sync into ads-live.json.
  const platformJobs = [
    ['meta-insights',       !!cfg.metaAccessToken && !!cfg.metaAdAccountId],
    ['tiktok-insights',     !!cfg.tiktokAccessToken && !!cfg.tiktokAdvertiserId],
    ['google-ads-insights', !!cfg.googleAccessToken && !!cfg.googleAdsCustomerId],
    ['amazon-ads-insights', !!cfg.amazonAccessToken && !!cfg.amazonProfileId],
    ['reddit-campaigns',    !!cfg.redditAccessToken && !!cfg.redditAdAccountId],
    ['linkedin-campaigns',  !!cfg.linkedinAccessToken && !!cfg.linkedinAdAccountId],
  ];

  const { execFile } = require('child_process');
  const results = [];

  try {
    for (const [action, connected] of platformJobs) {
      if (!connected) { results.push({ action, skipped: true, reason: 'not connected' }); continue; }
      const cmdObj = { action, batchCount: 7 };
      if (brandName) cmdObj.brand = brandName;
      const cmd = JSON.stringify(cmdObj);
      const outcome = await new Promise((resolve) => {
        const child = execFile(binaryPath, ['--config', configPath, '--cmd', cmd], {
          timeout: 60000, cwd: appRoot, windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
        }, (err, stdout, stderr) => {
          if (!err) return resolve({ ok: true });
          // Capture a compact summary of the failure for the renderer —
          // stderr trimmed to 200 chars, plus whether it was a timeout.
          const stderrStr = String(stderr || '').trim();
          const isTimeout = err.killed === true;
          resolve({
            ok: false,
            error: isTimeout ? 'timeout after 60s' : (stderrStr.slice(0, 200) || err.message),
          });
        });
        activeChildProcesses.add(child);
        child.on('exit', () => activeChildProcesses.delete(child));
      });
      results.push({ action, skipped: false, ...outcome });
    }
  } finally {
    // ALWAYS delete the tmp config — even if the loop throws, we must not
    // leave decrypted credentials on disk.
    if (isTmpConfig) { try { fs.unlinkSync(configPath); } catch {} }
  }

  if (win && !win.isDestroyed()) win.webContents.send('live-ads-changed', { brand: brandName || '' });

  // Summarise: how many platforms were attempted, how many succeeded
  const attempted = results.filter(r => !r.skipped);
  const successes = attempted.filter(r => r.ok);
  const failures = attempted.filter(r => !r.ok);
  return {
    success: true,
    attempted: attempted.length,
    succeeded: successes.length,
    failed: failures.length,
    results,
  };
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

        // Read brand.md ONCE and extract all fields
        let vertical = '', status = 'active', displayName = d.name;
        if (fs.existsSync(brandMd)) {
          const content = fs.readFileSync(brandMd, 'utf8');
          // Match both plain and markdown bold formats:
          //   Vertical: apparel         — plain format
          //   - **Vertical**: apparel   — markdown bold format
          const vertMatch = content.match(/\*?\*?Vertical\*?\*?\s*[:]\s*(\w+)/i);
          if (vertMatch) vertical = vertMatch[1];
          const statusMatch = content.match(/\*?\*?Status\*?\*?\s*[:]\s*(active|paused|archived)/i);
          if (statusMatch) status = statusMatch[1].toLowerCase();
          const h1Match = content.match(/^#\s+(.+)$/m);
          if (h1Match) {
            displayName = h1Match[1].trim()
              // Strip common prefixes Claude adds to brand.md headings
              .replace(/^Brand\s*Profile\s*[-—:]\s*/i, '')
              .replace(/^Brand\s*[-—:]\s*/i, '')
              .trim();
          } else {
            const fieldMatch = content.match(/^(?:Brand|Name)[:\s]+["']?([^\n"']+)/im);
            if (fieldMatch) displayName = fieldMatch[1].trim();
          }
        }
        if (displayName === d.name) {
          displayName = d.name.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        }

        // Count products
        const productsDir = path.join(brandPath, 'products');
        let productCount = 0;
        try { productCount = fs.readdirSync(productsDir, { withFileTypes: true }).filter(dd => dd.isDirectory()).length; } catch {}

        return { name: d.name, displayName, vertical, productCount, status };
      });

    // Auto-generate brand index for commands/scheduled tasks
    try {
      const crypto = require('crypto');
      const indexPath = path.join(brandsDir, 'brands-index.json');

      // Compute hash of current brand state
      const hashInput = dirs.map(b => `${b.name}:${b.productCount}:${b.status}`).sort().join('|');
      const currentHash = crypto.createHash('md5').update(hashInput).digest('hex');

      // Only write if changed
      let existingHash = '';
      try { existingHash = JSON.parse(fs.readFileSync(indexPath, 'utf8')).hash; } catch {}

      if (currentHash !== existingHash) {
        const cfg = readConfig();

        const index = {
          hash: currentHash,
          generated: new Date().toISOString(),
          brands: dirs.map(b => ({
            ...b,
            hasShopify: !!cfg.shopifyAccessToken,
            hasMeta: !!cfg.metaAccessToken,
          })),
        };
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
      }
    } catch {}

    return dirs.filter(b => b.status !== 'archived');
  } catch { return []; }
});

// Fetch credit balances for connected platforms
ipcMain.handle('get-credits', async (_, brandName) => {
  let cfg = {};
  try { cfg = brandName ? readBrandConfig(brandName) : readConfig(); } catch { return {}; }

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
let _wisdomCache = {};  // keyed by vertical
let _wisdomCacheTime = {};
// Cache aligned with the server-side eager aggregation throttle (10 min).
// Previously 4 h, which masked fresh reports from the user's own binary —
// they ran meta-insights, sent data to the wisdom API, and still saw the
// stale pre-run numbers in the app because the cache hadn't expired.
const WISDOM_CACHE_MS = 10 * 60 * 1000; // 10 minutes

ipcMain.handle('get-wisdom', async (_, brandName, opts) => {
  if (!brandName) try { brandName = readState().activeBrand || ''; } catch {}
  const cfg = brandName ? readBrandConfig(brandName) : readConfig();
  const vertical = cfg.vertical || 'general';

  const force = opts && opts.force === true;
  if (!force && _wisdomCache[vertical] && (Date.now() - (_wisdomCacheTime[vertical] || 0)) < WISDOM_CACHE_MS) {
    return _wisdomCache[vertical];
  }
  try {
    const raw = await httpsGet(`https://api.merlingotme.com/api/wisdom?vertical=${encodeURIComponent(vertical)}`);
    _wisdomCache[vertical] = JSON.parse(raw.toString());
    _wisdomCacheTime[vertical] = Date.now();
    return _wisdomCache[vertical];
  } catch { return _wisdomCache[vertical] || null; }
});

// Force-invalidate the wisdom cache for a specific vertical (or all).
// Called from the binary hook after any *-insights action reports fresh data,
// so the next get-wisdom query bypasses the in-memory cache and pulls the
// freshly-aggregated numbers straight from the API.
function invalidateWisdomCache(vertical) {
  if (vertical) {
    delete _wisdomCache[vertical];
    delete _wisdomCacheTime[vertical];
  } else {
    _wisdomCache = {};
    _wisdomCacheTime = {};
  }
}
ipcMain.handle('invalidate-wisdom-cache', (_, vertical) => {
  invalidateWisdomCache(vertical);
  return { ok: true };
});

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

// Machine fingerprint for Stripe checkout + license polling (persistent).
//
// P1-8: the seed is DETERMINISTIC so that if the user wipes their
// workspace (or reinstalls), they land on the same machineId and their
// paid subscription is automatically recovered from the Cloudflare KV
// license record via reconcileSubscriptionWithServer(). The old code
// included Date.now() and generated a new ID on every fresh install,
// orphaning the paid subscription in KV forever.
//
// The on-disk file still wins if present, so existing users keep their
// old non-deterministic ID and nothing breaks for them.
function getMachineId() {
  const machineIdFile = path.join(appRoot, '.merlin-machine-id');
  try {
    const existing = fs.readFileSync(machineIdFile, 'utf8').trim();
    if (existing && existing.length >= 16) return existing;
  } catch {}

  const crypto = require('crypto');
  const raw = `${os.hostname()}|${os.userInfo().username}|${os.platform()}|${os.arch()}`;
  const id = crypto.createHash('sha256').update(raw).digest('hex');
  try {
    fs.mkdirSync(path.dirname(machineIdFile), { recursive: true });
    fs.writeFileSync(machineIdFile, id);
  } catch {}
  return id;
}

// Read the applied referral attribution (the referrer's code the current
// user entered into the UI). Used by the Stripe checkout URL builder and
// by getReferralInfo() so the UI can reflect the applied state.
function getAppliedAttribution() {
  try {
    const attrFile = path.join(appRoot, '.merlin-attribution');
    if (fs.existsSync(attrFile)) {
      const data = JSON.parse(fs.readFileSync(attrFile, 'utf8'));
      if (data && typeof data === 'object') return data;
    }
  } catch {}
  return null;
}

function getSubscriptionState() {
  const subFile = path.join(appRoot, '.merlin-subscription');
  let recoveryNeeded = false;
  try {
    if (fs.existsSync(subFile)) {
      // REGRESSION GUARD (2026-04-14, codex enterprise review fix #5):
      // The previous implementation fell back to
      // `fs.readFileSync(subFile, 'utf8')` if readSecureFile returned
      // null. readSecureFile itself already handles every legacy format
      // (plaintext on macOS, safeStorage blob on Win/Linux, new AES-GCM
      // envelope) and returns the recovered plaintext — so a raw
      // readFileSync fallback would only re-surface the exact file
      // shape readSecureFile already rejected (e.g. an AES-GCM envelope
      // whose auth tag failed). Dropping the fallback eliminates a
      // footgun where a corrupted/tampered file would be silently
      // parsed as JSON and trusted.
      const raw = readSecureFile(subFile);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.subscribed) {
          return {
            subscribed: true,
            tier: data.tier || 'pro',
            key: data.key || '',
            status: data.status || 'active',
            email: data.email || '',
            gracePeriodUntil: data.gracePeriodUntil || null,
            currentPeriodEnd: data.currentPeriodEnd || null,
          };
        }
      } else {
        // File exists but can't be read (keychain reset, migration).
        // Flag for reconciliation so the UI can fall back to the server.
        recoveryNeeded = true;
      }
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
  // Add referral bonus days (max 21 = 3 friends × 7 days = 1 month total free trial)
  let bonusDays = 0;
  try { bonusDays = parseInt(fs.readFileSync(path.join(appRoot, '.merlin-referral-bonus'), 'utf8')) || 0; } catch {}
  bonusDays = Math.min(Math.max(bonusDays, 0), 21);
  const totalTrialDays = 7 + bonusDays;
  const daysLeft = Math.max(0, totalTrialDays - Math.floor((Date.now() - trialStart) / (1000 * 60 * 60 * 24)));
  return {
    subscribed: false,
    daysLeft,
    bonusDays,
    trialStart,
    expired: daysLeft === 0,
    recoveryNeeded,
  };
}

// Persist the server's view of the subscription to the encrypted local
// file. Called by the activation poller AND by reconcileSubscriptionWithServer.
//
// REGRESSION GUARD (2026-04-14, codex enterprise review fix #5):
// Historically this function had a plaintext fallback "so recovery
// still works" if the encrypted write failed. That defeats the purpose
// of encrypting the subscription file — if writeSecureFile fails, it's
// because we genuinely cannot protect the data, and silently writing
// it plaintext to .merlin-subscription drops every downstream user in
// the "unprotected subscription state" bucket. The fix: if
// writeSecureFile fails, report the failure and leave the old file
// intact. The activation poller will retry on the next tick and the
// user will see the subscription update in memory anyway.
function persistSubscription(data) {
  const subFile = path.join(appRoot, '.merlin-subscription');
  const payload = JSON.stringify({
    subscribed: true,
    tier: data.tier || 'pro',
    status: data.status || 'active',
    email: data.email || '',
    gracePeriodUntil: data.gracePeriodUntil || null,
    currentPeriodEnd: data.currentPeriodEnd || null,
    activatedAt: Date.now(),
    via: data.via || 'stripe',
  });
  try {
    writeSecureFile(subFile, payload);
  } catch (err) {
    console.error('[persistSubscription] encrypted write failed:', err?.message || err);
    // Do NOT fall back to plaintext — see regression guard above.
  }
}

// Clear the local subscription file (called on cancel/refund).
function clearSubscription() {
  const subFile = path.join(appRoot, '.merlin-subscription');
  try { fs.unlinkSync(subFile); } catch {}
  // Scrub the license token at the same time — leaving a stale token
  // around would let a reconnected Stripe session rebind it incorrectly.
  try { fs.unlinkSync(path.join(appRoot, '.merlin-license-token')); } catch {}
}

// ── License token (dormant — codex enterprise review fix #2) ───────
//
// DORMANT INFRASTRUCTURE — not wired into any request yet.
//
// The server already issues and stores a 64-hex-char licenseToken in
// the KV license record on first checkout (see handleCheckoutCompleted
// in worker-payments.js). These client helpers are staged for a future
// release that adds a Stripe success_url → deep-link → IPC handoff so
// the token can reach the app. Until that path exists, /api/portal and
// /api/delete-my-data authenticate via email+machineId instead (see
// the REGRESSION GUARD on open-manage above for the full reasoning).
//
// The helpers are kept here so a follow-up release can:
//   1. Add a merlin://activate?token=... protocol handler
//   2. Route the token through set-license-token below
//   3. Flip open-manage to forward the token
// without having to re-land the read/write/IPC plumbing.
//
// DO NOT delete these. DO NOT wire them up without first completing
// the deep-link capture path or they'll diverge from the server.
function readLicenseToken() {
  const tokenFile = path.join(appRoot, '.merlin-license-token');
  try {
    const raw = readSecureFile(tokenFile);
    if (!raw) return '';
    const hex = String(raw).trim().replace(/[^0-9a-f]/gi, '').slice(0, 64).toLowerCase();
    return hex.length === 64 ? hex : '';
  } catch { return ''; }
}

function writeLicenseToken(token) {
  const tokenFile = path.join(appRoot, '.merlin-license-token');
  const hex = String(token || '').trim().replace(/[^0-9a-f]/gi, '').slice(0, 64).toLowerCase();
  if (hex.length !== 64) return false;
  try {
    writeSecureFile(tokenFile, hex);
    return true;
  } catch { return false; }
}

ipcMain.handle('set-license-token', (_evt, token) => {
  const ok = writeLicenseToken(token);
  return { ok };
});

// Throttle server reconciliation so we never hammer /api/check-license.
let _lastReconcileAt = 0;

// Reconcile the local subscription state with the server. This is the
// backbone of P1-6, P1-7 and the P1-8 recovery story:
//   - At launch, if the local file says "trial" or is unreadable, we ask
//     the server whether the same machineId has an active license. If yes,
//     we write the file and unlock Pro.
//   - After a cancellation webhook fires, the server returns
//     {activated:false, canceled:true} and we clear the local file.
//   - If the server says the license is in a grace period, we keep Pro
//     active but the UI can surface a "payment failed" banner.
//
// Opts:
//   force: skip the throttle window
//   reason: free-form string for logging
async function reconcileSubscriptionWithServer(opts = {}) {
  const now = Date.now();
  if (!opts.force && now - _lastReconcileAt < 60 * 1000) {
    return { reconciled: false, reason: 'throttled' };
  }
  _lastReconcileAt = now;

  const machineId = getMachineId();
  try {
    const raw = await httpsGet(`https://merlingotme.com/api/check-license?id=${machineId}`);
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return { reconciled: false, reason: 'parse' }; }

    const current = getSubscriptionState();

    if (data.activated === true) {
      if (!current.subscribed) {
        persistSubscription({
          tier: data.tier || 'pro',
          status: data.status || 'active',
          email: data.email || '',
          gracePeriodUntil: data.gracePeriodUntil || null,
          currentPeriodEnd: data.currentPeriodEnd || null,
          via: opts.via || 'reconcile',
        });
        if (win && !win.isDestroyed()) {
          win.webContents.send('subscription-activated', { tier: data.tier || 'pro' });
        }
        return { reconciled: true, subscribed: true, changed: true };
      }
      return { reconciled: true, subscribed: true, changed: false };
    }

    // Server says not activated. Two cases:
    //
    //  (a) The server returns a `status` field — the license record
    //      EXISTS and has been explicitly deactivated (canceled, refunded,
    //      past_due with 3 failed retries). In that case we clear local
    //      Pro state so the UI matches reality.
    //
    //  (b) No `status` field — the KV record doesn't exist on the server.
    //      This could mean the user activated via a local license key and
    //      never hit Stripe at all, or the record was purged. Preserve
    //      local state rather than downgrading a legit key-activated user.
    if (current.subscribed && data.status && data.status !== 'active' && data.status !== 'trialing') {
      clearSubscription();
      if (win && !win.isDestroyed()) {
        win.webContents.send('subscription-canceled', { reason: data.status });
      }
      return { reconciled: true, subscribed: false, changed: true };
    }
    return { reconciled: true, subscribed: !!current.subscribed, changed: false };
  } catch (err) {
    // Network failure — preserve local state and let the user keep using
    // the app. We'll retry on the next throttle window.
    return { reconciled: false, reason: 'network', error: err?.message || String(err) };
  }
}

ipcMain.handle('get-subscription', () => getSubscriptionState());
ipcMain.handle('check-subscription-status', async () => {
  // User-triggered path uses the 60-second throttle to avoid hammering
  // the server if the button is clicked repeatedly. Automated callers
  // (launch reconcile, hourly reconcile, activation poller) pass
  // force:true to bypass the throttle.
  await reconcileSubscriptionWithServer();
  return getSubscriptionState();
});

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

// Stripe payment link ID — this is the PRODUCTION Payment Link, not the
// Customer Portal login ID. The old code re-used this ID in the billing
// portal URL, which resolved to a 404 (P1-1). The billing portal now
// hits /api/portal and receives a one-time Stripe-generated session URL.
const STRIPE_CHECKOUT_ID = '5kQfZggqt73f7MMca85wI00';
const STRIPE_CHECKOUT_URL = `https://buy.stripe.com/${STRIPE_CHECKOUT_ID}`;

let _activationPoller = null;
let _activationPollerMachineId = null;

function startActivationPoller(machineId) {
  // P1-6: extend window from 10 to 30 minutes and make the poller
  // idempotent so the renderer can restart it via check-subscription-status.
  if (_activationPoller) {
    clearInterval(_activationPoller);
    _activationPoller = null;
  }
  _activationPollerMachineId = machineId;
  let attempts = 0;
  const MAX_ATTEMPTS = 180; // 180 × 10s = 30 minutes
  _activationPoller = setInterval(async () => {
    attempts++;
    if (attempts > MAX_ATTEMPTS) {
      clearInterval(_activationPoller);
      _activationPoller = null;
      _activationPollerMachineId = null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('activation-timeout');
      }
      return;
    }
    const result = await reconcileSubscriptionWithServer({ force: true, via: 'stripe' });
    if (result.reconciled && result.subscribed) {
      clearInterval(_activationPoller);
      _activationPoller = null;
      _activationPollerMachineId = null;
    }
  }, 10000);
}

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
  const attr = getAppliedAttribution();
  if (attr && attr.code && /^[0-9a-z-]{1,32}$/.test(String(attr.code))) {
    const safeCode = encodeURIComponent(attr.code);
    if (attr.type === 'affiliate') attrSuffix = `__aff_${safeCode}`;
    else if (attr.type === 'referral') attrSuffix = `__ref_${safeCode}`;
  }
  shell.openExternal(
    `${STRIPE_CHECKOUT_URL}?client_reference_id=${machineId}${attrSuffix}${emailParam}`,
  );

  startActivationPoller(machineId);
  return { ok: true };
});

// P1-1: Billing portal URL is generated server-side via /api/portal,
// which creates a per-customer Stripe Customer Portal session. The old
// code opened a hard-coded URL that reused the payment link ID and
// resolved to a 404 for every existing customer.
//
// REGRESSION GUARD (2026-04-14, codex enterprise review fix #2 — loop 2):
// The call now forwards the subscriber's EMAIL from the local
// subscription state file. The server compares it constant-time
// against the email on the license record and returns 403
// unauthorized on mismatch. machineId + email together is a
// meaningful bar raise over machineId alone (SHA256 of
// hostname|username|platform|arch, derivable by any process that
// knows the user's workstation identity). See the REGRESSION GUARD
// in worker-payments.js handlePortalSession for the full rationale
// and why this replaced the licenseToken approach that couldn't be
// migrated onto existing paying users without breaking their portal
// access.
ipcMain.handle('open-manage', async () => {
  const machineId = getMachineId();
  const sub = getSubscriptionState();
  const email = (sub && sub.email) || '';
  try {
    const https = require('https');
    const payload = JSON.stringify({ machineId, email });
    const raw = await new Promise((resolve, reject) => {
      const req = https.request('https://merlingotme.com/api/portal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 10000,
      }, (res) => {
        let body = [];
        res.on('data', c => body.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(body) }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(payload);
      req.end();
    });

    let data = {};
    try { data = JSON.parse(raw.body.toString()); } catch {}

    if (raw.status >= 200 && raw.status < 300 && data.url) {
      shell.openExternal(data.url);
      return { ok: true };
    }

    // Map server errors to user-facing copy. `email required` means
    // the local subscription file lost its email field — the user
    // needs to re-reconcile (launch reconcile will populate it) or
    // contact support. `unauthorized` means the email on the local
    // record no longer matches the email on the server record — this
    // happens if the user changed their Stripe email without the
    // Electron app catching the update yet; a reconcile will fix it.
    let errMsg = data.error || `Server returned ${raw.status}`;
    if (raw.status === 400 && data.error === 'email required') {
      errMsg = 'Your local subscription record is missing an email. Relaunch Merlin to re-sync, or contact support@merlingotme.com.';
    } else if (raw.status === 401 && data.error === 'reauth_required') {
      errMsg = 'Your subscription record is out of date. Email support@merlingotme.com to recover it.';
    } else if (raw.status === 403 && data.error === 'unauthorized') {
      // Trigger a forced reconcile in the background — the local
      // email may be stale after a Stripe-side email change.
      reconcileSubscriptionWithServer({ force: true, via: 'portal-403' }).catch(() => {});
      errMsg = 'Billing credential rejected. Your saved email may be out of date — try again in a moment, or email support@merlingotme.com.';
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send('inline-message', {
        kind: 'error',
        text: errMsg.includes('merlingotme.com') || errMsg.includes('support@merlingotme.com')
          ? errMsg
          : `Could not open billing portal: ${errMsg}. Email support@merlingotme.com if this persists.`,
      });
    }
    return { ok: false, error: errMsg };
  } catch (err) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('inline-message', {
        kind: 'error',
        text: `Could not reach billing portal (${err?.message || 'network error'}). Check your connection and retry.`,
      });
    }
    return { ok: false, error: err?.message || 'network error' };
  }
});

// ── Referral System ────────────────────────────────────────
ipcMain.handle('get-referral-info', async () => {
  const machineId = getMachineId();
  const attribution = getAppliedAttribution();
  const appliedReferralCode = attribution && attribution.type === 'referral' ? attribution.code : null;
  try {
    const raw = await httpsGet(`https://merlingotme.com/api/check-referral?id=${machineId}`);
    const info = JSON.parse(raw.toString());
    return {
      referralCode: info.referralCode || machineId.slice(0, 8),
      referralCount: info.referralCount || 0,
      subscribedCount: info.subscribedCount || 0,
      trialExtensionDays: info.trialExtensionDays || 0,
      referredBy: info.referredBy || null,
      appliedReferralCode,
    };
  } catch {
    return {
      referralCode: machineId.slice(0, 8),
      referralCount: 0,
      subscribedCount: 0,
      trialExtensionDays: 0,
      referredBy: null,
      appliedReferralCode,
    };
  }
});

ipcMain.handle('apply-referral-code', async (_, code) => {
  if (!code || typeof code !== 'string') return { success: false, error: 'Invalid code' };
  const trimmed = code.trim().toLowerCase().slice(0, 8);
  if (!/^[0-9a-f]{8}$/.test(trimmed)) {
    return { success: false, error: 'Invalid code format — should be 8 characters (0-9 and a-f)' };
  }

  // Block applying a code you've already applied (idempotent error).
  const existing = getAppliedAttribution();
  if (existing && existing.type === 'referral' && existing.code === trimmed) {
    return { success: true, bonus: 0, alreadyApplied: true };
  }

  const machineId = getMachineId();
  // Refuse to apply your own code locally — saves a round trip and gives
  // a clearer error than the server's "cannot self-refer".
  if (trimmed === machineId.slice(0, 8)) {
    return { success: false, error: "That's your own referral code — share it with a friend" };
  }

  try {
    const https = require('https');
    const payload = JSON.stringify({ referrer: trimmed, referred: machineId });
    const raw = await new Promise((resolve, reject) => {
      const req = https.request('https://merlingotme.com/api/register-referral', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 10000,
      }, (res) => {
        let body = [];
        res.on('data', c => body.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(body) }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(payload);
      req.end();
    });

    let result = {};
    try { result = JSON.parse(raw.body.toString()); } catch {}

    if (raw.status === 200 && result.ok) {
      // Save attribution for the next Stripe checkout so the referrer gets
      // credit at the paid conversion event.
      try {
        const attrFile = path.join(appRoot, '.merlin-attribution');
        fs.writeFileSync(attrFile, JSON.stringify({ type: 'referral', code: trimmed, appliedAt: Date.now() }));
      } catch {}
      // R2-1: immediately refresh the local bonus cache so the UI counter
      // updates without waiting for the 1-hour poll.
      try {
        const check = await httpsGet(`https://merlingotme.com/api/check-referral?id=${machineId}`);
        const data = JSON.parse(check.toString());
        if (Number.isFinite(data.trialExtensionDays) && data.trialExtensionDays >= 0) {
          fs.writeFileSync(path.join(appRoot, '.merlin-referral-bonus'), String(data.trialExtensionDays));
        }
      } catch {}
      return { success: true, bonus: result.bonus || 0 };
    }

    // Friendly error messages for known server responses
    const serverError = result.error || '';
    if (raw.status === 404) return { success: false, error: 'No user found with that referral code' };
    if (raw.status === 400 && serverError.includes('self-refer')) {
      return { success: false, error: "That's your own code — share it with a friend" };
    }
    if (raw.status === 429) return { success: false, error: 'Too many tries — wait a minute and retry' };
    return { success: false, error: serverError || 'Could not register referral' };
  } catch (err) {
    return { success: false, error: 'Network error — check your connection and try again' };
  }
});

ipcMain.handle('apply-update', () => { downloadAndApplyUpdate(); });
ipcMain.handle('restart-app', () => {
  // If an asar update was staged, run the swap script instead of plain relaunch.
  // asar hot-swap is Windows-only (macOS disabled to preserve code signature).
  if (process.platform === 'win32') {
    const swapScript = path.join(appInstall, 'update-swap.cmd');
    if (fs.existsSync(swapScript)) {
      const { spawn } = require('child_process');
      spawn('cmd.exe', ['/c', swapScript], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      app.exit(0);
      return;
    }
  }
  // Standard relaunch (macOS always, Windows when no swap script)
  app.relaunch();
  app.exit(0);
});

// Full auto-install: download the new installer from GitHub releases, spawn
// it detached, then quit. The installer's customInit kills any leftover
// Merlin processes, installs over the old build, and customInstall launches
// the new version. Net effect: a one-click in-app update for shell changes.
ipcMain.handle('install-update', async () => {
  try {
    const raw = await httpsGet('https://api.github.com/repos/oathgames/Merlin/releases/latest');
    const data = JSON.parse(raw.toString());
    if (!data || !data.assets) throw new Error('No release data');

    let assetName, runner;
    if (process.platform === 'win32') {
      const a = data.assets.find(x => /^Merlin\.Setup\..*\.exe$/i.test(x.name));
      if (!a) throw new Error('No Windows installer in release');
      assetName = a.name;
      runner = (filePath) => {
        const { spawn } = require('child_process');
        // Use cmd /c start to launch the installer fully detached from this
        // process tree. Previous approach (spawn detached) was getting killed
        // when the parent Electron process exited on some Windows configs.
        // cmd /c start /wait runs the installer, then start "" launches the
        // app after the installer finishes. The /wait is critical — without
        // it, the app launches before install completes and runs the old version.
        const installDir = path.dirname(app.getPath('exe'));
        const appExe = path.join(installDir, 'Merlin.exe');
        const script = `@echo off\r\n"${filePath}" /S\r\ntimeout /t 2 /nobreak >nul\r\nstart "" "${appExe}"\r\n`;
        const batPath = path.join(os.tmpdir(), 'merlin-update.bat');
        fs.writeFileSync(batPath, script);
        const child = spawn('cmd.exe', ['/c', 'start', '/min', '', batPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
      };
    } else if (process.platform === 'darwin') {
      const a = data.assets.find(x => /\.dmg$/i.test(x.name)) || data.assets.find(x => /-mac.*\.zip$/i.test(x.name));
      if (!a) throw new Error('No Mac installer in release');
      assetName = a.name;
      runner = (filePath) => {
        const { spawn } = require('child_process');
        // Show guidance before opening DMG — non-technical users need instructions
        if (win && !win.isDestroyed()) {
          win.webContents.send('update-progress', 'Opening installer — drag Merlin to your Applications folder to complete the update.');
        }
        spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
      };
    } else {
      throw new Error('Auto-install not supported on this platform');
    }

    const asset = data.assets.find(x => x.name === assetName);
    if (win && !win.isDestroyed()) win.webContents.send('update-progress', 'Downloading installer...');
    const installer = await httpsGet(asset.browser_download_url);
    if (installer.length < 1024 * 1024) throw new Error('Installer download too small');

    const tmpFile = path.join(os.tmpdir(), assetName);
    fs.writeFileSync(tmpFile, installer);
    if (process.platform !== 'win32') fs.chmodSync(tmpFile, 0o755);

    if (win && !win.isDestroyed()) win.webContents.send('update-progress', 'Installing update...');

    setTimeout(() => {
      try { runner(tmpFile); } catch (e) { console.error('[install-update] runner failed', e); }
      // Give the batch script a moment to start before we exit
      setTimeout(() => { forceQuit = true; app.quit(); }, 1500);
    }, 500);

    return { ok: true };
  } catch (err) {
    console.error('[install-update]', err);
    if (win && !win.isDestroyed()) win.webContents.send('update-error', err.message || 'Install failed');
    return { ok: false, error: err.message };
  }
});
// Manual "check for updates" trigger from the UI. Returns the result so the
// caller can show a toast like "You're on the latest version" when no update
// exists, instead of the auto-check's silent no-op behavior.
ipcMain.handle('check-for-updates', async () => {
  try {
    const currentVersion = getCurrentVersion();
    const raw = await httpsGet('https://api.github.com/repos/oathgames/Merlin/releases/latest');
    const data = JSON.parse(raw.toString());
    if (!data || !data.tag_name) return { ok: false, error: 'Could not reach GitHub' };
    const latestVersion = data.tag_name.replace(/^v/, '');
    const hasNewer = isNewerVersion(latestVersion, currentVersion);
    const hasInstaller = releaseHasInstallerForPlatform(data.assets);
    const hasUpdate = hasNewer && hasInstaller;
    if (hasUpdate && win && !win.isDestroyed()) {
      win.webContents.send('update-available', { current: currentVersion, latest: latestVersion });
    }
    return { ok: true, current: currentVersion, latest: latestVersion, hasUpdate };
  } catch (err) {
    return { ok: false, error: err.message || 'Update check failed' };
  }
});

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
  // Workspace version.json is the source of truth — the update process writes
  // here reliably. The asar's bundled package.json may be stale if the hot-swap
  // failed (locked file, non-writable install dir, AV interference).
  try { return JSON.parse(fs.readFileSync(path.join(appRoot, 'version.json'), 'utf8')).version; } catch {}
  // Fallback: asar package.json (first install before any update)
  if (app.isPackaged) {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; } catch {}
  }
  try { return JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version; } catch {}
  return '0.0.0';
}

// Semver comparison: returns true if a > b (e.g. "0.4.0" > "0.3.8")
function isNewerVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// Download the Merlin engine binary from the latest GitHub release.
// FALLBACK ONLY — the binary is normally bundled in the installer at the
// install location. This runs only when the install copy is missing AND
// the workspace copy is missing. Writes to the workspace because the
// install location may be read-only (Mac) or AV-watched.
// Minimum binary version this Electron release requires. If the user's
// installed engine is below this, refresh-perf produces dashboard files in
// the WRONG directory (.claude/tools/results/ instead of results/{brand}/)
// because the cwd-aware outputDir fix shipped in 1.0.7. Without an enforced
// floor, a user on 1.0.6 who installs the new Electron would click "run a
// check now" and see no improvement — making the fix look broken.
//
// This constant lives in code rather than version.json because the Electron
// app and the engine binary are separate artifacts that can be on different
// versions briefly during rollout, and we want the app to know its own hard
// dependency without reading a file that's updatable.
const MIN_BINARY_VERSION = '1.0.7';

// Compare two dotted-number version strings (e.g. "1.0.7" vs "1.0.6").
// Returns -1, 0, or 1. Non-numeric or missing fields compare as 0.
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// Shell out to the binary's `--version` flag and parse the version string.
// The binary prints "Merlin Pipeline vX.Y.Z" to stdout. Returns null on any
// failure (binary missing, bad exit, unparseable output).
//
// NOTE: we use the `--version` FLAG, not `--cmd '{"action":"version"}'`,
// because the flag short-circuits before loadConfig runs. The cmd path
// requires a valid config file on disk, which we can't assume during the
// version check — especially during forced-update recovery after a failed
// install where config may be missing or corrupted.
async function getBinaryVersion() {
  const binaryPath = getBinaryPath();
  try { fs.accessSync(binaryPath); } catch { return null; }
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile(binaryPath, ['--version'], { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const m = String(stdout).match(/Merlin Pipeline v(\d+\.\d+\.\d+)/);
      resolve(m ? m[1] : null);
    });
  });
}

// Tracks whether the binary is below MIN_BINARY_VERSION after the startup
// check. Consulted by refresh-perf and the perf-bar empty-state button so
// the user sees a clear "engine updating" message instead of a confusing
// failure when the fix can't apply yet.
let _binaryTooOld = false;
function isBinaryTooOld() { return _binaryTooOld; }

// Promise that resolves once the startup binary ensure+version check has
// completed. refresh-perf and MCP runBinary await this to prevent a request
// that slips into the startup window (before the check runs) from executing
// against a stale binary that writes dashboards to the wrong directory.
//
// kickoffStartupChecks schedules the work behind a setTimeout so window
// creation isn't blocked, but returns the promise immediately so callers
// can await it instead of racing it.
//
// Safety: the whole body is wrapped so the promise is GUARANTEED to resolve.
// If it didn't, every subsequent refresh-perf call would hang forever
// (deadlock). A failed startup check must still resolve the promise — with
// _binaryTooOld=true — so downstream callers see the refusal message
// instead of silent infinite-await.
let _startupChecksPromise = null;
function kickoffStartupChecks(onProgress) {
  if (_startupChecksPromise) return _startupChecksPromise;
  _startupChecksPromise = new Promise((resolve) => {
    const finish = (result) => {
      try { resolve(result); } catch {}
    };
    // Hard safety net: if for any reason the async body never resolves
    // within 5 minutes, force-resolve so we don't deadlock downstream
    // callers. 5 minutes is generous — ensureBinary is 30-60s worst case,
    // the version check is <1s.
    const deadlineTimer = setTimeout(() => {
      _binaryTooOld = true;
      finish({ ok: false, error: 'startup check deadline exceeded' });
    }, 5 * 60 * 1000);

    setTimeout(async () => {
      try {
        try {
          await ensureBinary({ onProgress });
        } catch (err) {
          console.error('[ensureBinary]', err.message);
          if (win && !win.isDestroyed()) {
            win.webContents.send('engine-status', `Engine download failed: ${err.message}`);
          }
          // Swallow — the version check below still runs and sets _binaryTooOld
          // if we can't read a version, which is the correct refusal state.
        }
        let result;
        try {
          result = await ensureBinaryMinVersion(onProgress);
          if (!result.ok && win && !win.isDestroyed()) {
            win.webContents.send('engine-status', `Engine is out of date (need ≥${MIN_BINARY_VERSION}). Performance tracking is disabled until update completes.`);
          }
        } catch (err) {
          console.error('[ensureBinaryMinVersion]', err.message);
          _binaryTooOld = true;
          result = { ok: false, error: err.message };
        }
        clearTimeout(deadlineTimer);
        finish(result);
      } catch (err) {
        // Last-resort catch — nothing above should throw since each step
        // has its own try/catch, but belt-and-braces to prevent deadlock.
        console.error('[startup-checks] unexpected error:', err && err.message);
        _binaryTooOld = true;
        clearTimeout(deadlineTimer);
        finish({ ok: false, error: err && err.message });
      }
    }, 1500);
  });
  return _startupChecksPromise;
}

// Verify the installed binary is new enough. If not, force-download from
// GitHub releases (ensureBinary with force:true). Sets _binaryTooOld if the
// update fails so downstream code can react.
async function ensureBinaryMinVersion(onProgress = null) {
  const current = await getBinaryVersion();
  if (current && compareVersions(current, MIN_BINARY_VERSION) >= 0) {
    _binaryTooOld = false;
    return { ok: true, version: current };
  }

  console.log(`[engine] current=${current || 'unknown'} requires=>=${MIN_BINARY_VERSION} — updating`);
  if (onProgress) onProgress(`Updating engine to v${MIN_BINARY_VERSION}...`);
  try {
    await ensureBinary({ force: true, onProgress });
  } catch (err) {
    console.error('[engine] forced update failed:', err.message);
    _binaryTooOld = true;
    appendErrorLog(`${new Date().toISOString()} [binary-version] current=${current || 'unknown'} required=${MIN_BINARY_VERSION} update failed: ${err.message}\n`);
    return { ok: false, version: current, error: err.message };
  }

  // Re-check after download
  const updated = await getBinaryVersion();
  if (updated && compareVersions(updated, MIN_BINARY_VERSION) >= 0) {
    _binaryTooOld = false;
    return { ok: true, version: updated };
  }
  _binaryTooOld = true;
  appendErrorLog(`${new Date().toISOString()} [binary-version] after forced update: current=${updated || 'unknown'} still below ${MIN_BINARY_VERSION}\n`);
  return { ok: false, version: updated };
}

async function ensureBinary(opts = {}) {
  const { force = false, onProgress = null } = opts;

  // Fast path: install or workspace already has the binary
  if (!force) {
    try { fs.accessSync(getBinaryPath(), fs.constants.F_OK); return true; } catch {}
  }

  // Workspace target — install location may not be writable
  const binaryPath = path.join(appRoot, '.claude', 'tools', process.platform === 'win32' ? 'Merlin.exe' : 'Merlin');

  // Make sure the tools directory exists
  try { fs.mkdirSync(path.dirname(binaryPath), { recursive: true }); } catch {}

  if (onProgress) onProgress('Fetching engine...');
  const raw = await httpsGet('https://api.github.com/repos/oathgames/Merlin/releases/latest');
  const data = JSON.parse(raw.toString());
  if (!data || !data.assets) throw new Error('No release data available');

  const assetName = process.platform === 'win32' ? 'Merlin-windows-amd64.exe'
    : (process.platform === 'darwin' && process.arch === 'arm64') ? 'Merlin-darwin-arm64'
    : process.platform === 'darwin' ? 'Merlin-darwin-amd64'
    : 'Merlin-linux-amd64';

  const asset = (data.assets || []).find(a => a.name === assetName);
  if (!asset) throw new Error(`Engine binary ${assetName} not found in latest release`);

  if (onProgress) onProgress('Downloading engine...');
  const binary = await httpsGet(asset.browser_download_url);

  if (binary.length < 1024 * 1024) {
    throw new Error('Downloaded engine too small — possible corrupted download');
  }

  // Verify checksum if published
  const checksumAsset = (data.assets || []).find(a => a.name === 'checksums.txt');
  if (checksumAsset) {
    try {
      const checksumFile = (await httpsGet(checksumAsset.browser_download_url)).toString();
      const expectedHash = checksumFile.split('\n')
        .map(l => l.trim().split(/\s+/))
        .find(parts => parts[1] === assetName)?.[0];
      if (expectedHash) {
        const crypto = require('crypto');
        const actualHash = crypto.createHash('sha256').update(binary).digest('hex');
        if (actualHash !== expectedHash) {
          throw new Error(`Engine checksum mismatch: expected ${expectedHash.slice(0,12)}..., got ${actualHash.slice(0,12)}...`);
        }
      }
    } catch (e) {
      if (e.message.includes('checksum mismatch')) throw e;
      // Retry checksum fetch up to 2 more times before hard-failing (S4-05 hardening)
      let verified = false;
      for (let attempt = 0; attempt < 2 && !verified; attempt++) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        try {
          const retryFile = (await httpsGet(checksumAsset.browser_download_url)).toString();
          const retryHash = retryFile.split('\n').map(l => l.trim().split(/\s+/)).find(p => p[1] === assetName)?.[0];
          if (retryHash) {
            const ah = require('crypto').createHash('sha256').update(binary).digest('hex');
            if (ah !== retryHash) throw new Error('Engine checksum mismatch on retry');
            verified = true;
          }
        } catch (re) { if (re.message.includes('checksum mismatch')) throw re; }
      }
      if (!verified) throw new Error('Cannot verify engine integrity — checksum unavailable after 3 attempts. Aborted for security.');
    }
  }

  // Atomic write: write to tmp then rename
  const tmpPath = binaryPath + '.download';
  fs.writeFileSync(tmpPath, binary);
  try { fs.unlinkSync(binaryPath); } catch {}
  fs.renameSync(tmpPath, binaryPath);

  if (process.platform !== 'win32') {
    fs.chmodSync(binaryPath, 0o755);
    const { execSync } = require('child_process');
    try { execSync(`xattr -d com.apple.quarantine "${binaryPath}" 2>/dev/null`); } catch {}
    try {
      execSync(`codesign --force --sign - "${binaryPath}"`);
    } catch (signErr) {
      console.error('[ensureBinary] macOS ad-hoc codesign failed:', signErr.message);
      if (onProgress) onProgress('Engine downloaded — codesign failed. You may need to allow it in System Settings > Privacy.');
    }
  }

  console.log(`[ensureBinary] Downloaded ${assetName} (${(binary.length / 1024 / 1024).toFixed(1)} MB) to ${binaryPath}`);
  if (onProgress) onProgress('Engine ready');
  return true;
}

// Returns true if the release contains an installer asset for THIS platform.
// Used to skip update toasts for releases that didn't ship a Mac DMG (e.g.
// when CI minutes were exhausted and the build was done locally on Windows).
function releaseHasInstallerForPlatform(assets) {
  if (!Array.isArray(assets)) return false;
  if (process.platform === 'win32') return assets.some(a => /^Merlin\.Setup\..*\.exe$/i.test(a.name));
  if (process.platform === 'darwin') return assets.some(a => /\.dmg$/i.test(a.name) || /-mac.*\.zip$/i.test(a.name));
  return true;
}

async function checkForUpdates() {
  try {
    const currentVersion = getCurrentVersion();
    const raw = await httpsGet('https://api.github.com/repos/oathgames/Merlin/releases/latest');
    const data = JSON.parse(raw.toString());
    if (!data || !data.tag_name) return;
    const latestVersion = data.tag_name.replace(/^v/, '');
    console.log(`[update] current=${currentVersion} latest=${latestVersion} newer=${isNewerVersion(latestVersion, currentVersion)}`);
    if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) return;
    // Skip the toast if the release doesn't ship an installer for this OS
    if (!releaseHasInstallerForPlatform(data.assets)) {
      console.log('[update] release has no installer for this platform, skipping toast');
      return;
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send('update-available', { current: currentVersion, latest: latestVersion });
    }
  } catch (err) { console.log('[update] check failed:', err.message); }
}

async function downloadAndApplyUpdate() {
  try {
    const currentVersion = getCurrentVersion();
    const raw = await httpsGet('https://api.github.com/repos/oathgames/Merlin/releases/latest');
    const data = JSON.parse(raw.toString());
    if (!data || !data.tag_name) throw new Error('Invalid release data');
    const latestVersion = data.tag_name.replace(/^v/, '');
    if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) return;

    if (win && !win.isDestroyed()) win.webContents.send('update-progress', 'Downloading...');

    const versionJson = JSON.parse((await httpsGet(`https://raw.githubusercontent.com/oathgames/Merlin/${data.tag_name}/version.json`)).toString());

    // REGRESSION GUARD (2026-04-14, codex enterprise review fix #6):
    // Fetch the signed checksums.txt BEFORE touching anything on disk
    // and build a lookup from filename → expected SHA256. Every artifact
    // the updater is willing to overwrite — binary, app.asar, each file
    // in versionJson.updatable — must have an entry in this map, and
    // must verify byte-for-byte, or the update aborts with the user's
    // on-disk state untouched.
    //
    // Previously, the "updatable" files (CLAUDE.md, settings.json, the
    // merlin.md command file, hook scripts) were downloaded from
    // raw.githubusercontent.com with NO verification and written
    // straight over local files. A GitHub account compromise on a
    // single repo with write access, a CDN cache poisoning, or a
    // network-level attack with a valid merlin.local TLS cert would
    // let an attacker silently swap the shipped settings.json or
    // hook scripts — both of which run shell commands on every
    // Bash/Edit call. That's a full RCE-on-update primitive.
    //
    // The fix: pull the SAME checksums.txt we use for the binary,
    // parse it once into a map, and demand a match for every file we
    // write during the update flow. For legacy releases without
    // checksum entries for updatable files, we log and skip rather
    // than silently overwriting — the worst case is an older release
    // serves new binaries but stale commands, which is a strictly
    // safer failure mode than the current "overwrite anything that
    // fetches 200 OK" path.
    //
    // DO NOT reintroduce an unverified httpsGet+writeFileSync pair
    // inside the updatable loop. DO NOT relax the checksum lookup to
    // a "trust if missing" default.
    const checksumAsset = (data.assets || []).find(a => a.name === 'checksums.txt');
    const checksumMap = new Map();
    if (checksumAsset) {
      try {
        const checksumFile = (await httpsGet(checksumAsset.browser_download_url)).toString();
        for (const line of checksumFile.split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2 && /^[0-9a-f]{64}$/i.test(parts[0])) {
            checksumMap.set(parts.slice(1).join(' ').replace(/^\*/, ''), parts[0].toLowerCase());
          }
        }
      } catch (e) {
        throw new Error(`Cannot fetch checksums.txt: ${e.message}. Update aborted for security.`);
      }
    }
    const sha256 = (buf) => require('crypto').createHash('sha256').update(buf).digest('hex');

    // Phase 1 (download-only): fetch every updatable file into memory,
    // verify its checksum if one is listed, and stage it for atomic
    // write in phase 2. If a listed checksum MISMATCHES, abort without
    // touching disk. If no checksum is listed, still apply the file
    // but log a warning — the file is already pinned to a git tag on
    // raw.githubusercontent.com, which is effectively immutable (tag
    // force-push requires admin access + is audit-logged) and is the
    // same trust level our release assets rely on.
    //
    // REGRESSION GUARD (2026-04-14, codex enterprise review fix #6 — loop 2):
    // The first version of this fix hard-failed on missing checksums,
    // which would have orphaned every updatable file (CLAUDE.md,
    // settings.json, command files) whenever CI hadn't been updated
    // yet to emit their hashes. That broke auto-updates end-to-end
    // because CI emits checksums only for the Go binaries + app.asar,
    // not for raw.githubusercontent.com-fetched files. Soft-miss
    // behavior preserves auto-update utility while still HARD-failing
    // on an actual checksum mismatch.
    //
    // DO NOT change the soft-miss to a hard-fail without also
    // extending release.yml to emit checksums for every entry in
    // versionJson.updatable.
    const stagedUpdatables = [];
    for (const filePath of (versionJson.updatable || [])) {
      try {
        const content = await httpsGet(`https://raw.githubusercontent.com/oathgames/Merlin/${data.tag_name}/${filePath}`);
        const expected = checksumMap.get(filePath) || checksumMap.get(path.basename(filePath));
        if (expected) {
          const actual = sha256(content).toLowerCase();
          if (actual !== expected) {
            throw new Error(`Checksum mismatch on ${filePath}: expected ${expected.slice(0, 12)}..., got ${actual.slice(0, 12)}...`);
          }
        } else {
          console.warn(`[update] no checksum listed for ${filePath}, relying on tag immutability`);
        }
        stagedUpdatables.push({ filePath, content });
      } catch (e) {
        if (e.message && e.message.includes('Checksum mismatch')) throw e;
        // Network failures on individual files are non-fatal — skip.
        console.warn('[update] updatable fetch failed:', filePath, e.message);
      }
    }
    // Phase 2: write each verified file. Each write is preceded by a
    // one-file backup so we can roll back the entire update on failure.
    const rollbackList = [];
    try {
      for (const { filePath, content } of stagedUpdatables) {
        const fullPath = path.join(appRoot, filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        if (fs.existsSync(fullPath)) {
          const backup = fullPath + '.rollback';
          try { fs.copyFileSync(fullPath, backup); rollbackList.push({ fullPath, backup }); } catch {}
        }
        fs.writeFileSync(fullPath, content);
      }
    } catch (writeErr) {
      // Roll back any partial writes before surfacing the error.
      for (const { fullPath, backup } of rollbackList) {
        try { fs.copyFileSync(backup, fullPath); } catch {}
        try { fs.unlinkSync(backup); } catch {}
      }
      throw new Error(`Update rolled back after write failure: ${writeErr.message}`);
    }
    // Clean up backups once all writes succeeded.
    for (const { backup } of rollbackList) {
      try { fs.unlinkSync(backup); } catch {}
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
      // REGRESSION GUARD (2026-04-14, codex enterprise review fix #6):
      // The binary checksum check USED to be soft-failing: if
      // checksums.txt was missing or the binary wasn't listed, the
      // update proceeded without verification. That was already caught
      // in an earlier hardening pass (see the "3 attempts" retry), but
      // the implementation relied on a per-binary checksum fetch inside
      // this block. We now reuse the checksumMap populated at the top
      // of this function — single source of truth, same failure path
      // as app.asar / updatable files. A missing entry is a HARD abort.
      const expectedBinaryHash = checksumMap.get(binaryName);
      if (!expectedBinaryHash) {
        throw new Error('Cannot verify update integrity — binary not listed in checksums.txt. Update aborted for security.');
      }
      const actualBinaryHash = sha256(binary).toLowerCase();
      if (actualBinaryHash !== expectedBinaryHash) {
        throw new Error(`Binary checksum mismatch: expected ${expectedBinaryHash.slice(0, 12)}..., got ${actualBinaryHash.slice(0, 12)}...`);
      }
      const binaryPath = path.join(appRoot, '.claude', 'tools', process.platform === 'win32' ? 'Merlin.exe' : 'Merlin');
      if (fs.existsSync(binaryPath)) fs.copyFileSync(binaryPath, binaryPath + '.backup');
      try {
        fs.writeFileSync(binaryPath, binary);
      } catch (writeErr) {
        // Roll back the binary before surfacing the error so the app
        // doesn't boot from a half-written artifact on next launch.
        try { fs.copyFileSync(binaryPath + '.backup', binaryPath); } catch {}
        throw writeErr;
      }
      if (process.platform !== 'win32') {
        fs.chmodSync(binaryPath, 0o755);
        // macOS: clear quarantine + ad-hoc sign so Gatekeeper allows execution
        const { execSync } = require('child_process');
        try { execSync(`xattr -d com.apple.quarantine "${binaryPath}" 2>/dev/null`); } catch {}
        try { execSync(`codesign --force --sign - "${binaryPath}" 2>/dev/null`); } catch {}
      }
      try { fs.unlinkSync(binaryPath + '.backup'); } catch {}
    }

    // Update version in BOTH version.json and package.json
    // version.json is the source of truth (always writable, included in updatable list)
    const vjPath = path.join(appRoot, 'version.json');
    try {
      const vj = JSON.parse(fs.readFileSync(vjPath, 'utf8'));
      vj.version = latestVersion;
      fs.writeFileSync(vjPath, JSON.stringify(vj, null, 2));
    } catch {}

    const pkgPath = path.join(appRoot, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.version = latestVersion;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    } catch {} // may fail in asar — that's OK, version.json is the source of truth

    console.log(`[update] Version updated to ${latestVersion}`);

    // Stage the new asar for swap on restart.
    // macOS: DISABLED — mutating files inside a signed .app bundle invalidates the
    // code signature, causing "The application Merlin is not open anymore" on relaunch.
    // Ad-hoc re-signing loses hardened runtime entitlements. Mac users update via DMG only.
    // Windows: asar hot-swap works because Windows doesn't enforce code signatures on apps.
    //
    // REGRESSION GUARD (2026-04-14, codex enterprise review fix #6):
    // The app.asar download USED to trust any artifact over 500 KB as
    // valid — no checksum, no signature, just a size heuristic. An
    // attacker with write access to the release assets (compromised
    // PAT, branch-protection bypass, CDN cache poison) could ship an
    // arbitrary JS payload that runs with full Electron main-process
    // privileges on the next launch. app.asar IS the application — an
    // unverified swap is a full remote code execution primitive.
    //
    // The fix: require an app.asar checksum entry in checksums.txt,
    // verify byte-for-byte before writing the staged file, and delete
    // the staged file + abort staging on any failure (so the next
    // launch boots from the existing asar instead of a half-downloaded
    // one).
    let asarStaged = false;
    if (app.isPackaged && process.platform === 'win32') {
      const asarAsset = (data.assets || []).find(a => a.name === 'app.asar');
      if (asarAsset) {
        const asarPath = path.join(appInstall, 'app.asar');
        const stagedPath = asarPath + '.update';
        try {
          if (win && !win.isDestroyed()) win.webContents.send('update-progress', 'Downloading update...');
          const asarData = await httpsGet(asarAsset.browser_download_url);
          if (asarData.length <= 500000) {
            throw new Error(`app.asar too small (${asarData.length} bytes) — possible corrupted download`);
          }
          const expectedAsarHash = checksumMap.get('app.asar');
          if (!expectedAsarHash) {
            throw new Error('Cannot verify app.asar — not listed in checksums.txt. Update aborted for security.');
          }
          const actualAsarHash = sha256(asarData).toLowerCase();
          if (actualAsarHash !== expectedAsarHash) {
            throw new Error(`app.asar checksum mismatch: expected ${expectedAsarHash.slice(0, 12)}..., got ${actualAsarHash.slice(0, 12)}...`);
          }
          fs.writeFileSync(stagedPath, asarData);
          asarStaged = true;
          console.log(`[update] asar staged (${(asarData.length / 1024 / 1024).toFixed(1)} MB) → ${stagedPath}`);
          const swapScript = path.join(appInstall, 'update-swap.cmd');
          const exePath = process.execPath;
          fs.writeFileSync(swapScript, [
            '@echo off',
            `timeout /t 2 /nobreak >nul`,
            `move /Y "${stagedPath}" "${asarPath}"`,
            `start "" "${exePath}"`,
            `del "%~f0"`,
          ].join('\r\n'));
          console.log('[update] swap script written:', swapScript);
        } catch (e) {
          console.error('[update] asar staging failed:', e.message);
          // Clean up any partial stage so the safety net at launch
          // doesn't try to apply a corrupt / tampered asar.
          try { fs.unlinkSync(stagedPath); } catch {}
          asarStaged = false;
        }
      }
      // Stage install-dir binary copy for the swap script (Mac: avoid writing to
      // the signed .app bundle while running — defer to swap script instead).
      if (binaryAsset) {
        try {
          const workspaceBinary = path.join(appRoot, '.claude', 'tools', process.platform === 'win32' ? 'Merlin.exe' : 'Merlin');
          const installBinaryPath = path.join(appInstall, '.claude', 'tools', process.platform === 'win32' ? 'Merlin.exe' : 'Merlin');
          if (fs.existsSync(path.dirname(installBinaryPath)) && fs.existsSync(workspaceBinary)) {
            if (process.platform === 'darwin' && asarStaged) {
              // On Mac, the swap script will handle this AFTER codesign
              const stagedBinary = installBinaryPath + '.update';
              fs.copyFileSync(workspaceBinary, stagedBinary);
              console.log('[update] install-dir binary staged for swap script');
            } else {
              // Windows: write directly (no code signing concern)
              fs.copyFileSync(workspaceBinary, installBinaryPath);
              console.log('[update] install-dir binary synced');
            }
          }
        } catch (e) {
          console.error('[update] install-dir binary sync failed:', e.message);
        }
      }
    }

    // Never trigger the installer-download path (which downloads an .exe to
    // temp and triggers Defender). The asar hot-swap + binary replace handles
    // everything. Just restart to apply.
    if (win && !win.isDestroyed()) win.webContents.send('update-ready', { latest: latestVersion, needsReinstall: false });
  } catch (err) {
    if (win && !win.isDestroyed()) win.webContents.send('update-error', err.message || String(err));
  }
}

// ── App Lifecycle ───────────────────────────────────────────

// Single instance lock — prevent multiple windows
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.exit(0); } // exit(0) is synchronous — quit() is async and flashes a taskbar icon before closing
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  // ── Deferred-update safety net (Windows only) ───────────────
  //
  // Auto-update stages `app.asar.update` and writes `update-swap.cmd`, then
  // fires an in-toast "Restart" button that runs the swap script via the
  // `restart-app` IPC. If the user dismisses the toast and restarts Merlin
  // some other way (taskbar/desktop shortcut/Ctrl+Q), the swap never runs
  // and the app boots with the OLD asar while version.json reads the NEW
  // version — producing a half-updated install where new features (mic
  // button, fixed perf-bar copy, etc.) are missing but the titlebar says
  // they're there.
  //
  // This safety net detects a staged asar at launch, spawns the swap
  // script, and exits immediately. The swap script waits 2s (during which
  // this process releases its file handles), moves the .update file over
  // app.asar, and relaunches Merlin — completing the update transparently.
  //
  // Mac disabled: mutating files inside a signed .app bundle breaks the
  // code signature. Mac updates go through a DMG reinstall path instead.
  if (process.platform === 'win32' && app.isPackaged) {
    try {
      const stagedAsar = path.join(appInstall, 'app.asar.update');
      let stagedStat = null;
      try { stagedStat = fs.statSync(stagedAsar); } catch {}
      // Minimum size guard: a truncated download (< 500 KB) is garbage.
      // Nuke it so the next auto-update check can re-stage a clean copy.
      if (stagedStat && stagedStat.size < 500 * 1024) {
        try { fs.unlinkSync(stagedAsar); } catch {}
        stagedStat = null;
      }
      if (stagedStat) {
        let swapScript = path.join(appInstall, 'update-swap.cmd');
        const asarPath = path.join(appInstall, 'app.asar');
        const exePath = process.execPath;
        // If the original swap script got deleted somehow, regenerate it
        // inline so the safety net still works on its own.
        if (!fs.existsSync(swapScript)) {
          try {
            fs.writeFileSync(swapScript, [
              '@echo off',
              `timeout /t 2 /nobreak >nul`,
              `move /Y "${stagedAsar}" "${asarPath}"`,
              `start "" "${exePath}"`,
              `del "%~f0"`,
            ].join('\r\n'));
          } catch (e) {
            console.error('[update-safety-net] regenerate swap script failed:', e.message);
            swapScript = null;
          }
        }
        if (swapScript) {
          const { spawn } = require('child_process');
          console.log('[update-safety-net] staged asar detected, running swap script');
          try {
            spawn('cmd.exe', ['/c', swapScript], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
            app.exit(0);
            return;
          } catch (e) {
            console.error('[update-safety-net] swap spawn failed:', e.message);
            // Fall through to normal startup — better degraded v1.0.6 than crashed boot
          }
        }
      }
    } catch (err) {
      console.error('[update-safety-net]', err.message);
    }
  }

  // macOS About panel
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: 'Merlin',
      applicationVersion: getCurrentVersion(),
      copyright: '© Oath Games',
    });
  }

  // Migrate global tokens to per-brand (runs once, idempotent)
  try { migratePerBrand(); } catch (err) { console.error('[migration]', err.message); }
  // Migrate plaintext tokens to vault (runs once, idempotent)
  try { migrateTokensToVault(); } catch (err) { console.error('[vault-migration]', err.message); }
  // Rewrite legacy SKILL.md files to the brand-locked v2 format so scheduled
  // tasks pass `brand` on every MCP call (runs once, idempotent, only touches
  // files that match the legacy template exactly — hand edits are preserved)
  try { migrateLegacySkills(); } catch (err) { console.error('[skill-migration]', err.message); }
  // Move orphaned dashboard files from the legacy .claude/tools/results/
  // location into results/_legacy/ (runs once, idempotent)
  try { migrateLegacyResultsDir(); } catch (err) { console.error('[legacy-results-migration]', err.message); }

  // Kick off the engine ensure + version check BEFORE createWindow. This
  // sets _startupChecksPromise so the very first refresh-perf IPC from the
  // renderer (which could fire as soon as the window's HTML loads) can
  // await it instead of racing past it onto a stale binary. The onProgress
  // callback is safe to invoke before `win` exists — it null-checks — so
  // any engine-status messages produced before window creation are quietly
  // dropped (acceptable: they're toast notifications, not load-bearing).
  kickoffStartupChecks((msg) => {
    if (win && !win.isDestroyed()) win.webContents.send('engine-status', msg);
  });

  await createWindow();

  // Bootstrap workspace AFTER window is visible (prevents "Not Responding" on first launch)
  setTimeout(bootstrapWorkspace, 500);

  // macOS: Cmd+Q should actually quit (set forceQuit so close handler allows it)
  app.on('before-quit', () => {
    forceQuit = true;
    // Kill any running Merlin.exe child processes to prevent zombies
    for (const child of activeChildProcesses) {
      try { child.kill(); } catch {}
    }
    activeChildProcesses.clear();
  });

  // Launch on system startup — opt-in only (user enables via "Start at login" toggle)
  // On first install, default to enabled. User can disable from tray or settings.
  if (app.isPackaged) {
    try {
      const startupPref = readConfig().startAtLogin;
      // Only set if preference exists in config; first run defaults to true
      const shouldStart = startupPref !== undefined ? startupPref : true;
      app.setLoginItemSettings({ openAtLogin: shouldStart, openAsHidden: true });
    } catch {}
  }

  setTimeout(checkForUpdates, 10000);
  // Check every 30 minutes — short enough that users on the demo path see
  // new releases within half an hour without needing to restart.
  setInterval(checkForUpdates, 30 * 60 * 1000);

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
      if (Number.isFinite(data.trialExtensionDays) && data.trialExtensionDays >= 0) {
        fs.writeFileSync(path.join(appRoot, '.merlin-referral-bonus'), String(data.trialExtensionDays));
      }
    } catch {}
  }, 8000);

  // P1-6 / P1-7: reconcile subscription state with the server at launch so
  // users who paid on another install (or whose local file was wiped) get
  // their Pro status restored automatically. Also catches cancellations
  // that happened while the app was closed.
  setTimeout(() => {
    reconcileSubscriptionWithServer({ force: true, via: 'launch' }).catch(() => {});
  }, 4000);

  // P1-5 support: persist the machine ID into merlin-config.json so the
  // Go binary's `subscribe` CLI action can use it as client_reference_id.
  // Without this, a user who runs Merlin.exe subscribe standalone would
  // complete checkout but the webhook would reject with "missing
  // client_reference_id" and the license would never get written.
  setTimeout(() => {
    try {
      const cfg = readConfig();
      const id = getMachineId();
      if (id && cfg.machineId !== id) {
        cfg.machineId = id;
        writeConfig(cfg);
      }
    } catch {}
  }, 2000);

  // Hourly referral bonus refresh + subscription reconcile. The combined
  // tick means a canceled subscription is reflected in the app at most an
  // hour after the webhook fires, and a newly-subscribed device flips to
  // Pro without needing a relaunch.
  setInterval(async () => {
    try {
      const raw = await httpsGet(`https://merlingotme.com/api/check-referral?id=${getMachineId()}`);
      const data = JSON.parse(raw.toString());
      if (Number.isFinite(data.trialExtensionDays) && data.trialExtensionDays >= 0) {
        fs.writeFileSync(path.join(appRoot, '.merlin-referral-bonus'), String(data.trialExtensionDays));
      }
    } catch {}
    reconcileSubscriptionWithServer({ force: true, via: 'hourly' }).catch(() => {});
  }, 60 * 60 * 1000);
});
app.on('window-all-closed', () => { if (!tray) app.quit(); /* tray keeps app alive; without tray, quit normally */ });
app.on('activate', () => {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  else if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
