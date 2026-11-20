// REGRESSION GUARD (2026-11-20, bash-approval-followup)
//
//   1. An engine binary name the SHELL assembles (variables, spliced quotes,
//      a script written and sourced in the same command) must card, through
//      the real routeBash, and the PreToolUse hook must block it. The rule
//      is hiddenEngineCall in bash-approval-route.js.
//   2. The Bash spend card names the object id the engine will change,
//      sanitized exactly like the MCP budget card.
//   3. PowerShell / Monitor / any shell-shaped tool takes the Bash route,
//      PowerShell fails closed, and a throw in the approval path denies.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const route = require('./bash-approval-route');
const policy = require('./mcp-approval-policy');

const r = (command) => route.routeBash(command).route;
const SPEND = `'{"action":"meta-push","approved":true,"dailyBudget":900}'`;
const REPRODUCERS = [
  `B=.claude/tools/Mer; A=-cmd; \${B}lin.exe $A ${SPEND}`,
  `B=.claude/tools/Mer; A=-cmd; "\${B}"lin.exe $A ${SPEND}`,
  `echo "Mer""lin.ex""e -c""md {\\"action\\":\\"meta-push\\",\\"approved\\":true}" > s.sh && . s.sh`,
  `echo "Mer""lin.ex""e -c""md {\\"action\\":\\"meta-push\\",\\"approved\\":true}" > s.sh && bash s.sh`,
  `echo "Mer""lin.ex""e -c""md {\\"action\\":\\"meta-push\\",\\"approved\\":true}" > s.sh && source s.sh`,
  `X=Merlin.exe; ./$X --cmd ${SPEND}`,
  `eval ".claude/tools/Mer""lin.exe --cmd ${SPEND.replace(/'/g, '')}"`,
  `node run.js '{"action":"meta-budget","adId":"1","dailyBudget":900}'`,
];
const ALLOWED = [
  ['cd "$HOME" && ls', 'safe'],
  ['echo $PATH', 'safe'],
  ['grep -n \'"action":"meta-push"\' file.js', 'safe'],
  ['ls *.go', 'safe'],
];

// ── (1) hidden engine invocations ────────────────────────────────────

test('every reproducer cards as an unreadable engine call', () => {
  for (const c of REPRODUCERS) {
    assert.equal(r(c), 'card-unreadable', `must card: ${c}`);
    assert.equal(route.hiddenEngineCall(c), true, c);
  }
});

test('must-stay-allowed commands are unchanged', () => {
  for (const [c, want] of ALLOWED) assert.equal(r(c), want, c);
  // Not 'safe' before this change either (git is not in the safe list),
  // but it must never be read as an engine call.
  const commit = route.routeBash('git commit -m "fix meta-push action"');
  assert.equal(commit.route, 'other');
  assert.equal(route.hiddenEngineCall('git commit -m "fix meta-push action"'), false);
});

test('scripts and variables with no engine signal are not carded', () => {
  for (const c of ['bash build.sh', './run.sh', 'X=1; echo $X', '. ~/.profile', 'sh -c "npm test"']) {
    assert.notEqual(r(c), 'card-unreadable', c);
  }
});

test('a literal engine call is still classified by its own action', () => {
  assert.equal(r(`.claude/tools/Merlin.exe --cmd ${SPEND}`), 'spend');
  assert.equal(r(`.claude/tools/Merlin.exe --cmd '{"action":"meta-insights"}'`), 'other');
});

// ── hook tightening ───────────────────────────────────────────────────

const HOOK = path.join(__dirname, '..', '.claude', 'hooks', 'block-api-bypass.js');
const HOOK_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-hook-'));
test.after(() => { try { fs.rmSync(HOOK_CWD, { recursive: true, force: true }); } catch {} });
function runHook(tool_name, command) {
  const env = { ...process.env };
  delete env.TOOL_INPUT;
  delete env.TOOL_NAME;
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name, tool_input: { command } }),
    env, cwd: HOOK_CWD, encoding: 'utf8',
  });
  return res.status;
}

test('hook blocks the shell-assembled engine reproducers', () => {
  for (const c of REPRODUCERS.slice(0, 3)) assert.equal(runHook('Bash', c), 2, `hook must block: ${c}`);
});

test('hook still allows the must-stay-allowed commands', () => {
  for (const c of ['cd "$HOME" && ls', 'echo $PATH', 'git commit -m "fix meta-push action"',
    'grep -n \'"action":"meta-push"\' file.js']) {
    assert.equal(runHook('Bash', c), 0, `hook must allow: ${c}`);
  }
});

// ── review 5: empty expansions spliced into every signal ─────────────
// Each ran the engine in real bash (fake echo-args Merlin.exe) and routed
// 'other' before splicedEngineSignal.
const SPLICED = [
  `x=; ./Mer\${x}lin.exe --c\${x}md '{"act'\${x}'ion":"meta-push"}'`,
  `x=; ./Mer"\${x}"lin.exe --c\${x}md '{"act'\${x}'ion":"meta-push"}'`,
  `x=; ./Mer\`true\`lin.exe --c\${x}md x`,
  `x=; env ./Mer\${x}lin.exe --c\${x}md x`,
  `a=Mer; b=lin.exe; c=--c; d=md; ./$a$b $c$d "$json"`,
  `a=Mer; b=lin.exe; ./$a$b --cmd '{"action":"meta-push"}'`,
];
const SPLICED_UNCHAINED = [
  `./Mer$(true)lin.exe --cmd '{"action":"meta-push"}'`,
  `./Mer\${x:-}lin.exe --c\${x}md x`,
];
const STAY_UNCARDED = [
  ['cd "$HOME" && ls', 'safe'],
  ['echo $PATH', 'safe'],
  ['echo "$USER uses merlin"', 'safe'],
  ['git commit -m "fix meta-push action for $BRAND"', 'other'],
  ['grep \'"action":"meta-push"\' "$FILE"', 'safe'],
  ['rg -n \'"action": *"meta-push"\' app/', 'other'],
  ['npm test', 'other'],
  ['node "$SCRIPT"', 'other'],
  ['for f in *.js; do node --check "$f"; done', 'other'],
  ['export PATH="$PATH:/usr/local/bin"', 'other'],
  ['ls "$LOCALAPPDATA/Merlin/bin"', 'safe'],
  ['git log --oneline -n "$N"', 'other'],
];

test('expansions spliced into the binary name, flag and action key card', () => {
  for (const c of [...SPLICED, ...SPLICED_UNCHAINED]) assert.equal(r(c), 'card-unreadable', `must card: ${c}`);
  assert.equal(route.eraseExpansions(`./Mer\${x}lin.exe --c\${x}md '{"act'\${x}'ion":1}'`, false),
    './Merlin.exe --cmd {action:1}');
  assert.equal(route.eraseExpansions('./Mer$(echo a)lin.exe', false), './Merlin.exe');
  assert.equal(route.eraseExpansions('./${x:-Mer}lin.exe', true), './Merlin.exe');
});

test('text-only and signal-free commands with expansions stay uncarded', () => {
  for (const [c, want] of STAY_UNCARDED) {
    assert.equal(r(c), want, c);
    assert.equal(runHook('Bash', c), 0, `hook must allow: ${c}`);
  }
});

test('hook blocks chained spliced engine calls', () => {
  for (const c of SPLICED) assert.equal(runHook('Bash', c), 2, `hook must block: ${c}`);
});

test('erased reading stays linear on 50KB pathological input', () => {
  for (const unit of ['${', '$(', '`', '${x:-', 'a=$b; ', '\\$']) {
    const big = `x=; node ${unit.repeat(Math.ceil(50000 / unit.length))} ./Mer\${x}lin.exe`;
    const t0 = Date.now();
    r(big);
    assert.ok(Date.now() - t0 < 1000, `slow on ${unit}: ${Date.now() - t0}ms`);
  }
});

// ── review 6: git / sed / find / xargs run the engine from text ───────
// g1-g4, s1, s2 ran the fake engine in real bash and routed 'other' before
// the two-tier exemption (strongSignalUngated, textOnlyProgram).
const BUDGET = `'{"action":"meta-budget","adId":"1","dailyBudget":900}'`;
const ESC_BUDGET = `"'{\\"action\\":\\"meta-budget\\",\\"adId\\":\\"1\\",\\"dailyBudget\\":900}'"`;
const TIERED_GATED = [
  `git -c alias.x='!./.claude/tools/Merl""in.exe --c""md' x ${BUDGET}`,
  `x=; git -c alias.x='!./.claude/tools/Mer\${x}lin.exe --c\${x}md' x ${BUDGET}`,
  `GIT_PAGER='./.claude/tools/Merl""in.exe --c""md {\\"action\\":\\"meta-budget\\",\\"adId\\":\\"1\\",\\"dailyBudget\\":900} #' git -p version`,
  `git -c alias.x='!f(){ ./.claude/tools/Merl""in.exe --c""md "$1"; }; f' x '{"action":"meta-push","approved":true,"dailyBudget":900}'`,
  `printf '%s\\n' ${ESC_BUDGET} | sed 's/.*\\/*/.\\/.claude\\/tools\\/Merl""in.exe --c""md &/eg'`,
  `sed 's/.*\\/*/.\\/.claude\\/tools\\/Merl""in.exe --c""md &/eg' <<< ${ESC_BUDGET}`,
  `rg --pre ./x '"action":"meta-push"' f`,
  `git rebase -x './Merl""in.exe --c""md {"action":"meta-push"}' HEAD~1`,
  `GIT_PAGER='./Merl""in.exe --c""md {"action":"meta-push"}' git -p log`,
  `echo ./Merlin.exe --cmd '{"action":"meta-push"}' > s.sh; sh s.sh`,
  `cat s.txt | sh -s ${BUDGET}`,
  `find . -exec ./Merl""in.exe --c""md '{"action":"meta-push"}' \\;`,
  `echo '{"action":"meta-push"}' | xargs ./Merl""in.exe --c""md`,
  `git grep -O'./Merl""in.exe --c""md' meta-push`,
  `git -c core.pager='./Merl""in.exe --c""md' log`,
  `git -c alias.x='!sh' x ${BUDGET}`,
  `test -v 'a[$(./Merl""in.exe --c""md x)]'`,
  `printf -v 'a[$(./Merl""in.exe --c""md x)]' y`,
  `printf -v'a[$(./Merl""in.exe --c""md x)]' y`,
  `echo './Merl""in.exe --c""md x' >> ~/.bashrc`,
  `cp .claude/tools/Merlin.exe ~/bin/grep.exe`,
  `grep --cmd ${BUDGET} x`,
  `sed -e 's/a/b/' -e '1e date' ${BUDGET}`,
  `PATH=.:$PATH grep -c""md ${BUDGET}`,
  `git commit -m "bump Merlin.exe --cmd parsing"`,
];
const TIERED_UNGATED = [
  'cd "$HOME" && ls', 'echo $PATH', 'git commit -m "fix meta-push action"', 'git commit -m "don\'t break # things"',
  'git log --grep=meta-push', 'git diff main -- app/bash-approval-route.js', 'grep \'"action":"meta-push"\' file',
  'grep -rn "Merlin.exe" app/', 'cat docs/notes.md | grep -i merlin', 'rg -n \'"action": *"meta-push"\' app/',
  'sed -n \'1,20p\' app/main.js', 'sed \'s/meta-push/meta-bulk-push/g\' notes.txt',
  'sed -n \'/"action":"meta-push"/p\' app/x.js', 'git log -n 5 -- \'{"action":"meta-push"}\'',
  'npm test', "echo $'a\\tb'", 'ls .claude/tools/*.exe', 'ls "$LOCALAPPDATA/Merlin/bin"', 'node script.js',
  'node "$SCRIPT"', 'go build ./... && go vet ./...', 'gh pr view 12 --json state',
  "cat > notes.md <<'EOF'\n# Notes\nIt's Ryan's plan, don't skip.\n## Next\nEOF",
  'chmod +x .claude/tools/Merlin', 'cd .claude/tools && ls',
];

test('git, sed, rg, find and xargs forms with engine text card', () => {
  for (const c of TIERED_GATED) assert.equal(r(c), 'card-unreadable', `must card: ${c}`);
});

test('text-only, inert and signal-free commands stay uncarded', () => {
  for (const c of TIERED_UNGATED) {
    assert.ok(['safe', 'other'].includes(r(c)), `must stay uncarded: ${c} -> ${r(c)}`);
  }
});

test('sed and git text-only forms are allowlisted, exec forms are not', () => {
  assert.equal(route.sedTextOnly(['s/a/b/g', 'f']), true);
  assert.equal(route.sedTextOnly(['-n', '1,20p', 'f']), true);
  assert.equal(route.sedTextOnly(['-i.bak', '/x/d', 'f']), true);
  for (const a of [['s/a/b/e'], ['s/a/b/w out'], ['s/a\\/b/c/eg'], ['1e date'], ['-f', 's.sed'], ['s/a/b/;e'], ['r /etc/passwd']]) {
    assert.equal(route.sedTextOnly(a), false, a.join(' '));
  }
  assert.equal(route.gitTextOnly(['commit', '-m', 'x']), true);
  assert.equal(route.gitTextOnly(['-C', 'repo', 'log', '--oneline']), true);
  for (const a of [['-c', 'a=b', 'log'], ['-p', 'log'], ['--exec-path=.', 'log'], ['rebase', '-x', 'y'],
    ['fetch', '--upload-pack=x'], ['push', '--rec=x'], ['grep', '-nOx', 'y'], ['submodule', 'foreach', 'y'], ['x']]) {
    assert.equal(route.gitTextOnly(a), false, a.join(' '));
  }
});

test('hook blocks chained strong-signal forms through non-inert programs', () => {
  for (const c of [
    `true; git -c alias.x='!./.claude/tools/Merl""in.exe --c""md' x ${BUDGET}`,
    `cd x && sed 's/.*/.\\/.claude\\/tools\\/Merl""in.exe --c""md &/e' <<< ${ESC_BUDGET}`,
    `cd x; find . -exec ./Merl""in.exe --c""md '{"action":"meta-push"}' \\;`,
  ]) assert.equal(runHook('Bash', c), 2, `hook must block: ${c}`);
  for (const c of ['cd .claude/tools && ls', 'cat docs/notes.md | grep -i merlin', 'cd "$HOME" && ls',
    'go build ./... && go vet ./...']) {
    assert.equal(runHook('Bash', c), 0, `hook must allow: ${c}`);
  }
});

test('tiered checks stay linear on 50KB pathological input', () => {
  for (const unit of ['git -c a ', "sed 's/a/b/' ", '> x ', '--cmd ', '.claude/tools ', '"\\"']) {
    const big = `git ${unit.repeat(Math.ceil(50000 / unit.length))}`;
    let t0 = Date.now();
    r(big);
    assert.ok(Date.now() - t0 < 1000, `router slow on ${unit}: ${Date.now() - t0}ms`);
    t0 = Date.now();
    runHook('Bash', `${big}; true`);
    assert.ok(Date.now() - t0 < 1000, `hook slow on ${unit}: ${Date.now() - t0}ms`);
  }
});

test('hook runs for PowerShell and Monitor commands too', () => {
  const chained = `.claude/tools/Merlin.exe --cmd ${SPEND}; Remove-Item x`;
  assert.equal(runHook('PowerShell', chained), 2);
  assert.equal(runHook('Monitor', chained), 2);
  const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude', 'settings.json'), 'utf8'));
  const m = settings.hooks.PreToolUse.find((h) => /block-api-bypass/.test(JSON.stringify(h.hooks)) && /Bash/.test(h.matcher));
  assert.ok(m && m.matcher.split('|').includes('PowerShell') && m.matcher.split('|').includes('Monitor'));
});

// ── (2) object id on the Bash spend card ─────────────────────────────

test('Bash budget card names the object the engine changes, same as MCP', () => {
  const cases = [
    ['meta-budget', '{"action":"meta-budget","adId":"120","campaignId":"9","dailyBudget":50}', 'meta_ads', 'ad set (120)'],
    ['meta-budget', '{"action":"meta-budget","campaignId":"9","dailyBudget":50}', 'meta_ads', 'campaign (9)'],
    ['snapchat-budget', '{"action":"snapchat-budget","targetAdSetId":"sq","campaignId":"c","dailyBudget":5}', 'snapchat', 'ad squad (sq)'],
    ['google-ads-budget', '{"action":"google-ads-budget","campaignId":"g1","dailyBudget":5}', 'google_ads', 'campaign (g1)'],
  ];
  for (const [action, json, tool, target] of cases) {
    const card = route.bashSpendCard(action, `.claude/tools/Merlin.exe --cmd '${json}'`);
    assert.equal(card.target, target);
    assert.equal(card.label, policy.budgetChangeCard(tool, JSON.parse(json)).label);
    assert.ok(card.label.endsWith(target));
  }
});

test('Bash spend card uses the LAST id the engine binds and strips unsafe characters', () => {
  const card = route.bashSpendCard('meta-budget',
    `Merlin.exe --cmd '{"action":"meta-budget","adId":"111","adId":"222‮​","dailyBudget":9}'`);
  assert.equal(card.target, 'ad set (222)');
  assert.doesNotMatch(card.label, /[‮​]/);
  const long = route.bashSpendCard('meta-push', `Merlin.exe --cmd '{"action":"meta-push","campaignId":"${'9'.repeat(200)}"}'`);
  assert.ok(long.target.length <= 'campaign ()'.length + 64);
});

test('non-budget spend actions get the target line, none when no id is given', () => {
  assert.deepEqual(route.bashSpendCard('meta-activate', `Merlin.exe --cmd '{"action":"meta-activate","campaignId":"c7"}'`),
    { label: null, target: 'campaign (c7)' });
  assert.deepEqual(route.bashSpendCard('tiktok-push', `Merlin.exe --cmd '{"action":"tiktok-push"}'`),
    { label: null, target: '' });
  const none = route.bashSpendCard('meta-budget', `Merlin.exe --cmd '{"action":"meta-budget","dailyBudget":9}'`);
  assert.match(none.label, /no campaign or ad set id given/);
});

// ── (3) other shell tools and the throw path ─────────────────────────

test('every shell-shaped tool is routed, MCP tools and file tools are not', () => {
  for (const t of ['Bash', 'PowerShell', 'Monitor']) assert.equal(route.isShellTool(t, { command: 'ls' }), true, t);
  assert.equal(route.isShellTool('SomeFutureShell', { command: 'ls' }), true, 'unknown command-shaped tools fail closed');
  assert.equal(route.isShellTool('mcp__merlin__meta_ads', { command: 'x' }), false);
  assert.equal(route.isShellTool('Read', { file_path: 'x' }), false);
});

test('PowerShell engine calls card; signal-free commands keep their route', () => {
  const ps = (c) => route.routeShellTool('PowerShell', c).route;
  assert.equal(ps(`& .claude/tools/Merlin.exe --cmd ${SPEND}`), 'spend');
  assert.equal(ps('$b=".claude/tools/Mer"+"lin.exe"; & $b -cmd x'), 'card-unreadable');
  assert.equal(ps('& (Join-Path tools "Mer$("lin").exe") -c`md x'), 'card-unreadable');
  assert.equal(ps('Start-Process merlin -ArgumentList x'), 'card-unreadable');
  assert.equal(ps('Get-ChildItem'), 'other');
  assert.equal(ps('ls'), 'safe');
  // Monitor runs bash: same decision as the Bash tool.
  for (const c of REPRODUCERS) assert.equal(route.routeShellTool('Monitor', c).route, 'card-unreadable');
});

test('a throw or a missing decision in the approval path denies (fail closed)', async () => {
  const errors = [];
  const sync = route.failClosedApproval(() => { throw new Error('boom'); }, (e, t) => errors.push([e.message, t]));
  assert.equal((await sync('Bash', { command: 'ls' })).behavior, 'deny');
  const rejected = route.failClosedApproval(async () => { throw new Error('later'); });
  assert.equal((await rejected('Bash', {})).behavior, 'deny');
  const empty = route.failClosedApproval(async () => undefined);
  assert.equal((await empty('Bash', {})).behavior, 'deny');
  // The router itself throwing (forced) is caught the same way.
  const orig = route.routeShellTool;
  const throwing = route.failClosedApproval(async (t, i) => { if (orig.call(null, t, i.command)) throw new TypeError('forced'); });
  assert.equal((await throwing('Bash', { command: 'ls' })).behavior, 'deny');
  assert.deepEqual(errors, [['boom', 'Bash']]);
  const ok = route.failClosedApproval(async (t, i) => ({ behavior: 'allow', updatedInput: i }));
  assert.equal((await ok('Read', { file_path: 'x' })).behavior, 'allow');
});

test('main.js wires the fail-closed wrapper, the shell-tool route and disables PowerShell', () => {
  // Wiring only: the decisions themselves are exercised above.
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.match(src, /canUseTool: bashApprovalRoute\.failClosedApproval\(handleToolApproval/);
  assert.match(src, /disallowedTools: \['PowerShell'\]/);
  assert.match(src, /CLAUDE_CODE_USE_POWERSHELL_TOOL: '0'/);
  assert.match(src, /bashApprovalRoute\.isShellTool\(toolName, input\)/);
  assert.match(src, /bashApprovalRoute\.routeShellTool\(\(opts && opts\.shellTool\) \|\| 'Bash'/);
});
