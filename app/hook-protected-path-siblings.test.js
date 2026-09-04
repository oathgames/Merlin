// REGRESSION GUARD (2026-09-04, Rule 7 sibling gap in PROTECTED_PATH_PATTERNS):
//
// Hard-Won Security Rule 7 requires every blocklist pattern for a critical
// file to end in `(\.|$)` rather than `$`, so it also matches the `.bak` /
// `.tmp` / `.tmp.N` siblings that atomic writes leave behind. Three patterns
// in .claude/hooks/block-api-bypass.js still used the bare `$` anchor:
//
//     /merlin-config\.json$/i
//     /\.merlin-config-[a-z0-9_-]+\.json$/i
//     /\.merlin-tokens[a-z0-9_-]*$/i
//
// A rogue skill could therefore `Read ~/Merlin/.claude/tools/
// merlin-config.json.bak` and walk off with the same seven plaintext platform
// tokens the primary file holds, while the primary file itself was blocked.
//
// This test does not source-scan for the literal `(\.|$)` text: it EXTRACTS
// the real pattern array and runs paths through it, so a pattern that is
// rewritten in some other shape still has to actually block the siblings.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HOOK = path.join(__dirname, '..', '.claude', 'hooks', 'block-api-bypass.js');

// Pull `const PROTECTED_PATH_PATTERNS = [ ... ];` out of the hook and evaluate
// just that literal. The hook itself runs main() + process.exit on require, so
// it cannot simply be imported.
function loadProtectedPathPatterns() {
  const src = fs.readFileSync(HOOK, 'utf8');
  const marker = 'const PROTECTED_PATH_PATTERNS = [';
  const start = src.indexOf(marker);
  assert.ok(start >= 0, 'PROTECTED_PATH_PATTERNS array not found in block-api-bypass.js');
  const end = src.indexOf('\n];', start);
  assert.ok(end > start, 'PROTECTED_PATH_PATTERNS array is not terminated by a bare `];` line');
  const literal = src.slice(start + marker.length - 1, end + 2);
  const patterns = vm.runInNewContext(literal);
  assert.ok(Array.isArray(patterns) && patterns.length > 5, 'extracted pattern list looks wrong');
  return patterns;
}

const PATTERNS = loadProtectedPathPatterns();
const blocked = (p) => PATTERNS.some((re) => re.test(p));

// Every credential-bearing file whose siblings must also be blocked, with the
// primary path first. Add a row here whenever a new credential file is added
// to the hook — the sibling suffixes are the whole point.
const CREDENTIAL_FILES = [
  'C:/Users/x/Merlin/.claude/tools/merlin-config.json',
  'C:/Users/x/Merlin/.claude/tools/.merlin-config-apotheke.json',
  'C:/Users/x/Merlin/.claude/tools/.merlin-tokens-apotheke',
  '/home/x/Merlin/.claude/tools/merlin-config.json',
];

const SIBLING_SUFFIXES = ['.bak', '.tmp', '.tmp.1', '.old', '.download'];

test('the primary credential files are blocked (baseline)', () => {
  for (const p of CREDENTIAL_FILES) {
    assert.ok(blocked(p), `${p} must be blocked by PROTECTED_PATH_PATTERNS`);
  }
});

test('Rule 7: every atomic-write sibling of a credential file is blocked too', () => {
  for (const p of CREDENTIAL_FILES) {
    for (const suffix of SIBLING_SUFFIXES) {
      const sibling = p + suffix;
      assert.ok(
        blocked(sibling),
        `${sibling} must be blocked — a bare \`$\` anchor lets the atomic-write sibling leak the same plaintext tokens (Hard-Won Security Rule 7)`,
      );
    }
  }
});

test('SOURCE: no merlin credential-file pattern is still anchored on a bare `$`', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  const offenders = [];
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//')) continue;
    if (!/^\/.*\/i,$/.test(t)) continue;
    if (!/merlin-(config|tokens|vault|ratelimit|audit|threads|facts|relay|oauth|entitlement|active|dashboard)/i.test(t)) continue;
    if (/\$\/i,$/.test(t)) offenders.push(t);
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'Rule 7: these credential-file patterns end in `$` and so miss their .bak/.tmp siblings',
  );
});

test('the sibling widening did not over-block unrelated neighbours', () => {
  // `-salt`-style neighbours and ordinary project files must still be readable;
  // `(\.|$)` widens only on a dot, never on a hyphen or a word character.
  for (const p of [
    'C:/Users/x/Merlin/.claude/tools/merlin-configuration-notes.md',
    'C:/Users/x/Merlin/.claude/tools/merlin-config-example.md',
    'C:/Users/x/Merlin/app/renderer-helpers.md',
  ]) {
    assert.ok(!blocked(p), `${p} must NOT be blocked — the widening is dot-only`);
  }
});
