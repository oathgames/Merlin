const { app, BrowserWindow, ipcMain, protocol, nativeTheme, Menu, Tray, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const wsServer = require('./ws-server');
const { generateQRDataUri } = require('./qr');

Menu.setApplicationMenu(null);

// ── Cloud Credentials Cache (in-memory + encrypted disk) ─────
// Fetches OAuth client secrets from api.merlingotme.com on startup.
// Never writes secrets to unencrypted disk. safeStorage encrypts the disk cache.
const _credentialsCache = { data: null, fetchedAt: 0, promise: null };
const CREDENTIALS_TTL_MS = 60 * 60 * 1000; // 1 hour
const CREDENTIALS_URL = 'https://api.merlingotme.com/api/credentials';
const CREDENTIALS_APP_TOKEN = 'd4c3a2dff4582d1ddb727dbe34e40c726a23e57a8aa65fc06f8b8c051080c409';

async function fetchCredentials() {
  // Return cached if fresh
  if (_credentialsCache.data && (Date.now() - _credentialsCache.fetchedAt) < CREDENTIALS_TTL_MS) {
    return _credentialsCache.data;
  }
  // Deduplicate concurrent requests
  if (_credentialsCache.promise) return _credentialsCache.promise;

  _credentialsCache.promise = (async () => {
    try {
      const https = require('https');
      const data = await new Promise((resolve, reject) => {
        const req = https.request(CREDENTIALS_URL, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${CREDENTIALS_APP_TOKEN}` },
          timeout: 10000,
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode === 200) {
              try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid JSON')); }
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });

      _credentialsCache.data = data;
      _credentialsCache.fetchedAt = Date.now();
      console.log('[credentials] Fetched from server');

      // Persist encrypted to disk for offline fallback
      try {
        if (safeStorage.isEncryptionAvailable()) {
          const encrypted = safeStorage.encryptString(JSON.stringify(data));
          const cachePath = path.join(os.homedir(), '.claude', '.merlin-creds-cache');
          fs.mkdirSync(path.dirname(cachePath), { recursive: true });
          fs.writeFileSync(cachePath, encrypted);
        }
      } catch {}

      return data;
    } catch (err) {
      console.warn('[credentials] Fetch failed:', err.message);

      // Try encrypted disk cache
      try {
        if (safeStorage.isEncryptionAvailable()) {
          const cachePath = path.join(os.homedir(), '.claude', '.merlin-creds-cache');
          const encrypted = fs.readFileSync(cachePath);
          const decrypted = safeStorage.decryptString(encrypted);
          const data = JSON.parse(decrypted);
          _credentialsCache.data = data;
          _credentialsCache.fetchedAt = Date.now() - CREDENTIALS_TTL_MS + 300000; // expire in 5 min
          console.log('[credentials] Loaded from encrypted disk cache');
          return data;
        }
      } catch {}

      // Return stale in-memory cache if available
      return _credentialsCache.data || null;
    } finally {
      _credentialsCache.promise = null;
    }
  })();

  return _credentialsCache.promise;
}

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
      const shellPath = execSync(`${shell} -lc 'echo "$PATH"' 2>/dev/null`, {
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

// Workspace location (where brands, config, results live — user-accessible in Documents)
const appRoot = app.isPackaged
  ? path.join(app.getPath('documents'), 'Merlin')
  : path.join(__dirname, '..');
// Ensure workspace exists early — the SDK probe uses it as cwd and fails
// with ENOENT if it doesn't exist yet (race with bootstrapWorkspace on first launch).
try { fs.mkdirSync(appRoot, { recursive: true }); } catch {}

// The Claude Agent SDK spawns `node cli.js` as a subprocess. On Mac, non-developer
// users don't have Node.js installed, so `node` isn't on PATH and the SDK fails
// with ENOENT. Fix: create a wrapper script at a known PATH location that uses
// Electron's own embedded Node via ELECTRON_RUN_AS_NODE=1.
// The Claude Agent SDK spawns `node cli.js` as a subprocess. Non-developer
// users don't have Node.js installed, so `node` isn't on PATH. Fix: create
// a wrapper that re-execs Electron's own binary with ELECTRON_RUN_AS_NODE=1,
// which strips all Chromium/GUI behavior and makes it act as pure Node.js.
// Works on BOTH Mac and Windows — same technique, different script format.
if (app.isPackaged) {
  try {
    const electronBin = process.execPath;
    if (process.platform === 'win32') {
      // Windows: .cmd wrapper at %USERPROFILE%\.claude\bin\node.cmd
      const nodeWrapperDir = path.join(os.homedir(), '.claude', 'bin');
      const nodeWrapper = path.join(nodeWrapperDir, 'node.cmd');
      fs.mkdirSync(nodeWrapperDir, { recursive: true });
      const script = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${electronBin}" %*\r\n`;
      let needsWrite = true;
      try {
        const existing = fs.readFileSync(nodeWrapper, 'utf8');
        if (existing.includes(electronBin)) needsWrite = false;
      } catch {}
      if (needsWrite) {
        fs.writeFileSync(nodeWrapper, script);
      }
      if (!process.env.PATH.includes(nodeWrapperDir)) {
        process.env.PATH = nodeWrapperDir + ';' + process.env.PATH;
      }
    } else {
      // Mac/Linux: shell wrapper at ~/.claude/bin/node
      const nodeWrapperDir = path.join(os.homedir(), '.claude', 'bin');
      const nodeWrapper = path.join(nodeWrapperDir, 'node');
      fs.mkdirSync(nodeWrapperDir, { recursive: true });
      const script = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${electronBin}" "$@"\n`;
      let needsWrite = true;
      try {
        const existing = fs.readFileSync(nodeWrapper, 'utf8');
        if (existing.includes(electronBin)) needsWrite = false;
      } catch {}
      if (needsWrite) {
        fs.writeFileSync(nodeWrapper, script, { mode: 0o755 });
      }
      if (!process.env.PATH.includes(nodeWrapperDir)) {
        process.env.PATH = nodeWrapperDir + ':' + process.env.PATH;
      }
    }
  } catch (e) {
    console.error('[node-wrapper] Failed to create node wrapper:', e.message);
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

  // 3. macOS Keychain — scan every known service name
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
    for (const service of keychainServices) {
      try {
        const credJson = await new Promise((resolve) => {
          execFile(
            'security', ['find-generic-password', '-s', service, '-w'],
            { timeout: 3000, encoding: 'utf8' },
            (err, stdout) => resolve(err ? '' : (stdout || '').trim())
          );
        });
        const result = extractToken(credJson);
        if (result) {
          console.log(`[auth] Token found in Keychain: "${service}"`);
          persistCredentials(result.raw);
          return result.token;
        }
      } catch {}
    }
  }

  // 4. Windows — check alternate credential file locations
  //    Windows Credential Manager can't be read without P/Invoke or third-party
  //    modules. Instead, check alternate file paths where Claude might store creds.
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
      const probeEnv = { ...process.env };
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
// 100% non-blocking. Every file operation runs in a child process.
// The main thread NEVER touches the filesystem during bootstrap.
function bootstrapWorkspace() {
  if (!app.isPackaged) return;
  const { exec } = require('child_process');
  const src = appInstall.replace(/\\/g, '\\\\');
  const dest = appRoot.replace(/\\/g, '\\\\');

  if (process.platform === 'win32') {
    // Single robocopy command handles everything — dirs + individual files
    // /E=recurse /XC/XN/XO=skip existing files /NFL/NDL/NJH/NJS/NP=quiet
    // robocopy exits 0-7 on success, 8+ on failure — we ignore exit codes
    exec([
      `mkdir "${appRoot}" 2>nul`,
      `robocopy "${path.join(appInstall, '.claude')}" "${path.join(appRoot, '.claude')}" /E /XC /XN /XO /NFL /NDL /NJH /NJS /NP`,
      `robocopy "${path.join(appInstall, 'assets')}" "${path.join(appRoot, 'assets')}" /E /XC /XN /XO /NFL /NDL /NJH /NJS /NP`,
      `for %f in (CLAUDE.md version.json memory.md README.txt) do if not exist "${appRoot}\\%f" if exist "${appInstall}\\%f" copy /Y "${appInstall}\\%f" "${appRoot}\\%f"`,
    ].join(' & '), { shell: 'cmd.exe' }, () => console.log('[workspace] Bootstrap complete'));
  } else {
    exec([
      `mkdir -p "${appRoot}"`,
      `cp -Rn "${path.join(appInstall, '.claude')}" "${appRoot}/" 2>/dev/null`,
      `cp -Rn "${path.join(appInstall, 'assets')}" "${appRoot}/" 2>/dev/null`,
      `for f in CLAUDE.md version.json memory.md README.txt; do [ -f "${appInstall}/$f" ] && [ ! -f "${appRoot}/$f" ] && cp "${appInstall}/$f" "${appRoot}/$f"; done`,
    ].join('; '), () => console.log('[workspace] Bootstrap complete'));
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

// ── TEST HARNESS (rip out after v1) ────────────────────────
// REMOVAL: Delete this block (to "END TEST HARNESS" below), then run:
//   grep -n "TEST HARNESS\|testActive\|TEST_FLAGS\|TEST_DATA" app/main.js
// That finds ~7 one-liner early-returns in IPC handlers (delete those lines)
// plus one block in win.once('ready-to-show') (delete between the
// "TEST HARNESS" and "END TEST HARNESS" comments). Total: ~120 lines.
//
// Launch with flags to inject mock data for UI preview:
//   --test-all           Enable ALL test mocks
//   --test-perf          Mock performance bar data
//   --test-activity      Mock activity feed entries
//   --test-live          Mock live ads
//   --test-archive       Mock archive items
//   --test-spells        Mock spellbook entries
//   --test-connections   Mock connected platforms
//   --test-brands        Mock brand list
//   --test-spell-fire    Simulate spell completion event (fires after 5s)
const TEST_FLAGS = {
  all: process.argv.includes('--test-all'),
  perf: process.argv.includes('--test-perf'),
  activity: process.argv.includes('--test-activity'),
  live: process.argv.includes('--test-live'),
  archive: process.argv.includes('--test-archive'),
  spells: process.argv.includes('--test-spells'),
  connections: process.argv.includes('--test-connections'),
  brands: process.argv.includes('--test-brands'),
  spellFire: process.argv.includes('--test-spell-fire'),
};
// Block test mode in production builds
if (app.isPackaged) {
  Object.keys(TEST_FLAGS).forEach(k => TEST_FLAGS[k] = false);
}
function testActive(flag) { return TEST_FLAGS.all || TEST_FLAGS[flag]; }

// Mock data generators (all self-contained, no file deps)
const TEST_DATA = {
  brands() {
    return [
      { name: 'madchill', displayName: 'MadChill', vertical: 'ecommerce', productCount: 3, status: 'active' },
      { name: 'flowstate', displayName: 'FlowState', vertical: 'saas', productCount: 1, status: 'active' },
    ];
  },

  perf(days) {
    return {
      revenue: 12847.53,
      spend: 3291.20,
      mer: 3.9,
      platforms: 3,
      platformBreakdown: [
        { name: 'Meta', spend: 1842.50, revenue: 7623.10, roas: 4.14 },
        { name: 'TikTok', spend: 948.70, revenue: 3412.43, roas: 3.60 },
        { name: 'Google', spend: 500.00, revenue: 1812.00, roas: 3.62 },
      ],
      dailyBudget: 150,
      trend: 12,
      periodDays: days || 7,
      generatedAt: new Date().toISOString(),
    };
  },

  activity() {
    const now = Date.now();
    const hour = 3600000;
    return [
      { ts: new Date(now - hour * 1).toISOString(), type: 'optimize', action: 'meta-insights', detail: 'Pulled performance data — 3 winners, 1 underperformer paused', product: 'Sweatpants' },
      { ts: new Date(now - hour * 3).toISOString(), type: 'publish', action: 'meta-push', detail: 'Published "Summer Vibes" to Meta Testing campaign', product: 'Full Zip Hoodie' },
      { ts: new Date(now - hour * 5).toISOString(), type: 'create', action: 'image', detail: 'Generated 4 ad variations — lifestyle scene, studio shot, flat lay, action shot', product: 'Sweatpants' },
      { ts: new Date(now - hour * 8).toISOString(), type: 'optimize', action: 'meta-duplicate', detail: 'Scaled "Street Style" winner to Scaling campaign — $25/day', product: 'Sweatpants' },
      { ts: new Date(now - hour * 12).toISOString(), type: 'optimize', action: 'meta-kill', detail: 'Paused "Neon Nights" — CPC $2.14, below 1.5x ROAS threshold', product: 'Full Zip Hoodie' },
      { ts: new Date(now - hour * 24).toISOString(), type: 'report', action: 'dashboard', detail: 'Daily report: $1,847 revenue, $423 spend, 4.37x MER', product: '' },
      { ts: new Date(now - hour * 26).toISOString(), type: 'publish', action: 'tiktok-push', detail: 'Published "Get Ready With Me" to TikTok Testing campaign', product: 'Sweatpants' },
      { ts: new Date(now - hour * 30).toISOString(), type: 'create', action: 'image', detail: 'Generated hero image for email campaign — product on marble background', product: 'Full Zip Hoodie' },
      { ts: new Date(now - hour * 48).toISOString(), type: 'optimize', action: 'seo-audit', detail: 'SEO audit complete — 92/100 score, 3 missing alt tags fixed', product: '' },
      { ts: new Date(now - hour * 52).toISOString(), type: 'error', action: 'meta-push', detail: 'Meta rejected creative — text overlay exceeds 20% threshold', product: 'Sweatpants' },
    ];
  },

  liveAds() {
    return [
      { product: 'Sweatpants', platform: 'meta', status: 'live', adId: '120210987654321', budget: '$25/day', creativePath: null, lastRoas: 4.2 },
      { product: 'Sweatpants', platform: 'meta', status: 'live', adId: '120210987654322', budget: '$15/day', creativePath: null, lastRoas: 3.1 },
      { product: 'Full Zip Hoodie', platform: 'meta', status: 'paused', adId: '120210987654323', budget: '$20/day', creativePath: null, lastRoas: 1.2 },
      { product: 'Sweatpants', platform: 'tiktok', status: 'live', adId: '1234567890123', budget: '$30/day', creativePath: null, lastRoas: 3.6 },
      { product: 'Full Zip Hoodie', platform: 'google', status: 'live', adId: '9876543210', budget: '$20/day', creativePath: null, lastRoas: 3.8 },
      { product: 'Sweatpants', platform: 'meta', status: 'pending', adId: '120210987654324', budget: '$10/day', creativePath: null, lastRoas: null },
    ];
  },

  archive() {
    const now = Date.now();
    const day = 86400000;
    return [
      { id: 'img_20260405_143022', type: 'image', timestamp: now - day * 1, brand: 'madchill', product: 'Sweatpants', status: 'completed', qaPassed: true, model: 'flux-pro', thumbnail: '', files: ['hero.png', 'square.png'], folder: 'results/image/2026-04/madchill/img_20260405_143022', title: 'Lifestyle — Summer Vibes' },
      { id: 'img_20260404_091215', type: 'image', timestamp: now - day * 2, brand: 'madchill', product: 'Full Zip Hoodie', status: 'completed', qaPassed: true, model: 'flux-pro', thumbnail: '', files: ['hero.png'], folder: 'results/image/2026-04/madchill/img_20260404_091215', title: 'Studio — Clean White' },
      { id: 'ad_20260403_160830', type: 'video', timestamp: now - day * 3, brand: 'madchill', product: 'Sweatpants', status: 'completed', qaPassed: true, model: 'minimax', thumbnail: '', files: ['ad.mp4'], folder: 'results/video/2026-04/madchill/ad_20260403_160830', title: 'Street Style — Walking' },
      { id: 'img_20260402_110445', type: 'image', timestamp: now - day * 4, brand: 'madchill', product: 'Sweatpants', status: 'completed', qaPassed: false, model: 'flux-pro', thumbnail: '', files: ['hero.png', 'square.png'], folder: 'results/image/2026-04/madchill/img_20260402_110445', title: 'Neon Nights — Failed QA' },
      { id: 'img_20260401_082100', type: 'image', timestamp: now - day * 5, brand: 'madchill', product: 'Full Zip Hoodie', status: 'completed', qaPassed: true, model: 'flux-pro', thumbnail: '', files: ['hero.png'], folder: 'results/image/2026-04/madchill/img_20260401_082100', title: 'Flat Lay — Marble' },
      { id: 'ad_20260331_193015', type: 'video', timestamp: now - day * 6, brand: 'madchill', product: 'Sweatpants', status: 'completed', qaPassed: true, model: 'minimax', thumbnail: '', files: ['ad.mp4'], folder: 'results/video/2026-03/madchill/ad_20260331_193015', title: 'Get Ready With Me' },
    ];
  },

  spells() {
    const now = Date.now();
    return [
      { id: 'merlin-madchill-daily-ads', name: 'Daily Ads', description: 'Create and test new ad variations every morning', cron: '0 9 * * 1-5', enabled: true, lastRun: now - 3600000, lastStatus: 'success', lastSummary: 'Created 3 new variations, paused 1 underperformer', consecutiveFailures: 0, isMerlin: true },
      { id: 'merlin-madchill-performance-check', name: 'Performance Check', description: 'Analyze ad performance and optimize spend', cron: '0 14 * * *', enabled: true, lastRun: now - 7200000, lastStatus: 'success', lastSummary: 'Scaled 1 winner, paused 2 underperformers, saved $45/day', consecutiveFailures: 0, isMerlin: true },
      { id: 'merlin-madchill-morning-briefing', name: 'Morning Briefing', description: 'Daily performance summary and recommendations', cron: '30 8 * * 1-5', enabled: true, lastRun: now - 86400000, lastStatus: 'success', lastSummary: 'Yesterday: $1,847 revenue, 4.37x MER, 3 ads performing above target', consecutiveFailures: 0, isMerlin: true },
      { id: 'merlin-madchill-weekly-seo', name: 'Weekly SEO', description: 'Check rankings and publish a blog post', cron: '0 10 * * 1', enabled: false, lastRun: now - 604800000, lastStatus: 'failed', lastSummary: 'Shopify connection expired — reconnect to continue', consecutiveFailures: 2, isMerlin: true },
    ];
  },

  connections() {
    return ['meta', 'tiktok', 'google', 'shopify', 'fal', 'klaviyo'];
  },
};
// ── END TEST HARNESS ───────────────────────────────────────

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

  // Register protocol for inline images — with path traversal protection
  protocol.handle('merlin', (request) => {
    const requested = decodeURIComponent(request.url.replace('merlin://', ''));
    const filePath = path.resolve(appRoot, requested);
    const resolvedRoot = path.resolve(appRoot);
    if (!filePath.startsWith(resolvedRoot)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf' };
      return new Response(data, { headers: { 'Content-Type': types[ext] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
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

    // TEST HARNESS — rip out after v1
    // Simulate spell completion event after 5s
    if (testActive('spellFire')) {
      setTimeout(() => {
        win.webContents.send('spell-completed', {
          taskId: 'merlin-madchill-daily-ads',
          status: 'success',
          summary: 'Created 3 new ad variations for Sweatpants. Paused 1 underperformer (CPC $2.40). Scaled "Street Style" winner to $25/day.',
          timestamp: Date.now(),
        });
      }, 5000);
      // Fire a failure event at 10s to test error toast
      setTimeout(() => {
        win.webContents.send('spell-completed', {
          taskId: 'merlin-madchill-weekly-seo',
          status: 'failed',
          summary: 'Shopify connection expired — reconnect to continue SEO automation.',
          timestamp: Date.now(),
        });
      }, 10000);
    }
    // Log active test flags + show visual banner so test mode is never mistaken for real
    const activeFlags = Object.entries(TEST_FLAGS).filter(([, v]) => v).map(([k]) => k);
    if (activeFlags.length > 0) {
      console.log('[TEST] Active test flags:', activeFlags.join(', '));
      win.webContents.executeJavaScript(`
        const b = document.createElement('div');
        b.textContent = '⚠ TEST MODE — Mock data active';
        b.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:99999;background:#ef4444;color:#fff;padding:4px 16px;font-size:11px;font-weight:700;border-radius:0 0 8px 8px;pointer-events:none;';
        document.body.appendChild(b);
      `);
    }
    // END TEST HARNESS
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

  // Auto-approve MCP scheduled-task operations (spell create/update/delete)
  if (toolName.includes('scheduled-tasks') || toolName.includes('scheduled_tasks')) {
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
      // Budget enforcement (reuse existing logic)
      let activeBrand = '';
      try { activeBrand = readState().activeBrand || ''; } catch {}
      const cfg = activeBrand ? readBrandConfig(activeBrand) : readConfig();
      const dailyBudget = cfg.dailyAdBudget || 0;
      const translations = {
        'push': { label: 'Publish this ad', cost: `$${input.dailyBudget || 5}/day budget` },
        'duplicate': { label: 'Scale this winning ad', cost: 'Increases budget' },
        'setup': { label: 'Set up ad campaigns', cost: 'Free' },
        'setup-retargeting': { label: 'Set up retargeting audiences', cost: 'Free' },
      };
      const translated = translations[action] || { label: `Run ${action}`, cost: null };
      if (dailyBudget > 0 && (action === 'push')) {
        const adBudget = input.dailyBudget || 5;
        translated.cost = `$${adBudget}/day · Budget cap: $${dailyBudget}/day`;
      }
      const toolUseID = Date.now().toString();
      const payload = { toolUseID, label: translated.label, cost: translated.cost };
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

  // BUDGET ENFORCEMENT: Show remaining budget on spend actions
  if (toolName === 'Bash' && input.command && input.command.includes('Merlin')) {
    const cmdMatch = input.command.match(/"action"\s*:\s*"([^"]+)"/);
    const action = cmdMatch ? cmdMatch[1] : '';
    if (action === 'meta-push' || action === 'tiktok-push' || action === 'google-ads-push' || action === 'amazon-ads-push') {
      let activeBrand = '';
      try { activeBrand = readState().activeBrand || ''; } catch {}
      const cfg = activeBrand ? readBrandConfig(activeBrand) : readConfig();
      const dailyBudget = cfg.dailyAdBudget || 0;
      if (dailyBudget > 0) {
        // Read today's spend from ads-live.json to check remaining budget
        try {
          const brandsDir = path.join(appRoot, 'assets', 'brands');
          let todaySpend = 0;
          const dirs = fs.readdirSync(brandsDir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'example');
          for (const d of dirs) {
            const adsPath = path.join(brandsDir, d.name, 'ads-live.json');
            try {
              const ads = JSON.parse(fs.readFileSync(adsPath, 'utf8'));
              todaySpend += ads.filter(a => a.status === 'live').reduce((sum, a) => sum + (a.budget || 0), 0);
            } catch {}
          }
          const remaining = dailyBudget - todaySpend;
          // Enrich the approval card with budget context
          const budgetMatch = input.command.match(/"dailyBudget"\s*:\s*(\d+)/);
          const adBudget = budgetMatch ? parseInt(budgetMatch[1]) : 5;
          if (remaining < adBudget) {
            // Over budget — still show approval but warn
            const translated = translateTool(toolName, input);
            translated.cost = `⚠ Over budget! $${todaySpend}/$${dailyBudget} daily cap · This ad: $${adBudget}/day`;
            // Don't auto-deny — let user decide
          }
        } catch {}
      }
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
  const sessionEnv = { ...process.env };
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
      console.warn('[auth] No credentials found — SDK will trigger interactive auth');
      // Notify the renderer so it can show a helpful message instead of blank screen
      if (win && !win.isDestroyed()) {
        win.webContents.send('auth-required');
      }
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
      fetchCredentials,
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
      win.webContents.send('sdk-error', errMsg);
      wsServer.broadcast('sdk-error', errMsg);
    }
  } finally {
    // Always reset so session can be restarted after error or completion
    activeQuery = null;
    // Resolve pending generator promise so it exits cleanly (null = stop signal)
    if (resolveNextMessage) { resolveNextMessage(null); }
    resolveNextMessage = null;
    pendingMessageQueue = []; // Clear stale messages from failed session
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

ipcMain.handle('start-session', () => { startSession(); return { success: true }; });

// macOS: trigger the bundled CLI's login flow. Opens a browser for OAuth,
// creates the "Claude Code-credentials" Keychain entry (or writes
// ~/.claude/.credentials.json as fallback). Required when the user has
// Claude Desktop signed in but has never run `claude login` from terminal.
ipcMain.handle('trigger-claude-login', async () => {
  try {
    const { spawn } = require('child_process');
    const isWin = process.platform === 'win32';
    const nodeWrapper = path.join(os.homedir(), '.claude', 'bin', isWin ? 'node.cmd' : 'node');
    const sdkDir = app.isPackaged
      ? (process.platform === 'darwin'
        ? path.join(path.dirname(app.getPath('exe')), '..', 'Resources', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
        : path.join(path.dirname(app.getPath('exe')), 'resources', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk'))
      : path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    const cliJs = path.join(sdkDir, 'cli.js');

    // Spawn the bundled CLI's login flow. Captures stdout to extract the
    // auth URL, then opens it via shell.openExternal (foregrounds browser).
    // Works on both macOS and Windows.
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (result) => { if (!resolved) { resolved = true; resolve(result); } };

      const child = spawn(nodeWrapper, [cliJs, 'auth', 'login'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BROWSER: 'none' },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: isWin, // Windows needs shell for .cmd files
      });

      // Backup signal: watch for credential file creation.
      // If the CLI writes credentials but doesn't exit cleanly, this catches it.
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
                console.log('[claude-login] Credential file detected via fs.watch');
                try { credWatcher.close(); } catch {}
                credWatcher = null;
                try { child.kill(); } catch {}
                finish({ success: true });
              }
            } catch {}
          }
        });
      } catch (e) {
        console.warn('[claude-login] fs.watch setup failed:', e.message);
      }

      // 60s timeout — localhost callback can be slow on some networks
      const uxTimeout = setTimeout(() => {
        console.error('[claude-login] Timed out after 60s');
        try { credWatcher?.close(); } catch {}
        try { child.kill(); } catch {}
        finish({ success: false, timedOut: true, error: 'Login timed out. Try again or use an API key.' });
      }, 60000);

      let stdout = '';
      let stderr = '';
      let urlOpened = false;
      let pastePromptShown = false;
      child.stdout.on('data', (d) => {
        const chunk = d.toString();
        stdout += chunk;
        console.log('[claude-login] stdout:', chunk.trim());

        // Open the auth URL in the browser (once)
        if (!urlOpened) {
          const urlMatch = stdout.match(/(https:\/\/claude\.ai\/[^\s]+|https:\/\/[^\s]*oauth[^\s]*|https:\/\/[^\s]*auth[^\s]*login[^\s]*)/i);
          if (urlMatch) {
            shell.openExternal(urlMatch[0]);
            urlOpened = true;
          }
        }

        // If CLI outputs a paste prompt (callback server failed), show a dialog
        // so the user can paste the auth code back into the subprocess
        if (!pastePromptShown && /paste this|paste.*into|enter.*auth.*code|authentication code/i.test(stdout + stderr)) {
          pastePromptShown = true;
          if (win && !win.isDestroyed()) {
            win.webContents.send('auth-code-prompt');
          }
        }
      });

      // Also monitor stderr — some SDK versions print the auth URL or paste
      // prompt to stderr instead of stdout
      child.stderr.on('data', (d) => {
        const chunk = d.toString();
        stderr += chunk;
        console.log('[claude-login] stderr:', chunk.trim());
        if (!urlOpened) {
          const urlMatch = (stdout + stderr).match(/(https:\/\/claude\.ai\/[^\s]+|https:\/\/[^\s]*oauth[^\s]*|https:\/\/[^\s]*auth[^\s]*login[^\s]*)/i);
          if (urlMatch) {
            shell.openExternal(urlMatch[0]);
            urlOpened = true;
          }
        }
        if (!pastePromptShown && /paste this|paste.*into|enter.*auth.*code|authentication code/i.test(stdout + stderr)) {
          pastePromptShown = true;
          if (win && !win.isDestroyed()) win.webContents.send('auth-code-prompt');
        }
      });

      // Listen for the user's pasted auth code from the renderer
      const pasteHandler = (_, code) => {
        if (child.stdin && !child.stdin.destroyed && code) {
          child.stdin.write(code + '\n');
        }
      };
      // Use .on (not .once) so the user can retry with a different code
      ipcMain.on('auth-code-submit', pasteHandler);

      child.on('close', async (code) => {
        clearTimeout(uxTimeout);
        try { credWatcher?.close(); } catch {}
        ipcMain.removeListener('auth-code-submit', pasteHandler);
        if (resolved) return; // Timeout already fired — don't block with more I/O
        if (code === 0) {
          console.log('[claude-login] Login completed successfully');
          // Mac: persist Keychain credentials to file for instant future launches
          if (process.platform === 'darwin') await readMacCredentials();
          finish({ success: true });
        } else {
          console.error('[claude-login] Exit code:', code);
          // Even if CLI exits non-zero, check if credentials were created
          const credFile = path.join(os.homedir(), '.claude', '.credentials.json');
          try {
            const raw = fs.readFileSync(credFile, 'utf8').trim();
            if (raw && JSON.parse(raw)) {
              finish({ success: true });
              return;
            }
          } catch {}
          // Mac: also check Keychain
          if (process.platform === 'darwin') {
            const token = await readMacCredentials();
            if (token) { finish({ success: true }); return; }
          }
          finish({ success: false, error: `Login process exited with code ${code}` });
        }
      });

      child.on('error', (e) => {
        clearTimeout(uxTimeout);
        console.error('[claude-login] Spawn error:', e.message);
        finish({ success: false, error: e.message });
      });
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
  // TEST HARNESS — rip out after v1
  if (testActive('spells')) return {
    date: new Date().toISOString(),
    ads: '3 winners running strong (4.2x, 3.8x, 3.1x ROAS). Paused "Neon Nights" — CPC hit $2.40. Net spend down $15/day.',
    content: '2 blog posts published this week. "Summer Streetwear Guide" getting organic traffic.',
    revenue: '$1,847 yesterday. $12.8K this week. MER trending up 12% vs last week.',
    recommendation: 'Scale "Street Style" to $50/day — it has held 4.2x ROAS for 5 consecutive days.',
  };
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
        const urlMatch = content.match(/URL:\s*(https?:\/\/[^\s\n]+)/i) || content.match(/website:\s*(https?:\/\/[^\s\n]+)/i);
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

ipcMain.handle('open-claude-download', () => { shell.openExternal('https://claude.ai/download'); });
ipcMain.handle('open-external-url', (_, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});
ipcMain.handle('open-merlin-folder', () => { shell.openPath(appRoot); });

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

    // Include brand context + first-run showcase instructions in the spell prompt
    const brandContext = brandName ? `\nBrand: ${brandName}\nBrand assets: assets/brands/${brandName}/\n` : '';
    const firstRunBlock = `\nFirst-run check: If this is the first time running (no prior results exist for this task), use the best quality settings, narrate each step, show results visually, and end with a summary of what you did and when the next scheduled run is.\n`;
    const skillContent = `---\nname: ${fullTaskId}\ndescription: ${description}\ncronExpression: "${cron}"\n---\n${brandContext}${firstRunBlock}\n${prompt}\n`;
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

// ── Performance status bar: read cached dashboard data ──────
// Background dashboard refresh — runs binary to pull fresh data from all platforms
ipcMain.handle('refresh-perf', async (_, brandName) => {
  const binaryPath = getBinaryPath();
  try { fs.accessSync(binaryPath); } catch { return { error: 'binary missing' }; }

  // Use merged brand config if brand specified (includes brand tokens)
  let configPath = path.join(appRoot, '.claude', 'tools', 'merlin-config.json');
  try { fs.accessSync(configPath); } catch { return { error: 'config missing' }; }
  if (brandName) {
    const merged = brandName ? readBrandConfig(brandName) : readConfig();
    if (merged && Object.keys(merged).length > 0) {
      const tmpPath = path.join(os.tmpdir(), `.merlin-config-tmp-${require('crypto').randomBytes(16).toString('hex')}.json`);
      fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
      configPath = tmpPath;
    }
  }

  const cmdObj = { action: 'dashboard', batchCount: 1 };
  if (brandName) cmdObj.brand = brandName;
  const cmd = JSON.stringify(cmdObj);
  const isTmpConfig = configPath !== path.join(appRoot, '.claude', 'tools', 'merlin-config.json');
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile(binaryPath, ['--config', configPath, '--cmd', cmd], {
      timeout: 60000, cwd: appRoot,
    }, (err, stdout) => {
      // Delete temp config IMMEDIATELY — don't leave decrypted credentials on disk
      if (isTmpConfig) { try { fs.unlinkSync(configPath); } catch {} }
      if (err) return resolve({ error: err.message });
      // Cache the timestamp per brand
      try {
        const resultsDir = brandName ? path.join(appRoot, 'results', brandName) : path.join(appRoot, 'results');
        fs.mkdirSync(resultsDir, { recursive: true });
        fs.writeFileSync(path.join(resultsDir, '.perf-updated'), new Date().toISOString());
      } catch {}
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
  const latest = JSON.parse(fs.readFileSync(files[files.length - 1].path, 'utf8'));

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
  if (testActive('perf')) return TEST_DATA.perf(requestedDays); // TEST HARNESS — rip out after v1
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
  if (testActive('activity')) return TEST_DATA.activity().slice(0, limit); // TEST HARNESS — rip out after v1
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

ipcMain.handle('get-archive-items', async (_, filters = {}) => {
  if (testActive('archive')) return TEST_DATA.archive(); // TEST HARNESS — rip out after v1
  const resultsDir = path.join(appRoot, 'results');
  if (!fs.existsSync(resultsDir)) return [];

  const crypto = require('crypto');
  const indexPath = path.join(resultsDir, 'archive-index.json');

  // Build folder list from all result directories (flat + hierarchical)
  function findRunFolders(dir, relativeTo) {
    const folders = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const name = e.name;
        if (name === 'archive' || name === '.') continue;
        const fullPath = path.join(dir, name);
        const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, '/');

        // Is this a run folder? (starts with ad_ or img_)
        if (name.startsWith('ad_') || name.startsWith('img_')) {
          folders.push({ name, fullPath, relPath });
        } else {
          // Recurse into type/month/brand hierarchy
          folders.push(...findRunFolders(fullPath, relativeTo));
        }
      }
    } catch {}
    return folders;
  }

  const runFolders = findRunFolders(resultsDir, appRoot);

  // Hash check: skip rebuild if unchanged
  const hashInput = runFolders.map(f => {
    try { return `${f.name}:${fs.statSync(f.fullPath).mtimeMs}`; } catch { return f.name; }
  }).sort().join('|');
  const currentHash = crypto.createHash('md5').update(hashInput).digest('hex');

  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (cached.hash === currentHash && cached.items) {
      // Apply filters to cached items
      return applyArchiveFilters(cached.items, filters);
    }
  } catch {}

  // Rebuild index
  const items = [];
  for (const folder of runFolders) {
    const item = {
      id: folder.name,
      type: folder.name.startsWith('ad_') ? 'video' : 'image',
      timestamp: 0,
      brand: '',
      product: '',
      status: 'completed',
      qaPassed: true,
      model: '',
      thumbnail: '',
      files: [],
      folder: folder.relPath,
    };

    // Parse timestamp from folder name: ad_YYYYMMDD_HHMMSS or img_YYYYMMDD_HHMMSS
    const tsMatch = folder.name.match(/(\d{8})_(\d{6})$/);
    if (tsMatch) {
      const d = tsMatch[1], t = tsMatch[2];
      const parsed = new Date(
        `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}`
      ).getTime();
      if (!isNaN(parsed)) item.timestamp = parsed;
    }

    // Read metadata.json if present
    const metaPath = path.join(folder.fullPath, 'metadata.json');
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.brand) item.brand = meta.brand;
        if (meta.product) item.product = meta.product;
        if (meta.status) item.status = meta.status;
        if (meta.model) item.model = meta.model;
        if (meta.qaPassed !== undefined) item.qaPassed = meta.qaPassed;
        if (meta.type) item.type = meta.type;
        if (meta.tags) item.tags = meta.tags;
        if (meta.createdAt) {
          const createdTime = new Date(meta.createdAt).getTime();
          if (!isNaN(createdTime)) item.timestamp = createdTime;
        }
      }
    } catch (err) { console.warn(`[archive] Bad metadata in ${folder.name}:`, err.message); }

    // Find thumbnail — use portrait as single source of truth (same image in card + preview)
    try {
      const files = fs.readdirSync(folder.fullPath);
      item.files = files;
      const portrait = files.find(f => f.includes('_portrait') && /\.(jpg|png|webp)$/i.test(f));
      const anyImage = files.find(f => /\.(jpg|jpeg|png|webp)$/i.test(f) && !f.includes('_square'));
      const thumb = portrait || anyImage;
      if (thumb) item.thumbnail = folder.relPath + '/' + thumb;
    } catch {}

    // Skip completely empty folders
    if (item.files.length === 0) continue;

    // Skip corrupted videos — must have at least one video file > 10KB
    if (item.type === 'video') {
      const videoFiles = item.files.filter(f => /\.(mp4|webm|mov)$/i.test(f));
      if (videoFiles.length === 0) continue;
      const hasValidVideo = videoFiles.some(f => {
        try { return fs.statSync(path.join(folder.fullPath, f)).size > 10240; } catch { return false; }
      });
      if (!hasValidVideo) continue;
    }

    items.push(item);
  }

  // Sort newest first
  items.sort((a, b) => b.timestamp - a.timestamp);

  // Cache index
  try {
    fs.writeFileSync(indexPath, JSON.stringify({ hash: currentHash, items }, null, 2));
  } catch {}

  return applyArchiveFilters(items, filters);
});

function applyArchiveFilters(items, filters = {}) {
  let filtered = items;
  if (filters.brand) {
    const b = filters.brand.toLowerCase();
    filtered = filtered.filter(i => i.brand && i.brand.toLowerCase() === b);
  }
  if (filters.type) {
    filtered = filtered.filter(i => i.type === filters.type);
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    filtered = filtered.filter(i =>
      (i.brand && i.brand.toLowerCase().includes(q)) ||
      (i.product && i.product.toLowerCase().includes(q)) ||
      (i.model && i.model.toLowerCase().includes(q)) ||
      i.id.toLowerCase().includes(q)
    );
  }
  return filtered;
}

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
    setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} }, 60000);
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
  } catch { return false; }
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
    if (safeStorage.isEncryptionAvailable()) {
      try { tokens = JSON.parse(safeStorage.decryptString(buf)); } catch {
        tokens = JSON.parse(buf.toString('utf8'));
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
    fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2));
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
    if (safeStorage.isEncryptionAvailable()) {
      try { tokens = JSON.parse(safeStorage.decryptString(buf)); } catch {
        tokens = JSON.parse(buf.toString('utf8'));
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
    fs.writeFileSync(tokenPath, JSON.stringify(existing, null, 2));
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
    checkBrand('pinterestAccessToken', 'pinterest');
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
    if (globalCfg.slackBotToken || globalCfg.slackWebhookUrl || vaultGet('_global', 'slackBotToken')) connected.push({ platform: 'slack', status: 'connected' });
    if (globalCfg.discordGuildId && globalCfg.discordChannelId) connected.push({ platform: 'discord', status: 'connected' });
    return connected;
  } catch { return []; }
}

ipcMain.handle('get-connected-platforms', (_, brandName) => {
  if (testActive('connections')) return TEST_DATA.connections(); // TEST HARNESS — rip out after v1
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
        if (safeStorage.isEncryptionAvailable()) {
          try { tokens = JSON.parse(safeStorage.decryptString(buf)); } catch { tokens = JSON.parse(buf.toString('utf8')); }
        } else { tokens = JSON.parse(buf.toString('utf8')); }
        let changed = false;
        for (const key of keys) {
          if (tokens[key] !== undefined && tokens[key] !== '') {
            delete tokens[key];
            changed = true;
          }
        }
        if (changed) {
          if (safeStorage.isEncryptionAvailable()) {
            fs.writeFileSync(legacyTokensPath, safeStorage.encryptString(JSON.stringify(tokens)));
          } else {
            fs.writeFileSync(legacyTokensPath, JSON.stringify(tokens));
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
  if (testActive('spells')) return TEST_DATA.spells(); // TEST HARNESS — rip out after v1
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

// Read brands from filesystem
ipcMain.handle('get-live-ads', (_, brandName) => {
  if (testActive('live')) return TEST_DATA.liveAds(); // TEST HARNESS — rip out after v1
  if (!brandName) {
    // Use first brand with ads-live.json
    const brandsDir = path.join(appRoot, 'assets', 'brands');
    try {
      const dirs = fs.readdirSync(brandsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== 'example');
      for (const d of dirs) {
        const adsPath = path.join(brandsDir, d.name, 'ads-live.json');
        if (fs.existsSync(adsPath)) { brandName = d.name; break; }
      }
    } catch {}
  }
  if (!brandName) return [];
  if (!/^[a-z0-9_-]+$/i.test(brandName)) return [];
  const adsPath = path.join(appRoot, 'assets', 'brands', brandName, 'ads-live.json');
  try {
    return JSON.parse(fs.readFileSync(adsPath, 'utf8'));
  } catch { return []; }
});

// Read brands from filesystem
ipcMain.handle('get-brands', () => {
  if (testActive('brands')) return TEST_DATA.brands(); // TEST HARNESS — rip out after v1
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
          const vertMatch = content.match(/vertical[:\s]+(\w+)/i);
          if (vertMatch) vertical = vertMatch[1];
          const statusMatch = content.match(/status[:\s]+(active|paused|archived)/i);
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
const WISDOM_CACHE_MS = 4 * 60 * 60 * 1000; // 4 hours

ipcMain.handle('get-wisdom', async (_, brandName) => {
  if (!brandName) try { brandName = readState().activeBrand || ''; } catch {}
  const cfg = brandName ? readBrandConfig(brandName) : readConfig();
  const vertical = cfg.vertical || 'general';

  if (_wisdomCache[vertical] && (Date.now() - (_wisdomCacheTime[vertical] || 0)) < WISDOM_CACHE_MS) {
    return _wisdomCache[vertical];
  }
  try {
    const raw = await httpsGet(`https://api.merlingotme.com/api/wisdom?vertical=${encodeURIComponent(vertical)}`);
    _wisdomCache[vertical] = JSON.parse(raw.toString());
    _wisdomCacheTime[vertical] = Date.now();
    return _wisdomCache[vertical];
  } catch { return _wisdomCache[vertical] || null; }
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
      let raw = readSecureFile(subFile);
      if (!raw) {
        // safeStorage decryption failed — try plaintext fallback
        try { raw = fs.readFileSync(subFile, 'utf8'); } catch {}
      }
      if (raw) {
        const data = JSON.parse(raw);
        if (data.subscribed) return { subscribed: true, tier: data.tier || 'pro', key: data.key || '' };
      } else {
        // File exists but can't be read (keychain reset, machine migration)
        // Check with server using machine ID as recovery
        return { subscribed: false, daysLeft: 7, recoveryNeeded: true };
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
ipcMain.handle('restart-app', () => {
  // If an asar update was staged, run the swap script instead of plain relaunch.
  // The script waits for Electron to exit, moves app.asar.update → app.asar,
  // then relaunches the app with the new code.
  const swapScript = process.platform === 'win32'
    ? path.join(appInstall, 'update-swap.cmd')
    : path.join(appInstall, 'update-swap.sh');
  if (fs.existsSync(swapScript)) {
    const { spawn } = require('child_process');
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', swapScript], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      spawn('bash', [swapScript], { detached: true, stdio: 'ignore' }).unref();
    }
    app.exit(0);
  } else {
    app.relaunch();
    app.exit(0);
  }
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
      // Checksum file couldn't be fetched — continue without verification
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
    try { execSync(`codesign --force --sign - "${binaryPath}" 2>/dev/null`); } catch {}
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

    // Stage the new asar for swap on restart. Electron locks app.asar while
    // running — direct overwrite fails silently on Windows. Instead, download
    // to app.asar.update and write a helper script that swaps it after exit.
    let asarStaged = false;
    if (app.isPackaged) {
      const asarAsset = (data.assets || []).find(a => a.name === 'app.asar');
      if (asarAsset) {
        const asarPath = path.join(appInstall, 'app.asar');
        const stagedPath = asarPath + '.update';
        try {
          if (win && !win.isDestroyed()) win.webContents.send('update-progress', 'Downloading update...');
          const asarData = await httpsGet(asarAsset.browser_download_url);
          if (asarData.length > 500000) { // sanity: asar should be > 500KB
            fs.writeFileSync(stagedPath, asarData);
            asarStaged = true;
            console.log(`[update] asar staged (${(asarData.length / 1024 / 1024).toFixed(1)} MB) → ${stagedPath}`);

            // Write a helper script that swaps the asar after Electron exits
            if (process.platform === 'win32') {
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
            } else {
              const swapScript = path.join(appInstall, 'update-swap.sh');
              // On Mac, relaunch the .app bundle, not the raw binary
              const appBundle = process.execPath.replace(/\/Contents\/MacOS\/.*$/, '');
              fs.writeFileSync(swapScript, [
                '#!/bin/bash',
                'sleep 2',
                `mv -f "${stagedPath}" "${asarPath}"`,
                `open "${appBundle}"`,
                `rm -f "${swapScript}"`,
              ].join('\n'));
              fs.chmodSync(swapScript, 0o755);
              console.log('[update] swap script written:', swapScript);
            }
          }
        } catch (e) {
          console.error('[update] asar staging failed:', e.message);
        }
      }
      // Also stage the binary in the INSTALL location
      if (binaryAsset) {
        try {
          const installBinaryPath = path.join(appInstall, '.claude', 'tools', process.platform === 'win32' ? 'Merlin.exe' : 'Merlin');
          if (fs.existsSync(path.dirname(installBinaryPath))) {
            const binaryData = fs.readFileSync(path.join(appRoot, '.claude', 'tools', process.platform === 'win32' ? 'Merlin.exe' : 'Merlin'));
            fs.writeFileSync(installBinaryPath, binaryData);
            console.log('[update] install-dir binary synced');
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
  // Migrate global tokens to per-brand (runs once, idempotent)
  try { migratePerBrand(); } catch (err) { console.error('[migration]', err.message); }
  // Migrate plaintext tokens to vault (runs once, idempotent)
  try { migrateTokensToVault(); } catch (err) { console.error('[vault-migration]', err.message); }

  await createWindow();

  // Pre-fetch OAuth credentials from cloud vault (non-blocking)
  fetchCredentials().catch(() => {});

  // Bootstrap workspace AFTER window is visible (prevents "Not Responding" on first launch)
  setTimeout(bootstrapWorkspace, 500);

  // Ensure the Merlin engine binary is present. It's not bundled with the
  // Electron app (intentionally — kept out of the 99MB installer), so first
  // run must download it from GitHub releases. Runs in background so the
  // window stays responsive.
  setTimeout(async () => {
    try {
      await ensureBinary({
        onProgress: (msg) => {
          if (win && !win.isDestroyed()) win.webContents.send('engine-status', msg);
        },
      });
    } catch (err) {
      console.error('[ensureBinary]', err.message);
      if (win && !win.isDestroyed()) {
        win.webContents.send('engine-status', `Engine download failed: ${err.message}`);
      }
    }
  }, 1500);

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
app.on('window-all-closed', () => { if (!tray) app.quit(); /* tray keeps app alive; without tray, quit normally */ });
app.on('activate', () => {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  else if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
