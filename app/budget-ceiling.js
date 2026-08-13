// Merlin host-side daily-budget ceilings — single source of truth.
//
// REGRESSION GUARD (2026-08-13, budget-ceiling): this module exists because
// the same $5,000 constant was written out THREE times on the JS side
// (`mcp-tools.js` validateBudget, and twice in `main.js` handleToolApproval —
// the MCP spend path and the Bash spend path), each with its own wording and
// its own comparison. All three refused a legitimate $5,000/day Forever 21
// flash sale on 2026-08-13, and all three told the operator to "raise
// maxDailyAdBudget in config" — a remediation that did nothing, because none
// of them read the cap before applying the flat ceiling. The engine-side twin
// (`validateDailyBudget` in autocmo-core/main.go) had the identical defect.
//
// Two questions, two different answers. Do not collapse them again:
//
//   "Is this a plausible dollar amount at all?"  → the ceilings below.
//   "Did the operator authorize this much?"      → their declared cap.
//
// A declared `maxDailyAdBudget` is the operator stating intent in the one
// place intent belongs, so it REPLACES the default backstop. That is what
// makes the error message's instruction true. The escape hatch is bounded by
// BUDGET_ABSOLUTE_CEILING, which no config key lifts.
//
// Keep the constants and the ordering in step with autocmo-core/main.go's
// validateDailyBudget. The engine is the last line of defense and will refuse
// independently; these checks exist so the agent gets a correctable error and
// the user never sees a shocking card, not as a substitute for it.

'use strict';

// Default backstop, applied only when the operator has NOT declared a cap.
// Deliberately inclusive (`>=`): $50/day is the most common DTC daily budget
// and $50 pre-converted to cents is exactly 5000, so the boundary value is
// the single most likely cents bug rather than an unlikely one.
const BUDGET_HARD_CEILING = 5000;

// Bounds the escape hatch itself. No config value raises it. Far above any
// plausible daily spend for Merlin's user base, so it never binds a real
// launch — it exists so "the cap is authoritative" can never mean "a
// cents-scale cap authorizes a cents-scale spend."
const BUDGET_ABSOLUTE_CEILING = 100000;

// Relative cents detector: a request more than this many times the declared
// cap is treated as cents even when it sits below the flat backstop. Long
// predates this module (a $10/day request arriving as 1000 against a $20 cap
// is the original reported bug) and is deliberately tighter than the engine's
// 100x diagnostic, because denying here costs the agent one retry while
// letting it through costs real money.
const BUDGET_RELATIVE_CENTS_RATIO = 10;

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/**
 * Reason to hard-deny a daily budget before it reaches an approval card, or
 * null when the value is acceptable to show/run.
 *
 * Order matters and mirrors validateDailyBudget in autocmo-core/main.go:
 * absolute ceiling first (nothing lifts it), then the declared cap's
 * authorization, then the flat backstop, then the relative cents detector.
 *
 * @param {number} budget      Requested daily budget, in dollars.
 * @param {number} declaredCap The operator's maxDailyAdBudget (0 = none).
 * @param {{field?: string}} [opts] `field` names the offending input in the
 *        message (e.g. `ads[3].dailyBudget`) so a bulk push points at the row.
 * @returns {string|null} Agent-correctable message, or null to proceed.
 */
function denyReasonForBudget(budget, declaredCap, opts = {}) {
  const field = opts.field || 'dailyBudget';
  const cap = Number(declaredCap) > 0 ? Number(declaredCap) : 0;

  if (budget === undefined || budget === null) return null;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) {
    return `${field} must be a positive number in dollars (e.g. 10 for $10/day). Got: ${budget}`;
  }
  // Zero means "use the configured default" — resolved downstream.
  if (budget === 0) return null;

  // 1. Absolute ceiling. Applies even to an explicitly declared cap.
  if (budget >= BUDGET_ABSOLUTE_CEILING) {
    return `${field}=${budget} is at or above Merlin's ${money(BUDGET_ABSOLUTE_CEILING)}/day absolute ceiling. That ceiling is a build-time constant — no config key raises it, and raising it needs a code change. A value this large is dollars pre-converted to cents in every case we have seen: pass ${Math.round(budget / 100)} for ${money(Math.round(budget / 100))}/day. NEVER pre-convert — Merlin converts to cents internally.`;
  }

  // 2. A declared cap authorizes everything up to itself. This is the branch
  //    that makes a deliberate high-budget launch expressible at all.
  if (cap > 0 && budget <= cap) return null;

  // 3. Flat backstop — reached only when the cap does not authorize the value.
  if (budget >= BUDGET_HARD_CEILING) {
    if (cap > 0) {
      return `${field}=${budget} is both above your ${money(cap)}/day cap and at or above the ${money(BUDGET_HARD_CEILING)}/day default backstop, which usually means dollars were pre-converted to cents — pass ${Math.round(budget / 100)} for ${money(Math.round(budget / 100))}/day. If ${money(budget)}/day is genuinely intended, ask the user to confirm and raise maxDailyAdBudget to at least that amount first.`;
    }
    return `${field}=${budget} — Merlin refuses ${money(BUDGET_HARD_CEILING)}/day or more (that exact value included) while no maxDailyAdBudget is configured, because dollars pre-converted to cents land here: $50/day becomes exactly ${BUDGET_HARD_CEILING}. If you meant dollars, pass dollars (e.g. 10 for $10/day). If ${money(budget)}/day is genuinely intended, ask the user to confirm and set maxDailyAdBudget to the amount they authorize — a declared cap replaces this backstop.`;
  }

  // 4. Relative cents detector.
  if (cap > 0 && budget > cap * BUDGET_RELATIVE_CENTS_RATIO) {
    return `${field}=${budget} is more than ${BUDGET_RELATIVE_CENTS_RATIO}x your configured max of ${money(cap)}/day. This looks like cents, not dollars — pass ${Math.round(budget / 100)} for ${money(Math.round(budget / 100))}/day. NEVER pre-convert to cents.`;
  }

  return null;
}

/**
 * True when a budget must always show an approval card, even if it fits under
 * the declared cap and in-cap auto-approve is enabled.
 *
 * REGRESSION GUARD (2026-08-13): raising the ceiling via maxDailyAdBudget
 * would otherwise hand the in-cap auto-approve path a silent green light on
 * arbitrarily large spend — an operator who set the cap to 5000 for one flash
 * sale would get every subsequent $5,000/day push fired with no card. The cap
 * authorizes the AMOUNT; it does not waive the human look at this magnitude.
 *
 * @param {number} budget Requested daily budget, in dollars.
 * @returns {boolean}
 */
function alwaysRequiresCard(budget) {
  return typeof budget === 'number' && Number.isFinite(budget) && budget >= BUDGET_HARD_CEILING;
}

module.exports = {
  BUDGET_HARD_CEILING,
  BUDGET_ABSOLUTE_CEILING,
  BUDGET_RELATIVE_CENTS_RATIO,
  denyReasonForBudget,
  alwaysRequiresCard,
};
