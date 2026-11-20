// REGRESSION GUARD (2026-11-20, bash-approval-followup review)
//
//   1. Bash ANSI-C strings ($'\x69', $'\055', $'a') are decoded before
//      the router detects the engine or reads its action, in the router AND
//      in the PreToolUse hook. An undecodable one fails closed.
//   2. A glob command word under .claude/tools/ is an engine signal.
//   3. JSON keys are matched the way Go's encoding/json folds them: ASCII
//      case plus U+017F (long s) -> s and U+212A (Kelvin) -> k, for every
//      lookup (action, batchStatus, ids, amounts).
//   4. Interpreters are script runners, but need an engine signal to card.
//   5. Text-search programs (rg, ag, ack, findstr, Select-String, a sed with
//      no exec command) do not card on an action name in their pattern.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const route = require('./bash-approval-route');
const action = require('./bash-merlin-action');

const r = (command) => route.routeBash(command).route;
const LONG_S = 'ſ';
const KELVIN = 'K';

// ── (1) ANSI-C decoding ──────────────────────────────────────────────

test('ANSI-C engine calls card as the real spend action', () => {
  const budget = String.raw`.claude/tools/$'Merl\x69n.exe' $'\x2d\x2dcmd' $'{"\x61ction":"meta-budget","adId":"1","dailyBudget":900}'`;
  const out = route.routeBash(budget);
  assert.equal(out.route, 'spend');
  assert.equal(out.action, 'meta-budget');
  assert.equal(action.lastNumber(out.cmdText, 'dailyBudget'), 900);
  assert.equal(r(String.raw`$'\056claude/tools/\115erlin.exe' $'\055\055cmd' $'{"\141ction":"meta-push","approved":true,"dailyBudget":900}'`), 'spend');
  assert.equal(r(String.raw`.claude/tools/Merl$'\x69'n.exe $'\x2d'-cmd '{"action":"meta-push","approved":true}'`), 'spend');
  assert.equal(r(String.raw`.claude/tools/Merlin.exe --cmd $'{"action":"meta-push"}'`), 'spend');
  assert.equal(r(String.raw`cd x && .claude/tools/Merlin.exe --cmd $'{"action":"meta\x2dpush"}'`), 'spend');
});

test('an ANSI-C string that cannot be decoded exactly fails closed', () => {
  for (const c of [
    String.raw`.claude/tools/Merl$'\c' --cmd x`,
    String.raw`$'\x00' --cmd '{"action":"meta-push"}'`,
    String.raw`$'\xff' x`,
    String.raw`$'\u' x`,
    String.raw`$'\ud800' x`,
    String.raw`$'unterminated`,
  ]) {
    assert.equal(r(c), 'card-unreadable', c);
  }
});

test('decodeAnsiC follows bash escape rules', () => {
  const d = (s) => route.decodeAnsiC(s);
  assert.deepEqual(d(String.raw`echo $'a\tb'`), { text: "echo 'a\tb'", failed: false });
  assert.equal(d(String.raw`x $'\101\x42C\U00000044\cA\z'`).text, "x 'ABCD\x01\\z'");
  assert.equal(d(String.raw`x $'it\'s'`).text, "x 'it'\\''s'");
  // Not special inside quotes, after an escaped $, or after $$.
  assert.equal(d(String.raw`x "$'\x41'" '$'`).text, String.raw`x "$'\x41'" '$'`);
  assert.equal(d(String.raw`x \$'\x41'`).text, String.raw`x \$'\x41'`);
  assert.equal(d('no ansi here').text, 'no ansi here');
});

test('ordinary ANSI-C use stays uncarded', () => {
  assert.equal(r(String.raw`echo $'a\tb'`), 'safe');
  assert.equal(r(String.raw`printf $'\x41\n'`), 'other');
  assert.equal(r(String.raw`grep $'\t' file.tsv`), 'safe');
});

// ── (2) glob command word under the engine directory ─────────────────

test('a glob binary name with an ANSI-C flag cards', () => {
  assert.equal(r(String.raw`.claude/tools/M?rlin.exe $'\055cmd' $'{"\141ction":"meta-push"}'`), 'card-unreadable');
  assert.equal(r('.claude/tools/M*.exe'), 'card-unreadable');
  assert.equal(r('"$LOCALAPPDATA"/Merlin/bin/M?rlin.exe --version'), 'card-unreadable');
  // A glob in an ARGUMENT is not a command word.
  assert.equal(r('ls .claude/tools/*.exe'), 'safe');
});

// ── (3) Go encoding/json key folding ─────────────────────────────────

test('foldKey mirrors Go: ASCII case plus long s and Kelvin only', () => {
  assert.equal(action.foldKey('BatchStatu' + LONG_S), 'batchstatus');
  assert.equal(action.foldKey(KELVIN + 'ey'), 'key');
  // Turkish dotted / dotless i do not fold to i in Go.
  assert.notEqual(action.foldKey('actİon'), 'action');
  assert.notEqual(action.foldKey('actıon'), 'action');
});

test('a folded duplicate batchStatus binds the LAST value, as Go does, and cards', () => {
  for (const a of ['meta-batch-status', 'snapchat-batch-status']) {
    const json = `{"action":"${a}","batchStatus":"PAUSED","batchStatu${LONG_S}":"ACTIVE"}`;
    assert.equal(action.lastString(json, 'batchStatus'), 'ACTIVE');
    assert.equal(r(`.claude/tools/Merlin.exe --cmd '${json}'`), 'spend', json);
    const k = `{"action":"${a}","batchStatus":"PAUSED","batch${LONG_S}tatus":"ACTIVE"}`;
    assert.equal(r(`.claude/tools/Merlin.exe --cmd '${k}'`), 'spend', k);
  }
  // A real pause still skips the card.
  assert.equal(r(`.claude/tools/Merlin.exe --cmd '{"action":"meta-batch-status","batchStatus":"PAUSED"}'`), 'other');
});

test('action and other keys bind exactly where Go binds them', () => {
  // "action" has no s or k, so only ASCII case folds onto it.
  assert.equal(r(`.claude/tools/Merlin.exe --cmd '{"ACTION":"meta-push"}'`), 'spend');
  const two = `{"action":"meta-insights","acti${LONG_S}n":"x"}`;
  // U+017F folds to s, so "actiſn" is "actisn", not "action": no match.
  assert.equal(action.parseAction(two).count, 1);
  const dup = `{"action":"meta-insights","\\u0041CTION":"meta-push"}`;
  assert.equal(r(`.claude/tools/Merlin.exe --cmd '${dup}'`), 'deny-ambiguous');
  // A key that Go binds to "status" via long s.
  assert.equal(action.lastString(`{"${LONG_S}tatus":"x"}`, 'status'), 'x');
  // A folded key that Go binds to a "kind"-like field via Kelvin.
  assert.equal(action.lastString(`{"${KELVIN}ind":"y"}`, 'kind'), 'y');
});

test('the budget card id and amount follow the folded LAST key', () => {
  const j = `{"action":"snapchat-budget","targetAdSetId":"111","targetAd${LONG_S}etId":"999","dailyBudget":20,"dailyBudget":20}`;
  const card = route.bashSpendCard('snapchat-budget', j);
  assert.match(card.target, /999/);
  assert.doesNotMatch(card.target, /111/);
  const amt = `{"action":"meta-budget","adId":"1","dailyBudget":5,"daily${'B'}udget":7}`;
  assert.equal(action.lastNumber(amt, 'dailyBudget'), 7);
  const ids = `{"action":"meta-budget","ad${'I'}d":"1","AD${'I'}D":"2","dailyBudget":5}`;
  assert.equal(action.lastString(ids, 'adId'), '2');
  const campaign = `{"campaignId":"1","campaign${'I'}d":"2","campaignI${'D'}":"3"}`;
  assert.equal(action.lastString(campaign, 'campaignId'), '3');
});

// ── (4) interpreters as script runners ───────────────────────────────

test('interpreters that build an engine call card; plain scripts do not', () => {
  for (const c of [
    String.raw`node -e 'require("child_process").execFileSync(".claude/tools/Mer"+"lin.exe",["-"+"-c"+"md","{}"])'`,
    String.raw`python -c "import subprocess;subprocess.run(['.claude/tools/Mer'+'lin.exe','-'+'-c'+'md','{}'])"`,
    String.raw`python3 -c "import os;os.system('.claude/tools/Mer'+'lin.exe -'+'-cmd x')"`,
    String.raw`powershell -c "& (gci .claude/tools/M*.exe) ('-'+'-c'+'md') ('{}')"`,
    String.raw`pwsh -c "& (gci .claude/tools/M*.exe) ('-'+'-c'+'md') ('{}')"`,
    String.raw`cmd /c ".claude\tools\Mer^lin.exe -^-c^md {}"`,
    String.raw`printf '\056claude/tools/\115erlin.exe \055\055c\155d {}' | sh`,
    'echo LmNsYXVkZS90b29scy9NZXJsaW4uZXhlIC0tY21kICd7fSc= | base64 -d | sh',
  ]) {
    assert.equal(r(c), 'card-unreadable', c);
  }
  for (const c of ['node script.js', 'python x.py', 'python3 -m pytest', 'node --test app/x.test.js',
    'powershell -c Get-Date', 'cmd /c dir', 'pwsh ./build.ps1']) {
    assert.notEqual(r(c), 'card-unreadable', c);
  }
});

// ── (5) text-only search programs ────────────────────────────────────

test('text searches for an action name are not carded', () => {
  for (const c of [
    `rg -n '"action": *"meta-push"' app/`,
    `ag '"action":"meta-push"'`,
    `ack '"action":"meta-push"' app`,
    `findstr '"action":"meta-push"' f`,
    `sed -n '/"action":"meta-push"/p' f | grep x`,
    `rg '"action":"meta-push"' | sed 's/x/y/g' | grep z`,
  ]) {
    assert.equal(r(c), 'other', c);
  }
  // sed that can execute is not text-only.
  assert.equal(r(`sed 's/x/y/e' '{"action":"meta-push"}'`), 'card-unreadable');
  assert.equal(r(`sed -n '1e ls' f '"action":"meta-push"'`), 'card-unreadable');
});

test('must-stay-uncarded commands keep their route', () => {
  for (const [c, want] of [
    ['cd "$HOME" && ls', 'safe'], ['echo $PATH', 'safe'],
    ['git commit -m "fix meta-push action"', 'other'], [`grep '"action":"meta-push"' file`, 'safe'],
    ['npm test', 'other'], ['git log --grep=meta-push', 'other'],
  ]) {
    assert.equal(r(c), want, c);
  }
});

// ── hook ─────────────────────────────────────────────────────────────

const HOOK = path.join(__dirname, '..', '.claude', 'hooks', 'block-api-bypass.js');
const HOOK_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-hook-ansi-'));
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

test('hook decodes ANSI-C and blocks a chained engine call spelled with it', () => {
  for (const c of [
    String.raw`cd x && .claude/tools/$'Merl\x69n.exe' $'\x2d\x2dcmd' '{"action":"meta-push"}'`,
    String.raw`cd x; $'\056claude/tools/\115erlin.exe' --cmd '{}'`,
    String.raw`cd x && .claude/tools/M?rlin.exe $'\055cmd' $'{"\141ction":"meta-push"}'`,
    String.raw`ls; .claude/tools/Merl$'\c' --cmd x`,
  ]) {
    assert.equal(runHook(c), 2, `hook must block: ${c}`);
  }
  for (const c of [String.raw`echo $'a\tb' && ls`, String.raw`printf $'\x41\n'`, 'cd "$HOME" && ls',
    'ls .claude/tools/*.exe | wc -l', `rg -n '"action": *"meta-push"' app/ | head`]) {
    assert.equal(runHook(c), 0, `hook must allow: ${c}`);
  }
});

test('the hook decoder matches the router decoder', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  const routeSrc = fs.readFileSync(path.join(__dirname, 'bash-approval-route.js'), 'utf8');
  const body = (s, name) => {
    const i = s.indexOf('function ' + name);
    assert.ok(i >= 0, name);
    return s.slice(s.indexOf('{', i), s.indexOf('\n}\n', i)).replace(/hookDecodeAnsiCBody|decodeAnsiCBody/g, 'B')
      .replace(/HOOK_ANSI_C_SIMPLE|ANSI_C_SIMPLE/g, 'T');
  };
  assert.equal(body(src.replace(/\r\n/g, '\n'), 'hookDecodeAnsiCBody'), body(routeSrc.replace(/\r\n/g, '\n'), 'decodeAnsiCBody'));
  assert.equal(body(src.replace(/\r\n/g, '\n'), 'hookDecodeAnsiC('), body(routeSrc.replace(/\r\n/g, '\n'), 'decodeAnsiC('));
});
