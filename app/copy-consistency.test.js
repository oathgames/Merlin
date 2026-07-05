// copy-consistency.test.js: source-scan locks for the microcopy-unification
// pass (2026-07-04). renderer.js is not requireable (it runs inside the
// Electron renderer against a live DOM) and index.html is markup, so — like
// the other renderer guards (see renderer-ux.test.js) — each fix is pinned by
// scanning the shipped source text for the string that makes the fix true and,
// where it matters, for the anti-pattern that made the old copy wrong.
//
// Why these particular anchors: they are the stable, user-visible strings the
// unification standardized. If a future edit reintroduces the old copy (a
// designer re-types "7D Left", a refactor drops the shared formatMoney helper,
// a placeholder regains an ASCII "..."), the corresponding assertion fails and
// names the reason inline so the fix is obvious without archaeology.
//
// Fixes pinned here:
//   1. Trial pill reads "N days left", never the cramped "ND Left".
//   2. The out-of-credits error points at the ✦ Magic panel, never a
//      nonexistent "Settings → Connections" screen (phantom-path defect).
//   3. The perf-bar period picker offers 30D/90D, not the old 1M/3M labels.
//   4. formatMoney + timeAgo exist as single shared helpers (dedupe of ~5
//      money formatters and 4 time-ago copies onto one dialect each).
//   5. The composer + archive-search placeholders use the "…" ellipsis glyph,
//      never ASCII "...".
//   6. Canonical product terms: the automation concept is a "spell"; gallery
//      contents are "creatives".
//   7. Sentence-case action buttons (no Title Case labels).

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// Strip full-line JS comments so doc blocks that MENTION an old label (e.g.
// the "// ... single Retry Connection button" comments) don't count as hits.
const rendererCode = rendererSrc.replace(/^[ \t]*\/\/.*$/gm, '');
// Strip HTML comments from index.html for the same reason.
const indexCode = indexSrc.replace(/<!--[\s\S]*?-->/g, '');

// ── Lock 1: trial pill copy ────────────────────────────────────────

test('trial pill reads "N days left", never "ND Left"', () => {
  // Anti-pattern: the cramped "7D Left" / `${days}D Left` form.
  assert.doesNotMatch(indexCode, /7D Left/,
    'index.html trial pill must read "7 days left", not "7D Left"');
  assert.doesNotMatch(rendererCode, /\$\{days\}D Left/,
    'renderer.js trial pill template must read "${days} days left", not "${days}D Left"');
  // Positive: the sentence-case form is present in both.
  assert.match(indexSrc, /7 days left/,
    'index.html must ship the "7 days left" trial pill');
  assert.match(rendererCode, /\$\{days\} days left/,
    'renderer.js must build the trial pill as "${days} days left"');
  // Expired / Get Pro states are preserved.
  assert.match(rendererCode, /'Expired'/, 'the Expired trial state must be preserved');
  assert.match(rendererCode, /'Get Pro'/, 'the Get Pro CTA must be preserved');
});

// ── Lock 2: no phantom "Settings → Connections" path for credits ───

test('out-of-credits error points at the Magic panel, not a Settings screen', () => {
  // Anti-pattern: telling the user to open a Settings/Connections panel that
  // does not exist in the app. The only credit-add affordance is ✦ Magic.
  assert.doesNotMatch(rendererCode, /Open Settings → Connections/,
    'the credits error must not tell users to "Open Settings → Connections" — ' +
    'no such panel exists; route them to the ✦ Magic panel instead');
  // Positive: the credits branch names the ✦ Magic panel.
  assert.match(rendererCode, /Open the ✦ Magic panel to add more credits\./,
    'the out-of-credits error must direct users to the ✦ Magic panel');
});

// ── Lock 3: perf-bar period picker labels ──────────────────────────

test('perf-bar period picker shows 30D/90D, not 1M/3M', () => {
  // The two data-days buttons that were relabeled in an earlier pass.
  assert.match(indexCode, /data-days="30">30D</,
    'the 30-day period button must be labeled "30D"');
  assert.match(indexCode, /data-days="90">90D</,
    'the 90-day period button must be labeled "90D"');
  // Anti-pattern: the old month-based labels on those same buttons.
  assert.doesNotMatch(indexCode, /data-days="30">1M</,
    'the 30-day button must not carry the old "1M" label');
  assert.doesNotMatch(indexCode, /data-days="90">3M</,
    'the 90-day button must not carry the old "3M" label');
});

// ── Lock 4: single shared formatMoney + timeAgo helpers ────────────

test('formatMoney exists as a single shared helper', () => {
  const decls = rendererCode.match(/function\s+formatMoney\s*\(/g) || [];
  assert.strictEqual(decls.length, 1,
    `expected exactly one \`function formatMoney(\` declaration, found ${decls.length}; ` +
    'every money surface must route through the one shared formatter');
  // Its dialect: abs<1000 → comma-grouped whole dollars; larger → uppercase K/M/B.
  const body = rendererCode.match(/function\s+formatMoney\s*\([\s\S]{0,900}?\n\}/)[0];
  assert.match(body, /toLocaleString\(\)/, 'formatMoney must comma-group sub-$1000 values');
  assert.match(body, /}B`/, 'formatMoney must emit an uppercase B suffix for billions');
  assert.match(body, /}M`/, 'formatMoney must emit an uppercase M suffix for millions');
  assert.match(body, /}K`/, 'formatMoney must emit an uppercase K suffix (never lowercase "k")');
  // Anti-pattern: the retired lowercase-"k" money formatter body.
  assert.doesNotMatch(rendererCode, /\(n \/ 1000\)\.toFixed\(1\)\.replace\(\/\\\.0\$\/, ''\) \+ 'k'/,
    'the lowercase-"k" money format must not return');
});

test('timeAgo exists as a single shared helper with the richest behavior', () => {
  const decls = rendererCode.match(/function\s+timeAgo\s*\(/g) || [];
  assert.strictEqual(decls.length, 1,
    `expected exactly one \`function timeAgo(\` declaration, found ${decls.length}; ` +
    'every relative-time surface must route through the one shared helper');
  const body = rendererCode.match(/function\s+timeAgo\s*\([\s\S]{0,1200}?\n\}/)[0];
  assert.match(body, /'yesterday'/, 'timeAgo must keep the "yesterday" special-case');
  assert.match(body, /Math\.floor/, 'timeAgo must floor its units (richest behavior)');
});

test('the former time-ago copies now delegate to timeAgo', () => {
  // wisdomRelTime + formatTimeAgo survive as thin wrappers (kept for their
  // existing call sites) but must no longer re-implement the ladder.
  const wisdom = rendererCode.match(/function\s+wisdomRelTime\s*\([\s\S]{0,300}?\n\}/);
  assert.ok(wisdom, 'wisdomRelTime must still exist');
  assert.match(wisdom[0], /timeAgo\(/, 'wisdomRelTime must delegate to timeAgo');
  const fmt = rendererCode.match(/function\s+formatTimeAgo\s*\([\s\S]{0,300}?\n\}/);
  assert.ok(fmt, 'formatTimeAgo must still exist');
  assert.match(fmt[0], /timeAgo\(/, 'formatTimeAgo must delegate to timeAgo');
});

// ── Lock 5: ellipsis glyph in key placeholders ─────────────────────

test('composer + archive-search placeholders use the "…" glyph, not "..."', () => {
  assert.match(indexCode, /placeholder="Message Merlin…"/,
    'the composer placeholder must use the "…" ellipsis glyph');
  assert.doesNotMatch(indexCode, /placeholder="Message Merlin\.\.\."/,
    'the composer placeholder must not use ASCII "..."');
  assert.match(indexCode, /placeholder="Search brand, product, model…"/,
    'the archive-search placeholder must use the "…" ellipsis glyph');
  assert.doesNotMatch(indexCode, /placeholder="Search brand, product, model\.\.\."/,
    'the archive-search placeholder must not use ASCII "..."');
});

// ── Lock 6: canonical product terms ────────────────────────────────

test('the automation concept surfaces as a "spell"', () => {
  assert.match(rendererCode, /Create your own spell/,
    'the custom-spell template must say "Create your own spell"');
  assert.doesNotMatch(rendererCode, /Create your own automation/,
    'the old "Create your own automation" label must not return');
  assert.match(rendererCode, /turn on your first spell/,
    'the onboarding nudge must say "turn on your first spell"');
  assert.match(indexCode, /data-step="automation">Spell active</,
    'the onboarding progress step must read "Spell active"');
});

test('gallery empty-state calls its contents "creatives"', () => {
  assert.match(indexCode, /No creatives yet/,
    'the archive empty state must read "No creatives yet"');
  assert.doesNotMatch(indexCode, /No content yet/,
    'the old "No content yet" empty state must not return');
});

// ── Lock 7: sentence-case action buttons ───────────────────────────

test('action buttons are sentence-case, not Title Case', () => {
  for (const stale of [
    'Upgrade Now', 'Install Now', 'Start Fresh Session',
    'Retry Connection', 'Generate Report', 'Sign In to Claude',
  ]) {
    assert.ok(!new RegExp(`textContent = '${stale}'`).test(rendererCode),
      `button label "${stale}" must be sentence-cased (found a Title-Case assignment)`);
  }
  assert.doesNotMatch(indexCode, />Get Started</,
    'the ToS accept button must read "Get started", not "Get Started"');
  // Proper nouns / product terms are preserved.
  assert.match(rendererCode, /'Get Pro'/, '"Get Pro" (product tier) must stay Title Case');
});
