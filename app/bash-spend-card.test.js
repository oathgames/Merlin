// REGRESSION GUARD (2026-11-20, snapchat-budget)
//
// Contracts for budget-changing actions and the Bash approval route:
//
//   1. Bash path: meta-budget, snapchat-budget and snapchat-activate move ad
//      dollars, so a direct `Merlin --cmd '{"action":"snapchat-budget",...}'`
//      call must hit the BASH_SPEND approval card. They must NOT be in
//      BASH_PUSH_ONLY (the in-cap auto-approve set).
//
//   2. Compound command bypass found in review 2026-11-20: the safe-prefix
//      shortcut matched only the FIRST word and ran before the spend tiers,
//      so `cd /d/x && Merlin.exe --cmd '{"action":"snapchat-budget",...}'`
//      ran with no card. Every case below drives routeBash, the function
//      handleToolApproval in main.js dispatches on, with real commands.
//
//   3. MCP path: the 'budget' SPEND action card names the object id the
//      engine changes and the new daily amount, never a model-supplied name.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('./mcp-approval-policy');
const route = require('./bash-approval-route');

const SRC = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

const BIN = '.claude/tools/Merlin.exe';
const BUDGET_BASH_ACTIONS = ['meta-budget', 'snapchat-budget', 'snapchat-activate'];
const SPEND_JSON = `'{"action":"snapchat-budget","approved":true,"dailyBudget":900}'`;
const r = (command) => route.routeBash(command);
const longTail = (command) => policy.classifyLongTailApproval({ toolName: 'Bash', command, strictApprovals: false });

// ── (1) budget actions card on the Bash path ─────────────────────────

test('budget-moving Bash actions route to the spend card, alone and behind cd', () => {
  for (const a of BUDGET_BASH_ACTIONS) {
    assert.ok(route.BASH_SPEND.has(a), `${a} must be in BASH_SPEND`);
    assert.ok(!route.BASH_PUSH_ONLY.has(a), `${a} must never be in BASH_PUSH_ONLY (in-cap auto-approve)`);
    const json = `'{"action":"${a}","approved":true,"dailyBudget":40}'`;
    for (const command of [`${BIN} --cmd ${json}`, `cd /d/x && ${BIN} --cmd ${json}`]) {
      const got = r(command);
      assert.equal(got.route, 'spend', `${command} must card on the spend path`);
      assert.equal(got.action, a);
    }
  }
});

// ── (2) compound command bypass variants ─────────────────────────────

test('the reported compound-with-cd spend command no longer auto-allows', () => {
  const command = `cd /d/x && ${BIN} --cmd ${SPEND_JSON}`;
  assert.equal(r(command).route, 'spend');
  assert.equal(route.isSafeBash(command), false);
  assert.equal(r(`cd /d/x && ${BIN} --cmd '{"action":"meta-push","dailyBudget":5}'`).route, 'spend');
});

test('every shell separator and substitution sends the engine call to classification', () => {
  const engine = `${BIN} --cmd ${SPEND_JSON}`;
  const spend = [
    `cd /d/x ; ${engine}`,
    `cd /d/x || ${engine}`,
    `echo hi | ${engine}`,
    `cd /d/x\n${engine}`,
    `cd /d/x & ${engine}`,
    `ls && (${engine})`,
  ];
  for (const command of spend) {
    assert.equal(route.isSafeBash(command), false, JSON.stringify(command));
    assert.equal(r(command).route, 'spend', JSON.stringify(command));
  }
  // Substitution: the engine runs inside $(...) or backticks; the shell
  // composes the command, so it cards as unreadable rather than safe.
  for (const command of [`echo $(${engine})`, `echo "$(${engine})"`, 'echo `' + engine + '`', `cd "$(${engine})"`]) {
    assert.equal(route.isSafeBash(command), false, command);
    assert.equal(r(command).route, 'card-unreadable', command);
  }
});

test('quoted, mixed-case and canonical binary paths are detected', () => {
  const json = SPEND_JSON;
  const forms = [
    `cd /d/x && "${BIN}" --cmd ${json}`,
    `cd /d/x && '.claude/tools/MERLIN.EXE' --cmd ${json}`,
    `cd /d/x && .claude/tools/merlin.exe --cmd ${json}`,
    `merlin.exe --cmd ${json}`,
    `cd ~/Merlin && .claude/tools/Merlin --cmd ${json}`,
    `cd /d/x && "%LOCALAPPDATA%/Merlin/bin/Merlin.exe" --cmd ${json}`,
    `cd /d/x && "C:\\Users\\u\\AppData\\Local\\Merlin\\bin\\Merlin.exe" --cmd ${json}`,
    `cd /d/x && C:\\Users\\u\\AppData\\Local\\Merlin\\bin\\Merlin.exe --cmd ${json}`,
    `cd /d/x && bash -c ".claude/tools/Merlin --cmd '{\\"action\\":\\"snapchat-budget\\"}'"`,
    `cd /d/x && env FOO=1 ${BIN} --cmd ${json}`,
  ];
  for (const command of forms) {
    assert.ok(route.isEngineInvocation(command), `engine not detected: ${command}`);
    assert.equal(route.isSafeBash(command), false, command);
    assert.ok(['spend', 'card-unreadable'].includes(r(command).route), `${command} -> ${r(command).route}`);
  }
  // The plain forms read their action and take the exact spend path.
  assert.equal(r(forms[1]).route, 'spend');
  assert.equal(r(forms[3]).route, 'spend');
  assert.equal(r(forms[6]).route, 'spend');
});

test('--cmd=, -cmd and -cmd= forms are read like --cmd', () => {
  for (const flag of ['--cmd=', '-cmd=']) {
    const got = r(`cd /d/x && ${BIN} ${flag}${SPEND_JSON}`);
    assert.equal(got.route, 'spend', flag);
    assert.equal(got.action, 'snapchat-budget');
  }
  assert.equal(r(`cd /d/x && ${BIN} -cmd ${SPEND_JSON}`).route, 'spend');
  // A bare variable binary is still an engine call through its --cmd flag.
  assert.equal(r(`cd /d/x && "$MERLIN_BIN" --cmd ${SPEND_JSON}`).route, 'card-unreadable');
});

test('--cmd-file cards with the "could not be read" wording', () => {
  const forms = [
    `${BIN} --cmd-file c.json`,
    `echo '{"action":"snapchat-budget","dailyBudget":900}' > c.json && ${BIN} --cmd-file c.json`,
    `cd /d/x && ${BIN} --cmd-file=c.json`,
    `cd /d/x && ${BIN} -cmd-file c.json`,
  ];
  for (const command of forms) {
    const got = r(command);
    assert.equal(got.route, 'card-unreadable', command);
    assert.equal(got.reason, 'file', command);
  }
  const card = route.unreadableEngineCard('file');
  assert.equal(card.label, 'Run a Merlin command whose action could not be read');
  assert.match(card.cost, /comes from a file \(--cmd-file\), so Merlin could not read which action/);
  assert.match(card.budget, /Auto-expires in 15 min/);
  for (const reason of ['file', 'shell', 'no-action', 'bogus']) {
    const c = route.unreadableEngineCard(reason);
    assert.ok(!/\u2014/.test(c.label + c.cost + c.budget), 'no em dashes in card text');
    assert.match(c.cost, /could not read/);
  }
});

test('shell-built action text cards as unreadable instead of trusting the literal', () => {
  const forms = [
    // Quote splicing: the literal reads "meta-'", the shell passes meta-push.
    `${BIN} --cmd '{"action":"meta-'"push"'","dailyBudget":5}'`,
    `${BIN} --cmd "{\\"action\\":\\"$ACTION\\"}"`,
    `${BIN} --cmd {"action":"meta-push"}`,
    `cd /d/x && ${BIN} --cmd '{"brand":"x"}'`,
  ];
  for (const command of forms) assert.equal(r(command).route, 'card-unreadable', command);
});

test('the spend card reads dailyBudget from the engine JSON, not a later segment', () => {
  const got = r(`${BIN} --cmd '{"action":"meta-push","dailyBudget":5000}' && echo '{"dailyBudget":5,"brand":"other"}'`);
  assert.equal(got.route, 'spend');
  const bashMerlinAction = require('./bash-merlin-action');
  assert.equal(bashMerlinAction.lastNumber(got.cmdText, 'dailyBudget'), 5000);
  assert.equal(bashMerlinAction.lastString(got.cmdText, 'brand'), null);
});

test('destructive and ambiguous engine calls keep their tiers behind a cd', () => {
  assert.equal(r(`cd /d/x && ${BIN} --cmd '{"action":"mailchimp-campaign-send","approved":true}'`).route, 'destructive');
  assert.equal(r(`cd /d/x; ${BIN} --cmd '{"action":"resume-all-spend"}'`).route, 'destructive');
  assert.equal(r(`cd /d/x && ${BIN} --cmd '{"action":"rokt-report","action":"meta-push"}'`).route, 'deny-ambiguous');
  assert.equal(r(`${BIN} --cmd '{"action":"meta-insights"}' && ${BIN} --cmd '{"action":"meta-push"}'`).route, 'deny-ambiguous');
});

test('find -exec and xargs cannot launder an engine call through a safe word', () => {
  assert.equal(route.isSafeBash(`find . -name x -exec ${BIN} --cmd ${SPEND_JSON} \\;`), false);
  // A wrapped engine call hides its arguments from the reader: it cards.
  assert.equal(r(`find . -name x -exec ${BIN} --cmd ${SPEND_JSON} \\;`).route, 'card-unreadable');
  assert.equal(route.isSafeBash('find . -name "*.tmp" -delete'), false);
  assert.equal(r(`ls | xargs ${BIN} --cmd ${SPEND_JSON}`).route, 'card-unreadable');
  assert.equal(r(`bash -c ".claude/tools/Merlin --cmd '{\\"action\\":\\"meta-push\\"}'"`).route, 'card-unreadable');
  assert.equal(r(`cd /d/x && cmd /c ${BIN} --cmd ${SPEND_JSON}`).route, 'card-unreadable');
  // A leading VAR=value assignment keeps the binary as the command word.
  assert.equal(r(`FOO=1 ${BIN} --cmd ${SPEND_JSON}`).route, 'spend');
});

// ── (2b) legitimate flows stay as they were ──────────────────────────

test('plain and compound safe commands stay auto-allowed', () => {
  const safe = [
    'ls', 'ls -la results/', 'pwd', 'echo hello', 'cp a.png b.png', 'mkdir -p results/x',
    'cd /d/x && ls', 'cd /d/x; ls -la', 'mkdir -p out && cp a.png out/',
    'cd ~/Merlin && ls', 'cd "C:/Users/u/Merlin" && ls -la', 'ls .claude/tools/Merlin.exe',
    'test -f .claude/tools/Merlin.exe && echo yes',
    'ls results 2>&1', 'grep -r "action" results | wc -l', 'find results -name "*.json"',
    `echo '{"action":"snapchat-budget"}' > c.json`,
  ];
  for (const command of safe) assert.equal(r(command).route, 'safe', command);
  // Review 7: chmod can arm a staged wrapper, so with an engine signal it cards.
  assert.equal(r('chmod +x .claude/tools/Merlin').route, 'card-unreadable');
});

test('read-only engine calls keep their non-carded behavior, alone and behind cd', () => {
  for (const command of [
    `${BIN} --cmd '{"action":"meta-insights","brand":"x"}'`,
    `cd /d/x && ${BIN} --cmd '{"action":"meta-insights","brand":"x"}'`,
    `cd "C:/Users/u/Merlin" && ${BIN} --cmd '{"action":"dashboard"}'`,
    `${BIN} --version`,
  ]) {
    const got = r(command);
    assert.equal(got.route, 'other', `${command} must reach the long tail, classified by its action`);
    assert.equal(longTail(command), 'allow', `${command} must stay uncarded in auto mode`);
  }
  assert.equal(r(`cd /d/x && ${BIN} --cmd '{"action":"meta-insights"}'`).action, 'meta-insights');
});

// ── main.js wiring ───────────────────────────────────────────────────

test('main.js dispatches every Bash call on routeBash before any Bash allow', () => {
  assert.ok(!/function isSafeBash\b/.test(SRC) && !/safeBashPatterns/.test(SRC),
    'the prefix-only isSafeBash must not come back in main.js');
  const fn = SRC.indexOf('async function handleToolApproval(');
  // routeShellTool is routeBash for Bash-syntax tools (bash-hidden-engine.test.js).
  const routeIdx = SRC.indexOf("bashApprovalRoute.routeShellTool((opts && opts.shellTool) || 'Bash', input && input.command)", fn);
  const safeIdx = SRC.indexOf("bashRoute.route === 'safe'", fn);
  const unreadIdx = SRC.indexOf("bashRoute.route === 'card-unreadable'", fn);
  const spendIdx = SRC.indexOf('if (BASH_SPEND.has(bashAction))', fn);
  const longTailIdx = SRC.indexOf('longTailPolicy.classifyLongTailApproval(', fn);
  assert.ok(fn > 0 && routeIdx > fn && safeIdx > routeIdx && unreadIdx > safeIdx &&
    spendIdx > unreadIdx && longTailIdx > spendIdx, 'route -> safe -> unreadable card -> spend -> long tail');
  // No other Bash auto-allow between the function start and the route.
  assert.ok(!/toolName === 'Bash'[^\n]*\n\s*return \{ behavior: 'allow'/.test(SRC.slice(fn, routeIdx)));
  const guard = SRC.lastIndexOf('REGRESSION GUARD', routeIdx);
  assert.match(SRC.slice(guard, routeIdx), /2026-11-20, compound command bypass found in review/);
  const unread = SRC.slice(unreadIdx, unreadIdx + 600);
  assert.match(unread, /unreadableEngineCard\(bashRoute\.reason\)/);
  assert.match(unread, /'approval-request'/);
  assert.match(unread, /awaitApprovalDecision\(toolUseID, input\)/);
  assert.match(SRC.slice(spendIdx, spendIdx + 900), /lastNumber\(bashCmdText, 'dailyBudget'\)/);
});

// ── (3) MCP budget card ──────────────────────────────────────────────

test('MCP budget card names the Snapchat ad squad id and the new amount, not a model-supplied name', () => {
  const c = policy.budgetChangeCard('mcp__merlin__snapchat', {
    action: 'budget', targetAdSetId: '50000000-0000-4000-8000-000000000001', adSetName: 'Spring prospecting', dailyBudget: 40,
  });
  assert.equal(c.label, 'Change Snapchat daily budget: ad squad (50000000-0000-4000-8000-000000000001)');
  assert.ok(!c.label.includes('Spring prospecting'), 'the engine never checks adSetName against the id');
  assert.equal(c.cost, 'New daily budget: $40/day');
});

test('MCP budget card follows each engine object precedence', () => {
  assert.equal(policy.budgetChangeCard('mcp__merlin__snapchat', { campaignId: 'c1', dailyBudget: 100 }).label,
    'Change Snapchat daily budget: campaign (c1)');
  // meta-budget prefers adId (an ad set) over campaignId.
  assert.equal(policy.budgetChangeCard('mcp__merlin__meta_ads', { adId: '123', campaignId: '9', adSetName: 'Winners', dailyBudget: 25 }).label,
    'Change Meta daily budget: ad set (123)');
  assert.equal(policy.budgetChangeCard('mcp__merlin__google_ads', { campaignId: '777', campaignName: 'Brand', dailyBudget: 150 }).label,
    'Change Google Ads daily budget: campaign (777)');
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

test('MCP budget card strips bidi-override and zero-width characters from ids', () => {
  const sneaky = '123\u202e987\u200b\u200d\u2066\u2069\ufeff\u061c\u200e\u2028x';
  const c = policy.budgetChangeCard('mcp__merlin__meta_ads', { adId: sneaky, dailyBudget: 10 });
  assert.ok(!/[\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(c.label), `unsafe characters survived: ${JSON.stringify(c.label)}`);
  assert.match(c.label, /^Change Meta daily budget: ad set \(123 987/);
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
