// Tests for the jobs_poll / jobs_list / jobs_cancel MCP tools.
//
// These tools are the agent-facing wrappers around the JobStore primitive.
// The important contracts:
//   - jobs_poll: always returns envelope.ok with data.terminal flag when the
//     job exists; envelope.fail(JOB_NOT_FOUND) when it doesn't.
//   - jobs_list: returns a trimmed job listing (no full result payloads).
//   - jobs_cancel: returns cancelled=true only when a non-terminal job was
//     actually transitioned; returns cancelled=false with state=... for
//     already-terminal jobs; returns JOB_NOT_FOUND envelope when unknown.
//   - All three fail cleanly (INTERNAL_ERROR envelope) when ctx.jobStore is
//     missing — never crash.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildTools } = require('./mcp-tools');
const envelope = require('./mcp-envelope');
const { JobStore } = require('./mcp-jobs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-jobs-tools-'));
}

function makeFakeTool() {
  const registry = [];
  const tool = (name, description, schema, handler, options) => {
    registry.push({ name, description, schema, handler, options });
    return { name };
  };
  return { tool, registry };
}

function makeFakeZ() {
  const chain = () => ({
    optional: () => chain(), describe: () => chain(), default: () => chain(),
    regex: () => chain(), min: () => chain(), max: () => chain(),
  });
  return {
    string: () => chain(), number: () => chain(), boolean: () => chain(),
    any: () => chain(), enum: () => chain(), array: () => chain(),
    object: () => chain(),
  };
}

function makeCtx(overrides = {}) {
  return {
    getConnections: () => [],
    readConfig: () => ({}),
    readBrandConfig: () => ({}),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => null,
    appRoot: process.cwd(),
    isBinaryTooOld: () => false,
    runOAuthFlow: async () => ({ success: true }),
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
    ...overrides,
  };
}

function findTool(registry, name) {
  return registry.find((t) => t.name === name);
}

function waitForState(store, jobId, state, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const j = store.get(jobId);
      if (j && j.state === state) return resolve(j);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${state}`));
      setTimeout(check, 10);
    };
    check();
  });
}

// ── jobs tool REGISTRATION ────────────────────────────────────────────

test('jobs_poll / jobs_list / jobs_cancel are registered', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  assert.ok(findTool(registry, 'jobs_poll'));
  assert.ok(findTool(registry, 'jobs_list'));
  assert.ok(findTool(registry, 'jobs_cancel'));
});

test('jobs_cancel is annotated destructive + idempotent (preview-exempt)', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const cancel = findTool(registry, 'jobs_cancel');
  const ann = cancel.options && cancel.options.annotations;
  assert.ok(ann, 'jobs_cancel must surface annotations to the MCP layer');
  assert.equal(ann.destructive, true);
  assert.equal(ann.idempotent, true);
});

// ── Missing-jobStore fallback ─────────────────────────────────────────

test('jobs_poll returns a clean INTERNAL_ERROR envelope when jobStore is missing', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const out = await findTool(registry, 'jobs_poll').handler({ jobId: 'job-0123456789abcdef' });
  const env = envelope.parse(out);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INTERNAL_ERROR');
  assert.match(env.error.message, /Job store is not initialized/);
});

test('jobs_list returns INTERNAL_ERROR envelope when jobStore is missing', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const out = await findTool(registry, 'jobs_list').handler({});
  const env = envelope.parse(out);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INTERNAL_ERROR');
});

test('jobs_cancel returns INTERNAL_ERROR envelope when jobStore is missing', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const out = await findTool(registry, 'jobs_cancel').handler({ jobId: 'job-0123456789abcdef' });
  const env = envelope.parse(out);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INTERNAL_ERROR');
});

// ── jobs_poll ─────────────────────────────────────────────────────────

test('jobs_poll on unknown jobId returns JOB_NOT_FOUND envelope', async () => {
  const jobStore = new JobStore({ dir: tmpDir() });
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx({ jobStore }));
  const out = await findTool(registry, 'jobs_poll').handler({
    jobId: 'job-0000000000000000',
  });
  const env = envelope.parse(out);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'JOB_NOT_FOUND');
});

test('jobs_poll returns running then terminal state for a live job', async () => {
  const jobStore = new JobStore({ dir: tmpDir() });
  const { jobId } = jobStore.start({
    tool: 'test_tool',
    brand: 'acme',
    runFn: async ({ reportProgress }) => {
      reportProgress({ stage: 'step-1', pct: 0.5 });
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, data: { result: 'complete' } };
    },
  });
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx({ jobStore }));
  const pollTool = findTool(registry, 'jobs_poll');

  await waitForState(jobStore, jobId, 'done');
  const out = await pollTool.handler({ jobId });
  const env = envelope.parse(out);
  assert.equal(env.ok, true);
  assert.equal(env.data.jobId, jobId);
  assert.equal(env.data.state, 'done');
  assert.equal(env.data.terminal, true);
  assert.equal(env.data.tool, 'test_tool');
  assert.equal(env.data.brand, 'acme');
  assert.ok(env.data.result, 'terminal poll must include the final result envelope');
  assert.equal(env.data.result.data.result, 'complete');
});

test('jobs_poll on failed job returns data.error populated', async () => {
  const jobStore = new JobStore({ dir: tmpDir() });
  const { jobId } = jobStore.start({
    tool: 'failing_tool',
    runFn: async () => { throw new Error('upstream platform unhappy'); },
  });
  await waitForState(jobStore, jobId, 'failed');
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx({ jobStore }));
  const out = await findTool(registry, 'jobs_poll').handler({ jobId });
  const env = envelope.parse(out);
  assert.equal(env.ok, true, 'jobs_poll itself succeeded — the JOB failed');
  assert.equal(env.data.state, 'failed');
  assert.equal(env.data.terminal, true);
  assert.match(env.data.error.message, /upstream platform unhappy/);
});

// ── jobs_list ─────────────────────────────────────────────────────────

test('jobs_list returns all jobs when no filter is given', async () => {
  const jobStore = new JobStore({ dir: tmpDir() });
  jobStore.start({ tool: 'tool_a', brand: 'b1', runFn: async () => ({ ok: true }) });
  jobStore.start({ tool: 'tool_a', brand: 'b2', runFn: async () => ({ ok: true }) });
  jobStore.start({ tool: 'tool_b', brand: 'b1', runFn: async () => ({ ok: true }) });
  await new Promise((r) => setTimeout(r, 30));

  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx({ jobStore }));
  const out = await findTool(registry, 'jobs_list').handler({});
  const env = envelope.parse(out);
  assert.equal(env.ok, true);
  assert.equal(env.data.jobs.length, 3);
});

test('jobs_list filters by brand + tool + state', async () => {
  const jobStore = new JobStore({ dir: tmpDir() });
  jobStore.start({ tool: 'tool_a', brand: 'b1', runFn: async () => ({ ok: true }) });
  jobStore.start({ tool: 'tool_a', brand: 'b2', runFn: async () => ({ ok: true }) });
  jobStore.start({ tool: 'tool_b', brand: 'b1', runFn: async () => ({ ok: true }) });
  await new Promise((r) => setTimeout(r, 30));

  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx({ jobStore }));
  const listTool = findTool(registry, 'jobs_list');

  const b1 = envelope.parse(await listTool.handler({ brand: 'b1' })).data.jobs;
  assert.equal(b1.length, 2);
  const toolB = envelope.parse(await listTool.handler({ tool: 'tool_b' })).data.jobs;
  assert.equal(toolB.length, 1);
  assert.equal(toolB[0].tool, 'tool_b');
});

test('jobs_list omits the heavy `result` payload — only summary fields surface', async () => {
  // The agent polls with jobs_poll for the full result; jobs_list is a
  // lightweight inventory. Leaking full results makes listing 500 jobs O(MB).
  const jobStore = new JobStore({ dir: tmpDir() });
  const { jobId } = jobStore.start({
    tool: 'heavy_tool',
    runFn: async () => ({ ok: true, data: { giant: 'x'.repeat(50_000) } }),
  });
  await waitForState(jobStore, jobId, 'done');

  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx({ jobStore }));
  const out = await findTool(registry, 'jobs_list').handler({});
  const env = envelope.parse(out);
  const entry = env.data.jobs.find((j) => j.jobId === jobId);
  assert.ok(entry);
  assert.equal(entry.result, undefined, 'jobs_list must NOT include the result field');
});

test('jobs_list respects limit', async () => {
  const jobStore = new JobStore({ dir: tmpDir() });
  for (let i = 0; i < 5; i++) {
    jobStore.start({ tool: `t${i}`, runFn: async () => ({ ok: true }) });
    await new Promise((r) => setTimeout(r, 2));
  }
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx({ jobStore }));
  const out = await findTool(registry, 'jobs_list').handler({ limit: 2 });
  const env = envelope.parse(out);
  assert.equal(env.data.jobs.length, 2);
});

// ── jobs_cancel ───────────────────────────────────────────────────────

test('jobs_cancel on unknown jobId returns JOB_NOT_FOUND envelope', async () => {
  const jobStore = new JobStore({ dir: tmpDir() });
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx({ jobStore }));
  const out = await findTool(registry, 'jobs_cancel').handler({
    jobId: 'job-0000000000000000',
  });
  const env = envelope.parse(out);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'JOB_NOT_FOUND');
});

test('jobs_cancel transitions a running job to cancelled', async () => {
  const jobStore = new JobStore({ dir: tmpDir() });
  const { jobId } = jobStore.start({
    tool: 'cancellable_tool',
    runFn: async ({ checkCancelled }) => {
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 5));
        checkCancelled();
      }
      return { ok: true };
    },
  });
  await new Promise((r) => setTimeout(r, 15));

  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx({ jobStore }));
  const out = await findTool(registry, 'jobs_cancel').handler({ jobId });
  const env = envelope.parse(out);
  assert.equal(env.ok, true);
  assert.equal(env.data.cancelled, true);
  assert.equal(env.data.jobId, jobId);

  // Eventually transitions.
  await waitForState(jobStore, jobId, 'cancelled');
});

test('jobs_cancel on a terminal job reports already_terminal, no-op', async () => {
  const jobStore = new JobStore({ dir: tmpDir() });
  const { jobId } = jobStore.start({
    tool: 'quick_tool',
    runFn: async () => ({ ok: true }),
  });
  await waitForState(jobStore, jobId, 'done');

  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx({ jobStore }));
  const out = await findTool(registry, 'jobs_cancel').handler({ jobId });
  const env = envelope.parse(out);
  assert.equal(env.ok, true);
  assert.equal(env.data.cancelled, false);
  assert.equal(env.data.reason, 'already_terminal');
  // Original state preserved.
  assert.equal(jobStore.get(jobId).state, 'done');
});
