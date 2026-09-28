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
// What this file locks:
//   (a) a carded destructive action cannot run over IPC without approval
//   (b) a spend action cannot run over IPC without approval
//   (c) a caller-passed approved:true neither satisfies the gate nor reaches
//       the handler
//   (d) read-only actions still run, with no card
//   (e) a human Allow on the card runs the action, and only then is the
//       engine's `approved` flag set
//   plus fail-closed behavior and source scans that pin the wiring, so a
//   refactor of main.js or the endpoint cannot silently drop the gate.
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
    handler: async (args) => {
      calls.push({ tool: name, args: Object.assign({}, args) });
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

// Models handleToolApproval's mcp__merlin__ branch using the real policy
// sets. `card` decides what happens when a card is required:
//   'allow' -> human clicked Allow (humanApproved:true, as main.js returns)
//   'deny'  -> human clicked Deny
//   'none'  -> no window to show a card on
function policyApprover(card) {
  const seen = [];
  const approve = async (toolName, input) => {
    const { effectiveAction: action } = policy.resolveMerlinAction(toolName, input);
    const needsCard = policy.SPEND_ACTIONS.has(action) || policy.CARDED_DESTRUCTIVE_ACTIONS.has(action);
    seen.push({ toolName, input: Object.assign({}, input), action, carded: needsCard });
    if (policy.READ_ONLY_ACTIONS.has(action) || !needsCard) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (card === 'allow') return { behavior: 'allow', updatedInput: input, humanApproved: true };
    if (card === 'deny') {
      return { behavior: 'deny', code: 'APPROVAL_DENIED', message: 'This action was declined in the Merlin app, so it was not run.' };
    }
    return {
      behavior: 'deny',
      code: 'APPROVAL_REQUIRED',
      message: 'This action needs your approval in the Merlin app, but the Merlin window is not open, so it was not run. Open Merlin and try again.',
    };
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

test('policy: IPC approval deadline is below the shim request timeout', () => {
  const m = SRC_SHIM.match(/const REQUEST_TIMEOUT_MS = ([^;]+);/);
  assert.ok(m, 'shim REQUEST_TIMEOUT_MS not found');
  // eslint-disable-next-line no-new-func
  const shimTimeout = Function(`return (${m[1]});`)();
  assert.ok(Number.isFinite(policy.IPC_APPROVAL_DEADLINE_MS) && policy.IPC_APPROVAL_DEADLINE_MS > 0);
  assert.ok(policy.IPC_APPROVAL_DEADLINE_MS < shimTimeout,
    `IPC_APPROVAL_DEADLINE_MS (${policy.IPC_APPROVAL_DEADLINE_MS}) must be < shim REQUEST_TIMEOUT_MS (${shimTimeout}); otherwise an Allow after the shim gave up runs an action the caller was told failed`);
});

// ── (a) carded destructive ───────────────────────────────────

test('(a) klaviyo flow-set-message-template over IPC does not run when no card can be shown', async () => {
  const { tools, calls } = fakeTools();
  const { approve, seen } = policyApprover('none');
  const resp = await call('klaviyo', Object.assign({}, FLOW_SET), { tools, approve });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'APPROVAL_REQUIRED');
  assert.match(resp.error.message, /approval/i);
  assert.doesNotMatch(resp.error.message, /\bat \S+:\d+/, 'no stack frames in caller-facing text');
  assert.strictEqual(calls.length, 0, 'handler must not run');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].toolName, 'mcp__merlin__klaviyo', 'decision must see the SDK-qualified tool name');
  assert.strictEqual(seen[0].carded, true);
});

test('(a) klaviyo flow-set-message-template over IPC does not run when the card is denied', async () => {
  const { tools, calls } = fakeTools();
  const { approve } = policyApprover('deny');
  const resp = await call('klaviyo', Object.assign({}, FLOW_SET), { tools, approve });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'APPROVAL_DENIED');
  assert.strictEqual(calls.length, 0);
});

// ── (b) spend ────────────────────────────────────────────────

test('(b) spend intent tool meta_launch_test_ad over IPC does not run without approval', async () => {
  for (const card of ['none', 'deny']) {
    const { tools, calls } = fakeTools();
    const { approve, seen } = policyApprover(card);
    const resp = await call('meta_launch_test_ad', { brand: 'vela', dailyBudget: 20, adImagePath: 'a.png' }, { tools, approve });
    assert.strictEqual(resp.ok, false, `card=${card}`);
    assert.strictEqual(calls.length, 0, `card=${card}: handler must not run`);
    assert.strictEqual(seen[0].action, 'push');
  }
});

test('(b) legacy meta_ads push over IPC does not run without approval', async () => {
  const { tools, calls } = fakeTools();
  const { approve } = policyApprover('none');
  const resp = await call('meta_ads', { action: 'push', brand: 'vela', dailyBudget: 20 }, { tools, approve });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(calls.length, 0);
});

// ── (c) caller-supplied approved flag ────────────────────────

test('(c) caller-passed approved:true does not bypass the gate', async () => {
  const { tools, calls } = fakeTools();
  const { approve, seen } = policyApprover('none');
  const resp = await call('klaviyo', Object.assign({ approved: true }, FLOW_SET), { tools, approve });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'APPROVAL_REQUIRED');
  assert.strictEqual(calls.length, 0);
  assert.ok(!('approved' in seen[0].input), 'the decision must never see a caller-supplied approved flag');
});

test('(c) caller-passed approved:true never reaches the handler on an auto-approved path', async () => {
  // Even when the decision auto-approves (no human), a caller-set flag must
  // not flow through to the engine's requireApproval() backstop.
  const { tools, calls } = fakeTools();
  const autoAllow = async (_n, input) => ({ behavior: 'allow', updatedInput: Object.assign({}, input, { approved: true }) });
  const resp = await call('klaviyo', Object.assign({ approved: true }, FLOW_SET), { tools, approve: autoAllow });
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.ok(!('approved' in calls[0].args), 'approved must only be set by a human Allow');
});

// ── (d) read-only ────────────────────────────────────────────

test('(d) read-only action runs over IPC with no card', async () => {
  const { tools, calls } = fakeTools();
  const { approve, seen } = policyApprover('none');
  const resp = await call('klaviyo', { action: 'flows-list', brand: 'vela' }, { tools, approve });
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(seen[0].carded, false);
  assert.ok(!('approved' in calls[0].args));
});

// ── (e) approve in card ──────────────────────────────────────

test('(e) human Allow runs the carded action and sets approved for the engine gate', async () => {
  const { tools, calls } = fakeTools();
  const { approve } = policyApprover('allow');
  const resp = await call('klaviyo', Object.assign({}, FLOW_SET), { tools, approve });
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].args.approved, true);
  assert.strictEqual(calls[0].args.action, 'flow-set-message-template');
});

test('(e) human Allow runs a spend tool; approved is not injected into a schema that lacks it', async () => {
  const { tools, calls } = fakeTools();
  const { approve } = policyApprover('allow');
  const resp = await call('meta_launch_test_ad', { brand: 'vela', dailyBudget: 20, adImagePath: 'a.png' }, { tools, approve });
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.ok(!('approved' in calls[0].args), 'defineTool strict schemas reject undeclared keys');
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

test('e2e: the incident call over the live socket is refused and the handler never runs', async () => {
  const d = tmpDir();
  const { tools, calls } = fakeTools();
  const { approve } = policyApprover('none');
  const ep = ipc.start({ stateDir: d, tools, ctx: { appRoot: d }, approve });
  try {
    await new Promise((resolve) => {
      if (ep.server.listening) return resolve();
      ep.server.once('listening', resolve);
    });
    const token = ep.token;
    const resp = await new Promise((resolve, reject) => {
      const sock = net.createConnection(ep.socketPath);
      let buf = '';
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('e2e timeout')); }, 3000);
      sock.setEncoding('utf8');
      sock.on('error', (e) => { clearTimeout(timer); reject(e); });
      sock.on('connect', () => {
        sock.write(JSON.stringify({
          id: 'e2e', auth: token, method: 'tools/call',
          params: { name: 'klaviyo', arguments: Object.assign({ approved: true }, FLOW_SET) },
        }) + '\n');
      });
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
    assert.strictEqual(resp.ok, false);
    assert.strictEqual(resp.error.code, 'APPROVAL_REQUIRED');
    assert.strictEqual(calls.length, 0);
  } finally {
    ep.stop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

// ── Source scans: the wiring cannot be silently dropped ──────

test('source: dispatchRequest strips approved, calls approve, and only then the handler', () => {
  const start = SRC_ENDPOINT.indexOf('async function dispatchRequest(');
  const end = SRC_ENDPOINT.indexOf('\nfunction readActiveBrand(', start);
  assert.ok(start > 0 && end > start, 'dispatchRequest body not found');
  const body = SRC_ENDPOINT.slice(start, end);
  assert.match(body, /REGRESSION GUARD \(2026-09-28/);
  const stripIdx = body.indexOf('stripCallerApproval(args)');
  const approveIdx = body.indexOf('await approve(MERLIN_TOOL_PREFIX + name');
  const handlerIdx = body.indexOf('tool.handler(');
  assert.ok(stripIdx > 0, 'caller approved flag must be stripped');
  assert.ok(approveIdx > stripIdx, 'approval decision must run on the stripped args');
  assert.ok(handlerIdx > approveIdx, 'handler must only be reached after the approval decision');
  assert.strictEqual(body.split('tool.handler(').length - 1, 1, 'exactly one handler call site, behind the gate');
  assert.match(body, /decision\.humanApproved === true/);
  assert.strictEqual(ipc.MERLIN_TOOL_PREFIX, 'mcp__merlin__');
});

test('source: main.js passes handleToolApproval as the IPC approve decision', () => {
  const idx = SRC_MAIN.indexOf('_mcpIpcEndpoint = startMcpIpc({');
  assert.ok(idx > 0, 'startMcpIpc call site not found');
  const site = SRC_MAIN.slice(idx, SRC_MAIN.indexOf('});', idx));
  assert.match(site, /approve:\s*\(toolName, input\)\s*=>\s*handleToolApproval\(toolName, input, \{ merlinApprovalSurface: 'ipc' \}\)/);
  assert.match(site, /REGRESSION GUARD \(2026-09-28/);
});

test('source: every card in the mcp__merlin__ branch goes through the IPC-aware helpers', () => {
  const start = SRC_MAIN.indexOf("if (toolName.startsWith('mcp__merlin__')) {");
  const end = SRC_MAIN.indexOf('All other MCP merlin tools: auto-approve', start);
  assert.ok(start > 0 && end > start, 'mcp__merlin__ branch not found');
  const branch = SRC_MAIN.slice(start, end);
  const emissions = branch.split("win.webContents.send('approval-request', payload)").length - 1;
  assert.ok(emissions >= 2, 'expected the spend and carded-destructive card sites');
  assert.strictEqual(branch.split('prepareIpcApprovalCard(payload, opts)').length - 1, emissions,
    'every card emission must first check whether an IPC caller can be shown a card');
  assert.strictEqual(branch.split('return awaitApprovalDecision(toolUseID, input, opts)').length - 1, emissions,
    'every card must resolve through awaitApprovalDecision (bounded deadline + humanApproved)');
  assert.doesNotMatch(branch, /return new Promise\(/, 'an inline card Promise would skip the IPC deadline');
  assert.match(SRC_MAIN, /async function handleToolApproval\(toolName, input, opts\)/);
});

test('source: awaitApprovalDecision bounds IPC waits and marks human approval', () => {
  const start = SRC_MAIN.indexOf('function awaitApprovalDecision(');
  assert.ok(start > 0);
  const body = SRC_MAIN.slice(start, SRC_MAIN.indexOf('\n}\n', start) > 0 ? SRC_MAIN.indexOf('\n}\n', start) : start + 3000);
  assert.match(body, /IPC_APPROVAL_DEADLINE_MS/);
  assert.match(body, /APPROVAL_TIMEOUT/);
  assert.match(body, /humanApproved: true/);
  assert.match(body, /pendingApprovals\.delete\(toolUseID\)/, 'the expired card must be withdrawn');
  const guardIdx = SRC_MAIN.indexOf('REGRESSION GUARD (2026-09-28, ipc-approval-bypass): tools/call requests');
  assert.ok(guardIdx > 0 && guardIdx < start, 'guard block must sit above the IPC helpers');
});
