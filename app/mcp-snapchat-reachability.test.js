// REGRESSION GUARD (2026-10-09, Hard-Won Rule 23): Snapchat connector
// reachability, both directions, plus the brand-scope mirror and the tile
// availability gate.
//
// The Snapchat engine actions live in autocmo-core/snapchat.go and are routed
// by `case "snapchat-<x>":` in main.go. Nothing in a type system spans the two
// repos, so this file asserts:
//   (1) engine -> MCP: every snapchat-* engine action is reachable (the
//       snapchat tool enum, or platform_login for snapchat-login);
//   (2) MCP -> engine: every snapchat tool action routes to a real case;
//   (3) every declared param is read from a real Command json tag, and the
//       args land in the --cmd JSON end to end;
//   (4) kill + activate card (Rule 19) and the reads do not;
//   (5) BRAND_KEYS (main.js) and brandScopedKeys (vault.go) agree on every
//       snapchat key;
//   (6) the tile is gated on the BFF-delivered client_id, not hard-stubbed,
//       and a click while unavailable explains itself instead of doing nothing.
//
// Harness mirrors mcp-openai-ads-reachability.test.js (Node stdlib plus
// in-file stubs, no real zod).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const childProcess = require('child_process');
const execFileCalls = [];
childProcess.execFile = function fakeExecFile(file, args, options, callback) {
  execFileCalls.push({ file, args, options });
  const child = { stdin: { on() {}, write() {}, end() {} }, kill() {} };
  setImmediate(() => callback(null, 'ok', ''));
  return child;
};

const { buildTools } = require('./mcp-tools');
const approvalPolicy = require('./mcp-approval-policy');

function makeRecordingZ() {
  const node = (extra = {}) => ({
    ...extra,
    optional: () => node(extra),
    describe: () => node(extra),
    default: () => node(extra),
    regex: () => node(extra),
    int: () => node(extra),
  });
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
    readConfig: () => ({ snapchatAccessToken: 'x' }),
    readBrandConfig: () => ({ snapchatAccessToken: 'x' }),
    buildStrictBrandConfig: () => ({ snapchatAccessToken: 'x' }),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => __filename,
    appRoot: path.join(__dirname, '..'),
    isBinaryTooOld: () => false,
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
  };
}

const TOOLS = (() => {
  const entries = [];
  const tool = (name, description, schema, handler, options) => {
    entries.push({ name, description, schema, handler, options });
    return { name };
  };
  buildTools(tool, makeRecordingZ(), makeCtx());
  return entries;
})();
const byName = (n) => {
  const t = TOOLS.find((e) => e.name === n);
  assert.ok(t, `tool ${n} must be registered`);
  return t;
};

function lastCmd() {
  const call = execFileCalls[execFileCalls.length - 1];
  assert.ok(call, 'execFile must have been invoked');
  const i = call.args.indexOf('--cmd');
  assert.ok(i >= 0, '--cmd must be passed to the binary');
  return JSON.parse(call.args[i + 1]);
}

// The engine lives in the private sibling repo; skip the cross-repo checks in
// a shipped install where it is absent.
function coreFile(name) {
  const candidates = [
    path.join(__dirname, '..', '..', 'autocmo-core', name),
    path.join(__dirname, '..', '..', '..', 'autocmo-core', name),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  return found ? fs.readFileSync(found, 'utf8') : null;
}
const MAIN_GO = coreFile('main.go');
const VAULT_GO = coreFile('vault.go');

function engineSnapchatActions() {
  return [...new Set((MAIN_GO.match(/case\s+"snapchat-[a-z-]+"/g) || [])
    .map((s) => s.match(/"([^"]+)"/)[1]))].sort();
}

const TOOL_ACTIONS = byName('snapchat').schema.action.__enum;

test('snapchat tool exposes exactly the read + status-flip surface (no creation push)', () => {
  assert.deepEqual([...TOOL_ACTIONS].sort(), ['activate', 'ad-accounts', 'campaigns', 'insights', 'kill', 'status']);
  assert.ok(!TOOL_ACTIONS.includes('push'), 'creation push is a listed follow-up, not shipped');
});

test('engine -> MCP: every snapchat-* engine action is reachable', () => {
  if (!MAIN_GO) return;
  const engine = engineSnapchatActions();
  assert.ok(engine.length >= 7, `expected the 7 snapchat-* cases in main.go, got ${engine.join(', ')}`);
  const loginEnum = byName('platform_login').schema.platform.__enum;
  for (const action of engine) {
    if (action === 'snapchat-login') {
      assert.ok(loginEnum.includes('snapchat'), 'snapchat-login must be reachable via platform_login');
      continue;
    }
    const short = action.replace(/^snapchat-/, '');
    assert.ok(TOOL_ACTIONS.includes(short), `${action} has no MCP route (snapchat tool enum lacks '${short}')`);
  }
});

test('MCP -> engine: every snapchat tool action routes to a real case', () => {
  if (!MAIN_GO) return;
  const engine = engineSnapchatActions();
  for (const short of TOOL_ACTIONS) {
    assert.ok(engine.includes('snapchat-' + short), `snapchat tool action '${short}' routes to a missing engine case`);
  }
});

test('every declared snapchat param maps to a real Command json tag', () => {
  if (!MAIN_GO) return;
  const schema = byName('snapchat').schema;
  // defineTool adds transport keys (idempotencyKey) that never reach the engine.
  const transport = new Set(['action', 'brand', 'idempotencyKey']);
  for (const key of Object.keys(schema)) {
    if (transport.has(key)) continue;
    assert.ok(new RegExp(`json:"${key}(,omitempty)?"`).test(MAIN_GO), `snapchat.${key} is declared but no Command field reads it`);
  }
});

test('insights window, level and campaign reach the engine through the handler', async () => {
  execFileCalls.length = 0;
  await byName('snapchat').handler({
    action: 'insights', brand: 'apotheke', level: 'adsquad',
    startDate: '2026-09-27', endDate: '2026-10-03', campaignId: 'c1',
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-insights');
  assert.equal(cmd.level, 'adsquad');
  assert.equal(cmd.startDate, '2026-09-27');
  assert.equal(cmd.endDate, '2026-10-03');
  assert.equal(cmd.campaignId, 'c1');
});

test('ad-accounts switch id and kill approval reach the engine', async () => {
  execFileCalls.length = 0;
  await byName('snapchat').handler({ action: 'ad-accounts', brand: 'apotheke', snapchatAdAccountId: 'acct-1' });
  let cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-ad-accounts');
  assert.equal(cmd.snapchatAdAccountId, 'acct-1');

  await byName('snapchat').handler({ action: 'kill', brand: 'apotheke', campaignId: 'c1', approved: true });
  cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-kill');
  assert.equal(cmd.campaignId, 'c1');
  assert.equal(cmd.approved, true);
});

test('kill and activate always card; reads never do (Rule 19)', () => {
  for (const action of ['kill', 'activate']) {
    const { effectiveAction } = approvalPolicy.resolveMerlinAction('mcp__merlin__snapchat', { action });
    assert.ok(approvalPolicy.SPEND_ACTIONS.has(effectiveAction), `snapchat ${action} must route through the approval card`);
  }
  for (const action of ['status', 'ad-accounts', 'campaigns', 'insights']) {
    const { effectiveAction } = approvalPolicy.resolveMerlinAction('mcp__merlin__snapchat', { action });
    assert.ok(!approvalPolicy.SPEND_ACTIONS.has(effectiveAction), `snapchat ${action} is a read and must not card`);
  }
  const ann = (byName('snapchat').options || {}).annotations || {};
  assert.equal(ann.destructive, true, 'snapchat must be marked destructive');
  assert.equal(ann.costImpact, 'spend', 'snapchat must declare costImpact spend');
});

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('BRAND_KEYS and Go brandScopedKeys agree on every snapchat key', () => {
  const m = MAIN_JS.match(/const BRAND_KEYS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, 'BRAND_KEYS must be present in main.js');
  const jsSide = (m[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)).filter((k) => k.startsWith('snapchat')).sort();
  assert.deepEqual(jsSide, ['snapchatAccessToken', 'snapchatAdAccountId', 'snapchatOrganizationId', 'snapchatRefreshToken', 'snapchatTokenExpiresAt']);
  if (!VAULT_GO) return;
  const g = VAULT_GO.match(/var brandScopedKeys = map\[string\]bool\{([\s\S]*?)\n\}/);
  assert.ok(g, 'brandScopedKeys must be present in vault.go');
  const body = g[1].split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const goSide = (body.match(/"([^"]+)"\s*:/g) || []).map((s) => s.match(/"([^"]+)"/)[1]).filter((k) => k.startsWith('snapchat')).sort();
  assert.deepEqual(goSide, jsSide, 'BRAND_KEYS and brandScopedKeys drifted on snapchat keys');
});

test('snapchat tokens are vault-sensitive in oauth-persist', () => {
  const { VAULT_SENSITIVE_KEYS } = require('./oauth-persist');
  const has = (k) => (VAULT_SENSITIVE_KEYS.has ? VAULT_SENSITIVE_KEYS.has(k) : VAULT_SENSITIVE_KEYS.includes(k));
  for (const k of ['snapchatAccessToken', 'snapchatRefreshToken']) assert.ok(has(k), `${k} must be vault-sensitive`);
});

test('snapchat tile is gated on the BFF client_id, not hard-stubbed', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const tile = html.match(/<button[^>]*data-platform="snapchat"[^>]*>/);
  assert.ok(tile, 'snapchat tile must exist');
  assert.match(tile[0], /data-needs-client-id="true"/);
  assert.doesNotMatch(tile[0], /data-stubbed/);
  assert.match(MAIN_JS, /NEEDS_CLIENT_ID_PROVIDERS\s*=\s*\[[^\]]*'snapchat'/);
  assert.match(MAIN_JS, /ipcMain\.handle\('get-oauth-availability'/);
  const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  assert.match(preload, /getOAuthAvailability:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('get-oauth-availability'\)/);
});

test('availability IPC returns booleans only, never the client_id', () => {
  const m = MAIN_JS.match(/function getOAuthAvailability\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'getOAuthAvailability must exist in main.js');
  assert.match(m[1], /out\[p\]\s*=\s*!!vaultGet\('_global',\s*'_oauthcreds_'\s*\+\s*p\s*\+\s*'_clientID'\)/);
});

test('a click on an unavailable needs-client-id tile explains itself (not a dead click)', () => {
  const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  const click = renderer.match(/document\.addEventListener\('click', async \(e\) => \{\s*const tile = e\.target\.closest\('\.magic-tile'\);\s*if \(!tile\) return;([\s\S]{0,600})/);
  assert.ok(click, 'tile click handler must exist');
  const awaitIdx = click[1].indexOf('isAwaitingClientId(tile)');
  const stubIdx = click[1].indexOf('isStubbedTile(tile)');
  assert.ok(awaitIdx >= 0 && awaitIdx < stubIdx, 'the client-id check must run before the silent stub return');
  assert.match(click[1], /showToast\(/);
  assert.match(renderer, /isn't available yet/);
  // isStubbedTile must treat an awaiting tile as unavailable at every other site.
  assert.match(renderer, /function isStubbedTile\(tile\)\s*\{\s*return !!\(tile && tile\.dataset && \(tile\.dataset\.stubbed === 'true' \|\| isAwaitingClientId\(tile\)\)\);/);
});
