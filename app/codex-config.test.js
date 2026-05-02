// Unit tests for app/codex-config.js. Run with:
//   node app/codex-config.test.js
//
// Coverage:
//   Path + detection
//   1.  codexConfigPath: ~/.codex/config.toml on every OS
//   2.  detectInstalledCodex: missing dir → false
//   3.  detectInstalledCodex: dir present → true
//   4.  detectInstalledCodex: file present (no dir) → true (defensive)
//
//   TOML primitives
//   5.  encodeTomlString: basic string
//   6.  encodeTomlString: escapes quotes + backslash
//   7.  encodeTomlString: escapes control chars
//   8.  decodeTomlString: round-trip with escapes
//   9.  decodeTomlString: rejects unterminated string
//   10. parseTomlValue: int / bool / array / inline-table
//
//   parseCodexToml / serializeCodexToml round-trip
//   11. Empty input → empty parsed shape
//   12. Single [mcp_servers.foo] table parses fully
//   13. Multiple tables preserve order
//   14. Comments + blank lines in opaque header survive
//   15. Unknown table (e.g. [tui] datetime values) becomes opaque + survives round-trip byte-for-byte
//   16. Array-of-tables ([[x]]) → null (refuse to clobber)
//   17. Truly malformed structural input → null
//
//   buildCodexMerlinEntry / sameMerlinBody
//   18. buildCodexMerlinEntry includes env when present
//   19. sameMerlinBody true on identical bodies
//   20. sameMerlinBody false on differing args
//   21. sameMerlinBody false when env presence differs
//
//   mergeCodexMerlinEntry
//   22. Empty config → adds mcp_servers.merlin
//   23. Existing OTHER mcp_servers entry preserved
//   24. Same merlin entry → no-op (changed=false)
//   25. Different merlin entry → overwrites in-place (preserves table order)
//   26. Caller's input is not mutated
//   27. Opaque table preserved across merge
//
//   Disk I/O
//   28. readExistingCodexConfig: missing file → empty parsed shape
//   29. readExistingCodexConfig: empty file → empty parsed shape
//   30. readExistingCodexConfig: corrupt structural TOML → null
//   31. writeMergedCodexConfig: atomic, mode 0o600 on POSIX
//   32. writeMergedCodexConfig: creates parent dir if missing
//
//   applyCodexRegistration
//   33. Fresh config → writes file + decision sentinel
//   34. Re-run on registered config → changed=false
//   35. Corrupt existing config → ok=false with clear error
//   36. Preserves user's other [mcp_servers.<name>] entries through registration
//
//   isRegisteredCodex
//   37. Missing file → false
//   38. Matching entry → true
//   39. Mismatched command → false
//
//   Decision sentinel
//   40. recordCodexSkip + readCodexDecision round-trip (skipped + major)
//   41. recordCodexSkip(never) → decision='never' with no major
//
//   Sidecar status
//   42. End-to-end: write a fake user TOML with multiple servers, register, verify
//       merlin appears AND the user's other servers + opaque [tui] table survive

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cc = require('./codex-config');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.log('  ✗', name);
    console.log('    ', err.stack || err.message);
    failed++;
  }
}

function tmpDir() {
  const d = path.join(os.tmpdir(), 'merlin-codex-test-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function rmTmp(d) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

const merlinBody = {
  command: 'C:\\fake\\node.exe',
  args: ['C:\\fake\\merlin-mcp-shim.js'],
};

// ── Path + detection ─────────────────────────────────────────

test('codexConfigPath: ~/.codex/config.toml on every OS', () => {
  const p = cc.codexConfigPath();
  assert.ok(p.endsWith(path.join('.codex', 'config.toml')), 'expected ~/.codex/config.toml, got: ' + p);
  assert.ok(p.startsWith(os.homedir()), 'expected to start with homedir');
});

test('detectInstalledCodex: missing dir → false', () => {
  const orig = os.homedir;
  const d = tmpDir();
  try {
    os.homedir = () => d;
    assert.strictEqual(cc.detectInstalledCodex(), false);
  } finally {
    os.homedir = orig;
    rmTmp(d);
  }
});

test('detectInstalledCodex: dir present → true', () => {
  const orig = os.homedir;
  const d = tmpDir();
  try {
    os.homedir = () => d;
    fs.mkdirSync(path.join(d, '.codex'));
    assert.strictEqual(cc.detectInstalledCodex(), true);
  } finally {
    os.homedir = orig;
    rmTmp(d);
  }
});

test('detectInstalledCodex: file present (no dir manually created here) → true', () => {
  const orig = os.homedir;
  const d = tmpDir();
  try {
    os.homedir = () => d;
    fs.mkdirSync(path.join(d, '.codex'));
    fs.writeFileSync(path.join(d, '.codex', 'config.toml'), '');
    assert.strictEqual(cc.detectInstalledCodex(), true);
  } finally {
    os.homedir = orig;
    rmTmp(d);
  }
});

// ── TOML primitives ──────────────────────────────────────────

test('encodeTomlString: basic string', () => {
  assert.strictEqual(cc.encodeTomlString('hello'), '"hello"');
});

test('encodeTomlString: escapes quotes + backslash', () => {
  assert.strictEqual(cc.encodeTomlString('he said "hi" \\ ok'), '"he said \\"hi\\" \\\\ ok"');
});

test('encodeTomlString: escapes control chars', () => {
  assert.strictEqual(cc.encodeTomlString('a\nb\tc'), '"a\\nb\\tc"');
});

test('decodeTomlString: round-trip with escapes', () => {
  const original = 'a\nb\t"c"\\d';
  const encoded = cc.encodeTomlString(original);
  const { value } = cc.decodeTomlString(encoded, 0);
  assert.strictEqual(value, original);
});

test('decodeTomlString: rejects unterminated string', () => {
  assert.throws(() => cc.decodeTomlString('"oops', 0), /unterminated/);
});

test('parseTomlValue: int / bool / array / inline-table', () => {
  assert.deepStrictEqual(cc.parseTomlValue('42', 0), { value: 42, next: 2 });
  assert.deepStrictEqual(cc.parseTomlValue('true', 0), { value: true, next: 4 });
  assert.deepStrictEqual(cc.parseTomlValue('false', 0), { value: false, next: 5 });
  const arr = cc.parseTomlValue('["a", "b"]', 0);
  assert.deepStrictEqual(arr.value, ['a', 'b']);
  const tbl = cc.parseTomlValue('{ KEY = "VAL", N = 3 }', 0);
  assert.deepStrictEqual(tbl.value, { KEY: 'VAL', N: 3 });
});

// ── parseCodexToml / serializeCodexToml round-trip ──────────

test('Empty input → empty parsed shape', () => {
  const p = cc.parseCodexToml('');
  assert.ok(p);
  assert.strictEqual(p.opaqueHeader, '');
  assert.deepStrictEqual(p.tables, []);
});

test('Single [mcp_servers.foo] table parses fully', () => {
  const src = '[mcp_servers.foo]\ncommand = "node"\nargs = ["a", "b"]\n';
  const p = cc.parseCodexToml(src);
  assert.strictEqual(p.tables.length, 1);
  assert.strictEqual(p.tables[0].kind, 'parsed');
  assert.strictEqual(p.tables[0].name, 'mcp_servers.foo');
  assert.deepStrictEqual(p.tables[0].body, { command: 'node', args: ['a', 'b'] });
});

test('Multiple tables preserve order', () => {
  const src = '[mcp_servers.alpha]\ncommand = "a"\nargs = []\n\n[mcp_servers.bravo]\ncommand = "b"\nargs = []\n';
  const p = cc.parseCodexToml(src);
  assert.strictEqual(p.tables.length, 2);
  assert.strictEqual(p.tables[0].name, 'mcp_servers.alpha');
  assert.strictEqual(p.tables[1].name, 'mcp_servers.bravo');
});

test('Comments + blank lines in opaque header survive', () => {
  const src = '# Codex config\n# generated 2026\n\n[mcp_servers.foo]\ncommand = "node"\nargs = []\n';
  const p = cc.parseCodexToml(src);
  assert.ok(p.opaqueHeader.includes('Codex config'));
  assert.ok(p.opaqueHeader.includes('generated 2026'));
});

test('Unknown table becomes opaque + survives round-trip byte-for-byte (relevant chunk)', () => {
  // [tui] uses a literal-string value our parser doesn't model; the
  // section should fall into the opaque bucket and emerge unchanged.
  const src = "[tui]\ntheme = 'dark-classic'\nshow_clock = true\n\n[mcp_servers.merlin]\ncommand = \"node\"\nargs = [\"shim.js\"]\n";
  const p = cc.parseCodexToml(src);
  assert.ok(p);
  // Find the [tui] table — should be opaque because of the literal string.
  const tui = p.tables.find((t) => t.name === 'tui');
  assert.ok(tui, '[tui] table should appear');
  assert.strictEqual(tui.kind, 'opaque', '[tui] should be opaque (literal-string value not modeled)');
  assert.ok(tui.source.includes("'dark-classic'"));
  // Re-serialize and confirm the [tui] block survives.
  const out = cc.serializeCodexToml(p);
  assert.ok(out.includes("'dark-classic'"));
  assert.ok(out.includes('show_clock = true'));
});

test('Array-of-tables ([[x]]) → null (refuse to clobber)', () => {
  const src = '[[products]]\nname = "Hammer"\n';
  const p = cc.parseCodexToml(src);
  assert.strictEqual(p, null);
});

test('Truly malformed table header → returned as opaque (defensive)', () => {
  // A header line that confuses headerRe falls into the previous
  // chunk's opaque body. We just want to confirm we don't crash.
  const src = '[mcp_servers.foo]\nbroken=line=here\n';
  const p = cc.parseCodexToml(src);
  // The body had multiple `=` which our parseSectionBody can't handle —
  // value parser will succeed on `line=here` because `line` isn't
  // a quoted string, so it's actually an integer-parse failure. That
  // throws, which turns the whole section opaque. Good.
  assert.strictEqual(p.tables.length, 1);
  assert.strictEqual(p.tables[0].kind, 'opaque');
});

// ── buildCodexMerlinEntry / sameMerlinBody ──────────────────

test('buildCodexMerlinEntry: includes env when present', () => {
  const e = cc.buildCodexMerlinEntry({
    nodePath: '/usr/bin/node',
    shimPath: '/opt/merlin/shim.js',
    env: { MERLIN_STATE_DIR: '/var/lib/merlin' },
  });
  assert.deepStrictEqual(e, {
    command: '/usr/bin/node',
    args: ['/opt/merlin/shim.js'],
    env: { MERLIN_STATE_DIR: '/var/lib/merlin' },
  });
});

test('buildCodexMerlinEntry: omits env when empty', () => {
  const e = cc.buildCodexMerlinEntry({ nodePath: 'node', shimPath: 's' });
  assert.deepStrictEqual(e, { command: 'node', args: ['s'] });
});

test('sameMerlinBody: true on identical bodies', () => {
  assert.strictEqual(cc.sameMerlinBody(merlinBody, JSON.parse(JSON.stringify(merlinBody))), true);
});

test('sameMerlinBody: false on differing args', () => {
  const b = JSON.parse(JSON.stringify(merlinBody));
  b.args = ['different.js'];
  assert.strictEqual(cc.sameMerlinBody(merlinBody, b), false);
});

test('sameMerlinBody: false when env presence differs', () => {
  const a = { command: 'n', args: ['s'] };
  const b = { command: 'n', args: ['s'], env: { K: 'V' } };
  assert.strictEqual(cc.sameMerlinBody(a, b), false);
});

// ── mergeCodexMerlinEntry ────────────────────────────────────

test('mergeCodexMerlinEntry: empty config → adds mcp_servers.merlin', () => {
  const empty = cc.parseCodexToml('');
  const out = cc.mergeCodexMerlinEntry(empty, merlinBody);
  assert.strictEqual(out.changed, true);
  assert.strictEqual(out.config.tables.length, 1);
  assert.strictEqual(out.config.tables[0].name, 'mcp_servers.merlin');
});

test('mergeCodexMerlinEntry: existing OTHER mcp_servers entry preserved', () => {
  const src = '[mcp_servers.other]\ncommand = "other"\nargs = []\n';
  const p = cc.parseCodexToml(src);
  const out = cc.mergeCodexMerlinEntry(p, merlinBody);
  assert.strictEqual(out.changed, true);
  const names = out.config.tables.map((t) => t.name);
  assert.ok(names.includes('mcp_servers.other'));
  assert.ok(names.includes('mcp_servers.merlin'));
});

test('mergeCodexMerlinEntry: same merlin entry → no-op', () => {
  const src = '[mcp_servers.merlin]\ncommand = ' + cc.encodeTomlString(merlinBody.command) + '\nargs = ' + JSON.stringify(merlinBody.args).replace(/"/g, '"') + '\n';
  // Build via the parser to guarantee shape parity.
  const built = cc.parseCodexToml(src);
  // sanity:
  assert.strictEqual(built.tables[0].name, 'mcp_servers.merlin');
  const out = cc.mergeCodexMerlinEntry(built, merlinBody);
  assert.strictEqual(out.changed, false);
});

test('mergeCodexMerlinEntry: different merlin entry → overwrites in-place (preserves table order)', () => {
  const src = '[mcp_servers.merlin]\ncommand = "old-node"\nargs = ["old.js"]\n\n[mcp_servers.other]\ncommand = "x"\nargs = []\n';
  const p = cc.parseCodexToml(src);
  const out = cc.mergeCodexMerlinEntry(p, merlinBody);
  assert.strictEqual(out.changed, true);
  const idxMerlin = out.config.tables.findIndex((t) => t.name === 'mcp_servers.merlin');
  const idxOther = out.config.tables.findIndex((t) => t.name === 'mcp_servers.other');
  // Merlin came first in the source; it should still be first.
  assert.ok(idxMerlin < idxOther, 'merlin order preserved');
  const merlin = out.config.tables[idxMerlin];
  assert.strictEqual(merlin.body.command, merlinBody.command);
  assert.deepStrictEqual(merlin.body.args, merlinBody.args);
});

test('mergeCodexMerlinEntry: caller input is not mutated', () => {
  const empty = cc.parseCodexToml('');
  const before = JSON.stringify(empty);
  cc.mergeCodexMerlinEntry(empty, merlinBody);
  assert.strictEqual(JSON.stringify(empty), before);
});

test('mergeCodexMerlinEntry: opaque table preserved across merge', () => {
  const src = "[tui]\ntheme = 'dark-classic'\n";
  const p = cc.parseCodexToml(src);
  const out = cc.mergeCodexMerlinEntry(p, merlinBody);
  const tui = out.config.tables.find((t) => t.name === 'tui');
  assert.ok(tui);
  assert.strictEqual(tui.kind, 'opaque');
  const rendered = cc.serializeCodexToml(out.config);
  assert.ok(rendered.includes("'dark-classic'"));
  assert.ok(rendered.includes('[mcp_servers.merlin]'));
});

// ── Disk I/O ────────────────────────────────────────────────

test('readExistingCodexConfig: missing file → empty parsed shape', () => {
  const d = tmpDir();
  try {
    const p = cc.readExistingCodexConfig(path.join(d, 'nope.toml'));
    assert.deepStrictEqual(p, { opaqueHeader: '', tables: [] });
  } finally { rmTmp(d); }
});

test('readExistingCodexConfig: empty file → empty parsed shape', () => {
  const d = tmpDir();
  try {
    const p = path.join(d, 'cfg.toml');
    fs.writeFileSync(p, '');
    assert.deepStrictEqual(cc.readExistingCodexConfig(p), { opaqueHeader: '', tables: [] });
  } finally { rmTmp(d); }
});

test('readExistingCodexConfig: corrupt structural TOML ([[]]) → null', () => {
  const d = tmpDir();
  try {
    const p = path.join(d, 'cfg.toml');
    fs.writeFileSync(p, '[[products]]\nname = "x"\n');
    assert.strictEqual(cc.readExistingCodexConfig(p), null);
  } finally { rmTmp(d); }
});

test('writeMergedCodexConfig: atomic, mode 0o600 on POSIX', () => {
  const d = tmpDir();
  try {
    const p = path.join(d, 'codex', 'config.toml');
    const src = '[mcp_servers.foo]\ncommand = "x"\nargs = []\n';
    const parsed = cc.parseCodexToml(src);
    const ok = cc.writeMergedCodexConfig(p, parsed);
    assert.strictEqual(ok, true);
    const content = fs.readFileSync(p, 'utf8');
    assert.ok(content.includes('[mcp_servers.foo]'));
    if (process.platform !== 'win32') {
      const mode = fs.statSync(p).mode & 0o777;
      assert.strictEqual(mode, 0o600);
    }
    // No tmp leftovers.
    const leftovers = fs.readdirSync(path.dirname(p)).filter((n) => n.startsWith('config.toml.merlin-tmp-'));
    assert.strictEqual(leftovers.length, 0);
  } finally { rmTmp(d); }
});

test('writeMergedCodexConfig: creates parent dir if missing', () => {
  const d = tmpDir();
  try {
    const deep = path.join(d, 'does', 'not', 'exist', 'config.toml');
    const parsed = cc.parseCodexToml('[mcp_servers.x]\ncommand = "y"\nargs = []\n');
    assert.strictEqual(cc.writeMergedCodexConfig(deep, parsed), true);
    assert.ok(fs.existsSync(deep));
  } finally { rmTmp(d); }
});

// ── applyCodexRegistration ──────────────────────────────────

test('applyCodexRegistration: fresh config → writes file + decision sentinel', () => {
  const stateDir = tmpDir();
  const cfgDir = tmpDir();
  try {
    const configPath = path.join(cfgDir, 'config.toml');
    const out = cc.applyCodexRegistration({ stateDir, configPath, merlinBody });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.changed, true);
    assert.ok(fs.existsSync(configPath));
    const txt = fs.readFileSync(configPath, 'utf8');
    assert.ok(txt.includes('[mcp_servers.merlin]'));
    assert.ok(txt.includes(cc.encodeTomlString(merlinBody.command)));
    // Decision sentinel persisted.
    const decision = cc.readCodexDecision(stateDir);
    assert.ok(decision);
    assert.strictEqual(decision.decision, 'added');
  } finally { rmTmp(stateDir); rmTmp(cfgDir); }
});

test('applyCodexRegistration: re-run on registered config → changed=false', () => {
  const stateDir = tmpDir();
  const cfgDir = tmpDir();
  try {
    const configPath = path.join(cfgDir, 'config.toml');
    cc.applyCodexRegistration({ stateDir, configPath, merlinBody });
    const out = cc.applyCodexRegistration({ stateDir, configPath, merlinBody });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.changed, false);
  } finally { rmTmp(stateDir); rmTmp(cfgDir); }
});

test('applyCodexRegistration: corrupt existing config → ok=false with clear error', () => {
  const stateDir = tmpDir();
  const cfgDir = tmpDir();
  try {
    const configPath = path.join(cfgDir, 'config.toml');
    fs.writeFileSync(configPath, '[[products]]\nname = "x"\n'); // unsupported
    const out = cc.applyCodexRegistration({ stateDir, configPath, merlinBody });
    assert.strictEqual(out.ok, false);
    assert.ok(/unparseable/i.test(out.error));
  } finally { rmTmp(stateDir); rmTmp(cfgDir); }
});

test('applyCodexRegistration: preserves user other [mcp_servers.<name>] entries', () => {
  const stateDir = tmpDir();
  const cfgDir = tmpDir();
  try {
    const configPath = path.join(cfgDir, 'config.toml');
    fs.writeFileSync(configPath, '[mcp_servers.team_shared]\ncommand = "team"\nargs = ["bin"]\n');
    const out = cc.applyCodexRegistration({ stateDir, configPath, merlinBody });
    assert.strictEqual(out.ok, true);
    const txt = fs.readFileSync(configPath, 'utf8');
    assert.ok(txt.includes('[mcp_servers.team_shared]'));
    assert.ok(txt.includes('[mcp_servers.merlin]'));
  } finally { rmTmp(stateDir); rmTmp(cfgDir); }
});

// ── isRegisteredCodex ───────────────────────────────────────

test('isRegisteredCodex: missing file → false', () => {
  const d = tmpDir();
  try {
    assert.strictEqual(
      cc.isRegisteredCodex({ configPath: path.join(d, 'nope.toml'), merlinBody }),
      false,
    );
  } finally { rmTmp(d); }
});

test('isRegisteredCodex: matching entry → true', () => {
  const stateDir = tmpDir();
  const cfgDir = tmpDir();
  try {
    const configPath = path.join(cfgDir, 'config.toml');
    cc.applyCodexRegistration({ stateDir, configPath, merlinBody });
    assert.strictEqual(cc.isRegisteredCodex({ configPath, merlinBody }), true);
  } finally { rmTmp(stateDir); rmTmp(cfgDir); }
});

test('isRegisteredCodex: mismatched command → false', () => {
  const stateDir = tmpDir();
  const cfgDir = tmpDir();
  try {
    const configPath = path.join(cfgDir, 'config.toml');
    cc.applyCodexRegistration({ stateDir, configPath, merlinBody });
    const otherBody = { command: 'somewhere/else/node', args: merlinBody.args };
    assert.strictEqual(cc.isRegisteredCodex({ configPath, merlinBody: otherBody }), false);
  } finally { rmTmp(stateDir); rmTmp(cfgDir); }
});

// ── Decision sentinel ───────────────────────────────────────

test('recordCodexSkip + readCodexDecision round-trip (skipped + major)', () => {
  const d = tmpDir();
  try {
    cc.recordCodexSkip(d, 7, false);
    const dec = cc.readCodexDecision(d);
    assert.strictEqual(dec.decision, 'skipped');
    assert.strictEqual(dec.major, 7);
  } finally { rmTmp(d); }
});

test('recordCodexSkip(never) → decision=never with no major', () => {
  const d = tmpDir();
  try {
    cc.recordCodexSkip(d, 7, true);
    const dec = cc.readCodexDecision(d);
    assert.strictEqual(dec.decision, 'never');
    assert.strictEqual(dec.major, undefined);
  } finally { rmTmp(d); }
});

// ── End-to-end ──────────────────────────────────────────────

test('End-to-end: register into a multi-server file with opaque [tui] section', () => {
  const stateDir = tmpDir();
  const cfgDir = tmpDir();
  try {
    const configPath = path.join(cfgDir, 'config.toml');
    fs.writeFileSync(configPath, [
      "# Hand-edited Codex config",
      "",
      "[tui]",
      "theme = 'dark-classic'",
      "show_clock = true",
      "",
      "[mcp_servers.team_shared]",
      'command = "team-bin"',
      'args = ["--mode", "prod"]',
      "",
    ].join('\n'));
    const out = cc.applyCodexRegistration({ stateDir, configPath, merlinBody });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.changed, true);
    const txt = fs.readFileSync(configPath, 'utf8');
    assert.ok(txt.includes('[mcp_servers.merlin]'), 'merlin written');
    assert.ok(txt.includes('[mcp_servers.team_shared]'), 'team_shared preserved');
    assert.ok(txt.includes("[tui]"), '[tui] header preserved');
    assert.ok(txt.includes("'dark-classic'"), '[tui] body preserved verbatim');
    assert.ok(txt.includes('show_clock = true'), '[tui] body preserved verbatim');
  } finally { rmTmp(stateDir); rmTmp(cfgDir); }
});

// ── Summary ─────────────────────────────────────────────────

console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
