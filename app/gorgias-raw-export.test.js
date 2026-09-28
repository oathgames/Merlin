// REGRESSION GUARD (2026-09-28, gorgias-raw)
//
// The Gorgias MCP tool's `export` action has two engine targets:
//   raw absent / false -> gorgias-export      (de-identified, READ_ONLY, auto-approves)
//   raw: true          -> gorgias-export-raw  (customer PII verbatim, carded)
// The raw path writes a brand's customer personal information to disk, so it
// must always show the approval card, the card must say "WITHOUT removing
// personal info", and a raw call must never land on the de-identified action
// (or the reverse). These tests pin all three, end to end into the --cmd JSON.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// mcp-tools destructures execFile at load time: stub BEFORE the require.
const childProcess = require('child_process');
const execFileCalls = [];
childProcess.execFile = function fakeExecFile(file, args, options, callback) {
  execFileCalls.push({ file, args, options });
  const child = { stdin: { on() {}, write() {}, end() {} }, kill() {} };
  setImmediate(() => callback(null, 'ok', ''));
  return child;
};

const policy = require('./mcp-approval-policy');
const { buildTools } = require('./mcp-tools');

const SRC_MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function makeZ() {
  const node = () => ({
    optional: () => node(), describe: () => node(), default: () => node(),
    regex: () => node(), int: () => node(),
  });
  return {
    string: () => node(), number: () => node(), boolean: () => node(),
    any: () => node(), enum: () => node(), coerce: { number: () => node() },
    array: () => node(), object: () => node(), record: () => node(),
  };
}

function makeCtx() {
  return {
    getConnections: () => [],
    readConfig: () => ({ gorgiasDomain: 'x', gorgiasEmail: 'x', gorgiasApiKey: 'x' }),
    readBrandConfig: () => ({ gorgiasDomain: 'x', gorgiasEmail: 'x', gorgiasApiKey: 'x' }),
    buildStrictBrandConfig: () => ({ gorgiasDomain: 'x', gorgiasEmail: 'x', gorgiasApiKey: 'x' }),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => __filename, // execFile is stubbed; nothing spawns
    appRoot: path.join(__dirname, '..'),
    isBinaryTooOld: () => false,
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
    // no jobStore: the handler falls through to a direct runBinary call,
    // which is what lets this test read the --cmd JSON synchronously.
  };
}

const entries = [];
buildTools((name, description, schema, handler, options) => {
  entries.push({ name, description, schema, handler, options });
  return { name };
}, makeZ(), makeCtx());
const gorgias = entries.find((e) => e.name === 'gorgias');

function lastCmd() {
  const call = execFileCalls[execFileCalls.length - 1];
  assert.ok(call, 'execFile must have been invoked');
  const i = call.args.indexOf('--cmd');
  assert.ok(i >= 0, '--cmd must be passed to the binary');
  return JSON.parse(call.args[i + 1]);
}

test('gorgias tool declares raw, gorgiasOptOutCsv and approved', () => {
  assert.ok(gorgias, 'gorgias tool must be registered');
  for (const key of ['raw', 'gorgiasOptOutCsv', 'approved']) {
    assert.ok(Object.prototype.hasOwnProperty.call(gorgias.schema, key),
      `gorgias.${key} must be declared: zod strips undeclared keys, and the IPC endpoint only sets approved when the schema has it.`);
  }
});

test('export + raw:true resolves to the carded export-raw action', () => {
  const out = policy.resolveMerlinAction('mcp__merlin__gorgias', { action: 'export', raw: true, brand: 'apotheke' });
  assert.equal(out.effectiveAction, 'export-raw');
  assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS.has('export-raw'), 'export-raw must card');
  assert.ok(!policy.READ_ONLY_ACTIONS.has('export-raw'), 'export-raw must never be read-only');
});

test('a malformed raw flag over-cards instead of auto-approving', () => {
  for (const raw of ['true', 1, 'yes', null]) {
    const out = policy.resolveMerlinAction('mcp__merlin__gorgias', { action: 'export', raw });
    assert.equal(out.effectiveAction, 'export-raw', `raw=${JSON.stringify(raw)} must card`);
  }
});

test('plain export is unchanged: read-only, no card', () => {
  for (const input of [{ action: 'export' }, { action: 'export', raw: false }]) {
    const out = policy.resolveMerlinAction('mcp__merlin__gorgias', input);
    assert.equal(out.effectiveAction, 'export');
    assert.ok(policy.READ_ONLY_ACTIONS.has('export'));
  }
  // Other tools' export is untouched by the gorgias rule.
  assert.equal(policy.resolveMerlinAction('mcp__merlin__klaviyo', { action: 'export', raw: true }).effectiveAction, 'export');
});

test('the approval card says personal info is NOT removed and names the brand', () => {
  assert.ok(SRC_MAIN.includes("toolName === 'mcp__merlin__gorgias' && input && input.action === 'export'"),
    'translateTool must carry an explicit gorgias raw-export label');
  assert.ok(SRC_MAIN.includes('Export ${brandLabel} Gorgias tickets WITHOUT removing personal info (health-related tickets excluded)'),
    'card label must state that personal info is not removed');
  assert.ok(SRC_MAIN.includes('${input.brand.trim().toUpperCase()}\'s'),
    'card label must name the brand (apotheke renders as APOTHEKE\'s)');
});

test('raw export reaches gorgias-export-raw with approved and opt-out, without the raw key', async () => {
  execFileCalls.length = 0;
  await gorgias.handler({ action: 'export', raw: true, brand: 'apotheke', approved: true, gorgiasOptOutCsv: 'C:/optout.csv' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'gorgias-export-raw');
  assert.equal(cmd.approved, true, 'the engine refuses a raw export unless approved reaches it');
  assert.equal(cmd.gorgiasOptOutCsv, 'C:/optout.csv');
  assert.ok(!('raw' in cmd), 'raw is a routing flag, not an engine field');
});

test('de-identified export never carries raw-only keys to the engine', async () => {
  execFileCalls.length = 0;
  await gorgias.handler({ action: 'export', brand: 'apotheke', approved: true, gorgiasOptOutCsv: 'C:/optout.csv' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'gorgias-export');
  for (const k of ['raw', 'approved', 'gorgiasOptOutCsv']) {
    assert.ok(!(k in cmd), `${k} must not reach the de-identified export`);
  }
  execFileCalls.length = 0;
  await gorgias.handler({ action: 'export', raw: false, brand: 'apotheke' });
  assert.equal(lastCmd().action, 'gorgias-export', 'raw:false stays de-identified');
});
