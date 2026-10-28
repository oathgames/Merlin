// REGRESSION GUARD (2026-10-08, Rule 23): Klaviyo segment-get + metric-aggregate
// measurement reachability.
//
// merlin-core added the read-only `klaviyo-segment-get` action (Command.SegmentID,
// json "segmentId") and a `Command.Measurement` (json "measurement") option on
// `klaviyo-metric-aggregate`. zod strips keys a tool schema never declared, so
// an undeclared segmentId or measurement is dropped before the handler runs and
// the engine silently answers a different question (no segment, or "count"
// instead of revenue). Nothing errors. This file locks:
//   1. `segment-get` is in the klaviyo action enum, and is NOT carded (it is a
//      read-only GET).
//   2. `segmentId` and `measurement` are declared, spelled as the Go json tags,
//      and measurement is the exact engine-accepted set.
//   3. End-to-end through the tool handler: both land in the --cmd JSON.
//
// Node stdlib plus in-file stubs only (CI runs with no `npm install`).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const childProcess = require('child_process');
const execFileCalls = [];
childProcess.execFile = function fakeExecFile(file, args, options, callback) {
  execFileCalls.push({ file, args, options });
  const child = { stdin: { on() {}, write() {}, end() {} }, kill() {} };
  setImmediate(() => callback(null, 'ok', ''));
  return child;
};

const path = require('node:path');
const { buildTools, runBinary } = require('./mcp-tools');
const approvalPolicy = require('./mcp-approval-policy');

function makeZ() {
  const node = (extra = {}) => ({
    ...extra,
    optional: () => node(extra),
    describe: (d) => node({ ...extra, __describe: d }),
    default: () => node(extra),
    regex: () => node(extra),
    int: () => node(extra),
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

function klaviyoTool() {
  const entries = [];
  const tool = (name, description, schema, handler, options) => {
    entries.push({ name, description, schema, handler, options });
    return { name };
  };
  buildTools(tool, makeZ(), makeCtx());
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

test('klaviyo action enum includes segment-get', () => {
  const shape = shapeOf(klaviyoTool());
  assert.ok(shape.action.__enum.includes('segment-get'),
    'segment-get must be routable: main.go has case "klaviyo-segment-get".');
});

test('segment-get is read-only and never carded', () => {
  const carded = approvalPolicy.CARDED_DESTRUCTIVE_ACTIONS;
  if (carded) {
    const has = typeof carded.has === 'function' ? carded.has.bind(carded) : (k) => carded.includes(k);
    assert.ok(!has('segment-get') && !has('klaviyo-segment-get'),
      'segment-get is a GET; carding it would put an approval card in front of a read.');
  }
});

test('segmentId and measurement are declared with the engine spelling', () => {
  const shape = shapeOf(klaviyoTool());
  assert.ok(Object.prototype.hasOwnProperty.call(shape, 'segmentId'), 'segmentId must be declared (Command.SegmentID json "segmentId")');
  assert.equal(shape.segmentId.__kind, 'string');
  assert.ok(Object.prototype.hasOwnProperty.call(shape, 'measurement'), 'measurement must be declared (Command.Measurement json "measurement")');
  assert.deepEqual(shape.measurement.__enum, ['count', 'unique', 'sum_value'],
    'measurement must be exactly the set klaviyoNormalizeMeasurement accepts.');
});

test('segmentId reaches --cmd for klaviyo-segment-get via the tool handler', async () => {
  execFileCalls.length = 0;
  await klaviyoTool().handler({ action: 'segment-get', brand: 'acme', segmentId: 'SegA1' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'klaviyo-segment-get');
  assert.equal(cmd.segmentId, 'SegA1');
});

test('measurement reaches --cmd for klaviyo-metric-aggregate via the tool handler', async () => {
  execFileCalls.length = 0;
  await klaviyoTool().handler({ action: 'metric-aggregate', brand: 'acme', metricId: 'PO1', measurement: 'sum_value', batchCount: 7 });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'klaviyo-metric-aggregate');
  assert.equal(cmd.measurement, 'sum_value');
  assert.equal(cmd.metricId, 'PO1');
});

test('metricId reaches --cmd for flow-message-performance (conversion metric override)', async () => {
  execFileCalls.length = 0;
  await runBinary(makeCtx(), 'klaviyo-flow-message-performance', { brand: 'acme', flowId: 'F1', metricId: 'RX9' });
  const cmd = lastCmd();
  assert.equal(cmd.metricId, 'RX9');
  assert.equal(cmd.flowId, 'F1');
});
