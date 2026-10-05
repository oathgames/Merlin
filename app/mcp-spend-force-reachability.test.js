// Spend-guard `force` reachability, Hard-Won Rules 19, 23 and 25.
//
// REGRESSION GUARD (2026-10-05, google-budget-force). The engine's
// spend-anomaly guard (autocmo-core/spend_pause.go:checkSpendAnomaly, reached
// through enforceAggregateMonthlyCap on every budget-setting action) refuses
// with "pass force=true to override". `force` was not declared on any ad MCP
// tool, so defineTool's strict input check rejected it as an unknown field and
// the remediation the guard named could not be performed from the app (a live
// google_ads budget call hit exactly this). Rule 25: a guard's remediation must
// actually work. Rule 23: an engine param must be reachable from MCP.
//
// This file pins, for every ad tool whose engine path reaches the guard:
//   1. `force` is declared on the schema,
//   2. it lands in the engine --cmd JSON as the Go `force` json tag,
//   3. it never buys silence: the policy still maps the call to a SPEND action
//      and handleToolApproval excludes forced calls from in-cap auto-approve,
//   4. the Go side still reads `json:"force,omitempty"` and still names
//      force=true in the refusal (cross-repo drift check),
//   5. the host cap is read for the brand the call names (getBudgetContext).
//
// Stdlib only (CI runs app tests without npm install).

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
const policy = require('./mcp-approval-policy');
const budgetCeiling = require('./budget-ceiling');

function makeRecordingZ() {
  const node = (extra = {}) => ({
    ...extra,
    optional: () => node(extra),
    describe: () => node(extra),
    default: () => node(extra),
    regex: () => node(extra),
    int: () => node(extra),
    min: () => node(extra),
    max: () => node(extra),
    positive: () => node(extra),
    nonnegative: () => node(extra),
    nullable: () => node(extra),
    refine: () => node(extra),
  });
  return {
    string: () => node(), number: () => node(), boolean: () => node({ __bool: true }),
    any: () => node(), enum: (vals) => node({ __enum: vals }),
    literal: () => node(),
    coerce: { number: () => node() },
    array: (item) => node({ __item: item }),
    object: (shape) => node({ __shape: shape }),
    record: () => node(),
    union: () => node(),
  };
}

const TOKENS = {
  metaAccessToken: 'x', metaAdAccountId: 'act_1', metaPageId: '1',
  googleAccessToken: 'x', googleAdsCustomerId: '1',
  tiktokAccessToken: 'x', tiktokAdvertiserId: '1',
  amazonAccessToken: 'x', amazonProfileId: '1',
  redditAccessToken: 'x', redditAdAccountId: '1',
  linkedinAccessToken: 'x', linkedinAdAccountId: '1',
  openaiAdsAccessToken: 'x', roundelAccessToken: 'x',
  maxDailyAdBudget: 1000,
};

function makeCtx() {
  return {
    getConnections: () => [],
    readConfig: () => ({ ...TOKENS }),
    readBrandConfig: () => ({ ...TOKENS }),
    buildStrictBrandConfig: () => ({ ...TOKENS }),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => __filename,
    appRoot: path.join(__dirname, '..'),
    isBinaryTooOld: () => false,
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
  };
}

let _entries = null;
function entries() {
  if (_entries) return _entries;
  _entries = [];
  const tool = (name, description, schema, handler, options) => {
    _entries.push({ name, description, schema, handler, options });
    return { name };
  };
  buildTools(tool, makeRecordingZ(), makeCtx());
  return _entries;
}
function getTool(name) {
  const t = entries().find((e) => e.name === name);
  assert.ok(t, `${name} must be registered`);
  return t;
}

// Every ad tool whose engine path reaches enforceAggregateMonthlyCap ->
// checkSpendAnomaly (budget-setting actions), with one representative call.
const FORCE_TOOLS = [
  { tool: 'google_ads', args: { action: 'budget', brand: 'ripit', campaignId: '123', dailyBudget: 200 }, engine: 'google-ads-budget' },
  { tool: 'meta_ads', args: { action: 'budget', brand: 'ripit', campaignId: '123', dailyBudget: 200 }, engine: 'meta-budget' },
  { tool: 'tiktok_ads', args: { action: 'push', brand: 'ripit', dailyBudget: 200 }, engine: 'tiktok-push' },
  { tool: 'amazon_ads', args: { action: 'push', brand: 'ripit', dailyBudget: 200 }, engine: 'amazon-ads-push' },
  { tool: 'reddit_ads', args: { action: 'create-campaign', brand: 'ripit', dailyBudget: 200 }, engine: 'reddit-create-campaign' },
  { tool: 'linkedin_ads', args: { action: 'setup', brand: 'ripit', dailyBudget: 200 }, engine: 'linkedin-setup' },
  { tool: 'openai_ads', args: { action: 'push', brand: 'ripit', dailyBudget: 200 }, engine: 'openai-ads-push' },
  { tool: 'roundel', args: { action: 'budget', brand: 'ripit', campaignId: '123', dailyBudget: 200, approved: true }, engine: 'roundel-budget' },
  { tool: 'meta_adjust_budget', args: { brand: 'ripit', adId: '123', dailyBudget: 200 }, engine: 'meta-budget' },
  { tool: 'meta_launch_test_ad', args: null },
  { tool: 'meta_launch_test_batch', args: null },
  { tool: 'meta_scale_winner', args: null },
];

for (const spec of FORCE_TOOLS) {
  test(`${spec.tool} declares force as an optional boolean`, () => {
    const schema = getTool(spec.tool).schema;
    assert.ok(Object.prototype.hasOwnProperty.call(schema, 'force'),
      `${spec.tool} must declare "force" (the engine spend-anomaly guard says "pass force=true")`);
    assert.equal(schema.force.__bool, true, `${spec.tool}.force must be z.boolean()`);
  });
}

for (const spec of FORCE_TOOLS.filter((s) => s.args)) {
  test(`${spec.tool}: force=true lands in the engine --cmd JSON`, async () => {
    execFileCalls.length = 0;
    const res = await getTool(spec.tool).handler({ ...spec.args, force: true });
    const call = execFileCalls.find((c) => c.args.includes('--cmd'));
    assert.ok(call, `${spec.tool} must invoke the engine; got ${JSON.stringify(res).slice(0, 300)}`);
    const cmd = JSON.parse(call.args[call.args.indexOf('--cmd') + 1]);
    assert.equal(cmd.action, spec.engine);
    assert.equal(cmd.force, true, `${spec.tool} must pass force through under the Go json tag "force"`);
  });
}

test('google_ads read aliases strip force before reaching the engine', async () => {
  const t = getTool('google_ads');
  let checked = 0;
  for (const action of ['budget-status', 'brand-exclusion-preview']) {
    if (!t.schema.action.__enum.includes(action)) continue;
    execFileCalls.length = 0;
    await t.handler({ action, brand: 'ripit', force: true });
    const call = execFileCalls.find((c) => c.args.includes('--cmd'));
    if (!call) continue;
    checked++;
    const cmd = JSON.parse(call.args[call.args.indexOf('--cmd') + 1]);
    assert.equal(cmd.force, undefined, `${action} is read-only and must not forward force`);
  }
  assert.ok(checked > 0, 'at least one google_ads read alias must have been exercised');
});

test('force never changes the approval classification: forced spend calls still resolve to SPEND actions', () => {
  const cases = [
    ['mcp__merlin__google_ads', { action: 'budget', force: true }],
    ['mcp__merlin__meta_ads', { action: 'push', force: true }],
    ['mcp__merlin__meta_ads', { action: 'budget', force: true }],
    ['mcp__merlin__roundel', { action: 'activate', force: true }],
    ['mcp__merlin__meta_adjust_budget', { force: true }],
    ['mcp__merlin__meta_launch_test_ad', { force: true }],
    ['mcp__merlin__meta_scale_winner', { force: true }],
  ];
  for (const [toolName, input] of cases) {
    const action = policy.resolveMerlinAction(toolName, input).effectiveAction;
    assert.ok(policy.SPEND_ACTIONS.has(action), `${toolName} with force:true resolved to "${action}", which does not card`);
    const plain = policy.resolveMerlinAction(toolName, { ...input, force: undefined }).effectiveAction;
    assert.equal(action, plain, `${toolName}: force must not alter the resolved action`);
  }
  const src = fs.readFileSync(path.join(__dirname, 'mcp-approval-policy.js'), 'utf8');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /\.force\b/, 'the approval policy must never read input.force');
});

test('requestsGuardOverride: any non-false force counts', () => {
  assert.equal(budgetCeiling.requestsGuardOverride({ force: true }), true);
  assert.equal(budgetCeiling.requestsGuardOverride({ force: 'true' }), true);
  assert.equal(budgetCeiling.requestsGuardOverride({ force: 1 }), true);
  assert.equal(budgetCeiling.requestsGuardOverride({ force: false }), false);
  assert.equal(budgetCeiling.requestsGuardOverride({}), false);
  assert.equal(budgetCeiling.requestsGuardOverride(null), false);
});

const MAIN_SRC = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('main.js: forced spend calls are excluded from in-cap auto-approve on BOTH paths', () => {
  assert.match(MAIN_SRC, /const forceRequested = budgetCeiling\.requestsGuardOverride\(input\)/);
  assert.match(MAIN_SRC, /if \(!requireSpendApproval && !forceRequested && capForComparison > 0 && action === 'push'/);
  assert.ok(MAIN_SRC.includes('const bashForceRequested = /"force"\\s*:\\s*(?!false\\b)/.test(input.command);'),
    'Bash spend path must detect a forced command');
  assert.match(MAIN_SRC, /if \(!bashRequireSpendApproval && !bashForceRequested && capForComparison > 0 && BASH_PUSH_ONLY\.has\(bashAction\)/);
});

test('Bash force detector: matches forced commands, ignores force:false', () => {
  const re = /"force"\s*:\s*(?!false\b)/;
  assert.ok(re.test('Merlin.exe --cmd \'{"action":"meta-push","force":true}\''));
  assert.ok(re.test('{"force" : "yes"}'));
  assert.ok(!re.test('{"action":"meta-push","force":false}'));
  assert.ok(!re.test('{"action":"meta-push"}'));
});

test('main.js: the host cap is read for the brand the call names, not readState().activeBrand', () => {
  assert.match(MAIN_SRC, /function getBudgetContext\(inputBrand\)/);
  assert.match(MAIN_SRC, /budgetCeiling\.resolveCapBrand\(inputBrand, /);
  assert.match(MAIN_SRC, /const budgetCtx = getBudgetContext\(input\.brand\);/);
  assert.match(MAIN_SRC, /const budgetCtx = getBudgetContext\(bashInputBrand\);/);
  const codeOnly = MAIN_SRC.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly, /getBudgetContext\(\)/, 'every getBudgetContext call must pass the call brand');
  const start = MAIN_SRC.indexOf('function getBudgetContext(');
  const body = MAIN_SRC.slice(start, start + 600);
  assert.doesNotMatch(body, /activeBrand \? readBrandConfig\(activeBrand\)/, 'the cap must not be read from activeBrand directly');
});

// Rule 25 cross-repo check: the Go guard names force=true and reads the json
// tag the MCP key maps onto. Skips when autocmo-core is not checked out next
// to the app (public CI), like budget-ceiling.test.js's drift check.
function findCore() {
  for (const rel of ['../../autocmo-core', '../../../autocmo-core']) {
    const dir = path.resolve(__dirname, rel);
    if (fs.existsSync(path.join(dir, 'main.go')) && fs.existsSync(path.join(dir, 'spend_pause.go'))) return dir;
  }
  return null;
}

test('cross-repo: Go Command.Force json tag is "force" and the guard tells the caller to pass force=true', (t) => {
  const core = findCore();
  if (!core) { t.skip('autocmo-core not checked out next to the app'); return; }
  const mainGo = fs.readFileSync(path.join(core, 'main.go'), 'utf8');
  const m = mainGo.match(/^\s*Force\s+bool\s+`json:"([^",]+)[^`]*`/m);
  assert.ok(m, 'Command.Force must exist in autocmo-core/main.go');
  assert.equal(m[1], 'force', 'Go json tag must match the MCP key "force"');
  const spendGo = fs.readFileSync(path.join(core, 'spend_pause.go'), 'utf8');
  assert.match(spendGo, /pass force=true to override/, 'spend-anomaly refusal must keep naming the remediation the MCP surface exposes');
  assert.match(spendGo, /cmd\.Force/, 'checkSpendAnomaly must honour cmd.Force');
});
