// Merlin host-side approval routing for Merlin MCP tools.
//
// `handleToolApproval` in main.js routes every `mcp__merlin__*` call through
// READ_ONLY / SPEND / setup gates that are keyed by `input.action`. Legacy
// multiplexer tools (meta_ads, tiktok_ads, …) carry an `action` enum, so the
// gate works as designed. Intent-style tools (mcp-meta-intent.js — one tool
// per operation, no `action` multiplexer) do NOT carry that field; without
// the routing below, every intent tool fell through to the unconditional
// auto-approve at the bottom of the `mcp__merlin__` branch — letting
// `meta_launch_test_ad`, `meta_promote_to_retargeting`, and the other
// spend-firing intents fire real ad spend without the user-facing approval
// card.
//
// REGRESSION GUARD (2026-05-02, codex-spend-approval-bypass): every tool
// registered via `defineTool({ costImpact: 'spend', ... })` MUST appear in
// the SPEND-routed slot below (action === 'push' or 'duplicate'). The
// companion test (`mcp-approval-policy.test.js`) cross-references this map
// against the actual Meta intent tool registry — a future intent tool with
// `costImpact: 'spend'` that forgets to update this map fails CI before it
// can ship. The host-side approval card is the user-visible gate; the SDK
// preview-token round-trip only fires for high-blast operations where the
// agent supplies the right context (e.g. `previousBudget` on
// `meta_adjust_budget`). Both layers are required: this module is the
// always-on user gate, the preview gate is the agent-side sanity check.

'use strict';

// ── Action vocabulary (single source of truth) ──────────────────────
// Mirrors the action sets used by the legacy multiplexer tools. Keep in
// sync with the binary's action router (autocmo-core/main.go) — adding a
// new read-only action upstream means adding it here too, otherwise the
// host gate will card it unnecessarily.
const READ_ONLY_ACTIONS = Object.freeze(new Set([
  'insights', 'products', 'orders', 'analytics', 'cohorts', 'dashboard',
  'calendar', 'wisdom', 'report', 'audit', 'revenue', 'keywords',
  'rankings', 'track', 'gaps', 'status', 'performance', 'lists',
  'campaigns', 'list', 'list-avatars', 'discover', 'adlib',
  'competitor-scan', 'landing-audit', 'dry-run', 'version',
  'blog-list', 'update-rank',
]));

// SPEND_ACTIONS gate the approval card. `push` is the only action eligible
// for in-cap auto-approve (caller passes an explicit, knowable dailyBudget).
// `duplicate` always cards because the platform inherits the source's
// server-side budget — we cannot verify the eventual spend from canUseTool.
// `setup` / `setup-retargeting` always card because they touch ad-account
// state without necessarily moving budget.
const SPEND_ACTIONS = Object.freeze(new Set(['push', 'duplicate', 'setup', 'setup-retargeting']));

// ── Intent-tool routing ─────────────────────────────────────────────
//
// Map of intent-style MCP tool name → equivalent legacy `action` value. The
// chosen action determines the gate the call hits in main.js:
//   - In READ_ONLY_ACTIONS  → auto-approve
//   - In SPEND_ACTIONS      → approval card (with cents-detector + budget context)
//   - Anything else         → falls through to the catch-all auto-approve
//
// CONSERVATIVE BIAS: when the routed action's cap-check semantics don't
// match the intent tool's real cost shape (e.g. server-side budget
// inheritance, per-ad budget arrays, "re-activate paused" implying spend
// resumes at an unknowable rate), prefer 'duplicate' over 'push'. Cards
// always fire on duplicate — the user reads exactly what's about to happen
// rather than relying on an opaque "fits under cap" auto-approve.
const INTENT_TOOL_TO_ACTION = Object.freeze({
  // Read / discover / non-mutating — auto-approve via READ_ONLY
  'mcp__merlin__meta_setup_account':            'discover',
  'mcp__merlin__meta_review_performance':       'insights',
  'mcp__merlin__meta_audit':                    'audit',
  'mcp__merlin__meta_import_account_state':     'discover',
  'mcp__merlin__meta_research_competitor_ads':  'adlib',
  'mcp__merlin__meta_build_lookalike':          'audit',  // costImpact 'api'; non-spend
  // meta_pause_asset is destructive at campaign scope, but the SDK preview
  // gate already requires confirm_token for campaignId-scope pauses
  // (mcp-meta-intent.js:271). Ad-scope pause has no spend impact — auto-approve.
  'mcp__merlin__meta_pause_asset':              'audit',

  // Spend-firing — approval card mandatory
  // PUSH-style (in-cap auto-approve eligible): explicit `dailyBudget` on the
  // tool input maps directly to the per-day spend created.
  'mcp__merlin__meta_launch_test_ad':           'push',

  // DUPLICATE-style (always cards): per-ad dailyBudget array, server-side
  // budget inheritance, or "re-activate" with no rate signal — the host
  // can't verify the eventual spend without doing platform RPC, so card.
  'mcp__merlin__meta_launch_test_batch':        'duplicate',
  'mcp__merlin__meta_promote_to_retargeting':   'duplicate',
  'mcp__merlin__meta_activate_asset':           'duplicate',
  'mcp__merlin__meta_scale_winner':             'duplicate',
  'mcp__merlin__meta_adjust_budget':            'duplicate',
  // DPA setup creates an ad set in PAUSED state, but the configured
  // budget IS the spend surface — once a human flips it to ACTIVE the
  // dollars start. Card it as a duplicate-class spend action so the
  // user confirms the budget + audience targeting + freq cap before
  // the ad set is even created. Activation later goes through
  // meta_activate_asset which has its own card.
  'mcp__merlin__meta_dpa_setup':                'duplicate',

  // Setup-style — touches ad-account state, no per-call spend
  'mcp__merlin__meta_prepare_retargeting':      'setup',
});

// Per-tool friendly label for the approval card. main.js builds a generic
// label from the action alone ("Publish this ad", "Scale this winning ad"),
// which reads weirdly when the actual operation is e.g. a 50-ad batch.
// Override here so the card matches what's about to happen.
const INTENT_TOOL_LABELS = Object.freeze({
  'mcp__merlin__meta_launch_test_ad':           'Publish this Meta test ad',
  'mcp__merlin__meta_launch_test_batch':        'Launch this Meta ad batch',
  'mcp__merlin__meta_promote_to_retargeting':   'Promote ad into Meta retargeting',
  'mcp__merlin__meta_activate_asset':           'Re-activate paused Meta ad',
  'mcp__merlin__meta_scale_winner':             'Scale this winning Meta ad',
  'mcp__merlin__meta_adjust_budget':            'Change Meta ad set budget',
  'mcp__merlin__meta_prepare_retargeting':      'Set up Meta retargeting audience',
  'mcp__merlin__meta_dpa_setup':                'Set up Meta DPA catalog retargeting (PAUSED on create)',
});

/**
 * Resolve the effective routing action for a Merlin MCP call.
 *
 * Returns the legacy `action` value the caller's gate logic should use —
 * either the multiplexer's own `input.action` field (legacy path) or the
 * mapped action for an intent-style tool (this module's contribution).
 *
 * @param {string} toolName  Full tool name including `mcp__merlin__` prefix
 * @param {object} input     Tool call input as supplied to canUseTool
 * @returns {{ effectiveAction: string, label: string|null }}
 */
function resolveMerlinAction(toolName, input) {
  const rawAction = (input && typeof input.action === 'string') ? input.action : '';
  if (rawAction) return { effectiveAction: rawAction, label: null };
  const mapped = INTENT_TOOL_TO_ACTION[toolName];
  if (mapped) {
    return { effectiveAction: mapped, label: INTENT_TOOL_LABELS[toolName] || null };
  }
  return { effectiveAction: '', label: null };
}

module.exports = {
  READ_ONLY_ACTIONS,
  SPEND_ACTIONS,
  INTENT_TOOL_TO_ACTION,
  INTENT_TOOL_LABELS,
  resolveMerlinAction,
};
