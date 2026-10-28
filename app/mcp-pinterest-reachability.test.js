// REGRESSION GUARD (2026-10-09, Hard-Won Rules 19 + 23): pinterest_ads
// param reachability.
//
// The engine (autocmo-core/pinterest.go) reads Command.TargetAdSetID
// (json "targetAdSetId") for ad-group kill/activate, while the tool exposes
// the Pinterest-native name adGroupId. If that remap breaks, a "pause this
// ad group" call reaches the engine with no target and the engine refuses,
// so the capability is silently unreachable. This file asserts every engine
// param the connector reads is declared, that adGroupId lands as
// targetAdSetId in the --cmd JSON, and that the insights window and
// approval flag reach the engine under the right pinterest-* action.
//
// Harness copied from mcp-openai-ads-reachability.test.js (Node stdlib plus
// in-file stubs, no real zod, so CI runs it without npm install).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// ── execFile capture ─────────────────────────────────────────────────
//
// Patch child_process.execFile BEFORE requiring mcp-tools: the module
// destructures `const { execFile } = require('child_process')` at load time,
// so the stub has to be installed first. node:test gives each test file its
// own process, so this never leaks into another suite.
const childProcess = require('child_process');
const execFileCalls = [];
childProcess.execFile = function fakeExecFile(file, args, options, callback) {
  execFileCalls.push({ file, args, options });
  const child = {
    stdin: { on() {}, write() {}, end() {} },
    kill() {},
  };
  // Defer so the caller finishes wiring stdin before we resolve.
  setImmediate(() => callback(null, 'ok', ''));
  return child;
};

const { buildTools, runBinary } = require('./mcp-tools');

// ── Shape-recording zod stub ─────────────────────────────────────────
//
// The stub in mcp-tools.test.js throws away nested shapes, which is exactly
// why the missing ads[].name went unnoticed. This one records them so the
// assertions below can reach into `ads` array items.
function makeRecordingZ() {
  const node = (extra = {}) => {
    const self = {
      ...extra,
      optional: () => node(extra),
      describe: () => node(extra),
      default: () => node(extra),
      regex: () => node(extra),
      int: () => node(extra),
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

function makeCtx(overrides = {}) {
  return {
    getConnections: () => [],
    readConfig: () => ({ metaAccessToken: 'x' }),
    readBrandConfig: () => ({ metaAccessToken: 'x' }),
    buildStrictBrandConfig: () => ({ metaAccessToken: 'x' }),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    // Any real, existing path works: execFile is stubbed, nothing is spawned.
    getBinaryPath: () => __filename,
    appRoot: path.join(__dirname, '..'),
    isBinaryTooOld: () => false,
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
    ...overrides,
  };
}

function registry() {
  const entries = [];
  const tool = (name, description, schema, handler, options) => {
    entries.push({ name, description, schema, handler, options });
    return { name };
  };
  buildTools(tool, makeRecordingZ(), makeCtx());
  return entries;
}

const TOOLS = registry();
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

const PINTEREST_KEYS = ['campaignId', 'adGroupId', 'adId', 'level', 'days', 'startDate', 'endDate', 'status', 'approved', 'pinterestAdAccountId'];

test('pinterest_ads declares every param the engine reads', () => {
  const schema = byName('pinterest_ads').schema;
  for (const key of PINTEREST_KEYS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(schema, key),
      `pinterest_ads.${key} must be declared: zod strips what is not declared.`,
    );
  }
});

test('pinterest_ads action enum covers the shipped engine actions', () => {
  const vals = byName('pinterest_ads').schema.action.__enum;
  for (const a of ['status', 'verify', 'ad-accounts', 'campaigns', 'insights', 'kill', 'activate']) {
    assert.ok(vals.includes(a), `pinterest_ads action enum must include ${a}`);
  }
});

test('pinterest_ads kill remaps adGroupId to targetAdSetId and forwards approval', async () => {
  execFileCalls.length = 0;
  await byName('pinterest_ads').handler({
    action: 'kill',
    brand: 'apotheke',
    adGroupId: '2680000000001,2680000000002',
    approved: true,
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'pinterest-kill');
  assert.equal(cmd.targetAdSetId, '2680000000001,2680000000002', 'adGroupId must land as targetAdSetId');
  assert.ok(!('adGroupId' in cmd), 'the engine has no adGroupId field; it must not be sent raw');
  assert.equal(cmd.approved, true, 'approval flag must reach the engine');
});

// REGRESSION GUARD (2026-10-17, ad-account pick): the login note tells the
// user to switch with "the Pinterest ad-accounts action with
// pinterestAdAccountId <id>". That instruction only works if the param
// reaches the engine's Command.PinterestAdAccountID (Rules 23 + 25).
test('pinterest_ads ad-accounts forwards pinterestAdAccountId for the switch', async () => {
  execFileCalls.length = 0;
  await byName('pinterest_ads').handler({ action: 'ad-accounts', brand: 'apotheke', pinterestAdAccountId: '549755885175' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'pinterest-ad-accounts');
  assert.equal(cmd.pinterestAdAccountId, '549755885175');
});

// platform_login must relay the engine's ad-account selection note so the
// agent tells the user when Merlin may have picked another business's
// account (Snapchat / X / Pinterest logins).
// The registered handler returns the MCP text content: a summary line, a
// blank line, then the JSON envelope. Pull the envelope's data back out.
function unwrap(res) {
  const text = res.content[0].text;
  return JSON.parse(text.slice(text.indexOf('{'))).data;
}

test('platform_login relays the ad-account selection note', async () => {
  const entries = [];
  const tool = (name, description, schema, handler) => { entries.push({ name, handler }); return { name }; };
  const note = 'Merlin selected Snapchat ad account "Soothe" (s1) because its name matches this brand. This login can also see: "Unique" (u1): no campaigns.';
  buildTools(tool, makeRecordingZ(), makeCtx({
    runOAuthFlow: async () => ({ success: true, platform: 'snapchat', accountNote: note, accountVerified: false }),
  }));
  const login = entries.find((e) => e.name === 'platform_login');
  const res = unwrap(await login.handler({ platform: 'snapchat', brand: 'apotheke' }));
  assert.equal(res.success, true);
  assert.equal(res.accountVerified, false);
  assert.equal(res.accountNote, note);
  assert.ok(res.summary.includes(note), 'the note must be in the summary the agent reads');
  assert.ok(/switch/i.test(res.instructions), 'the agent must be told to offer the switch');

  const quiet = entries.length;
  buildTools(tool, makeRecordingZ(), makeCtx({ runOAuthFlow: async () => ({ success: true, platform: 'snapchat', accountVerified: true }) }));
  const res2 = unwrap(await entries.slice(quiet).find((e) => e.name === 'platform_login').handler({ platform: 'snapchat', brand: 'apotheke' }));
  assert.equal(res2.summary, 'Connected snapchat');
  assert.ok(!('accountNote' in res2));
});

// main.js must strip the selection fields before applyExchangeResult writes
// the login result into the brand config.
test('runOAuthFlow strips accountSelection fields before persisting', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = main.indexOf('async function runOAuthFlow(');
  assert.ok(start > 0);
  const end = main.indexOf('\n}\n', start);
  const body = main.slice(start, end);
  const applies = body.split('applyExchangeResult(').length - 1;
  const takes = body.split('takeAccountSelection(').length - 1;
  assert.ok(applies >= 3, 'expected the fast-open and both legacy persist sites');
  assert.equal(takes, applies, 'every applyExchangeResult in runOAuthFlow must be preceded by takeAccountSelection');
  assert.ok(/delete parsed\.accountSelectionNote/.test(main) && /delete parsed\.accountSelectionVerified/.test(main));
});

test('pinterest_ads activate forwards campaignId and adId', async () => {
  execFileCalls.length = 0;
  await byName('pinterest_ads').handler({ action: 'activate', brand: 'apotheke', campaignId: '626700000001', adId: '687000000001' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'pinterest-activate');
  assert.equal(cmd.campaignId, '626700000001');
  assert.equal(cmd.adId, '687000000001');
});

test('pinterest_ads insights window and level reach the engine', async () => {
  execFileCalls.length = 0;
  await byName('pinterest_ads').handler({
    action: 'insights',
    brand: 'apotheke',
    level: 'adgroup',
    startDate: '2026-09-27',
    endDate: '2026-10-03',
    status: 'active',
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'pinterest-insights');
  assert.equal(cmd.level, 'adgroup');
  assert.equal(cmd.startDate, '2026-09-27');
  assert.equal(cmd.endDate, '2026-10-03');
  assert.equal(cmd.status, 'active');
});

// Same gate as snapchat / quickbooks: the tile is live only once the
// BFF-delivered client_id is in the vault, otherwise it explains itself.
test('pinterest tile is gated on the BFF client_id, not hard-stubbed', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const tile = html.match(/<button[^>]*data-platform="pinterest"[^>]*>/);
  assert.ok(tile, 'pinterest tile must exist');
  assert.match(tile[0], /data-needs-client-id="true"/);
  assert.doesNotMatch(tile[0], /data-stubbed/);
  const mainJs = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.match(mainJs, /NEEDS_CLIENT_ID_PROVIDERS\s*=\s*\[[^\]]*'pinterest'/);
});
