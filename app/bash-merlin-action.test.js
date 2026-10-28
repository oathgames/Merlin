// REGRESSION GUARD (2026-10-04, ad-connector adversarial review, MEDIUM 5 + 6)
//
// The Bash approval gate read the FIRST "action" key out of a Merlin --cmd
// payload; Go's encoding/json runs the LAST one, matches keys
// case-insensitively, and decodes \u escapes. Each of those let a spend
// action ride under a read's card. These tests pin the parser to Go's
// reading and pin main.js to the parser.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseAction, lastNumber, lastString } = require('./bash-merlin-action');

const cmd = (json) => `.claude/tools/Merlin.exe --config cfg.json --cmd '${json}'`;

test('a normal command parses unambiguously', () => {
  const r = parseAction(cmd('{"action":"meta-push","dailyBudget":40}'));
  assert.deepStrictEqual(r, { action: 'meta-push', ambiguous: false, count: 1 });
});

test('duplicate action keys are ambiguous (Go would run the last one)', () => {
  const r = parseAction(cmd('{"action":"rokt-report","action":"meta-push","approved":true}'));
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.action, 'meta-push', 'the reported action must be the one Go runs');
});

test('case-variant action keys count as action keys', () => {
  const r = parseAction(cmd('{"action":"rokt-report","ACTION":"meta-push"}'));
  assert.strictEqual(r.ambiguous, true);
  const solo = parseAction(cmd('{"Action":"meta-push"}'));
  assert.strictEqual(solo.action, 'meta-push');
  assert.strictEqual(solo.ambiguous, false);
});

test('\\u escapes in the key are decoded before comparing', () => {
  const r = parseAction(cmd('{"action":"rokt-report","\\u0061ction":"meta-push"}'));
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.count, 2);
});

test('\\u escapes in the value are decoded', () => {
  const r = parseAction(cmd('{"action":"meta-\\u0070ush"}'));
  assert.strictEqual(r.action, 'meta-push');
  assert.strictEqual(r.ambiguous, false);
});

test('an undecodable action value is ambiguous', () => {
  assert.strictEqual(parseAction(cmd('{"action":"bad\\q"}')).ambiguous, true);
  assert.strictEqual(parseAction(cmd('{"action":5}')).ambiguous, true);
});

test('backslash-escaped JSON inside a double-quoted shell arg is read too', () => {
  const r = parseAction('Merlin.exe --cmd "{\\"action\\":\\"meta-push\\",\\"dailyBudget\\":25}"');
  assert.strictEqual(r.action, 'meta-push');
  assert.strictEqual(lastNumber('Merlin.exe --cmd "{\\"action\\":\\"meta-push\\",\\"dailyBudget\\":25}"', 'dailyBudget'), 25);
});

test('no action key returns empty, not ambiguous', () => {
  assert.deepStrictEqual(parseAction('Merlin.exe --version'), { action: '', ambiguous: false, count: 0 });
});

test('dailyBudget: the LAST occurrence wins, matching Go', () => {
  assert.strictEqual(lastNumber(cmd('{"action":"meta-push","dailyBudget":5,"dailyBudget":5000}'), 'dailyBudget'), 5000);
  assert.strictEqual(lastNumber(cmd('{"action":"meta-push","dailyBudget":5,"DAILYBUDGET":900}'), 'dailyBudget'), 900);
  assert.strictEqual(lastNumber(cmd('{"action":"meta-push","dailyBudget":12.5}'), 'dailyBudget'), 12.5);
  assert.strictEqual(lastNumber(cmd('{"action":"meta-push"}'), 'dailyBudget'), null);
});

test('lastString follows the same rule', () => {
  assert.strictEqual(lastString(cmd('{"brand":"a","Brand":"b"}'), 'brand'), 'b');
});

test('main.js routes both Bash approval reads through the parser', () => {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.ok(src.includes("require('./bash-merlin-action')"), 'main.js must require the parser');
  assert.ok(!/match\(\/"action"\\s\*:\\s\*"/.test(src), 'first-match action regex is back in main.js');
  assert.ok(!/match\(\/"dailyBudget"\\s\*:/.test(src), 'first-match dailyBudget regex is back in main.js');
  assert.ok(src.includes('if (parsedBash.ambiguous)'), 'Bash branch must deny ambiguous commands');
});
