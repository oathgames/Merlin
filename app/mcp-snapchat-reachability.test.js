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

test('snapchat tool exposes exactly the read, status-flip, build, ad-creation and DPA surface', () => {
  assert.deepEqual([...TOOL_ACTIONS].sort(), [
    'activate', 'ad-accounts', 'ad-squads', 'ads', 'audiences', 'batch-status', 'build-architecture', 'bulk-push', 'campaigns',
    'catalogs', 'create-ad', 'create-ad-squad', 'create-audience', 'create-campaign', 'create-creative', 'create-product-set',
    'dpa-setup', 'insights', 'kill', 'pixel-stats', 'pixels', 'status', 'upload-media',
  ]);
  assert.ok(!TOOL_ACTIONS.includes('push'), 'there is no auto-approvable single push; ads go through bulk-push or create-ad');
});

test('engine -> MCP: every snapchat-* engine action is reachable', () => {
  if (!MAIN_GO) return;
  const engine = engineSnapchatActions();
  assert.ok(engine.length >= 24, `expected the 24 snapchat-* cases in main.go, got ${engine.join(', ')}`);
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

test('batch-status typed id lists and status reach the engine end to end', async () => {
  execFileCalls.length = 0;
  await byName('snapchat').handler({
    action: 'batch-status', brand: 'apotheke', batchStatus: 'ACTIVE', approved: true,
    campaignIds: ['c1'], adSquadIds: ['s1', 's2'], adIds: ['a1'],
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-batch-status');
  assert.equal(cmd.batchStatus, 'ACTIVE');
  assert.deepEqual(cmd.campaignIds, ['c1']);
  assert.deepEqual(cmd.adSquadIds, ['s1', 's2']);
  assert.deepEqual(cmd.adIds, ['a1']);
  assert.equal(cmd.approved, true);
});

test('every snapchat write always cards; reads and a dry-run build never do (Rule 19)', () => {
  const resolve = (input) => approvalPolicy.resolveMerlinAction('mcp__merlin__snapchat', input).effectiveAction;
  for (const action of ['kill', 'activate', 'create-audience', 'create-campaign', 'create-ad-squad', 'upload-media', 'create-creative', 'create-ad', 'bulk-push', 'create-product-set']) {
    const a = resolve({ action });
    assert.ok(approvalPolicy.SPEND_ACTIONS.has(a), `snapchat ${action} must route through the approval card (got '${a}')`);
    assert.notEqual(a, 'push', `snapchat ${action} must never be eligible for in-cap auto-approve`);
  }
  for (const batchStatus of ['ACTIVE', 'PAUSED', undefined, 'paused', 'active']) {
    const a = resolve({ action: 'batch-status', batchStatus });
    assert.ok(approvalPolicy.SPEND_ACTIONS.has(a), `snapchat batch-status ${batchStatus} must card (got '${a}')`);
    assert.notEqual(a, 'push', 'snapchat batch-status must never be eligible for in-cap auto-approve');
  }
  assert.equal(resolve({ action: 'batch-status', batchStatus: 'PAUSED' }), 'kill');
  assert.equal(resolve({ action: 'batch-status', batchStatus: 'ACTIVE' }), 'duplicate');
  const real = resolve({ action: 'build-architecture', dryRun: false, approved: true });
  assert.ok(approvalPolicy.SPEND_ACTIONS.has(real) && real !== 'push', 'a real build must always card');
  for (const input of [{}, { dryRun: true }, { dryRun: undefined }]) {
    const a = resolve({ action: 'build-architecture', ...input });
    assert.ok(approvalPolicy.READ_ONLY_ACTIONS.has(a), `a dry-run build is read-only (input ${JSON.stringify(input)} got '${a}')`);
  }
  // dpa-setup mirrors build-architecture: only dryRun literally false builds
  // (budgeted ad squads), and it must card, never in-cap auto-approve.
  const realDpa = resolve({ action: 'dpa-setup', dryRun: false, approved: true });
  assert.equal(realDpa, 'duplicate', 'a real dpa-setup must route to the always-carded duplicate');
  assert.ok(approvalPolicy.SPEND_ACTIONS.has(realDpa), 'a real dpa-setup must always card');
  for (const input of [{}, { dryRun: true }, { dryRun: undefined }, { dryRun: 'false' }, { dryRun: 0 }]) {
    const a = resolve({ action: 'dpa-setup', ...input });
    assert.equal(a, 'dry-run', `only dryRun:false builds; input ${JSON.stringify(input)} must plan (got '${a}')`);
    assert.ok(approvalPolicy.READ_ONLY_ACTIONS.has(a));
  }
  for (const action of ['status', 'ad-accounts', 'campaigns', 'insights', 'pixels', 'audiences', 'ad-squads', 'ads', 'catalogs', 'pixel-stats']) {
    const a = resolve({ action });
    assert.ok(!approvalPolicy.SPEND_ACTIONS.has(a), `snapchat ${action} is a read and must not card`);
  }
  // The reads added with the build surface are named read-only explicitly
  // rather than riding the catch-all. (ad-accounts can switch the selected
  // account, a local config write, so it stays on the catch-all as before.)
  for (const action of ['insights', 'campaigns', 'status', 'pixels', 'audiences', 'ad-squads', 'ads', 'catalogs', 'pixel-stats']) {
    const a = resolve({ action });
    assert.ok(approvalPolicy.READ_ONLY_ACTIONS.has(a), `snapchat ${action} must be named read-only (got '${a}')`);
  }
  const ann = (byName('snapchat').options || {}).annotations || {};
  assert.equal(ann.destructive, true, 'snapchat must be marked destructive');
  assert.equal(ann.costImpact, 'spend', 'snapchat must declare costImpact spend');
});

test('build-architecture params reach the engine end to end (dry run default untouched)', async () => {
  execFileCalls.length = 0;
  await byName('snapchat').handler({ action: 'build-architecture', brand: 'forever21', dailyBudget: 20, minAge: 21, sourceAudienceId: '5052756160240353', snapchatPixelId: 'px-1', excludeAudienceIds: ['111111'] });
  let cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-build-architecture');
  assert.equal(cmd.dryRun, undefined, 'the handler must not invent a dryRun value; the engine defaults to a dry run');
  assert.equal(cmd.approved, undefined, 'the handler must not auto-approve');
  assert.equal(cmd.dailyBudget, 20);
  assert.equal(cmd.minAge, 21);
  assert.equal(cmd.sourceAudienceId, '5052756160240353');
  assert.equal(cmd.snapchatPixelId, 'px-1');
  assert.deepEqual(cmd.excludeAudienceIds, ['111111']);

  await byName('snapchat').handler({ action: 'build-architecture', brand: 'forever21', dryRun: false, approved: true });
  cmd = lastCmd();
  assert.equal(cmd.dryRun, false);
  assert.equal(cmd.approved, true);
});

test('create-audience / create-campaign / create-ad-squad params reach the engine', async () => {
  execFileCalls.length = 0;
  await byName('snapchat').handler({ action: 'create-audience', brand: 'forever21', audienceType: 'pixel', audienceName: '30D_WV', audienceEvent: 'PAGE_VIEW', audienceRetentionDays: 30, approved: true });
  let cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-create-audience');
  assert.equal(cmd.audienceType, 'pixel');
  assert.equal(cmd.audienceName, '30D_WV');
  assert.equal(cmd.audienceEvent, 'PAGE_VIEW');
  assert.equal(cmd.audienceRetentionDays, 30);

  await byName('snapchat').handler({ action: 'create-audience', brand: 'forever21', audienceType: 'customer-list', audienceName: 'Customers', inputPath: 'c.csv', audienceDescription: 'd', approved: true });
  cmd = lastCmd();
  assert.equal(cmd.inputPath, 'c.csv');
  assert.equal(cmd.audienceDescription, 'd');

  await byName('snapchat').handler({ action: 'create-audience', brand: 'forever21', audienceType: 'lookalike', audienceName: 'LAL', sourceAudienceId: '123456', lookalikeCountry: 'us', lookalikeType: 'BALANCE', approved: true });
  cmd = lastCmd();
  assert.equal(cmd.audienceType, 'lookalike');
  assert.equal(cmd.lookalikeCountry, 'us');
  assert.equal(cmd.lookalikeType, 'BALANCE');

  await byName('snapchat').handler({ action: 'create-campaign', brand: 'forever21', campaignName: 'Broad_Prospecting_ABO', approved: true });
  cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-create-campaign');
  assert.equal(cmd.campaignName, 'Broad_Prospecting_ABO');

  await byName('snapchat').handler({ action: 'create-ad-squad', brand: 'forever21', campaignId: 'c1', adSetName: 'Broad_US', dailyBudget: 20, optimizationGoal: 'PIXEL_PURCHASE', bidStrategy: 'AUTO_BID', minAge: 18, includeAudienceIds: ['1'], excludeAudienceIds: ['2'], approved: true });
  cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-create-ad-squad');
  assert.equal(cmd.campaignId, 'c1');
  assert.equal(cmd.adSetName, 'Broad_US');
  assert.equal(cmd.dailyBudget, 20);
  assert.equal(cmd.optimizationGoal, 'PIXEL_PURCHASE');
  assert.equal(cmd.bidStrategy, 'AUTO_BID');
  assert.deepEqual(cmd.includeAudienceIds, ['1']);
  assert.deepEqual(cmd.excludeAudienceIds, ['2']);
});

test('read params (status filter, campaign and ad squad scope) reach the engine', async () => {
  execFileCalls.length = 0;
  await byName('snapchat').handler({ action: 'ad-squads', brand: 'forever21', campaignId: 'c1', status: 'paused' });
  let cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-ad-squads');
  assert.equal(cmd.campaignId, 'c1');
  assert.equal(cmd.status, 'paused');
  await byName('snapchat').handler({ action: 'ads', brand: 'forever21', targetAdSetId: 's1' });
  cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-ads');
  assert.equal(cmd.targetAdSetId, 's1');
  await byName('snapchat').handler({ action: 'pixels', brand: 'forever21' });
  assert.equal(lastCmd().action, 'snapchat-pixels');
  await byName('snapchat').handler({ action: 'audiences', brand: 'forever21' });
  assert.equal(lastCmd().action, 'snapchat-audiences');
});

test('ad-creation params reach the engine end to end (no auto-approve)', async () => {
  execFileCalls.length = 0;
  const snap = byName('snapchat');
  await snap.handler({ action: 'upload-media', brand: 'forever21', adImagePath: 'a.png', mediaName: 'Snap_A', approved: true });
  let cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-upload-media');
  assert.equal(cmd.adImagePath, 'a.png');
  assert.equal(cmd.mediaName, 'Snap_A');
  await snap.handler({ action: 'upload-media', brand: 'forever21', adVideoPath: 'v.mp4', approved: true });
  assert.equal(lastCmd().adVideoPath, 'v.mp4');

  await snap.handler({ action: 'create-creative', brand: 'forever21', adName: 'Snap_A', snapchatMediaId: 'm1', adHeadline: 'H', adLink: 'https://x.com', ctaType: 'ORDER_NOW', snapchatProfileId: 'p1', snapchatBrandName: 'F21', approved: true });
  cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-create-creative');
  assert.equal(cmd.adName, 'Snap_A');
  assert.equal(cmd.snapchatMediaId, 'm1');
  assert.equal(cmd.adHeadline, 'H');
  assert.equal(cmd.adLink, 'https://x.com');
  assert.equal(cmd.ctaType, 'ORDER_NOW');
  assert.equal(cmd.snapchatProfileId, 'p1');
  assert.equal(cmd.snapchatBrandName, 'F21');

  await snap.handler({ action: 'create-ad', brand: 'forever21', adName: 'Snap_A', snapchatCreativeId: 'c1', targetAdSetId: 's1', approved: true });
  cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-create-ad');
  assert.equal(cmd.snapchatCreativeId, 'c1');
  assert.equal(cmd.targetAdSetId, 's1');

  const ads = [{ name: 'Snap_A', imagePath: 'a.png', headline: 'H', link: 'https://x.com', cta: 'SHOP_NOW' }];
  await snap.handler({ action: 'bulk-push', brand: 'forever21', adSetName: 'Broad_US', campaignId: 'c1', snapchatProfileId: 'p1', ads });
  cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-bulk-push');
  assert.equal(cmd.adSetName, 'Broad_US');
  assert.deepEqual(cmd.ads, ads);
  assert.equal(cmd.approved, undefined, 'the handler must not auto-approve');
});

test('DPA params reach the engine end to end under the engine json keys (no auto-approve)', async () => {
  execFileCalls.length = 0;
  const snap = byName('snapchat');
  await snap.handler({ action: 'catalogs', brand: 'forever21', catalogId: 'cat1' });
  let cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-catalogs');
  assert.equal(cmd.catalogId, 'cat1');

  await snap.handler({ action: 'pixel-stats', brand: 'forever21', snapchatPixelId: 'px1', domain: 'forever21.com', days: 14 });
  cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-pixel-stats');
  assert.equal(cmd.snapchatPixelId, 'px1');
  assert.equal(cmd.domain, 'forever21.com');
  assert.equal(cmd.days, 14);

  const filter = { CUSTOM_LABEL_0: { EQ: 'sale' } };
  await snap.handler({ action: 'create-product-set', brand: 'forever21', catalogId: 'cat1', productSetName: 'Sale', productSetFilter: filter, approved: true });
  cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-create-product-set');
  assert.equal(cmd.catalogId, 'cat1');
  assert.equal(cmd.productSetName, 'Sale');
  assert.deepEqual(cmd.productSetFilter, filter);
  assert.equal(cmd.approved, true);

  const dpaSquads = [
    { name: 'DPA_Prospecting', dailyBudget: 50, audience: 'prospecting', adName: 'DPA_P' },
    { name: 'DPA_ATC', dailyBudget: 75, audience: 'atc_no_purchase', retentionDays: 14, adName: 'DPA_ATC', optimizationGoal: 'PIXEL_PURCHASE', productSetId: 'default' },
  ];
  await snap.handler({
    action: 'dpa-setup', brand: 'forever21', campaignName: 'Snap_DPA', catalogId: 'cat1', productSetId: 'default',
    snapchatDynamicTemplateId: 't1', snapchatPixelId: 'px1', adHeadline: 'Shop the sale', ctaType: 'SHOP_NOW', snapchatProfileId: 'p1', dpaSquads,
  });
  cmd = lastCmd();
  assert.equal(cmd.action, 'snapchat-dpa-setup');
  assert.equal(cmd.campaignName, 'Snap_DPA');
  assert.equal(cmd.productSetId, 'default');
  assert.equal(cmd.snapchatDynamicTemplateId, 't1');
  assert.equal(cmd.adHeadline, 'Shop the sale');
  assert.equal(cmd.ctaType, 'SHOP_NOW');
  assert.equal(cmd.snapchatProfileId, 'p1');
  assert.deepEqual(cmd.dpaSquads, dpaSquads);
  assert.equal(cmd.dryRun, undefined, 'the handler must not default dryRun; the engine treats unset as a dry run');
  assert.equal(cmd.approved, undefined, 'the handler must not auto-approve');
});

test('dpaSquads[] keys and top-level DPA keys match the engine json tags', () => {
  const item = byName('snapchat').schema.dpaSquads.__item.__shape;
  const keys = Object.keys(item).sort();
  assert.deepEqual(keys, ['adName', 'audience', 'dailyBudget', 'name', 'optimizationGoal', 'productSetId', 'retentionDays']);
  const dpaGo = coreFile('snapchat_dpa.go');
  if (dpaGo) {
    const m = dpaGo.match(/type SnapchatDPASquad struct \{([\s\S]*?)\n\}/);
    assert.ok(m, 'SnapchatDPASquad must be present in snapchat_dpa.go');
    const goKeys = (m[1].match(/json:"([^",]+)/g) || []).map((t) => t.slice(6)).sort();
    assert.deepEqual(goKeys, keys, 'dpaSquads[] drifted from SnapchatDPASquad json tags');
  }
  if (!MAIN_GO) return;
  for (const key of ['domain', 'productSetName', 'productSetFilter', 'snapchatDynamicTemplateId', 'dpaSquads', 'catalogId', 'productSetId', 'days']) {
    assert.ok(new RegExp(`json:"${key}[,"]`).test(MAIN_GO), `Command must decode ${key}`);
  }
});

test('bulk-push ads[] keys match the engine strict-key set for snapchat-bulk-push', () => {
  const item = byName('snapchat').schema.ads.__item.__shape;
  assert.deepEqual(Object.keys(item).sort(), ['cta', 'headline', 'imagePath', 'link', 'name', 'videoPath']);
  const strict = coreFile('bulk_ad_strict.go');
  if (!strict) return;
  assert.match(strict, /"snapchat-bulk-push":\s*\{/, 'engine must declare a strict-key rule for snapchat-bulk-push');
});

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('BRAND_KEYS and Go brandScopedKeys agree on every snapchat key', () => {
  const m = MAIN_JS.match(/const BRAND_KEYS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, 'BRAND_KEYS must be present in main.js');
  const jsSide = (m[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)).filter((k) => k.startsWith('snapchat')).sort();
  assert.deepEqual(jsSide, ['snapchatAccessToken', 'snapchatAdAccountId', 'snapchatOrganizationId', 'snapchatProspectingExclusions', 'snapchatPublicProfileId', 'snapchatRefreshToken', 'snapchatTokenExpiresAt', 'snapchatUrlTags']);
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

// QuickBooks has the same shape (empty hardcoded ClientID, BFF-delivered id),
// so it gets the same gate.
test('quickbooks tile shares the client_id availability gate', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const tile = html.match(/<button[^>]*data-platform="quickbooks"[^>]*>/);
  assert.ok(tile, 'quickbooks tile must exist');
  assert.match(tile[0], /data-needs-client-id="true"/);
  assert.match(MAIN_JS, /NEEDS_CLIENT_ID_PROVIDERS\s*=\s*\[[^\]]*'quickbooks'/);
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
