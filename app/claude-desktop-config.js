// Claude Desktop / MCP-client autoconfig.
//
// Detects Claude Desktop's config file, prompts the user once whether to
// register Merlin as an MCP server in it, and atomically merges the
// merlin entry while preserving any other mcpServers the user has
// configured (Cline, Cursor, etc. all share the same file shape).
//
// All filesystem I/O is wrapped: a missing config dir, a corrupt JSON
// file, or an unwritable disk all degrade gracefully — never crash the
// host app. The user's choice is persisted to <stateDir>/.mcp-claude-desktop-prompt
// so we don't pester them on every launch.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolve Claude Desktop's config file. Mirrors the official paths Anthropic
// publishes. We do NOT try to autodetect Codex / Cline / Cursor — each of
// those clients reads its own config file and this prompt is specifically
// for Claude Desktop. Users of other clients can copy the entry by hand
// from the docs (D:/autoCMO-claude/MCP-SIDECAR-SETUP.md).
function claudeDesktopConfigPath(platform) {
  const p = platform || process.platform;
  if (p === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  if (p === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

// Sentinel file recording the user's decision. Schema:
//   { decision: 'added' | 'skipped' | 'never', at: <epoch-ms> }
// `never` (Don't ask again) suppresses the prompt forever; `skipped`
// suppresses it for the current major version only (we re-prompt on
// minor bumps that ship sidecar improvements).
function decisionFile(stateDir) {
  return path.join(stateDir, '.mcp-claude-desktop-prompt');
}

function readDecision(stateDir) {
  try {
    const raw = fs.readFileSync(decisionFile(stateDir), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.decision === 'string') return obj;
  } catch {}
  return null;
}

function writeDecision(stateDir, decision) {
  const payload = JSON.stringify({ decision, at: Date.now(), schema: 1 }, null, 2);
  const target = decisionFile(stateDir);
  const tmp = target + '.tmp';
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(tmp, 0o600); } catch {}
    }
    fs.renameSync(tmp, target);
  } catch (e) {
    // Best effort — failure to persist the decision just means we
    // re-prompt next launch. Not fatal.
    return false;
  }
  return true;
}

// Read existing claude_desktop_config.json. Returns the parsed object on
// success, an empty object {} if the file doesn't exist, or null if the
// file exists but is unparseable (we refuse to clobber a corrupt config).
function readExistingConfig(configPath) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    if (e instanceof SyntaxError) return null; // unparseable — refuse to clobber
    return null;
  }
}

// Atomically write the merged config. Preserves any existing mcpServers
// entries (other tools the user has). Tmp + rename ensures Claude
// Desktop never reads a half-written file. Returns true on success.
function writeMergedConfig(configPath, mergedObj) {
  const dir = path.dirname(configPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const tmp = configPath + '.merlin-tmp-' + Date.now().toString(36);
  try {
    fs.writeFileSync(tmp, JSON.stringify(mergedObj, null, 2), { mode: 0o600 });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(tmp, 0o600); } catch {}
    }
    fs.renameSync(tmp, configPath);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

// Build the merlin mcpServers entry. The shim is launched via the
// bundled Node binary the desktop app already ships (see getBundledNodePath
// in main.js). In dev, we fall back to the system `node`.
function buildMerlinEntry({ nodePath, shimPath }) {
  return {
    command: nodePath,
    args: [shimPath],
  };
}

// Merge the merlin entry into an existing config. Pure function — no I/O.
//
// Behavior:
//   * If `mcpServers` is missing, create it.
//   * If `mcpServers.merlin` already exists with the SAME command + args,
//     this is a no-op — return { changed: false, config: existing }.
//   * If it exists with different values, OVERWRITE (we always want the
//     latest install path; users who renamed Merlin to a custom location
//     should remove the entry by hand).
//   * Other mcpServers entries (Cline, Cursor, etc.) are preserved
//     untouched — never deleted, never reordered.
function mergeMerlinEntry(existing, merlinEntry) {
  // Defensive copy so the caller's input is not mutated.
  const cfg = (existing && typeof existing === 'object') ? Object.assign({}, existing) : {};
  const mcpServers = (cfg.mcpServers && typeof cfg.mcpServers === 'object')
    ? Object.assign({}, cfg.mcpServers)
    : {};

  const current = mcpServers.merlin;
  const same = current
    && typeof current === 'object'
    && current.command === merlinEntry.command
    && Array.isArray(current.args)
    && Array.isArray(merlinEntry.args)
    && current.args.length === merlinEntry.args.length
    && current.args.every((v, i) => v === merlinEntry.args[i]);
  if (same) {
    return { changed: false, config: cfg };
  }
  mcpServers.merlin = merlinEntry;
  cfg.mcpServers = mcpServers;
  return { changed: true, config: cfg };
}

// Whether the prompt should fire. Decision rules:
//   1. If the user previously chose 'never' → don't ask.
//   2. If Claude Desktop's config dir doesn't exist → don't ask
//      (Claude Desktop probably isn't installed; an unsolicited
//      "Add Merlin to Claude Desktop?" prompt would confuse non-users).
//   3. If 'merlin' is already registered and matches the current command
//      + shim path → don't ask (already done; future versions can re-prompt
//      after a major bump if we ever want to).
//   4. If the user previously chose 'skipped' → re-ask only on a major
//      version bump. Caller passes the current major version; if the
//      stored decision was made on the same major, suppress.
//   5. Otherwise → fire the prompt.
//
// `currentMajor` is just the integer major (e.g. 1 for v1.20.0).
function shouldPrompt({ stateDir, configPath, merlinEntry, currentMajor }) {
  const decision = readDecision(stateDir);
  if (decision && decision.decision === 'never') return { fire: false, reason: 'user-chose-never' };

  // No config dir → Claude Desktop probably isn't installed.
  const configDir = path.dirname(configPath);
  let configDirExists = false;
  try { configDirExists = fs.statSync(configDir).isDirectory(); } catch { configDirExists = false; }
  if (!configDirExists) return { fire: false, reason: 'claude-desktop-not-installed' };

  // Already registered & matching?
  const existing = readExistingConfig(configPath);
  if (existing && typeof existing === 'object') {
    const existingMerlin = existing.mcpServers && existing.mcpServers.merlin;
    if (existingMerlin
        && existingMerlin.command === merlinEntry.command
        && Array.isArray(existingMerlin.args)
        && existingMerlin.args.length === merlinEntry.args.length
        && existingMerlin.args.every((v, i) => v === merlinEntry.args[i])) {
      return { fire: false, reason: 'already-registered' };
    }
  } else if (existing === null) {
    // Corrupt config — don't touch it without explicit user opt-in.
    return { fire: false, reason: 'config-unparseable' };
  }

  // Previously skipped on this major version?
  if (decision && decision.decision === 'skipped'
      && Number.isFinite(decision.major) && decision.major === currentMajor) {
    return { fire: false, reason: 'skipped-this-major' };
  }
  return { fire: true, reason: 'prompt-needed' };
}

// Combined "is the merlin entry currently registered & matching" — used
// by the magic-panel "Sidecar status" indicator. No prompt; just a
// truthy/falsy answer.
function isRegistered({ configPath, merlinEntry }) {
  const existing = readExistingConfig(configPath);
  if (!existing || typeof existing !== 'object') return false;
  const e = existing.mcpServers && existing.mcpServers.merlin;
  if (!e || typeof e !== 'object') return false;
  if (e.command !== merlinEntry.command) return false;
  if (!Array.isArray(e.args) || e.args.length !== merlinEntry.args.length) return false;
  return e.args.every((v, i) => v === merlinEntry.args[i]);
}

// Apply the registration: merge + atomic write + decision persist.
// Caller has already obtained user consent. Returns { ok, changed, error? }.
function applyRegistration({ stateDir, configPath, merlinEntry }) {
  const existing = readExistingConfig(configPath);
  if (existing === null) {
    return { ok: false, error: 'Claude Desktop config exists but is unparseable; refusing to overwrite. Remove or fix it manually.' };
  }
  const { changed, config } = mergeMerlinEntry(existing || {}, merlinEntry);
  if (!changed) {
    writeDecision(stateDir, 'added');
    return { ok: true, changed: false };
  }
  const wrote = writeMergedConfig(configPath, config);
  if (!wrote) {
    return { ok: false, error: 'Failed to write Claude Desktop config (permissions or disk error).' };
  }
  writeDecision(stateDir, 'added');
  return { ok: true, changed: true };
}

// Record a Skip / Don't-ask-again outcome.
function recordSkip(stateDir, currentMajor, never) {
  if (never) {
    writeDecision(stateDir, 'never');
    // Override base writeDecision to also store the major version.
    try {
      const target = decisionFile(stateDir);
      fs.writeFileSync(target, JSON.stringify({ decision: 'never', at: Date.now(), schema: 1 }, null, 2), { mode: 0o600 });
    } catch {}
    return;
  }
  // Same as writeDecision('skipped') but with a major-version stamp so
  // shouldPrompt can re-ask on the next major bump.
  try {
    const target = decisionFile(stateDir);
    fs.writeFileSync(target, JSON.stringify({ decision: 'skipped', major: currentMajor, at: Date.now(), schema: 1 }, null, 2), { mode: 0o600 });
  } catch {}
}

module.exports = {
  claudeDesktopConfigPath,
  decisionFile,
  readDecision,
  writeDecision,
  readExistingConfig,
  writeMergedConfig,
  buildMerlinEntry,
  mergeMerlinEntry,
  shouldPrompt,
  isRegistered,
  applyRegistration,
  recordSkip,
};
