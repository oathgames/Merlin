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

// ── execFile capture (for the end-to-end --cmd assertions at the bottom) ──
//
// mcp-tools destructures `const { execFile } = require('child_process')` at
// load time, so the stub has to be installed BEFORE that require. node:test
// gives each test file its own process, so this never leaks elsewhere.
const childProcess = require('child_process');
const execFileCalls = [];
childProcess.execFile = function fakeExecFile(file, args, options, callback) {
  execFileCalls.push({ file, args, options });
  const child = { stdin: { on() {}, write() {}, end() {} }, kill() {} };
  setImmediate(() => callback(null, 'ok', ''));
  return child;
};

const { buildTools, runBinary } = require('./mcp-tools');

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
    'rm -r assets/brands/brightco',
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

// ── REGRESSION GUARD (2026-09-04, engine-approval-gate-parity, merlin-core
// PR #385): three engine actions now refuse to run unless cmd.Approved is
// true — mailchimp-campaign-send, mailchimp-campaign-schedule, and
// merchant-sync-shopify. Per Hard-Won Security Rule 19 the app has to (a)
// card each of them host-side and (b) let the approved flag reach the
// engine. Two independent ways this silently breaks:
//
//   1. The action is missing from CARDED_DESTRUCTIVE_ACTIONS, so it falls
//      through main.js's catch-all auto-approve and fires with no card.
//      sync-shopify was in exactly that state: its sibling 'setup' was
//      carded via SPEND_ACTIONS while the actual catalog write was not.
//   2. The tool schema never declares `approved`, so zod strips it before
//      the handler runs and the engine refuses every call with no type
//      error anywhere (the Rule 23 failure mode).
//
// Nothing else in either repo spans the two, so these tests are the link.

test('the three engine-gated actions are all carded host-side', () => {
  // Routing is by the tool's own action value, which the handler prefixes
  // on the way to the engine (mailchimp- / merchant-).
  const gated = {
    'campaign-send': 'mailchimp-campaign-send',
    'campaign-schedule': 'mailchimp-campaign-schedule',
    'sync-shopify': 'merchant-sync-shopify',
  };
  for (const [action, engineAction] of Object.entries(gated)) {
    assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS.has(action),
      `${action} must be in CARDED_DESTRUCTIVE_ACTIONS — the engine refuses ${engineAction} without approval, and without the card the user is never asked.`);
    assert.ok(!policy.READ_ONLY_ACTIONS.has(action),
      `${action} must not be in READ_ONLY_ACTIONS — the read-only auto-approve fires first and the card never shows.`);
  }
});

test('the Bash bypass path cards merchant-sync-shopify too', () => {
  // The MCP card is one binary invocation away from being skipped: an agent
  // that knows the engine action name can call it through Bash. main.js
  // mirrors the tier in BASH_CARDED_DESTRUCTIVE for exactly that reason.
  const i = SRC_MAIN.indexOf('const BASH_CARDED_DESTRUCTIVE');
  assert.ok(i > 0, 'main.js must define BASH_CARDED_DESTRUCTIVE');
  const block = SRC_MAIN.slice(i, i + 900);
  for (const engineAction of ['mailchimp-campaign-send', 'mailchimp-campaign-schedule', 'merchant-sync-shopify']) {
    assert.ok(block.includes(`'${engineAction}'`),
      `${engineAction} must be in BASH_CARDED_DESTRUCTIVE — otherwise the Bash path fires it with no card.`);
  }
});

test('mailchimp + google_merchant declare `approved`, and never auto-set it', () => {
  const SRC_TOOLS = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');
  const blockFor = (name, next) => {
    const start = SRC_TOOLS.indexOf(`name: '${name}'`);
    assert.ok(start > 0, `${name} tool must exist`);
    const end = SRC_TOOLS.indexOf(`name: '${next}'`, start);
    return SRC_TOOLS.slice(start, end > 0 ? end : start + 14000);
  };
  for (const [name, next] of [['mailchimp', 'applovin'], ['google_merchant', 'triplewhale']]) {
    const block = blockFor(name, next);
    assert.ok(/approved:\s*z\.boolean\(\)/.test(block),
      `${name} must declare an \`approved\` boolean input — zod strips undeclared keys, so without it the flag never reaches the engine and every gated call is refused.`);
    assert.ok(!/args\.approved\s*=/.test(block),
      `${name}'s handler assigns args.approved — that bypasses the approval card the flag exists to represent.`);
  }
});

// ── End-to-end: the approved flag survives runBinary into the --cmd JSON ──

function lastCmd() {
  const call = execFileCalls[execFileCalls.length - 1];
  assert.ok(call, 'execFile must have been invoked');
  const i = call.args.indexOf('--cmd');
  assert.ok(i >= 0, '--cmd must be passed to the binary');
  return JSON.parse(call.args[i + 1]);
}

function makeBinaryCtx() {
  return {
    ...makeCtx(),
    // Any real, existing path works: execFile is stubbed, nothing is spawned.
    getBinaryPath: () => __filename,
    readConfig: () => ({ mailchimpApiKey: 'x' }),
    readBrandConfig: () => ({ mailchimpApiKey: 'x' }),
    buildStrictBrandConfig: () => ({ mailchimpApiKey: 'x' }),
    appRoot: path.join(__dirname, '..'),
  };
}

for (const engineAction of ['mailchimp-campaign-send', 'mailchimp-campaign-schedule', 'merchant-sync-shopify']) {
  test(`${engineAction} carries approved:true into the --cmd JSON`, async () => {
    execFileCalls.length = 0;
    await runBinary(makeBinaryCtx(), engineAction, {
      brand: 'acme',
      campaignId: 'abc123',
      approved: true,
    });
    const cmd = lastCmd();
    assert.equal(cmd.action, engineAction);
    assert.equal(cmd.approved, true,
      `the engine's requireApproval() gate refuses ${engineAction} unless approved reaches it as true.`);
  });
}

// ── REGRESSION GUARD (2026-09-04, engine-approval-gate-parity, merlin-core
// PR #387): four DELETE runners now refuse to run unless cmd.Approved is
// true — klaviyo-flow-delete, klaviyo-template-delete,
// mailchimp-campaign-delete and postscript-automation-delete. Same two
// silent failure modes as the send/sync block above: an action missing from
// CARDED_DESTRUCTIVE_ACTIONS fires through main.js's catch-all with no card,
// and a tool that never declares `approved` has the flag stripped by zod so
// the engine refuses every call with no error anywhere.

test('the four engine-gated deletes are all carded host-side', () => {
  const gated = {
    'flow-delete': 'klaviyo-flow-delete',
    'template-delete': 'klaviyo-template-delete',
    'campaign-delete': 'mailchimp-campaign-delete',
    'automation-delete': 'postscript-automation-delete',
  };
  for (const [action, engineAction] of Object.entries(gated)) {
    assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS.has(action),
      `${action} must be in CARDED_DESTRUCTIVE_ACTIONS — the engine refuses ${engineAction} without approval, and without the card the user is never asked.`);
    assert.ok(!policy.READ_ONLY_ACTIONS.has(action),
      `${action} must not be in READ_ONLY_ACTIONS — the read-only auto-approve fires first and the card never shows.`);
    assert.ok(!policy.SPEND_ACTIONS.has(action),
      `${action} must not be in SPEND_ACTIONS — a delete has no budget context to show.`);
  }
});

test('the Bash bypass path cards the four engine-gated deletes', () => {
  const i = SRC_MAIN.indexOf('const BASH_CARDED_DESTRUCTIVE');
  assert.ok(i > 0, 'main.js must define BASH_CARDED_DESTRUCTIVE');
  const block = SRC_MAIN.slice(i, i + 1600);
  for (const engineAction of [
    'klaviyo-flow-delete', 'klaviyo-template-delete',
    'mailchimp-campaign-delete', 'postscript-automation-delete',
  ]) {
    assert.ok(block.includes(`'${engineAction}'`),
      `${engineAction} must be in BASH_CARDED_DESTRUCTIVE — otherwise the Bash path fires it with no card.`);
  }
});

test('klaviyo + postscript declare `approved`, and never auto-set it', () => {
  const SRC_TOOLS = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');
  const blockFor = (name, next) => {
    const start = SRC_TOOLS.indexOf(`name: '${name}'`);
    assert.ok(start > 0, `${name} tool must exist`);
    const end = SRC_TOOLS.indexOf(`name: '${next}'`, start);
    return SRC_TOOLS.slice(start, end > 0 ? end : start + 14000);
  };
  for (const [name, next] of [['klaviyo', 'mailchimp'], ['postscript', 'clarity']]) {
    const block = blockFor(name, next);
    assert.ok(/approved:\s*z\.boolean\(\)/.test(block),
      `${name} must declare an \`approved\` boolean input — zod strips undeclared keys, so without it the flag never reaches the engine and every gated delete is refused.`);
    assert.ok(!/args\.approved\s*=/.test(block),
      `${name}'s handler assigns args.approved — that bypasses the approval card the flag exists to represent.`);
  }
});

test('every engine-gated delete has a plain-English approval card label', () => {
  // The generic fallback reads "klaviyo — flow-delete". A paying user must
  // be told an asset is about to be destroyed with no undo.
  for (const engineAction of [
    'klaviyo-flow-delete', 'klaviyo-template-delete',
    'mailchimp-campaign-delete', 'postscript-automation-delete',
  ]) {
    assert.ok(SRC_MAIN.includes(`'${engineAction}':`) || SRC_MAIN.includes(`'${engineAction}':   `),
      `main.js must translate ${engineAction} into a friendly Bash-path card label.`);
  }
  for (const marker of [
    "'flow-delete':",
    "'template-delete':",
    "'campaign-delete':",
    "mcp__merlin__postscript' && input && input.action === 'automation-delete'",
  ]) {
    assert.ok(SRC_MAIN.includes(marker),
      `main.js must translate the MCP-path action ${marker} into a friendly card label.`);
  }
});

for (const engineAction of [
  'klaviyo-flow-delete', 'klaviyo-template-delete',
  'mailchimp-campaign-delete', 'postscript-automation-delete',
]) {
  test(`${engineAction} carries approved:true into the --cmd JSON`, async () => {
    execFileCalls.length = 0;
    await runBinary(makeBinaryCtx(), engineAction, {
      brand: 'acme',
      flowId: 'F1',
      templateId: 'T1',
      campaignId: 'C1',
      automationId: 'A1',
      approved: true,
    });
    const cmd = lastCmd();
    assert.equal(cmd.action, engineAction);
    assert.equal(cmd.approved, true,
      `the engine's requireApproval() gate refuses ${engineAction} unless approved reaches it as true.`);
  });
}

// ── Contract N (2026-07-10, audit P0-02): no live-spend / customer-facing
//    write may auto-approve. main.js's approval path consults ONLY the three
//    action sets, so any dangerous action absent from SPEND ∪ CARDED falls
//    through to the catch-all auto-approve (the legacy meta_ads multiplexer
//    fail-open). This locks the exact class Codex flagged. ─────────────────

// DANGEROUS_ACTIONS: every action string that fires real ad spend OR mutates
// live customer-facing state. Each MUST resolve to a card (SPEND or CARDED),
// never the catch-all auto-approve. Adding a new spend/live-write action
// without adding it here is the regression this catches.
const DANGEROUS_ACTIONS = [
  // Legacy meta_ads multiplexer spend verbs (the P0-02 fail-open) + linkedin.
  'activate', 'retarget', 'budget', 'bulk-push', 'lockdown',
  // Universal spend verbs.
  'push', 'duplicate', 'kill', 'setup', 'setup-retargeting',
  'create-campaign', 'create-ad',
  // Email/SMS live sends + destructive structural writes.
  'campaign-send', 'campaign-schedule', 'campaign-delete',
  'segment-create', 'flow-update-status', 'flow-delete', 'flows-bulk-import',
  'template-delete', 'bulk-import-flow',
  'automation-pause', 'automation-start', 'automation-activate',
  'automation-deactivate', 'automation-delete',
  // Live social channel posts.
  'post',
  // Live product-catalog push to Google Merchant.
  'sync-shopify',
  // GA4 Admin writes (also fail-closed server-side; carded for the human gate).
  'create-key-event', 'archive-key-event', 'create-custom-dimension',
  'create-custom-metric', 'create-audience', 'update-property-settings',
  'update-stream-settings', 'attach-shopify-events',
];

test('P0-02: no dangerous action can auto-approve (every one is in SPEND ∪ CARDED)', () => {
  const carded = new Set([...policy.SPEND_ACTIONS, ...policy.CARDED_DESTRUCTIVE_ACTIONS]);
  const leaked = DANGEROUS_ACTIONS.filter((a) => !carded.has(a));
  assert.deepEqual(leaked, [],
    `these live-spend / customer-facing actions AUTO-APPROVE (fall through main.js's catch-all); add each to SPEND_ACTIONS or CARDED_DESTRUCTIVE_ACTIONS: ${leaked.join(', ')}`);
});

test('P0-02: the specific Codex-reported fail-opens are carded', () => {
  // Regression pins for the exact actions the 2026-07-10 audit named.
  for (const a of ['activate', 'budget', 'bulk-push', 'retarget']) {
    assert.ok(policy.SPEND_ACTIONS.has(a), `meta_ads '${a}' must be a SPEND action (fires real ad dollars)`);
  }
  assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS.has('segment-create'),
    "klaviyo 'segment-create' must be carded (creates live audience targeting)");
  assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS.has('post'),
    "discord/slack 'post' must be carded (live channel message)");
});

test('P0-02: the false "carded via destructive-tool default" comment is gone', () => {
  // main.js AUTO-APPROVES anything not in the three sets; there is no
  // destructive-tool default. The old comment asserted a protection that
  // did not exist. It must not come back.
  const SRC = fs.readFileSync(path.join(__dirname, 'mcp-approval-policy.js'), 'utf8');
  assert.ok(!/carded via the destructive-tool default/.test(SRC),
    'the false "destructive-tool default" claim must not reappear; there is no such default');
});

test('P0-02: every dangerous action really exists in a tool schema (no dead entries)', () => {
  // Guard against carding phantom actions: each DANGEROUS_ACTIONS entry must
  // appear as a quoted action string somewhere in the tool schemas, so this
  // list stays honest as tools evolve.
  const SRC = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');
  const missing = DANGEROUS_ACTIONS.filter((a) => !SRC.includes(`'${a}'`));
  assert.deepEqual(missing, [],
    `these carded actions are not present in any tool schema (stale entries): ${missing.join(', ')}`);
});

// ── Contract O (2026-09-04): an engine action gated by requireApproval is
//    DEAD unless three things ship together: an `approved` key in the tool
//    schema (zod strips undeclared keys), an entry in
//    CARDED_DESTRUCTIVE_ACTIONS (the card that legitimately produces the
//    flag), and an entry in BASH_CARDED_DESTRUCTIVE (so the card is not one
//    binary invocation away from being skipped). Two actions shipped with
//    none of the three:
//
//      quiz-funnel-gen  (quiz_funnel.go:runQuizFunnelGen):  always fatal.
//      resume-all-spend (spend_pause.go:runResumeAllSpend): always fatal,
//        AND it is the only thing that lifts the master spend pause, so the
//        gap was a one-way door: pause with no way back. ─────────────────

test('quiz-funnel-gen is carded host-side and not swallowed by another tier', () => {
  assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS.has('quiz-funnel-gen'),
    'the engine refuses quiz-funnel-gen without approval; without the card the user is never asked and every call fatals.');
  assert.ok(!policy.READ_ONLY_ACTIONS.has('quiz-funnel-gen'),
    'read-only auto-approve fires first and the card would never show.');
  assert.ok(!policy.SPEND_ACTIONS.has('quiz-funnel-gen'),
    'quiz generation moves no ad dollars, so there is no budget context to render.');
});

test('spend_control resume-all is carded, and pause-all deliberately is NOT', () => {
  assert.ok(policy.CARDED_DESTRUCTIVE_ACTIONS.has('resume-all'),
    'resume-all-spend is requireApproval-gated in the engine and re-arms every spend path for the brand.');
  assert.ok(!policy.CARDED_DESTRUCTIVE_ACTIONS.has('pause-all'),
    'pause-all is the emergency brake; a brake that asks permission is not a brake.');
  assert.ok(!policy.SPEND_ACTIONS.has('pause-all') && !policy.SPEND_ACTIONS.has('resume-all'),
    'neither action creates spend directly, so neither belongs in the budget-context tier.');
});

test('the Bash bypass path cards quiz-funnel-gen and resume-all-spend', () => {
  const i = SRC_MAIN.indexOf('const BASH_CARDED_DESTRUCTIVE');
  assert.ok(i > 0, 'main.js must define BASH_CARDED_DESTRUCTIVE');
  const block = SRC_MAIN.slice(i, i + 2600);
  for (const engineAction of ['quiz-funnel-gen', 'resume-all-spend']) {
    assert.ok(block.includes(`'${engineAction}'`),
      `${engineAction} must be in BASH_CARDED_DESTRUCTIVE , otherwise the Bash path fires it with no card.`);
  }
});

test('quiz-funnel-gen and resume-all-spend have plain-English card labels', () => {
  for (const engineAction of ['quiz-funnel-gen', 'resume-all-spend', 'pause-all-spend']) {
    assert.ok(SRC_MAIN.includes(`'${engineAction}':`),
      `main.js must translate ${engineAction} into a friendly card label rather than the generic tool-and-action fallback.`);
  }
  // The label must read as impact, not as a dev-facing action name.
  assert.match(SRC_MAIN, /Turn Merlin ad spend back on for this brand/);
  assert.match(SRC_MAIN, /Generate a quiz funnel landing page for this brand/);
});

test('content + spend_control declare `approved`, and never auto-set it', () => {
  const SRC_TOOLS = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');
  const blockFor = (name, next) => {
    const start = SRC_TOOLS.indexOf(`name: '${name}'`);
    assert.ok(start > 0, `${name} tool must exist`);
    const end = SRC_TOOLS.indexOf(`name: '${next}'`, start);
    return SRC_TOOLS.slice(start, end > 0 ? end : start + 20000);
  };
  for (const [name, next] of [['content', 'video'], ['spend_control', 'jobs_poll']]) {
    const block = blockFor(name, next);
    assert.ok(/approved:\s*z\.boolean\(\)/.test(block),
      `${name} must declare an \`approved\` boolean input , zod strips undeclared keys, so without it the flag never reaches the engine and the gated action is refused on every call.`);
    assert.ok(!/args\.approved\s*=/.test(block),
      `${name}'s handler assigns args.approved , that bypasses the approval card the flag exists to represent.`);
  }
});

test('spend_control is registered and exposes BOTH halves of the kill switch', () => {
  const registry = buildRegistry();
  const t = registry.find((x) => x.name === 'spend_control');
  assert.ok(t, 'spend_control must be registered , resume-all-spend had no MCP route at all (Rule 23, both directions).');
  const SRC_TOOLS = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');
  const start = SRC_TOOLS.indexOf("name: 'spend_control'");
  const block = SRC_TOOLS.slice(start, start + 4000);
  assert.ok(block.includes("'pause-all'") && block.includes("'resume-all'"),
    'exposing pause without resume is the one-way door this fixes.');
  assert.ok(block.includes("'pause-all-spend'") && block.includes("'resume-all-spend'"),
    'both engine action names must be routed to; a route to an action that does not exist is the mirror-image Rule 23 bug.');
});

test('quiz-funnel-gen carries approved:true into the --cmd JSON', async () => {
  execFileCalls.length = 0;
  await runBinary(makeBinaryCtx(), 'quiz-funnel-gen', {
    brand: 'acme',
    approved: true,
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'quiz-funnel-gen');
  assert.equal(cmd.approved, true,
    "the engine's requireApproval() gate refuses quiz-funnel-gen unless approved reaches it as true.");
});

test('spend_control resume-all sends approved:true, and pause-all never does', async () => {
  // The registered handler closes over the ctx buildRegistry supplied, whose
  // getBinaryPath is a fake path, so the wire assertions go through runBinary
  // directly; the registration itself is pinned by the test above.
  execFileCalls.length = 0;
  await runBinary(makeBinaryCtx(), 'resume-all-spend', { brand: 'acme', approved: true });
  let cmd = lastCmd();
  assert.equal(cmd.action, 'resume-all-spend');
  assert.equal(cmd.approved, true);

  execFileCalls.length = 0;
  await runBinary(makeBinaryCtx(), 'pause-all-spend', { brand: 'acme', slackMessage: 'runaway CPA' });
  cmd = lastCmd();
  assert.equal(cmd.action, 'pause-all-spend');
  assert.equal(cmd.approved, undefined,
    'pausing must never require or carry an approval flag , the engine deliberately does not gate it.');
  assert.equal(cmd.slackMessage, 'runaway CPA',
    'the operator pause note is read from cmd.SlackMessage by the engine; dropping it silently is the Rule 23 param half.');
});
