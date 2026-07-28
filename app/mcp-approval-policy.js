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
  // 'adlib' was removed 2026-07-26 alongside the dead meta-adlib route (see
  // mcp-meta-intent.js meta_research_competitor_ads). Ad Library research
  // routes through 'competitor-scan', which is right below.
  'campaigns', 'list', 'list-avatars', 'discover',
  'competitor-scan', 'landing-audit', 'dry-run', 'version',
  'blog-list', 'update-rank',
  // Reddit / LinkedIn list ad accounts (no spend, no destructive op).
  'accounts',
  // Reddit ad-group / ad list (parallel to 'campaigns' — read-only listing).
  'adgroups', 'ads',
  // Mailchimp + Klaviyo read-only template / automation enumeration.
  // Adding these here means the destructive=true tool wrapper auto-
  // approves GET endpoints (templates-list / template-get / etc.)
  // while still routing the CRUD verbs (-create / -update / -delete /
  // -bulk-upload) through the approval card. campaign-content is the
  // Mailchimp rendered-HTML export (two GETs, no writes) — NOT to be
  // confused with campaign-set-content, which stays carded.
  'campaign-content',
  'templates-list', 'template-get',
  'automations-list', 'automation-emails',
  'flows-list', 'flow-get',
  // Klaviyo segment enumeration (GET, no writes). segment-create stays
  // carded via the destructive-tool default.
  'segments-list',
]));

// SPEND_ACTIONS gate the approval card. `push` is the only action eligible
// for in-cap auto-approve (caller passes an explicit, knowable dailyBudget).
// `duplicate` always cards because the platform inherits the source's
// server-side budget — we cannot verify the eventual spend from canUseTool.
// `kill` always cards because pausing a campaign affects every ad under it
// (the failure mode the meta_pause_asset preview gate guards against —
// E002 lift the same rule into the universal SPEND_ACTIONS set).
// `setup` / `setup-retargeting` always card because they touch ad-account
// state without necessarily moving budget.
// REGRESSION GUARD (2026-05-10, E002): adding 'kill' here means every
// destructive verb on a legacy multiplexer routes through the card path —
// no orphan that auto-approves a stop-spend operation under the catch-all.
const SPEND_ACTIONS = Object.freeze(new Set([
  'push', 'duplicate', 'kill', 'setup', 'setup-retargeting',
  // Reddit explicit creators (the multiplexer routes 'create-campaign' and
  // 'create-ad' to reddit-create-campaign / reddit-create-ad in the binary —
  // both fire real spend without the universal `push` semantics).
  'create-campaign', 'create-ad',
]));

// CARDED_DESTRUCTIVE_ACTIONS gate the generic confirmation card for
// destructive non-spend writes — actions that don't fire ad dollars
// but DO send mail to real subscribers, pause/start workflows, or
// otherwise touch live customer-facing state. Before this tier
// existed, every action that wasn't in READ_ONLY_ACTIONS or
// SPEND_ACTIONS fell through to the unconditional auto-approve at the
// end of the mcp__merlin__ block in main.js. Campaign-send fired real
// emails to thousands of subscribers without a confirmation card.
//
// REGRESSION GUARD (2026-05-11, mailchimp-klaviyo-parity Gitar
// review): the Gitar reviewer flagged the auto-approve fallthrough
// as a WARN on the Mailchimp expansion PR — Mailchimp's CAN-SPAM
// gate is defense-in-depth (refuses non-compliant sends server-side)
// but does NOT replace user confirmation of "yes, send this email
// blast to 25,000 people." Adding 'campaign-send' and
// 'campaign-schedule' here means main.js shows a generic card with
// the action name + tool name so the user gets a "do you want to
// proceed?" beat. The card does NOT include budget context (no
// dollars involved) — handleToolApproval branches on
// CARDED_DESTRUCTIVE_ACTIONS BEFORE the SPEND_ACTIONS branch's
// budget machinery.
//
// Order of evaluation in main.js:
//   1. READ_ONLY → auto-approve
//   2. SPEND     → card with budget context + in-cap auto-approve
//   3. CARDED_DESTRUCTIVE → card WITHOUT budget context, no
//                            auto-approve eligibility
//   4. catch-all → auto-approve (config / voice / content / etc.)
//
// What does NOT belong here:
//   - Read-only enumerations (templates-list, automations-list, …)
//     → READ_ONLY_ACTIONS
//   - Anything that moves ad dollars
//     → SPEND_ACTIONS
//   - Idempotent setup writes a user already pre-authorized (the
//     "click a tile to connect" flow) — those auto-approve.
const CARDED_DESTRUCTIVE_ACTIONS = Object.freeze(new Set([
  // Mailchimp / Klaviyo / future-email-platform real-send actions.
  // These deliver mail to live subscriber lists and are not recoverable.
  'campaign-send', 'campaign-schedule',
  // Workflow-level pause / resume. Recoverable (the inverse action
  // exists) but a fat-fingered pause on a brand's welcome series
  // costs revenue until someone notices, so we card.
  'automation-pause', 'automation-start',
  // Postscript SMS automation (flow) writes. These mutate customer-facing
  // SMS flows — automation-create + automation-activate can flip a TCPA-gated
  // flow LIVE to real subscribers, automation-delete destroys a flow, the
  // step CRUD edits what live subscribers receive, and bulk-import-flow can
  // create + activate several flows at once. The binary runs CheckFlowTCPA
  // server-side, but per the Mailchimp precedent (rule above) that is
  // defense-in-depth, NOT a substitute for the user confirming "yes, change
  // this SMS flow." Postscript names its toggles activate/deactivate (not
  // pause/start), so without these entries every Postscript automation write
  // fell through to the catch-all auto-approve. costImpact is 'api' (no ad
  // dollars) → carded WITHOUT budget context.
  'automation-create', 'automation-update', 'automation-delete',
  'automation-activate', 'automation-deactivate',
  'automation-step-create', 'automation-step-update', 'automation-step-delete',
  'bulk-import-flow',
]));

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
  'mcp__merlin__meta_research_competitor_ads':  'competitor-scan',
  'mcp__merlin__meta_build_lookalike':          'audit',  // costImpact 'api'; non-spend
  // meta_rename_ads is a WRITE, but a reversible one that moves no money and
  // changes no delivery setting (POST /{adId} name). Routed read-only for the
  // same reason meta_pause_asset is: carding it would be pure friction.
  'mcp__merlin__meta_rename_ads':               'audit',
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
  // meta_edit_ad_link creates NO new spend — it repoints an ad that is
  // already spending at a different URL. That is still money at stake (a
  // wrong destination burns live budget exactly like a bad launch does), and
  // the host cannot verify the destination is correct, so it takes the
  // always-cards duplicate path rather than an in-cap auto-approve.
  'mcp__merlin__meta_edit_ad_link':             'duplicate',

  // Setup-style — touches ad-account state, no per-call spend
  'mcp__merlin__meta_prepare_retargeting':      'setup',
  // meta_create_custom_audience adds a custom audience to the ad account and
  // is NOT idempotent (a retry mints a second audience with the same name),
  // so it cards like the other ad-account-state writes.
  'mcp__merlin__meta_create_custom_audience':   'setup',
  // Same shape as its pixel sibling above: adds ad-account state, not
  // idempotent, no per-call spend.
  'mcp__merlin__meta_create_engagement_audience': 'setup',
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
  'mcp__merlin__meta_edit_ad_link':             'Change a live Meta ad\'s destination URL',
  'mcp__merlin__meta_create_custom_audience':   'Create a Meta custom audience',
  'mcp__merlin__meta_create_engagement_audience': 'Create a Meta Page/Instagram engagement audience',
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

// ── Auto mode: long-tail auto-approve + destructive-shell keep-list ──────
//
// The host gate (handleToolApproval in main.js) runs, in order: a hard-deny
// floor (checkHardDeny: banned ad-platform hosts, protected credential files,
// raw sockets, exfiltration), then the spend / customer-send / destructive
// card tiers, then everything else. Auto mode changes only that last "everything
// else" step: the benign long tail (WebFetch to a non-banned host, benign Bash,
// non-Merlin read tools, standard file/search ops) auto-approves instead of
// carding, because the hard-deny floor already blocked every dangerous vector
// and the tiers already carded every spend / customer-facing action. What is
// left carries no spend or credential risk, so a card there is pure friction.
//
// The single exception the user asked to keep: DESTRUCTIVE SHELL. `rm -rf` and
// its kin cause irreversible LOCAL data loss (a brand's results/ folder, a
// media cache) that checkHardDeny does NOT cover (it guards credential files,
// not arbitrary user data). That stays a "very specific approval" and cards
// even in auto mode.

// Patterns for irreversible local data loss / system-state commands. Kept
// deliberately narrow to avoid carding benign work: a bare `rm file` (no
// recursive/force flag) is allowed, `> /dev/null` is allowed, `npm run format`
// is allowed. Only genuinely destructive shapes match.
const DESTRUCTIVE_SHELL_PATTERNS = Object.freeze([
  /\brm\s+-\w*[rf]/i,                     // rm -r / -f / -rf / -fr
  /\brm\s+--(recursive|force)\b/i,        // rm --recursive / --force
  /\b(rmdir|rd)\s+\/s\b/i,                // Windows recursive dir delete
  /\bdel\s+\/[sfq]/i,                     // Windows del /s /f /q
  /\bRemove-Item\b[^\n]*-(Recurse|Force)\b/i,
  /\bgit\s+reset\s+--hard\b/i,            // discards committed + staged work
  /\bgit\s+clean\s+-\w*f/i,               // git clean -f / -fd
  /\bdd\s+if=/i,                          // raw disk write
  /\bmkfs\b/i,                            // format a filesystem
  /\bshred\b/i,                           // secure-delete
  /\btruncate\s+-s\s*0\b/i,               // zero out a file
  /:\(\)\s*\{/,                           // fork bomb :(){ :|:& };:
  />\s*\/dev\/(sd|nvme|disk|hd)/i,        // overwrite a block device
  /\b(shutdown|reboot|halt|poweroff)\b/i, // host power state
]);

/**
 * True when a Bash command is a destructive-shell shape (irreversible local
 * data loss or a host-state change). Pure over the command string.
 */
function isDestructiveShell(command) {
  const cmd = (command || '').trim();
  if (!cmd) return false;
  return DESTRUCTIVE_SHELL_PATTERNS.some((p) => p.test(cmd));
}

/**
 * Decide how the long tail of tool calls is handled AFTER checkHardDeny and the
 * spend / customer-send / destructive card tiers have already run and not
 * matched. Returns 'allow' (auto-approve, no card) or 'card' (show the generic
 * confirmation card).
 *
 * Auto mode (the product default, strictApprovals !== true): auto-approve the
 * long tail; card only destructive shell. Strict mode (strictApprovals ===
 * true): card the whole long tail, the pre-auto-mode behavior, an explicit
 * opt-in to more prompts.
 *
 * @param {{ toolName: string, command?: string, strictApprovals?: boolean }} args
 * @returns {'allow'|'card'}
 */
function classifyLongTailApproval({ toolName, command, strictApprovals }) {
  // Irreversible local data loss always cards, in either mode.
  if (toolName === 'Bash' && isDestructiveShell(command)) {
    return 'card';
  }
  if (strictApprovals) return 'card';
  return 'allow';
}

module.exports = {
  READ_ONLY_ACTIONS,
  SPEND_ACTIONS,
  CARDED_DESTRUCTIVE_ACTIONS,
  INTENT_TOOL_TO_ACTION,
  INTENT_TOOL_LABELS,
  resolveMerlinAction,
  isDestructiveShell,
  classifyLongTailApproval,
};
