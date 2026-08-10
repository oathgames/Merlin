// scheduled-tasks-daemon.test.js
//
// Unit tests for the daemon-sync module that pin every behaviour the
// 2026-04-27 Spellbook RSI audit fixed. Every test creates an isolated
// temp directory, points MERLIN_SCHEDULED_TASKS_ROOT at it, and exercises
// the public API end-to-end. No Electron, no Claude SDK, no LLM calls.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Per-test isolation: each test makes a fresh temp dir and restores the
// env var when done so cross-test contamination is impossible.
function makeFakeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-stasks-'));
  const outer = path.join(root, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
  const inner = path.join(outer, 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb');
  fs.mkdirSync(inner, { recursive: true });
  return { root, sessionDir: inner, stateFile: path.join(inner, 'scheduled-tasks.json') };
}

async function withEnv(envValue, fn) {
  const previous = process.env.MERLIN_SCHEDULED_TASKS_ROOT;
  process.env.MERLIN_SCHEDULED_TASKS_ROOT = envValue;
  // Force a fresh require so module-level paths re-read the env var.
  delete require.cache[require.resolve('./scheduled-tasks-daemon')];
  try { return await fn(require('./scheduled-tasks-daemon')); }
  finally {
    if (previous === undefined) delete process.env.MERLIN_SCHEDULED_TASKS_ROOT;
    else process.env.MERLIN_SCHEDULED_TASKS_ROOT = previous;
    delete require.cache[require.resolve('./scheduled-tasks-daemon')];
  }
}

// ─── Path discovery ──────────────────────────────────────────────────────

test('daemonAvailability returns no-install when no Claude Code Desktop dir exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-stasks-empty-'));
  withEnv(root, (mod) => {
    const r = mod.daemonAvailability();
    assert.equal(r.available, false);
    assert.equal(r.reason, 'no-install');
  });
});

test('daemonAvailability finds a state file when one exists', () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, JSON.stringify({ scheduledTasks: [] }));
  withEnv(root, (mod) => {
    const r = mod.daemonAvailability();
    assert.equal(r.available, true);
    assert.equal(r.path, stateFile);
  });
});

test('daemonAvailability surfaces malformed when JSON is broken', () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, '{ not: valid json');
  withEnv(root, (mod) => {
    const r = mod.daemonAvailability();
    assert.equal(r.available, false);
    assert.equal(r.reason, 'malformed');
  });
});

test('findStateFile picks the most recently modified install when multiple exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-stasks-multi-'));
  const oldDir = path.join(root, 'aaaa', 'bbbb');
  const newDir = path.join(root, 'cccc', 'dddd');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  const oldFile = path.join(oldDir, 'scheduled-tasks.json');
  const newFile = path.join(newDir, 'scheduled-tasks.json');
  fs.writeFileSync(oldFile, JSON.stringify({ scheduledTasks: [] }));
  fs.writeFileSync(newFile, JSON.stringify({ scheduledTasks: [] }));
  // Force the OLDER mtime to be older than the NEWER one. Some filesystems
  // (NTFS in particular) only have ms-level resolution, so back-date the
  // older file by a clear margin.
  const past = Date.now() - 60_000;
  fs.utimesSync(oldFile, past / 1000, past / 1000);
  withEnv(root, (mod) => {
    assert.equal(mod._internal.findStateFile(), newFile);
  });
});

// ─── Insert ──────────────────────────────────────────────────────────────

test('registerOrUpdateTask inserts a brand new task with the expected fields', async () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, JSON.stringify({ scheduledTasks: [] }));
  await withEnv(root, async (mod) => {
    const r = await mod.registerOrUpdateTask({
      id: 'merlin-acme-daily-ads',
      cron: '0 9 * * 1-5',
      filePath: 'C:\\fake\\skill.md',
      cwd: 'D:\\fake\\cwd',
    });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'inserted');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.scheduledTasks.length, 1);
    const entry = state.scheduledTasks[0];
    assert.equal(entry.id, 'merlin-acme-daily-ads');
    assert.equal(entry.cronExpression, '0 9 * * 1-5');
    assert.equal(entry.enabled, true);
    assert.equal(typeof entry.createdAt, 'number');
  });
});

test('registerOrUpdateTask preserves unknown daemon fields (lastRunAt etc.)', async () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, JSON.stringify({
    scheduledTasks: [{
      id: 'merlin-acme-daily-ads',
      cronExpression: '0 9 * * 1-5',
      enabled: true,
      filePath: 'old.md',
      cwd: 'D:\\old',
      createdAt: 1000,
      lastRunAt: '2026-04-26T12:00:00.000Z',
      approvedPermissions: [{ toolName: 'Bash' }],
      notifySessionId: 'local_xyz',
      jitterSeconds: 42,
    }],
  }));
  await withEnv(root, async (mod) => {
    const r = await mod.registerOrUpdateTask({
      id: 'merlin-acme-daily-ads',
      cron: '0 10 * * 1-5',
      filePath: 'new.md',
      cwd: 'D:\\new',
    });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'updated');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const e = state.scheduledTasks[0];
    assert.equal(e.cronExpression, '0 10 * * 1-5');
    assert.equal(e.filePath, 'new.md');
    assert.equal(e.cwd, 'D:\\new');
    // Fields we don't own MUST be preserved
    assert.equal(e.lastRunAt, '2026-04-26T12:00:00.000Z');
    assert.deepEqual(e.approvedPermissions, [{ toolName: 'Bash' }]);
    assert.equal(e.notifySessionId, 'local_xyz');
    assert.equal(e.jitterSeconds, 42);
    assert.equal(e.createdAt, 1000); // not regenerated on update
  });
});

test('registerOrUpdateTask returns unchanged when nothing differs', async () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, JSON.stringify({
    scheduledTasks: [{
      id: 'merlin-acme-daily-ads',
      cronExpression: '0 9 * * 1-5',
      enabled: true,
      filePath: 'a.md',
      cwd: 'D:\\a',
      createdAt: 1,
    }],
  }));
  await withEnv(root, async (mod) => {
    const r = await mod.registerOrUpdateTask({
      id: 'merlin-acme-daily-ads',
      cron: '0 9 * * 1-5',
      filePath: 'a.md',
      cwd: 'D:\\a',
    });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'unchanged');
  });
});

test('registerOrUpdateTask preserves top-level unknown keys (forward-compat)', async () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, JSON.stringify({
    scheduledTasks: [],
    schemaVersion: 7,
    futureFeature: { hello: 'world' },
  }));
  await withEnv(root, async (mod) => {
    await mod.registerOrUpdateTask({
      id: 'merlin-acme-daily-ads',
      cron: '0 9 * * 1-5',
      filePath: 'a.md',
      cwd: 'D:\\a',
    });
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.schemaVersion, 7);
    assert.deepEqual(state.futureFeature, { hello: 'world' });
  });
});

// ─── setEnabled ──────────────────────────────────────────────────────────

test('setEnabled flips an existing task and verify-after-write succeeds', async () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, JSON.stringify({
    scheduledTasks: [{
      id: 'merlin-acme-daily-ads', cronExpression: '0 9 * * 1-5',
      enabled: true, filePath: 'a.md', cwd: 'D:\\a', createdAt: 1,
    }],
  }));
  await withEnv(root, async (mod) => {
    const off = await mod.setEnabled('merlin-acme-daily-ads', false);
    assert.equal(off.ok, true);
    assert.equal(off.action, 'disabled');
    let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.scheduledTasks[0].enabled, false);

    const on = await mod.setEnabled('merlin-acme-daily-ads', true);
    assert.equal(on.ok, true);
    assert.equal(on.action, 'enabled');
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.scheduledTasks[0].enabled, true);
  });
});

test('setEnabled is idempotent — same value returns unchanged', async () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, JSON.stringify({
    scheduledTasks: [{
      id: 'merlin-acme-daily-ads', cronExpression: '0 9 * * 1-5',
      enabled: true, filePath: 'a.md', cwd: 'D:\\a', createdAt: 1,
    }],
  }));
  await withEnv(root, async (mod) => {
    const r = await mod.setEnabled('merlin-acme-daily-ads', true);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'unchanged');
  });
});

test('setEnabled returns not-found for unknown task id', async () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, JSON.stringify({ scheduledTasks: [] }));
  await withEnv(root, async (mod) => {
    const r = await mod.setEnabled('merlin-acme-ghost', false);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-found');
  });
});

test('setEnabled returns no-install when daemon dir missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-stasks-noinstall-'));
  await withEnv(root, async (mod) => {
    const r = await mod.setEnabled('merlin-acme-daily-ads', false);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-install');
  });
});

test('setEnabled rejects malformed JSON without clobbering the file', async () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, '{ broken');
  await withEnv(root, async (mod) => {
    const r = await mod.setEnabled('merlin-acme-daily-ads', false);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'malformed');
    // File MUST be untouched — we never overwrite a broken file blind.
    assert.equal(fs.readFileSync(stateFile, 'utf8'), '{ broken');
  });
});

test('setEnabled preserves all sibling tasks unchanged', async () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, JSON.stringify({
    scheduledTasks: [
      { id: 'merlin-a-x', cronExpression: '0 1 * * *', enabled: true, filePath: 'x.md', cwd: 'D:\\', createdAt: 1, lastRunAt: 'A' },
      { id: 'merlin-b-y', cronExpression: '0 2 * * *', enabled: true, filePath: 'y.md', cwd: 'D:\\', createdAt: 2, lastRunAt: 'B' },
      { id: 'merlin-c-z', cronExpression: '0 3 * * *', enabled: false, filePath: 'z.md', cwd: 'D:\\', createdAt: 3 },
    ],
  }));
  await withEnv(root, async (mod) => {
    await mod.setEnabled('merlin-b-y', false);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.scheduledTasks[0].lastRunAt, 'A');
    assert.equal(state.scheduledTasks[1].enabled, false);
    assert.equal(state.scheduledTasks[1].lastRunAt, 'B'); // sibling field preserved
    assert.equal(state.scheduledTasks[2].enabled, false); // unrelated entry untouched
    assert.equal(state.scheduledTasks[2].cronExpression, '0 3 * * *');
  });
});

// ─── removeTask ──────────────────────────────────────────────────────────

test('removeTask deletes the entry and verify-after passes', async () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, JSON.stringify({
    scheduledTasks: [
      { id: 'merlin-a-x', cronExpression: '0 1 * * *', enabled: true, filePath: 'x.md', cwd: 'D:\\', createdAt: 1 },
      { id: 'merlin-b-y', cronExpression: '0 2 * * *', enabled: true, filePath: 'y.md', cwd: 'D:\\', createdAt: 2 },
    ],
  }));
  await withEnv(root, async (mod) => {
    const r = await mod.removeTask('merlin-a-x');
    assert.equal(r.ok, true);
    assert.equal(r.action, 'removed');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.scheduledTasks.length, 1);
    assert.equal(state.scheduledTasks[0].id, 'merlin-b-y');
  });
});

test('removeTask is idempotent on missing entries', async () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, JSON.stringify({ scheduledTasks: [] }));
  await withEnv(root, async (mod) => {
    const r = await mod.removeTask('merlin-acme-ghost');
    assert.equal(r.ok, true);
    assert.equal(r.action, 'unchanged');
  });
});

// ─── snapshot ────────────────────────────────────────────────────────────

test('snapshot returns tasksById keyed by id', async () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, JSON.stringify({
    scheduledTasks: [
      { id: 'merlin-a-x', cronExpression: '0 1 * * *', enabled: true, filePath: 'x.md', cwd: 'D:\\', createdAt: 1 },
      { id: 'merlin-b-y', cronExpression: '0 2 * * *', enabled: false, filePath: 'y.md', cwd: 'D:\\', createdAt: 2 },
    ],
  }));
  withEnv(root, (mod) => {
    const s = mod.snapshot();
    assert.equal(s.available, true);
    assert.equal(Object.keys(s.tasksById).length, 2);
    assert.equal(s.tasksById['merlin-a-x'].enabled, true);
    assert.equal(s.tasksById['merlin-b-y'].enabled, false);
  });
});

test('snapshot returns available:false when no install exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-stasks-snap-empty-'));
  withEnv(root, (mod) => {
    const s = mod.snapshot();
    assert.equal(s.available, false);
    assert.equal(s.reason, 'no-install');
    assert.deepEqual(s.tasksById, {});
  });
});

// ─── Validation ──────────────────────────────────────────────────────────

test('isValidTaskId rejects path traversal + shell-meta chars', () => {
  withEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-stasks-id-')), (mod) => {
    const v = mod._internal.isValidTaskId;
    // Valid
    assert.equal(v('merlin-acme-daily-ads'), true);
    assert.equal(v('merlin-bright-co-creative-refresh'), true);
    // Invalid
    assert.equal(v('foo'), false);                    // no merlin- prefix
    assert.equal(v('merlin-'), false);                 // empty rest
    assert.equal(v('merlin-../../etc/passwd'), false); // path traversal
    assert.equal(v('merlin-acme/sub'), false);         // slash
    assert.equal(v('merlin-acme;rm'), false);          // shell meta
    assert.equal(v('merlin-acme\nx'), false);          // newline
    assert.equal(v(123), false);                        // non-string
    assert.equal(v(''), false);                         // empty
    assert.equal(v('merlin-' + 'a'.repeat(300)), false); // too long
  });
});

test('mutators reject invalid task ids before any IO', async () => {
  const { root } = makeFakeInstall();
  await withEnv(root, async (mod) => {
    const evil = 'merlin-../../etc';
    assert.deepEqual(
      await mod.setEnabled(evil, false),
      { ok: false, reason: 'invalid-id' },
    );
    assert.deepEqual(
      await mod.removeTask(evil),
      { ok: false, reason: 'invalid-id' },
    );
    const r = await mod.registerOrUpdateTask({
      id: evil, cron: '0 9 * * *', filePath: 'a.md', cwd: 'D:\\',
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid-id');
  });
});

// ─── Concurrency / atomicity ─────────────────────────────────────────────

test('parallel setEnabled calls do not corrupt the file (last-writer-wins per id)', async () => {
  const { root, stateFile } = makeFakeInstall();
  // Seed with 5 tasks and flip them all in parallel.
  const seedTasks = Array.from({ length: 5 }, (_, i) => ({
    id: `merlin-acme-task${i}`,
    cronExpression: '0 9 * * *',
    enabled: true,
    filePath: `t${i}.md`,
    cwd: 'D:\\',
    createdAt: i,
  }));
  fs.writeFileSync(stateFile, JSON.stringify({ scheduledTasks: seedTasks }));

  await withEnv(root, async (mod) => {
    const ops = seedTasks.map((t) => mod.setEnabled(t.id, false));
    const results = await Promise.all(ops);
    for (const r of results) assert.equal(r.ok, true);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.scheduledTasks.length, 5);
    for (const t of state.scheduledTasks) assert.equal(t.enabled, false);
  });
});

test('atomic write — interrupted writes never leave a half-file at the canonical path', async () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, JSON.stringify({
    scheduledTasks: [{
      id: 'merlin-acme-x', cronExpression: '0 1 * * *',
      enabled: true, filePath: 'x.md', cwd: 'D:\\', createdAt: 1,
    }],
  }));
  await withEnv(root, async (mod) => {
    await mod.setEnabled('merlin-acme-x', false);
    // The atomic write uses a uniquely-suffixed tmp file. After a clean
    // run no .tmp.* siblings should remain.
    const siblings = fs.readdirSync(path.dirname(stateFile));
    const orphanTmps = siblings.filter((n) => n.includes('.tmp.'));
    assert.deepEqual(orphanTmps, [], 'expected no orphan .tmp.* files');
  });
});

test('stale lock (>30s old) is broken automatically', async () => {
  const { root, stateFile } = makeFakeInstall();
  fs.writeFileSync(stateFile, JSON.stringify({
    scheduledTasks: [{
      id: 'merlin-acme-x', cronExpression: '0 1 * * *',
      enabled: true, filePath: 'x.md', cwd: 'D:\\', createdAt: 1,
    }],
  }));
  // Plant a stale lock from a "crashed" prior run.
  const lockPath = stateFile + '.lock';
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999, acquiredAt: Date.now() - 60_000 }));
  const past = (Date.now() - 60_000) / 1000;
  fs.utimesSync(lockPath, past, past);
  await withEnv(root, async (mod) => {
    const r = await mod.setEnabled('merlin-acme-x', false);
    assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
  });
});

// ─── friendlyReason ──────────────────────────────────────────────────────

test('friendlyReason maps every public reason to a plain-English string', () => {
  withEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-stasks-friendly-')), (mod) => {
    const codes = Object.keys(mod._internal.FRIENDLY_REASONS);
    // Every code must produce a non-empty, jargon-free message.
    for (const c of codes) {
      const msg = mod.friendlyReason(c);
      assert.ok(msg && msg.length > 0, `missing message for ${c}`);
      // No leakage of stack traces or technical jargon.
      assert.ok(!/Error:|undefined|null|\bNaN\b|stack/i.test(msg),
        `friendly message for ${c} leaks technical detail: ${msg}`);
    }
    // Unknown codes still get a friendly fallback.
    assert.ok(mod.friendlyReason('not-a-real-code'));
  });
});

// ─── No LLM hops (the regression guard for the original incident) ───────

test('REGRESSION GUARD (2026-04-27): module imports nothing from claude-agent-sdk', () => {
  const src = fs.readFileSync(path.join(__dirname, 'scheduled-tasks-daemon.js'), 'utf8');
  // Strip comment blocks/lines before scanning — comments may legitimately
  // explain that the module DELIBERATELY does not use the LLM path.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // /* … */
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // // … but not URLs
  assert.ok(
    !/(?:require|import)\s*\(\s*['"]@anthropic-ai\/claude-agent-sdk/.test(stripped),
    'scheduled-tasks-daemon.js MUST NOT import the Claude SDK. ' +
    'The whole point of this module is deterministic file IO.'
  );
  // The actual behavioural rule: no executable code calls update_scheduled_task
  // by name (string literal or otherwise). Comments are exempt.
  assert.ok(
    !/['"`]update_scheduled_task['"`]|update_scheduled_task\s*\(/.test(stripped),
    'scheduled-tasks-daemon.js executable code MUST NOT echo the LLM-prompt ' +
    'tool name. The toggle path is direct file IO; the prior LLM-prompt ' +
    'path is the bug we removed.'
  );
});

test('REGRESSION GUARD (2026-04-27): main.js toggle/create paths do not echo update_scheduled_task in any LLM prompt', () => {
  const mainPath = path.join(__dirname, 'main.js');
  if (!fs.existsSync(mainPath)) return; // running outside autoCMO checkout
  const src = fs.readFileSync(mainPath, 'utf8');
  // Strip comments — the documentation above the toggle handler may
  // legitimately mention the old broken path so future readers know what
  // we replaced.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  // No string-literal mention of the LLM tool name in EXECUTABLE code.
  // The original bug was a literal `using update_scheduled_task` template
  // sent to Claude.
  assert.ok(
    !/update_scheduled_task/.test(stripped),
    'main.js executable code MUST NOT include the literal string ' +
    '"update_scheduled_task" — that was the LLM-prompt path the 2026-04-27 ' +
    'audit replaced with deterministic file IO via scheduled-tasks-daemon.js.'
  );
});
