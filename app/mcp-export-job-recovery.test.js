'use strict';

// REGRESSION GUARD (2026-09-28): job-482d692d682a480e. A raw Gorgias export
// sat "running" at 0% forever after a Merlin relaunch killed its engine child:
// the job file said running, but its runFn and resume loop died with the old
// process, and nothing in the job ever moved updatedAt. These tests pin the
// three fixes: orphan recovery, engine heartbeats with a stall watchdog, and
// never persisting an approval for a restart re-run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { JobStore, ORPHAN_ERROR_CODE } = require('./mcp-jobs');
const {
  startExportJob,
  recoverExportJobs,
  watchExportChild,
  parseExportProgressLine,
  RESTART_RESUMABLE_EXPORT_ACTIONS,
} = require('./mcp-tools');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-export-recovery-'));
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await tick(10);
  }
  throw new Error('timeout');
}

// Simulates the pre-restart process: a job that is running when the process dies.
function orphanJob(dir, extra = {}) {
  const old = new JobStore({ dir, pruneIntervalMs: 0 });
  const { jobId } = old.start({ tool: 'gorgias', brand: 'apotheke', runFn: () => new Promise(() => {}), ...extra });
  return { old, jobId };
}

test('an orphaned job is resumed under the same jobId when a resume runFn exists', async () => {
  const dir = tmpDir();
  const { jobId } = orphanJob(dir);
  await tick(20);
  const fresh = new JobStore({ dir, pruneIntervalMs: 0 });
  const r = fresh.recoverOrphans(() => async ({ reportProgress }) => {
    reportProgress({ stage: 'resumed', heartbeat: true });
    return { ok: true, data: { resumed: true } };
  });
  assert.deepEqual(r.resumed, [jobId]);
  const job = await waitFor(() => { const j = fresh.get(jobId); return j && j.state === 'done' ? j : null; });
  assert.equal(job.owner, fresh.instanceId);
  assert.ok(job.heartbeatAt, 'heartbeat recorded');
});

test('an orphan with no resume path is finalized as INTERRUPTED, never left running', async () => {
  const dir = tmpDir();
  const { jobId } = orphanJob(dir);
  await tick(20);
  const fresh = new JobStore({ dir, pruneIntervalMs: 0 });
  const r = fresh.recoverOrphans(() => null);
  assert.deepEqual(r.interrupted, [jobId]);
  const job = fresh.get(jobId);
  assert.equal(job.state, 'failed');
  assert.equal(job.error.code, ORPHAN_ERROR_CODE);
  assert.match(job.error.message, /run the same request again/);
});

test('recovery never touches jobs owned by the live process', async () => {
  const dir = tmpDir();
  const store = new JobStore({ dir, pruneIntervalMs: 0 });
  const { jobId } = store.start({ tool: 'gorgias', runFn: () => new Promise(() => {}) });
  await tick(20);
  const r = store.recoverOrphans(() => null);
  assert.equal(r.interrupted.length + r.resumed.length + r.cancelled.length, 0);
  assert.equal(store.get(jobId).state, 'running');
});

test('cancel on an orphan finalizes it as cancelled', async () => {
  const dir = tmpDir();
  const { jobId } = orphanJob(dir);
  await tick(20);
  const fresh = new JobStore({ dir, pruneIntervalMs: 0 });
  const res = fresh.cancel(jobId);
  assert.equal(res.cancelled, true);
  assert.equal(fresh.get(jobId).state, 'cancelled');
});

test('raw exports persist no resume args and no approval; de-identified exports persist args minus approval', () => {
  const started = [];
  const ctx = { jobStore: { start: (opts) => { started.push(opts); return { jobId: 'job-x' }; } } };
  startExportJob(ctx, 'gorgias', 'gorgias-export-raw', { brand: 'apotheke', raw: true, approved: true });
  startExportJob(ctx, 'gorgias', 'gorgias-export', { brand: 'apotheke', approved: true, confirm_token: 't' });
  assert.equal(started[0].meta.resume, undefined);
  assert.equal(JSON.stringify(started[0].meta).includes('approved'), false);
  assert.deepEqual(started[1].meta.resume, { tool: 'gorgias', action: 'gorgias-export', args: { brand: 'apotheke' } });
  assert.equal(RESTART_RESUMABLE_EXPORT_ACTIONS.has('gorgias-export-raw'), false);
});

test('recoverExportJobs re-runs a persisted de-identified export but interrupts a raw one', async () => {
  const dir = tmpDir();
  const deid = orphanJob(dir, { meta: { action: 'gorgias-export', resume: { tool: 'gorgias', action: 'gorgias-export', args: { brand: 'apotheke' } } } });
  const raw = orphanJob(dir, { meta: { action: 'gorgias-export-raw' } });
  // A tampered job file claiming a raw resume must still be refused.
  const forged = orphanJob(dir, { meta: { action: 'gorgias-export-raw', resume: { tool: 'gorgias', action: 'gorgias-export-raw', args: { approved: true } } } });
  await tick(20);
  const fresh = new JobStore({ dir, pruneIntervalMs: 0 });
  // Swap the runner so the resumed de-identified job never spawns a real engine.
  const r = fresh.recoverOrphans.call(fresh, (job) => {
    const res = job.meta && job.meta.resume;
    return res && RESTART_RESUMABLE_EXPORT_ACTIONS.has(res.action) ? async () => ({ ok: true, data: {} }) : null;
  });
  assert.deepEqual(r.resumed, [deid.jobId]);
  assert.deepEqual(r.interrupted.sort(), [raw.jobId, forged.jobId].sort());

  // The real helper applies the same allowlist and runs once per store.
  const dir2 = tmpDir();
  const forged2 = orphanJob(dir2, { meta: { action: 'gorgias-export-raw', resume: { tool: 'gorgias', action: 'gorgias-export-raw', args: { approved: true } } } });
  await tick(20);
  const fresh2 = new JobStore({ dir: dir2, pruneIntervalMs: 0 });
  const r2 = recoverExportJobs({ jobStore: fresh2 });
  assert.deepEqual(r2.interrupted, [forged2.jobId]);
  assert.equal(recoverExportJobs({ jobStore: fresh2 }), null, 'runs once per store');
});

test('parseExportProgressLine accepts counts and rejects anything else', () => {
  assert.deepEqual(parseExportProgressLine('MERLIN_PROGRESS stage=tickets pages=5 scanned=500 tickets=302'),
    { stage: 'tickets', counts: { pages: 5, scanned: 500, tickets: 302 } });
  assert.equal(parseExportProgressLine('{"status":"complete"}'), null);
  assert.equal(parseExportProgressLine('MERLIN_PROGRESS pages=5'), null);
  const p = parseExportProgressLine('MERLIN_PROGRESS stage=tickets email=a@b.co Name=x tickets=3');
  assert.deepEqual(p.counts, { tickets: 3 });
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = [];
  child.kill = (sig) => { child.killed.push(sig); };
  return child;
}

test('watchExportChild turns engine heartbeats into job heartbeats', () => {
  const child = fakeChild();
  const seen = [];
  watchExportChild(child, (p) => seen.push(p), () => {}, 60000);
  child.stdout.emit('data', Buffer.from('noise\nMERLIN_PROGRESS stage=tickets pages=1 tick'));
  child.stdout.emit('data', Buffer.from('ets=2\n'));
  child.emit('exit', 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].heartbeat, true);
  assert.match(seen[0].stage, /tickets \(pages 1, tickets 2\)/);
});

test('watchExportChild kills an engine that stops heartbeating and flags the stall', async () => {
  const child = fakeChild();
  let stalled = false;
  watchExportChild(child, () => {}, () => { stalled = true; }, 30);
  child.stdout.emit('data', Buffer.from('MERLIN_PROGRESS stage=tickets pages=1\n'));
  await tick(80);
  assert.equal(stalled, true);
  assert.deepEqual(child.killed, ['SIGTERM']);
});

test('watchExportChild does not kill an engine that keeps heartbeating', async () => {
  const child = fakeChild();
  let stalled = false;
  watchExportChild(child, () => {}, () => { stalled = true; }, 60);
  for (let i = 0; i < 5; i++) {
    child.stdout.emit('data', Buffer.from(`MERLIN_PROGRESS stage=tickets pages=${i}\n`));
    await tick(25);
  }
  child.emit('exit', 0);
  await tick(80);
  assert.equal(stalled, false);
  assert.deepEqual(child.killed, []);
});
