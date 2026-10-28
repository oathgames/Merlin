// Google Ads AI Max for Search reachability, Hard-Won Rules 19 + 23.
//
// The engine action google-ads-search-create (autocmo-core/googleads_search.go)
// reads Command fields by their Go `json:"..."` tags. runBinary copies MCP arg
// keys onto the Command verbatim and zod strips anything undeclared, so every
// key must be DECLARED on google_ads with the exact Go spelling and must land
// in the --cmd JSON. The Go half of this pact is TestSearchCreate_WireTags in
// autocmo-core/googleads_search_test.go.
//
// Also pins the approval routing (Rule 19): search-create commits a new daily
// budget, so it is a SPEND action that ALWAYS cards and is never eligible for
// the in-cap auto-approve (that path is push-only).
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

const fs = require('node:fs');

const SEARCH_KEYS = ['campaignName', 'adSetName', 'dailyBudget', 'adLink', 'keywords', 'negativeKeywords',
  'headlines', 'descriptions', 'path1', 'path2', 'targetRoas', 'finalUrlExpansion', 'brandExclusion',
  'brandListName', 'brandEntityIds', 'brandQuery', 'geoTargetConstants', 'excludeUserListIds', 'force'];

test('google_ads exposes the search-create action', () => {
  assert.ok(googleAds().schema.action.__enum.includes('search-create'), 'google_ads action enum is missing search-create');
});

test('google_ads declares every Command key google-ads-search-create reads', () => {
  const schema = googleAds().schema;
  for (const k of SEARCH_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(schema, k), `google_ads is missing "${k}"`);
  }
  for (const k of ['keywords', 'negativeKeywords', 'headlines', 'descriptions']) {
    assert.ok(schema[k].__item, `${k} must be declared as an array`);
  }
});

test('approval policy: search-create is SPEND (always cards) and never in-cap auto-approved', () => {
  assert.ok(policy.SPEND_ACTIONS.has('search-create'), 'search-create must be a SPEND action');
  assert.ok(!policy.READ_ONLY_ACTIONS.has('search-create'));
  assert.equal(policy.resolveMerlinAction('mcp__merlin__google_ads', { action: 'search-create' }).effectiveAction, 'search-create');
  // The in-cap auto-approve branch in main.js is keyed on action === 'push'
  // alone; search-create must never be added to it.
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const inCap = main.match(/if \(!requireSpendApproval && !forceRequested && capForComparison > 0 && ([^\r\n]*)/);
  assert.ok(inCap, 'in-cap auto-approve clause not found in main.js');
  assert.match(inCap[1], /^action === 'push' &&/);
  assert.ok(!inCap[1].includes('search-create'));
  assert.ok(main.includes("'search-create': { label: 'Create a Google AI Max Search campaign (starts paused)'"),
    'main.js must label the search-create approval card');
});

test('search-create args land verbatim in --cmd', async () => {
  const args = {
    action: 'search-create', brand: 'apotheke', campaignName: 'APOTHEKE | AI Max Search', adSetName: 'Candles',
    dailyBudget: 50, adLink: 'https://apothekeco.com/collections/candles',
    keywords: ['luxury candles', 'brooklyn candle'], negativeKeywords: ['cheap'],
    headlines: ['Hand Poured In Brooklyn', 'Luxury Scented Candles', 'Shop The Collection'],
    descriptions: ['Small batch candles made in Brooklyn.', 'Free shipping on orders over $75.'],
    path1: 'candles', path2: 'shop', targetRoas: 4, finalUrlExpansion: false, brandExclusion: true,
    brandListName: 'Brand Exclusions', brandEntityIds: ['111'], brandQuery: 'Apotheke', geoTargetConstants: ['2840'],
  };
  const cmd = await engineCmd(args);
  assert.equal(cmd.action, 'google-ads-search-create');
  for (const [k, v] of Object.entries(args)) {
    if (k === 'action') continue;
    assert.deepEqual(cmd[k], v, `${k} must reach the engine unchanged`);
  }
});
