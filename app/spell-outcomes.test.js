// Unit tests for spell-outcomes.js. Run with `node app/spell-outcomes.test.js`.
//
// Scenario coverage:
//   1. Empty / missing brand log → null
//   2. DecisionFact entries (kill / scale / generate) counted correctly
//   3. Error-type entries counted
//   4. Legacy generation entries (action=image / blog-post / video) counted
//   5. Window filter: entries before lastRun - 5min or after lastRun + 4h excluded
//   6. Corrupted JSONL lines skipped (do not poison the roll-up)
//   7. Brand-slug validation rejects path-traversal attempts
//   8. Large log tail-read: last 128KB is enough to surface a recent run

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { readSpellOutcomes } = require('./spell-outcomes');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.log('  ✗', name);
    console.log('   ', err.message);
    if (err.stack) console.log('   ', err.stack.split('\n').slice(1, 4).join('\n    '));
    failed++;
  }
}

function makeBrandLog(brand, lines) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-spell-outcomes-'));
  const brandDir = path.join(tmpRoot, 'assets', 'brands', brand);
  fs.mkdirSync(brandDir, { recursive: true });
  fs.writeFileSync(
    path.join(brandDir, 'activity.jsonl'),
    lines.map(l => JSON.stringify(l)).join('\n') + '\n'
  );
  return tmpRoot;
}

function cleanup(tmpRoot) {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

const LAST_RUN = '2026-04-19T12:00:00Z';
const LAST_RUN_MS = Date.parse(LAST_RUN);
const iso = (offsetMs) => new Date(LAST_RUN_MS + offsetMs).toISOString();

console.log('Running spell-outcomes tests...\n');

test('returns null when brand log does not exist', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-spell-outcomes-'));
  try {
    const out = readSpellOutcomes(tmpRoot, 'ghost-brand', LAST_RUN);
    assert.strictEqual(out, null);
  } finally {
    cleanup(tmpRoot);
  }
});

test('returns null when lastRun is missing or unparseable', () => {
  const tmpRoot = makeBrandLog('acme', []);
  try {
    assert.strictEqual(readSpellOutcomes(tmpRoot, 'acme', null), null);
    assert.strictEqual(readSpellOutcomes(tmpRoot, 'acme', ''), null);
    assert.strictEqual(readSpellOutcomes(tmpRoot, 'acme', 'not-a-date'), null);
  } finally {
    cleanup(tmpRoot);
  }
});

test('rejects brand names with path-traversal characters', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-spell-outcomes-'));
  try {
    assert.strictEqual(readSpellOutcomes(tmpRoot, '../../etc', LAST_RUN), null);
    assert.strictEqual(readSpellOutcomes(tmpRoot, 'brand/slash', LAST_RUN), null);
    assert.strictEqual(readSpellOutcomes(tmpRoot, 'brand with spaces', LAST_RUN), null);
  } finally {
    cleanup(tmpRoot);
  }
});

test('counts DecisionFact kill/scale/generate entries', () => {
  const tmpRoot = makeBrandLog('acme', [
    { ts: iso(60_000), type: 'decision', action: 'kill', decision: { action: 'kill', target: 'ad_1', trigger: 'fatigue' } },
    { ts: iso(120_000), type: 'decision', action: 'kill', decision: { action: 'kill', target: 'ad_2', trigger: 'dead_on_arrival' } },
    { ts: iso(180_000), type: 'decision', action: 'scale', decision: { action: 'scale', target: 'ad_3', trigger: 'winner' } },
    { ts: iso(240_000), type: 'decision', action: 'generate', decision: { action: 'generate', target: 'ad_4' } },
  ]);
  try {
    const out = readSpellOutcomes(tmpRoot, 'acme', LAST_RUN);
    assert.deepStrictEqual(out, { kills: 2, scales: 1, generated: 1, errors: 0 });
  } finally {
    cleanup(tmpRoot);
  }
});

test('counts error entries via type=error and severity=error', () => {
  const tmpRoot = makeBrandLog('acme', [
    { ts: iso(10_000), type: 'error', action: 'meta-insights', detail: 'token expired' },
    { ts: iso(20_000), type: 'optimize', severity: 'error', detail: 'rate limited' },
    { ts: iso(30_000), type: 'optimize', severity: 'info', detail: 'ok' }, // NOT an error
  ]);
  try {
    const out = readSpellOutcomes(tmpRoot, 'acme', LAST_RUN);
    assert.strictEqual(out.errors, 2);
  } finally {
    cleanup(tmpRoot);
  }
});

test('counts legacy generation entries (image, blog-post, video)', () => {
  const tmpRoot = makeBrandLog('acme', [
    { ts: iso(10_000), type: 'optimize', action: 'image' },
    { ts: iso(20_000), type: 'optimize', action: 'blog-post' },
    { ts: iso(30_000), type: 'optimize', action: 'video' },
    { ts: iso(40_000), type: 'optimize', action: 'meta-insights' }, // NOT a generation
  ]);
  try {
    const out = readSpellOutcomes(tmpRoot, 'acme', LAST_RUN);
    assert.strictEqual(out.generated, 3);
  } finally {
    cleanup(tmpRoot);
  }
});

test('excludes entries outside [lastRun - 5min, lastRun + 4h]', () => {
  const tmpRoot = makeBrandLog('acme', [
    { ts: iso(-10 * 60 * 1000), type: 'decision', decision: { action: 'kill' } }, // 10min before → out
    { ts: iso(-4 * 60 * 1000), type: 'decision', decision: { action: 'kill' } },  // 4min before → in
    { ts: iso(60_000), type: 'decision', decision: { action: 'kill' } },           // 1min after → in
    { ts: iso(4 * 60 * 60 * 1000 + 60_000), type: 'decision', decision: { action: 'kill' } }, // 4h+1min → out
  ]);
  try {
    const out = readSpellOutcomes(tmpRoot, 'acme', LAST_RUN);
    assert.strictEqual(out.kills, 2);
  } finally {
    cleanup(tmpRoot);
  }
});

test('skips corrupted JSONL lines without throwing', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-spell-outcomes-'));
  const brandDir = path.join(tmpRoot, 'assets', 'brands', 'acme');
  fs.mkdirSync(brandDir, { recursive: true });
  const lines = [
    JSON.stringify({ ts: iso(10_000), type: 'decision', decision: { action: 'kill' } }),
    'not valid json {',
    JSON.stringify({ ts: iso(20_000), type: 'decision', decision: { action: 'scale' } }),
    '',
    JSON.stringify({ ts: 'also not a date', type: 'decision', decision: { action: 'kill' } }),
  ];
  fs.writeFileSync(path.join(brandDir, 'activity.jsonl'), lines.join('\n'));
  try {
    const out = readSpellOutcomes(tmpRoot, 'acme', LAST_RUN);
    assert.deepStrictEqual(out, { kills: 1, scales: 1, generated: 0, errors: 0 });
  } finally {
    cleanup(tmpRoot);
  }
});

test('tail-reads large logs (>1MB) and surfaces recent run', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-spell-outcomes-'));
  const brandDir = path.join(tmpRoot, 'assets', 'brands', 'acme');
  fs.mkdirSync(brandDir, { recursive: true });
  const logPath = path.join(brandDir, 'activity.jsonl');
  // Build ~1.2MB of filler entries (far before window) synchronously so the
  // tail-read kicks in, then append the recent entry we expect to surface.
  // The recent entry sits in the last ~100 bytes — well inside the 128KB
  // tail window, so readSpellOutcomes must surface it despite dropping
  // the first (partial) line during tail-read.
  const filler = JSON.stringify({ ts: '2020-01-01T00:00:00Z', type: 'optimize', detail: 'x'.repeat(200) }) + '\n';
  const fillerCount = Math.ceil((1.2 * 1024 * 1024) / filler.length);
  const recent = JSON.stringify({ ts: iso(60_000), type: 'decision', decision: { action: 'kill' } }) + '\n';
  fs.writeFileSync(logPath, filler.repeat(fillerCount) + recent);
  try {
    const stat = fs.statSync(logPath);
    assert.ok(stat.size > 1024 * 1024, `log should be >1MB to exercise tail path (got ${stat.size})`);
    const out = readSpellOutcomes(tmpRoot, 'acme', LAST_RUN);
    assert.ok(out, 'expected non-null outcomes');
    assert.strictEqual(out.kills, 1);
  } finally {
    cleanup(tmpRoot);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
