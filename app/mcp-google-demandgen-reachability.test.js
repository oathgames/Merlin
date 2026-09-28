// Google Ads Demand Gen (YouTube Shorts) reachability, Hard-Won Rule 23.
//
// The engine action google-ads-demandgen-push reads Command fields and BulkAd
// fields by their Go `json:"..."` tags (autocmo-core/main.go, see
// googleads_demandgen.go). runBinary copies MCP arg keys onto the Command
// verbatim and zod strips anything undeclared, so every key the engine reads
// must be DECLARED on google_ads with the exact Go spelling, and must actually
// land in the --cmd JSON. The Go half of this pact is
// TestDemandGenWireContractTags in autocmo-core/googleads_demandgen_test.go.
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

function makeCtx(overrides = {}) {
  return {
    getConnections: () => [],
    readConfig: () => ({ googleAccessToken: 'x' }),
    readBrandConfig: () => ({ googleAccessToken: 'x' }),
    buildStrictBrandConfig: () => ({ googleAccessToken: 'x' }),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => __filename,
    appRoot: path.join(__dirname, '..'),
    isBinaryTooOld: () => false,
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
    ...overrides,
  };
}

function googleAds(ctx) {
  const entries = [];
  const tool = (name, description, schema, handler, options) => {
    entries.push({ name, description, schema, handler, options });
    return { name };
  };
  buildTools(tool, makeRecordingZ(), ctx || makeCtx());
  const t = entries.find((e) => e.name === 'google_ads');
  assert.ok(t, 'google_ads must be registered');
  return t;
}

const COMMAND_KEYS = ['campaignName', 'adSetName', 'targetAdSetId', 'dailyBudget', 'businessName', 'logoPath',
  'ctaType', 'youtubeChannelId', 'channels', 'geoTargetConstants', 'bidStrategy', 'targetCpa', 'campaignId', 'approved'];
const BULK_AD_KEYS = ['name', 'youtubeVideoId', 'videoPath', 'headline', 'description', 'body', 'link'];

test('google_ads exposes the Demand Gen actions', () => {
  const vals = googleAds().schema.action.__enum;
  for (const a of ['demandgen-push', 'activate', 'video-insights']) {
    assert.ok(vals.includes(a), `google_ads action enum is missing ${a}`);
  }
});

test('google_ads declares every Command key google-ads-demandgen-push reads', () => {
  const schema = googleAds().schema;
  for (const k of COMMAND_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(schema, k), `google_ads is missing "${k}"`);
  }
  const shape = schema.ads && schema.ads.__item && schema.ads.__item.__shape;
  assert.ok(shape, 'google_ads.ads must be an array of objects');
  for (const k of BULK_AD_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(shape, k), `google_ads.ads[].${k} is missing`);
  }
});

test('approval policy: demandgen-push and activate card, video-insights is read-only', () => {
  assert.ok(policy.SPEND_ACTIONS.has('demandgen-push'));
  assert.ok(policy.SPEND_ACTIONS.has('activate'));
  assert.ok(policy.READ_ONLY_ACTIONS.has('video-insights'));
});

test('demandgen-push args land verbatim in the engine --cmd JSON', async () => {
  execFileCalls.length = 0;
  const t = googleAds();
  await t.handler({
    action: 'demandgen-push', brand: 'ripit', campaignName: 'RIPIT YT', adSetName: 'Organic Winners',
    dailyBudget: 5, businessName: 'RIPIT', logoPath: '/x/logo.png', ctaType: 'SHOP_NOW',
    channels: ['youtube_shorts'], geoTargetConstants: ['2840'], bidStrategy: 'AUTO',
    ads: [{ name: 'YT_4PvMxEU1qVY', youtubeVideoId: '4PvMxEU1qVY', headline: 'h', body: 'b', link: 'https://ripit.co/packs' }],
  });
  const call = execFileCalls.find((c) => c.args.includes('--cmd'));
  assert.ok(call, 'engine must be invoked');
  const cmd = JSON.parse(call.args[call.args.indexOf('--cmd') + 1]);
  assert.equal(cmd.action, 'google-ads-demandgen-push');
  assert.equal(cmd.businessName, 'RIPIT');
  assert.equal(cmd.adSetName, 'Organic Winners');
  assert.deepEqual(cmd.channels, ['youtube_shorts']);
  assert.equal(cmd.ads[0].youtubeVideoId, '4PvMxEU1qVY');
  assert.equal(cmd.ads[0].name, 'YT_4PvMxEU1qVY');
});

test('demandgen-push with a local mp4 goes to the job path, not a 110s call', async () => {
  const started = [];
  const ctx = makeCtx({ jobStore: { start: (spec) => { started.push(spec); return { jobId: 'job-1' }; } } });
  const res = await googleAds(ctx).handler({
    action: 'demandgen-push', brand: 'ripit', campaignName: 'C', adSetName: 'Meta Winners',
    ads: [{ name: 'n', videoPath: '/x/a.mp4', headline: 'h', body: 'b', link: 'https://ripit.co' }],
  });
  assert.equal(started.length, 1, 'an upload push must start a background job');
  assert.equal(started[0].meta.action, 'google-ads-demandgen-push');
  assert.match(JSON.stringify(res), /job-1/);
});
