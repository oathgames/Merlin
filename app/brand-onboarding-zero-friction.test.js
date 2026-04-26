// REGRESSION GUARD (2026-04-26, brand-onboarding-zero-friction)
//
// Three contracts, one file:
//
//   1. The brand-name displayName parser in main.js's get-brands handler
//      MUST strip both prefix bloat ("Brand Profile — POG") AND suffix bloat
//      ("POG — Brand Guide", "POG — Memory") so the dropdown shows "POG".
//      Historical incident: brand.md heading drifted between Claude turns
//      and skill writers; the dropdown showed "POG — Brand Guide" because
//      only the prefix-strip path existed. Fixing this is invisible from the
//      outside — the only place to anchor the contract is a source-scan +
//      a functional re-implementation of the same regex chain.
//
//   2. The host-side approval gate MUST auto-approve every
//      `mcp__scheduled-tasks__*` tool call without an approval card.
//      Brand onboarding fires four scheduled-task creates back-to-back; if
//      any one prompts an approval card, the user has to click through them
//      and the "<30s zero-friction" goal collapses. Source-scan asserts the
//      short-circuit is on the path BEFORE the catch-all approval card.
//
//   3. The brand_activate MCP tool MUST exist, accept a brand slug, and
//      route to ctx.activateBrand. The skill calls this immediately after
//      writing brand.md; missing it leaves the user stuck on the previous
//      brand.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const SRC_MCP = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────
// Shared mirror of the parser logic in main.js's get-brands handler.
// Keep this in sync with the .replace chain in get-brands; the tests
// below pin both this mirror AND the source so drift is caught.
// ─────────────────────────────────────────────────────────────────
function extractDisplayName(brandMd, folderName) {
  let displayName = folderName;
  const h1 = brandMd.match(/^#\s+(.+)$/m);
  if (h1) {
    displayName = h1[1]
      .trim()
      .replace(/^Brand\s*Profile\s*[-—–:]\s*/i, '')
      .replace(/^Brand\s*[-—–:]\s*/i, '')
      .replace(/\s*[-—–:]\s*Brand\s*Guide\s*$/i, '')
      .replace(/\s*[-—–:]\s*Brand\s*Profile\s*$/i, '')
      .replace(/\s*[-—–:]\s*Memory\s*$/i, '')
      .replace(/\s*[-—–:]\s*(?:Style|Identity|Voice|Playbook)\s*Guide\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (!displayName || displayName === folderName) {
    const fld = brandMd.match(/^(?:Brand|Name)[:\s]+["']?([^\n"']+)/im);
    if (fld) displayName = fld[1].trim();
  }
  if (!displayName || displayName === folderName) {
    displayName = folderName.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  return displayName;
}

test('displayName: bare H1 passes through', () => {
  assert.equal(extractDisplayName('# POG\n', 'pog'), 'POG');
});

test('displayName: " — Brand Guide" suffix gets stripped (the user-reported bloat)', () => {
  assert.equal(extractDisplayName('# POG — Brand Guide\n', 'pog'), 'POG');
  assert.equal(extractDisplayName('# Madchill — Brand Guide\n', 'madchill'), 'Madchill');
});

test('displayName: "Brand Profile —" prefix gets stripped', () => {
  assert.equal(extractDisplayName('# Brand Profile — POG\n', 'pog'), 'POG');
  assert.equal(extractDisplayName('# Brand Profile - Madchill\n', 'madchill'), 'Madchill');
});

test('displayName: " — Memory" / " — Brand Profile" / " — Voice Guide" suffixes', () => {
  assert.equal(extractDisplayName('# POG — Memory\n', 'pog'), 'POG');
  assert.equal(extractDisplayName('# POG — Brand Profile\n', 'pog'), 'POG');
  assert.equal(extractDisplayName('# POG — Voice Guide\n', 'pog'), 'POG');
  assert.equal(extractDisplayName('# POG — Style Guide\n', 'pog'), 'POG');
  assert.equal(extractDisplayName('# POG — Identity Guide\n', 'pog'), 'POG');
  assert.equal(extractDisplayName('# POG — Playbook Guide\n', 'pog'), 'POG');
});

test('displayName: en-dash and hyphen separators handled like em-dash', () => {
  assert.equal(extractDisplayName('# POG – Brand Guide\n', 'pog'), 'POG');  // en-dash U+2013
  assert.equal(extractDisplayName('# POG - Brand Guide\n', 'pog'), 'POG');
  assert.equal(extractDisplayName('# POG: Brand Guide\n', 'pog'), 'POG');
});

test('displayName: H1 with em-dash inside the brand name itself is preserved', () => {
  // "FRESHWATER — A NORTHWEST BRAND" should not be mangled — only known
  // suffix words are stripped, brand-internal dashes pass through.
  assert.equal(extractDisplayName('# Freshwater — A Northwest Brand\n', 'freshwater'), 'Freshwater — A Northwest Brand');
});

test('displayName: falls back to title-cased folder name when H1 missing', () => {
  assert.equal(extractDisplayName('No heading here.\n', 'mad-chill'), 'Mad Chill');
  assert.equal(extractDisplayName('', 'pog'), 'Pog');
});

test('displayName: Brand: <name> field used when H1 missing', () => {
  assert.equal(extractDisplayName('Brand: POG\nVertical: ecommerce\n', 'pog'), 'POG');
});

test('displayName: pathological "# — Brand Guide" falls through to folder', () => {
  // The H1 has only a separator + suffix → after strip it's empty, so we
  // should fall back to the folder-name title-case path.
  assert.equal(extractDisplayName('# — Brand Guide\n', 'pog'), 'Pog');
});

// ─────────────────────────────────────────────────────────────────
// Source-scan: the SAME .replace chain MUST live in main.js. This pins
// the host-side parser against drift; if someone simplifies the regex
// chain and breaks the suffix strip, the mirror above keeps passing
// while this assertion fails.
// ─────────────────────────────────────────────────────────────────
test('main.js get-brands handler still strips Brand Guide / Memory / Style Guide suffixes', () => {
  // We need to anchor inside the get-brands handler so a similarly-named
  // chain elsewhere in main.js doesn't false-pass.
  const anchor = SRC_MAIN.indexOf("ipcMain.handle('get-brands'");
  assert.ok(anchor > 0, 'get-brands handler not found — test needs updating if renamed');
  const slice = SRC_MAIN.slice(anchor, anchor + 4000);
  // These are the load-bearing suffix replacers — the prefix replacers were
  // already shipping; the regression we're guarding against is reverting any
  // of these suffix patterns.
  assert.match(slice, /Brand\\s\*Guide\\s\*\$/, 'missing " — Brand Guide" suffix strip');
  assert.match(slice, /Brand\\s\*Profile\\s\*\$/, 'missing " — Brand Profile" suffix strip');
  assert.match(slice, /Memory\\s\*\$/, 'missing " — Memory" suffix strip');
  assert.match(slice, /\(\?:Style\|Identity\|Voice\|Playbook\)\\s\*Guide\\s\*\$/,
    'missing the Style|Identity|Voice|Playbook Guide suffix strip');
});

// ─────────────────────────────────────────────────────────────────
// Approval gate: scheduled-tasks short-circuit
// ─────────────────────────────────────────────────────────────────
test('main.js auto-approves every mcp__scheduled-tasks__ tool call', () => {
  // Two contracts:
  //   (a) the source contains a startsWith short-circuit for the prefix
  //   (b) it lives BEFORE the catch-all approval card at the bottom of
  //       handleToolApproval (otherwise the catch-all fires first and the
  //       short-circuit is dead code).
  const shortCircuitIdx = SRC_MAIN.search(/toolName\.startsWith\('mcp__scheduled-tasks__'\)/);
  assert.ok(shortCircuitIdx > 0, 'short-circuit for mcp__scheduled-tasks__ is missing');

  // The "All other MCP merlin tools: auto-approve" comment is one
  // catch-all; the bigger one is the function-tail block that fires the
  // generic approval card. Find the LAST `approval-request` IPC send and
  // assert the short-circuit precedes it. If a future refactor moves the
  // short-circuit below this, every onboarding gets 4 approval cards back.
  const lastApprovalSend = SRC_MAIN.lastIndexOf("'approval-request'");
  assert.ok(lastApprovalSend > 0, "no approval-request IPC found — test needs updating");
  assert.ok(
    shortCircuitIdx < lastApprovalSend,
    'mcp__scheduled-tasks__ short-circuit MUST appear before the catch-all approval card. '
    + 'Reordering them lets a scheduled-task call hit the catch-all first and prompt for approval, '
    + 'which is the exact 4-extra-clicks regression this guards against.'
  );
});

// ─────────────────────────────────────────────────────────────────
// brand_activate MCP tool: declared, wired to ctx.activateBrand
// ─────────────────────────────────────────────────────────────────
test('mcp-tools registers a brand_activate tool that calls ctx.activateBrand', () => {
  // Source-scan: name + handler signature.
  assert.match(SRC_MCP, /name:\s*'brand_activate'/);
  assert.match(SRC_MCP, /ctx\.activateBrand\(brand\)/);
});

test('main.js wires ctx.activateBrand into the MCP server context', () => {
  // The mcpCtx object passed to createMerlinMcpServer must have a callable
  // activateBrand. If a future refactor moves the wiring or renames the key,
  // the brand_activate tool returns the host-not-wired error envelope and
  // the skill loops on every onboarding.
  assert.match(SRC_MAIN, /activateBrand:\s*\(brand\)\s*=>\s*\{/);
  // The function persists state and fires the brand-activated IPC.
  assert.match(SRC_MAIN, /writeState\(\{\s*activeBrand:\s*brand\s*\}\)/);
  assert.match(SRC_MAIN, /'brand-activated'/);
});

// ─────────────────────────────────────────────────────────────────
// SKILL invariants: zero AskUserQuestion in setup body, brand_activate
// referenced, parallel scheduled-task creation called out
// ─────────────────────────────────────────────────────────────────
test('merlin-setup SKILL.md does not call AskUserQuestion mid-setup (only the opening website prompt)', () => {
  const skillPath = path.join(__dirname, '..', '.claude', 'skills', 'merlin-setup', 'SKILL.md');
  const skill = fs.readFileSync(skillPath, 'utf8');
  // The ZERO-APPROVAL CONTRACT block is the load-bearing rule.
  assert.match(skill, /ZERO-APPROVAL CONTRACT/);
  // Every prior "use AskUserQuestion to confirm vertical / autopilot consent
  // / pick spells / capture goal" prompt MUST be gone. We allow `AskUserQuestion`
  // mentions as part of the contract / opening-prompt instructions, but the
  // specific phrasings of the four removed prompts MUST be absent.
  assert.doesNotMatch(skill, /Use\s+`AskUserQuestion`\s+to\s+confirm\s+the\s+detected\s+vertical/i);
  assert.doesNotMatch(skill, /Turn on autopilot for \[Brand\]\?/);
  assert.doesNotMatch(skill, /Yes — turn on all 4 \(recommended\)/);
  assert.doesNotMatch(skill, /What's your revenue target for/);
});

test('merlin-setup SKILL.md instructs the agent to call brand_activate after brand.md', () => {
  const skillPath = path.join(__dirname, '..', '.claude', 'skills', 'merlin-setup', 'SKILL.md');
  const skill = fs.readFileSync(skillPath, 'utf8');
  assert.match(skill, /brand_activate\(\{brand:/);
  assert.match(skill, /IMMEDIATELY after writing brand\.md/i);
});

test('merlin-setup SKILL.md instructs parallel scheduled-task creation (no per-task narration)', () => {
  const skillPath = path.join(__dirname, '..', '.claude', 'skills', 'merlin-setup', 'SKILL.md');
  const skill = fs.readFileSync(skillPath, 'utf8');
  assert.match(skill, /in\s+PARALLEL/i);
  // The old "After creation tell user: ..." narration line was 4× chatter —
  // make sure it doesn't sneak back in via copy-paste.
  assert.doesNotMatch(skill, /After creation tell user:\s*\*"Daily content is set!/);
});

// ─────────────────────────────────────────────────────────────────
// Model pin: Opus 4.7. Product decision (2026-04-27) — every Merlin
// session runs Opus regardless of plan default. The sdk-latency-knobs
// test owns the negative case (must not be the old Sonnet pin); we
// pin the positive case here too so a future model bump has TWO
// failing tests pointing at the change site.
// ─────────────────────────────────────────────────────────────────
test('main.js pins the chat-thread model to claude-opus-4-7', () => {
  // Match against the queryOptions block specifically — anti-slop / probe
  // queries elsewhere in main.js may use different models legitimately.
  const queryOptsIdx = SRC_MAIN.indexOf('const queryOptions = {');
  assert.ok(queryOptsIdx > 0, 'queryOptions block not found — test needs updating if renamed');
  const slice = SRC_MAIN.slice(queryOptsIdx, queryOptsIdx + 800);
  assert.match(slice, /model:\s*['"]claude-opus-4-7['"]/);
});

// ─────────────────────────────────────────────────────────────────
// In-cap auto-approve (post-Gitar-review tightening, 2026-04-28):
//   - PUSH ONLY (duplicate intentionally cards because we can't see
//     its inherited budget).
//   - Fail closed on config read (default require-approval = true).
//   - Budget data unknown ⇒ card (headroom must be a finite number).
//   - bypassPermissions removed from runtime allow-list.
//   - Bash path action-gated to BASH_PUSH_ONLY for drift resistance.
// ─────────────────────────────────────────────────────────────────
test('handleToolApproval auto-approves in-cap MCP push without firing the approval card', () => {
  // Source-scan: the auto-approve clause MUST appear AFTER the cents-
  // detector hard-deny (so the floor wins on anomalies) and BEFORE the
  // approval-card emission (so the card path is bypassed on the happy
  // path). Three anchors — order matters.
  const anchorMcp = SRC_MAIN.indexOf("const SPEND = new Set(['push', 'duplicate', 'setup', 'setup-retargeting'])");
  assert.ok(anchorMcp > 0, "MCP SPEND set not found");
  // Slice ends at the next `if (toolName ===` (next handler block) so we
  // capture the entire SPEND branch including the approval-card emission.
  const branchEnd = SRC_MAIN.indexOf("if (toolName === 'AskUserQuestion'", anchorMcp);
  assert.ok(branchEnd > anchorMcp, 'AskUserQuestion branch (next handler block) not found');
  const sliceMcp = SRC_MAIN.slice(anchorMcp, branchEnd);
  // Cents-detector lives first.
  const centsIdx = sliceMcp.indexOf('looks like cents, not dollars');
  assert.ok(centsIdx > 0, 'cents-detector message missing from MCP spend branch');
  // In-cap auto-approve next.
  const inCapIdx = sliceMcp.indexOf('IN-CAP AUTO-APPROVE');
  assert.ok(inCapIdx > centsIdx, 'IN-CAP AUTO-APPROVE block must appear AFTER the cents-detector');
  // Approval card emission last.
  const cardIdx = sliceMcp.indexOf("'approval-request'");
  assert.ok(cardIdx > inCapIdx, 'approval-request emission must appear AFTER the in-cap auto-approve clause');
  // The auto-approve respects the requireSpendApproval opt-out.
  assert.match(sliceMcp, /requireSpendApproval/);
});

test('MCP in-cap auto-approve gates on action === push only (duplicate cards)', () => {
  // Gitar #121 finding 1 + #122 finding 2: duplicate has no visible
  // dailyBudget on the call, so any auto-approve guard reduces to "any
  // headroom exists" — which let a duplicate of a $500/day source ad
  // pass with $1 of remaining cap. Removing duplicate from the auto-
  // approve set is the only safe fix; the card stays.
  const anchorMcp = SRC_MAIN.indexOf("const SPEND = new Set(['push', 'duplicate', 'setup', 'setup-retargeting'])");
  const branchEnd = SRC_MAIN.indexOf("if (toolName === 'AskUserQuestion'", anchorMcp);
  const sliceMcp = SRC_MAIN.slice(anchorMcp, branchEnd);
  // The auto-approve gate must filter on push only.
  assert.match(sliceMcp, /action === 'push'\)\s*\{/);
  // It must NOT auto-approve duplicate (the regression we're guarding).
  assert.doesNotMatch(sliceMcp, /action === 'duplicate' && headroom > 0/);
});

test('MCP in-cap auto-approve fails closed on config read errors', () => {
  // Gitar #122 finding 1: bare `catch {}` defaulted requireSpendApproval
  // to false, opening every spend on transient I/O / parse errors. The
  // fail-closed default is `true`; the catch logs a warning.
  const anchorMcp = SRC_MAIN.indexOf("const SPEND = new Set(['push', 'duplicate', 'setup', 'setup-retargeting'])");
  const branchEnd = SRC_MAIN.indexOf("if (toolName === 'AskUserQuestion'", anchorMcp);
  const sliceMcp = SRC_MAIN.slice(anchorMcp, branchEnd);
  assert.match(sliceMcp, /let requireSpendApproval = true/);
  assert.match(sliceMcp, /\[spend-approval\] config read failed/);
});

test('MCP in-cap auto-approve cards when budget data is unknown (headroom not finite)', () => {
  // Gitar #121 finding 1 also flagged the fallback path: if
  // budgetCtx.remaining isn't finite, the previous code defaulted
  // headroom to capForComparison and silently allowed. The fix uses
  // null as the unknown sentinel and refuses to auto-approve unless
  // headroom is finite.
  const anchorMcp = SRC_MAIN.indexOf("const SPEND = new Set(['push', 'duplicate', 'setup', 'setup-retargeting'])");
  const branchEnd = SRC_MAIN.indexOf("if (toolName === 'AskUserQuestion'", anchorMcp);
  const sliceMcp = SRC_MAIN.slice(anchorMcp, branchEnd);
  assert.match(sliceMcp, /Number\.isFinite\(budgetCtx\.remaining\)\s*\?\s*budgetCtx\.remaining\s*:\s*null/);
  assert.match(sliceMcp, /headroom !== null/);
});

test('handleToolApproval auto-approves in-cap Bash Merlin push (mirrors MCP path)', () => {
  const anchorBash = SRC_MAIN.indexOf("const BASH_SPEND = new Set(['meta-push'");
  assert.ok(anchorBash > 0, 'Bash BASH_SPEND set not found');
  const sliceBash = SRC_MAIN.slice(anchorBash, anchorBash + 5000);
  const centsIdx = sliceBash.indexOf('looks like cents, not dollars');
  const inCapIdx = sliceBash.indexOf('IN-CAP AUTO-APPROVE for Bash spend path');
  const cardIdx = sliceBash.indexOf("'approval-request'");
  assert.ok(centsIdx > 0 && inCapIdx > centsIdx && cardIdx > inCapIdx,
    'order must be: cents-detector → in-cap auto-approve → approval-card. '
    + 'A regression that flips two of these would either re-introduce the '
    + 'cents card OR reintroduce friction on every push.');
  assert.match(sliceBash, /bashRequireSpendApproval/);
});

test('Bash in-cap auto-approve gates on BASH_PUSH_ONLY action set (drift resistance)', () => {
  // Gitar #121 finding 3: if a future edit adds setup-equivalent Bash
  // actions to BASH_SPEND (e.g. `meta-setup`), they would silently
  // inherit auto-approval. The fix gates on a separate BASH_PUSH_ONLY
  // set so anything not in it cards even if BASH_SPEND grows.
  const anchorBash = SRC_MAIN.indexOf("const BASH_SPEND = new Set(['meta-push'");
  const sliceBash = SRC_MAIN.slice(anchorBash, anchorBash + 5000);
  assert.match(sliceBash, /const BASH_PUSH_ONLY = new Set\(/);
  assert.match(sliceBash, /BASH_PUSH_ONLY\.has\(bashAction\)/);
});

test('Bash in-cap auto-approve fails closed on config read errors', () => {
  // Same Gitar #122 finding 1 fix mirrored on the Bash path.
  const anchorBash = SRC_MAIN.indexOf("const BASH_SPEND = new Set(['meta-push'");
  const sliceBash = SRC_MAIN.slice(anchorBash, anchorBash + 5000);
  assert.match(sliceBash, /let bashRequireSpendApproval = true/);
  assert.match(sliceBash, /\[spend-approval\] bash config read failed/);
});

test('Bash in-cap auto-approve cards when budget data is unknown', () => {
  const anchorBash = SRC_MAIN.indexOf("const BASH_SPEND = new Set(['meta-push'");
  const sliceBash = SRC_MAIN.slice(anchorBash, anchorBash + 5000);
  // Same null-sentinel pattern as the MCP path.
  assert.match(sliceBash, /Number\.isFinite\(budgetCtx\.remaining\)\s*\?\s*budgetCtx\.remaining\s*:\s*null/);
  assert.match(sliceBash, /headroom !== null/);
});

test('handleToolApproval auto-approves draft-only Reddit posts', () => {
  // The draft-only auto-approve clause sits between postMode resolution and
  // the approval-card emission for reddit-prospect-post.
  const anchorReddit = SRC_MAIN.indexOf("input.command.includes('reddit-prospect-post')");
  assert.ok(anchorReddit > 0, 'reddit-prospect-post branch not found');
  const sliceReddit = SRC_MAIN.slice(anchorReddit, anchorReddit + 4000);
  assert.match(sliceReddit, /DRAFT-ONLY AUTO-APPROVE/);
  // Opt-out via cfg.requireRedditApproval is honored.
  assert.match(sliceReddit, /requireRedditApproval/);
  // The auto-approve fires only when postMode === 'draft-only'.
  assert.match(sliceReddit, /postMode === 'draft-only' && !redditRequireApproval/);
});

// ─────────────────────────────────────────────────────────────────
// Anthropic auto-mode opt-in: permissionMode resolves from cfg.permissionMode
// with allow-list validation; default stays 'acceptEdits'. bypassPermissions
// is intentionally excluded from the runtime allow-list.
// ─────────────────────────────────────────────────────────────────
test('main.js reads permissionMode from config with an allow-list', () => {
  // The resolution block must:
  //   (a) declare the ALLOWED_MODES set including 'auto'
  //   (b) default to 'acceptEdits'
  //   (c) actually feed the resolved value into queryOptions.permissionMode
  assert.match(SRC_MAIN, /const ALLOWED_MODES = new Set\(\[[^\]]*'auto'[^\]]*\]\)/);
  assert.match(SRC_MAIN, /let resolvedPermissionMode = 'acceptEdits'/);
  // The queryOptions block must reference the resolved variable, not a
  // hardcoded literal — that's the wire-up that lets the config flag take
  // effect at session start.
  const queryOptsIdx = SRC_MAIN.indexOf('const queryOptions = {');
  const slice = SRC_MAIN.slice(queryOptsIdx, queryOptsIdx + 800);
  assert.match(slice, /permissionMode:\s*resolvedPermissionMode/);
});

test('ALLOWED_MODES does NOT include bypassPermissions (config-write attack surface)', () => {
  // Gitar #121 finding 2: brand config files can be written by the AI
  // agent during onboarding, so a runtime-readable allow-list including
  // bypassPermissions would let a single config write silently strip
  // every spend guardrail. The mode is a code-level / env-var concern,
  // not a config-readable one.
  const anchor = SRC_MAIN.indexOf('const ALLOWED_MODES = new Set');
  assert.ok(anchor > 0, 'ALLOWED_MODES declaration not found');
  // Slice the literal set declaration line.
  const declLine = SRC_MAIN.slice(anchor, SRC_MAIN.indexOf(';', anchor));
  assert.doesNotMatch(declLine, /bypassPermissions/,
    'bypassPermissions MUST NOT appear in ALLOWED_MODES — that mode disables '
    + 'every safety surface (cents-detector, in-cap auto-approve, friendly '
    + 'translations, canUseTool itself). Brand config can be written by the '
    + 'agent during onboarding; a single config write would strip all spend '
    + 'guardrails. If you genuinely need bypassPermissions for a controlled '
    + 'environment, use an env var or code change — not config.');
});
