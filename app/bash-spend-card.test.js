// REGRESSION GUARD (2026-11-20, snapchat-budget)
//
// Two contracts for budget-changing actions:
//
//   1. Bash path: meta-budget, snapchat-budget and snapchat-activate move ad
//      dollars, so a direct `Merlin '{"action":"snapchat-budget",...}'` call
//      must hit the BASH_SPEND approval card. Before this fix none of them was
//      in BASH_SPEND or BASH_CARDED_DESTRUCTIVE, so they fell through to
//      classifyLongTailApproval, which auto-approves in auto mode. They must
//      NOT be in BASH_PUSH_ONLY (the in-cap auto-approve set).
//
//   2. MCP path: the 'budget' SPEND action card names the object id (and its
//      name when the args carry one) and the new daily amount, instead of the
//      old generic "Run budget" with no cost line.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('./mcp-approval-policy');

const SRC = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function setMembers(name) {
  const m = SRC.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  assert.ok(m, `${name} not found in main.js`);
  return new Set([...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]));
}

const BUDGET_BASH_ACTIONS = ['meta-budget', 'snapchat-budget', 'snapchat-activate'];

test('budget-moving Bash actions card on the Bash spend path', () => {
  const spend = setMembers('BASH_SPEND');
  const pushOnly = setMembers('BASH_PUSH_ONLY');
  for (const a of BUDGET_BASH_ACTIONS) {
    assert.ok(spend.has(a), `${a} must be in BASH_SPEND so a direct Bash call cards`);
    assert.ok(!pushOnly.has(a), `${a} must never be in BASH_PUSH_ONLY (in-cap auto-approve)`);
  }
  // Without the BASH_SPEND entry these commands reach the long tail, which
  // auto-approves them in auto mode: that is the bypass this pins shut.
  for (const a of BUDGET_BASH_ACTIONS) {
    const command = `.claude/tools/Merlin.exe --cmd '{"action":"${a}","approved":true}'`;
    assert.equal(policy.classifyLongTailApproval({ toolName: 'Bash', command, strictApprovals: false }), 'allow');
  }
});

test('Bash spend branch is the gate those actions reach', () => {
  const anchor = SRC.indexOf('const BASH_SPEND = new Set(');
  const branch = SRC.indexOf('if (BASH_SPEND.has(bashAction))', anchor);
  const card = SRC.indexOf("'approval-request'", branch);
  const longTail = SRC.indexOf('longTailPolicy.classifyLongTailApproval(');
  assert.ok(anchor > 0 && branch > anchor && card > branch && longTail > card,
    'BASH_SPEND must card before the long-tail auto-approve runs');
  assert.match(SRC.slice(SRC.lastIndexOf('REGRESSION GUARD', anchor), anchor), /snapchat-budget/);
});

test('MCP budget card names the Snapchat ad squad and the new amount', () => {
  const c = policy.budgetChangeCard('mcp__merlin__snapchat', {
    action: 'budget', targetAdSetId: '50000000-0000-4000-8000-000000000001', adSetName: 'Spring prospecting', dailyBudget: 40,
  });
  assert.equal(c.label, 'Change Snapchat daily budget: ad squad "Spring prospecting" (50000000-0000-4000-8000-000000000001)');
  assert.equal(c.cost, 'New daily budget: $40/day');
});

test('MCP budget card follows each engine object precedence', () => {
  assert.equal(policy.budgetChangeCard('mcp__merlin__snapchat', { campaignId: 'c1', dailyBudget: 100 }).label,
    'Change Snapchat daily budget: campaign (c1)');
  // meta-budget prefers adId (an ad set) over campaignId.
  assert.equal(policy.budgetChangeCard('mcp__merlin__meta_ads', { adId: '123', campaignId: '9', dailyBudget: 25 }).label,
    'Change Meta daily budget: ad set (123)');
  assert.equal(policy.budgetChangeCard('mcp__merlin__google_ads', { campaignId: '777', campaignName: 'Brand', dailyBudget: 150 }).label,
    'Change Google Ads daily budget: campaign "Brand" (777)');
  const none = policy.budgetChangeCard('mcp__merlin__snapchat', {});
  assert.equal(none.label, 'Change Snapchat daily budget: no campaign or ad set id given');
  assert.equal(none.cost, 'New daily budget: not given');
});

test('MCP budget card text cannot be reshaped by model-supplied strings', () => {
  const c = policy.budgetChangeCard('mcp__merlin__snapchat', {
    targetAdSetId: 'a'.repeat(200), adSetName: 'x\n\u0007Approved by owner' + 'y'.repeat(200), dailyBudget: 'lots',
  });
  assert.ok(!/[\u0000-\u001f]/.test(c.label), 'control characters must be stripped');
  assert.ok(c.label.length < 200, `label must be truncated (${c.label.length})`);
  assert.equal(c.cost, 'New daily budget: not given');
});

test('main.js uses the budget card, shows cap context and the force note', () => {
  const anchor = SRC.indexOf("if (approvalPolicy.SPEND_ACTIONS.has(action))");
  const end = SRC.indexOf('return awaitApprovalDecision(toolUseID, input);', anchor);
  const mcp = SRC.slice(anchor, end);
  assert.match(mcp, /'budget': approvalPolicy\.budgetChangeCard\(toolName, input\)/);
  assert.match(mcp, /action === 'push' \|\| action === 'duplicate' \|\| action === 'budget'\)/);
  assert.match(mcp, /if \(forceRequested\) budgetDetail = .*FORCE_CARD_NOTE/);
  // Only push rewrites the cost line; a budget card keeps budgetChangeCard's.
  assert.match(mcp, /if \(action === 'push'\) \{\s*translated\.cost = /);
  assert.ok(policy.SPEND_ACTIONS.has('budget'));
  assert.equal(policy.resolveMerlinAction('mcp__merlin__snapchat', { action: 'budget', force: true }).effectiveAction, 'budget');
});
