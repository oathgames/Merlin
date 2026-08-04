// REGRESSION GUARD (2026-08-03): GA4 Enhanced Measurement param reachability.
//
// Context: analytics.go has read a data stream's enhancedMeasurementSettings
// since the audit-property action shipped, and raises an "Enhanced Measurement
// off" finding from it. Found live on brand "revive" (property 539215592):
// the audit correctly reported the signal as off, and there was no way to fix
// it from Merlin, because Enhanced Measurement is a data-stream sub-resource
// and update-property-settings only patches property-level fields.
//
// google-analytics-update-stream-settings closes that loop. This file locks
// the wire so it cannot repeat the Rule 23 failure mode: an engine capability
// that ships complete and stays unreachable because the MCP schema never
// declared its params. Zod strips undeclared keys, so a param that is missing
// here is dropped before the handler runs, with no type error anywhere and no
// compiler spanning the two repos.
//
// What this file locks:
//   1. `update-stream-settings` is in the google_analytics action enum.
//   2. Its two params (analyticsStreamId, analyticsStreamSettings) are
//      DECLARED, spelled exactly as the Go Command struct's json tags.
//   3. It is in the blastRadius write set, so it cannot slip through the
//      per-action preview gate as if it were a read.
//   4. End-to-end: both params survive runBinary into the --cmd JSON, with
//      the nested boolean map intact.
//
// CI runs these with no `npm install` (see .github/workflows/app-unit-tests.yml),
// so everything here is Node stdlib plus in-file stubs: no real zod.

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
  setImmediate(() => callback(null, 'ok', ''));
  return child;
};

const { buildTools, runBinary } = require('./mcp-tools');

function makeZ() {
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
    string: () => node({ __kind: 'string' }),
    number: () => node({ __kind: 'number' }),
    boolean: () => node({ __kind: 'boolean' }),
    any: () => node(),
    enum: (vals) => node({ __enum: vals }),
    coerce: { number: () => node() },
    array: (item) => node({ __item: item }),
    object: (shape) => node({ __shape: shape }),
    // Record captures its value schema so the assertions below can prove the
    // settings map is boolean-valued rather than open-ended.
    record: (value) => node({ __kind: 'record', __value: value }),
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
  buildTools(tool, makeZ(), makeCtx());
  return entries;
}

const TOOLS = registry();
const GA = (() => {
  const t = TOOLS.find((e) => e.name === 'google_analytics');
  assert.ok(t, 'google_analytics tool must be registered');
  return t;
})();

// ── 1. Action is declared ────────────────────────────────────────────

test('google_analytics action enum includes update-stream-settings', () => {
  const values = GA.schema.action.__enum;
  assert.ok(Array.isArray(values), 'action must be a z.enum');
  assert.ok(
    values.includes('update-stream-settings'),
    'update-stream-settings is missing from the action enum, so the engine action is unreachable from the app (Hard-Won Security Rule 23).',
  );
});

// ── 2. Params are declared, spelled as the Go json tags ──────────────
//
// Source of truth: the Command struct in autocmo-core/main.go
// (AnalyticsStreamId → "analyticsStreamId",
//  AnalyticsStreamSettings → "analyticsStreamSettings"). These are cross-repo
// literals on purpose: autoCMO CI cannot see the Go source, so the contract is
// asserted as spelled strings on both sides. runBinary copies MCP arg keys
// onto the Command object verbatim, so a rename on either side silently
// breaks the wire with no type error.
const STREAM_SETTINGS_COMMAND_KEYS = ['analyticsStreamId', 'analyticsStreamSettings'];

test('google_analytics declares every update-stream-settings Command param', () => {
  for (const key of STREAM_SETTINGS_COMMAND_KEYS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(GA.schema, key),
      `google_analytics input schema is missing "${key}": zod strips undeclared keys, so the engine can never receive it. See Command in autocmo-core/main.go.`,
    );
  }
});

test('analyticsStreamSettings is a boolean-valued record', () => {
  const field = GA.schema.analyticsStreamSettings;
  assert.equal(
    field.__kind, 'record',
    'analyticsStreamSettings must be z.record(...): the engine reads it as map[string]interface{} of Enhanced Measurement toggles.',
  );
  assert.equal(
    field.__value && field.__value.__kind, 'boolean',
    'analyticsStreamSettings must be z.record(z.boolean()): the engine hard-refuses a non-boolean value, so an open-ended record would push a validation failure from the schema down into the binary where the user sees it as a fatal instead of a field error.',
  );
});

test('analyticsStreamId is a string, not a number', () => {
  // GA4 stream ids are numeric-looking but must stay strings: they are path
  // segments, and a number schema would lose precision on large ids and
  // break the "properties/{p}/dataStreams/{s}" full-path form the engine
  // also accepts.
  assert.equal(GA.schema.analyticsStreamId.__kind, 'string');
});

// ── 3. The action is gated as a write ────────────────────────────────
//
// defineTool does not forward blastRadius to the registration callback (it
// closes over it inside the wrapper), so these drive the REAL gate through
// the registered handler rather than reading the callback directly. That is
// the stronger test: it proves the gate fires, not merely that a name appears
// in a set.
const envelopes = require('./mcp-envelope');

test('update-stream-settings refuses to run without a confirmation round-trip', async () => {
  execFileCalls.length = 0;
  const parsed = envelopes.parse(await GA.handler({
    action: 'update-stream-settings',
    brand: 'revive',
    analyticsStreamSettings: { streamEnabled: true },
  }));

  assert.ok(parsed && parsed.ok === false, 'an unconfirmed write must fail closed');
  assert.equal(
    parsed.error && parsed.error.code, 'CONFIRM_REQUIRED',
    'update-stream-settings must be in the blastRadius write set: it PATCHes a live GA4 data stream and changes what the site measures.',
  );
  assert.equal(
    execFileCalls.length, 0,
    'the engine must not be invoked before the write is confirmed.',
  );
});

test('update-stream-settings preview mints a confirm_token', async () => {
  execFileCalls.length = 0;
  const parsed = envelopes.parse(await GA.handler({
    action: 'update-stream-settings',
    brand: 'revive',
    analyticsStreamSettings: { streamEnabled: true },
    preview: true,
  }));

  assert.ok(parsed && parsed.ok, 'a preview call must succeed');
  assert.ok(parsed.data && parsed.data.confirm_token, 'preview must mint a confirm_token');
  assert.ok(
    parsed.data.blast_radius && parsed.data.blast_radius.reason,
    'the approval card needs a human-readable reason.',
  );
  assert.equal(execFileCalls.length, 0, 'a preview must not reach the engine');
});

test('read actions still skip the confirmation gate', async () => {
  // Guards against a fat-fingered edit that widens the write set to every
  // action and turns every GA4 read into a two-step confirm. audit-property
  // matters most here: it is the action that SURFACES the Enhanced
  // Measurement finding, so gating it would put a confirm step in front of a
  // pure diagnostic.
  for (const action of ['audit-property', 'traffic', 'discover']) {
    execFileCalls.length = 0;
    const parsed = envelopes.parse(await GA.handler({ action, brand: 'revive' }));
    assert.notEqual(
      parsed && parsed.error && parsed.error.code, 'CONFIRM_REQUIRED',
      `${action} is a read and must not require confirmation.`,
    );
    assert.equal(execFileCalls.length, 1, `${action} should reach the engine directly`);
  }
});

// ── 4. End-to-end: declared params reach the engine's --cmd JSON ─────

function lastCmd() {
  const call = execFileCalls[execFileCalls.length - 1];
  assert.ok(call, 'execFile must have been invoked');
  const i = call.args.indexOf('--cmd');
  assert.ok(i >= 0, '--cmd must be passed to the binary');
  return JSON.parse(call.args[i + 1]);
}

test('update-stream-settings params survive runBinary into the --cmd JSON', async () => {
  execFileCalls.length = 0;
  await runBinary(makeCtx(), 'google-analytics-update-stream-settings', {
    brand: 'revive',
    analyticsPropertyId: '539215592',
    analyticsStreamId: '7654321',
    analyticsStreamSettings: { streamEnabled: true, pageChangesEnabled: true },
    approved: true,
  });

  const cmd = lastCmd();
  assert.equal(cmd.action, 'google-analytics-update-stream-settings');
  assert.equal(cmd.analyticsStreamId, '7654321', 'analyticsStreamId must reach the engine');
  assert.deepEqual(
    cmd.analyticsStreamSettings,
    { streamEnabled: true, pageChangesEnabled: true },
    'the nested Enhanced Measurement map must reach the engine intact',
  );
  assert.equal(cmd.approved, true, 'the approval flag must reach the engine (Hard-Won Security Rule 18)');
});

test('a false-valued toggle is not dropped on the way to the engine', async () => {
  // runBinary skips undefined/null/'' but must keep `false`: turning a signal
  // OFF is a legitimate patch, and silently dropping it would make the engine
  // see an empty settings map and refuse.
  execFileCalls.length = 0;
  await runBinary(makeCtx(), 'google-analytics-update-stream-settings', {
    brand: 'revive',
    analyticsStreamId: '7654321',
    analyticsStreamSettings: { streamEnabled: false },
    approved: true,
  });

  const cmd = lastCmd();
  assert.deepEqual(cmd.analyticsStreamSettings, { streamEnabled: false });
});
