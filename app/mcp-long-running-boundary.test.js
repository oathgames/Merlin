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

// ── the generation exemption, and nothing else ─────────────────────────
//
// REGRESSION GUARD (2026-09-04, boundary-test-only-checked-the-default):
// the tests above pin the DEFAULT and say nothing about call sites, so the
// same hole could be re-opened one `{ timeout: 300000 }` at a time. Two
// things go wrong in opposite directions and both need pinning:
//
//   1. An override ABOVE the boundary re-creates the original bug (the host
//      kills the call first, the caller gets no envelope). meta-import
//      shipped with exactly 120000, i.e. sitting ON the boundary.
//   2. Removing the DELIBERATE exemptions silently kills real generation
//      runs at 110s. content(image/batch) and video had no explicit timeout
//      and inherited the old 300000 default; dropping the default without
//      pinning them would have started cutting off paid renders mid-flight.
//
// So: exactly two call sites may exceed the boundary-safe default, they must
// be the two generation handlers, and they must go through the named constant
// (which carries the "delete me once a job producer exists" note).

const BOUNDARY_SAFE_MS = 110000;

// The only handlers allowed a timeout at or above BOUNDARY_SAFE_MS, keyed by
// the nearest preceding `name: '<tool>'` in the source.
const LONG_TIMEOUT_ALLOWLIST = new Set(['content', 'video']);

function toolNameAt(src, index) {
  const before = src.slice(0, index);
  const i = before.lastIndexOf("name: '");
  if (i < 0) return '(module scope)';
  return before.slice(i + 7, before.indexOf("'", i + 7));
}

test('no mcp-*.js call site sets a timeout above the boundary-safe default, except the generation allowlist', () => {
  const files = fs.readdirSync(__dirname)
    .filter((f) => /^mcp-.*\.js$/.test(f) && !f.endsWith('.test.js'));
  assert.ok(files.length >= 3, 'the scan must actually find the mcp modules');

  const offenders = [];
  for (const file of files) {
    const src = readSrc(file);
    // Resolve `timeout: NAME` through a same-file `const NAME = <number>;`.
    const consts = new Map();
    for (const m of src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*(\d+);/g)) {
      consts.set(m[1], Number(m[2]));
    }
    for (const m of src.matchAll(/timeout:\s*([A-Za-z_$][\w$]*|\d+)/g)) {
      const raw = m[1];
      const value = /^\d+$/.test(raw) ? Number(raw) : consts.get(raw);
      if (value === undefined) {
        // A timeout wired to something this scan cannot resolve (a variable,
        // an import). Fail loudly rather than quietly waving it through.
        offenders.push(`${file}: timeout: ${raw} , unresolvable, the scan cannot prove it is inside the boundary`);
        continue;
      }
      // 110000 IS the boundary-safe default, so an explicit override at that
      // value is fine (meta-import restates it deliberately). Anything ABOVE
      // it is the hole.
      if (value <= BOUNDARY_SAFE_MS) continue;
      const owner = toolNameAt(src, m.index);
      if (!LONG_TIMEOUT_ALLOWLIST.has(owner)) {
        offenders.push(`${file}: ${owner} sets timeout ${value} , above ${BOUNDARY_SAFE_MS}ms the host boundary (120000ms) fires first and the caller gets no envelope`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('the two generation handlers keep an explicit long timeout via the named constant', () => {
  const src = readSrc('mcp-tools.js');
  const decl = src.match(/const GENERATION_TIMEOUT_MS = (\d+);/);
  assert.ok(decl, 'GENERATION_TIMEOUT_MS must exist , the exemption has to be named, not a bare literal');
  assert.equal(Number(decl[1]), 300000, 'the exemption restores the prior 300000ms budget, not a new number');

  const uses = [...src.matchAll(/timeout:\s*GENERATION_TIMEOUT_MS/g)].map((m) => toolNameAt(src, m.index));
  assert.deepEqual(uses.sort(), ['content', 'video'],
    'exactly the content and video handlers may use the generation exemption');
});

test('the exemption documents why it exists and what retires it', () => {
  const src = readSrc('mcp-tools.js');
  const i = src.indexOf('const GENERATION_TIMEOUT_MS');
  const comment = src.slice(Math.max(0, i - 2200), i);
  assert.match(comment, /jobs_poll|mcp-jobs/,
    'the exemption must point at the job/overflow path as the real fix');
  assert.match(comment, /EXEMPTION|exemption/,
    'it must read as an exemption, not as a second default');
});

test('meta_import_account_state no longer overrides the timeout onto the boundary itself', () => {
  const src = readSrc('mcp-meta-intent.js');
  assert.ok(!/timeout:\s*120000/.test(src),
    'a 120000ms override IS the boundary , the host times out first and the caller gets an opaque transport error');
  assert.match(src, /'meta-import'[^\n]*timeout:\s*110000/,
    'meta-import must sit strictly inside the boundary like the default does');
});
