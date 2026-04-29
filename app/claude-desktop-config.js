// Claude Desktop / Claude Code MCP-client autoconfig.
//
// Two clients, two distinct file shapes — both atomic-merge-safe here.
//
// Claude Desktop:
//   * One file: claude_desktop_config.json (per-OS path).
//   * Single mcpServers map; entries auto-load on launch.
//   * No per-project trust model.
//
// Claude Code (the CLI / VS Code extension Ryan develops with):
//   * Two files involved per registration:
//       (a) ~/.claude.json — user-level, has a `projects` map keyed by
//           absolute project path. Each project entry carries
//           `enabledMcpjsonServers: string[]` (allowlist) and
//           `disabledMcpjsonServers: string[]` (denylist).
//       (b) <project>/.mcp.json — per-project, carries the actual
//           `mcpServers` map.
//   * Servers in <project>/.mcp.json are REGISTERED but not LOADED unless
//     their name appears in the project's `enabledMcpjsonServers` array.
//     This is the security model: a teammate checking in .mcp.json
//     cannot silently inject a server into your Claude Code session.
//   * Live incident anchor (2026-04-29): v1.20.0 wrote .mcp.json
//     correctly but never touched .claude.json — Ryan approved the
//     prompt, the entry registered, Claude Code refused to load it
//     because pog-shopify's enabledMcpjsonServers was [].
//
// All filesystem I/O is wrapped: a missing config dir, a corrupt JSON
// file, or an unwritable disk all degrade gracefully — never crash the
// host app. Atomic writes (tmp + rename) on every persistence path so
// a crash mid-write cannot corrupt either client's config. The user's
// choice is persisted to <stateDir>/.mcp-claude-desktop-prompt so we
// don't pester them on every launch.

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

// Resolve Claude Code's user-level config file. The CLI / VS Code
// extension stores its global state at ~/.claude.json on every OS —
// ANTHROPIC's source-of-truth path is platform-agnostic, unlike
// Claude Desktop which deliberately uses Application Support / APPDATA.
function claudeCodeConfigPath() {
  return path.join(os.homedir(), '.claude.json');
}

// Resolve a project's per-project Claude Code config (.mcp.json at the
// project root). The path passed in is the project root the user
// picked; this just normalises the trailing component.
function claudeCodeProjectMcpPath(projectRoot) {
  return path.join(projectRoot, '.mcp.json');
}

// Detect which MCP-host clients appear to be installed on this machine.
// Used by the autoprompt to choose between the Desktop-only / Code-only
// / both flows. We never try to connect to either client — we just
// check for the existence of their canonical config (Desktop) or
// presence of ~/.claude.json (Code). Detection is cheap and tolerant of
// missing files / permissions errors.
//
// Returns { desktop: bool, code: bool }.
function detectInstalledClients() {
  const out = { desktop: false, code: false };
  try {
    const desktopPath = claudeDesktopConfigPath();
    // Existence of the per-OS Claude config DIRECTORY (not the file)
    // signals Claude Desktop is installed even if the file hasn't been
    // written yet. claudeDesktopConfigPath()'s parent is that dir.
    out.desktop = fs.statSync(path.dirname(desktopPath)).isDirectory();
  } catch { /* not installed */ }
  try {
    // Claude Code installs/reuses ~/.claude.json on first launch. If
    // the file exists and is parseable JSON, the user has run it.
    const ccPath = claudeCodeConfigPath();
    const raw = fs.readFileSync(ccPath, 'utf8');
    if (raw && raw.trim()) {
      JSON.parse(raw); // validate; throws on corrupt
      out.code = true;
    }
  } catch { /* not installed or unparseable */ }
  return out;
}

// Resolve a user-supplied project root to the canonical key used in
// ~/.claude.json's `projects` map. We:
//   1. Reject non-strings, missing-directory, and not-a-directory cases.
//   2. fs.realpathSync to resolve symlinks — prevents double-registering
//      the same project under two key names if the user picks the link
//      one time and the real path another.
//   3. path.resolve to normalise (collapse `.`/`..`, ensure absolute).
// Returns { ok: true, key } or { ok: false, error }.
function resolveProjectKey(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
    return { ok: false, error: 'Project path is empty.' };
  }
  let st;
  try {
    st = fs.statSync(projectRoot);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: false, error: 'Project path does not exist: ' + projectRoot };
    }
    return { ok: false, error: 'Cannot access project path: ' + (e && e.message) };
  }
  if (!st.isDirectory()) {
    return { ok: false, error: 'Project path is not a directory: ' + projectRoot };
  }
  let real;
  try {
    real = fs.realpathSync(projectRoot);
  } catch (e) {
    // Best-effort fallback if realpath fails (Windows symlink quirks etc.)
    real = path.resolve(projectRoot);
  }
  return { ok: true, key: path.resolve(real) };
}

// Sentinel file listing every project the user has ever registered for
// Claude Code. Purely informational — used to populate the sidecar
// status panel and to default the directory picker to the
// most-recently-used project on subsequent launches. The actual
// allowlist enforcement lives in ~/.claude.json's
// projects[<key>].enabledMcpjsonServers, which we always write
// authoritatively; this sentinel is a read-side cache, never trusted
// as the source of truth.
function claudeCodeProjectsFile(stateDir) {
  return path.join(stateDir, '.mcp-claude-code-projects.json');
}

function readClaudeCodeProjects(stateDir) {
  try {
    const raw = fs.readFileSync(claudeCodeProjectsFile(stateDir), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.projects)) {
      // Filter to strings only — defensive against a corrupted sentinel.
      return obj.projects.filter((p) => typeof p === 'string' && p.length > 0);
    }
  } catch {}
  return [];
}

function writeClaudeCodeProjects(stateDir, projects) {
  const target = claudeCodeProjectsFile(stateDir);
  // Dedup + sort for stable on-disk shape.
  const seen = new Set();
  const cleaned = [];
  for (const p of projects) {
    if (typeof p !== 'string' || !p.length) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    cleaned.push(p);
  }
  cleaned.sort();
  const payload = JSON.stringify({ schema: 1, projects: cleaned }, null, 2);
  const tmp = target + '.tmp';
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(tmp, 0o600); } catch {}
    }
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

function rememberClaudeCodeProject(stateDir, projectKey) {
  const list = readClaudeCodeProjects(stateDir);
  if (!list.includes(projectKey)) list.push(projectKey);
  return writeClaudeCodeProjects(stateDir, list);
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

// Atomic write of a decision sentinel. `extra` is an optional object of
// additional fields to merge into the payload alongside `{decision, at,
// schema}` — used by the 'skipped' path to record the major version.
// Tmp + rename ensures crash-safety; mode 0o600 keeps the file
// owner-only on POSIX.
function writeDecision(stateDir, decision, extra) {
  const payload = JSON.stringify(
    Object.assign({ decision, at: Date.now(), schema: 1 }, extra || {}),
    null,
    2,
  );
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

// Merge the merlin entry into a .mcp.json (per-project Claude Code
// config). Same shape as Claude Desktop's mcpServers block, just at
// the file's top level. Pure function — no I/O.
//
// Behavior mirrors mergeMerlinEntry above:
//   * If `mcpServers` is missing, create it.
//   * Same merlin entry → no-op.
//   * Different merlin entry → overwrite (latest install path wins).
//   * Other servers (other-mcp, etc.) preserved untouched.
function mergeMcpJsonMerlinEntry(existing, merlinEntry) {
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

// Merge the merlin enablement into ~/.claude.json. Pure function — no I/O.
//
// Touches EXACTLY ONE FIELD: projects[<projectKey>].enabledMcpjsonServers.
// Every other field at every level is preserved verbatim — Claude Code's
// ~/.claude.json carries the user's settings, theme, history pointers,
// onboarding state, dozens of other fields. A clobbered ~/.claude.json
// would wipe the user's Claude Code state. The function:
//
//   1. Defensive-copies the top-level object.
//   2. Defensive-copies the projects map (creating it if missing).
//   3. Defensive-copies the per-project entry (creating it if missing).
//   4. Reads enabledMcpjsonServers as an array (defaulting to []).
//   5. Adds 'merlin' if absent (idempotent — present already → no-op).
//   6. Also REMOVES 'merlin' from disabledMcpjsonServers if present
//      there — Claude Code's denylist takes precedence over the
//      allowlist, so an unfinished prior session that Disabled merlin
//      must be cleared when the user explicitly re-enables.
//
// Returns { changed: bool, config: <updated-top-level> }. `changed` is
// false only when neither the enable-list nor the disable-list needed
// touching — caller skips the disk write in that case.
function mergeClaudeJsonEnable(existing, projectKey) {
  // Defensive DEEP copy of the entire input. JSON round-trip is the
  // simplest way to honor the "pure function — no I/O, never mutates
  // caller's input" contract at every level: top-level fields,
  // projects map, OTHER projects' entries (Gitar PR #163 review:
  // pre-fix shallow Object.assign on cfg.projects left other-project
  // entries as shared references with `existing`; not a live bug
  // because every caller serializes the result to JSON immediately,
  // but it weakened the docstring contract). ~/.claude.json is bounded
  // (single-user config, never holds binary or cyclic data) so the
  // round-trip cost is acceptable; Claude Code config files are
  // typically <50 KB.
  const cfg = (existing && typeof existing === 'object')
    ? JSON.parse(JSON.stringify(existing))
    : {};
  const projects = (cfg.projects && typeof cfg.projects === 'object')
    ? cfg.projects
    : {};
  cfg.projects = projects; // Ensure cfg.projects is set even if existing.projects was missing.
  const entry = (projects[projectKey] && typeof projects[projectKey] === 'object')
    ? projects[projectKey]
    : {};

  const enabled = Array.isArray(entry.enabledMcpjsonServers)
    ? entry.enabledMcpjsonServers.slice()
    : [];
  const disabled = Array.isArray(entry.disabledMcpjsonServers)
    ? entry.disabledMcpjsonServers.slice()
    : [];

  let changed = false;
  if (!enabled.includes('merlin')) {
    enabled.push('merlin');
    changed = true;
  }
  const wasDisabled = disabled.indexOf('merlin');
  if (wasDisabled !== -1) {
    disabled.splice(wasDisabled, 1);
    changed = true;
  }
  if (!changed) {
    return { changed: false, config: cfg };
  }

  entry.enabledMcpjsonServers = enabled;
  // Only write the disabled array back if it existed before OR we just
  // pruned it — never invent the field if Claude Code never wrote it.
  if (Array.isArray(existing && existing.projects && existing.projects[projectKey]
                    && existing.projects[projectKey].disabledMcpjsonServers)
      || wasDisabled !== -1) {
    entry.disabledMcpjsonServers = disabled;
  }
  projects[projectKey] = entry;
  cfg.projects = projects;
  return { changed: true, config: cfg };
}

// Whether the prompt should fire. Decision rules:
//   1. If the user previously chose 'never' → don't ask.
//   2. If NEITHER Claude Desktop NOR Claude Code is installed → don't
//      ask (no point prompting a user who has neither host; an
//      unsolicited "Add Merlin to Claude?" would confuse non-users).
//      Caller passes `installedClients` (typically from
//      `detectInstalledClients()`); if absent, the function falls
//      back to the v1.20.0 Desktop-only behavior for backward
//      compatibility with the original single-client signature.
//   3. If 'merlin' is already registered + matching in EVERY installed
//      client → don't ask (already done across the board). For
//      Desktop, "registered" means the desktop config has the matching
//      merlin entry; for Code we don't enumerate per-project state
//      from this call site — Code's per-project nature means the
//      autoprompt firing on a major bump is the correct UX for
//      offering NEW project enablement. So the suppress-when-already-
//      registered rule applies only to Desktop.
//   4. If the user previously chose 'skipped' → re-ask only on a
//      major version bump.
//   5. Otherwise → fire the prompt.
//
// Gitar PR #163 follow-up (2026-04-29): pre-fix this function bailed
// on `claude-desktop-not-installed` before the caller had any chance
// to check Claude Code. A user with ONLY Claude Code installed never
// saw the autoprompt because the Desktop-config-dir gate blocked it.
// Now `installedClients` flows in: if Code is installed, the
// Desktop-only gate is bypassed.
function shouldPrompt({ stateDir, configPath, merlinEntry, currentMajor, installedClients }) {
  const decision = readDecision(stateDir);
  if (decision && decision.decision === 'never') return { fire: false, reason: 'user-chose-never' };

  // Compute installed clients defensively if caller didn't pass them.
  // Backward compat: callers that pre-date Claude Code support get the
  // historical Desktop-only behavior.
  const installed = (installedClients && typeof installedClients === 'object')
    ? installedClients
    : detectInstalledClients();
  if (!installed.desktop && !installed.code) {
    return { fire: false, reason: 'no-claude-host-installed' };
  }

  // Already registered & matching IN DESKTOP (Code's per-project model
  // means an autoprompt re-fire on major bump is the correct UX for
  // offering enablement on a new project the user has since adopted).
  let desktopAlreadyRegistered = false;
  if (installed.desktop) {
    const existing = readExistingConfig(configPath);
    if (existing && typeof existing === 'object') {
      const existingMerlin = existing.mcpServers && existing.mcpServers.merlin;
      if (existingMerlin
          && existingMerlin.command === merlinEntry.command
          && Array.isArray(existingMerlin.args)
          && existingMerlin.args.length === merlinEntry.args.length
          && existingMerlin.args.every((v, i) => v === merlinEntry.args[i])) {
        desktopAlreadyRegistered = true;
      }
    } else if (existing === null) {
      // Corrupt config — don't touch it without explicit user opt-in.
      return { fire: false, reason: 'config-unparseable' };
    }
  }

  // Suppression rule: if Desktop is the ONLY installed client AND
  // merlin is already registered there, nothing to ask. (If Code is
  // also installed, we still want to prompt — the user may want to
  // enable Code in a project.)
  if (installed.desktop && !installed.code && desktopAlreadyRegistered) {
    return { fire: false, reason: 'already-registered' };
  }

  // Previously skipped on this major version?
  if (decision && decision.decision === 'skipped'
      && Number.isFinite(decision.major) && decision.major === currentMajor) {
    return { fire: false, reason: 'skipped-this-major' };
  }

  // Previously added → don't re-prompt on subsequent launches within
  // the same major. (A major version bump re-fires the prompt — that's
  // intentional, lets new features in a major be re-offered to users
  // who skipped the original prompt.) Added in v1.20.5 (Gitar PR #163
  // follow-up): without this rule, a user with Code-only registration
  // sees the prompt every launch because the per-Code already-
  // registered check intentionally fires on major bumps to offer
  // enablement on newly-adopted projects. With this rule, the user
  // gets one prompt per major and decides in-product (via the
  // sidecar status panel) when to add additional projects.
  if (decision && decision.decision === 'added') {
    // Stamp the major if not already stamped (older 'added' sentinels
    // didn't include a major field — treat them as suppress-forever
    // within the current major so we don't re-prompt at all).
    const decisionMajor = Number.isFinite(decision.major) ? decision.major : currentMajor;
    if (decisionMajor === currentMajor) {
      return { fire: false, reason: 'already-added-this-major' };
    }
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

// Per-project Claude Code "is merlin loaded?" check. Returns true iff
// BOTH conditions hold:
//   1. <projectRoot>/.mcp.json has a matching merlin entry under mcpServers.
//   2. ~/.claude.json's projects[<projectKey>].enabledMcpjsonServers
//      includes "merlin".
// Failing either check → returns false. Identical to the Desktop
// isRegistered() in spirit but spans the two-file model.
function isRegisteredClaudeCode({ projectRoot, projectKey, claudeJsonPath, merlinEntry }) {
  const mcpJsonPath = claudeCodeProjectMcpPath(projectRoot);
  const projectCfg = readExistingConfig(mcpJsonPath);
  if (!projectCfg || typeof projectCfg !== 'object') return false;
  const e = projectCfg.mcpServers && projectCfg.mcpServers.merlin;
  if (!e || typeof e !== 'object') return false;
  if (e.command !== merlinEntry.command) return false;
  if (!Array.isArray(e.args) || e.args.length !== merlinEntry.args.length) return false;
  if (!e.args.every((v, i) => v === merlinEntry.args[i])) return false;

  const userCfg = readExistingConfig(claudeJsonPath);
  if (!userCfg || typeof userCfg !== 'object') return false;
  const proj = userCfg.projects && userCfg.projects[projectKey];
  if (!proj || typeof proj !== 'object') return false;
  return Array.isArray(proj.enabledMcpjsonServers)
    && proj.enabledMcpjsonServers.includes('merlin');
}

// Sidecar status: enumerate every project the user has registered with
// Claude Code (read from <stateDir>/.mcp-claude-code-projects.json) and
// verify each one's live state. Used by the IPC status handler so the
// renderer can show a per-project row with a live/stale dot.
//
// The "live" check re-runs isRegisteredClaudeCode for each project —
// catches the case where a teammate edited <project>/.mcp.json by hand
// and removed merlin, or where ~/.claude.json was reset.
function listClaudeCodeProjectsStatus({ stateDir, claudeJsonPath, merlinEntry }) {
  const out = [];
  const remembered = readClaudeCodeProjects(stateDir);
  for (const projectKey of remembered) {
    let enabled = false;
    try {
      enabled = isRegisteredClaudeCode({
        projectRoot: projectKey,
        projectKey,
        claudeJsonPath,
        merlinEntry,
      });
    } catch { enabled = false; }
    out.push({ path: projectKey, enabled });
  }
  return out;
}

// Apply the Claude Code registration to ONE project. Two atomic writes:
//   1. Merge merlin entry into <projectRoot>/.mcp.json (creating if missing).
//   2. Add 'merlin' to ~/.claude.json's
//      projects[<projectKey>].enabledMcpjsonServers (creating projects
//      map / project entry / array as needed).
// Both writes are tmp+rename atomic. If either source file is corrupt,
// we refuse to touch it (clear error) — never clobber.
//
// Returns { ok, changed?, mcpJsonPath?, claudeJsonPath?, projectKey?, error? }.
//
// `changed` = true iff at least one of the two files actually got
// rewritten. A re-run on an already-registered project returns
// { ok: true, changed: false } and rewrites nothing.
function applyRegistrationClaudeCode({ stateDir, claudeJsonPath, projectRoot, merlinEntry }) {
  const resolved = resolveProjectKey(projectRoot);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  const projectKey = resolved.key;
  const mcpJsonPath = claudeCodeProjectMcpPath(projectKey);

  // Step 1: per-project .mcp.json
  const existingProject = readExistingConfig(mcpJsonPath);
  if (existingProject === null) {
    return { ok: false, error: '.mcp.json at ' + projectKey + ' is unparseable; refusing to overwrite. Remove or fix it manually.' };
  }
  const projMerge = mergeMcpJsonMerlinEntry(existingProject || {}, merlinEntry);
  let mcpJsonChanged = false;
  if (projMerge.changed) {
    const wrote = writeMergedConfig(mcpJsonPath, projMerge.config);
    if (!wrote) {
      return { ok: false, error: 'Failed to write ' + mcpJsonPath + ' (permissions or disk error).' };
    }
    mcpJsonChanged = true;
  }

  // Step 2: user-level ~/.claude.json
  const existingUser = readExistingConfig(claudeJsonPath);
  if (existingUser === null) {
    // We've already written .mcp.json successfully above — don't roll
    // back, just surface the clean error so the user can fix the
    // ~/.claude.json corruption and re-run. Idempotent on re-run.
    return {
      ok: false,
      error: claudeJsonPath + ' is unparseable; refusing to overwrite. Repair the JSON manually, then re-run.',
      mcpJsonPath,
      mcpJsonChanged,
    };
  }
  const userMerge = mergeClaudeJsonEnable(existingUser || {}, projectKey);
  let claudeJsonChanged = false;
  if (userMerge.changed) {
    const wrote = writeMergedConfig(claudeJsonPath, userMerge.config);
    if (!wrote) {
      return {
        ok: false,
        error: 'Failed to write ' + claudeJsonPath + ' (permissions or disk error).',
        mcpJsonPath,
        mcpJsonChanged,
      };
    }
    claudeJsonChanged = true;
  }

  // Step 3: remember this project so future status panels can list it.
  rememberClaudeCodeProject(stateDir, projectKey);

  return {
    ok: true,
    changed: mcpJsonChanged || claudeJsonChanged,
    mcpJsonPath,
    claudeJsonPath,
    projectKey,
  };
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

// Record a Skip / Don't-ask-again outcome via writeDecision's atomic
// tmp+rename path. The `skipped` branch stamps the current major
// version so shouldPrompt() can re-ask on the next major bump; the
// `never` branch records no major (decision='never' is permanent).
//
// Gitar PR #150 follow-up (2026-04-29): the original implementation
// double-wrote the sentinel — first via writeDecision (atomic), then
// via a direct fs.writeFileSync (non-atomic). Both writes contained
// IDENTICAL content, the second was redundant, AND the second write
// dropped the atomic-write discipline used everywhere else. Now both
// branches use the same atomic helper with an optional extra-fields
// object, eliminating the redundant write and keeping crash-safety
// uniform.
function recordSkip(stateDir, currentMajor, never) {
  if (never) {
    writeDecision(stateDir, 'never');
    return;
  }
  writeDecision(stateDir, 'skipped', { major: currentMajor });
}

module.exports = {
  // Claude Desktop (single-file model).
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
  // Claude Code (two-file model).
  claudeCodeConfigPath,
  claudeCodeProjectMcpPath,
  claudeCodeProjectsFile,
  readClaudeCodeProjects,
  writeClaudeCodeProjects,
  rememberClaudeCodeProject,
  detectInstalledClients,
  resolveProjectKey,
  mergeMcpJsonMerlinEntry,
  mergeClaudeJsonEnable,
  isRegisteredClaudeCode,
  listClaudeCodeProjectsStatus,
  applyRegistrationClaudeCode,
};
