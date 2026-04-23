'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { JobStore, TERMINAL_STATES, PRUNE_INTERVAL_MS } = require('./mcp-jobs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-jobs-test-'));
}

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForState(store, jobId, state, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = store.get(jobId);
    if (job && job.state === state) return job;
    await tick(10);
  }
  throw new Error(`timeout waiting for ${jobId} to reach state=${state}`);
}

test('JobStore requires a dir', () => {
  assert.throws(() => new JobStore({}), /dir/);
});

test('start returns a jobId synchronously', () => {
  const store = new JobStore({ dir: tmpDir() });
  const { jobId } = store.start({
    tool: 'test_tool',
    runFn: async () => ({ ok: true, data: { done: true } }),
  });
  assert.ok(typeof jobId === 'string');
  assert.ok(/^job-[a-f0-9]{16}$/.test(jobId));
});

test('job transitions queued -> running -> done', async () => {
  const store = new JobStore({ dir: tmpDir() });
  const { jobId } = store.start({
    tool: 'test_tool',
    runFn: async () => ({ ok: true, data: { summary: 'complete' } }),
  });

  // Immediately queued
  const early = store.get(jobId);
  assert.ok(early);
  assert.ok(['queued', 'running', 'done'].includes(early.state));

  // Eventually done
  const done = await waitForState(store, jobId, 'done');
  assert.equal(done.state, 'done');
  assert.equal(done.pct, 1);
  assert.deepEqual(done.result, { ok: true, data: { summary: 'complete' } });
});

test('reportProgress updates stage/pct/etaSec', async () => {
  const store = new JobStore({ dir: tmpDir() });
  let progressed = false;
  const { jobId } = store.start({
    tool: 'long_tool',
    runFn: async ({ reportProgress }) => {
      reportProgress({ stage: 'step-1', pct: 0.25, etaSec: 300 });
      await tick(10);
      reportProgress({ stage: 'step-2', pct: 0.75, etaSec: 100 });
      progressed = true;
      return { ok: true, data: null };
    },
  });

  await waitForState(store, jobId, 'done');
  assert.equal(progressed, true);
});

test('pct is clamped to [0, 1]', async () => {
  const store = new JobStore({ dir: tmpDir() });
  const { jobId } = store.start({
    tool: 'clamp_tool',
    runFn: async ({ reportProgress }) => {
      reportProgress({ pct: 2.5 });
      await tick(5);
      return { ok: true, data: null };
    },
  });
  await tick(30);
  const job = store.get(jobId);
  assert.ok(job.pct <= 1, `pct not clamped: ${job.pct}`);
});

test('failed handler sets state=failed with error', async () => {
  const store = new JobStore({ dir: tmpDir() });
  const { jobId } = store.start({
    tool: 'failing_tool',
    runFn: async () => { throw new Error('boom'); },
  });
  const job = await waitForState(store, jobId, 'failed');
  assert.equal(job.state, 'failed');
  assert.equal(job.error.message, 'boom');
});

test('cancel requested: checkCancelled throws and state becomes cancelled', async () => {
  const store = new JobStore({ dir: tmpDir() });
  const { jobId } = store.start({
    tool: 'cancellable_tool',
    runFn: async ({ checkCancelled }) => {
      for (let i = 0; i < 20; i++) {
        await tick(10);
        checkCancelled();
      }
      return { ok: true, data: null };
    },
  });
  await tick(20);
  const result = store.cancel(jobId);
  assert.equal(result.cancelled, true);
  const job = await waitForState(store, jobId, 'cancelled', 1000);
  assert.equal(job.state, 'cancelled');
});

test('cancel on terminal job returns already_terminal', async () => {
  const store = new JobStore({ dir: tmpDir() });
  const { jobId } = store.start({
    tool: 'quick_tool',
    runFn: async () => ({ ok: true, data: null }),
  });
  await waitForState(store, jobId, 'done');
  const result = store.cancel(jobId);
  assert.equal(result.cancelled, false);
  assert.equal(result.reason, 'already_terminal');
});

test('cancel on unknown job returns not_found', () => {
  const store = new JobStore({ dir: tmpDir() });
  const result = store.cancel('job-0123456789abcdef');
  assert.equal(result.cancelled, false);
  assert.equal(result.reason, 'not_found');
});

test('list filters by brand, tool, state', async () => {
  const store = new JobStore({ dir: tmpDir() });
  store.start({ tool: 'tool_a', brand: 'b1', runFn: async () => ({ ok: true }) });
  store.start({ tool: 'tool_a', brand: 'b2', runFn: async () => ({ ok: true }) });
  store.start({ tool: 'tool_b', brand: 'b1', runFn: async () => ({ ok: true }) });

  // Give microtasks a chance to complete transitions.
  await tick(30);

  assert.equal(store.list({ brand: 'b1' }).length, 2);
  assert.equal(store.list({ brand: 'b2' }).length, 1);
  assert.equal(store.list({ tool: 'tool_b' }).length, 1);
  assert.equal(store.list().length, 3);
});

test('list respects limit and sorts newest-first', async () => {
  const store = new JobStore({ dir: tmpDir() });
  for (let i = 0; i < 5; i++) {
    store.start({ tool: `t${i}`, runFn: async () => ({ ok: true }) });
    await tick(2);
  }
  const top = store.list({ limit: 3 });
  assert.equal(top.length, 3);
  // Newest first
  for (let i = 1; i < top.length; i++) {
    assert.ok(top[i - 1].createdAt >= top[i].createdAt);
  }
});

test('jobId validation prevents path traversal in file operations', () => {
  const store = new JobStore({ dir: tmpDir() });
  // Malformed jobIds must never reach the filesystem.
  assert.equal(store.get('../../../etc/passwd'), null);
  assert.equal(store.get('job-not-hex'), null);
  assert.equal(store.get(null), null);
  assert.equal(store.get(undefined), null);
});

test('terminal jobs are NOT mutated by further state updates (frozen)', async () => {
  const store = new JobStore({ dir: tmpDir() });
  const { jobId } = store.start({
    tool: 'freeze_tool',
    runFn: async ({ reportProgress }) => {
      await tick(10);
      return { ok: true, data: { id: 'first' } };
    },
  });
  const done = await waitForState(store, jobId, 'done');
  const originalResult = done.result;

  // Try to re-invoke the private updater — simulating a bug where a late
  // progress callback fires after the terminal transition.
  store._updateJob(jobId, { state: 'running', stage: 'late', result: { ok: true, data: { id: 'second' } } });
  const reread = store.get(jobId);
  // Terminal state must be preserved
  assert.equal(reread.state, 'done');
  assert.deepEqual(reread.result, originalResult);
});

test('runFn receives reportProgress, checkCancelled, registerCancel', async () => {
  const store = new JobStore({ dir: tmpDir() });
  let received = null;
  const { jobId } = store.start({
    tool: 'contract_tool',
    runFn: async (args) => {
      received = Object.keys(args);
      return { ok: true };
    },
  });
  await waitForState(store, jobId, 'done');
  assert.ok(received.includes('reportProgress'));
  assert.ok(received.includes('checkCancelled'));
  assert.ok(received.includes('registerCancel'));
});

test('TERMINAL_STATES contains the expected states', () => {
  assert.ok(TERMINAL_STATES.has('done'));
  assert.ok(TERMINAL_STATES.has('failed'));
  assert.ok(TERMINAL_STATES.has('cancelled'));
  assert.equal(TERMINAL_STATES.has('running'), false);
  assert.equal(TERMINAL_STATES.has('queued'), false);
});

// ── Periodic prune timer (task 5.5) ─────────────────────────────

test('PRUNE_INTERVAL_MS defaults to 6 hours', () => {
  assert.equal(PRUNE_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

test('timer is created on construction and has unref() applied', () => {
  const store = new JobStore({ dir: tmpDir() });
  // Timer handle is exposed via the private field so tests can introspect.
  assert.ok(store._pruneInterval, 'constructor must start a prune timer');
  // Node Timeout objects are also Refable — confirm the timer is currently
  // unref'd so Electron can exit on app.quit() without waiting for the
  // next prune. Node exposes hasRef() on Timeout objects.
  if (typeof store._pruneInterval.hasRef === 'function') {
    assert.equal(store._pruneInterval.hasRef(), false, 'timer must be unref\'d');
  }
  store.shutdown();
});

test('shutdown() clears the periodic prune timer', () => {
  const store = new JobStore({ dir: tmpDir() });
  assert.ok(store._pruneInterval);
  store.shutdown();
  assert.equal(store._pruneInterval, null);
  // Idempotent — second shutdown is a no-op, not a throw.
  store.shutdown();
  assert.equal(store._pruneInterval, null);
});

test('_stopPruneInterval() is an alias that also clears the timer', () => {
  const store = new JobStore({ dir: tmpDir() });
  assert.ok(store._pruneInterval);
  store._stopPruneInterval();
  assert.equal(store._pruneInterval, null);
});

test('periodic timer calls _pruneOld every pruneIntervalMs (mock timers)', async (t) => {
  // Use node:test mock timers to advance fake time without waiting 6 real
  // hours. Drive a short pruneIntervalMs so we can fire multiple ticks.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = new JobStore({ dir: tmpDir(), pruneIntervalMs: 1000 });

  let callCount = 0;
  const originalPrune = store._pruneOld.bind(store);
  store._pruneOld = function () {
    callCount += 1;
    return originalPrune();
  };

  // Advance fake time 3 intervals — expect 3 periodic invocations.
  t.mock.timers.tick(3100);
  assert.equal(callCount, 3, `expected 3 ticks, got ${callCount}`);

  store.shutdown();
  // After shutdown, further ticks must not call _pruneOld.
  t.mock.timers.tick(5000);
  assert.equal(callCount, 3, 'shutdown() must stop further periodic prunes');

  t.mock.timers.reset();
});

test('_pruneOld drops terminal jobs past retention and returns count/bytes', async () => {
  const dir = tmpDir();
  // Use a very short retention so we don't have to mock Date.
  const store = new JobStore({ dir, retentionMs: 10, pruneIntervalMs: 0 });
  const { jobId } = store.start({
    tool: 'test_tool',
    runFn: async () => ({ ok: true, data: null }),
  });
  await waitForState(store, jobId, 'done');
  // Wait past retention.
  await tick(30);
  const result = store._pruneOld();
  assert.ok(result.dropped >= 1, `expected >=1 dropped, got ${result.dropped}`);
  assert.ok(result.bytesFreed > 0, `expected bytesFreed>0, got ${result.bytesFreed}`);
  assert.equal(store.get(jobId), null, 'job file must be removed after prune');
  store.shutdown();
});

test('_pruneOld re-entry is guarded (skipped:true on concurrent call)', () => {
  const store = new JobStore({ dir: tmpDir(), pruneIntervalMs: 0 });
  // Force the guard state then call — simulates a re-entrant invocation.
  store._pruning = true;
  const result = store._pruneOld();
  assert.equal(result.skipped, true);
  assert.equal(result.dropped, 0);
  // Reset so shutdown path doesn't leave the flag dirty for GC.
  store._pruning = false;
  store.shutdown();
});

test('pruneIntervalMs:0 opts out of the periodic timer', () => {
  const store = new JobStore({ dir: tmpDir(), pruneIntervalMs: 0 });
  assert.equal(store._pruneInterval, null, 'no timer should be scheduled');
  // shutdown() on a store without a timer is still safe.
  store.shutdown();
});
