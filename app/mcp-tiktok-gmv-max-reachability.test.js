// REGRESSION GUARD (2026-10-05, Hard-Won Rule 23): tiktok_audit reachability.
//
// The TikTok GMV Max reads (autocmo-core/tiktok_gmv_max.go) are only useful if
// the MCP surface can reach them. This file asserts both directions: every
// engine case "tiktok-gmv-max-*" and "tiktok-campaigns" is in the tiktok_audit
// enum, every enum value maps to a real engine case, each declared param lands
// in the --cmd JSON, and the tool is a non-destructive read that the approval
// policy resolves to a READ_ONLY action (never a SPEND or carded path).
//
// Harness copied from mcp-openai-ads-reachability.test.js (Node stdlib plus
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
    readConfig: () => ({ tiktokAccessToken: 'x' }),
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

const fs = require('node:fs');
const policy = require('./mcp-approval-policy');

function lastCmd() {
  const call = execFileCalls[execFileCalls.length - 1];
  assert.ok(call, 'execFile must have been invoked');
  const i = call.args.indexOf('--cmd');
  assert.ok(i >= 0, '--cmd must be passed to the binary');
  return JSON.parse(call.args[i + 1]);
}

function findMainGo() {
  const candidates = [
    process.env.MERLIN_CORE_DIR && path.join(process.env.MERLIN_CORE_DIR, 'main.go'),
    path.join(__dirname, '..', '..', 'autocmo-core', 'main.go'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const tiktokAudit = () => byName('tiktok_audit');
const enumValues = () => tiktokAudit().schema.action.__enum;

test('tiktok_audit is a non-destructive, api-cost, brand-scoped read', () => {
  const a = tiktokAudit().options.annotations;
  assert.equal(a.destructive, false);
  assert.equal(a.costImpact, 'api');
  assert.equal(a.brandRequired, true);
  assert.equal(a.preview, false);
  assert.deepEqual(a.concurrency, { platform: 'tiktok' });
});

test('every tiktok_audit action resolves to a READ_ONLY policy action, never SPEND or carded', () => {
  for (const action of enumValues()) {
    const { effectiveAction } = policy.resolveMerlinAction('mcp__merlin__tiktok_audit', { action, brand: 'apotheke' });
    assert.ok(policy.READ_ONLY_ACTIONS.has(effectiveAction), `${action} must be READ_ONLY (got ${effectiveAction})`);
    assert.ok(!policy.SPEND_ACTIONS.has(effectiveAction), `${action} must never be a SPEND action`);
    assert.ok(!policy.CARDED_DESTRUCTIVE_ACTIONS.has(effectiveAction), `${action} must never card`);
  }
  assert.equal(policy.INTENT_TOOL_TO_ACTION['mcp__merlin__tiktok_audit'], 'audit');
  assert.ok(policy.READ_ONLY_ACTIONS.has('audit'));
});

test('tiktok_audit enum and engine GMV Max cases match in both directions', (t) => {
  const mainGo = findMainGo();
  if (!mainGo) { t.skip('autocmo-core/main.go not present beside the app checkout'); return; }
  const src = fs.readFileSync(mainGo, 'utf8');
  const engine = new Set();
  for (const m of src.matchAll(/case\s+"(tiktok-(?:gmv-max-[a-z-]+|campaigns))"\s*:/g)) engine.add(m[1]);
  engine.delete('tiktok-gmv-max-update-roi'); // the write: routed by tiktok_gmv_max_set_roi_target, asserted below
  assert.ok(engine.size >= 9, `expected the GMV Max engine cases, found ${[...engine].join(', ')}`);
  const routed = new Set(enumValues().map((v) => 'tiktok-' + v));
  for (const e of engine) assert.ok(routed.has(e), `engine action ${e} has no tiktok_audit route`);
  for (const r of routed) assert.ok(engine.has(r), `tiktok_audit routes to ${r}, which main.go does not handle`);
});

test('every tiktok_audit action routes to tiktok-<action> in --cmd', async () => {
  for (const action of enumValues()) {
    execFileCalls.length = 0;
    await tiktokAudit().handler({ action, brand: 'apotheke', campaignId: '1874518629365218' });
    const cmd = lastCmd();
    assert.equal(cmd.action, 'tiktok-' + action);
    assert.equal(cmd.campaignId, '1874518629365218');
  }
});

test('tiktok_audit params land in the --cmd JSON with engine json names', async () => {
  const args = {
    action: 'gmv-max-report',
    brand: 'apotheke',
    campaignId: '1874518629365218',
    startDate: '2026-09-05',
    endDate: '2026-10-04',
    dimensions: ['campaign_id', 'item_id'],
    metrics: ['cost', 'gross_revenue', 'roi'],
    tiktokStoreId: 'store1',
    tiktokBcId: 'bc1',
    tiktokAdvertiserId: 'adv1',
    tiktokFilters: { campaign_status: 'ENABLE' },
    page: 2,
    pageSize: 50,
    keyword: 'candle',
    spuIdList: ['spu1'],
    needAuthCodeVideo: false,
    customPostsEligible: true,
    sortField: 'cost',
    sortType: 'DESC',
  };
  const schema = tiktokAudit().schema;
  for (const key of Object.keys(args)) {
    assert.ok(Object.prototype.hasOwnProperty.call(schema, key), `tiktok_audit.${key} must be declared`);
  }
  execFileCalls.length = 0;
  await tiktokAudit().handler(args);
  const cmd = lastCmd();
  assert.equal(cmd.action, 'tiktok-gmv-max-report');
  for (const [key, val] of Object.entries(args)) {
    if (key === 'action' || key === 'brand') continue;
    if (key === 'needAuthCodeVideo') continue; // false is checked below
    assert.deepEqual(cmd[key], val, `${key} must reach the engine unchanged`);
  }
});

test('needAuthCodeVideo:false is not dropped on the way to the engine', async () => {
  execFileCalls.length = 0;
  await tiktokAudit().handler({ action: 'gmv-max-videos', brand: 'apotheke', needAuthCodeVideo: false });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'tiktok-gmv-max-videos');
  assert.equal(cmd.needAuthCodeVideo, false, 'an explicit false must reach the engine, or the default (true) silently wins');
});

// ── The ONE write: tiktok_gmv_max_set_roi_target ─────────────────────

const roiTool = () => byName('tiktok_gmv_max_set_roi_target');

test('ROI target write is destructive, spend-class, and has no action enum (intent-style)', () => {
  const a = roiTool().options.annotations;
  assert.equal(a.destructive, true);
  assert.equal(a.costImpact, 'spend');
  assert.equal(a.brandRequired, true);
  assert.equal(a.preview, false);
  assert.ok(!Object.prototype.hasOwnProperty.call(roiTool().schema, 'action'), 'intent tool must not carry an action field');
});

test('ROI target write ALWAYS cards: SPEND action, not push, labelled', () => {
  const { effectiveAction, label } = policy.resolveMerlinAction('mcp__merlin__tiktok_gmv_max_set_roi_target', {
    brand: 'apotheke', campaignId: '1874518629365218', roasBid: 1,
  });
  assert.equal(effectiveAction, 'roi-target');
  assert.ok(policy.SPEND_ACTIONS.has('roi-target'), 'roi-target must be a SPEND action');
  assert.notEqual(effectiveAction, 'push', 'push is the only in-cap auto-approve action; the ROI write must never use it');
  assert.ok(!policy.READ_ONLY_ACTIONS.has('roi-target'));
  assert.ok(label && /ROI target/.test(label), 'card must carry a specific label');
});

test('main.js in-cap auto-approve stays push-only, so roi-target can never skip the card', () => {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.match(src, /capForComparison > 0 && action === 'push' &&/, 'in-cap auto-approve must remain gated on push only');
  assert.match(src, /'roi-target': \{/, 'roi-target needs its own card text');
});

test('ROI target write routes to tiktok-gmv-max-update-roi with campaignId and roasBid', async (t) => {
  execFileCalls.length = 0;
  await roiTool().handler({ brand: 'apotheke', campaignId: '1874518629365218', roasBid: 1 });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'tiktok-gmv-max-update-roi');
  assert.equal(cmd.campaignId, '1874518629365218');
  assert.equal(cmd.roasBid, 1);
  assert.ok(!cmd.approved, 'the handler must never set approved itself');
  const mainGo = findMainGo();
  if (!mainGo) { t.skip('autocmo-core/main.go not present'); return; }
  assert.match(fs.readFileSync(mainGo, 'utf8'), /case\s+"tiktok-gmv-max-update-roi"\s*:/, 'engine must handle tiktok-gmv-max-update-roi');
});

test('an approved flag passed by the caller reaches the engine unchanged (card flow)', async () => {
  execFileCalls.length = 0;
  await roiTool().handler({ brand: 'apotheke', campaignId: '1874518629365218', roasBid: 1.2, approved: true });
  const cmd = lastCmd();
  assert.equal(cmd.approved, true);
  assert.equal(cmd.roasBid, 1.2);
});
