// REGRESSION GUARD (2026-08-03, sdk-cli-entry-moved).
//
// main.js spawned `node <sdk>/cli.js auth login`. The pinned SDK ships no
// cli.js, so spawn failed instantly, no browser opened, and the renderer sat on
// "Opening Claude sign-in" until a 5-minute timeout. It presented as an expired
// token on a fully authenticated install. These tests pin the resolution order
// and the fail-fast behaviour so it cannot silently regress.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('login does not hardcode cli.js as the spawn target', () => {
  assert.ok(
    !/path\.join\(sdkDir,\s*['"]cli\.js['"]\)\s*;[\s\S]{0,200}spawn\(nodeExe,\s*\[cliJs/.test(SRC),
    'the hardcoded cli.js spawn is back'
  );
  assert.ok(SRC.includes('resolveClaudeCliEntry('), 'resolver is not being used');
});

test('resolver prefers the platform binary the SDK actually ships', () => {
  const fn = SRC.slice(SRC.indexOf('function resolveClaudeCliEntry'));
  const body = fn.slice(0, fn.indexOf('\nfunction '));
  assert.ok(body.includes('claude-agent-sdk-${process.platform}-${arch}'),
    'does not look for the platform package');
  assert.ok(body.indexOf('claude-agent-sdk-${process.platform}') < body.indexOf("'cli.js'"),
    'platform binary must be tried BEFORE the legacy cli.js');
  assert.ok(body.includes('musl'), 'linux musl variant not handled (SDK resolves it)');
});

test('a missing CLI fails fast instead of spawning a nonexistent path', () => {
  assert.ok(/if \(!cliEntry\)/.test(SRC), 'no guard for an unresolved CLI');
  const guard = SRC.slice(SRC.indexOf('if (!cliEntry)'), SRC.indexOf('if (!cliEntry)') + 500);
  assert.ok(/success:\s*false/.test(guard), 'must resolve as a failure');
  assert.ok(!/spawn\(/.test(guard), 'must not reach spawn when unresolved');
});

test('the failure message is plain English with a real remedy (Rule 6)', () => {
  const i = SRC.indexOf('Claude sign-in could not start');
  assert.ok(i > 0, 'no user-facing message for the missing-CLI case');
  const msg = SRC.slice(i, SRC.indexOf("'", i + 40));
  assert.ok(/reinstall|update/i.test(msg), 'message gives no actionable next step');
  assert.ok(!/ENOENT|spawn |cli\.js/i.test(msg), 'message leaks internals at the user');
});

test('a native binary is launched directly, without a Node interpreter', () => {
  assert.ok(SRC.includes("const useNode = cliEntry.kind === 'js'"),
    'binary vs js launch is not distinguished');
  assert.ok(/const cmd = useNode \? nodeExe : cliEntry\.path/.test(SRC),
    'the platform binary is not spawned directly');
});
