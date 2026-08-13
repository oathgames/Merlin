// REGRESSION GUARD (2026-08-13, budget-ceiling)
//
// Live incident: a $5,000/day Forever 21 flash sale was refused by every
// budget guard in the stack, and each one told the operator to "raise
// maxDailyAdBudget in config." Raising it changed nothing — the flat $5,000
// ceiling was checked before and independently of the cap on all four sites
// (mcp-tools.js, both main.js spend paths, and validateDailyBudget in
// autocmo-core/main.go). The product could not express the launch at any
// config value, and the error message sent the operator on a debugging loop
// to discover that.
//
// These tests pin the contract that fixed it:
//   1. A declared cap authorizes up to itself, so the launch is expressible.
//   2. Following the error's instruction actually works.
//   3. The `>=` boundary is inclusive on purpose and the wording says so.
//   4. The escape hatch is bounded — no config value lifts the absolute
//      ceiling, and high-magnitude spend never auto-approves.
//   5. All three JS call sites route through this module (source scan), so
//      the constants cannot drift back apart.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  BUDGET_HARD_CEILING,
  BUDGET_ABSOLUTE_CEILING,
  BUDGET_RELATIVE_CENTS_RATIO,
  denyReasonForBudget,
  alwaysRequiresCard,
} = require('./budget-ceiling');

// ── 1. The reported incident ─────────────────────────────────────────

test('a declared cap authorizes the flash sale that used to be impossible', () => {
  // The exact 2026-08-13 case: Forever 21, $5,000/day, cap declared to match.
  assert.equal(denyReasonForBudget(5000, 5000), null,
    'REGRESSION: $5,000/day with maxDailyAdBudget=5000 must be allowed — this is the incident');
  assert.equal(denyReasonForBudget(6500, 8000), null,
    'a high budget under a higher declared cap must be allowed');
});

test("the error's remediation actually works", () => {
  // Step 1: no cap. Refused, and the message names the key that lifts it.
  const denial = denyReasonForBudget(5000, 0);
  assert.ok(denial, '$5,000/day with no cap must be refused');
  assert.match(denial, /maxDailyAdBudget/,
    'the refusal must name the config key that lifts it');

  // Step 2: do what the message says. Pre-fix this returned the same error.
  assert.equal(denyReasonForBudget(5000, 5000), null,
    'REGRESSION: the message instructs setting maxDailyAdBudget, so setting it must work');
});

// ── 2. Boundary semantics ────────────────────────────────────────────

test('the ceiling boundary is inclusive and the wording says so', () => {
  assert.equal(denyReasonForBudget(BUDGET_HARD_CEILING - 1, 0), null,
    'just under the backstop is allowed');

  const denial = denyReasonForBudget(BUDGET_HARD_CEILING, 0);
  assert.ok(denial,
    'exactly $5,000/day is refused with no cap — it is the cents form of a $50/day budget');
  assert.match(denial, /or more/,
    'an inclusive boundary must be stated as "or more"');
  assert.doesNotMatch(denial, /exceeds/,
    'must not say the value "exceeds" a ceiling it is refused AT — an operator who ' +
    'retries at exactly the ceiling gets the same refusal and no new information');
});

// ── 3. The guards that must still fire ───────────────────────────────

test('cents-for-dollars is still caught for brands on a normal cap', () => {
  // Default maxDailyAdBudget is $5, so this is the overwhelming majority.
  assert.ok(denyReasonForBudget(5000, 50), '$50 pre-converted to cents must be refused');
  assert.ok(denyReasonForBudget(1000, 20), 'the original bug report ($10/day sent as 1000)');
  assert.ok(denyReasonForBudget(500, 5), 'cents bug against the default $5 cap');
  assert.ok(denyReasonForBudget(5000, 0), 'no cap declared → flat backstop applies');
});

test('the relative detector fires beyond the ratio but not below it', () => {
  const cap = 20;
  assert.ok(denyReasonForBudget(cap * BUDGET_RELATIVE_CENTS_RATIO + 1, cap),
    'beyond the ratio reads as cents');
  // At/below the ratio the engine still enforces the cap; the host shows a
  // card with "⚠ Over budget!" rather than accusing the agent of a cents bug.
  assert.equal(denyReasonForBudget(cap * BUDGET_RELATIVE_CENTS_RATIO, cap), null,
    'exactly at the ratio is left to the card + engine, not hard-denied here');
});

test('malformed budgets are refused', () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '100', {}]) {
    assert.ok(denyReasonForBudget(bad, 50), `${String(bad)} must be refused`);
  }
  // Absent / zero mean "use the configured default" and are resolved downstream.
  assert.equal(denyReasonForBudget(undefined, 50), null);
  assert.equal(denyReasonForBudget(null, 50), null);
  assert.equal(denyReasonForBudget(0, 50), null);
});

// ── 4. The escape hatch is bounded ───────────────────────────────────

test('no config value lifts the absolute ceiling', () => {
  for (const cap of [0, 50, BUDGET_ABSOLUTE_CEILING, BUDGET_ABSOLUTE_CEILING * 10]) {
    const denial = denyReasonForBudget(BUDGET_ABSOLUTE_CEILING, cap);
    assert.ok(denial,
      `REGRESSION: the absolute ceiling must hold even with maxDailyAdBudget=${cap}`);
  }
  const denial = denyReasonForBudget(BUDGET_ABSOLUTE_CEILING * 5, BUDGET_ABSOLUTE_CEILING * 10);
  assert.match(denial, /build-time constant/,
    'must state plainly that this one really does need a code change');

  // Ordering guard: absolute ceiling must outrank the cap's authorization.
  assert.ok(denyReasonForBudget(1000000, 1000000),
    'REGRESSION: a cents-scale cap must not authorize a cents-scale spend');
});

test('high-magnitude spend always cards, even inside a raised cap', () => {
  assert.equal(alwaysRequiresCard(BUDGET_HARD_CEILING), true,
    'REGRESSION: raising the cap authorizes the amount, not the silence — a ' +
    '$5,000/day push must never ride the in-cap auto-approve path');
  assert.equal(alwaysRequiresCard(BUDGET_HARD_CEILING + 1), true);
  assert.equal(alwaysRequiresCard(BUDGET_HARD_CEILING - 1), false,
    'ordinary budgets stay eligible for in-cap auto-approve');
  assert.equal(alwaysRequiresCard(25), false);
});

// ── 5. Source scan: every call site routes through this module ───────

const APP_DIR = __dirname;
const readApp = (f) => fs.readFileSync(path.join(APP_DIR, f), 'utf8');

test('no app file re-inlines a budget ceiling constant', () => {
  // The whole point of this module is that the constant is written once.
  // A fresh `const HARD_CEILING = 5000` in a spend path is how the four-way
  // drift happened in the first place.
  for (const file of ['main.js', 'mcp-tools.js']) {
    const src = readApp(file);
    assert.doesNotMatch(src, /const\s+\w*HARD_CEILING\w*\s*=\s*\d/,
      `${file} declares its own budget ceiling constant — require it from ` +
      './budget-ceiling.js instead (see that file\'s REGRESSION GUARD)');
  }
});

test('both main.js spend paths hard-deny via the shared module', () => {
  const src = readApp('main.js');
  const denials = src.match(/budgetCeiling\.denyReasonForBudget\(/g) || [];
  assert.equal(denials.length, 2,
    'expected exactly two hard-deny call sites in main.js (the MCP spend path ' +
    'and the Bash spend path); found ' + denials.length);

  const cards = src.match(/budgetCeiling\.alwaysRequiresCard\(/g) || [];
  assert.equal(cards.length, 2,
    'REGRESSION: both in-cap auto-approve branches must consult ' +
    'alwaysRequiresCard, or a raised cap silently fires high-magnitude spend');
});

test('mcp-tools.js validates through the shared module', () => {
  const src = readApp('mcp-tools.js');
  assert.match(src, /require\('\.\/budget-ceiling'\)/,
    'mcp-tools.js must source its thresholds from budget-ceiling.js');
  assert.match(src, /denyReasonForBudget\(nb, maxCap/,
    'nested ads[] entries must be validated too — bulk push is the path where ' +
    'a per-ad cents bug multiplies across the whole batch');
});

// ── 6. Cross-repo drift guard ────────────────────────────────────────

test('constants agree with the engine, when the engine source is reachable', () => {
  // The engine (autocmo-core) is a separate private repo, so it is not always
  // checked out beside this one. Skip rather than fail when it is absent;
  // when it IS present, a mismatch is a split-brain trust boundary — the host
  // would allow a budget the binary refuses, or vice versa.
  const candidates = [
    path.resolve(APP_DIR, '../../autocmo-core/main.go'),
    path.resolve(APP_DIR, '../../../autocmo-core/main.go'),
  ];
  const enginePath = candidates.find((p) => fs.existsSync(p));
  if (!enginePath) return;

  const go = fs.readFileSync(enginePath, 'utf8');
  const pairs = [
    ['BudgetHardCeiling', BUDGET_HARD_CEILING],
    ['BudgetAbsoluteCeiling', BUDGET_ABSOLUTE_CEILING],
  ];
  for (const [goName, jsValue] of pairs) {
    const m = go.match(new RegExp(`${goName}\\s*=\\s*([\\d.]+)`));
    assert.ok(m, `could not find ${goName} in the engine source`);
    assert.equal(Number(m[1]), jsValue,
      `${goName} is ${m[1]} in autocmo-core/main.go but ${jsValue} here — ` +
      'the host and the engine must refuse the same values');
  }
});
