#!/usr/bin/env node
// Merlin — PreToolUse guard for Bash / WebFetch / Edit / Write / Read.
//
// Runs before every matching tool call. Exits 2 (blocking) if Claude attempts
// to reach ad platform APIs directly, use raw sockets, run inline network code,
// or read/tamper with Merlin credential files.
//
// This is the FIRST line of defense. canUseTool in main.js is the second.
// Both must agree for a bypass to succeed; both fail-closed on error.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Banned hosts — direct access is never allowed ─────────────────────────
// Match as substring of a URL (with http/https prefix).
const BANNED_HOSTS = [
  'graph.facebook.com',
  'business.facebook.com',
  'business-api.tiktok.com',
  'open-api.tiktok.com',
  'open.tiktokapis.com',
  'ads-api.tiktok.com',
  'googleads.googleapis.com',
  'www.googleadservices.com',
  'advertising-api.amazon.com',
  'advertising-api-eu.amazon.com',
  'advertising-api-fe.amazon.com',
  'sellingpartnerapi-na.amazon.com',
  'sellingpartnerapi-eu.amazon.com',
  'sellingpartnerapi-fe.amazon.com',
  'a.klaviyo.com',
  'api.klaviyo.com',
  'adsapi.snapchat.com',
  'ads-api.pinterest.com',
  // Stripe — read-only reporting via the binary. Direct `curl api.stripe.com`
  // from Claude would bypass the binary's read-only enforcement (stripeGet)
  // and the rate-limit preflight. All Stripe access must go through the binary.
  'api.stripe.com',
  // Stripe OAuth authorize + token URLs. The binary opens authorize in the
  // user's browser and the BFF at merlingotme.com handles the token exchange —
  // Claude never needs to touch connect.stripe.com directly.
  'connect.stripe.com',
  // Foreplay — competitor ad intelligence. Routed through the binary so every
  // credit-burning call passes PreflightCheck + shows up in the audit log.
  // Direct curl/WebFetch would bypass the user's credit budget telemetry and
  // could leak the Bearer API key via shell history.
  'public.api.foreplay.co',
];

// Shopify Admin API is blocked but OAuth authorize URL stays allowed (user-facing).
const SHOPIFY_ADMIN_API = /\.myshopify\.com\/admin\/api/i;

// ── Allowlisted URLs (bypass banned-host checks) ──────────────────────────
// Short, specific. Used for updates + telemetry only.
const ALLOWED_URL_PREFIXES = [
  'https://github.com/oathgames/',
  'https://api.github.com/repos/oathgames/',
  'https://raw.githubusercontent.com/oathgames/',
  'https://merlingotme.com/',
  'https://www.merlingotme.com/',
  'https://api.merlingotme.com/',
];

// ── Raw socket tools ──────────────────────────────────────────────────────
const RAW_SOCKET_PATTERNS = [
  /\bnc\s+-/,
  /\bncat\b/,
  /\bsocat\b/,
  /\bopenssl\s+s_client\b/,
  /\btelnet\b/,
];

// ── Inline-script interpreters that can make network calls ───────────────
// REGRESSION GUARD (2026-04-16): `node -p` / `--print` executes arbitrary JS
// just like `-e` / `--eval` — it evaluates the expression and prints the
// result. Combined forms `-pe` / `-ep` are also accepted by Node. The
// previous list only caught `-e|--eval`, so `node -p "require('https').get(…)"`
// sailed through both INLINE_SCRIPT_PATTERNS and SCRIPT_FILE_PATTERNS
// (the latter explicitly excludes `-p`). Keep all four forms here.
const INLINE_SCRIPT_PATTERNS = [
  /\bnode\s+(-e|--eval|-p|--print|-pe|-ep)\b/,
  /\bpython3?\s+-c\b/,
  /\bruby\s+-e\b/,
  /\bperl\s+-e\b/,
  /\bdeno\s+eval\b/,
  /\bbun\s+(-e|--eval)\b/,
  // PowerShell — covers -c (command string), -Command, -EncodedCommand
  /\b(powershell|pwsh)\s+(-c|-Command|-[eE]nc)\b/,
];

// Script file execution — block `node file.js`, `python file.py` etc. when
// the script file contains banned hosts or network calls. Without this,
// Claude can Write a script then Run it to bypass inline-script checks.
const SCRIPT_FILE_PATTERNS = [
  /\bnode\s+(?!-e\b|--eval\b|--check\b|-p\b|--version\b)[^\s|&;]+\.(js|mjs|cjs)\b/,
  /\bpython3?\s+(?!-c\b|--version\b|-m\s+pip\b)[^\s|&;]+\.py\b/,
  /\bruby\s+(?!-e\b|--version\b)[^\s|&;]+\.rb\b/,
  /\bperl\s+(?!-e\b|--version\b)[^\s|&;]+\.pl\b/,
  /\bbun\s+(?!-e\b|--eval\b)[^\s|&;]+\.(js|ts)\b/,
  /\bdeno\s+run\b/,
];

// Tools that can make HTTP requests outside of curl/wget (Windows-specific).
// These are not in HTTP_FETCH_VERBS because they don't take URLs the same way.
const WINDOWS_HTTP_TOOLS = [
  /\bcertutil\s+-urlcache\b/i,
  /\bbitsadmin\s+\/transfer\b/i,
  /\bStart-BitsTransfer\b/i,
];

// Keywords inside inline scripts that indicate network intent.
const NETWORK_INTENT_KEYWORDS = [
  /require\(['"]https?['"]\)/,
  /require\(['"]net['"]\)/,
  /from\s+['"]https?['"]/,
  /\burllib\b/,
  /\brequests\b/,
  /\.fetch\(/,
  /\baxios\b/,
  /\bgot\(/,
  /\bhttp\.client\b/,
  /socket\.create_connection/,
  /\bnet\.connect\b/,
  /\bnet\.createConnection\b/,
  // PowerShell .NET HTTP classes — string concatenation can dodge hostname
  // matching but these class names reveal network intent unambiguously.
  /\bNet\.WebClient\b/i,
  /\bSystem\.Net\b/i,
  /\bWebRequest\b/i,
  /\bHttpClient\b/i,
  /\bInvoke-Expression\b/i,
  /\biex\s/i,
];

// ── Protected files — never readable/writable by Claude ──────────────────
// Two families: PATH patterns anchor to end-of-string (for file_path checks),
// COMMAND patterns match anywhere in a shell command (may be followed by
// pipes, redirects, args). Keeping them separate avoids the pipe bypass.
const PROTECTED_PATH_PATTERNS = [
  /merlin-config\.json$/i,
  /\.merlin-config-[a-z0-9_-]+\.json$/i,
  /\.merlin-tokens[a-z0-9_-]*$/i,
  /\.merlin-vault(\.|$)/i,
  /\.merlin-ratelimit(\.|$)/i,
  /\.merlin-audit(\.|$)/i,
  // Signed entitlement preflight cache (AES-GCM encrypted envelope over an
  // Ed25519-signed payload). Tampering is detected at load time by sig
  // verification, but unrestricted delete access would let a rogue tool
  // force a fresh network round-trip every invocation and degrade user
  // experience. `(\.|$)` covers the `.tmp` atomic-write sibling per Rule 7.
  /\.merlin-entitlement-cache(\.|$)/i,
  // Per-brand conversation history (role + text per bubble). Exfiltration
  // would leak every marketing decision, customer complaint, revenue
  // figure, and strategy discussion across every brand. Atomic-write
  // siblings (.bak/.tmp) covered by (\.|$) per Rule 7.
  /\.merlin-threads(\.|$)/i,
  /\.merlin-reddit-cache(\.|$)/i,
  // Desktop relay credentials — encrypted via safeStorage but contains the
  // session + desktop token that authenticate to the Cloudflare relay.
  // Exfiltration would let an attacker impersonate the desktop and receive
  // every message the PWA sends. Apply the same (\.|$) atomic-write guard
  // as the other blobs.
  /\.merlin-relay-creds(\.|$)/i,
  // Fact-binding HMAC session key (hex-on-disk) + signed envelope log. The
  // key file seeds every fact envelope's HMAC; the JSONL log carries the
  // signed envelopes the renderer verifies on ingest. Either one in wrong
  // hands = fact forgery for that session. `(\.|$)` covers .bak/.tmp
  // atomic-write siblings per Rule 7.
  /\.merlin-facts-key(\.|$)/i,
  /\.merlin-facts\.[a-z0-9_-]+\.jsonl(\.|$)/i,
  /\.rate-state(\.|$)/i,
  /\.rate-secret(\.|$)/i,
  // REGRESSION GUARD (2026-04-14, adversary loop 2):
  // These MUST use `(\.|$)` not `$` so they match .vault.bak, .vault.tmp,
  // .rate-state.tmp, etc. The `$` anchor was a bypass hole: vault.go:204
  // writes `%APPDATA%/Merlin/.vault.bak` during rekey, and that suffix was
  // NOT blocked — a rogue skill could `Read ~/Merlin/.vault.bak` and
  // exfiltrate an encrypted vault snapshot.
  //
  // DO NOT tighten these back to `$`. The trailing `.bak` / `.tmp` suffixes
  // are legitimate implementation details of atomic-write patterns and must
  // all be covered by the same blocklist rule.
  /[/\\]Merlin[/\\]\.vault(\.|$)/i,
  /[/\\]\.vault(\.|$)/i,
  /[/\\]\.rate-state\b/i,
  /[/\\]\.rate-secret\b/i,
  // MCP source files — redaction patterns must stay secret
  /mcp-server\.js$/i,
  /mcp-tools\.js$/i,
  /mcp-redact\.js$/i,
  // REGRESSION GUARD (2026-04-16): parity with the inline Read-hook
  // blocklist in .claude/settings.json. Without these, cat/grep of
  // app/main.js, app/preload.js, app/ws-server.js, etc. from Bash sails
  // through this hook (the settings.json inline regex catches Read/Edit
  // but not Bash). Leaking these files reveals the IPC surface, auth
  // handshake, and redaction patterns.
  /[/\\]app[/\\](main|renderer|preload|ws-server|relay-client|mcp-server|mcp-tools|mcp-redact|tts-worker)\.js$/i,
  // Claude Code's own OAuth credentials file. Combined with the broad
  // `Bash(cp *)` allow-list, an unprotected path would let an adversary
  // cp it elsewhere and then Read it.
  /[/\\]\.claude[/\\]\.credentials\.json$/i,
  // Grep directory check — block searching the entire tools directory
  // Matches both absolute (C:\...\tools) and relative (.claude/tools) paths
  /\.claude[/\\]tools\/?$/i,
];
const PROTECTED_COMMAND_PATTERNS = [
  /merlin-config\.json\b/i,
  /\.merlin-config-[a-z0-9_-]+\.json\b/i,
  /\.merlin-tokens[a-z0-9_-]*\b/i,
  /\.merlin-vault\b/i,
  /\.merlin-ratelimit\b/i,
  /\.merlin-audit\b/i,
  /\.merlin-facts-key\b/i,
  /\.merlin-facts\.[a-z0-9_-]+\.jsonl\b/i,
  /\.merlin-reddit-cache\b/i,
  /\.rate-state\b/i,
  /\.rate-secret\b/i,
  /\.merlin-[a-z]/i,                    // Catch-all: .merlin-api-key, .merlin-subscription, etc.
  // REGRESSION GUARD (2026-04-14, adversary loop 2): `\b` is a word boundary,
  // so `.vault\b` already catches `.vault`, `.vault.bak`, `.vault.tmp` via
  // the `.` char not being a word char. Kept explicit for readability.
  // Match the real vault file at %APPDATA%/Merlin/.vault (and .bak/.tmp siblings).
  /Merlin[/\\]\.vault\b/i,
  /AppData.*\.vault\b/i,
  /Application Support.*\.vault\b/i,
  /\.config[/\\]merlin[/\\]\.vault\b/i,
  // Protect framework files from mutation via cp/mv/rm
  /\.claude[/\\]hooks[/\\]/i,
  /\.claude[/\\]commands[/\\]/i,
  // REGRESSION GUARD (2026-04-18): .claude/skills/ ships routing SKILL.md
  // files that the Claude SDK loads at startup. A rogue write to a SKILL's
  // description field could re-route user intent (e.g. swap analytics for
  // ad-spend). Bash parity with the inline Read|Edit|Write hook — mutating
  // via `cp`/`mv`/`rm` must be blocked the same way as direct edits.
  /\.claude[/\\]skills[/\\]/i,
  /\.claude[/\\]settings\.json\b/i,
  // REGRESSION GUARD (2026-04-16): Bash parity with the settings.json
  // inline Read-hook blocklist. Blocks `cat app/ws-server.js`,
  // `grep <pat> app/preload.js`, `cp app/main.js /tmp/x`, etc.
  /[/\\]app[/\\](main|renderer|preload|ws-server|mcp-server|mcp-tools|mcp-redact|tts-worker)\.js\b/i,
  // Claude Code OAuth token file. Without this, `cp ~/.claude/.credentials.json /tmp/x`
  // (allowed by `Bash(cp *)`) followed by Read would exfiltrate the token.
  /[/\\]\.claude[/\\]\.credentials\.json\b/i,
];

// ── Audit log path ────────────────────────────────────────────────────────
function auditLogPath() {
  // The workspace root is the cwd where Claude was launched. Audit log lives
  // inside the workspace so it's visible to the user via the UI.
  return path.join(process.cwd(), '.claude', 'tools', '.merlin-audit.log');
}

const MAX_LOG_BYTES = 1024 * 1024; // 1 MB cap before rotation

function rotateIfNeeded(p) {
  try {
    const s = fs.statSync(p);
    if (s.size > MAX_LOG_BYTES) {
      fs.renameSync(p, p + '.1');
    }
  } catch {}
}

function redact(text) {
  if (!text) return '';
  const s = String(text);
  // Base64-ish tokens (>= 32 chars) → [TOKEN]
  let out = s.replace(/[A-Za-z0-9_\-+/]{32,}={0,2}/g, '[TOKEN]');
  // Bearer + access_token URL params
  out = out.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
  out = out.replace(/(access_token=)[^&\s"']+/gi, '$1[REDACTED]');
  return out.slice(0, 400);
}

function auditLog(reason, toolName, cmd) {
  try {
    const logPath = auditLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    rotateIfNeeded(logPath);
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      src: 'hook',
      event: 'deny',
      reason,
      tool: toolName,
      hash: crypto.createHash('sha256').update(cmd || '').digest('hex').slice(0, 16),
      sample: redact(cmd).slice(0, 200),
    }) + '\n';
    fs.appendFileSync(logPath, entry);
  } catch { /* best-effort; never throw from the hook */ }
}

// ── Check helpers ─────────────────────────────────────────────────────────
function isAllowlisted(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return ALLOWED_URL_PREFIXES.some(p => lower.includes(p.toLowerCase()));
}

// HTTP-fetching commands. If any of these appear in the command and the
// command ALSO contains a banned host substring (with or without protocol),
// it's a bypass attempt. Regex is case-insensitive.
const HTTP_FETCH_VERBS = /\b(curl|wget|http|httpie|xh|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i;

function findBannedHost(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  // Case 1: URL-like context — protocol prefix or scheme-relative.
  // Low false-positive risk; this catches any language's HTTP client.
  for (const host of BANNED_HOSTS) {
    if (
      lower.includes('://' + host) ||
      lower.includes('//' + host) ||
      lower.includes('"http://' + host) ||
      lower.includes('"https://' + host) ||
      lower.includes("'http://" + host) ||
      lower.includes("'https://" + host)
    ) {
      return host;
    }
  }

  // Case 2: HTTP-fetching verb present and bare host appears anywhere.
  // curl/wget default to http:// when no protocol is given, so
  // `curl graph.facebook.com/me` still hits Meta. Block it.
  if (HTTP_FETCH_VERBS.test(text)) {
    for (const host of BANNED_HOSTS) {
      if (lower.includes(host)) return host;
    }
  }

  if (SHOPIFY_ADMIN_API.test(text)) return '.myshopify.com/admin/api';
  return null;
}

function matchesRawSocket(cmd) {
  return RAW_SOCKET_PATTERNS.some(p => p.test(cmd));
}

function matchesInlineScriptWithNetwork(cmd) {
  const hasInlineInterp = INLINE_SCRIPT_PATTERNS.some(p => p.test(cmd));
  if (!hasInlineInterp) return false;
  // Scan the whole command for network intent keywords
  if (NETWORK_INTENT_KEYWORDS.some(p => p.test(cmd))) return true;
  // Also trip on banned hosts inline (raw or protocol)
  const bare = cmd.toLowerCase();
  for (const host of BANNED_HOSTS) {
    if (bare.includes(host)) return true;
  }
  return false;
}

function matchesProtectedFileCommand(cmd) {
  // File-touching verbs on protected paths. `ls` and `stat` are NOT here
  // because they only show metadata, not contents.
  const fileVerbs = /\b(cat|less|more|head|tail|type|Get-Content|Set-Content|grep|rg|ack|awk|sed|xxd|hexdump|od|strings|tee|cp|mv|rm|del|Remove-Item|Copy-Item|Move-Item)\b/;
  if (!fileVerbs.test(cmd)) return null;
  for (const pat of PROTECTED_COMMAND_PATTERNS) {
    if (pat.test(cmd)) return pat.source;
  }
  return null;
}

function matchesProtectedFilePath(filePath) {
  if (!filePath) return null;
  for (const pat of PROTECTED_PATH_PATTERNS) {
    if (pat.test(filePath)) return pat.source;
  }
  return null;
}

function block(reason, toolName, cmd) {
  auditLog(reason, toolName, cmd);
  process.stderr.write(
    'BLOCKED: ' + reason + '\n' +
    'Merlin enforces these guards to prevent platform bans from rate-limit violations. ' +
    'Use the Merlin binary (.claude/tools/Merlin.exe --cmd \'{"action":"..."}\') for any ad platform action — ' +
    'it handles credentials and rate limits internally.\n'
  );
  process.exit(2);
}

// Read the PreToolUse hook payload. Per the Claude Code / Agent SDK hook
// contract, payloads are delivered on stdin as a single JSON document of the
// form { session_id, tool_name, tool_input: {...}, ... }. Older / alternate
// harnesses sometimes populate TOOL_INPUT / TOOL_NAME env vars instead, so we
// prefer stdin and fall back to env only if stdin is empty / a TTY.
function readHookPayload() {
  let raw = '';
  try {
    if (!process.stdin.isTTY) {
      raw = fs.readFileSync(0, 'utf8');
    }
  } catch { /* fall through to env fallback */ }
  if (!raw) {
    const envRaw = process.env.TOOL_INPUT;
    if (envRaw) return { tool_input: JSON.parse(envRaw), tool_name: process.env.TOOL_NAME || '' };
    // No input at all — caller is not a real hook invocation.
    return null;
  }
  return JSON.parse(raw);
}

// ── Entry point ───────────────────────────────────────────────────────────
function main() {
  // REGRESSION GUARD (2026-04-16): fail CLOSED on missing or malformed hook
  // input. The prior version read `process.env.TOOL_INPUT || '{}'` and
  // `process.exit(0)` on parse failure, which was doubly fail-open: the SDK
  // delivers payloads on stdin (not env), so TOOL_INPUT was always unset,
  // `'{}'` parsed cleanly to {}, every matcher short-circuited on empty
  // strings, and every Bash/WebFetch/Edit/Write/Read call sailed through.
  // Two-part fix: (1) read stdin per the hook spec; (2) exit 2 on any
  // parse / empty-payload path so the outer try/catch's fail-closed promise
  // (line ~407) actually holds. If the harness ever changes, a hang here
  // is preferable to a silent allow.
  let payload;
  try {
    payload = readHookPayload();
  } catch (err) {
    process.stderr.write('block-api-bypass: malformed hook payload — failing closed: ' + (err && err.message || err) + '\n');
    process.exit(2);
  }
  if (!payload || typeof payload !== 'object') {
    process.stderr.write('block-api-bypass: no hook payload received — failing closed\n');
    process.exit(2);
  }

  // Claude Code hook spec wraps the tool args under `tool_input`. Older
  // harnesses put them at the top level — accept both.
  const input = (payload.tool_input && typeof payload.tool_input === 'object')
    ? payload.tool_input
    : payload;

  // Figure out which matcher fired this hook
  const toolName = payload.tool_name || process.env.TOOL_NAME || '';
  const cmd = input.command || '';
  const url = input.url || '';
  const filePath = input.file_path || '';

  // ── Read / Edit / Write tools ──────────────────────────────────────
  if (filePath) {
    const hit = matchesProtectedFilePath(filePath);
    if (hit) {
      block(
        'Protected Merlin credential file: ' + filePath,
        toolName,
        filePath
      );
    }
  }

  // ── WebFetch ───────────────────────────────────────────────────────
  if (url) {
    if (!isAllowlisted(url)) {
      const host = findBannedHost(url);
      if (host) {
        block('Direct WebFetch to ' + host + ' is not allowed', toolName, url);
      }
    }
  }

  // ── Bash ───────────────────────────────────────────────────────────
  if (cmd) {
    // Protected file access via shell verbs
    const fileHit = matchesProtectedFileCommand(cmd);
    if (fileHit) {
      block('Shell access to protected Merlin files is not allowed', toolName, cmd);
    }

    // Raw sockets
    if (matchesRawSocket(cmd)) {
      block('Raw socket tools (nc, socat, openssl s_client) are not allowed', toolName, cmd);
    }

    // Inline script with network intent (node -e, python -c, powershell -c, etc.)
    if (matchesInlineScriptWithNetwork(cmd)) {
      block('Inline scripts with network calls are not allowed', toolName, cmd);
    }

    // Script file execution (node file.js, python file.py, etc.)
    // This closes the write-then-run bypass: Claude writes a .js/.py with
    // HTTP calls, then runs `node malicious.js`. We block any interpreter
    // invocation with a script file unless it's a known safe pattern.
    if (SCRIPT_FILE_PATTERNS.some(p => p.test(cmd))) {
      block('Running script files is not allowed in Merlin sessions. Use the Merlin binary for all platform actions.', toolName, cmd);
    }

    // Windows-specific HTTP tools (certutil -urlcache, bitsadmin, etc.)
    if (WINDOWS_HTTP_TOOLS.some(p => p.test(cmd))) {
      block('Windows download tools (certutil, bitsadmin) are not allowed', toolName, cmd);
    }

    // Direct HTTP to banned hosts — only if not allowlisted
    if (!isAllowlisted(cmd)) {
      const host = findBannedHost(cmd);
      if (host) {
        block('Direct command access to ' + host + ' is not allowed', toolName, cmd);
      }
    }
  }

  // ── Grep tool — check the path argument ─────────────────────────
  // Grep is auto-approved and not covered by the Read matcher.
  // Check its `path` field against protected patterns.
  if (input.path) {
    const hit = matchesProtectedFilePath(input.path);
    if (hit) {
      block('Grep/search of protected Merlin credential file is not allowed', toolName, input.path);
    }
  }

  // Fall through: allow
  process.exit(0);
}

try {
  main();
} catch (err) {
  // Fail-closed on internal errors. The second defense (canUseTool in main.js)
  // catches most real attacks, so failing closed here is acceptable.
  process.stderr.write('block-api-bypass: internal error — failing closed: ' + (err && err.message || err) + '\n');
  process.exit(2);
}
