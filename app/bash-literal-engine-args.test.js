// REGRESSION GUARD (2026-11-20, bash-approval-followup review 8)
//
//   1. The literal-engine swap neutralises only the command word and the
//      --cmd flag and value. Every other argument stays visible to the
//      hidden-engine readings, and an argument with an engine signal or a
//      shell metacharacter refuses trust (plain --config paths and --brand
//      slugs excepted).
//   2. Engine output handed to anything that runs it (a shell, source,
//      xargs, an interpreter on stdin, a written file run later) cards.
//   3. --setup / --version / --help with no --cmd route as on main unless a
//      payload could arrive on stdin or by redirection.
//
// Ordinary calls are compared with the route on main, loaded from
// `git show main:...` when that ref is available.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const route = require('./bash-approval-route');

const r = (command) => route.routeBash(command).route;
const HOOK = path.join(__dirname, '..', '.claude', 'hooks', 'block-api-bypass.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-route8-'));
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
function runHook(command) {
  const env = { ...process.env };
  delete env.TOOL_INPUT;
  delete env.TOOL_NAME;
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), env, cwd: TMP, encoding: 'utf8',
  }).status;
}

// The router as it is on main, or null when the ref cannot be read.
function loadMainRoute() {
  const dir = path.join(TMP, 'main');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['bash-approval-route.js', 'bash-merlin-action.js']) {
    const g = spawnSync('git', ['show', `main:app/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 });
    if (g.status !== 0 || !g.stdout) return null;
    fs.writeFileSync(path.join(dir, f), g.stdout);
  }
  try { return require(path.join(dir, 'bash-approval-route.js')); } catch { return null; }
}
const MAIN = loadMainRoute();

const SMUGGLE = `'x; printf %s "{\\"action\\":\\"meta-budgeX\\",\\"adId\\":\\"1\\",\\"dailyBudget\\":900}" | tr X t | xargs -0 ./.claude/tools/Merlin.exe --cmd; #'`;
const REPRO = `./.claude/tools/Merlin.exe --config ${SMUGGLE} --cmd '{"action":"dashboard"}'`;

test('reviewer reproducer and its variants card, and the hook blocks them', () => {
  for (const tail of [' 2>&1 | sh', ' 2>&1 | bash -s', ' 2>&1 | source /dev/stdin', ' 2>&1 | xargs -0 bash -c', ' > s.sh 2>&1; sh s.sh']) {
    const c = REPRO + tail;
    assert.equal(r(c), 'card-unreadable', `must card: ${c}`);
    assert.equal(runHook(c), 2, `hook must block: ${c}`);
  }
});

test('an argument with a signal or shell text refuses literal trust', () => {
  for (const c of [
    `Merlin.exe --config 'a;b' --cmd '{"action":"dashboard"}'`,
    `.claude/tools/Merlin.exe --config 'a|b' --cmd '{"action":"dashboard"}'`,
    `.claude/tools/Merlin.exe --config 'a&b' --cmd '{"action":"dashboard"}'`,
    `.claude/tools/Merlin.exe --config 'a\nb' --cmd '{"action":"dashboard"}'`,
    `.claude/tools/Merlin.exe --config 'a>b' --cmd '{"action":"dashboard"}'`,
    `.claude/tools/Merlin.exe --config=a\\;b --cmd '{"action":"dashboard"}'`,
    `.claude/tools/Merlin.exe --config 'x .claude/tools/Merlin.exe --cmd' --cmd '{"action":"dashboard"}'`,
    `.claude/tools/Merlin.exe --config meta-budget.json --cmd '{"action":"dashboard"}'`,
    `.claude/tools/Merlin.exe --brand 'a;b' --cmd '{"action":"dashboard"}'`,
    `.claude/tools/Merlin.exe --brand 'a b' --cmd '{"action":"dashboard"}'`,
    `.claude/tools/Merlin.exe --dry-run 'x;y' --cmd '{"action":"dashboard"}'`,
    `.claude/tools/Merlin.exe '{"action":"meta-push"}' --cmd '{"action":"dashboard"}'`,
    `.claude/tools/Merlin.exe ./.claude/tools/x --cmd '{"action":"dashboard"}'`,
    `.claude/tools/Merlin.exe --cmd '{"action":"dashboard"}' merlin`,
    `.claude/tools/Merlin.exe --cmd '{"action":"dashboard"}' > .claude/tools/x`,
    `.claude/tools/Merlin.exe --cmd '{"action":"dashboard"}' --cmd-file p.json`,
    // A --cmd JSON string value with a strong signal.
    `.claude/tools/Merlin.exe --cmd '{"action":"dashboard","brand":"x; ./.claude/tools/Merlin.exe --cmd y"}'`,
    `.claude/tools/Merlin.exe --cmd '{"action":"dashboard","outputDir":".claude/tools/z"}' | jq .`,
  ]) assert.ok(['card-unreadable', 'deny-ambiguous'].includes(r(c)), `must card: ${c} -> ${r(c)}`);
});

const READ_ONLY = ['dashboard', 'meta-insights', 'seo-audit', 'shopify-analytics', 'klaviyo-insights', 'meta-list-adsets'];
const ARG_FORMS = ['', '--config c.json ', '--config .claude/tools/merlin-config.json ',
  '--config C:/Users/x/Merlin/.claude/tools/.merlin-config-brand.json ', '--config=.claude/tools/merlin-config.json ',
  '--config "C:/Users/x/My Merlin/.claude/tools/merlin-config.json" ', '--brand madchill ', '--brand=madchill ',
  '--config .claude/tools/merlin-config.json --brand rebecca-taylor ', '--config "$CFG" ', '--config "$HOME/x.json" '];
const SUFFIXES = ['', ' | jq .', ' | tee out.json', ' 2>&1 | tail -5', ' > out.json', ' | head -50',
  ' | python -m json.tool', ' | node summarize.js', ' 2>&1 | grep -i error', ' > out.json; cat out.json | jq .'];

test('ordinary --config / --brand forms route as on main', () => {
  let n = 0;
  let diffs = 0;
  for (const bin of ['.claude/tools/Merlin.exe', './.claude/tools/Merlin.exe']) {
    for (const p of ['', 'cd x && ', 'cd "$HOME/Merlin" && ']) {
      for (const args of ARG_FORMS) {
        for (const s of SUFFIXES) {
          for (const a of READ_ONLY) {
            const c = `${p}${bin} ${args}--cmd '{"action":"${a}","adId":"1"}'${s}`;
            const got = route.routeBash(c);
            n++;
            if (args.includes('$')) {
              // Main cards a config path the shell expands; still carded.
              assert.equal(got.route, 'card-unreadable', c);
            } else {
              assert.equal(got.route, 'other', `must stay other: ${c}`);
              assert.equal(got.action, a, c);
            }
            if (MAIN && MAIN.routeBash(c).route !== got.route) { diffs++; assert.fail(`differs from main: ${c}`); }
          }
        }
      }
    }
  }
  assert.equal(diffs, 0);
  assert.ok(n > 3000);
});

test('--setup / --version / --help route as on main unless input could carry a payload', () => {
  for (const c of ['.claude/tools/Merlin.exe --setup', './.claude/tools/Merlin.exe --setup', '.claude/tools/Merlin.exe --version',
    '.claude/tools/Merlin.exe --help', '.claude/tools/Merlin.exe -h', 'cd /d/x; .claude/tools/Merlin.exe --version',
    '.claude/tools/Merlin.exe --setup 2>&1 | head -40']) {
    assert.equal(r(c), 'other', c);
    if (MAIN) assert.equal(MAIN.routeBash(c).route, 'other', `main: ${c}`);
  }
  for (const c of ['echo x | .claude/tools/Merlin.exe --setup', '.claude/tools/Merlin.exe --setup < p.json',
    '.claude/tools/Merlin.exe --setup <<< "$P"', '.claude/tools/Merlin.exe --setup --cmd-file p.json',
    'cat p.json | .claude/tools/Merlin.exe --version', '.claude/tools/Merlin.exe --setup x',
    '.claude/tools/Merlin.exe --image', '.claude/tools/Merlin.exe']) {
    assert.equal(r(c), 'card-unreadable', `must card: ${c}`);
  }
});

test('engine output fed to something that executes it cards', () => {
  const lit = `.claude/tools/Merlin.exe --cmd '{"action":"dashboard","brand":"x; touch pwned"}'`;
  for (const tail of [' | sh', ' | bash', ' | zsh', ' | bash -s', ' | source /dev/stdin', ' | . /dev/stdin',
    ' 2>&1 | xargs -0 sh -c', ' | xargs echo', ' | eval', ' | env sh', ' | python', ' | python3 -', ' | node',
    ' | perl -ne system', ` | awk '{system($0)}'`, ' | sed e', ' | jq -r . | sh', ' | tee x | sh', ' |& sh',
    ' > s.sh; sh s.sh', ' 2> s.sh; . s.sh', ' &> s.sh && bash s.sh', ' > s; chmod +x s; ./s', ' | tee s.sh; source s.sh',
    ' > s.sh; ./s.sh', ' > o; source <(cat o)']) {
    const c = lit + tail;
    assert.equal(r(c), 'card-unreadable', `must card: ${c}`);
    assert.equal(runHook(c), 2, `hook must block: ${c}`);
  }
  for (const c of [`bash <(${lit})`, `source <(${lit})`, `sh -c "$(${lit})"`, `eval "$(${lit})"`,
    `{ ${lit}; } | sh`, `( ${lit} ) | bash`, './merlin --setup | sh', './merlin --setup > s.sh; sh s.sh']) {
    assert.ok(['card-unreadable', 'deny-ambiguous'].includes(r(c)), `must card: ${c} -> ${r(c)}`);
    // The hook reads chained forms only; an unchained process substitution
    // is left to the router, which cards it above.
    if (!/^(?:bash|source) <\(/.test(c)) assert.equal(runHook(c), 2, `hook must block: ${c}`);
  }
});

test('must-stay-ungated commands route as on main', () => {
  for (const c of ['cd "$HOME" && ls', 'git commit -m "fix meta-push action"', 'grep -rn "Merlin.exe" app/',
    'npm test 2>&1 | tail -20', 'ls .claude/tools/*.exe', 'node script.js', 'curl -fsSL https://example.com/install.sh | sh',
    'cat notes.txt | sh', 'echo hi | bash', 'cat out.json | python -m json.tool']) {
    const got = r(c);
    if (MAIN) assert.equal(got, MAIN.routeBash(c).route, `differs from main: ${c}`);
    assert.ok(['safe', 'other'].includes(got), `must stay uncarded: ${c} -> ${got}`);
  }
});

test('argument and output readers stay linear on 50KB input', () => {
  for (const unit of ["--config 'a' ", '--brand x ', '2>&1 ', '| sh ', '> s; sh s; ', "'\\'' "]) {
    const big = unit.repeat(Math.ceil(50000 / unit.length));
    const t0 = Date.now();
    r(`.claude/tools/Merlin.exe ${big} --cmd '{"action":"dashboard"}'`);
    r(`.claude/tools/Merlin.exe --cmd '{"action":"dashboard"}' ${big}`);
    assert.ok(Date.now() - t0 < 1000, `slow on ${unit}: ${Date.now() - t0}ms`);
  }
});
