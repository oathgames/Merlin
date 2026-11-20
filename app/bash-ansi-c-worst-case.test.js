// REGRESSION GUARD (2026-11-20, bash-approval-followup review 3)
//
// Three review rounds each desynced the context-aware ANSI-C decoder's
// quote / comment lexer from real bash. routeBash and the PreToolUse hook now
// also read the command CONTEXT-FREE: backslash-newline removed first, then
// every $' anywhere decoded with full bash rules and substituted, whatever
// quote, comment, here-doc or expansion it sits in. The most restrictive
// reading wins, and a reading other than the context-aware one can only add
// a card. Every engine call below was run in real bash against an
// echo-args fake Merlin.exe and does reach the engine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const route = require('./bash-approval-route');
const action = require('./bash-merlin-action');

const S = String.raw;
const NL = '\n';
const BSNL = '\\\n';
const DOLLAR = '$';
const BRACE_HASH = DOLLAR + '{x:- # }';
const r = (c) => route.routeBash(c).route;
const CARDED = new Set(['spend', 'destructive', 'card-unreadable', 'deny-ambiguous']);
const cards = (c) => CARDED.has(r(c));

const HOOK = path.join(__dirname, '..', '.claude', 'hooks', 'block-api-bypass.js');
const HOOK_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-hook-worst-'));
test.after(() => { try { fs.rmSync(HOOK_CWD, { recursive: true, force: true }); } catch {} });
function runHook(command) {
  const env = { ...process.env };
  delete env.TOOL_INPUT;
  delete env.TOOL_NAME;
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    env, cwd: HOOK_CWD, encoding: 'utf8',
  }).status;
}

const ENGINE_X = S`./$'Merl\x69n.exe' $'\x2d\x2dcmd' $'{"\x61ction":"meta-budget","adId":"1","dailyBudget":900}'`;

// The four review reproducers (rb4/c2.txt cases 0, 1, 2, 5).
const REPRO = {
  braceHashU: S`cd .claude/tools && : ` + BRACE_HASH + S` ; ./$'Mer\u6cin.exe' $'\u2d\u2d'cmd $'{"a\u63tion":"meta-budge\u74","adId":"1","dailyBudget":900}'`,
  continuationU: 'cd .claude/tools && ./$' + BSNL + S`'Mer\u6cin.exe' $` + BSNL + S`'\u2d\u2d'cmd $` + BSNL +
    S`'{"a\u63tion":"meta-budge\u74","adId":"1","dailyBudget":900}'`,
  braceHashX: S`cd .claude/tools && : ` + BRACE_HASH + S` ; ` + ENGINE_X,
  continuationPush: 'cd .claude/tools; ./$' + BSNL + S`'Mer\u6cin.exe' $` + BSNL + S`'\u2d\u2d'cmd $` + BSNL +
    S`'{"a\u63tion":"meta-pus\u68"}'`,
};

test('the review reproducers card as the real spend action and the hook blocks them', () => {
  const want = { braceHashU: 'meta-budget', continuationU: 'meta-budget', braceHashX: 'meta-budget', continuationPush: 'meta-push' };
  for (const [name, c] of Object.entries(REPRO)) {
    const out = route.routeBash(c);
    assert.equal(out.route, 'spend', name);
    assert.equal(out.action, want[name], name);
    if (want[name] === 'meta-budget') assert.equal(action.lastNumber(out.cmdText, 'dailyBudget'), 900, name);
    assert.equal(runHook(c), 2, `hook must block: ${name}`);
  }
});

test('# that bash does not treat as a comment cannot hide an ANSI-C engine call', () => {
  for (const c of [
    S`: ` + BRACE_HASH + S` ; ` + ENGINE_X,
    S`echo ` + DOLLAR + S`{x:-#} ; ./$'Mer\u6cin.exe' $'\u2d'cmd x`,
    S`: $(( 1 # 2 )) ; ` + ENGINE_X,
    S`[[ a =~ # ]] ; ` + ENGINE_X,
    S`x=a#b # it's` + NL + ENGINE_X,
  ]) {
    assert.ok(cards(c), `must card: ${c} (got ${r(c)})`);
    assert.equal(runHook(c), 2, `hook must block: ${c}`);
  }
});

test('backslash-newline is removed before reading, as bash does', () => {
  assert.equal(route.stripLineContinuations('a' + BSNL + 'b'), 'ab');
  assert.equal(route.stripLineContinuations('a\\\r\nb'), 'ab');
  // An escaped backslash before the newline is not a continuation.
  assert.equal(route.stripLineContinuations('a\\\\\nb'), 'a\\\\\nb');
  assert.equal(route.stripLineContinuations('a\\\\\\\nb'), 'a\\\\b');
  const c = './$' + BSNL + S`'Mer\u6cin.exe' --cmd '{"action":"meta-push"}'`;
  assert.equal(route.routeBash(c).route, 'spend');
  assert.equal(route.routeBash(c).action, 'meta-push');
  // `echo a\\<newline>engine` runs the engine on the second line.
  assert.ok(cards('echo a\\\\\n.claude/tools/Merlin.exe --cmd \'{"action":"meta-push"}\''));
  // A comment ending in a backslash does not continue onto the next line.
  assert.ok(cards('true # c \\\n.claude/tools/Merlin.exe --cmd \'{"action":"meta-push"}\''));
});

test('short \\u and \\x forms and $\' adjacency decode as bash does', () => {
  assert.equal(route.worstCaseAnsiC(S`$'\u6c\x6'`).text, "'l\x06'");
  for (const [c, act] of [
    [S`.claude/tools/$'Mer\u6cin.exe' $'\x2d\u2d'cmd '{"action":"meta-push"}'`, 'meta-push'],
    [S`.claude/tools/M$'\x65'rlin.exe --cmd '{"action":"meta-push"}'`, 'meta-push'],
    [S`.claude/tools/Merlin.exe --cmd $'{"action":"meta-budg\U65t","adId":"1","dailyBudget":900}'`, 'meta-budget'],
  ]) {
    const out = route.routeBash(c);
    assert.equal(out.route, 'spend', c);
    assert.equal(out.action, act, c);
  }
});

test('ANSI-C inside a here-doc fed to a shell, or inside eval, cards', () => {
  for (const c of [
    "cat <<'EOF' | sh\n" + S`.claude/tools/$'Merl\x69n.exe' --cmd '{"action":"meta-push"}'` + '\nEOF',
    'bash <<EOF\n' + S`.claude/tools/\$'Merl\x69n.exe' --cmd '{"action":"meta-push"}'` + '\nEOF',
    'cat <<EOF | bash\n' + S`.claude/tools/$'Merl\x69n.exe' $'\x2d\x2dcmd' x` + '\nEOF',
    S`eval "./.claude/tools/\$'Merl\x69n.exe' --cmd 'x'"`,
    S`eval "$'\x2e'claude/tools/Merlin.exe --cmd x"`,
  ]) {
    assert.ok(cards(c), `must card: ${JSON.stringify(c)} (got ${r(c)})`);
  }
});

test('worstCaseAnsiC decodes every $\' with no context', () => {
  // Inside double quotes, inside a comment, after an escaped $: all decoded.
  assert.equal(route.worstCaseAnsiC(S`echo "$'\x41'" # $'\x42'`).text, `echo "'A'" # 'B'`);
  assert.equal(route.worstCaseAnsiC(S`x \$'\x41'`).text, "x \\'A'");
  assert.equal(route.worstCaseAnsiC(S`$'it\'s'`).text, "'it'\\''s'");
  for (const c of [S`$'\x00'`, S`$'\xff'`, S`$'\u'`, S`$'\c'`, "$'open"]) {
    assert.equal(route.worstCaseAnsiC(c).failed, true, c);
  }
  assert.equal(route.worstCaseAnsiC('no ansi').failed, false);
});

test('an undecodable naive $\' body cards only alongside an engine signal or unresolvable program', () => {
  // The comment hides $'\xff' from the context-aware decoder, not from the
  // context-free one, and an engine call follows.
  assert.equal(r("# $'\\xff'\n.claude/tools/Merlin.exe --version"), 'card-unreadable');
  assert.equal(r("$X '$'"), 'card-unreadable');
  // No signal, resolvable programs: unchanged.
  assert.ok(!cards("echo '$'"));
  assert.ok(!cards("git commit -m 'costs $'"));
});

test('a worst-case reading never makes a result less restrictive', () => {
  const push = `.claude/tools/Merlin.exe --cmd '{"action":"meta-push"}'`;
  assert.equal(r(push), 'spend');
  assert.ok(cards(push + S` # $'\x41'`));
  // A $' the worst case decodes differently (inside double quotes) keeps the
  // spend card and its action.
  const dq = push + ` && echo "$'abc'"`;
  assert.notEqual(route.worstCaseAnsiC(dq).text, route.decodeAnsiC(dq).text);
  assert.equal(r(dq), 'spend');
  assert.equal(route.routeBash(dq).action, 'meta-push');
  // Two readings that disagree on the action card as unreadable.
  const disagree = S`.claude/tools/Merlin.exe --cmd '{"action":"meta-push","x":"$'}' ; .claude/tools/Merlin.exe --cmd '{"action":"meta-budget"}'`;
  assert.ok(cards(disagree));
});

test('ordinary commands stay uncarded', () => {
  const heredoc = "cat > notes.md <<'EOF'\n# Release notes\n\nIt's the team's build. Don't ship.\n## What's new\nEOF";
  const heredoc2 = "cat > notes.md <<EOF\n# Heading\nit's fine, isn't it\nEOF";
  for (const c of ['cd "$HOME" && ls', 'echo $PATH', 'git commit -m "fix meta-push action"',
    `git commit -m "don't break # things"`, `grep '"action":"meta-push"' file`,
    `rg -n '"action": *"meta-push"' app/`, 'npm test', S`echo $'a\tb'`,
    `echo "it's" # fine`, 'ls .claude/tools/*.exe', 'node script.js', "git log --oneline # what's new",
    heredoc, heredoc2]) {
    assert.ok(!cards(c), `must not card: ${JSON.stringify(c)} (got ${r(c)})`);
  }
  assert.equal(r('cd "$HOME" && ls'), 'safe');
  assert.equal(r('echo $PATH'), 'safe');
  assert.equal(r(S`echo $'a\tb'`), 'safe');
  assert.equal(r(`echo "it's" # fine`), 'safe');
  for (const c of [`echo "it's" # fine`, "git log --oneline # what's new", heredoc, S`printf $'\x41\n'`, 'cd "$HOME" && ls']) {
    assert.equal(runHook(c), 0, `hook must allow: ${JSON.stringify(c)}`);
  }
});

// REGRESSION GUARD (2026-11-20, bash-approval-followup review 4): a1 / a3
// were verified in real bash against the echo-args fake engine; both reach
// it. a1 routed 'other' and passed the hook; a3 carded but passed the hook.
const U_ENGINE = S`eval $'\U2e/Mer\U6cin.exe \U2d\U2d\U63md \x27{"\U61\U63tion":"meta-budget","adId":"1","dailyBudget":900}\x27'`;
const REVIEW4 = {
  a1: 'echo hi # note ' + BSNL + ": '$' ; " + U_ENGINE,
  a2: ": '$' ; " + U_ENGINE,
  a3: 'echo hi # note ' + BSNL + U_ENGINE,
};

test('review 4: a comment continuation and an overlapping $\' cannot hide an engine call', () => {
  for (const [name, c] of Object.entries(REVIEW4)) {
    assert.ok(cards(c), `${name} must card (got ${r(c)})`);
    assert.equal(runHook(c), 2, `${name}: hook must block`);
  }
});

test('review 4 layer A: $\' with a character-code escape always cards', () => {
  for (const c of [
    S`printf $'\x41\n'`, S`echo $'\u00e9'`, S`echo $'\U41'`, S`echo $'\101'`, S`echo $'\cA'`,
    S`echo '$' \x41`, // context does not matter: $' then an escape anywhere after it
    'echo $' + BSNL + S`'\x41'`, // only visible once backslash-newline is removed
  ]) {
    assert.equal(route.ansiCCharCodeBackstop(c), true, c);
    assert.ok(cards(c), `must card: ${JSON.stringify(c)} (got ${r(c)})`);
  }
  // Separator or newline: the hook blocks; a single simple command keeps the
  // hook's single-command policy (the router cards it).
  for (const c of [S`printf $'\x41\n'; ls`, S`echo $'\x41'` + NL + 'ls', S`ls && echo $'\101'`]) {
    assert.equal(runHook(c), 2, `hook must block: ${JSON.stringify(c)}`);
  }
  assert.equal(runHook(S`printf $'\x41\n'`), 0);
  for (const c of [S`echo $'\n'`, S`echo $'a\tb'`, S`IFS=$'\n'`, S`git commit -m $'line1\nline2'`,
    S`grep -P '\x41|\d+' file`, S`echo $'it\'s'`]) {
    assert.equal(route.ansiCCharCodeBackstop(c), false, c);
    assert.ok(!cards(c), `must not card: ${JSON.stringify(c)} (got ${r(c)})`);
  }
  assert.equal(runHook(S`IFS=$'\n'; ls`), 0);
});

test('review 4 layer B: the worst case is read from every $\' alignment', () => {
  // The $' inside '$' swallows the real body in the reading from the first $'.
  const w0 = route.worstCaseAnsiC(": '$' ; ./$'Mer\\x6cin.exe' x");
  assert.ok(!/Merlin\.exe/.test(w0.text));
  const w1 = route.worstCaseAnsiC(": '$' ; ./$'Mer\\x6cin.exe' x", 10);
  assert.ok(/'Merlin\.exe'/.test(w1.text), w1.text);
  // Readings that disagree (the misaligned one sees an unresolvable program,
  // the aligned ones the real action) card as unreadable.
  const c = ": '$' ; .claude/tools/$'Mer\\x6cin.exe' --cmd '{\"action\":\"meta-push\"}'";
  assert.equal(r(c), 'card-unreadable');
  assert.equal(runHook(c), 2);
  // One alignment per distinct body boundary: a $' the first reading already
  // decoded as a body start adds no reading.
  assert.deepEqual(route.worstCaseAnsiC(S`$'\x41' $'\x42'`).starts, [0, 8]);
  assert.deepEqual(route.worstCaseAnsiC("$'$'$'").starts, [0, 4]);
});

test('review 4 layer C: continuations are not joined inside a comment or quote', () => {
  assert.equal(route.stripLineContinuationsOutsideComments('a # c ' + BSNL + 'b'), 'a # c ' + BSNL + 'b');
  assert.equal(route.stripLineContinuationsOutsideComments("echo 'x" + BSNL + "y'"), "echo 'x" + BSNL + "y'");
  assert.equal(route.stripLineContinuationsOutsideComments('a' + BSNL + 'b # c'), 'ab # c');
  assert.equal(route.stripLineContinuationsOutsideComments('a' + BSNL + '#b'), 'a#b');
  assert.equal(route.joinAllContinuations('a\\\\' + NL + 'b' + '\\\r\nc'), 'a\\bc');
  const push = `.claude/tools/Merlin.exe --cmd '{"action":"meta-push"}'`;
  // Joined, line 2 is comment text; not joined (as bash reads it), it runs
  // the engine. The readings disagree, so the command cards.
  const c = 'true # c ' + BSNL + push;
  assert.equal(r(c), 'card-unreadable');
  assert.equal(runHook(c), 2);
});

test('review 4: ordinary multi-line and commented commands stay uncarded', () => {
  const heredoc = "cat > notes.md <<'EOF'\n# Release notes\n\nIt's the team's build. Don't ship.\n## What's new\nEOF";
  for (const c of ['git log ' + BSNL + ' --oneline', "git log --oneline # what's new", heredoc,
    S`grep -P '\x41|\d+' file`, 'echo hi # note ' + BSNL + 'ls']) {
    assert.ok(!cards(c), `must not card: ${JSON.stringify(c)} (got ${r(c)})`);
    assert.equal(runHook(c), 0, `hook must allow: ${JSON.stringify(c)}`);
  }
});

test('review 4 self-attack: shell code assembled at run time cards', () => {
  const built = {
    s1: S`d=\$; eval "$d'./Mer\U6cin.exe' $d'\U2d\U2d\U63md' $d'{\"\U61ction\":\"meta-push\"}'"`,
    s3: S`eval "$(printf '\44')'./Mer\U6cin.exe' $(printf '\44')'\U2d\U2d\U63md' x"`,
    s4: S`e=eval; d=\$; $e "@{d}'./Mer\U6cin.exe' @{d}'\U2d\U2d\U63md' @{d}'{\"\U61\U63tion\":\"meta-\U70ush\"}'"`.replace(/@{/g, DOLLAR + "{"),
    s7: S`x=; eval "./Mer@{x}lin.exe --c@{x}md '{\"act@{x}ion\":\"meta-push\"}'"`.replace(/@{/g, DOLLAR + "{"),
    s8: S`x=; bash -c "./Mer@{x}lin.exe --c@{x}md x"`.replace(/@{/g, DOLLAR + "{"),
  };
  for (const [k, c] of Object.entries(built)) {
    assert.ok(cards(c), `${k} must card (got ${r(c)})`);
  }
  assert.equal(runHook(built.s1), 2);
  assert.equal(runHook(built.s3), 2);
  for (const c of ['eval "$(ssh-agent -s)"', 'bash -c "echo $HOME"', 'sh scripts/build.sh', S`printf '\x41\n'`]) {
    assert.equal(runHook(c), 0, `hook must allow: ${JSON.stringify(c)}`);
  }
});

test('pathological 50KB inputs finish well under a second', () => {
  const inputs = [
    '\\'.repeat(50000),
    ('\\'.repeat(999) + '\n').repeat(50),
    "$'".repeat(25000),
    S`$'\x41'`.repeat(7000),
    S`$'\u` .repeat(12500),
    ('a #' + "'").repeat(12500),
    ('\\\n').repeat(25000) + "$'x",
    ('"${').repeat(16000),
    "$'" + 'a'.repeat(50000),
    ("'$'" + S` $'\x41' `).repeat(5000),
    ('# c ' + BSNL + S`$'$'\U41'`).repeat(4000),
    ("$'$" + "'$$'").repeat(8000),
    (REVIEW4.a1 + NL).repeat(250),
  ];
  for (const c of inputs) {
    const t0 = process.hrtime.bigint();
    route.routeBash(c);
    route.worstCaseAnsiC(c);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 500, `${JSON.stringify(c.slice(0, 12))} took ${ms}ms`);
  }
});
