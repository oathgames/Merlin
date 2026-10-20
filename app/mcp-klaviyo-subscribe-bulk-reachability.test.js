// REGRESSION GUARD (2026-10-20, Rule 23): Klaviyo subscribe-bulk + list-create
// reachability and approval treatment.
//
// merlin-core added `klaviyo-list-create` (idempotent, single opt-in by
// default) and `klaviyo-subscribe-bulk` (CSV import of consented emails as
// SUBSCRIBED, DRY RUN unless dryRun is literally false). zod strips keys a
// tool schema never declared, so an undeclared field is dropped before the
// handler runs. A dropped `dryRun:false` is harmless (it stays a dry run),
// but a dropped listNameTemplate / consentedAt / historicalImport silently
// changes WHICH lists and WHAT consent record a real import writes. This file
// locks:
//   1. Both actions are in the klaviyo enum.
//   2. Every subscribe-bulk field is declared with the Go json tag spelling.
//   3. Approval: subscribe-bulk without dryRun, or with any value other than
//      literal false, resolves to the read-only 'dry-run'; dryRun:false
//      resolves to the carded 'subscribe-bulk'. list-create is carded.
//   4. End-to-end through the handler: fields land in the --cmd JSON.
//   5. With a job store, subscribe-bulk runs as a background job that is NOT
//      restart-resumable (its approval is an in-memory card click).
//   6. main.js cards the Bash path for both actions.
//
// Node stdlib plus in-file stubs only (CI runs with no `npm install`).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const childProcess = require('child_process');
const execFileCalls = [];
childProcess.execFile = function fakeExecFile(file, args, options, callback) {
  execFileCalls.push({ file, args, options });
  const child = { stdin: { on() {}, write() {}, end() {} }, kill() {} };
  setImmediate(() => callback(null, 'ok', ''));
  return child;
};

const path = require('node:path');
const { buildTools, RESTART_RESUMABLE_EXPORT_ACTIONS } = require('./mcp-tools');
const approvalPolicy = require('./mcp-approval-policy');

function makeZ() {
  const node = (extra = {}) => ({
    ...extra,
    optional: () => node(extra),
    describe: (d) => node({ ...extra, __describe: d }),
    default: () => node(extra),
    regex: () => node(extra),
    int: () => node(extra),
    min: () => node(extra),
    max: () => node(extra),
  });
  return {
    string: () => node({ __kind: 'string' }),
    number: () => node({ __kind: 'number' }),
    boolean: () => node({ __kind: 'boolean' }),
    any: () => node(),
    enum: (vals) => node({ __enum: vals }),
    coerce: { number: () => node({ __kind: 'number' }) },
    array: (item) => node({ __item: item }),
    object: (shape) => node({ __shape: shape }),
    record: (value) => node({ __kind: 'record', __value: value }),
  };
}

function makeCtx(overrides = {}) {
  return {
    getConnections: () => [],
    readConfig: () => ({ klaviyoApiKey: 'x' }),
    readBrandConfig: () => ({ klaviyoApiKey: 'x' }),
    buildStrictBrandConfig: () => ({ klaviyoApiKey: 'x' }),
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

function klaviyoTool(ctx = makeCtx()) {
  const entries = [];
  const tool = (name, description, schema, handler, options) => {
    entries.push({ name, description, schema, handler, options });
    return { name };
  };
  buildTools(tool, makeZ(), ctx);
  const found = entries.find((e) => e.name === 'klaviyo');
  assert.ok(found, 'klaviyo tool must be registered');
  return found;
}

function shapeOf(entry) {
  return entry.schema && (entry.schema.__shape || entry.schema);
}

function lastCmd() {
  const call = execFileCalls[execFileCalls.length - 1];
  assert.ok(call, 'execFile must have been invoked');
  const i = call.args.indexOf('--cmd');
  assert.ok(i >= 0, '--cmd must be passed to the binary');
  return JSON.parse(call.args[i + 1]);
}

function resolve(input) {
  return approvalPolicy.resolveMerlinAction('mcp__merlin__klaviyo', input).effectiveAction;
}

function isCarded(action) {
  const carded = approvalPolicy.CARDED_DESTRUCTIVE_ACTIONS;
  return typeof carded.has === 'function' ? carded.has(action) : carded.includes(action);
}

function isReadOnly(action) {
  const ro = approvalPolicy.READ_ONLY_ACTIONS;
  return typeof ro.has === 'function' ? ro.has(action) : ro.includes(action);
}

test('klaviyo action enum includes list-create and subscribe-bulk', () => {
  const shape = shapeOf(klaviyoTool());
  for (const a of ['list-create', 'subscribe-bulk']) {
    assert.ok(shape.action.__enum.includes(a), `${a} must be routable: main.go has case "klaviyo-${a}".`);
  }
});

test('subscribe-bulk fields are declared with the engine json spelling', () => {
  const shape = shapeOf(klaviyoTool());
  const want = {
    listId: 'string', listName: 'string', listNameTemplate: 'string',
    csvPath: 'string', csvDir: 'string', csvPattern: 'string',
    dryRun: 'boolean', historicalImport: 'boolean',
    consentedAt: 'string', customSource: 'string', maxMinutes: 'number',
  };
  for (const [k, kind] of Object.entries(want)) {
    assert.ok(Object.prototype.hasOwnProperty.call(shape, k), `${k} must be declared (Command json "${k}")`);
    assert.equal(shape[k].__kind, kind, `${k} must be a ${kind}`);
  }
  assert.deepEqual(shape.optInProcess.__enum, ['single_opt_in', 'double_opt_in'],
    'optInProcess must be exactly the set klaviyoNormalizeOptIn maps to.');
});

test('subscribe-bulk is a read-only dry run unless dryRun is literally false', () => {
  assert.ok(isReadOnly('dry-run'), "'dry-run' must stay READ_ONLY");
  for (const input of [
    { action: 'subscribe-bulk' },
    { action: 'subscribe-bulk', dryRun: true },
    { action: 'subscribe-bulk', dryRun: 'false' },
    { action: 'subscribe-bulk', dryRun: 0 },
    { action: 'subscribe-bulk', dryRun: null },
  ]) {
    assert.equal(resolve(input), 'dry-run', `input ${JSON.stringify(input)} must resolve to dry-run`);
  }
});

test('subscribe-bulk with dryRun:false is carded', () => {
  const eff = resolve({ action: 'subscribe-bulk', dryRun: false });
  assert.equal(eff, 'subscribe-bulk');
  assert.ok(isCarded('subscribe-bulk'), 'the real import must show an approval card');
  assert.ok(!isReadOnly('subscribe-bulk'), 'the real import must never auto-approve');
});

test('list-create is carded and never read-only', () => {
  assert.equal(resolve({ action: 'list-create', listName: 'X' }), 'list-create');
  assert.ok(isCarded('list-create'));
  assert.ok(!isReadOnly('list-create'));
});

test('subscribe-bulk fields reach --cmd via the tool handler (no job store)', async () => {
  execFileCalls.length = 0;
  await klaviyoTool().handler({
    action: 'subscribe-bulk', brand: 'acme',
    csvDir: 'C:/data', csvPattern: 'F21_Verified_*.csv', listNameTemplate: 'F21_Warmup_Batch_{n}',
    dryRun: false, historicalImport: true, consentedAt: '2024-01-01',
    customSource: 'Legacy signup', maxMinutes: 30, optInProcess: 'single_opt_in',
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'klaviyo-subscribe-bulk');
  assert.equal(cmd.csvDir, 'C:/data');
  assert.equal(cmd.csvPattern, 'F21_Verified_*.csv');
  assert.equal(cmd.listNameTemplate, 'F21_Warmup_Batch_{n}');
  assert.equal(cmd.dryRun, false);
  assert.equal(cmd.historicalImport, true);
  assert.equal(cmd.consentedAt, '2024-01-01');
  assert.equal(cmd.customSource, 'Legacy signup');
  assert.equal(cmd.maxMinutes, 30);
  assert.equal(cmd.optInProcess, 'single_opt_in');
});

test('list-create fields reach --cmd via the tool handler', async () => {
  execFileCalls.length = 0;
  await klaviyoTool().handler({ action: 'list-create', brand: 'acme', listName: 'F21_Warmup_Batch_01', optInProcess: 'single_opt_in' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'klaviyo-list-create');
  assert.equal(cmd.listName, 'F21_Warmup_Batch_01');
  assert.equal(cmd.optInProcess, 'single_opt_in');
});

test('with a job store, subscribe-bulk runs as a background job that is not restart-resumable', async () => {
  const started = [];
  const jobStore = {
    start(spec) { started.push(spec); return { jobId: 'job-1' }; },
  };
  const res = await klaviyoTool(makeCtx({ jobStore })).handler({ action: 'subscribe-bulk', brand: 'acme', csvPath: 'C:/a.csv', listName: 'L' });
  assert.equal(started.length, 1, 'exactly one job must start');
  assert.equal(started[0].tool, 'klaviyo');
  assert.equal(started[0].meta.action, 'klaviyo-subscribe-bulk');
  assert.equal(started[0].meta.resume, undefined, 'no resume args may be persisted');
  assert.ok(!RESTART_RESUMABLE_EXPORT_ACTIONS.has('klaviyo-subscribe-bulk'),
    'a restart must never re-run an approved import without a fresh card');
  assert.equal(typeof started[0].runFn, 'function');
  assert.match(JSON.stringify(res), /DRY RUN/, 'a default call must be described as a dry run');
});

test('main.js cards the Bash path for both actions', () => {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const m = src.match(/const BASH_CARDED_DESTRUCTIVE = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, 'BASH_CARDED_DESTRUCTIVE must exist in main.js');
  for (const a of ['klaviyo-subscribe-bulk', 'klaviyo-list-create']) {
    assert.ok(m[1].includes(`'${a}'`), `${a} must be in BASH_CARDED_DESTRUCTIVE`);
  }
});
