// REGRESSION GUARD (2026-08-22): TrendTrack ad-library reachability.
//
// Incident class: CLAUDE.md Rule 23. `trendtrackDiscoverAds` (autocmo-core/
// trendtrack.go) shipped a working client for TrendTrack's 250M-ad library,
// but the only callers were `palantir-ideas` and `competitor-breakdown` — and
// `palantir-ideas` has no MCP route of its own. The MCP `trendtrack` tool
// exposed exactly two actions, status and verify-key. Net effect: an agent
// asked for a competitor's ads and Merlin silently could not produce one,
// with no error anywhere. Nothing in a type system spans the two repos.
//
// A second, quieter instance sat in the same tool: `runTrendtrackVerifyKey`
// reads the key from `Command.APIKey`, and the schema declared no `apiKey`
// param. Zod strips undeclared keys, so verify-key ALWAYS reported
// "API key is empty" — a permanently failing action that looked like a bad
// key rather than a missing param.
//
// What this file locks, in BOTH directions:
//   1. Every `case "trendtrack-*"` in main.go is in the MCP action enum
//      (catches shipped-but-unreachable — the direction the older
//      mcp-action-go-parity test never covered).
//   2. Every enum value has a Go case (catches routes to nothing).
//   3. Every declared param name matches a real `json:"..."` tag on the Go
//      Command struct. runBinary copies arg keys onto the Command object
//      verbatim, so a rename on either side breaks the wire silently.
//   4. End-to-end: declared args actually land in the --cmd JSON, including
//      the array-valued trendtrackSearch and the apiKey that verify-key needs.
//   5. The actions are brand-optional. One workspace-wide key, keyed on the
//      COMPETITOR, so requiring the user's own brand would be a false gate.
//
// CI runs this with no `npm install`: Node stdlib plus in-file stubs only.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// ── execFile capture (must be patched before requiring mcp-tools) ─────
const childProcess = require('child_process');
const execFileCalls = [];
childProcess.execFile = function fakeExecFile(file, args, options, callback) {
  execFileCalls.push({ file, args, options });
  const child = { stdin: { on() {}, write() {}, end() {} }, kill() {} };
  setImmediate(() => callback(null, 'ok', ''));
  return child;
};

const { buildTools } = require('./mcp-tools');

function makeZ() {
  const node = (extra = {}) => ({
    ...extra,
    optional: () => node(extra),
    describe: () => node(extra),
    default: () => node(extra),
    regex: () => node(extra),
    int: () => node(extra),
  });
  return {
    string: () => node(), number: () => node(), boolean: () => node(),
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
    readConfig: () => ({ trendtrackApiKey: 'x' }),
    readBrandConfig: () => ({ trendtrackApiKey: 'x' }),
    buildStrictBrandConfig: () => ({ trendtrackApiKey: 'x' }),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => __filename,
    appRoot: path.join(__dirname, '..'),
    isBinaryTooOld: () => false,
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
  };
}

function registry() {
  const entries = [];
  const tool = (name, description, schema, handler, options) => {
    entries.push({ name, description, schema, handler, options });
    return { name };
  };
  buildTools(tool, makeZ(), makeCtx());
  return entries;
}

const TOOLS = registry();
const TRENDTRACK = TOOLS.find((t) => t.name === 'trendtrack');
assert.ok(TRENDTRACK, 'trendtrack tool must be registered');
const ENUM = TRENDTRACK.schema.action.__enum;

// ── Go source (sibling private repo; absent in public-repo CI) ────────
const MAIN_GO_PATH = path.join(__dirname, '..', '..', 'autocmo-core', 'main.go');
let MAIN_GO = null;
try { MAIN_GO = fs.readFileSync(MAIN_GO_PATH, 'utf8'); } catch { MAIN_GO = null; }
const GO_SKIP = !MAIN_GO && 'autocmo-core sibling repo not present (public-repo CI)';

const GO_TRENDTRACK_ACTIONS = MAIN_GO
  ? [...new Set([...MAIN_GO.matchAll(/case\s+"(trendtrack-[a-z0-9-]+)"\s*:/g)].map((m) => m[1]))]
  : [];

// ── 1. Engine → MCP: nothing ships unreachable ────────────────────────
test('every trendtrack-* engine action is exposed in the MCP enum', { skip: GO_SKIP }, () => {
  assert.ok(GO_TRENDTRACK_ACTIONS.length >= 4,
    `expected at least 4 trendtrack cases in main.go, found ${GO_TRENDTRACK_ACTIONS.length} — the extraction regex is probably broken`);
  const missing = GO_TRENDTRACK_ACTIONS
    .map((a) => a.replace(/^trendtrack-/, ''))
    .filter((a) => !ENUM.includes(a));
  assert.deepEqual(missing, [],
    `Engine actions with no MCP route: ${missing.join(', ')}.\n` +
    'A capability is not shipped until it is reachable (CLAUDE.md Rule 23). Add each to the ' +
    'trendtrack tool action enum in mcp-tools.js, WITH its required params, in the same PR — ' +
    'or write an explicit exemption here explaining why it stays engine-internal.');
});

// ── 2. MCP → engine: no route to a nonexistent action ─────────────────
test('every trendtrack MCP action has a Go switch case', { skip: GO_SKIP }, () => {
  const missing = ENUM.filter((a) => !GO_TRENDTRACK_ACTIONS.includes(`trendtrack-${a}`));
  assert.deepEqual(missing, [],
    `MCP actions routing to a case that does not exist in main.go: ${missing.join(', ')}. ` +
    'This is the meta-adlib failure mode: every call returns "unknown action".');
});

test('discover-ads and download-ad are both exposed', () => {
  for (const a of ['status', 'verify-key', 'discover-ads', 'download-ad']) {
    assert.ok(ENUM.includes(a), `trendtrack action enum is missing "${a}"`);
  }
});

// ── 3. Param spelling matches the Go json tags ────────────────────────
test('every declared trendtrack param matches a Command json tag in main.go', { skip: GO_SKIP }, () => {
  // `brand` is consumed by runBinary for config resolution, never forwarded
  // as a Command field; `action` is set separately; idempotencyKey / preview /
  // confirm_token are MCP-only and stripped by runBinary before the spawn.
  const EXEMPT = new Set(['action', 'brand', 'idempotencyKey', 'preview', 'confirm_token']);
  const goTags = new Set([...MAIN_GO.matchAll(/json:"([A-Za-z0-9_]+)[,"]/g)].map((m) => m[1]));
  const offenders = Object.keys(TRENDTRACK.schema)
    .filter((k) => !EXEMPT.has(k))
    .filter((k) => !goTags.has(k));
  assert.deepEqual(offenders, [],
    `trendtrack params with no matching Command json tag: ${offenders.join(', ')}. ` +
    'runBinary copies arg keys verbatim onto the Command object, so a spelling drift is ' +
    'a silently dropped field, not a compile error.');
});

// ── 4. End-to-end: declared args reach the --cmd JSON ─────────────────
function lastCmd() {
  const call = execFileCalls[execFileCalls.length - 1];
  assert.ok(call, 'execFile was never invoked — runBinary refused before spawning');
  const i = call.args.indexOf('--cmd');
  assert.ok(i !== -1, '--cmd not present in argv');
  return JSON.parse(call.args[i + 1]);
}

test('discover-ads forwards search filters to the engine', async () => {
  execFileCalls.length = 0;
  await TRENDTRACK.handler({
    action: 'discover-ads',
    trendtrackSearch: ['courtyard.io', 'arenaclub.com'],
    trendtrackSearchType: 'domain',
    trendtrackMediaType: 'image',
    trendtrackSortBy: 'reach',
    limit: 5,
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'trendtrack-discover-ads');
  assert.deepEqual(cmd.trendtrackSearch, ['courtyard.io', 'arenaclub.com']);
  assert.equal(cmd.trendtrackSearchType, 'domain');
  assert.equal(cmd.trendtrackMediaType, 'image');
  assert.equal(cmd.trendtrackSortBy, 'reach');
  assert.equal(cmd.limit, 5);
});

test('download-ad forwards adId to the engine', async () => {
  execFileCalls.length = 0;
  await TRENDTRACK.handler({ action: 'download-ad', adId: 'tt_12345' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'trendtrack-download-ad');
  assert.equal(cmd.adId, 'tt_12345');
});

test('verify-key forwards apiKey — the action was permanently broken without it', async () => {
  execFileCalls.length = 0;
  await TRENDTRACK.handler({ action: 'verify-key', apiKey: 'tt-test-key' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'trendtrack-verify-key');
  assert.equal(cmd.apiKey, 'tt-test-key',
    'runTrendtrackVerifyKey reads Command.APIKey; without this param it always reports "API key is empty"');
});

// ── 5. Brand-optional ─────────────────────────────────────────────────
test('trendtrack actions run without a brand', async () => {
  for (const action of ['status', 'verify-key', 'discover-ads', 'download-ad']) {
    execFileCalls.length = 0;
    const res = await TRENDTRACK.handler({ action, adId: 'x', apiKey: 'k', trendtrackSearch: ['x.com'] });
    assert.ok(execFileCalls.length > 0,
      `trendtrack-${action} was refused for a missing brand. The TrendTrack key is workspace-wide ` +
      'and the query is keyed on the COMPETITOR, so add the action to BRAND_OPTIONAL_ACTIONS in mcp-tools.js. ' +
      `Refusal text: ${res && res.content && JSON.stringify(res.content).slice(0, 200)}`);
  }
});
