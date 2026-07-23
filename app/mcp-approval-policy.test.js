// REGRESSION GUARD (2026-05-02, codex-spend-approval-bypass)
//
// This test exists because, prior to 2026-05-02, every Meta intent tool
// (mcp-meta-intent.js — `meta_launch_test_ad`, `meta_promote_to_retargeting`,
// `meta_scale_winner`, …) bypassed the host-side spend approval card. Root
// cause: `handleToolApproval` in main.js routed the `mcp__merlin__*` branch
// by inspecting `input.action`, which the legacy multiplexer tools carry
// (action: 'push'/'duplicate'/etc.) but intent-style tools do NOT. Without
// a tool-name → action mapping, intent tools fell through to the
// unconditional auto-approve at the bottom of the branch — letting the
// agent fire real ad spend without the user-visible approval card.
//
// Three contracts pinned here:
//
//   1. `resolveMerlinAction` returns the right effective action for every
//      currently-registered intent tool, plus the right label override.
//
//   2. Cross-check: every tool registered via `defineTool({ costImpact:
//      'spend', ... })` MUST map to a SPEND-set action ('push' or
//      'duplicate'). This catches the case where a future intent tool ships
//      with `costImpact: 'spend'` but the author forgets to add it to
//      INTENT_TOOL_TO_ACTION — that tool would otherwise re-introduce the
//      original bypass.
//
//   3. Source-scan main.js to confirm the gate uses the policy module's
//      action sets and resolver — not inline copies that could drift away
//      from the policy file's source of truth.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policy = require('./mcp-approval-policy');
const { buildTools } = require('./mcp-tools');

const SRC_MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// ── Fakes (mirrors mcp-meta-intent.test.js) ───────────────────────────

function makeFakeTool() {
  const registry = [];
  const tool = (name, description, schema, handler, options) => {
    registry.push({ name, description, schema, handler, options });
    return { name };
  };
  return { tool, registry };
}

function makeFakeZ() {
  const chain = () => ({
    optional: () => chain(), describe: () => chain(), default: () => chain(),
    regex: () => chain(), int: () => chain(),
  });
  return {
    string: () => chain(), number: () => chain(), boolean: () => chain(),
    any: () => chain(), enum: () => chain(),
    coerce: { number: () => chain() }, array: () => chain(),
    object: () => chain(), record: () => chain(),
  };
}

function makeCtx() {
  return {
    getConnections: () => [],
    readConfig: () => ({}),
    readBrandConfig: () => ({}),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => '/fake/binary',
    appRoot: process.cwd(),
    isBinaryTooOld: () => false,
    runOAuthFlow: async () => ({ success: true }),
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
  };
}

function buildRegistry() {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  return registry;
}

// ── Contract 1: resolveMerlinAction routing ──────────────────────────

test('resolveMerlinAction passes through input.action for legacy multiplexer tools', () => {
  for (const action of ['insights', 'push', 'duplicate', 'audit', 'discover']) {
    const out = policy.resolveMerlinAction('mcp__merlin__meta_ads', { action });
    assert.equal(out.effectiveAction, action, `legacy meta_ads action=${action} must pass through`);
    assert.equal(out.label, null, 'legacy multiplexer never overrides label');
  }
});

test('resolveMerlinAction routes meta_launch_test_ad to push (in-cap auto-approve eligible)', () => {
  const out = policy.resolveMerlinAction('mcp__merlin__meta_launch_test_ad', {
    brand: 'acme', adImagePath: '/x.png', dailyBudget: 5,
    adHeadline: 'h', adBody: 'b', adLink: 'https://x',
  });
  assert.equal(out.effectiveAction, 'push');
  assert.equal(out.label, 'Publish this Meta test ad');
});

test('resolveMerlinAction routes the always-card spend intents to duplicate', () => {
  const cardingIntents = [
    'mcp__merlin__meta_launch_test_batch',
    'mcp__merlin__meta_promote_to_retargeting',
    'mcp__merlin__meta_activate_asset',
    'mcp__merlin__meta_scale_winner',
    'mcp__merlin__meta_adjust_budget',
  ];
  for (const name of cardingIntents) {
    const out = policy.resolveMerlinAction(name, { brand: 'acme' });
    assert.equal(out.effectiveAction, 'duplicate', `${name} must always card via 'duplicate'`);
    assert.ok(out.label, `${name} must override the card label`);
  }
});

test('resolveMerlinAction routes meta_prepare_retargeting to setup', () => {
  const out = policy.resolveMerlinAction('mcp__merlin__meta_prepare_retargeting', { brand: 'acme' });
  assert.equal(out.effectiveAction, 'setup');
});

test('resolveMerlinAction routes read-only intents into READ_ONLY_ACTIONS', () => {
  const readOnlyIntents = [
    'mcp__merlin__meta_setup_account',
    'mcp__merlin__meta_review_performance',
    'mcp__merlin__meta_audit',
    'mcp__merlin__meta_import_account_state',
    'mcp__merlin__meta_research_competitor_ads',
    'mcp__merlin__meta_build_lookalike',
    'mcp__merlin__meta_pause_asset',
  ];
  for (const name of readOnlyIntents) {
    const out = policy.resolveMerlinAction(name, { brand: 'acme' });
    assert.ok(
      policy.READ_ONLY_ACTIONS.has(out.effectiveAction),
      `${name} → '${out.effectiveAction}' must be in READ_ONLY_ACTIONS`
    );
  }
});

test('resolveMerlinAction returns empty effectiveAction for unmapped intent tools', () => {
  // Unknown tool with no `input.action` → empty string (falls through to
  // the catch-all auto-approve in main.js, matching pre-fix behavior for
  // tools that were never spend-firing in the first place).
  const out = policy.resolveMerlinAction('mcp__merlin__future_unmapped_tool', {});
  assert.equal(out.effectiveAction, '');
  assert.equal(out.label, null);
});

test('input.action wins over the intent-tool map (legacy + intent overlap is impossible)', () => {
  // Defense-in-depth: if a tool somehow carries both a tool-name match
  // AND an action field, the explicit action wins. (This shouldn't happen
  // in practice — intent tools have no `action` schema field — but the
  // contract removes any room for confusion.)
  const out = policy.resolveMerlinAction('mcp__merlin__meta_launch_test_ad', { action: 'insights' });
  assert.equal(out.effectiveAction, 'insights');
  assert.equal(out.label, null);
});

// ── Contract 2: Cross-check against the actual intent-tool registry ──

test('every spend-firing intent tool maps to a SPEND_ACTIONS member', () => {
  // Build the real registry the same way mcp-meta-intent.test.js does, then
  // walk every tool with costImpact:'spend' and assert it appears in
  // INTENT_TOOL_TO_ACTION mapped to a SPEND-routed action.
  //
  // This is the load-bearing test: it catches the case where a future
  // intent tool (meta_X, tiktok_X, …) ships with `costImpact: 'spend'` but
  // its author forgets to update mcp-approval-policy.js. The legacy
  // multiplexer tools (meta_ads, tiktok_ads, …) ALSO have
  // `costImpact: 'spend'` but they route via `input.action` — they're
  // exempted via the `tool-name has no action schema` heuristic below.
  const registry = buildRegistry();

  const intentToolNames = new Set();
  for (const entry of registry) {
    const ann = entry.options && entry.options.annotations;
    if (!ann || ann.costImpact !== 'spend') continue;

    // Skip legacy multiplexer tools — they declare an `action` enum on
    // their input schema and route via `input.action`.
    // entry.schema is the enriched shape object (defineTool calls
    // tool(name, description, shape, wrapped, options) where shape is the
    // plain-object map of field name → Zod descriptor). Multiplexer tools
    // declare `action` directly in their input schema; intent tools never do.
    if (entry.schema && Object.prototype.hasOwnProperty.call(entry.schema, 'action')) continue;

    intentToolNames.add(entry.name);
  }

  assert.ok(
    intentToolNames.size > 0,
    'No spend-firing intent tools found in the registry — test fixture broken'
  );

  for (const name of intentToolNames) {
    const fullName = `mcp__merlin__${name}`;
    const mapped = policy.INTENT_TOOL_TO_ACTION[fullName];
    assert.ok(
      mapped,
      `Spend intent tool ${fullName} is not mapped in INTENT_TOOL_TO_ACTION — adding it would re-introduce the spend-bypass.`
    );
    assert.ok(
      policy.SPEND_ACTIONS.has(mapped),
      `Spend intent tool ${fullName} maps to '${mapped}', which is NOT in SPEND_ACTIONS — the approval card will not fire.`
    );
  }
});

test('non-destructive intent tools never map to SPEND_ACTIONS (cards on reads = bad UX)', () => {
  // What we DON'T want is a pure-read intent tool accidentally mapped to a
  // SPEND action — that would card the user on every status fetch.
  //
  // Note: destructive but non-spend tools (e.g. `meta_prepare_retargeting`,
  // costImpact: 'api') legitimately map to 'setup' or 'setup-retargeting'
  // because they touch ad-account state. The legacy multiplexer treats
  // `meta_ads action='setup'` the same way. So this assertion is gated on
  // destructive:false specifically — a true read-only tool should never
  // hit the approval card.
  const registry = buildRegistry();

  for (const entry of registry) {
    const ann = entry.options && entry.options.annotations;
    if (!ann) continue;
    if (ann.destructive === true) continue;
    // Skip legacy multiplexers — same heuristic as above.
    if (entry.schema && Object.prototype.hasOwnProperty.call(entry.schema, 'action')) continue;

    const fullName = `mcp__merlin__${entry.name}`;
    const mapped = policy.INTENT_TOOL_TO_ACTION[fullName];
    if (!mapped) continue; // unmapped is fine — falls through to auto-approve
    assert.ok(
      !policy.SPEND_ACTIONS.has(mapped),
      `Non-destructive intent tool ${fullName} maps to '${mapped}' which is in SPEND_ACTIONS — would card every read.`
    );
  }
});

// ── Contract 3: main.js source-scan ──────────────────────────────────

test('main.js handleToolApproval imports mcp-approval-policy', () => {
  assert.match(
    SRC_MAIN,
    /require\(['"]\.\/mcp-approval-policy['"]\)/,
    'main.js must require ./mcp-approval-policy — otherwise the gate is using a stale inline copy'
  );
});

test('main.js calls resolveMerlinAction in the mcp__merlin__ branch', () => {
  assert.match(
    SRC_MAIN,
    /approvalPolicy\.resolveMerlinAction\s*\(\s*toolName\s*,\s*input\s*\)/,
    'main.js must call approvalPolicy.resolveMerlinAction(toolName, input) — otherwise intent tools bypass routing'
  );
});

test('main.js no longer carries the inline READ_ONLY action set', () => {
  // The inline `const READ_ONLY = new Set([...])` in handleToolApproval was
  // the source-of-truth pre-fix. Keeping it alongside the policy module is
  // a drift trap (one file gets a new action, the other doesn't). Ensure
  // the inline declaration is gone — main.js must reference
  // approvalPolicy.READ_ONLY_ACTIONS instead.
  assert.doesNotMatch(
    SRC_MAIN,
    /const\s+READ_ONLY\s*=\s*new\s+Set\(/,
    'main.js still has an inline READ_ONLY set — delete it; use approvalPolicy.READ_ONLY_ACTIONS'
  );
  assert.match(
    SRC_MAIN,
    /approvalPolicy\.READ_ONLY_ACTIONS/,
    'main.js must reference approvalPolicy.READ_ONLY_ACTIONS in the gate logic'
  );
});

test('main.js no longer carries the inline SPEND action set', () => {
  // Same drift hazard as READ_ONLY. The inline `const SPEND = new Set([...])`
  // must be replaced by approvalPolicy.SPEND_ACTIONS.
  assert.doesNotMatch(
    SRC_MAIN,
    /const\s+SPEND\s*=\s*new\s+Set\(/,
    'main.js still has an inline SPEND set — delete it; use approvalPolicy.SPEND_ACTIONS'
  );
  assert.match(
    SRC_MAIN,
    /approvalPolicy\.SPEND_ACTIONS/,
    'main.js must reference approvalPolicy.SPEND_ACTIONS in the gate logic'
  );
});

// ── Contract 4: INTENT_TOOL_TO_ACTION ↔ INTENT_TOOL_LABELS parity (D002) ──
//
// REGRESSION GUARD (2026-05-10, D002): the two maps are independently
// authored and silently drift — adding a new intent tool to one but not the
// other is a class of bug that ships a correctly-routed call with a generic
// "Publish this ad" label, OR a labelled card with no routing (falls
// through to auto-approve). The parity test catches both directions.

test('every key in INTENT_TOOL_TO_ACTION has a matching INTENT_TOOL_LABELS entry (or is read-only)', () => {
  // Read-only intents intentionally have no label override (they auto-approve
  // via READ_ONLY_ACTIONS without ever drawing a card). Every SPEND or SETUP
  // mapped tool MUST have a label override — otherwise the card text is the
  // generic action verb.
  for (const [toolName, action] of Object.entries(policy.INTENT_TOOL_TO_ACTION)) {
    const isReadOnly = policy.READ_ONLY_ACTIONS.has(action);
    if (isReadOnly) continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(policy.INTENT_TOOL_LABELS, toolName),
      `${toolName} → '${action}' (carding action) is missing a INTENT_TOOL_LABELS entry — the approval card will use the generic verb.`
    );
  }
});

test('every key in INTENT_TOOL_LABELS has a matching INTENT_TOOL_TO_ACTION entry', () => {
  // The reverse direction: a label without a routing entry is dead weight —
  // the label override path in main.js never fires because resolveMerlinAction
  // returns label:null for unmapped tools.
  for (const toolName of Object.keys(policy.INTENT_TOOL_LABELS)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(policy.INTENT_TOOL_TO_ACTION, toolName),
      `${toolName} is in INTENT_TOOL_LABELS but missing from INTENT_TOOL_TO_ACTION — the label is unreachable.`
    );
  }
});

test('main.js threads intentToolLabel through the approval-card payload', () => {
  // Without the label override, the card reads "Scale this winning ad" for
  // a `meta_launch_test_batch` of 50 ads — confusing UX. Pin the override
  // so a future refactor doesn't drop the per-tool label and silently
  // regress the card text.
  assert.match(
    SRC_MAIN,
    /if\s*\(\s*intentToolLabel\s*\)/,
    'main.js must override translated.label with intentToolLabel for intent tools'
  );
});

// REGRESSION GUARD (2026-05-11, mailchimp-klaviyo-parity Gitar review):
// CARDED_DESTRUCTIVE_ACTIONS is the third approval tier — destructive
// non-spend writes that must show a card before firing. Before this
// tier existed, the mcp__merlin__ block in main.js had a binary
// READ_ONLY-vs-SPEND switch with everything-else auto-approving, so
// mailchimp-campaign-send fired real email blasts to thousands of
// subscribers without a user confirmation. The tests below pin:
//   1. The set is exported and non-empty.
//   2. campaign-send + campaign-schedule are in it (the load-bearing
//      Mailchimp cases — sending to a real audience is not recoverable).
//   3. main.js wires the set BEFORE the catch-all auto-approve.
//   4. No member of CARDED_DESTRUCTIVE_ACTIONS is also in READ_ONLY
//      (would silently override the card) or in SPEND (would route
//      through the budget-context path with no budget context, which
//      is misleading rather than wrong).

test('CARDED_DESTRUCTIVE_ACTIONS is exported and non-empty', () => {
  assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS instanceof Set,
    'CARDED_DESTRUCTIVE_ACTIONS must be a Set');
  assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS.size >= 2,
    'CARDED_DESTRUCTIVE_ACTIONS must have at least 2 entries (campaign-send + campaign-schedule)');
});

test('CARDED_DESTRUCTIVE_ACTIONS includes campaign-send + campaign-schedule', () => {
  assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS.has('campaign-send'),
    'campaign-send must be carded — fires real email blasts to live subscriber lists');
  assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS.has('campaign-schedule'),
    'campaign-schedule must be carded — queues a real email blast');
});

// REGRESSION GUARD (2026-06-XX, connector-hardening): Postscript names its
// automation toggles activate/deactivate (NOT pause/start), and its flow CRUD
// + bulk import are genuinely state-mutating SMS writes that can flip a
// TCPA-gated flow LIVE to real subscribers. Pre-fix only campaign-send/-schedule
// and the Klaviyo-style pause/start were carded, so every Postscript automation
// write fell through main.js's catch-all auto-approve and fired without a card.
test('CARDED_DESTRUCTIVE_ACTIONS covers Postscript automation writes', () => {
  const required = [
    'automation-create', 'automation-update', 'automation-delete',
    'automation-activate', 'automation-deactivate',
    'automation-step-create', 'automation-step-update', 'automation-step-delete',
    'bulk-import-flow',
  ];
  for (const action of required) {
    assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS.has(action),
      `${action} must be carded — it mutates a customer-facing SMS flow (Postscript). Without it, the action auto-approves with no confirmation.`);
  }
});

test('CARDED_DESTRUCTIVE_ACTIONS does not overlap READ_ONLY_ACTIONS', () => {
  // Overlap would mean the READ_ONLY auto-approve fires first and the
  // card never shows.
  for (const action of policy.CARDED_DESTRUCTIVE_ACTIONS) {
    assert.ok(!policy.READ_ONLY_ACTIONS.has(action),
      `${action} is in BOTH CARDED_DESTRUCTIVE_ACTIONS and READ_ONLY_ACTIONS — the read-only check fires first, so the card never shows. Remove from one set.`);
  }
});

test('CARDED_DESTRUCTIVE_ACTIONS does not overlap SPEND_ACTIONS', () => {
  // Overlap would route through the budget-context card path with no
  // budget context — confusing UX. Pick one path per action.
  for (const action of policy.CARDED_DESTRUCTIVE_ACTIONS) {
    assert.ok(!policy.SPEND_ACTIONS.has(action),
      `${action} is in BOTH CARDED_DESTRUCTIVE_ACTIONS and SPEND_ACTIONS — these have incompatible UX (budget card vs generic card). Pick one.`);
  }
});

test('main.js handleToolApproval wires CARDED_DESTRUCTIVE_ACTIONS BEFORE the catch-all auto-approve', () => {
  // Source-scan: the CARDED_DESTRUCTIVE_ACTIONS branch must appear
  // BEFORE the comment "All other MCP merlin tools: auto-approve"
  // otherwise the catch-all would fire first and the card path is
  // unreachable.
  const cardedIdx = SRC_MAIN.indexOf('CARDED_DESTRUCTIVE_ACTIONS.has(action)');
  assert.ok(cardedIdx > 0,
    'main.js must check approvalPolicy.CARDED_DESTRUCTIVE_ACTIONS in handleToolApproval');
  const catchAllIdx = SRC_MAIN.indexOf('All other MCP merlin tools: auto-approve');
  assert.ok(catchAllIdx > 0, 'catch-all auto-approve comment must exist');
  assert.ok(cardedIdx < catchAllIdx,
    'CARDED_DESTRUCTIVE_ACTIONS branch must precede the catch-all auto-approve — otherwise the card never shows');
});

// ── Auto mode: long-tail auto-approve + destructive-shell keep-list ──────
//
// The user asked Merlin to stop asking for permission so often: auto-approve
// the benign long tail (WebFetch to a non-banned host, benign Bash, non-Merlin
// tools) and keep a card only for the "very specific approvals" (ad spend,
// customer sends, destructive actions). checkHardDeny + the spend/send/
// destructive tiers still run first; these tests pin the new last step.

test('isDestructiveShell flags irreversible local data loss + system-state commands', () => {
  const destructive = [
    'rm -rf results/',
    'rm -r assets/brands/madchill',
    'sudo rm -fr /',
    'rm --recursive foo',
    'del /s /q C:\\\\Merlin\\\\results',
    'rmdir /s bar',
    'Remove-Item results -Recurse -Force',
    'git reset --hard HEAD~3',
    'git clean -fd',
    'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sdb1',
    'shred -u secret.txt',
    'truncate -s 0 ledger.json',
    ':(){ :|:& };:',
    'echo boom > /dev/sda',
    'shutdown -h now',
    'reboot',
  ];
  for (const cmd of destructive) {
    assert.equal(policy.isDestructiveShell(cmd), true, `should flag: ${cmd}`);
  }
});

test('isDestructiveShell does NOT flag benign commands', () => {
  const benign = [
    'ls -la',
    'cat README.md',
    'git status',
    'git log --oneline -5',
    'git commit -m "x"',
    'npm install',
    'npm run format',
    'node scripts/build.js',
    'python3 tool.py',
    'grep -r foo .',
    'rm foo.txt',            // single-file delete, no -r/-f flag → allowed
    'echo hi > /dev/null',   // /dev/null is not a block device
    'mkdir -p results/new',
    'cp a b',
    'performance-report.sh', // must not trip the \brm heuristic
  ];
  for (const cmd of benign) {
    assert.equal(policy.isDestructiveShell(cmd), false, `should NOT flag: ${cmd}`);
  }
  assert.equal(policy.isDestructiveShell(''), false);
  assert.equal(policy.isDestructiveShell(undefined), false);
});

test('classifyLongTailApproval auto-approves the benign long tail in auto mode', () => {
  const auto = { strictApprovals: false };
  assert.equal(policy.classifyLongTailApproval({ toolName: 'WebFetch', ...auto }), 'allow');
  assert.equal(policy.classifyLongTailApproval({ toolName: 'Bash', command: 'git status', ...auto }), 'allow');
  assert.equal(policy.classifyLongTailApproval({ toolName: 'Bash', command: 'cat brand.md', ...auto }), 'allow');
  assert.equal(policy.classifyLongTailApproval({ toolName: 'mcp__other__read_thing', ...auto }), 'allow');
  // Missing strictApprovals field (undefined) defaults to auto mode.
  assert.equal(policy.classifyLongTailApproval({ toolName: 'WebFetch' }), 'allow');
});

test('classifyLongTailApproval always cards destructive shell, even in auto mode', () => {
  assert.equal(
    policy.classifyLongTailApproval({ toolName: 'Bash', command: 'rm -rf results/', strictApprovals: false }),
    'card');
  assert.equal(
    policy.classifyLongTailApproval({ toolName: 'Bash', command: 'git reset --hard', strictApprovals: false }),
    'card');
});

test('classifyLongTailApproval cards the whole long tail in strict mode', () => {
  const strict = { strictApprovals: true };
  assert.equal(policy.classifyLongTailApproval({ toolName: 'WebFetch', ...strict }), 'card');
  assert.equal(policy.classifyLongTailApproval({ toolName: 'Bash', command: 'git status', ...strict }), 'card');
  assert.equal(policy.classifyLongTailApproval({ toolName: 'mcp__other__read_thing', ...strict }), 'card');
});

test('main.js wires the auto-mode long-tail decision at the final fallthrough', () => {
  // Source-scan: the final catch-all must route through the policy module's
  // classifyLongTailApproval + read strictApprovals, and auto-approve on
  // 'allow'. A future edit that reverts to always-carding (or always-allowing
  // without the destructive-shell card) breaks this guard.
  assert.match(SRC_MAIN, /classifyLongTailApproval\s*\(/,
    'main.js must call approvalPolicy.classifyLongTailApproval at the fallthrough');
  assert.match(SRC_MAIN, /strictApprovals/,
    'main.js must read the strictApprovals config flag');
  assert.match(SRC_MAIN, /longTailDecision\s*===\s*'allow'/,
    "main.js must auto-approve when the long-tail decision is 'allow'");
  assert.match(SRC_MAIN, /isDestructiveShell/,
    'main.js must still surface a destructive-shell card via isDestructiveShell');
});
