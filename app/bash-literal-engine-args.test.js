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
//   4. (review 9) shell text inside the single-quoted --cmd JSON is inert;
//      a positional, `--` or unknown flag before --cmd refuses trust.
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
  for (const unit of ["--config 'a' ", '--brand x ', '2>&1 ', '| sh ', '> s; sh s; ', "'\\'' ", 'a ', '`$(;# ']) {
    const big = unit.repeat(Math.ceil(50000 / unit.length));
    const t0 = Date.now();
    r(`.claude/tools/Merlin.exe ${big} --cmd '{"action":"dashboard"}'`);
    r(`.claude/tools/Merlin.exe --cmd '{"action":"dashboard"}' ${big}`);
    r(`.claude/tools/Merlin.exe --cmd '{"action":"blog-post","body":"${big.replace(/'/g, '')}"}' | jq .`);
    r(`cd ${big.replace(/\s/g, 'x')} && .claude/tools/Merlin.exe --cmd`);
    assert.ok(Date.now() - t0 < 1000, `slow on ${unit}: ${Date.now() - t0}ms`);
  }
});

// REGRESSION GUARD (2026-11-20, bash-approval-followup review 9), part 1:
// shell text inside the single-quoted --cmd JSON is inert and must not
// refuse the literal swap (it carded content calls that route 'other' on
// main); the same text outside that one quoted word keeps the strict reading.
const AD_COPY = ['use `code` here', 'costs $(5) today', 'a; b & c | d $HOME (x) <y> #z `w` $(v)',
  '50% off! Shop now; save $$ (today) #1 <3 & more | `wow`', 'line1\nline2 `x` # not a comment', 'tabs\there `x`'];
test('shell text inside single-quoted --cmd JSON routes as on main', () => {
  let n = 0;
  for (const body of AD_COPY) {
    for (const p of ['', 'cd x && ', 'cd ~/Merlin && ']) {
      for (const a of ['', '--config .claude/tools/merlin-config.json ', '--brand madchill ', '--dry-run ']) {
        for (const s of ['', ' | jq .', ' 2>&1 | tail -5', ' | head -50', ' | tee out.json', ' 2>&1 | grep -i error']) {
          for (const act of ['blog-post', 'dashboard', 'seo-audit']) {
            const c = `${p}.claude/tools/Merlin.exe ${a}--cmd '{"action":"${act}","body":${JSON.stringify(body)}}'${s}`;
            const got = route.routeBash(c);
            n++;
            assert.equal(got.route, 'other', `must stay other: ${c}`);
            assert.equal(got.action, act, c);
            if (MAIN) assert.equal(MAIN.routeBash(c).route, 'other', `main: ${c}`);
          }
        }
      }
    }
  }
  assert.ok(n > 1000);
});

test('the relaxation never covers text outside the single-quoted JSON', () => {
  const B = '{"action":"blog-post","body":"`x`"}';
  for (const c of [
    // Double quotes: expansions are live, strict as before.
    '.claude/tools/Merlin.exe --cmd "{\\"action\\":\\"blog-post\\",\\"body\\":\\"use `code` here\\"}"',
    '.claude/tools/Merlin.exe --cmd "{\\"action\\":\\"blog-post\\",\\"body\\":\\"costs $(5) today\\"}"',
    // Glued to the quoted word, or a second quoted word.
    `./.claude/tools/Merlin.exe --cmd ''"$(./.claude/tools/Merlin.exe --cmd '{"action":"meta-budget","adId":"1","dailyBudget":900}')"`,
    `./.claude/tools/Merlin.exe --cmd '{"action":"dashboard"}'$(./.claude/tools/Merlin.exe --cmd '{"action":"meta-budget","adId":"1","dailyBudget":900}')`,
    `.claude/tools/Merlin.exe --cmd '{"action":"blog-post","b":"x"}'"\`./.claude/tools/Merlin.exe --cmd y\`"`,
    `.claude/tools/Merlin.exe --cmd '{"action":"blog-post","b":"$"}'\\x41`,
    `.claude/tools/Merlin.exe --cmd='${B}'`,
    // A quote opened before the engine call or before --cmd.
    `echo ' .claude/tools/Merlin.exe --cmd '{"action":"dashboard","x":"\`.claude/tools/Merlin.exe --cmd x\`"}'`,
    `.claude/tools/Merlin.exe --config 'a --cmd ' '{"action":"dashboard","b":"\`x\`"}' --cmd '{"action":"dashboard"}'`,
    // Outside the span: comment, CR, $' char code, here-doc, executing tail.
    `.claude/tools/Merlin.exe --cmd '${B}' # \`y\``,
    `.claude/tools/Merlin.exe --cmd '${B}'\r./.claude/tools/Merlin.exe --cmd '{"action":"meta-budget","adId":"1","dailyBudget":900}'`,
    `.claude/tools/Merlin.exe --cmd '${B}' | jq . $'\\x41'`,
    `.claude/tools/Merlin.exe --cmd '${B}' | grep x <<EOF\nEOF`,
    `.claude/tools/Merlin.exe --cmd '${B}' | tee x | sh`,
    `.claude/tools/Merlin.exe --cmd '${B}' 2>&1 | jq -r .x | sh`,
    `.claude/tools/Merlin.exe --cmd '${B}' 2>&1 | tail -5 > out.sh`,
    `.claude/tools/Merlin.exe --cmd '${B}' --cmd '{"action":"meta-budget","adId":"1","dailyBudget":900}'`,
    `x=1 .claude/tools/Merlin.exe --cmd '${B}'`,
    // A strong signal inside the JSON still refuses trust.
    `.claude/tools/Merlin.exe --cmd '{"action":"blog-post","body":"\`./.claude/tools/Merlin.exe --cmd {}\`"}'`,
    `.claude/tools/Merlin.exe --cmd '{"action":"blog-post","body":"\`x\`","action":"meta-budget"}'`,
  ]) assert.ok(['card-unreadable', 'deny-ambiguous'].includes(r(c)), `must card: ${JSON.stringify(c)} -> ${r(c)}`);
  assert.equal(r(`.claude/tools/Merlin.exe --cmd '{"action":"meta-budget","adId":"1","dailyBudget":900,"b":"\`x\`"}'`), 'spend');
  // The apostrophe idioms route as on main (carded there too).
  for (const c of [`.claude/tools/Merlin.exe --cmd '{"action":"blog-post","body":"Don'\\''t"}'`,
    `.claude/tools/Merlin.exe --cmd '{"action":"blog-post","body":"Don'"'"'t"}'`]) {
    if (MAIN) assert.equal(r(c), MAIN.routeBash(c).route, c);
  }
});

// Part 2: Go's flag package stops at the first positional argument or `--`,
// so a later --cmd is ignored and the paid default pipeline runs.
test('arguments Go would not parse as harmless flags refuse literal trust', () => {
  const D = `'{"action":"dashboard"}'`;
  for (const c of [
    `.claude/tools/Merlin.exe x --cmd ${D}`, `./.claude/tools/Merlin.exe -- --cmd ${D}`,
    `.claude/tools/Merlin.exe --image x --cmd ${D}`, `.claude/tools/Merlin.exe - --cmd ${D}`,
    `.claude/tools/Merlin.exe --dry-run false --cmd ${D}`, `.claude/tools/Merlin.exe --dry-run=false --cmd ${D}`,
    `.claude/tools/Merlin.exe --cmd ${D} extra`, `.claude/tools/Merlin.exe --CMD ${D}`,
    `.claude/tools/Merlin.exe --install /tmp/x --cmd ${D}`, `.claude/tools/Merlin.exe --config-stdin --cmd ${D}`,
    `.claude/tools/Merlin.exe --bogus --cmd ${D}`, `Merlin.exe x --cmd ${D}`, `merlin -- --cmd ${D}`,
    `.claude/tools/Merlin.exe x --cmd ${D} | jq .`, `cd x && .claude/tools/Merlin.exe x --cmd ${D} 2>&1 | tail -5`,
    `.claude/tools/Merlin.exe --install /tmp/x`, `.claude/tools/Merlin.exe --test`,
  ]) assert.equal(r(c), 'card-unreadable', `must card: ${c}`);
  for (const c of [`.claude/tools/Merlin.exe --image --cmd ${D}`, `.claude/tools/Merlin.exe --dry-run --cmd ${D}`,
    `.claude/tools/Merlin.exe --version --cmd ${D}`, `.claude/tools/Merlin.exe -cmd ${D} -brand x`,
    `.claude/tools/Merlin.exe --cmd ${D} 2> err.txt`, `.claude/tools/Merlin.exe --cmd ${D} > out.json`]) {
    assert.equal(r(c), 'other', c);
    if (MAIN) assert.equal(MAIN.routeBash(c).route, 'other', `main: ${c}`);
  }
});
