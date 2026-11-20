// REGRESSION GUARD (2026-11-20, bash-approval-followup review 7)
//
//   1. `>&word` writes FILE word, so staging a wrapper with it is a write;
//      every bash redirect form that names a file counts.
//   2. Only a fully read literal engine call (readable --cmd action) is
//      trusted by TIER 1; a wrapper named merlin is not, and chmod is not
//      inert.
//   3. Ordinary read-only engine calls behind `cd`, piped to tee / jq /
//      python / node, or redirected route exactly as they did before TIER 1
//      (main), because literal engine segments are removed before the
//      hidden-engine readings (withoutLiteralEngineCalls).
//   4. ack / ag long options match by prefix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const route = require('./bash-approval-route');

const r = (command) => route.routeBash(command).route;
const HOOK = path.join(__dirname, '..', '.claude', 'hooks', 'block-api-bypass.js');
const HOOK_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-hook7-'));
test.after(() => { try { fs.rmSync(HOOK_CWD, { recursive: true, force: true }); } catch {} });
function runHook(command) {
  const env = { ...process.env };
  delete env.TOOL_INPUT;
  delete env.TOOL_NAME;
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), env, cwd: HOOK_CWD, encoding: 'utf8',
  }).status;
}

const BUDGETX = `'{"action":"meta-budgeX","adId":"1","dailyBudget":900}'`;
const WRAP = `'xargs -0 ./.claude/tools/Merlin.exe --cmd'`;
const SPLICED_WRAP = `'xargs -0 ./.claude/tools/Merl""in.exe --c""md'`;

test('reviewer case 1: >&merlin wrapper staging cards and the hook blocks it', () => {
  const c = `echo ${WRAP} >&merlin; chmod +x merlin; printf %s ${BUDGETX} | tr X t | ./merlin`;
  assert.equal(r(c), 'card-unreadable');
  assert.equal(runHook(c), 2);
  // Same shape with the engine text spliced, so the hook's literal reader
  // does not see it and TIER 1 is the only layer.
  const s = `echo ${SPLICED_WRAP} >&merlin; chmod +x merlin; printf %s ${BUDGETX} | tr X t | ./merlin`;
  assert.equal(r(s), 'card-unreadable');
  assert.equal(runHook(s), 2);
});

test('every file-writing redirect form with a strong signal cards', () => {
  const forms = ['>&merlin', '>& merlin', '&>merlin', '&>>merlin', '>|merlin', '2>merlin', '<>merlin',
    '>>merlin', '{fd}>merlin', '> merlin', '>"merlin"', ">&'m'", '>& "$F"', '>&$F', '1>&m1', '>', '>&'];
  for (const f of forms) {
    const c = `echo ${SPLICED_WRAP} ${f}`;
    assert.equal(r(c), 'card-unreadable', `must card: ${c}`);
    assert.equal(runHook(`true; ${c}`), 2, `hook must block: ${c}`);
  }
});

test('fd duplicates and device targets are not file writes', () => {
  for (const f of ['>&2', '>& 2', '2>&1', '>&-', '2>&1-', '>/dev/null', '2>/dev/null', '&>/dev/null', '>/dev/stderr', '>&/dev/fd/2']) {
    const c = `echo .claude/tools ${f}`;
    assert.ok(['safe', 'other'].includes(r(c)), `must stay uncarded: ${c} -> ${r(c)}`);
    assert.equal(runHook(`cd x; ${c}`), 0, `hook must allow: ${c}`);
  }
});

test('copy, link and write programs are not inert under a strong signal', () => {
  for (const c of [
    'cp x .claude/tools/Merlin.exe', 'mv x .claude/tools/Merlin.exe', 'ln -s x .claude/tools/Merlin.exe',
    'install x .claude/tools/Merlin.exe', `echo ${SPLICED_WRAP} | tee merlin`, `echo ${SPLICED_WRAP} | dd of=merlin`,
    'chmod +x .claude/tools/Merlin', 'chmod +x merlin && echo .claude/tools',
  ]) assert.equal(r(c), 'card-unreadable', `must card: ${c}`);
});

test('an engine-named command word without a readable action cards under a strong signal', () => {
  for (const c of [
    `printf %s ${BUDGETX} | tr X t | ./merlin`.replace('./merlin', './merlin; echo .claude/tools'),
    'echo .claude/tools; ./merlin',
    `cat p.json | ./merlin --cmd-file /dev/stdin; echo .claude/tools`,
    '.claude/tools/Merlin.exe --cmd "$P"',
    '.claude/tools/Merlin.exe',
    `echo '{"action":"meta-push"}' | xargs ./.claude/tools/Merlin.exe --cmd`,
  ]) assert.equal(r(c), 'card-unreadable', `must card: ${c}`);
});

// Route on main (before TIER 1) for every case below, recorded from
// `git show main:app/bash-approval-route.js`; spend actions are the one
// intended change ('other' on main where the old tier missed them, 'spend' now).
const READ_ONLY = ['dashboard', 'meta-insights', 'seo-audit', 'tiktok-insights', 'google-ads-insights',
  'shopify-analytics', 'klaviyo-insights', 'meta-catalog', 'meta-list-adsets', 'competitor-scan'];
const SPEND_ACTIONS = ['meta-push', 'meta-budget', 'tiktok-push', 'meta-duplicate', 'google-ads-budget'];
const PREFIXES = ['', 'cd x && ', 'cd "$HOME/Merlin" && ', 'cd "$PROJ" && ', 'cd ~/Merlin && '];
const SUFFIXES = ['', ' 2>&1 | tail -5', ' > out.json', ' | tee out.json', ' | jq .', ' | python -m json.tool',
  ' | node summarize.js', ' | head -50', ' && echo done', ' 2>&1 | grep -i error'];

test('ordinary engine calls route as on main (read-only other, spend carded)', () => {
  for (const bin of ['.claude/tools/Merlin.exe', './.claude/tools/Merlin.exe']) {
    for (const p of PREFIXES) {
      for (const s of SUFFIXES) {
        for (const a of READ_ONLY) {
          const c = `${p}${bin} --cmd '{"action":"${a}","adId":"1"}'${s}`;
          const res = route.routeBash(c);
          assert.equal(res.route, 'other', `must stay other: ${c}`);
          assert.equal(res.action, a, c);
        }
        for (const a of SPEND_ACTIONS) {
          const c = `${p}${bin} --cmd '{"action":"${a}","adId":"1","dailyBudget":5}'${s}`;
          const res = route.routeBash(c);
          assert.equal(res.route, 'spend', `must card spend: ${c}`);
          assert.equal(res.action, a, c);
        }
      }
    }
  }
  assert.equal(r('cd /d/x; .claude/tools/Merlin.exe --version'), 'other');
});

test('removing a literal segment cannot hide a second engine call', () => {
  const lit = `.claude/tools/Merlin.exe --cmd '{"action":"dashboard"}'`;
  for (const c of [
    `${lit} ; ./Mer""lin.exe --c""md '{"action":"meta-budget"}'`,
    `${lit} | xargs ./.claude/tools/Merlin.exe`,
    `${lit} && x=; ./Mer\${x}lin.exe --c\${x}md '{"action":"meta-budget"}'`,
    `.claude/tools/Merlin.exe --config "$(./Mer""lin.exe --c""md '{"action":"meta-budget"}')" --cmd '{"action":"dashboard"}'`,
    `X=$(./Mer""lin.exe --c""md '{"action":"meta-budget"}') .claude/tools/Merlin.exe --cmd '{"action":"dashboard"}'`,
    `${lit} <<< "$(./Mer""lin.exe --c""md x)"`,
    `${lit} # '\n./Mer""lin.exe --c""md '{"action":"meta-budget"}'`,
    `${lit} \\\n; ./Mer""lin.exe --c""md '{"action":"meta-budget"}'`,
    `${lit}; echo ${SPLICED_WRAP} >&merlin`,
    `${lit} >& merlin2; chmod +x merlin2`,
    `${lit} | tee out | xargs -0 ./.claude/tools/Merl""in.exe --c""md`,
  ]) assert.ok(['card-unreadable', 'deny-ambiguous', 'spend'].includes(r(c)), `must card: ${c} -> ${r(c)}`);
  // Two --cmd values (Go keeps the last) name two actions: denied, so a
  // benign first value cannot front for a spend one.
  assert.equal(r(`.claude/tools/Merlin.exe --cmd '{"action":"dashboard"}' --cmd '{"action":"meta-budget","adId":"1","dailyBudget":9}'`), 'deny-ambiguous');
});

test('must-stay-ungated commands keep their route', () => {
  for (const c of ['cd "$HOME" && ls', 'echo $PATH', 'git commit -m "fix meta-push action"', 'grep -rn "Merlin.exe" app/',
    'cat docs/notes.md | grep -i merlin', 'rg -n \'"action": *"meta-push"\' app/', 'sed -n \'1,20p\' app/main.js',
    'npm test 2>&1 | tail -20', 'echo hi >&2', 'ls .claude/tools/*.exe', 'node script.js', 'cd ~/Merlin && npm test',
    'go build ./... && go vet ./...', 'cd "$HOME/Merlin" && ls', 'cd "$HOME/Merlin" && cat x | jq .']) {
    assert.ok(['safe', 'other'].includes(r(c)), `must stay uncarded: ${c} -> ${r(c)}`);
  }
});

test('ack and ag long options match by prefix', () => {
  for (const c of [`ack --pag='./x' '"action":"meta-push"' f`, `ack --pa=./x '"action":"meta-push"' f`,
    `ag --pager=./x '"action":"meta-push"' f`, `ack --ackr=x '"action":"meta-push"' f`, `ack --outp=x '"action":"meta-push"' f`,
    `ACK_PAGER=./x ack '"action":"meta-push"' f`]) {
    assert.equal(r(c), 'card-unreadable', `must card: ${c}`);
  }
  assert.ok(['safe', 'other'].includes(r(`ack -i '"action":"meta-push"' app/`)));
});

test('literal-segment and redirect readers stay linear on 50KB input', () => {
  for (const unit of ['>&', '> ', '&>', ".claude/tools/Merlin.exe --cmd '{\"action\":\"dashboard\"}' | ", 'cd x; ', '"\\"']) {
    const big = unit.repeat(Math.ceil(50000 / unit.length));
    const t0 = Date.now();
    r(big);
    r(`echo .claude/tools ${big}`);
    assert.ok(Date.now() - t0 < 1000, `slow on ${unit}: ${Date.now() - t0}ms`);
  }
});
