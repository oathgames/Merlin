// REGRESSION GUARD (2026-09-28, ipc-approval-bypass) test suite.
//
// Incident: the klaviyo tool's flow-set-message-template action is in
// CARDED_DESTRUCTIVE_ACTIONS, but called over the local IPC sidecar
// (mcp-ipc-endpoint.js, authenticated with <stateDir>/mcp-shim-token and
// used by external Claude Code sessions) it executed in ~1.7s with no card
// and no approved flag. Five live Klaviyo flow emails were changed. Root
// cause: dispatchRequest called tool.handler directly, and the host
// approval decision (handleToolApproval in main.js) was wired only into the
// Agent SDK's canUseTool.
//
// Amended 2026-10-04 (desktop-approval, Ryan operator decision): approval
// for an authenticated external MCP call lives on the originating client
// (Claude Desktop prompts per tool). The 2026-09-28 gate wiring stays, but a
// card-tier decision on the 'ipc' surface now resolves to allow with
// hostApproved:true instead of an in-app card.
//
// What this file locks:
//   (a) a carded destructive action over IPC runs with no card, and the app
//       (never the caller) sets the engine's `approved` flag
//   (b) spend over IPC runs the same way, while deny rails still refuse
//   (c) a caller-passed approved:true neither reaches the decision nor the
//       handler
//   (d) read-only actions still run, with no approved flag
//   plus the auth check, fail-closed behavior, and source scans that pin the
//   wiring, so a refactor of main.js or the endpoint cannot silently drop
//   the deny rails or let tool input pick the approval surface.
//
// The approver used here models handleToolApproval's tier order with the
// REAL policy sets from mcp-approval-policy.js (main.js itself cannot be
// loaded outside Electron). The source scans below pin that main.js passes
// handleToolApproval, unchanged, as the endpoint's decision.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ipc = require('./mcp-ipc-endpoint');
const policy = require('./mcp-approval-policy');
const budgetCeiling = require('./budget-ceiling');
const callOrigin = require('./mcp-call-origin');

const SRC_ENDPOINT = fs.readFileSync(path.join(__dirname, 'mcp-ipc-endpoint.js'), 'utf8');
const SRC_MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const SRC_SHIM = fs.readFileSync(path.join(__dirname, 'merlin-mcp-shim.js'), 'utf8');

const TOKEN = 'a'.repeat(32);

function tmpDir() {
  const d = path.join(os.tmpdir(), 'merlin-ipc-gate-test-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Fake wrapped-tool registry. Schemas mirror the real ones for the keys
// that matter: klaviyo declares `approved` (mcp-tools.js), the Meta intent
// tool and the legacy meta_ads multiplexer do not.
function fakeTools() {
  const calls = [];
  const mk = (name, inputSchema) => ({
    name,
    description: name,
    inputSchema,
    annotations: {},
    handler: async (args, extra) => {
      calls.push({ tool: name, args: Object.assign({}, args), external: callOrigin.isExternalOrigin(extra) });
      return { content: [{ type: 'text', text: 'ran ' + name }] };
    },
  });
  return {
    calls,
    tools: [
      mk('klaviyo', { action: {}, brand: {}, flowId: {}, templateId: {}, approved: {} }),
      mk('meta_launch_test_ad', { brand: {}, dailyBudget: {}, adImagePath: {} }),
      mk('meta_ads', { action: {}, brand: {}, dailyBudget: {} }),
    ],
  };
}

// Models handleToolApproval's mcp__merlin__ branch for the 'ipc' surface
// using the real policy sets and the real budget deny rail:
//   * deny rails first (the cents detector / absolute ceiling via
//     budget-ceiling.denyReasonForBudget), exactly as main.js orders them;
//   * where the in-app path would card, the IPC surface returns allow with
//     hostApproved:true (REGRESSION GUARD 2026-10-04, desktop-approval):
//     the MCP client already prompted, so no Merlin card and no wait.
function policyApprover() {
  const seen = [];
  const approve = async (toolName, input) => {
    const { effectiveAction: action } = policy.resolveMerlinAction(toolName, input);
    const needsCard = policy.SPEND_ACTIONS.has(action) || policy.CARDED_DESTRUCTIVE_ACTIONS.has(action);
    seen.push({ toolName, input: Object.assign({}, input), action, carded: needsCard });
    if (policy.READ_ONLY_ACTIONS.has(action) || !needsCard) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (policy.SPEND_ACTIONS.has(action)) {
      const denial = budgetCeiling.denyReasonForBudget(input.dailyBudget || 5, 0);
      if (denial) return { behavior: 'deny', message: denial };
    }
    return { behavior: 'allow', updatedInput: input, hostApproved: true };
  };
  return { approve, seen };
}

function call(name, args, { tools, approve }) {
  return ipc.dispatchRequest(
    { id: 'x', auth: TOKEN, method: 'tools/call', params: { name, arguments: args } },
    { tools, expectedToken: TOKEN, ctx: { appRoot: tmpDir() }, approve }
  );
}

const FLOW_SET = { action: 'flow-set-message-template', brand: 'vela', flowId: 'F1', templateId: 'T1' };

// ── Policy preconditions ─────────────────────────────────────

test('policy: the incident action and the spend fixtures are gated tiers', () => {
  assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS.has('flow-set-message-template'));
  assert.strictEqual(policy.INTENT_TOOL_TO_ACTION['mcp__merlin__meta_launch_test_ad'], 'push');
  assert.ok(policy.SPEND_ACTIONS.has('push'));
  assert.ok(policy.READ_ONLY_ACTIONS.has('flows-list'));
});

// ── (a) carded destructive: approved at the originating client ──

test('(a) klaviyo flow-set-message-template over IPC runs with no card and the app sets approved', async () => {
  const { tools, calls } = fakeTools();
  const { approve, seen } = policyApprover();
  const resp = await call('klaviyo', Object.assign({}, FLOW_SET), { tools, approve });
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(calls.length, 1, 'handler runs without waiting on an in-app card');
  assert.strictEqual(calls[0].args.approved, true, 'approved set exactly as after a click on Approve');
  assert.strictEqual(calls[0].external, true, 'handler sees the transport-derived external origin');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].toolName, 'mcp__merlin__klaviyo', 'decision must see the SDK-qualified tool name');
  assert.strictEqual(seen[0].carded, true);
});

// ── (b) spend ────────────────────────────────────────────────

test('(b) spend intent tool meta_launch_test_ad over IPC runs; approved not injected into a schema that lacks it', async () => {
  const { tools, calls } = fakeTools();
  const { approve, seen } = policyApprover();
  const resp = await call('meta_launch_test_ad', { brand: 'vela', dailyBudget: 20, adImagePath: 'a.png' }, { tools, approve });
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(seen[0].action, 'push');
  assert.ok(!('approved' in calls[0].args), 'defineTool strict schemas reject undeclared keys');
});

test('(b) budget deny rail still refuses an external spend call (cents-scale budget)', async () => {
  const { tools, calls } = fakeTools();
  const { approve } = policyApprover();
  const resp = await call('meta_ads', { action: 'push', brand: 'vela', dailyBudget: 250000 }, { tools, approve });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(calls.length, 0, 'a deny rail is not a prompt; external origin never waives it');
});

test('(b) a deny decision of any kind keeps the handler from running', async () => {
  const { tools, calls } = fakeTools();
  const deny = async () => ({ behavior: 'deny', message: 'Merlin is not allowed to delete campaigns.' });
  const resp = await call('klaviyo', Object.assign({}, FLOW_SET), { tools, approve: deny });
  assert.strictEqual(resp.ok, false);
  assert.match(resp.error.message, /not allowed/);
  assert.strictEqual(calls.length, 0);
});

// ── (c) caller-supplied approved flag ────────────────────────

test('(c) caller-passed approved:true is stripped before the decision', async () => {
  const { tools } = fakeTools();
  const { approve, seen } = policyApprover();
  await call('klaviyo', Object.assign({ approved: true }, FLOW_SET), { tools, approve });
  assert.ok(!('approved' in seen[0].input), 'the decision must never see a caller-supplied approved flag');
});

test('(c) caller-passed approved:true never reaches the handler on a non-host-approved path', async () => {
  // A decision that allows WITHOUT hostApproved (long-tail auto-approve)
  // must not let a caller-set flag flow through to requireApproval().
  const { tools, calls } = fakeTools();
  const autoAllow = async (_n, input) => ({ behavior: 'allow', updatedInput: Object.assign({}, input, { approved: true }) });
  const resp = await call('klaviyo', Object.assign({ approved: true }, FLOW_SET), { tools, approve: autoAllow });
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.ok(!('approved' in calls[0].args), 'approved is only ever set by the app');
});

// ── (d) read-only ────────────────────────────────────────────

test('(d) read-only action runs over IPC with no card and no approved flag', async () => {
  const { tools, calls } = fakeTools();
  const { approve, seen } = policyApprover();
  const resp = await call('klaviyo', { action: 'flows-list', brand: 'vela' }, { tools, approve });
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(seen[0].carded, false);
  assert.ok(!('approved' in calls[0].args));
});

// ── Fail-closed ──────────────────────────────────────────────

test('fail-closed: no approve function means tools/call never runs', async () => {
  const { tools, calls } = fakeTools();
  const resp = await call('klaviyo', { action: 'flows-list', brand: 'vela' }, { tools, approve: undefined });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'APPROVAL_UNAVAILABLE');
  assert.strictEqual(calls.length, 0);
});

test('fail-closed: a throwing approval decision never runs the tool', async () => {
  const { tools, calls } = fakeTools();
  const boom = async () => { throw new Error('internal detail /secret/path'); };
  const resp = await call('klaviyo', Object.assign({}, FLOW_SET), { tools, approve: boom });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'APPROVAL_UNAVAILABLE');
  assert.doesNotMatch(resp.error.message, /secret/, 'raw error text must not leak to the caller');
  assert.strictEqual(calls.length, 0);
});

test('fail-closed: start() refuses to boot without an approve function', () => {
  const d = tmpDir();
  const { tools } = fakeTools();
  assert.throws(() => ipc.start({ stateDir: d, tools, ctx: { appRoot: d } }), /approve function required/);
});

// ── End to end over the real socket / named pipe ─────────────

test('e2e: an external call over the live socket runs with no card, caller approved stripped, app approved set', async () => {
  const d = tmpDir();
  const { tools, calls } = fakeTools();
  const { approve, seen } = policyApprover();
  const ep = ipc.start({ stateDir: d, tools, ctx: { appRoot: d }, approve });
  try {
    await new Promise((resolve) => {
      if (ep.server.listening) return resolve();
      ep.server.once('listening', resolve);
    });
    const send = (req) => new Promise((resolve, reject) => {
      const sock = net.createConnection(ep.socketPath);
      let buf = '';
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('e2e timeout')); }, 3000);
      sock.setEncoding('utf8');
      sock.on('error', (e) => { clearTimeout(timer); reject(e); });
      sock.on('connect', () => { sock.write(JSON.stringify(req) + '\n'); });
      sock.on('data', (chunk) => {
        buf += chunk;
        const idx = buf.indexOf('\n');
        if (idx >= 0) {
          clearTimeout(timer);
          try { resolve(JSON.parse(buf.slice(0, idx))); } catch (e) { reject(e); }
          sock.end();
        }
      });
    });
    // Wrong token: refused before any decision or handler.
    const bad = await send({
      id: 'bad', auth: 'b'.repeat(32), method: 'tools/call',
      params: { name: 'klaviyo', arguments: Object.assign({}, FLOW_SET) },
    });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.error.code, 'AUTH_FAILED');
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(seen.length, 0);

    const resp = await send({
      id: 'e2e', auth: ep.token, method: 'tools/call',
      params: { name: 'klaviyo', arguments: Object.assign({ approved: true }, FLOW_SET) },
    });
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].args.approved, true);
    assert.strictEqual(calls[0].external, true);
    assert.ok(!('approved' in seen[0].input));
  } finally {
    ep.stop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

// ── Source scans: the wiring cannot be silently dropped ──────

test('source: dispatchRequest strips approved, calls approve, and only then the handler with external origin', () => {
  const start = SRC_ENDPOINT.indexOf('async function dispatchRequest(');
  const end = SRC_ENDPOINT.indexOf('\nfunction readActiveBrand(', start);
  assert.ok(start > 0 && end > start, 'dispatchRequest body not found');
  const body = SRC_ENDPOINT.slice(start, end);
  assert.match(body, /REGRESSION GUARD \(2026-09-28/);
  assert.match(body, /REGRESSION GUARD \(2026-10-04, desktop-approval\)/);
  const authIdx = body.indexOf('constantTimeEqual(reqJson.auth');
  const stripIdx = body.indexOf('stripCallerApproval(args)');
  const approveIdx = body.indexOf('await approve(MERLIN_TOOL_PREFIX + name');
  const handlerIdx = body.indexOf('tool.handler(');
  assert.ok(authIdx > 0 && stripIdx > authIdx, 'caller approved flag stripped after the token check');
  assert.ok(approveIdx > stripIdx, 'approval decision must run on the stripped args');
  assert.ok(handlerIdx > approveIdx, 'handler must only be reached after the approval decision');
  assert.strictEqual(body.split('tool.handler(').length - 1, 1, 'exactly one handler call site, behind the gate');
  assert.match(body, /tool\.handler\(finalArgs, callOrigin\.externalOriginExtra\(/);
  assert.match(body, /decision\.hostApproved === true/);
  assert.doesNotMatch(body, /humanApproved/, 'external calls no longer wait on a human click in Merlin');
  assert.strictEqual(ipc.MERLIN_TOOL_PREFIX, 'mcp__merlin__');
});

test('source: main.js passes handleToolApproval with the ipc surface set from the transport', () => {
  const idx = SRC_MAIN.indexOf('_mcpIpcEndpoint = startMcpIpc({');
  assert.ok(idx > 0, 'startMcpIpc call site not found');
  const site = SRC_MAIN.slice(idx, SRC_MAIN.indexOf('});', idx));
  assert.match(site, /approve:\s*\(toolName, input\)\s*=>\s*handleToolApproval\(toolName, input, \{ merlinApprovalSurface: 'ipc' \}\)/);
  assert.match(site, /REGRESSION GUARD \(2026-09-28/);
  assert.match(site, /REGRESSION GUARD \(2026-10-04, desktop-approval\)/);
  // The surface flag is only ever set at that call site, never derived from input.
  const code = SRC_MAIN.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const setSites = code.split("merlinApprovalSurface: 'ipc'").length - 1;
  assert.strictEqual(setSites, 1, 'merlinApprovalSurface must be set only at the startMcpIpc call site');
  assert.doesNotMatch(SRC_MAIN, /input\.merlinApprovalSurface|input\[['"]merlinApprovalSurface/);
});

test('source: every card in the mcp__merlin__ branch resolves external origin before emitting, after the deny rails', () => {
  const start = SRC_MAIN.indexOf("if (toolName.startsWith('mcp__merlin__')) {");
  const end = SRC_MAIN.indexOf('All other MCP merlin tools: auto-approve', start);
  assert.ok(start > 0 && end > start, 'mcp__merlin__ branch not found');
  const branch = SRC_MAIN.slice(start, end);
  const emit = "win.webContents.send('approval-request', payload)";
  const resolver = 'resolveExternalOriginCard(payload, toolName, input, opts)';
  const emissions = branch.split(emit).length - 1;
  assert.ok(emissions >= 2, 'expected the spend and carded-destructive card sites');
  assert.strictEqual(branch.split(resolver).length - 1, emissions,
    'every card emission must first hand external calls back to the originating client');
  let from = 0;
  for (let i = 0; i < emissions; i++) {
    const r = branch.indexOf(resolver, from);
    const e = branch.indexOf(emit, from);
    assert.ok(r > 0 && r < e, 'resolver must run before the card is emitted');
    from = e + emit.length;
  }
  const denyIdx = branch.indexOf('budgetCeiling.denyReasonForBudget(adBudget, capForComparison)');
  assert.ok(denyIdx > 0 && denyIdx < branch.indexOf(resolver), 'budget deny rail must run before the external allow');
  assert.ok(SRC_MAIN.indexOf('const deny = checkHardDeny(toolName, input);') < SRC_MAIN.indexOf("if (toolName.startsWith('mcp__merlin__')) {"),
    'hard-deny runs before any allow');
  assert.doesNotMatch(branch, /return new Promise\(/);
  assert.match(SRC_MAIN, /async function handleToolApproval\(toolName, input, opts\)/);
});

test('source: resolveExternalOriginCard is a no-op off the ipc surface and never emits a card', () => {
  const start = SRC_MAIN.indexOf('function resolveExternalOriginCard(');
  assert.ok(start > 0);
  const body = SRC_MAIN.slice(start, SRC_MAIN.indexOf('\nfunction awaitApprovalDecision(', start));
  assert.match(body, /if \(!isIpcApprovalSurface\(opts\)\) return null;/);
  assert.match(body, /hostApproved: true/);
  assert.doesNotMatch(body, /approval-request|setPendingApproval|nudgeForApproval/);
  const guardIdx = SRC_MAIN.indexOf('REGRESSION GUARD (2026-10-04, desktop-approval): Ryan operator decision');
  assert.ok(guardIdx > 0 && guardIdx < start, 'guard block must sit above the helper');
});
