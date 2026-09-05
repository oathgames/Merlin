// Frozen-surface parity test (Electron / JS half).
//
// Compares the live collection from `app/frozen-surfaces.js` against the
// committed snapshot at `app/__snapshots__/frozen-surfaces.snapshot.json`.
// Read the header of `app/frozen-surfaces.js` for the before/after refactor
// workflow — this file only enforces it.
//
// Accepting an intentional change:
//     npm run parity:update          # or: UPDATE_FROZEN_SURFACES=1 node --test app/frozen-surfaces.test.js
// then COMMIT the regenerated snapshot. The npm script passes an argv flag
// rather than an env prefix so the same command works in cmd.exe, PowerShell
// and bash without a cross-env dependency; the env var is honored too, for
// shells where a prefix is natural. The snapshot diff is what reviewers
// read; regenerating without calling the change out in the PR body defeats
// the entire harness.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { collectFrozenSurfaces, canonicalJSON, canonicalize } = require('./frozen-surfaces');

const SNAPSHOT_DIR = path.join(__dirname, '__snapshots__');
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, 'frozen-surfaces.snapshot.json');

// Cross-platform accept switch: an argv flag (what `npm run parity:update`
// passes, so cmd.exe / PowerShell need no env-prefix support) OR the env var.
const WANTS_UPDATE =
  process.env.UPDATE_FROZEN_SURFACES === '1' ||
  process.argv.includes('--update-frozen-surfaces');

const ACCEPT_INSTRUCTIONS = [
  '',
  'If this drift is a BUG: fix the code. Do not touch the snapshot.',
  'If this drift is INTENTIONAL, accept it explicitly:',
  '',
  '    npm run parity:update        (or UPDATE_FROZEN_SURFACES=1 node --test app/frozen-surfaces.test.js)',
  '',
  'then COMMIT app/__snapshots__/frozen-surfaces.snapshot.json. The snapshot',
  'diff is what reviewers read in code review — an unexplained regeneration',
  'is a review blocker, so call the change out in the PR body too.',
].join('\n');

// ── Structural drift: name the surface and the key ────────────
//
// Reported before the textual diff because "mcpTools[meta_scale_winner].
// annotations.costImpact" is the sentence a reviewer needs; the unified diff
// is the corroborating detail.

function diffPaths(expected, actual, prefix = '', out = []) {
  if (out.length >= 40) return out;
  const bothObjects =
    expected && actual && typeof expected === 'object' && typeof actual === 'object' &&
    Array.isArray(expected) === Array.isArray(actual);

  if (!bothObjects) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      out.push({ path: prefix || '<root>', expected, actual });
    }
    return out;
  }

  if (Array.isArray(expected)) {
    // Scalar lists (action sets, config allowlists, version.json's updatable)
    // are SETS in practice: they are sorted at collection time, so one removed
    // element shifts every later index and a positional walk would report
    // dozens of spurious drifts that bury the real one. Report membership.
    const allScalar = (arr) => arr.every((v) => v === null || typeof v !== 'object');
    if (allScalar(expected) && allScalar(actual)) {
      const remaining = new Map();
      for (const v of expected) {
        const k = JSON.stringify(v);
        remaining.set(k, (remaining.get(k) || 0) + 1);
      }
      for (const v of actual) {
        const k = JSON.stringify(v);
        if (remaining.get(k)) remaining.set(k, remaining.get(k) - 1);
        else if (out.length < 40) out.push({ path: `${prefix}[+added]`, expected: undefined, actual: v });
      }
      for (const v of expected) {
        const k = JSON.stringify(v);
        if (remaining.get(k) && out.length < 40) {
          remaining.set(k, remaining.get(k) - 1);
          out.push({ path: `${prefix}[-removed]`, expected: v, actual: undefined });
        }
      }
      return out;
    }
    const len = Math.max(expected.length, actual.length);
    for (let i = 0; i < len && out.length < 40; i++) {
      diffPaths(expected[i], actual[i], `${prefix}[${i}]`, out);
    }
    return out;
  }

  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const key of keys) {
    if (out.length >= 40) break;
    const child = prefix ? `${prefix}.${key}` : key;
    if (!(key in expected)) { out.push({ path: child, expected: undefined, actual: actual[key] }); continue; }
    if (!(key in actual)) { out.push({ path: child, expected: expected[key], actual: undefined }); continue; }
    diffPaths(expected[key], actual[key], child, out);
  }
  return out;
}

function short(value) {
  if (value === undefined) return '<absent>';
  const s = JSON.stringify(value);
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

function formatPathDrift(drifts) {
  return drifts
    .map((d) => `  ${d.path}\n      snapshot: ${short(d.expected)}\n      live:     ${short(d.actual)}`)
    .join('\n');
}

// ── Unified diff of the pretty JSON ───────────────────────────
//
// Common prefix/suffix trimming rather than a full LCS. That is only
// readable when the change is ONE contiguous region, so `collectHunks`
// below first walks down to the smallest subtrees that actually differ and
// diffs each of those separately — otherwise two distant edits would print
// as one hunk spanning everything between them.

function unifiedDiff(expectedText, actualText, context = 3, maxLines = 120) {
  const a = expectedText.split('\n');
  const b = actualText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }

  const from = Math.max(0, start - context);
  const lines = [`@@ line ${from + 1} @@`];
  for (let i = from; i < start; i++) lines.push(`  ${a[i]}`);
  for (let i = start; i <= endA; i++) lines.push(`- ${a[i]}`);
  for (let i = start; i <= endB; i++) lines.push(`+ ${b[i]}`);
  for (let i = endA + 1; i <= Math.min(a.length - 1, endA + context); i++) lines.push(`  ${a[i]}`);

  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).concat([`  ... ${lines.length - maxLines} more diff lines elided`]).join('\n');
  }
  return lines.join('\n');
}

// Descend to the smallest differing subtrees, then diff each one. A node is
// only descended into while it is big enough that a whole-node diff would be
// unreadable; below that threshold the node prints in full, which is what a
// reviewer wants for a single tool or a single skill entry.
const HUNK_DESCEND_THRESHOLD = 800;
const MAX_HUNKS = 8;

function collectHunks(expected, actual, prefix = '', hunks = []) {
  if (hunks.length >= MAX_HUNKS) return hunks;
  const ex = JSON.stringify(expected);
  const ac = JSON.stringify(actual);
  if (ex === ac) return hunks;

  const bothContainers =
    expected && actual && typeof expected === 'object' && typeof actual === 'object' &&
    Array.isArray(expected) === Array.isArray(actual);
  const big = (ex || '').length + (ac || '').length > HUNK_DESCEND_THRESHOLD;

  // A scalar list is diffed WHOLE, never descended into: it is sorted, so
  // prefix/suffix trimming already yields a clean one-line +/- for an added or
  // removed member, whereas descending positionally would emit a hunk for
  // every shifted index.
  const scalarList = (v) => Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object');
  if (bothContainers && big && !(scalarList(expected) && scalarList(actual))) {
    const keys = Array.isArray(expected)
      ? [...Array(Math.max(expected.length, actual.length)).keys()]
      : [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      if (hunks.length >= MAX_HUNKS) break;
      const child = Array.isArray(expected) ? `${prefix}[${key}]` : (prefix ? `${prefix}.${key}` : String(key));
      collectHunks(expected[key], actual[key], child, hunks);
    }
    return hunks;
  }

  hunks.push({
    path: prefix || '<root>',
    diff: unifiedDiff(
      JSON.stringify(expected === undefined ? null : expected, null, 2),
      JSON.stringify(actual === undefined ? null : actual, null, 2)
    ),
  });
  return hunks;
}

function formatHunks(hunks) {
  if (hunks.length === 0) return '  (no structural hunk — whitespace or key-order only)';
  return hunks
    .map((h) => [
      `--- snapshot: ${h.path}`,
      `+++ live:     ${h.path}`,
      h.diff,
    ].join('\n'))
    .join('\n\n');
}

// ── The parity test ───────────────────────────────────────────

test('frozen surfaces match the committed snapshot', () => {
  const live = collectFrozenSurfaces();
  const liveText = canonicalJSON(live);

  if (WANTS_UPDATE) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, liveText, 'utf8');
    console.log(`[frozen-surfaces] snapshot regenerated: ${SNAPSHOT_FILE}`);
    console.log('[frozen-surfaces] COMMIT it and explain the change in the PR body.');
    return;
  }

  assert.ok(
    fs.existsSync(SNAPSHOT_FILE),
    `No snapshot at ${SNAPSHOT_FILE}.\n${ACCEPT_INSTRUCTIONS}`
  );

  // Normalize CRLF: this repo is cloned with core.autocrlf=true on Windows,
  // so git checks the committed LF snapshot out with CRLF line endings. The
  // collector always emits LF, so without this the harness would be red on
  // every fresh Windows clone and green in CI — the worst possible split.
  const snapshotText = fs.readFileSync(SNAPSHOT_FILE, 'utf8').replace(/\r\n/g, '\n');
  if (snapshotText === liveText) return;

  const snapshot = JSON.parse(snapshotText);
  const liveCanonical = canonicalize(live);
  const drifts = diffPaths(snapshot, liveCanonical);
  const hunks = collectHunks(snapshot, liveCanonical);
  const message = [
    'FROZEN SURFACE DRIFT — an externally visible contract moved.',
    '',
    `Drifting keys (${drifts.length}${drifts.length >= 40 ? '+, truncated' : ''}):`,
    formatPathDrift(drifts) || '  (whitespace/ordering only)',
    '',
    `Unified diff (${hunks.length}${hunks.length >= MAX_HUNKS ? '+, truncated' : ''} hunk(s)):`,
    formatHunks(hunks),
    ACCEPT_INSTRUCTIONS,
  ].join('\n');

  assert.fail(message);
});

test('collection is deterministic across repeated runs', () => {
  // A non-deterministic collector makes every future diff untrustworthy.
  assert.equal(canonicalJSON(collectFrozenSurfaces()), canonicalJSON(collectFrozenSurfaces()));
});

// ── Negative tests: prove drift is actually detected ──────────
//
// Each mutates ONE surface in memory and asserts the comparison both fails
// and names the mutated key. Without these, a collector that silently
// dropped a surface would keep the parity test green forever.

test('NEGATIVE: a changed MCP tool description is detected and named', () => {
  const baseline = collectFrozenSurfaces();
  const mutated = JSON.parse(canonicalJSON(baseline));
  assert.ok(mutated.mcpTools.length > 0, 'no MCP tools collected — the collector itself is broken');

  const idx = mutated.mcpTools.findIndex((t) => t.name === 'connection_status');
  assert.ok(idx >= 0, 'connection_status must exist for this negative test');
  mutated.mcpTools[idx].description = 'DRIFTED DESCRIPTION';

  const drifts = diffPaths(canonicalize(baseline), mutated);
  assert.ok(drifts.length > 0, 'mutating a tool description must produce drift');
  assert.ok(
    drifts.some((d) => d.path === `mcpTools[${idx}].description`),
    `drift must name the changed key, got: ${drifts.map((d) => d.path).join(', ')}`
  );
  assert.notEqual(canonicalJSON(baseline), JSON.stringify(mutated, null, 2) + '\n');
});

test('NEGATIVE: a changed budget ceiling is detected and named', () => {
  const baseline = collectFrozenSurfaces();
  const mutated = JSON.parse(canonicalJSON(baseline));
  mutated.budgetCeilings.BUDGET_HARD_CEILING = 999999;

  const drifts = diffPaths(canonicalize(baseline), mutated);
  assert.deepEqual(drifts.map((d) => d.path), ['budgetCeilings.BUDGET_HARD_CEILING']);
  assert.equal(drifts[0].actual, 999999);
});

test('NEGATIVE: a dropped skill and a changed skill body are both detected', () => {
  const baseline = collectFrozenSurfaces();
  assert.ok(baseline.skills.length > 0, 'no SKILLs collected — the collector itself is broken');

  const bodyChanged = JSON.parse(canonicalJSON(baseline));
  bodyChanged.skills[0].bodySha256 = '0'.repeat(64);
  const bodyDrifts = diffPaths(canonicalize(baseline), bodyChanged);
  assert.ok(
    bodyDrifts.some((d) => d.path === 'skills[0].bodySha256'),
    'a changed SKILL body must surface as a bodySha256 drift'
  );

  const dropped = JSON.parse(canonicalJSON(baseline));
  const removedName = dropped.skills.pop().dir;
  const dropDrifts = diffPaths(canonicalize(baseline), dropped);
  assert.ok(dropDrifts.length > 0, `dropping SKILL ${removedName} must produce drift`);
  assert.ok(
    dropDrifts.some((d) => d.path.startsWith(`skills[${baseline.skills.length - 1}]`)),
    `dropping a SKILL must name its index, got: ${dropDrifts.map((d) => d.path).join(', ')}`
  );
});

test('NEGATIVE: a spend action removed from the approval policy is detected', () => {
  // The Rule 19 failure shape: a spend-firing route quietly leaves the set
  // that decides whether the user sees an approval card.
  const baseline = collectFrozenSurfaces();
  const mutated = JSON.parse(canonicalJSON(baseline));
  assert.ok(mutated.approvalPolicy.spendActions.includes('push'), "'push' must be a spend action");
  mutated.approvalPolicy.spendActions = mutated.approvalPolicy.spendActions.filter((a) => a !== 'push');

  // A sorted scalar list is compared as a SET, so one removal must report as
  // exactly one drift naming the removed value — not N index shifts.
  const drifts = diffPaths(canonicalize(baseline), mutated);
  assert.deepEqual(
    drifts.map((d) => d.path),
    ['approvalPolicy.spendActions[-removed]'],
    `drift must be exactly the removal, got: ${JSON.stringify(drifts.map((d) => d.path))}`
  );
  assert.equal(drifts[0].expected, 'push');
});

test('the failure message tells the reader exactly how to accept a change', () => {
  // The harness is only useful if a red run is actionable without reading
  // this file. Pin the two things the message must always carry.
  assert.match(ACCEPT_INSTRUCTIONS, /npm run parity:update/);
  assert.match(ACCEPT_INSTRUCTIONS, /UPDATE_FROZEN_SURFACES=1/);
  assert.match(ACCEPT_INSTRUCTIONS, /reviewers read/);

  // And that `npm run parity:update` actually maps to this file's accept
  // switch. A renamed script would make the advice above a lie — the exact
  // "remediation that cannot work" failure Hard-Won Rule 25 is about.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const script = (pkg.scripts && pkg.scripts['parity:update']) || '';
  assert.match(script, /frozen-surfaces\.test\.js/, 'parity:update must run this test file');
  assert.match(script, /--update-frozen-surfaces/, 'parity:update must pass the accept flag this file reads');
});
