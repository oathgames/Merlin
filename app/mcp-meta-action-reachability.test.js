// REGRESSION GUARD (2026-07-26): Meta ENGINE ACTION reachability.
//
// This is app/mcp-meta-param-reachability.test.js one level up. That file locks
// the PARAMS of an action the MCP layer already routes to; this one locks the
// set of ACTIONS the MCP layer can route to at all.
//
// Incident: `autocmo-core/main.go` has shipped `case "meta-list-adsets":` for
// months — the read that answers "which ad sets exist and what status are they
// in", i.e. the check that a campaign really was staged PAUSED before anyone
// activates it. No MCP tool named it. `grep -rn "list-adsets" autoCMO/app/*.js`
// returned zero non-test hits, so there was no arg spelling, no action value,
// no tool that could reach it. The same audit found ten more:
//   meta-list-ads, meta-list-videos, meta-inspect-adset, meta-catalog-sets,
//   meta-geo-resolve, meta-create-audience, meta-rename-ads, meta-edit-link,
//   meta-delete, aware-audience.
// Plus the mirror-image defect: `meta-adlib`, an action the MCP layer routed to
// that the engine has NEVER had (flagged 2026-05-10, exempted, left broken).
//
// Why the existing tests did not catch it:
//   • mcp-action-go-parity.test.js walks MCP → engine, and ONLY for tools with
//     an `action: z.enum([...])`. Intent tools (mcp-meta-intent.js) have no
//     action enum, which is exactly how meta-adlib survived a parity test that
//     was already running.
//   • Nothing at all walked engine → MCP. An action nobody wired up produced no
//     failure anywhere: not a type error, not a 404, not a lint warning. It
//     simply did not exist as far as the product was concerned.
//
// What this file locks:
//   1. ENGINE → MCP. Every Meta-surface `case "<x>":` in main.go is reachable
//      from some MCP tool, or appears in UNEXPOSED_ENGINE_ACTIONS with a
//      written reason. Adding an engine action and wiring nothing fails here.
//   2. MCP → ENGINE, including intent tools. Every action literal the Meta MCP
//      surface hands to runBinary exists as a real case in main.go. This is the
//      meta-adlib class, and it covers the enum-less intent tools that
//      mcp-action-go-parity.test.js structurally cannot see.
//   3. The meta_audit enum and META_AUDIT_ACTION_MAP agree with each other and
//      with mcp-action-go-parity.test.js's copy of the same routing table.
//   4. The specific actions from this incident stay reachable, by name.
//
// Like mcp-action-go-parity.test.js, the engine-side assertions SKIP when the
// private autocmo-core sibling repo is absent (public-repo CI checks out only
// autoCMO). Dev workspaces always have it, so the contract is enforced at
// dev-time and before every release. The pure-JS assertions always run.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── Sources ──────────────────────────────────────────────────────────

const APP_DIR = __dirname;
const MCP_TOOLS_SRC = fs.readFileSync(path.join(APP_DIR, 'mcp-tools.js'), 'utf8');
const MCP_INTENT_SRC = fs.readFileSync(path.join(APP_DIR, 'mcp-meta-intent.js'), 'utf8');
const PARITY_TEST_SRC = fs.readFileSync(path.join(APP_DIR, 'mcp-action-go-parity.test.js'), 'utf8');

const MAIN_GO_PATH = path.join(APP_DIR, '..', '..', 'autocmo-core', 'main.go');
const MAIN_GO_SRC = fs.existsSync(MAIN_GO_PATH) ? fs.readFileSync(MAIN_GO_PATH, 'utf8') : null;
const ENGINE_AVAILABLE = MAIN_GO_SRC !== null;
const SKIP_NO_ENGINE = !ENGINE_AVAILABLE && 'autocmo-core sibling repo not present (public-repo CI)';

// ── execFile capture ─────────────────────────────────────────────────
//
// Patched BEFORE requiring mcp-tools, which destructures execFile at load
// time. Section 6 drives real tool handlers through this to prove the args
// reach the engine's --cmd JSON — declaring an action is only half the
// contract, and the 2026-07-25 param incident was the other half failing.
// node:test gives each file its own process, so this never leaks.
const childProcess = require('node:child_process');
const execFileCalls = [];
childProcess.execFile = function fakeExecFile(file, args, options, callback) {
  execFileCalls.push({ file, args, options });
  const child = { stdin: { on() {}, write() {}, end() {} }, kill() {} };
  setImmediate(() => callback(null, 'ok', ''));
  return child;
};

const { buildTools, META_AUDIT_ACTION_MAP, metaAuditEngineAction } = require('./mcp-tools');

// ── Engine-side extraction ───────────────────────────────────────────

// Every `case "<x>":` literal in main.go's dispatcher.
function extractGoCases(src) {
  const out = new Set();
  const re = /case\s+"([a-z][a-zA-Z0-9_-]*)":/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

const GO_CASES = ENGINE_AVAILABLE ? extractGoCases(MAIN_GO_SRC) : new Set();

// The Meta surface: every `meta-*` action, plus the Meta-backed actions whose
// case name carries no prefix. Keeping the non-prefixed ones in scope is the
// point — `aware-audience` reads Meta custom audiences and was unreachable for
// exactly the same reason as the meta-* ones, and a prefix-only sweep would
// have declared the audit clean while missing it.
const NON_PREFIXED_META_ACTIONS = ['aware-audience', 'competitor-scan'];

function metaEngineActions() {
  const out = new Set();
  for (const c of GO_CASES) {
    if (c.startsWith('meta-') || NON_PREFIXED_META_ACTIONS.includes(c)) out.add(c);
  }
  return out;
}

// ── MCP-side extraction ──────────────────────────────────────────────
//
// Three routes into the engine exist on the Meta surface:
//   a) meta_ads          — 'meta-' + enum value (legacy multiplexer)
//   b) meta_audit        — META_AUDIT_ACTION_MAP (imported, not scraped)
//   c) intent tools      — runBinary(ctx, '<literal>', …) in mcp-meta-intent.js
// (c) is the one no prior test could see. Scrape it as a literal so a new
// intent tool is covered the moment it is written, with no table to update.

function extractRunBinaryLiterals(src) {
  const out = new Set();
  const re = /runBinary\(\s*ctx\s*,\s*'([a-z][a-zA-Z0-9_-]*)'/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

// Pull one tool's `action: z.enum([...])` values out of mcp-tools.js. Same
// bracket-walk approach as mcp-action-go-parity.test.js, scoped to a named
// tool block so a neighbouring tool's enum can't bleed in.
function extractToolEnum(src, toolName) {
  const start = src.indexOf(`name: '${toolName}'`);
  assert.ok(start >= 0, `tool ${toolName} must exist in mcp-tools.js`);
  const nextName = src.indexOf('name: \'', start + 10);
  const block = src.slice(start, nextName > 0 ? nextName : src.length);
  const cleaned = block
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const anchor = cleaned.indexOf('action: z.enum([');
  assert.ok(anchor >= 0, `tool ${toolName} must declare an action enum`);
  const open = cleaned.indexOf('[', anchor);
  let depth = 0;
  let close = -1;
  for (let i = open; i < cleaned.length; i++) {
    if (cleaned[i] === '[') depth++;
    else if (cleaned[i] === ']') { depth--; if (depth === 0) { close = i; break; } }
  }
  assert.ok(close > 0, `could not find the end of ${toolName}'s action enum`);
  return (cleaned.slice(open, close + 1).match(/'([a-zA-Z][a-zA-Z0-9_-]*)'/g) || [])
    .map((s) => s.slice(1, -1));
}

const META_ADS_ENUM = extractToolEnum(MCP_TOOLS_SRC, 'meta_ads');
const META_AUDIT_ENUM = extractToolEnum(MCP_TOOLS_SRC, 'meta_audit');
const INTENT_ACTIONS = extractRunBinaryLiterals(MCP_INTENT_SRC);

// Everything the Meta MCP surface can reach, as engine action names.
function mcpReachableEngineActions() {
  const out = new Set();
  for (const a of META_ADS_ENUM) out.add('meta-' + a);
  for (const a of META_AUDIT_ENUM) out.add(metaAuditEngineAction(a));
  for (const a of INTENT_ACTIONS) out.add(a);
  return out;
}

// ── Deliberately unexposed engine actions ────────────────────────────
//
// An entry here is a DECISION, not a TODO. Each needs a reason that would
// survive a code review; "we haven't got to it" is not one — wire it instead.
const UNEXPOSED_ENGINE_ACTIONS = Object.freeze({
  'meta-delete': [
    'Permanently deletes any ad / ad set / campaign by id (Meta soft-deletes,',
    'recoverable ~90 days). It exists as the engine-internal cleanup path for a',
    'partially-failed push. The operational need an agent actually has —',
    '"stop this from spending" — is fully served by meta_pause_asset, which is',
    'reversible. A delete-anything-by-id verb on the agent surface is blast',
    'radius with no matching upside, so it stays engine-internal on purpose.',
  ].join(' '),
  'meta-login': [
    'OAuth entry point. Reached through platform_login / the connect tiles in',
    'main.js, not through a Meta domain tool. Listed in BRAND_OPTIONAL_ACTIONS.',
  ].join(' '),
});

// ── 1. ENGINE → MCP ──────────────────────────────────────────────────

test('every Meta engine action is reachable from the MCP surface', { skip: SKIP_NO_ENGINE }, () => {
  const reachable = mcpReachableEngineActions();
  const orphans = [];
  for (const action of [...metaEngineActions()].sort()) {
    if (reachable.has(action)) continue;
    if (Object.prototype.hasOwnProperty.call(UNEXPOSED_ENGINE_ACTIONS, action)) continue;
    orphans.push(action);
  }
  assert.deepStrictEqual(orphans, [],
    'Engine actions with NO MCP route — shipped in autocmo-core/main.go, unreachable from the app:\n  ' +
    orphans.join('\n  ') + '\n' +
    'This is the meta-list-adsets bug class: the capability exists, nothing can call it, and nothing fails.\n' +
    'Fix by adding the action to meta_audit (read-only inspection — preferred) or as an intent tool in\n' +
    'mcp-meta-intent.js (writes — remember destructive/costImpact and, for spend, INTENT_TOOL_TO_ACTION\n' +
    'per CLAUDE.md Hard-Won Rule 19). If it is deliberately engine-internal, add it to\n' +
    'UNEXPOSED_ENGINE_ACTIONS above WITH a reason.');
});

test('UNEXPOSED_ENGINE_ACTIONS only lists actions that really exist', { skip: SKIP_NO_ENGINE }, () => {
  // A stale exemption is worse than none: it silently shrinks the audit.
  const stale = Object.keys(UNEXPOSED_ENGINE_ACTIONS).filter((a) => !GO_CASES.has(a));
  assert.deepStrictEqual(stale, [],
    `UNEXPOSED_ENGINE_ACTIONS names actions with no case in main.go: ${stale.join(', ')}. ` +
    'Remove the rows — they are masking nothing and imply coverage that does not exist.');
});

test('UNEXPOSED_ENGINE_ACTIONS entries are not also reachable', { skip: SKIP_NO_ENGINE }, () => {
  // If something on the "deliberately not exposed" list IS exposed, the comment
  // is a lie and the next reader will trust it.
  const reachable = mcpReachableEngineActions();
  const contradictions = Object.keys(UNEXPOSED_ENGINE_ACTIONS).filter((a) => reachable.has(a));
  assert.deepStrictEqual(contradictions, [],
    `These are documented as deliberately unexposed but the MCP surface routes to them: ${contradictions.join(', ')}. ` +
    'Either drop the exemption row or drop the route.');
});

test('every UNEXPOSED_ENGINE_ACTIONS entry carries a real reason', () => {
  for (const [action, reason] of Object.entries(UNEXPOSED_ENGINE_ACTIONS)) {
    assert.ok(typeof reason === 'string' && reason.length >= 60,
      `UNEXPOSED_ENGINE_ACTIONS['${action}'] needs a substantive reason (>=60 chars), got ${JSON.stringify(reason)}.`);
    assert.doesNotMatch(reason, /\b(TODO|later|for now|not yet|temporar)/i,
      `UNEXPOSED_ENGINE_ACTIONS['${action}'] reads as a deferral, not a decision: ${JSON.stringify(reason)}. ` +
      'If it should be exposed, expose it — an exemption is not a backlog.');
  }
});

// ── 2. MCP → ENGINE (covers the enum-less intent tools) ──────────────

test('every action the Meta MCP surface routes to exists in main.go', { skip: SKIP_NO_ENGINE }, () => {
  const offenders = [];
  for (const action of [...mcpReachableEngineActions()].sort()) {
    if (!GO_CASES.has(action)) offenders.push(action);
  }
  assert.deepStrictEqual(offenders, [],
    'MCP routes to engine actions that do not exist — every call returns "unknown action":\n  ' +
    offenders.join('\n  ') + '\n' +
    'This is the meta-adlib bug class (shipped 2026-05-10, broken until 2026-07-26).');
});

test('meta-adlib is gone from every Meta surface', () => {
  // Anchor the specific incident. The engine never had this action; both the
  // meta_ads enum and the meta_research_competitor_ads intent tool used to
  // name it. Re-introducing either spelling is a silent outage.
  assert.ok(!META_ADS_ENUM.includes('adlib'),
    'meta_ads action enum still contains "adlib" — main.go has no case "meta-adlib" and never has.');
  assert.ok(!INTENT_ACTIONS.has('meta-adlib'),
    'an intent tool still calls runBinary(ctx, "meta-adlib") — that action does not exist in the engine.');
  assert.match(MCP_INTENT_SRC, /runBinary\(ctx, 'competitor-scan'/,
    'meta_research_competitor_ads must route to the real "competitor-scan" action.');
});

test('competitor-scan callers declare the params the engine actually reads', { skip: SKIP_NO_ENGINE }, () => {
  // runCompetitorScan fatals without cmd.BlogBody, and defineTool's strict
  // unknown-key check refuses fields that are not declared — so a surface
  // offering this action without blogBody declared cannot ever succeed.
  // meta_research_competitor_ads translates friendly params to blogBody in its
  // handler; the dashboard tool declares blogBody directly.
  assert.match(MCP_INTENT_SRC, /blogBody: names\.join\(','\)/,
    'meta_research_competitor_ads must translate competitor names into the engine\'s blogBody wire field.');
  assert.match(MCP_TOOLS_SRC, /blogBody: z\.string\(\)\.optional\(\)\.describe\('For competitor-scan/,
    'the dashboard tool exposes action:"competitor-scan" and must declare blogBody, or every call is refused as an unknown field.');
});

// ── 3. meta_audit routing table integrity ────────────────────────────

test('every meta_audit enum value has a META_AUDIT_ACTION_MAP row', () => {
  const missing = META_AUDIT_ENUM.filter((a) => !Object.prototype.hasOwnProperty.call(META_AUDIT_ACTION_MAP, a));
  assert.deepStrictEqual(missing, [],
    `meta_audit enum values with no META_AUDIT_ACTION_MAP row: ${missing.join(', ')}. ` +
    'Unmapped values fall through to "meta-<value>", which is right by accident at best and wrong for ' +
    'any action whose engine case is spelled differently (list-catalog-sets, resolve-geo, aware-audience).');
});

test('META_AUDIT_ACTION_MAP has no rows for actions the enum dropped', () => {
  const orphans = Object.keys(META_AUDIT_ACTION_MAP).filter((a) => !META_AUDIT_ENUM.includes(a));
  assert.deepStrictEqual(orphans, [],
    `META_AUDIT_ACTION_MAP maps actions that are no longer in the meta_audit enum: ${orphans.join(', ')}.`);
});

test('mcp-action-go-parity.test.js meta_audit actionMap agrees with META_AUDIT_ACTION_MAP', () => {
  // Two tables describing one routing decision. They only stay honest if a
  // mismatch fails. Only the non-prefix rows need to appear in the parity
  // table (it derives the rest from `prefix`), so check that direction.
  const parityBlock = PARITY_TEST_SRC.slice(
    PARITY_TEST_SRC.indexOf("{ name: 'meta_audit'"),
    PARITY_TEST_SRC.indexOf("{ name: 'google_analytics'"),
  );
  assert.ok(parityBlock.length > 0, 'could not locate the meta_audit row in mcp-action-go-parity.test.js');
  for (const [action, engine] of Object.entries(META_AUDIT_ACTION_MAP)) {
    if (engine === 'meta-' + action) continue; // derivable from the prefix
    assert.ok(
      parityBlock.includes(`'${action}'`) && parityBlock.includes(`'${engine}'`),
      `mcp-action-go-parity.test.js's meta_audit actionMap is missing '${action}' → '${engine}'. ` +
      'Without the row the parity test computes "meta-' + action + '", which is not a real case, and fails ' +
      'with a confusing message pointing at main.go instead of at this table.',
    );
  }
});

// ── 4. Named anchors for the actions from this incident ──────────────

test('the account-inventory reads are reachable through meta_audit', () => {
  // Spelled out one by one so a regression names the exact capability lost,
  // rather than a set-difference the next reader has to interpret.
  const expected = {
    'list-adsets':       'meta-list-adsets',
    'list-ads':          'meta-list-ads',
    'inspect-adset':     'meta-inspect-adset',
    'list-videos':       'meta-list-videos',
    'list-catalog-sets': 'meta-catalog-sets',
    'resolve-geo':       'meta-geo-resolve',
    'aware-audience':    'aware-audience',
  };
  for (const [action, engine] of Object.entries(expected)) {
    assert.ok(META_AUDIT_ENUM.includes(action),
      `meta_audit lost the "${action}" action — the engine action ${engine} becomes unreachable again.`);
    assert.equal(metaAuditEngineAction(action), engine,
      `meta_audit "${action}" must route to engine action "${engine}".`);
  }
});

test('meta_audit exposes the params its new reads require', () => {
  // Same failure mode as the 2026-07-25 param incident: an action that is
  // reachable but whose required arg is undeclared is still unusable.
  // list-ads needs targetAdSetId, resolve-geo needs geoRegions, and
  // list-adsets needs status to accept "paused" (locating a staged draft).
  const auditBlock = MCP_TOOLS_SRC.slice(
    MCP_TOOLS_SRC.indexOf("name: 'meta_audit'"),
    MCP_TOOLS_SRC.indexOf("name: 'google_analytics'"),
  );
  assert.ok(auditBlock.length > 0, 'could not locate the meta_audit tool block');
  assert.match(auditBlock, /targetAdSetId: z\.string\(\)/,
    'meta_audit must declare targetAdSetId or list-ads has no way to name its ad set.');
  assert.match(auditBlock, /geoRegions: z\.array\(z\.string\(\)\)/,
    'meta_audit must declare geoRegions or resolve-geo has nothing to resolve.');
  assert.match(auditBlock, /status: z\.enum\(\['active', 'paused', 'all'\]\)/,
    'meta_audit status must accept "paused" — finding a STAGED ad set is the point of list-adsets.');
});

test('the write actions from this incident are reachable as intent tools', () => {
  for (const action of ['meta-rename-ads', 'meta-edit-link', 'meta-create-audience']) {
    assert.ok(INTENT_ACTIONS.has(action),
      `no intent tool routes to ${action} — it went back to being unreachable.`);
  }
});

// ── 5. End-to-end: the newly-wired tools actually reach the engine ────
//
// Everything above is static analysis. These drive the REAL registered
// handlers and read the --cmd JSON the engine would receive, which is the only
// way to prove the whole chain (schema declaration → strict unknown-key check
// → arg copy → binary invocation) holds. A tool can be perfectly declared and
// still unreachable if any link drops the field.

function makeZ() {
  const node = (extra = {}) => {
    const self = {
      ...extra,
      optional: () => node(extra),
      describe: () => node(extra),
      default: () => node(extra),
      regex: () => node(extra),
      int: () => node(extra),
      // safeParse is what defineTool's coerceArgsToSchema calls; passing the
      // value through unchanged keeps this stub out of the assertions' way.
      safeParse: (v) => ({ success: true, data: v }),
    };
    return self;
  };
  return {
    string: () => node(), number: () => node(), boolean: () => node({ __kind: 'boolean' }),
    any: () => node(), enum: (vals) => node({ __enum: vals }),
    coerce: { number: () => node() },
    array: (item) => node({ __item: item }),
    object: (shape) => node({ __shape: shape }),
    record: () => node(),
  };
}

function makeCtx() {
  return {
    getConnections: () => [],
    readConfig: () => ({ metaAccessToken: 'x' }),
    readBrandConfig: () => ({ metaAccessToken: 'x' }),
    buildStrictBrandConfig: () => ({ metaAccessToken: 'x' }),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => __filename, // any real path; execFile is stubbed
    appRoot: path.join(APP_DIR, '..'),
    isBinaryTooOld: () => false,
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
  };
}

const TOOLS = (() => {
  const entries = [];
  buildTools((name, description, schema, handler, options) => {
    entries.push({ name, description, schema, handler, options });
    return { name };
  }, makeZ(), makeCtx());
  return entries;
})();

function tool(name) {
  const t = TOOLS.find((e) => e.name === name);
  assert.ok(t, `tool ${name} must be registered`);
  return t;
}

function lastCmd() {
  const call = execFileCalls[execFileCalls.length - 1];
  assert.ok(call, 'execFile must have been invoked — the handler never reached the binary');
  const i = call.args.indexOf('--cmd');
  assert.ok(i >= 0, '--cmd must be passed to the binary');
  return JSON.parse(call.args[i + 1]);
}

test('meta_audit list-adsets reaches the engine with its status filter', async () => {
  execFileCalls.length = 0;
  await tool('meta_audit').handler({ action: 'list-adsets', brand: 'acme', status: 'paused' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-list-adsets');
  assert.equal(cmd.status, 'paused',
    'status must survive to the engine — without it runMetaListAdSets returns ACTIVE only and a staged draft stays invisible.');
});

test('meta_audit list-ads sends targetAdSetId', async () => {
  execFileCalls.length = 0;
  await tool('meta_audit').handler({ action: 'list-ads', brand: 'acme', targetAdSetId: '120210000000000000' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-list-ads');
  assert.equal(cmd.targetAdSetId, '120210000000000000');
});

// ── 5b. RETURN-path reachability (2026-08-07) ────────────────────────
//
// Rule 23 has a return path, and it fails the same silent way. meta-list-ads
// now emits links[] / linkCount (every destination an ad points at, including
// the placement-customized creatives whose URL lives in asset_feed_spec) and
// urlTags (the ad's UTM string). A field the engine emits but this surface
// never names is unreachable in practice: nothing errors, the agent simply
// never asks for it and keeps answering destination questions from
// inspect-adset's ONE-creative sample.
//
// Incident: a 404 sweep of NORTHWIND's live account read 16 of 62 active ads and
// reported a clean bill of health, because the other 46 came back with an empty
// link and an empty link reads as "nothing to check". The same pass found 10 of
// 11 active ad sets with url_tags absent, which breaks Triple Whale attribution
// and had no per-ad surface at all.
//
// Go half: autocmo-core/meta_ad_destination_test.go
// (TestListAdsResponseFieldsAreDeclaredOnTheMCPSurface) asserts the mirror
// image. Rename a field and both files change in the same PR.

const LIST_ADS_RESPONSE_FIELDS = ['links', 'linkCount', 'urlTags'];

test('meta_audit declares the destination + UTM fields list-ads returns', () => {
  const auditBlock = MCP_TOOLS_SRC.slice(
    MCP_TOOLS_SRC.indexOf("name: 'meta_audit'"),
    MCP_TOOLS_SRC.indexOf("name: 'google_analytics'"),
  );
  assert.ok(auditBlock.length > 0, 'could not locate the meta_audit tool block');
  for (const field of LIST_ADS_RESPONSE_FIELDS) {
    assert.ok(auditBlock.includes(field),
      `meta_audit never mentions "${field}" — meta-list-ads emits it and the agent will never know to read it. This is the return-path half of the meta-list-adsets bug class.`);
  }
  assert.match(auditBlock, /inspect-adset only ever samples ONE creative/,
    'the description must steer destination/UTM audits to list-ads — routing them to inspect-adset is what produced 26% coverage that looked like 100%.');
});

test('the engine actually emits the fields meta_audit promises', { skip: SKIP_NO_ENGINE }, () => {
  const metaGoPath = path.join(APP_DIR, '..', '..', 'autocmo-core', 'meta.go');
  if (!fs.existsSync(metaGoPath)) return;
  const src = fs.readFileSync(metaGoPath, 'utf8');
  for (const tag of ['json:"links,omitempty"', 'json:"linkCount"', 'json:"urlTags"']) {
    assert.ok(src.includes(tag),
      `autocmo-core metaAdRow no longer carries ${tag} — meta_audit advertises a field the binary does not send.`);
  }
  // linkCount 0 and urlTags "" are the FINDINGS. omitempty on either one drops
  // the key exactly when it matters, and a missing key reads as "not checked".
  for (const tag of ['json:"linkCount,omitempty"', 'json:"urlTags,omitempty"']) {
    assert.ok(!src.includes(tag),
      `${tag} would hide the zero value — a linkCount of 0 ("no readable destination") and an empty urlTags ("clicks land untagged") are the two findings this surface exists to report.`);
  }
});

test('meta_audit resolve-geo sends the geoRegions array', async () => {
  execFileCalls.length = 0;
  await tool('meta_audit').handler({ action: 'resolve-geo', brand: 'acme', geoRegions: ['Florida', 'New Jersey'] });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-geo-resolve');
  assert.deepStrictEqual(cmd.geoRegions, ['Florida', 'New Jersey']);
});

test('meta_audit aware-audience does NOT get a meta- prefix', async () => {
  // The prefix-everything fallthrough this map replaced would have produced
  // 'meta-aware-audience', which is not a case in main.go.
  execFileCalls.length = 0;
  await tool('meta_audit').handler({ action: 'aware-audience', brand: 'acme' });
  assert.equal(lastCmd().action, 'aware-audience');
});

test('meta_audit list-catalog-sets maps to the engine spelling', async () => {
  execFileCalls.length = 0;
  await tool('meta_audit').handler({ action: 'list-catalog-sets', brand: 'acme', catalogId: '1234567890' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-catalog-sets', 'the engine case is meta-catalog-sets, not meta-list-catalog-sets');
  assert.equal(cmd.catalogId, '1234567890');
});

test('meta_rename_ads sends the renameAds pairs verbatim', async () => {
  execFileCalls.length = 0;
  await tool('meta_rename_ads').handler({
    brand: 'acme',
    renameAds: [{ adId: '111', name: 'Vinny_Video04' }, { adId: '222', name: 'Static_03' }],
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-rename-ads');
  assert.deepStrictEqual(cmd.renameAds, [
    { adId: '111', name: 'Vinny_Video04' },
    { adId: '222', name: 'Static_03' },
  ]);
});

test('meta_rename_ads refuses a batch over Meta\'s 50 cap instead of truncating', async () => {
  execFileCalls.length = 0;
  const many = Array.from({ length: 51 }, (_, i) => ({ adId: String(i), name: `ad${i}` }));
  const res = await tool('meta_rename_ads').handler({ brand: 'acme', renameAds: many });
  assert.match(JSON.stringify(res).replace(/\\+"/g, '"'), /at most 50 renames/);
  assert.equal(execFileCalls.length, 0, 'an over-cap batch must not reach the binary');
});

test('meta_edit_ad_link sends adId + adLink and refuses a relative URL', async () => {
  execFileCalls.length = 0;
  await tool('meta_edit_ad_link').handler({ brand: 'acme', adId: '333', adLink: 'https://example.com/new-lp' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-edit-link');
  assert.equal(cmd.adId, '333');
  assert.equal(cmd.adLink, 'https://example.com/new-lp');

  execFileCalls.length = 0;
  const res = await tool('meta_edit_ad_link').handler({ brand: 'acme', adId: '333', adLink: '/new-lp' });
  assert.match(JSON.stringify(res).replace(/\\+"/g, '"'), /absolute http\(s\) URL/);
  assert.equal(execFileCalls.length, 0, 'a relative URL must not reach the binary');
});

test('meta_create_custom_audience defaults retention to 30 and enforces Meta\'s 180-day cap', async () => {
  execFileCalls.length = 0;
  await tool('meta_create_custom_audience').handler({ brand: 'acme', audienceName: 'Purchasers 30d' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-create-audience');
  assert.equal(cmd.audienceName, 'Purchasers 30d');
  assert.equal(cmd.audienceRetentionDays, 30,
    'an omitted window must default to 30 — the engine treats 0 as out-of-range and fatals.');

  execFileCalls.length = 0;
  const res = await tool('meta_create_custom_audience').handler({
    brand: 'acme', audienceName: 'Purchasers 365', audienceRetentionDays: 365,
  });
  assert.match(JSON.stringify(res).replace(/\\+"/g, '"'), /must be 1-180/);
  assert.equal(execFileCalls.length, 0, 'an over-cap retention window must not reach the binary');
});

// Rule 23, half (a): a param can be declared in the schema and still never
// reach the wire. audienceSource is the whole point of this tool — an
// engagement audience with no source is scoped to nothing — so assert it lands
// in the --cmd JSON rather than trusting the declaration.
// Rule 23 half (a): inputPath is the whole job here. A customer-list upload with
// no file path silently uploads nothing, so assert it lands in the --cmd JSON.
test('meta_upload_customer_list routes inputPath + name through to --cmd', async () => {
  execFileCalls.length = 0;
  await tool('meta_upload_customer_list').handler({
    brand: 'acme', inputPath: 'C:/tmp/customers.csv', audienceName: 'Customers over $100',
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-upload-customer-list');
  assert.equal(cmd.inputPath, 'C:/tmp/customers.csv',
    'inputPath must reach the binary — without it nothing is uploaded');
  assert.equal(cmd.audienceName, 'Customers over $100');
});

test('meta_upload_customer_list refuses an empty inputPath before hitting the binary', async () => {
  execFileCalls.length = 0;
  const res = await tool('meta_upload_customer_list').handler({ brand: 'acme', audienceName: 'x' });
  assert.match(JSON.stringify(res).replace(/\+"/g, '"'), /inputPath required/);
  assert.equal(execFileCalls.length, 0, 'a missing path must not reach the binary');
});

// Rule 23 both halves for Advertising Settings -> existing customers.
// The list IS the payload: an empty array is a meaningful CLEAR, and an absent
// key means report-only in the engine, so the two must stay distinguishable all
// the way into the --cmd JSON.
test('meta_set_existing_customers routes the audience list through to --cmd', async () => {
  execFileCalls.length = 0;
  await tool('meta_set_existing_customers').handler({
    brand: 'acme', existingCustomerAudienceIds: ['120248777097950637', '120248501483500637'],
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-existing-customers');
  assert.deepEqual(cmd.existingCustomerAudienceIds,
    ['120248777097950637', '120248501483500637'],
    'the audience ids must reach the binary in order and unmodified');
});

test('meta_set_existing_customers transmits an empty list as a real clear', async () => {
  execFileCalls.length = 0;
  await tool('meta_set_existing_customers').handler({ brand: 'acme', existingCustomerAudienceIds: [] });
  const cmd = lastCmd();
  assert.ok(Array.isArray(cmd.existingCustomerAudienceIds),
    'an empty array must survive the runBinary key copy — dropping it turns a CLEAR into a report-only read that would report success for a write that never happened');
  assert.equal(cmd.existingCustomerAudienceIds.length, 0);
});

test('meta_set_existing_customers refuses a non-array before hitting the binary', async () => {
  execFileCalls.length = 0;
  const res = await tool('meta_set_existing_customers').handler({ brand: 'acme' });
  assert.match(JSON.stringify(res), /existingCustomerAudienceIds must be an array/);
  assert.equal(execFileCalls.length, 0, 'a malformed write must not reach the binary');
});

test('meta_audit exposes the existing-customers READ and maps it to the engine action', async () => {
  execFileCalls.length = 0;
  await tool('meta_audit').handler({ brand: 'acme', action: 'existing-customers' });
  assert.equal(lastCmd().action, 'meta-existing-customers',
    'the read must route to the same engine action, without the meta- prefix fallthrough');
});

// Rule 23 for the partnership identity override. The whole point of the
// feature is that the ad publishes from someone else, so if these params are
// stripped between the tool and the binary the push silently runs under the
// BRAND identity and nobody finds out until they read the live creative.
// Rule 23 for meta-attribution-compare. The engine action shipped with no MCP
// route and sat unreachable until 2026-08-11; the suite caught it, which is
// exactly what the both-directions check is for.
test('meta_audit exposes attribution-compare and maps it to the engine action', async () => {
  execFileCalls.length = 0;
  await tool('meta_audit').handler({ brand: 'acme', action: 'attribution-compare' });
  assert.equal(lastCmd().action, 'meta-attribution-compare',
    'must map explicitly, not lean on the meta- prefix fallthrough');
});

// batchCount is the ONLY param runMetaAttributionCompare reads. Declaring the
// action without it would make the day-window form silently return lifetime.
test('meta_audit routes batchCount through to --cmd for attribution-compare', async () => {
  execFileCalls.length = 0;
  await tool('meta_audit').handler({ brand: 'acme', action: 'attribution-compare', batchCount: 30 });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-attribution-compare');
  assert.equal(cmd.batchCount, 30,
    'batchCount must reach the binary — without it every call silently reports lifetime');
});

test('meta_ads bulk-push carries the partner identity through to --cmd', async () => {
  execFileCalls.length = 0;
  await tool('meta_ads').handler({
    brand: 'acme', action: 'bulk-push', campaignName: 'C', adSetName: 'S',
    partnerPageId: '117203078065824', partnerInstagramUserId: '17841401740810477',
    ads: [{ imagePath: 'C:/tmp/a.png', name: 'a', headline: 'h', body: 'b', link: 'https://x.com' }],
  });
  const cmd = lastCmd();
  assert.equal(cmd.partnerPageId, '117203078065824',
    'partnerPageId must reach the binary — without it the ad publishes from the brand identity');
  assert.equal(cmd.partnerInstagramUserId, '17841401740810477');
});

test('meta_ads bulk-push omits partner identity when not requested', async () => {
  execFileCalls.length = 0;
  await tool('meta_ads').handler({
    brand: 'acme', action: 'bulk-push', campaignName: 'C', adSetName: 'S',
    ads: [{ imagePath: 'C:/tmp/a.png', name: 'a', headline: 'h', body: 'b', link: 'https://x.com' }],
  });
  const cmd = lastCmd();
  assert.ok(!('partnerPageId' in cmd), 'no partner identity must mean no key at all, not an empty string');
});

test('meta_create_engagement_audience routes source + event through to --cmd', async () => {
  execFileCalls.length = 0;
  await tool('meta_create_engagement_audience').handler({
    brand: 'acme', audienceName: 'IG Engagers 365d', audienceSource: 'ig',
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-create-engagement-audience');
  assert.equal(cmd.audienceName, 'IG Engagers 365d');
  assert.equal(cmd.audienceSource, 'ig',
    'audienceSource must reach the binary — without it the audience has no event source');
  assert.equal(cmd.audienceRetentionDays, 365,
    'an omitted window must default to the full year, the reason to prefer this over the pixel tool');
});

test('meta_create_engagement_audience enforces the 365-day engagement cap', async () => {
  execFileCalls.length = 0;
  const res = await tool('meta_create_engagement_audience').handler({
    brand: 'acme', audienceName: 'too long', audienceSource: 'page', audienceRetentionDays: 400,
  });
  assert.match(JSON.stringify(res).replace(/\\+"/g, '"'), /must be 1-365/);
  assert.equal(execFileCalls.length, 0, 'an over-cap retention window must not reach the binary');
});

test('meta_research_competitor_ads translates competitors[] into blogBody', async () => {
  execFileCalls.length = 0;
  await tool('meta_research_competitor_ads').handler({
    brand: 'acme', competitors: ['Madhappy', 'Pangaia'], limit: 5,
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'competitor-scan', 'must route to the real action, not the never-existing meta-adlib');
  assert.equal(cmd.blogBody, 'Madhappy,Pangaia',
    'runCompetitorScan reads the competitor list from cmd.BlogBody — an untranslated `competitors` field is dropped and the engine fatals.');
  assert.equal(cmd.imageCount, 5, 'ads-per-competitor rides on cmd.ImageCount');
  assert.ok(!('competitors' in cmd), 'the friendly param must not be forwarded — the engine has no such field');
});

test('meta_ads refuses the removed adlib action with a pointer to the replacement', async () => {
  execFileCalls.length = 0;
  const res = await tool('meta_ads').handler({ action: 'adlib', brand: 'acme' });
  const text = JSON.stringify(res).replace(/\\+"/g, '"');
  assert.match(text, /does not exist and never has/);
  assert.match(text, /meta_research_competitor_ads/, 'the refusal must name the working replacement');
  assert.equal(execFileCalls.length, 0, 'the dead action must not reach the binary');
});

// ── 6. Extraction sanity ─────────────────────────────────────────────

test('extraction found enough to be trustworthy', { skip: SKIP_NO_ENGINE }, () => {
  // If a regex breaks, every set goes empty and every assertion above passes
  // vacuously. Pin floors: main.go had 40 meta-* cases and the Meta MCP
  // surface reached 30+ engine actions on 2026-07-26.
  assert.ok(GO_CASES.size > 200, `parsed only ${GO_CASES.size} cases from main.go — extractGoCases is broken.`);
  assert.ok(metaEngineActions().size >= 35, `found only ${metaEngineActions().size} Meta engine actions — expected 35+.`);
  assert.ok(INTENT_ACTIONS.size >= 15, `found only ${INTENT_ACTIONS.size} intent-tool runBinary literals — expected 15+.`);
  assert.ok(mcpReachableEngineActions().size >= 30,
    `MCP surface reaches only ${mcpReachableEngineActions().size} engine actions — expected 30+.`);
});
