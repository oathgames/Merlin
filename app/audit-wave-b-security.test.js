// REGRESSION GUARDS for audit Wave B (2026-05-02): security gaps the
// 10-persona adversarial audit surfaced. Three locks here:
//
// (B1) `.merlin-active-spend.json` and `.merlin-dashboard-prev.json`
//      were missing from PROTECTED_PATH_PATTERNS. Both files were added
//      in Loop 3 and carry per-platform spend posture + revenue/MER
//      snapshots — exfiltration helps a multi-stage attacker pick the
//      next OAuth target.
//
// (B2) Bash-shape hole in spell write-protection. RSI Loop 5 added
//      ~/.claude/scheduled-tasks/<id>/SKILL.md to PROTECTED_PATH_PATTERNS
//      but missed PROTECTED_COMMAND_PATTERNS — `Bash(echo > ... SKILL.md)`
//      sailed through. Sims 4 and 9 both flagged independently.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function hookSrc() {
  return fs.readFileSync(
    path.join(__dirname, '..', '.claude', 'hooks', 'block-api-bypass.js'),
    'utf8',
  );
}

// ── (B1) Per-brand state ledger files protected ─────────────────────

test('PROTECTED_PATH_PATTERNS covers .merlin-active-spend with atomic-write siblings', () => {
  const src = hookSrc();
  assert.match(
    src,
    /\\\.merlin-active-spend\\?\(\\\.\|\$\)/,
    'block-api-bypass.js must list /\\.merlin-active-spend(\\.|$)/i — without it the per-brand spend ledger leaks platform posture, .bak/.tmp atomic-write siblings unprotected (Hard-Won Rule 7)',
  );
});

test('PROTECTED_PATH_PATTERNS covers .merlin-dashboard-prev with atomic-write siblings', () => {
  const src = hookSrc();
  assert.match(
    src,
    /\\\.merlin-dashboard-prev\\?\(\\\.\|\$\)/,
    'block-api-bypass.js must list /\\.merlin-dashboard-prev(\\.|$)/i — Loop 3 dashboard snapshot carries MER + revenue + per-platform ROAS',
  );
});

// ── (B2) Bash-shape spell hole ──────────────────────────────────────

test('PROTECTED_COMMAND_PATTERNS covers .claude/scheduled-tasks for Bash-shape commands', () => {
  const src = hookSrc();
  // Find the COMMAND patterns array (second `const … = [`).
  const arrMatch = src.match(/const PROTECTED_COMMAND_PATTERNS = \[([\s\S]*?)\];/);
  assert.ok(arrMatch, 'PROTECTED_COMMAND_PATTERNS array not found');
  const body = arrMatch[1];
  assert.match(
    body,
    /\\\.claude\[\/\\\\\]scheduled-tasks\[\/\\\\\]/,
    "PROTECTED_COMMAND_PATTERNS must include /\\.claude[/\\\\]scheduled-tasks[/\\\\]/i — without it Bash(echo > ~/.claude/scheduled-tasks/X/SKILL.md) and Bash(cp evil.md ~/.claude/scheduled-tasks/X/config.json) bypass Loop 5's Edit/Write protection. Sims 4+9 flagged independently.",
  );
});

// Functional: simulate that a Bash-shaped command targeting the spell
// path would match at least one COMMAND pattern. Same probe-shape the
// existing Loop 5 functional test uses for the Edit/Write side.
test('Bash command targeting spell SKILL.md is matched by PROTECTED_COMMAND_PATTERNS', () => {
  const src = hookSrc();
  const arrMatch = src.match(/const PROTECTED_COMMAND_PATTERNS = \[([\s\S]*?)\];/);
  assert.ok(arrMatch);
  const body = arrMatch[1];
  // Extract the regex literals (best-effort string parse, same shape
  // as the Loop 5 test).
  const regexLiterals = [...body.matchAll(/\/((?:\\\/|[^\/\n])+)\/(i?)/g)].map((m) => {
    try { return new RegExp(m[1], m[2]); } catch (_) { return null; }
  }).filter(Boolean);
  // Build representative Bash command strings the audit surfaced.
  const commands = [
    'echo "evil" >> /Users/x/.claude/scheduled-tasks/merlin-daily-acme/SKILL.md',
    'cp /tmp/evil.md C:\\Users\\x\\.claude\\scheduled-tasks\\merlin-optimize\\SKILL.md',
    'cat ~/.claude/scheduled-tasks/merlin-digest/config.json',
    'rm -rf ~/.claude/scheduled-tasks/merlin-memory/',
  ];
  for (const cmd of commands) {
    const matched = regexLiterals.some((r) => r.test(cmd));
    assert.equal(matched, true, `Bash command ${JSON.stringify(cmd)} must be matched by at least one PROTECTED_COMMAND_PATTERNS entry — pre-fix this command would have rewritten the user's spell logic during a session prompt-injection`);
  }
});

// Sanity: legitimate paths the audit deliberately leaves unprotected
// remain unmatched (so the regex doesn't accidentally over-block).
test('PROTECTED_COMMAND_PATTERNS does not over-match unrelated .claude paths', () => {
  const src = hookSrc();
  const arrMatch = src.match(/const PROTECTED_COMMAND_PATTERNS = \[([\s\S]*?)\];/);
  assert.ok(arrMatch);
  const body = arrMatch[1];
  const regexLiterals = [...body.matchAll(/\/((?:\\\/|[^\/\n])+)\/(i?)/g)].map((m) => {
    try { return new RegExp(m[1], m[2]); } catch (_) { return null; }
  }).filter(Boolean);
  // /tmp/x is neither a protected path nor a protected command.
  const benign = '/tmp/x.txt';
  const matched = regexLiterals.some((r) => r.test(benign));
  assert.equal(matched, false, '/tmp/x.txt should NOT be matched by any protected pattern');
});
