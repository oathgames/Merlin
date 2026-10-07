// Google Ads customer-exclusion reachability, Hard-Won Rule 23.
//
// The engine actions google-ads-audiences and google-ads-exclude-audience
// (autocmo-core/googleads_audiences.go) and the excludeUserListIds field on
// google-ads-search-create read Command fields by their Go `json:"..."` tags.
// runBinary copies MCP arg keys onto the Command verbatim and zod strips
// anything undeclared, so every key must be DECLARED on google_ads with the
// exact Go spelling and must land in the --cmd JSON. The Go half of this pact
// is TestGoogleAdsExcludeAudience_WireTags in googleads_audiences_test.go.
//
// Also pins the approval routing (Rule 19): exclude-audience changes who live
// campaigns reach, so it cards (destructive, not spend), while the audiences
// read stays uncarded and cannot carry a write because the handler strips
// approved / force.
//
// Stdlib only (CI runs app tests without npm install).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
const policy = require('./mcp-approval-policy');

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
    readConfig: () => ({ googleAccessToken: 'x', maxDailyAdBudget: 500 }),
    readBrandConfig: () => ({ googleAccessToken: 'x', maxDailyAdBudget: 500 }),
    buildStrictBrandConfig: () => ({ googleAccessToken: 'x', maxDailyAdBudget: 500 }),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => __filename,
    appRoot: path.join(__dirname, '..'),
    isBinaryTooOld: () => false,
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
  };
}

function googleAds() {
  const entries = [];
  const tool = (name, description, schema, handler, options) => {
    entries.push({ name, description, schema, handler, options });
    return { name };
  };
  buildTools(tool, makeRecordingZ(), makeCtx());
  const t = entries.find((e) => e.name === 'google_ads');
  assert.ok(t, 'google_ads must be registered');
  return t;
}

async function engineCmd(args) {
  execFileCalls.length = 0;
  await googleAds().handler(args);
  const call = execFileCalls.find((c) => c.args.includes('--cmd'));
  assert.ok(call, 'engine must be invoked');
  return JSON.parse(call.args[call.args.indexOf('--cmd') + 1]);
}

test('google_ads exposes the audiences and exclude-audience actions', () => {
  const vals = googleAds().schema.action.__enum;
  for (const a of ['audiences', 'exclude-audience']) {
    assert.ok(vals.includes(a), `google_ads action enum is missing ${a}`);
  }
});

test('google_ads declares every Command key the engine reads', () => {
  const schema = googleAds().schema;
  for (const k of ['userListId', 'campaignIds', 'excludeUserListIds', 'approved']) {
    assert.ok(Object.prototype.hasOwnProperty.call(schema, k), `google_ads is missing "${k}"`);
  }
  assert.ok(schema.excludeUserListIds.__item, 'excludeUserListIds must be declared as an array');
  assert.ok(schema.campaignIds.__item, 'campaignIds must be declared as an array');
});

test('approval policy: exclude-audience cards as destructive, audiences is a read', () => {
  assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS.has('exclude-audience'), 'exclude-audience must card');
  assert.ok(!policy.SPEND_ACTIONS.has('exclude-audience'), 'exclude-audience moves no dollars, it is not SPEND');
  assert.ok(!policy.READ_ONLY_ACTIONS.has('exclude-audience'), 'exclude-audience is a write');
  assert.ok(policy.READ_ONLY_ACTIONS.has('audiences'), 'audiences must be uncarded');
  assert.ok(!policy.SPEND_ACTIONS.has('audiences') && !policy.CARDED_DESTRUCTIVE_ACTIONS.has('audiences'));
});

test('audiences routes to google-ads-audiences and cannot carry a write', async () => {
  const cmd = await engineCmd({ action: 'audiences', brand: 'apotheke', approved: true, force: true });
  assert.equal(cmd.action, 'google-ads-audiences');
  assert.ok(!cmd.approved, 'read alias must strip approved');
  assert.ok(!cmd.force, 'read alias must strip force');
});

test('exclude-audience args land verbatim in --cmd', async () => {
  const cmd = await engineCmd({
    action: 'exclude-audience', brand: 'apotheke', userListId: '55',
    campaignIds: ['23232784050', '23232784051'], approved: true,
  });
  assert.equal(cmd.action, 'google-ads-exclude-audience');
  assert.equal(cmd.userListId, '55');
  assert.deepEqual(cmd.campaignIds, ['23232784050', '23232784051']);
  assert.equal(cmd.approved, true);
});

test('search-create excludeUserListIds lands verbatim in --cmd', async () => {
  const cmd = await engineCmd({
    action: 'search-create', brand: 'apotheke', campaignName: 'Search_NonBrand', dailyBudget: 50,
    adLink: 'https://example.com', keywords: ['luxury candles'], headlines: ['a', 'b', 'c'],
    descriptions: ['d', 'e'], excludeUserListIds: ['55', '56'], approved: true,
  });
  assert.equal(cmd.action, 'google-ads-search-create');
  assert.deepEqual(cmd.excludeUserListIds, ['55', '56']);
});
