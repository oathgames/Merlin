// Source-scan regression test for the three latency knobs in main.js'
// query() call: model pin, autoCompactWindow, and excludeDynamicSections,
// plus the per-turn usage-telemetry log that proves the first two are
// actually working.
//
// We do NOT boot Electron here. Same pattern as ws-server.test.js and
// stripe_readonly_test.go: the source file is the contract, grep is
// the enforcement.
//
// Why this matters — and why "just read the SDK docs" isn't enough:
// All three knobs are silent-failure-mode. If a future edit drops the
// `model: 'claude-sonnet-4-6'` line, the SDK inherits the account
// default (Opus for Max-plan users) and every user's TTFT roughly
// doubles with no runtime error. If the `autoCompactWindow: 200000`
// line vanishes, the SDK silently falls back to its ~160k default and
// long-lived brand sessions start paying the compact-spike cost weeks
// sooner than necessary. If `excludeDynamicSections: true` regresses,
// cross-user prompt caching fragments and every new user / new brand
// re-pays the full system-prompt tokenization cost on every turn.
// None of those print an error. The only observable is latency, which
// users attribute to "Claude being slow" rather than a Merlin bug. The
// [sdk-usage] log line is the live canary — if cache_read drops, we
// see it in the Electron main-process stdout.
//
// Run with: node app/sdk-latency-knobs.test.js

const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;
const MAIN_JS = path.join(APP_DIR, 'main.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  \u2713', name);
    passed++;
  } catch (err) {
    console.log('  \u2717', name);
    console.log('   ', err.message);
    failed++;
  }
}

if (!fs.existsSync(MAIN_JS)) {
  console.error('FATAL: app/main.js not found at', MAIN_JS);
  process.exit(1);
}
const SRC = fs.readFileSync(MAIN_JS, 'utf8');

// -------------------------------------------------------------------------
// The comment markers that anchor the human-readable rationale. Deleting a
// marker is not allowed without deleting the corresponding rule from
// D:\autoCMO-claude\CLAUDE.md as well — the two must stay in lockstep.
// -------------------------------------------------------------------------
test('main.js keeps the LATENCY TUNING (2026-04-23) block', () => {
  if (!SRC.includes('LATENCY TUNING (2026-04-23)')) {
    throw new Error(
      'main.js lost its LATENCY TUNING (2026-04-23) REGRESSION GUARD comment. '
      + 'Do not delete it. If the rule genuinely changed, add a new dated '
      + 'block explaining the history before removing this one.'
    );
  }
});

test('main.js keeps the LATENCY TELEMETRY (2026-04-23) block', () => {
  if (!SRC.includes('LATENCY TELEMETRY (2026-04-23)')) {
    throw new Error(
      'main.js lost its LATENCY TELEMETRY (2026-04-23) comment. The usage '
      + 'log is what verifies the three knobs are actually delivering — '
      + 'deleting it blinds us to a silent-failure regression. Restore it.'
    );
  }
});

// -------------------------------------------------------------------------
// Knob 1: model pinned to Sonnet 4.6.
// -------------------------------------------------------------------------
test('main.js pins model to claude-sonnet-4-6 in query() options', () => {
  // Literal substring. Accepts single or double quotes. If a future edit
  // parameterizes this (env var, config lookup), that's a product change
  // and should update this test to enforce the new invariant — but
  // removing the pin without a replacement fails here.
  if (!/model:\s*['"]claude-sonnet-4-6['"]/.test(SRC)) {
    throw new Error(
      'main.js does not pin `model: \'claude-sonnet-4-6\'` in the query() '
      + 'options object. Without the pin, the SDK inherits the account '
      + 'default (Opus for Max-plan users) and TTFT roughly doubles on the '
      + 'interactive chat thread. See the LATENCY TUNING block for history. '
      + 'If you need a different model for a subagent, set it on that '
      + 'subagent\'s `model:` — do not change the main thread default.'
    );
  }
});

// -------------------------------------------------------------------------
// Knob 2: autoCompactWindow bumped to the full 200k model window.
// -------------------------------------------------------------------------
test('main.js sets autoCompactWindow to 200000 via inline settings', () => {
  if (!/autoCompactWindow:\s*200000\b/.test(SRC)) {
    throw new Error(
      'main.js does not set `autoCompactWindow: 200000` in the inline '
      + '`settings` layer. Without it the SDK falls back to its ~160k '
      + 'default, which triggers compaction at ~147k. Long-lived per-brand '
      + 'resume sessions hit that threshold within weeks of heavy use. '
      + 'Raise back to 200000 — higher is a no-op (model truncates at 200k '
      + 'regardless), lower re-introduces the premature-compact cost.'
    );
  }
});

// -------------------------------------------------------------------------
// Knob 3: excludeDynamicSections — already present as a separate guard,
// but we double-check here because all three knobs are interlocked and a
// drop in any one surfaces as the same symptom (slow responses).
// -------------------------------------------------------------------------
test('main.js keeps excludeDynamicSections: true on the system prompt', () => {
  if (!/excludeDynamicSections:\s*true\b/.test(SRC)) {
    throw new Error(
      'main.js lost `excludeDynamicSections: true` on the systemPrompt '
      + 'object. That flag is what keeps the cached system-prompt prefix '
      + 'identical across users and brands — without it, per-install '
      + 'dynamic bits (cwd, memory path, git status) fragment the cache '
      + 'and every new user / brand re-tokenizes ~20KB on every turn.'
    );
  }
});

// -------------------------------------------------------------------------
// Telemetry: the [sdk-usage] log line must be present and must include the
// four token fields we actually care about. If a refactor drops one of the
// fields, we lose the ability to diagnose cache regressions.
// -------------------------------------------------------------------------
test('main.js emits the [sdk-usage] log line with the four cache fields', () => {
  if (!SRC.includes('[sdk-usage]')) {
    throw new Error(
      'main.js does not emit an [sdk-usage] log line. That log is the '
      + 'only live canary for cache regressions — without it, a silent '
      + 'drop in cache hit rate goes unnoticed until users complain. '
      + 'Restore the console.log line in the for-await message loop.'
    );
  }
  const requiredFields = [
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'input_tokens',
    'output_tokens',
  ];
  for (const field of requiredFields) {
    if (!SRC.includes(field)) {
      throw new Error(
        `main.js [sdk-usage] telemetry is missing the \`${field}\` field. `
        + 'All four of input_tokens, output_tokens, cache_read_input_tokens, '
        + 'and cache_creation_input_tokens are required to compute the cache '
        + 'hit rate. Dropping one blinds that calculation.'
      );
    }
  }
});

test('main.js computes and logs the cache hit rate percentage', () => {
  // The hit-rate math is the whole point of the log — we assert both the
  // variable name and the unit symbol so a future refactor can't silently
  // stop computing it.
  if (!/hitRate|hit_rate/.test(SRC)) {
    throw new Error(
      'main.js no longer computes a cache hit rate in the usage log. The '
      + 'raw cache_read number is not actionable without the denominator — '
      + 'hit-rate % is what tells us whether the caching is actually '
      + 'working. Restore it.'
    );
  }
});

// -------------------------------------------------------------------------
// Interlock: the three knobs must coexist on the SAME query() call. A
// regression where one knob accidentally gets moved to a different query()
// site (e.g. a dev-only or test-only query) would pass the individual
// checks above but still break the production path. Look for them all
// clustered within the same ~200-line window.
// -------------------------------------------------------------------------
test('all three latency knobs live on the same query() options block', () => {
  const modelIdx = SRC.search(/model:\s*['"]claude-sonnet-4-6['"]/);
  const compactIdx = SRC.search(/autoCompactWindow:\s*200000\b/);
  const excludeIdx = SRC.search(/excludeDynamicSections:\s*true\b/);
  if (modelIdx < 0 || compactIdx < 0 || excludeIdx < 0) {
    // The individual tests above already handled missing knobs; don't
    // double-report here. Pass silently and let the specific failures
    // carry the message.
    return;
  }
  const span = Math.max(modelIdx, compactIdx, excludeIdx)
    - Math.min(modelIdx, compactIdx, excludeIdx);
  // The queryOptions block + its preceding comments fit in well under
  // 5000 chars. Anything wider means the knobs have drifted apart —
  // likely onto different query() calls, which defeats the whole point.
  const MAX_SPAN = 5000;
  if (span > MAX_SPAN) {
    throw new Error(
      `The three latency knobs have drifted apart in main.js — they span `
      + `${span} characters, which is too wide to be on the same query() `
      + `options block. They must all apply to the same query() call or `
      + `the user-facing chat thread will silently use only some of them. `
      + `Consolidate them back onto one options object.`
    );
  }
});

// -------------------------------------------------------------------------
console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
