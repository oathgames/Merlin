// REGRESSION GUARD (2026-08-05, ga-event-breakdown): GA4 custom-dimension
// READ reachability.
//
// Context: analytics_writes.go has been able to REGISTER a GA4 custom dimension
// (google-analytics-create-custom-dimension) since the write surface shipped,
// and gtm_quiz.go instruments a `quiz_step` event that carries step identity as
// event PARAMETERS. Found live on brand "revive" (property 539215592): four
// dimensions registered ("Quiz Category", "Quiz Sub Step", "Quiz Step Number",
// "Quiz Step ID"), the event firing correctly (31 active users over 2 days,
// confirmed via google-analytics-funnel), and NO action anywhere that could
// group or filter a report by any of them. So the question the instrumentation
// exists to answer ("which quiz question do people abandon on") was
// unanswerable from Merlin.
//
// google-analytics-event-breakdown and -step-funnel close that loop. This file
// locks the wire so the closing cannot un-close itself the way Rule 23
// describes: an engine capability that ships complete and stays unreachable
// because the MCP schema never declared it. Zod strips undeclared keys, so a
// param missing here is dropped before the handler runs. No type error, no
// log line, no compiler spanning the two repos.
//
// What this file locks:
//   1. Both actions are in the google_analytics action enum.
//   2. analyticsDimension is DECLARED, spelled exactly as the Go Command
//      struct's json tag.
//   3. Both are READS. They must NOT fall into the blastRadius write set and
//      put a confirmation card in front of a diagnostic.
//   4. End-to-end: analyticsDimension + analyticsEventName survive runBinary
//      into the --cmd JSON under the right engine action name.
//   5. The tool description names both actions, since the description is what
//      the agent routes on and an undocumented action is unreachable in
//      practice even when the enum allows it.
//
// CI runs these with no `npm install` (see .github/workflows/app-unit-tests.yml),
// so everything here is Node stdlib plus in-file stubs: no real zod.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

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
      describe: (text) => node({ ...extra, __describe: text }),
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

const READ_ACTIONS = ['event-breakdown', 'step-funnel'];

// ── 1. Actions are declared ──────────────────────────────────────────

test('google_analytics action enum includes event-breakdown and step-funnel', () => {
  const values = GA.schema.action.__enum;
  assert.ok(Array.isArray(values), 'action must be a z.enum');
  for (const action of READ_ACTIONS) {
    assert.ok(
      values.includes(action),
      `${action} is missing from the action enum, so the engine action is unreachable from the app (Hard-Won Security Rule 23).`,
    );
  }
});

// ── 2. Params are declared, spelled as the Go json tags ──────────────
//
// Source of truth: the Command struct in autocmo-core/main.go
// (AnalyticsDimension → "analyticsDimension", AnalyticsEventName →
// "analyticsEventName"). Cross-repo literals on purpose: autoCMO CI cannot see
// the Go source, so the contract is asserted as spelled strings on both sides.
// runBinary copies MCP arg keys onto the Command object verbatim, so a rename
// on either side silently breaks the wire with no type error.
const BREAKDOWN_COMMAND_KEYS = ['analyticsDimension', 'analyticsEventName'];

test('google_analytics declares every event-breakdown Command param', () => {
  for (const key of BREAKDOWN_COMMAND_KEYS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(GA.schema, key),
      `google_analytics input schema is missing "${key}": zod strips undeclared keys, so the engine can never receive it. See Command in autocmo-core/main.go.`,
    );
  }
});

test('analyticsDimension is a string, not an enum', () => {
  // It accepts four different shapes (a GA4 display name, a parameter name,
  // an explicit "customEvent:foo", or a built-in dimension) and the valid set
  // is per-property. An enum here would hard-code one property's dimensions
  // into the app and reject every other brand's.
  const field = GA.schema.analyticsDimension;
  assert.equal(field.__kind, 'string');
  assert.ok(!field.__enum, 'analyticsDimension must not be an enum: the valid values are per-property.');
});

test('analyticsDimension describe() tells the agent it accepts a GA4 display name', () => {
  // The describe text is the agent's only instruction on what to pass. A user
  // reads "Quiz Step Number" off the GA4 UI; the Data API only accepts
  // "customEvent:step_index". If the description does not say the display name
  // works, the agent guesses the API form and gets a 400.
  const text = GA.schema.analyticsDimension.__describe || '';
  assert.match(
    text, /display name/i,
    'analyticsDimension must document that a GA4 display name is accepted. That is the string a user can actually see.',
  );
  assert.match(
    text, /customEvent:/,
    'analyticsDimension must document the explicit Data API form as well.',
  );
});

// ── 3. Both actions are READS: no confirmation card ─────────────────
//
// defineTool does not forward blastRadius to the registration callback (it
// closes over it inside the wrapper), so these drive the REAL gate through the
// registered handler rather than reading the callback directly. That is the
// stronger test: it proves the gate does not fire, not merely that a name is
// absent from a set.
const envelopes = require('./mcp-envelope');

test('event-breakdown and step-funnel skip the confirmation gate', async () => {
  for (const action of READ_ACTIONS) {
    execFileCalls.length = 0;
    const parsed = envelopes.parse(await GA.handler({
      action,
      brand: 'revive',
      analyticsEventName: 'quiz_step',
      analyticsDimension: 'Quiz Step Number',
    }));
    assert.notEqual(
      parsed && parsed.error && parsed.error.code, 'CONFIRM_REQUIRED',
      `${action} is a read (a Data API runReport) and must not require confirmation. Gating it would put an approval card in front of a diagnostic.`,
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

test('event-breakdown params survive runBinary into the --cmd JSON', async () => {
  execFileCalls.length = 0;
  await runBinary(makeCtx(), 'google-analytics-event-breakdown', {
    brand: 'revive',
    analyticsPropertyId: '539215592',
    analyticsEventName: 'quiz_step',
    analyticsDimension: 'Quiz Step Number',
    batchCount: 30,
  });

  const cmd = lastCmd();
  assert.equal(cmd.action, 'google-analytics-event-breakdown');
  assert.equal(cmd.analyticsEventName, 'quiz_step', 'analyticsEventName must reach the engine');
  assert.equal(
    cmd.analyticsDimension, 'Quiz Step Number',
    'analyticsDimension must reach the engine VERBATIM. The engine resolves the display name against the property registry, so trimming or normalizing it here would break the lookup.',
  );
  assert.equal(cmd.analyticsPropertyId, '539215592');
});

test('step-funnel routes to the step-funnel engine action, not the funnel one', async () => {
  // google-analytics-funnel and google-analytics-step-funnel answer different
  // questions: funnel takes ordered EVENT NAMES, step-funnel takes one event
  // plus a dimension. Routing step-funnel at the funnel action would silently
  // return a one-row funnel, which is the exact bug this feature fixes.
  execFileCalls.length = 0;
  const parsed = envelopes.parse(await GA.handler({
    action: 'step-funnel',
    brand: 'revive',
    analyticsEventName: 'quiz_step',
    analyticsDimension: 'step_index',
  }));
  assert.ok(parsed, 'handler must return an envelope');

  const cmd = lastCmd();
  assert.equal(cmd.action, 'google-analytics-step-funnel');
  assert.equal(cmd.analyticsDimension, 'step_index');
});

// ── 5. The description documents both actions ────────────────────────

test('the google_analytics description names event-breakdown and step-funnel', () => {
  // The enum makes an action callable; the description is what makes the agent
  // call it. An action that is in the enum but absent from the description is
  // reachable in principle and unreachable in practice.
  for (const action of READ_ACTIONS) {
    assert.ok(
      GA.description.includes(action),
      `the google_analytics description must mention "${action}". The description is the agent's routing surface.`,
    );
  }
  assert.match(
    GA.description, /custom dimension/i,
    'the description must state that these read back a custom dimension: that is the capability gap they close.',
  );
});

// ── 6. Engine-side parity (dev workspaces only) ──────────────────────
//
// The Go binary lives in a sibling repo (autocmo-core, private). It IS present
// in dev workspaces but NOT in the public-repo CI runner, which only checks out
// autoCMO. Skip gracefully when it is unreachable, same policy as
// mcp-action-go-parity.test.js.
const MAIN_GO_PATH = path.join(__dirname, '..', '..', 'autocmo-core', 'main.go');
const MAIN_GO_SRC = fs.existsSync(MAIN_GO_PATH) ? fs.readFileSync(MAIN_GO_PATH, 'utf8') : null;

test('every declared action has a Go case (dev workspaces only)', { skip: MAIN_GO_SRC === null }, () => {
  for (const action of READ_ACTIONS) {
    const needle = `case "google-analytics-${action}":`;
    assert.ok(
      MAIN_GO_SRC.includes(needle),
      `main.go has no ${needle}. The MCP action would return "unknown action" from the binary.`,
    );
  }
  assert.ok(
    MAIN_GO_SRC.includes('json:"analyticsDimension,omitempty"'),
    'Command in main.go must declare analyticsDimension, spelled exactly as the zod key.',
  );
});
