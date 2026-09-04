// REGRESSION GUARD (2026-09-04, engine-timeout-past-the-mcp-boundary +
// jobs-overflow-path-must-stay-wired):
//
// runBinary's default engine timeout was 300000ms (5 min) while the MCP
// tool-call boundary the agent host enforces is 120s. Any engine action that
// took between 2 and 5 minutes was killed by the boundary rather than by us,
// so the agent got an opaque transport timeout with no envelope, no error
// code and no next_action, while the engine kept running against the platform
// in a process nobody was reading. The default now sits at 110s: WE time out
// first and the caller gets an actionable envelope.
//
// The companion half is that work which genuinely cannot finish inside that
// bound has somewhere to go. That is app/mcp-jobs.js plus the jobs_poll /
// jobs_list / jobs_cancel tools. This file pins both: the boundary itself,
// and the wiring that keeps the overflow path alive (a future "remove the
// unused job store" cleanup would silently re-create the original problem,
// because the timeout can then only be fixed by raising it again).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildTools } = require('./mcp-tools.js');
const envelope = require('./mcp-envelope.js');
const { JobStore } = require('./mcp-jobs.js');

const MCP_CALL_BOUNDARY_MS = 120000;

function readSrc(f) {
  return fs.readFileSync(path.join(__dirname, f), 'utf8');
}

// ── the timeout bound ──────────────────────────────────────────────────

test('runBinary default engine timeout lands strictly inside the MCP call boundary', () => {
  const src = readSrc('mcp-tools.js');
  const m = src.match(/const timeout = opts\.timeout \|\| \(MCP_CALL_BOUNDARY_MS - (\d+)\);/);
  assert.ok(m, 'runBinary must derive its default from MCP_CALL_BOUNDARY_MS, not a bare literal');
  const boundary = src.match(/const MCP_CALL_BOUNDARY_MS = (\d+);/);
  assert.ok(boundary, 'MCP_CALL_BOUNDARY_MS must be declared next to the default');
  assert.equal(Number(boundary[1]), MCP_CALL_BOUNDARY_MS);

  const effective = Number(boundary[1]) - Number(m[1]);
  assert.equal(effective, 110000, 'the documented default is 110000ms');
  assert.ok(effective < MCP_CALL_BOUNDARY_MS, 'the engine must time out BEFORE the transport does');
  assert.ok(
    MCP_CALL_BOUNDARY_MS - effective >= 5000,
    'leave at least 5s of margin for redactOutput over a 32MB buffer plus the envelope round-trip',
  );
});

test('the 300000ms default is gone from runBinary', () => {
  const src = readSrc('mcp-tools.js');
  const start = src.indexOf('const configPathHint = path.join(ctx.appRoot');
  const window = src.slice(start, start + 2000).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(
    !/opts\.timeout \|\| 300000/.test(window),
    'reverting to a 5-minute default re-opens the opaque-boundary-timeout hole',
  );
});

test('the comment documents the job/overflow path as the answer for >110s work', () => {
  const src = readSrc('mcp-tools.js');
  const i = src.indexOf('MCP_CALL_BOUNDARY_MS');
  const comment = src.slice(Math.max(0, i - 1600), i);
  assert.match(comment, /mcp-jobs/, 'the constant must point readers at the overflow path');
  assert.match(comment, /jobs_poll/);
});

// ── the overflow path must stay wired ──────────────────────────────────

test('mcp-server.js still constructs ctx.jobStore on every server build', () => {
  const src = readSrc('mcp-server.js');
  assert.match(src, /new JobStore\(\{\s*dir:/, 'the shared JobStore must be constructed in server init');
  assert.match(src, /if \(!ctx\.jobStore\)/, 'callers must still be able to pre-populate ctx.jobStore');
});

test('main.js still shuts the JobStore prune timer down on quit', () => {
  const src = readSrc('main.js');
  assert.match(src, /jobStore\.shutdown\(\)/, 'a leaked prune timer keeps the event loop alive at exit');
});

test('jobs_list returns the real jobs from a STARTED store (end-to-end, no mocks)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-jobs-overflow-'));
  const jobStore = new JobStore({ dir });
  try {
    const { jobId } = jobStore.start({
      tool: 'meta_bulk_push',
      brand: 'apotheke',
      runFn: async (reportProgress) => {
        reportProgress({ stage: 'uploading', pct: 0.5 });
        return { ok: true };
      },
    });
    assert.match(jobId, /^job-[0-9a-f]{16}$/);

    const registry = [];
    const tool = (name, description, schema, handler, options) => {
      registry.push({ name, handler, options });
      return { name };
    };
    const chain = () => ({
      optional: () => chain(), describe: () => chain(), default: () => chain(),
      regex: () => chain(), int: () => chain(),
    });
    const z = {
      string: () => chain(), number: () => chain(), boolean: () => chain(),
      any: () => chain(), enum: () => chain(), array: () => chain(),
      object: () => chain(), record: () => chain(), coerce: { number: () => chain() },
    };
    buildTools(tool, z, {
      getConnections: () => [], readConfig: () => ({}), readBrandConfig: () => ({}),
      writeConfig: () => {}, writeBrandTokens: () => {}, getBinaryPath: () => null,
      appRoot: process.cwd(), isBinaryTooOld: () => false,
      runOAuthFlow: async () => ({ success: true }), awaitStartupChecks: async () => {},
      activeChildProcesses: new Set(), jobStore,
    });

    const listTool = registry.find((t) => t.name === 'jobs_list');
    assert.ok(listTool, 'jobs_list must be registered');
    const env = envelope.parse(await listTool.handler({}));
    assert.equal(env.ok, true);
    const found = env.data.jobs.find((j) => j.jobId === jobId);
    assert.ok(found, 'a job started through JobStore.start() must surface in jobs_list');
    assert.equal(found.tool, 'meta_bulk_push');
    assert.equal(found.brand, 'apotheke');
  } finally {
    jobStore.shutdown();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
