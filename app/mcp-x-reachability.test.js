// REGRESSION GUARD (2026-10-09, Hard-Won Rule 23): X (Twitter) Ads
// connector reachability, both directions, plus the brand-scope mirror, the
// vault-sensitive token pair, the API-host blocklists and the tile
// availability gate.
//
// The engine actions live in autocmo-core/twitter_ads.go and are routed by
// `case "twitter-<x>":` in main.go. The MCP tool is named x_ads (the product
// name) while the engine keeps the twitter- prefix (Config, vault and OAuth
// provider keys already used it), so the name mismatch is exactly the kind
// of seam Rule 23 exists for. Nothing in a type system spans the two repos,
// so this file asserts:
//   (1) engine -> MCP: every twitter-* engine action is reachable (the x_ads
//       tool enum, or platform_login for twitter-login);
//   (2) MCP -> engine: every x_ads tool action routes to a real case;
//   (3) every declared param is read from a real Command json tag, and the
//       args land in the --cmd JSON end to end;
//   (4) kill + activate card (Rule 19) and the reads do not;
//   (5) BRAND_KEYS (main.js) and brandScopedKeys (vault.go) agree on every
//       twitter key, and both halves of the OAuth 1.0a pair are vaulted;
//   (6) the tile is gated on the BFF-delivered consumer key, not stubbed;
//   (7) the X Ads hosts are on both direct-call blocklists.
//
// Harness mirrors mcp-snapchat-reachability.test.js.

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
    readConfig: () => ({ twitterAccessToken: 'x' }),
    readBrandConfig: () => ({ twitterAccessToken: 'x' }),
    buildStrictBrandConfig: () => ({ twitterAccessToken: 'x' }),
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

function engineTwitterActions() {
  return [...new Set((MAIN_GO.match(/case\s+"twitter-[a-z-]+"/g) || [])
    .map((s) => s.match(/"([^"]+)"/)[1]))].sort();
}

const TOOL_ACTIONS = byName('x_ads').schema.action.__enum;

test('x_ads tool exposes exactly the read + status-flip surface (no creation push)', () => {
  assert.deepEqual([...TOOL_ACTIONS].sort(), ['activate', 'ad-accounts', 'campaigns', 'insights', 'kill', 'status']);
  assert.ok(!TOOL_ACTIONS.includes('push'), 'campaign creation is deliberately not shipped');
});

test('engine -> MCP: every twitter-* engine action is reachable', () => {
  if (!MAIN_GO) return;
  const engine = engineTwitterActions();
  assert.ok(engine.length >= 7, `expected the 7 twitter-* cases in main.go, got ${engine.join(', ')}`);
  const loginEnum = byName('platform_login').schema.platform.__enum;
  for (const action of engine) {
    if (action === 'twitter-login') {
      assert.ok(loginEnum.includes('twitter'), 'twitter-login must be reachable via platform_login');
      continue;
    }
    const short = action.replace(/^twitter-/, '');
    assert.ok(TOOL_ACTIONS.includes(short), `${action} has no MCP route (x_ads tool enum lacks '${short}')`);
  }
});

test('MCP -> engine: every x_ads tool action routes to a real case', () => {
  if (!MAIN_GO) return;
  const engine = engineTwitterActions();
  for (const short of TOOL_ACTIONS) {
    assert.ok(engine.includes('twitter-' + short), `x_ads tool action '${short}' routes to a missing engine case`);
  }
});

test('every declared x_ads param maps to a real Command json tag', () => {
  if (!MAIN_GO) return;
  const schema = byName('x_ads').schema;
  const transport = new Set(['action', 'brand', 'idempotencyKey']);
  for (const key of Object.keys(schema)) {
    if (transport.has(key)) continue;
    assert.ok(new RegExp(`json:"${key}(,omitempty)?"`).test(MAIN_GO), `x_ads.${key} is declared but no Command field reads it`);
  }
});

test('insights window, level and campaign reach the engine through the handler', async () => {
  execFileCalls.length = 0;
  await byName('x_ads').handler({
    action: 'insights', brand: 'apotheke', level: 'promoted_tweet',
    startDate: '2026-09-27', endDate: '2026-10-03', campaignId: 'c1',
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'twitter-insights');
  assert.equal(cmd.level, 'promoted_tweet');
  assert.equal(cmd.startDate, '2026-09-27');
  assert.equal(cmd.endDate, '2026-10-03');
  assert.equal(cmd.campaignId, 'c1');
});

test('ad-accounts switch id and kill approval reach the engine', async () => {
  execFileCalls.length = 0;
  await byName('x_ads').handler({ action: 'ad-accounts', brand: 'apotheke', twitterAdAccountId: '18ce54d4x5t' });
  let cmd = lastCmd();
  assert.equal(cmd.action, 'twitter-ad-accounts');
  assert.equal(cmd.twitterAdAccountId, '18ce54d4x5t');

  await byName('x_ads').handler({ action: 'kill', brand: 'apotheke', campaignId: 'c1', approved: true });
  cmd = lastCmd();
  assert.equal(cmd.action, 'twitter-kill');
  assert.equal(cmd.campaignId, 'c1');
  assert.equal(cmd.approved, true);
});

test('the engine level vocabulary matches the tool enum', () => {
  const levels = byName('x_ads').schema.level.__enum;
  assert.deepEqual([...levels].sort(), ['campaign', 'line_item', 'promoted_tweet']);
  const src = coreFile('twitter_ads.go');
  if (!src) return;
  for (const l of levels) assert.ok(src.includes(`"${l}"`), `twitter_ads.go does not accept level '${l}'`);
});

test('kill and activate always card; reads never do (Rule 19)', () => {
  for (const action of ['kill', 'activate']) {
    const { effectiveAction } = approvalPolicy.resolveMerlinAction('mcp__merlin__x_ads', { action });
    assert.ok(approvalPolicy.SPEND_ACTIONS.has(effectiveAction), `x_ads ${action} must route through the approval card`);
  }
  for (const action of ['status', 'ad-accounts', 'campaigns', 'insights']) {
    const { effectiveAction } = approvalPolicy.resolveMerlinAction('mcp__merlin__x_ads', { action });
    assert.ok(!approvalPolicy.SPEND_ACTIONS.has(effectiveAction), `x_ads ${action} is a read and must not card`);
  }
  const ann = (byName('x_ads').options || {}).annotations || {};
  assert.equal(ann.destructive, true, 'x_ads must be marked destructive');
  assert.equal(ann.costImpact, 'spend', 'x_ads must declare costImpact spend');
});

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const X_KEYS = ['twitterAccessToken', 'twitterAccessTokenSecret', 'twitterAdAccountId', 'twitterUserId'];

test('BRAND_KEYS and Go brandScopedKeys agree on every twitter key', () => {
  const m = MAIN_JS.match(/const BRAND_KEYS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, 'BRAND_KEYS must be present in main.js');
  const jsSide = (m[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)).filter((k) => k.startsWith('twitter')).sort();
  assert.deepEqual(jsSide, [...X_KEYS].sort());
  if (!VAULT_GO) return;
  const g = VAULT_GO.match(/var brandScopedKeys = map\[string\]bool\{([\s\S]*?)\n\}/);
  assert.ok(g, 'brandScopedKeys must be present in vault.go');
  const body = g[1].split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const goSide = (body.match(/"([^"]+)"\s*:/g) || []).map((s) => s.match(/"([^"]+)"/)[1]).filter((k) => k.startsWith('twitter')).sort();
  assert.deepEqual(goSide, jsSide, 'BRAND_KEYS and brandScopedKeys drifted on twitter keys');
});

test('both halves of the OAuth 1.0a token pair are vault-sensitive, and disconnect clears every key', () => {
  const { VAULT_SENSITIVE_KEYS } = require('./oauth-persist');
  const has = (k) => (VAULT_SENSITIVE_KEYS.has ? VAULT_SENSITIVE_KEYS.has(k) : VAULT_SENSITIVE_KEYS.includes(k));
  for (const k of X_KEYS) assert.ok(has(k), `${k} must be vault-sensitive`);
  const dm = MAIN_JS.match(/\n\s*twitter:\s*\[([^\]]*)\],/);
  assert.ok(dm, 'disconnect keyMap must carry a twitter entry');
  const keys = (dm[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)).sort();
  assert.deepEqual(keys, [...X_KEYS].sort());
});

test('connection status needs BOTH halves of the token pair', () => {
  assert.match(MAIN_JS, /snapResolves\(xToken, 'twitterAccessToken'\) && snapResolves\(xSecret, 'twitterAccessTokenSecret'\)/);
});

test('x tile is gated on the BFF consumer key, not hard-stubbed', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const tile = html.match(/<button[^>]*data-platform="twitter"[^>]*>/);
  assert.ok(tile, 'twitter tile must exist');
  assert.match(tile[0], /data-needs-client-id="true"/);
  assert.doesNotMatch(tile[0], /data-stubbed/);
  assert.match(MAIN_JS, /NEEDS_CLIENT_ID_PROVIDERS\s*=\s*\[[^\]]*'twitter'/);
  const cfg = require('./oauth-provider-config');
  const active = cfg.ACTIVE_PLATFORMS;
  const isActive = active && (active.has ? active.has('twitter') : active.includes('twitter'));
  assert.ok(!isActive, 'twitter must take the legacy binary-login path (OAuth 1.0a), not the PKCE fast-open path');
});

test('X Ads hosts are on both direct-call blocklists', () => {
  const hook = fs.readFileSync(path.join(__dirname, '..', '.claude', 'hooks', 'block-api-bypass.js'), 'utf8');
  for (const host of ['ads-api.x.com', 'ads-api.twitter.com']) {
    assert.ok(hook.includes(`'${host}'`), `block-api-bypass.js must block ${host}`);
    assert.ok(MAIN_JS.includes(`'${host}'`), `main.js BANNED_API_HOSTS must block ${host}`);
  }
});
