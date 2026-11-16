// REGRESSION GUARD (2026-09-27, Hard-Won Rule 23): openai_ads insights window
// param reachability.
//
// Incident: the ChatGPT Ads slide of the APOTHEKE weekly deck needs an exact
// Sun-Sat week. The engine (autocmo-core/openai_ads.go runOpenAIAdsInsights)
// reads Command.StartDate / Command.EndDate (json "startDate" / "endDate") for
// openai-ads-insights, but if the openai_ads zod schema does not declare them
// they are stripped before the handler runs and the only reachable window is
// a trailing batchCount one. This file asserts both halves: the keys are
// declared, and a call through the real openai_ads handler lands them in the
// --cmd JSON handed to the engine under the openai-ads-insights action.
//
// Harness copied from mcp-meta-param-reachability.test.js (Node stdlib plus
// in-file stubs, no real zod, so CI runs it without npm install).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

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

const OPENAI_WINDOW_KEYS = ['startDate', 'endDate'];

function lastCmd() {
  const call = execFileCalls[execFileCalls.length - 1];
  assert.ok(call, 'execFile must have been invoked');
  const i = call.args.indexOf('--cmd');
  assert.ok(i >= 0, '--cmd must be passed to the binary');
  return JSON.parse(call.args[i + 1]);
}

test('openai_ads declares startDate and endDate for insights', () => {
  const schema = byName('openai_ads').schema;
  for (const key of OPENAI_WINDOW_KEYS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(schema, key),
      `openai_ads.${key} must be declared: the engine reads it and zod strips what is not declared.`,
    );
  }
});

test('openai_ads insights start/end dates reach the engine through the tool handler', async () => {
  execFileCalls.length = 0;
  await byName('openai_ads').handler({
    action: 'insights',
    brand: 'apotheke',
    startDate: '2026-09-20',
    endDate: '2026-09-26',
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'openai-ads-insights', 'insights must route to openai-ads-insights');
  assert.equal(cmd.startDate, '2026-09-20', 'startDate must reach the engine');
  assert.equal(cmd.endDate, '2026-09-26', 'endDate must reach the engine');
});

test('openai_ads insights without dates still sends batchCount and no window keys', async () => {
  execFileCalls.length = 0;
  await byName('openai_ads').handler({ action: 'insights', brand: 'apotheke', batchCount: 7 });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'openai-ads-insights');
  assert.equal(cmd.batchCount, 7);
  assert.ok(!('startDate' in cmd) && !('endDate' in cmd), 'no window keys when none were given');
});
// REGRESSION GUARD (2026-11-14, openai-ads-push): push/activate params the
// engine reads. `approved` was previously undeclared, so strict mode rejected
// it and requireApproval in openai_ads.go could never pass from the app.
const OPENAI_PUSH_KEYS = ['approved', 'campaignName', 'adSetName', 'adName', 'targetAdSetId', 'adSetId', 'ads', 'campaignId', 'adId'];

test('openai_ads declares every push/activate/pause param the engine reads', () => {
  const schema = byName('openai_ads').schema;
  for (const key of OPENAI_PUSH_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(schema, key), `openai_ads.${key} must be declared`);
  }
  assert.ok(schema.action.__enum.includes('activate'), 'activate must be an openai_ads action');
  const item = schema.ads.__item.__shape;
  for (const key of ['name', 'imagePath', 'headline', 'body', 'link']) {
    assert.ok(Object.prototype.hasOwnProperty.call(item, key), `openai_ads.ads[].${key} must be declared (engine BulkAd field)`);
  }
});

test('openai_ads bulk push params reach the engine as openai-ads-push', async () => {
  execFileCalls.length = 0;
  await byName('openai_ads').handler({
    action: 'push', brand: 'apotheke', approved: true, campaignId: 'camp_1',
    campaignName: 'Q4 ChatGPT', adSetName: 'Candles', dailyBudget: 10,
    ads: [{ name: 'Ad One', imagePath: 'a.png', headline: 'First headline' }],
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'openai-ads-push');
  assert.equal(cmd.approved, true);
  assert.equal(cmd.campaignId, 'camp_1');
  assert.equal(cmd.campaignName, 'Q4 ChatGPT');
  assert.equal(cmd.adSetName, 'Candles');
  assert.equal(cmd.ads[0].name, 'Ad One');
});

test('openai_ads activate routes to openai-ads-activate with adSetId', async () => {
  execFileCalls.length = 0;
  await byName('openai_ads').handler({ action: 'activate', brand: 'apotheke', approved: true, adSetId: 'ag_1', campaignId: 'camp_1' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'openai-ads-activate');
  assert.equal(cmd.adSetId, 'ag_1');
  assert.equal(cmd.campaignId, 'camp_1');
});

test('openai_ads activate is SPEND-class, never in-cap auto-approved', () => {
  const policy = require('./mcp-approval-policy');
  assert.ok(policy.SPEND_ACTIONS.has('activate'), 'activate must card as a spend action');
  assert.ok(policy.SPEND_ACTIONS.has('push'));
  assert.ok(!policy.READ_ONLY_ACTIONS.has('activate'));
});

test('OpenAI Ads tile verifies the key before saving (no blind save)', () => {
  const fs = require('node:fs');
  const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  assert.match(renderer, /openai_ads:\s*\{[^}]*verify:\s*'verifyOpenAIAdsKey'/, 'openai_ads tile must declare its verify bridge');
  assert.match(renderer, /showModalError\(friendlyErrorPlain\(\(vr && vr\.error\)/, 'verify failure must pass through friendlyErrorPlain (Rule 6)');
  assert.match(preload, /verifyOpenAIAdsKey:.*'verify-openai-ads-key'/);
  const i = main.indexOf("ipcMain.handle('verify-openai-ads-key'");
  assert.ok(i > 0, 'verify-openai-ads-key handler must exist');
  const block = main.slice(i, main.indexOf('\n});', i));
  assert.ok(block.includes("action: 'openai-ads-verify'"), 'must run the engine verify');
  const verifyAt = block.indexOf('if (outcome.err)');
  const saveAt = block.indexOf("persistConfigField('openaiAdsApiKey'");
  assert.ok(verifyAt > 0 && saveAt > verifyAt, 'the key is persisted only after the verify outcome is checked');
  assert.ok(!/console\.(log|error)\([^)]*outcome\.stdout/.test(block), 'stdout carries the key and must never be logged');
});
