// Codex CLI MCP-client autoconfig.
//
// Codex (the OpenAI Codex CLI / VS Code extension) reads MCP-server
// definitions from a TOML file at ~/.codex/config.toml on every OS.
// Each server is a TOML table named [mcp_servers.<name>] carrying:
//
//   command = "<absolute path to launcher>"
//   args    = ["<absolute path to script>", ...]
//   env     = { KEY = "value", ... }   # optional
//
// Note the snake_case key (`mcp_servers`) — distinct from Claude Desktop
// and Claude Code, which both use camelCase (`mcpServers`) in JSON.
//
// This module owns:
//
//   * codexConfigPath()                 — canonical ~/.codex/config.toml path
//   * detectInstalledCodex()            — non-throwing existence check
//   * parseCodexToml() / serializeCodexToml()
//                                       — vendored MINIMAL TOML support
//                                         (see SCOPE OF TOML SUPPORT below)
//   * mergeCodexMerlinEntry()           — pure merge of merlin into mcp_servers
//   * applyCodexRegistration()          — atomic write of the merged file
//   * isRegisteredCodex()               — live check used by status panel
//   * recordCodexSkip()                 — sentinel for the autoprompt
//
// SCOPE OF TOML SUPPORT
//
//   We deliberately do NOT depend on a third-party TOML library. Hard-Won
//   Security Rule N: every new transitive dep is supply-chain surface,
//   and this file's needs are tiny and shaped by Codex's documented
//   `[mcp_servers.<name>]` schema. The vendored parser/serializer
//   handles ONLY the constructs Codex's config file uses in practice:
//
//     - Top-level scalar keys:                    foo = "bar"
//                                                  foo = 42
//                                                  foo = true
//     - Nested tables one level deep:             [mcp_servers.merlin]
//     - String values (basic + quoted)
//     - Integer + boolean values
//     - String arrays                              args = ["a", "b"]
//     - Inline tables for env                      env = { KEY = "value" }
//     - Comments (whole-line `#` only — anything else passes through)
//
//   The "preserve everything else verbatim" contract is the load-bearing
//   one: if a user has hand-written sections we don't understand
//   (multi-line arrays, datetimes, deep tables, literal strings), the
//   parser falls back to OPAQUE PASSTHROUGH — the unknown chunk is kept
//   as a raw string and re-emitted unchanged on serialize. Refuse-to-
//   clobber on truly unparseable input (mismatched brackets, unterminated
//   strings) — same posture as the Claude config merge.
//
// SECURITY POSTURE
//
//   * Atomic writes (tmp + rename) on every persistence path.
//   * Mode 0o600 on the rendered config (POSIX). Codex itself ships with
//     0o644 historically; we tighten to 0o600 because the file may
//     contain command paths an attacker could swap. Tightening is safe —
//     Codex reads its own file as the same user.
//   * Refuse-to-clobber: any parse failure surfaces a clear error and
//     leaves the original file untouched.
//   * Never invent fields. Only the [mcp_servers.merlin] block is
//     written; every other table + comment + blank line is preserved
//     byte-for-byte where the parser supports the construct, or stuffed
//     through the OPAQUE PASSTHROUGH path otherwise.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ──────────────────────────────────────────────────────────────
// Path resolution
// ──────────────────────────────────────────────────────────────

// Codex stores its config at ~/.codex/config.toml on every OS. Mirrors
// the path Codex's documented `--config` flag defaults to. No
// per-platform override (unlike Claude Desktop's APPDATA / Application
// Support dance) — Codex shipped with a single canonical path.
function codexConfigPath() {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

// Detect whether Codex appears to be installed. Existence of either
// ~/.codex/ (the directory Codex creates on first run) OR a parseable
// config.toml is treated as "installed". Mirrors Claude Code's
// detectInstalledClients() approach — never connects to the client,
// just checks for the on-disk footprint.
function detectInstalledCodex() {
  const dir = path.dirname(codexConfigPath());
  try {
    if (fs.statSync(dir).isDirectory()) return true;
  } catch { /* not installed */ }
  try {
    if (fs.statSync(codexConfigPath()).isFile()) return true;
  } catch { /* not installed */ }
  return false;
}

// ──────────────────────────────────────────────────────────────
// Decision sentinel
// ──────────────────────────────────────────────────────────────

// Per-client sentinel — distinct from the Claude one so that "skip
// Codex" doesn't suppress the Claude prompt and vice versa.
function codexDecisionFile(stateDir) {
  return path.join(stateDir, '.mcp-codex-prompt');
}

function readCodexDecision(stateDir) {
  try {
    const raw = fs.readFileSync(codexDecisionFile(stateDir), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.decision === 'string') return obj;
  } catch {}
  return null;
}

function writeCodexDecision(stateDir, decision, extra) {
  const payload = JSON.stringify(
    Object.assign({ decision, at: Date.now(), schema: 1 }, extra || {}),
    null,
    2,
  );
  const target = codexDecisionFile(stateDir);
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

function recordCodexSkip(stateDir, currentMajor, never) {
  if (never) {
    writeCodexDecision(stateDir, 'never');
    return;
  }
  writeCodexDecision(stateDir, 'skipped', { major: currentMajor });
}

// ──────────────────────────────────────────────────────────────
// TOML helpers — vendored, minimal, tailored to Codex's config shape
// ──────────────────────────────────────────────────────────────

// Encode a string as a TOML basic string with the standard escape rules.
// Codex (like every TOML 1.0 parser) accepts: \" \\ \b \t \n \f \r \uXXXX.
// We escape the minimum required set; everything else passes through as
// a literal codepoint.
function encodeTomlString(s) {
  if (typeof s !== 'string') throw new Error('encodeTomlString: non-string input');
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';            // "
    else if (c === 0x5c) out += '\\\\';      // \
    else if (c === 0x08) out += '\\b';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0d) out += '\\r';
    else if (c < 0x20 || c === 0x7f) {
      out += '\\u' + c.toString(16).padStart(4, '0');
    } else {
      out += s[i];
    }
  }
  out += '"';
  return out;
}

// Decode a TOML basic string starting at position `i` in `src` (which
// must be the opening quote). Returns { value, next } where `next` is
// the index of the character AFTER the closing quote. Throws on
// unterminated string or unsupported escape.
function decodeTomlString(src, i) {
  if (src[i] !== '"') throw new Error('decodeTomlString: expected opening quote at ' + i);
  let out = '';
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '"') return { value: out, next: j + 1 };
    if (c === '\\') {
      const esc = src[j + 1];
      if (esc === '"') { out += '"'; j += 2; continue; }
      if (esc === '\\') { out += '\\'; j += 2; continue; }
      if (esc === 'b') { out += '\b'; j += 2; continue; }
      if (esc === 't') { out += '\t'; j += 2; continue; }
      if (esc === 'n') { out += '\n'; j += 2; continue; }
      if (esc === 'f') { out += '\f'; j += 2; continue; }
      if (esc === 'r') { out += '\r'; j += 2; continue; }
      if (esc === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) {
        out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
        j += 6;
        continue;
      }
      throw new Error('decodeTomlString: unsupported escape \\' + (esc || '') + ' at ' + j);
    }
    if (c === '\n' || c === '\r') {
      throw new Error('decodeTomlString: unterminated basic string at ' + i);
    }
    out += c;
    j++;
  }
  throw new Error('decodeTomlString: unterminated basic string at ' + i);
}

// Parse a TOML scalar value (string / int / bool / array / inline table)
// starting at position `i` (skipping leading whitespace already done by
// caller). Returns { value, next }. Throws on unsupported constructs —
// caller stuffs the entire surrounding line into the OPAQUE PASSTHROUGH
// bucket if this throws.
function parseTomlValue(src, i) {
  // Skip inline whitespace.
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
  if (i >= src.length) throw new Error('parseTomlValue: end of input');
  const c = src[i];
  // String.
  if (c === '"') return decodeTomlString(src, i);
  // Boolean.
  if (src.startsWith('true', i)) {
    return { value: true, next: i + 4 };
  }
  if (src.startsWith('false', i)) {
    return { value: false, next: i + 5 };
  }
  // Array.
  if (c === '[') {
    const arr = [];
    let j = i + 1;
    while (j < src.length) {
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === ']') return { value: arr, next: j + 1 };
      const inner = parseTomlValue(src, j);
      arr.push(inner.value);
      j = inner.next;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === ',') { j++; continue; }
      if (src[j] === ']') return { value: arr, next: j + 1 };
      throw new Error('parseTomlValue: malformed array near ' + j);
    }
    throw new Error('parseTomlValue: unterminated array');
  }
  // Inline table.
  if (c === '{') {
    const obj = {};
    let j = i + 1;
    while (j < src.length) {
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '}') return { value: obj, next: j + 1 };
      // key
      let keyEnd = j;
      while (keyEnd < src.length && /[A-Za-z0-9_\-]/.test(src[keyEnd])) keyEnd++;
      if (keyEnd === j) throw new Error('parseTomlValue: expected inline-table key at ' + j);
      const key = src.slice(j, keyEnd);
      j = keyEnd;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] !== '=') throw new Error('parseTomlValue: expected = in inline table at ' + j);
      j++;
      const inner = parseTomlValue(src, j);
      obj[key] = inner.value;
      j = inner.next;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === ',') { j++; continue; }
      if (src[j] === '}') return { value: obj, next: j + 1 };
      throw new Error('parseTomlValue: malformed inline table near ' + j);
    }
    throw new Error('parseTomlValue: unterminated inline table');
  }
  // Integer (no float / datetime support — neither appears in any
  // documented Codex MCP config).
  const intMatch = /^-?\d+/.exec(src.slice(i));
  if (intMatch) {
    return { value: parseInt(intMatch[0], 10), next: i + intMatch[0].length };
  }
  throw new Error('parseTomlValue: unsupported value at ' + i + ': ' + JSON.stringify(src.slice(i, i + 20)));
}

// Parse the entire Codex config.toml.
//
// Output shape:
//   {
//     opaqueHeader: string,           // any pre-first-table content (comments, root keys we couldn't parse)
//     tables: [
//       { kind: 'parsed', name: 'mcp_servers.merlin', body: { command, args, env? } },
//       { kind: 'opaque', source: '<raw chunk>' },
//       ...
//     ]
//   }
//
// ANY parse error inside a [section] rolls that whole section into the
// opaque bucket — preserve-and-passthrough. That keeps round-trips
// stable for sections we don't fully understand. The ONE hard failure
// is at the table-header level itself: an unmatched `[`, an empty `[]`,
// etc. — those are unparseable at the structural level and we refuse
// to overwrite (returns `null`).
function parseCodexToml(src) {
  if (typeof src !== 'string') return null;
  const result = { opaqueHeader: '', tables: [] };

  // Split into chunks delimited by `[name]` / `[name.sub]` headers at
  // the start of a line (after optional whitespace).
  const headerRe = /^[ \t]*\[([^\[\]\n]+)\][ \t]*(?:#[^\n]*)?$/;
  const lines = src.split(/\r?\n/);

  let currentChunk = []; // raw lines for the current section
  let currentHeader = null; // null = pre-first-table

  function flushChunk() {
    const raw = currentChunk.join('\n');
    if (currentHeader === null) {
      result.opaqueHeader = raw;
      return;
    }
    // Try to parse as a simple key=value block.
    let body;
    try {
      body = parseSectionBody(raw);
    } catch {
      result.tables.push({ kind: 'opaque', name: currentHeader, source: '[' + currentHeader + ']\n' + raw });
      return;
    }
    result.tables.push({ kind: 'parsed', name: currentHeader, body });
  }

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    const trimmed = line.trimStart();
    // Refuse-to-clobber on array-of-tables (`[[x]]`) — we do not model
    // them, and silently round-tripping them as opaque could corrupt
    // ordering relative to the parsed sections we DO model. Better to
    // bail here and let the caller surface a clear "repair manually"
    // error than to write a half-understood file.
    if (trimmed.startsWith('[[')) {
      return null;
    }
    const m = headerRe.exec(line);
    if (m) {
      flushChunk();
      currentChunk = [];
      currentHeader = m[1].trim();
      continue;
    }
    currentChunk.push(line);
  }
  flushChunk();
  return result;
}

// Parse a section body (everything after `[header]` and before the next
// `[header]`) into a plain object. Supports the same scalar shapes as
// parseTomlValue. Empty lines + whole-line comments are dropped (they
// are reconstructed by the serializer with stable formatting). Throws
// on any line we can't parse — caller turns the whole section opaque.
function parseSectionBody(src) {
  const obj = {};
  const lines = src.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    // key = value [# comment]
    const eq = line.indexOf('=');
    if (eq < 0) throw new Error('parseSectionBody: no = in line: ' + line);
    const keyRaw = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_\-]*$/.test(keyRaw)) {
      throw new Error('parseSectionBody: unsupported key shape: ' + keyRaw);
    }
    const valStart = eq + 1;
    const parsed = parseTomlValue(line, valStart);
    obj[keyRaw] = parsed.value;
    // Reject anything trailing other than whitespace + optional comment.
    const rest = line.slice(parsed.next).trim();
    if (rest && !rest.startsWith('#')) {
      throw new Error('parseSectionBody: trailing content after value: ' + rest);
    }
  }
  return obj;
}

// Render a TOML value (scalar / array / inline table). Shared by
// section-body emission and inline-table emission.
function renderTomlValue(value) {
  if (typeof value === 'string') return encodeTomlString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (Array.isArray(value)) {
    return '[' + value.map(renderTomlValue).join(', ') + ']';
  }
  if (value && typeof value === 'object') {
    const inner = Object.keys(value)
      .map((k) => k + ' = ' + renderTomlValue(value[k]))
      .join(', ');
    return '{ ' + inner + ' }';
  }
  throw new Error('renderTomlValue: unsupported value: ' + JSON.stringify(value));
}

// Render a parsed section body back to TOML. Stable key order so
// re-runs produce byte-identical output (crucial for diff hygiene in
// version-controlled config files).
function renderSectionBody(body) {
  const keys = Object.keys(body).sort();
  return keys.map((k) => k + ' = ' + renderTomlValue(body[k])).join('\n');
}

// Serialize a parseCodexToml() result back to a TOML string. Preserves
// opaque header + opaque sections verbatim; re-emits parsed sections
// with stable ordering.
function serializeCodexToml(parsed) {
  const parts = [];
  if (parsed.opaqueHeader && parsed.opaqueHeader.length) {
    parts.push(parsed.opaqueHeader.replace(/\s+$/, ''));
  }
  for (const t of parsed.tables) {
    if (t.kind === 'opaque') {
      parts.push(t.source.replace(/\s+$/, ''));
    } else {
      const body = renderSectionBody(t.body);
      parts.push('[' + t.name + ']' + (body ? '\n' + body : ''));
    }
  }
  return parts.filter((p) => p && p.length).join('\n\n') + '\n';
}

// ──────────────────────────────────────────────────────────────
// Merlin-entry merge
// ──────────────────────────────────────────────────────────────

// Build the Codex `[mcp_servers.merlin]` table body. Same input shape
// as the Claude side (`{nodePath, shimPath}`) so callers can reuse
// resolveSidecarPaths()'s output.
function buildCodexMerlinEntry({ nodePath, shimPath, env }) {
  const body = {
    command: nodePath,
    args: [shimPath],
  };
  if (env && typeof env === 'object' && Object.keys(env).length) {
    body.env = Object.assign({}, env);
  }
  return body;
}

// Pure merge of the merlin entry into a parsed config.
//
// Behavior mirrors mergeMerlinEntry on the Claude side:
//   * If `mcp_servers.merlin` is missing, append a new table.
//   * If it exists with the SAME body, no-op (changed=false).
//   * If it exists with different values, OVERWRITE in-place (preserves
//     positional ordering of other tables — matters for diff hygiene
//     when the user keeps other servers configured).
//   * Other [mcp_servers.<name>] tables are preserved untouched.
function mergeCodexMerlinEntry(parsed, merlinBody) {
  // Defensive deep copy of input.
  const cfg = { opaqueHeader: parsed.opaqueHeader, tables: parsed.tables.map((t) => {
    if (t.kind === 'opaque') return { kind: 'opaque', name: t.name, source: t.source };
    return { kind: 'parsed', name: t.name, body: JSON.parse(JSON.stringify(t.body)) };
  }) };

  let changed = false;
  const targetName = 'mcp_servers.merlin';
  let found = false;
  for (const t of cfg.tables) {
    if (t.kind !== 'parsed') continue;
    if (t.name !== targetName) continue;
    found = true;
    const same = sameMerlinBody(t.body, merlinBody);
    if (!same) {
      t.body = JSON.parse(JSON.stringify(merlinBody));
      changed = true;
    }
    break;
  }
  if (!found) {
    cfg.tables.push({ kind: 'parsed', name: targetName, body: JSON.parse(JSON.stringify(merlinBody)) });
    changed = true;
  }
  return { changed, config: cfg };
}

function sameMerlinBody(a, b) {
  if (!a || !b) return false;
  if (a.command !== b.command) return false;
  if (!Array.isArray(a.args) || !Array.isArray(b.args)) return false;
  if (a.args.length !== b.args.length) return false;
  for (let i = 0; i < a.args.length; i++) if (a.args[i] !== b.args[i]) return false;
  // env compare (both absent → same; both present → keys+values match).
  const aHas = a.env && typeof a.env === 'object';
  const bHas = b.env && typeof b.env === 'object';
  if (aHas !== bHas) return false;
  if (aHas && bHas) {
    const ak = Object.keys(a.env).sort();
    const bk = Object.keys(b.env).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false;
      if (a.env[ak[i]] !== b.env[bk[i]]) return false;
    }
  }
  return true;
}

// ──────────────────────────────────────────────────────────────
// Disk I/O — read existing config, write merged config
// ──────────────────────────────────────────────────────────────

// Read existing ~/.codex/config.toml. Returns:
//   * a parsed object on success
//   * `{ opaqueHeader: '', tables: [] }` if the file doesn't exist (clean slate)
//   * null if the file exists but is structurally unparseable (refuse to clobber)
function readExistingCodexConfig(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { opaqueHeader: '', tables: [] };
    return null; // permission, etc. — don't touch
  }
  if (!raw.trim()) return { opaqueHeader: '', tables: [] };
  return parseCodexToml(raw);
}

// Atomically write the rendered config. Parent dir is created if
// missing (Codex installs that dir on first run; we tolerate it being
// absent so a fresh-machine install can proceed). Mode 0o600 on POSIX.
function writeMergedCodexConfig(configPath, parsedConfig) {
  const dir = path.dirname(configPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const rendered = serializeCodexToml(parsedConfig);
  const tmp = configPath + '.merlin-tmp-' + Date.now().toString(36);
  try {
    fs.writeFileSync(tmp, rendered, { mode: 0o600 });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(tmp, 0o600); } catch {}
    }
    fs.renameSync(tmp, configPath);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

// Apply the registration: read → merge → atomic write → decision persist.
// Caller has already obtained user consent (autoprompt or explicit IPC).
// Returns { ok, changed, error?, configPath }.
function applyCodexRegistration({ stateDir, configPath, merlinBody }) {
  const existing = readExistingCodexConfig(configPath);
  if (existing === null) {
    return {
      ok: false,
      error: configPath + ' is unparseable; refusing to overwrite. Repair the TOML manually, then re-run.',
      configPath,
    };
  }
  const { changed, config } = mergeCodexMerlinEntry(existing, merlinBody);
  if (!changed) {
    writeCodexDecision(stateDir, 'added');
    return { ok: true, changed: false, configPath };
  }
  const wrote = writeMergedCodexConfig(configPath, config);
  if (!wrote) {
    return {
      ok: false,
      error: 'Failed to write ' + configPath + ' (permissions or disk error).',
      configPath,
    };
  }
  writeCodexDecision(stateDir, 'added');
  return { ok: true, changed: true, configPath };
}

// "Is the merlin entry currently registered & matching" — used by the
// magic-panel "Sidecar status" indicator. No prompt; just a truthy/falsy
// answer. Tolerates the file being absent or unparseable (returns false
// either way — a missing config is the correct "not registered" state).
function isRegisteredCodex({ configPath, merlinBody }) {
  const existing = readExistingCodexConfig(configPath);
  if (!existing || existing.tables == null) return false;
  for (const t of existing.tables) {
    if (t.kind !== 'parsed') continue;
    if (t.name !== 'mcp_servers.merlin') continue;
    return sameMerlinBody(t.body, merlinBody);
  }
  return false;
}

module.exports = {
  // Path + detection
  codexConfigPath,
  detectInstalledCodex,
  // Decision sentinel
  codexDecisionFile,
  readCodexDecision,
  writeCodexDecision,
  recordCodexSkip,
  // TOML helpers (exported so tests can exercise round-trips directly)
  encodeTomlString,
  decodeTomlString,
  parseTomlValue,
  parseCodexToml,
  serializeCodexToml,
  parseSectionBody,
  renderSectionBody,
  // Merlin entry
  buildCodexMerlinEntry,
  mergeCodexMerlinEntry,
  sameMerlinBody,
  // Disk I/O
  readExistingCodexConfig,
  writeMergedCodexConfig,
  applyCodexRegistration,
  isRegisteredCodex,
};
