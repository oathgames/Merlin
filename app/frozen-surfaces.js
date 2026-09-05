// Merlin — Frozen-Surface Parity Harness (Electron / JS half)
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT THIS IS
// ─────────────────────────────────────────────────────────────────────────
// A "frozen surface" is anything an external consumer binds to and that a
// refactor must not silently move: the MCP tool contract the agent calls,
// the SKILL bodies the SDK routes on, the config keys the renderer may
// write, the approval-policy sets that decide whether real ad spend shows a
// card, the budget ceilings, and the /update manifest. None of those are
// covered by a type system — Merlin's two repos cannot compile against each
// other, and the agent side is an LLM, not a caller a compiler can check.
// So drift here is silent by construction, which is exactly the failure
// class Hard-Won Rules 19 and 23 were both written after.
//
// This module collects every one of those surfaces into ONE canonical,
// deterministic JSON object. `app/frozen-surfaces.test.js` compares it
// byte-for-byte against the committed snapshot at
// `app/__snapshots__/frozen-surfaces.snapshot.json`.
//
// ─────────────────────────────────────────────────────────────────────────
// BEFORE / AFTER WORKFLOW  (15 lines — read this before a big refactor)
// ─────────────────────────────────────────────────────────────────────────
//  1. On the base commit (main, or wherever your refactor starts), run
//       node --test app/frozen-surfaces.test.js
//     It MUST be green. A red harness before you start means the snapshot
//     is already stale, and you cannot tell your drift from someone else's.
//  2. Do the refactor — human, multi-agent, or a delegated model. Move
//     files, split modules, rewrite handlers, whatever.
//  3. Run the same command again.
//  4. GREEN  → every externally visible surface survived the refactor
//     byte-for-byte. That is the proof; nothing further is needed.
//  5. RED    → the test prints a unified diff of the pretty JSON and names
//     the drifting key paths. It is one of exactly two things:
//       (a) a BUG — you moved something a consumer binds to. Fix the code,
//           not the snapshot.
//       (b) a DELIBERATE change — a new tool, a widened enum, a retired
//           skill. Accept it with:
//               npm run parity:update          (or UPDATE_FROZEN_SURFACES=1)
//           then COMMIT the regenerated snapshot and call the change out in
//           the PR body. The snapshot diff is what reviewers actually read;
//           an unexplained one is a review blocker.
//  6. Never regenerate to make a red test go away. Regenerating is how you
//     say "yes, I meant to change the contract" — in public, in the diff.
//
// ─────────────────────────────────────────────────────────────────────────
// KNOWN GAPS (deliberate — do not "fix" by inventing values)
// ─────────────────────────────────────────────────────────────────────────
//  • Functions on tool annotations (`blastRadius`, a `concurrency.platform`
//    resolver) serialize as the literal "[function]". Their SOURCE is not
//    hashed: source text churns on reformatting, and calling them here
//    would need synthetic args this module has no business inventing.
//    `mcp-approval-policy.test.js` is what actually pins their behavior.
//  • Scalar config DEFAULTS (falModel "seedance-2", imageModel
//    "banana-pro-edit", maxDailyAdBudget, blogPublishMode "draft") are NOT
//    defined anywhere in `app/` — they live in the Go engine's loadConfig
//    and are captured by `autocmo-core/frozen_surfaces.go`. What the app
//    owns, and what this file therefore captures, is the config KEY surface:
//    which keys the renderer may write (CONFIG_FIELD_ALLOWLIST) and which
//    ones must be vaulted (VAULT_SENSITIVE_KEYS).
//  • Zod's own JSON-Schema emitter is the serializer (`z.toJSONSchema`,
//    native to zod 4 — no new dependency, and JSON Schema 2020-12 is the
//    spec anchor). A zod MAJOR bump can therefore move this snapshot; the
//    major is recorded in `meta.zodMajor` so such a diff explains itself.
//    A schema zod refuses to represent falls back to a `_def` walk.
//
// Usage: `collectFrozenSurfaces()` → plain object. `canonicalJSON(obj)` →
// the exact pretty string the snapshot file holds.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const APP_DIR = __dirname;
const REPO_ROOT = path.join(APP_DIR, '..');
const SKILLS_DIR = path.join(REPO_ROOT, '.claude', 'skills');

// Bump when the SHAPE of the collector output changes for reasons that are
// not a real product change (e.g. a new surface is added to the harness).
// Reviewers use it to tell "the harness grew" from "the product moved".
const SNAPSHOT_FORMAT_VERSION = 1;

// ── Canonicalization ──────────────────────────────────────────
//
// Sort every object key recursively so the serialized bytes depend on the
// VALUES, never on declaration order. Arrays keep their order (an ordered
// list like version.json's `updatable` is itself part of the contract);
// callers that hold sets sort them explicitly before handing them over.

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}

function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value), null, 2) + '\n';
}

function sortedSet(setOrArray) {
  return [...(setOrArray || [])].map(String).sort();
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── Surface 1: MCP tools ──────────────────────────────────────

function makeStubCtx() {
  // Registration-only context. buildTools/buildMetaIntentTools never invoke a
  // handler during registration, so nothing here is ever called; the stubs
  // exist so a defensive `typeof ctx.x === 'function'` check at registration
  // time cannot throw. Mirrors the fakes in mcp-approval-policy.test.js.
  return {
    getConnections: () => [],
    readConfig: () => ({}),
    readBrandConfig: () => ({}),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => '/frozen-surfaces/stub-binary',
    appRoot: REPO_ROOT,
    isBinaryTooOld: () => false,
    runOAuthFlow: async () => ({ success: true }),
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
  };
}

// Deterministic serialization of one zod schema.
//
// Primary path is zod 4's own `toJSONSchema` (spec anchor: JSON Schema
// 2020-12). `io: 'input'` is the right frame — these schemas describe what a
// caller SENDS. `unrepresentable: 'any'` keeps an exotic type from throwing
// the whole collection; the `$schema` header is stripped because it is a
// constant that would repeat 80× in the snapshot for no review value.
function zodToDeterministic(z, schema) {
  try {
    const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    if (js && typeof js === 'object') delete js.$schema;
    return js;
  } catch (e) {
    return { _unrepresentable: describeZodDef(schema), _reason: String((e && e.message) || e) };
  }
}

// Fallback `_def` walk for anything zod's emitter refuses. Deliberately
// shallow: type name, wrapped inner type, enum values, description.
function describeZodDef(schema) {
  const def = schema && schema._def;
  if (!def) return { type: 'unknown' };
  const out = { type: String(def.type || 'unknown') };
  if (schema.description) out.description = schema.description;
  if (Array.isArray(def.entries)) out.values = def.entries.map(String).sort();
  if (def.entries && !Array.isArray(def.entries) && typeof def.entries === 'object') {
    out.values = Object.values(def.entries).map(String).sort();
  }
  if (def.innerType) out.inner = describeZodDef(def.innerType);
  if (def.element) out.element = describeZodDef(def.element);
  return out;
}

// Annotations carry two callback shapes (blastRadius, a concurrency.platform
// resolver). See KNOWN GAPS at the top of this file for why they collapse to
// "[function]" rather than being hashed or invoked.
function serializeAnnotations(annotations) {
  const out = {};
  for (const [key, value] of Object.entries(annotations || {})) {
    if (typeof value === 'function') { out[key] = '[function]'; continue; }
    if (value && typeof value === 'object') {
      const nested = {};
      for (const [k, v] of Object.entries(value)) {
        nested[k] = typeof v === 'function' ? '[function]' : v;
      }
      out[key] = nested;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function collectMcpTools() {
  // Registration is pure, but mcp-tools destructures `execFile` at load; the
  // stub keeps any accidental spawn from reaching a real process.
  const childProcess = require('node:child_process');
  const realExecFile = childProcess.execFile;
  childProcess.execFile = function frozenSurfacesExecFileStub() {
    throw new Error('frozen-surfaces: a tool handler ran during collection — collection must be registration-only');
  };

  let z;
  let registry;
  try {
    z = require('zod');
    const { buildTools } = require('./mcp-tools');
    registry = [];
    const tool = (name, description, schema, handler, options) => {
      registry.push({ name, description, schema, options });
      return { name };
    };
    buildTools(tool, z, makeStubCtx());
  } finally {
    childProcess.execFile = realExecFile;
  }

  const tools = registry.map((entry) => ({
    name: entry.name,
    description: entry.description,
    annotations: serializeAnnotations(entry.options && entry.options.annotations),
    input: serializeShape(z, entry.schema),
  }));
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return tools;
}

function serializeShape(z, shape) {
  const out = {};
  for (const key of Object.keys(shape || {}).sort()) {
    out[key] = zodToDeterministic(z, shape[key]);
  }
  return out;
}

// ── Surface 2: SKILLs ─────────────────────────────────────────
//
// Frontmatter fields are the always-resident cold-start context (the SDK
// loads every `description` at startup and routes on it), so they are
// captured verbatim. The BODY is loaded on demand and is far too large to
// sit in a review diff, so it is captured as a sha256 — enough to prove it
// did not move, small enough to read.

const SKILL_FRONTMATTER_FIELDS = ['name', 'description', 'owner', 'bytes_justification'];

function parseSkillFrontmatter(raw) {
  // Minimal, deliberately non-YAML: these files use flat `key: value` pairs
  // only. A nested/multiline frontmatter would silently mis-parse here, so
  // the collector records the raw block hash alongside the parsed fields.
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { fields: {}, body: normalized, frontmatterRaw: '' };
  const end = normalized.indexOf('\n---\n', 3);
  if (end === -1) return { fields: {}, body: normalized, frontmatterRaw: '' };
  const frontmatterRaw = normalized.slice(4, end + 1);
  const body = normalized.slice(end + 5);
  const fields = {};
  for (const line of frontmatterRaw.split('\n')) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  return { fields, body, frontmatterRaw };
}

function collectSkills() {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const file = path.join(SKILLS_DIR, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const { fields, body, frontmatterRaw } = parseSkillFrontmatter(raw);
    const entry = { dir: name, bodySha256: sha256(body), bodyBytes: Buffer.byteLength(body, 'utf8') };
    for (const key of SKILL_FRONTMATTER_FIELDS) {
      if (fields[key] !== undefined) entry[key] = fields[key];
    }
    // Catches a frontmatter key nobody declared as frozen being added or
    // dropped, without dumping the whole block into the diff.
    entry.frontmatterSha256 = sha256(frontmatterRaw);
    out.push(entry);
  }
  return out;
}

// ── Surface 3: config key surface ─────────────────────────────

function collectConfigSurface() {
  const persist = require('./oauth-persist');
  return {
    // Every key the renderer's save-config-field IPC will accept. Dropping
    // one here is the "postscript-save-broken" incident class: the paste is
    // rejected with "Unknown config field" and nothing else says why.
    configFieldAllowlist: sortedSet(persist.CONFIG_FIELD_ALLOWLIST),
    // Every key that must round-trip through the vault instead of landing in
    // merlin-config.json as plaintext (Hard-Won Rule 21's failure mode).
    vaultSensitiveKeys: sortedSet(persist.VAULT_SENSITIVE_KEYS),
    // Scalar defaults are engine-side: see KNOWN GAPS at the top.
    scalarDefaultsOwnedBy: 'autocmo-core/frozen_surfaces.go (configDefaults)',
  };
}

// ── Surface 4: approval policy ────────────────────────────────

function collectApprovalPolicy() {
  const policy = require('./mcp-approval-policy');
  return {
    readOnlyActions: sortedSet(policy.READ_ONLY_ACTIONS),
    spendActions: sortedSet(policy.SPEND_ACTIONS),
    cardedDestructiveActions: sortedSet(policy.CARDED_DESTRUCTIVE_ACTIONS),
    intentToolToAction: Object.assign({}, policy.INTENT_TOOL_TO_ACTION),
    intentToolLabels: Object.assign({}, policy.INTENT_TOOL_LABELS),
  };
}

// ── Surface 5: budget ceilings ────────────────────────────────

function collectBudgetCeilings() {
  const ceilings = require('./budget-ceiling');
  return {
    BUDGET_HARD_CEILING: ceilings.BUDGET_HARD_CEILING,
    BUDGET_ABSOLUTE_CEILING: ceilings.BUDGET_ABSOLUTE_CEILING,
    BUDGET_RELATIVE_CENTS_RATIO: ceilings.BUDGET_RELATIVE_CENTS_RATIO,
  };
}

// ── Surface 6: version.json update manifest ───────────────────

function collectVersionManifest() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'version.json'), 'utf8'));
  return {
    // Order is preserved: `updatable` is walked in order by the /update flow.
    updatable: (manifest.updatable || []).map(String),
    removed: (manifest.removed || []).map(String),
  };
}

// ── Public API ────────────────────────────────────────────────

function collectFrozenSurfaces() {
  const zodMajor = (() => {
    try { return String(require('zod/package.json').version).split('.')[0]; }
    catch { return 'unknown'; }
  })();

  return {
    meta: {
      repo: 'autoCMO',
      snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
      // Recorded so a zod major bump reads as an explained diff, not a mystery.
      zodMajor,
    },
    mcpTools: collectMcpTools(),
    skills: collectSkills(),
    configSurface: collectConfigSurface(),
    approvalPolicy: collectApprovalPolicy(),
    budgetCeilings: collectBudgetCeilings(),
    versionManifest: collectVersionManifest(),
  };
}

module.exports = {
  collectFrozenSurfaces,
  canonicalJSON,
  canonicalize,
  SNAPSHOT_FORMAT_VERSION,
  // Exported for the negative test, which mutates a collected surface in
  // memory and asserts the comparison names the drifting key.
  _internals: { sha256, parseSkillFrontmatter, serializeAnnotations },
};
