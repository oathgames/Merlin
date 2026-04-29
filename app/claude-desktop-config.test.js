// Unit tests for app/claude-desktop-config.js. Run with:
//   node app/claude-desktop-config.test.js
//
// Coverage:
//   1. claudeDesktopConfigPath: per-OS path
//   2. mergeMerlinEntry: empty config → adds mcpServers + merlin
//   3. mergeMerlinEntry: existing mcpServers → preserves siblings
//   4. mergeMerlinEntry: same merlin entry → no-op (changed=false)
//   5. mergeMerlinEntry: different merlin entry → overwrites
//   6. readExistingConfig: missing file → {}
//   7. readExistingConfig: corrupt file → null (refuse to clobber)
//   8. writeMergedConfig: atomic, preserves non-merlin entries
//   9. shouldPrompt: never → fire=false
//  10. shouldPrompt: skipped on same major → fire=false
//  11. shouldPrompt: skipped on older major → fire=true
//  12. shouldPrompt: missing config dir → fire=false (claude desktop not installed)
//  13. shouldPrompt: matching merlin entry already present → fire=false
//  14. isRegistered: detects matching entry
//  15. applyRegistration: writes config + decision

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cdc = require('./claude-desktop-config');

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
  const d = path.join(os.tmpdir(), 'merlin-cdc-test-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function rmTmp(d) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

const merlinEntry = {
  command: 'C:\\\\fake\\\\node.exe',
  args: ['C:\\\\fake\\\\merlin-mcp-shim.js'],
};

// ── Path resolution ──────────────────────────────────────────

test('claudeDesktopConfigPath(win32) targets %APPDATA%\\Claude', () => {
  const orig = process.env.APPDATA;
  try {
    process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming';
    const p = cdc.claudeDesktopConfigPath('win32');
    assert.ok(p.endsWith(path.join('Claude', 'claude_desktop_config.json')));
    assert.ok(p.includes('Roaming'));
  } finally {
    if (orig === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = orig;
  }
});

test('claudeDesktopConfigPath(darwin) targets Library/Application Support/Claude', () => {
  const p = cdc.claudeDesktopConfigPath('darwin');
  assert.ok(p.includes(path.join('Library', 'Application Support', 'Claude')));
  assert.ok(p.endsWith('claude_desktop_config.json'));
});

test('claudeDesktopConfigPath(linux) targets ~/.config/Claude', () => {
  const p = cdc.claudeDesktopConfigPath('linux');
  assert.ok(p.includes(path.join('.config', 'Claude')));
});

// ── Merge logic ──────────────────────────────────────────────

test('mergeMerlinEntry: empty config → adds mcpServers + merlin', () => {
  const out = cdc.mergeMerlinEntry({}, merlinEntry);
  assert.strictEqual(out.changed, true);
  assert.deepStrictEqual(out.config.mcpServers.merlin, merlinEntry);
});

test('mergeMerlinEntry: existing mcpServers → preserves siblings', () => {
  const existing = {
    mcpServers: {
      cline: { command: 'cline', args: [] },
      cursor: { command: 'cursor', args: [] },
    },
    otherSetting: 'preserved',
  };
  const out = cdc.mergeMerlinEntry(existing, merlinEntry);
  assert.strictEqual(out.changed, true);
  assert.ok(out.config.mcpServers.cline);
  assert.ok(out.config.mcpServers.cursor);
  assert.deepStrictEqual(out.config.mcpServers.merlin, merlinEntry);
  assert.strictEqual(out.config.otherSetting, 'preserved');
  // Caller's input must not be mutated.
  assert.ok(!existing.mcpServers.merlin);
});

test('mergeMerlinEntry: same merlin entry → no-op (changed=false)', () => {
  const existing = { mcpServers: { merlin: merlinEntry } };
  const out = cdc.mergeMerlinEntry(existing, merlinEntry);
  assert.strictEqual(out.changed, false);
});

test('mergeMerlinEntry: different merlin entry → overwrites', () => {
  const existing = { mcpServers: { merlin: { command: 'old-node', args: ['old.js'] } } };
  const out = cdc.mergeMerlinEntry(existing, merlinEntry);
  assert.strictEqual(out.changed, true);
  assert.deepStrictEqual(out.config.mcpServers.merlin, merlinEntry);
});

// ── Disk I/O ─────────────────────────────────────────────────

test('readExistingConfig: missing file → {}', () => {
  const d = tmpDir();
  try {
    assert.deepStrictEqual(cdc.readExistingConfig(path.join(d, 'nope.json')), {});
  } finally { rmTmp(d); }
});

test('readExistingConfig: corrupt file → null (refuse to clobber)', () => {
  const d = tmpDir();
  try {
    const p = path.join(d, 'cfg.json');
    fs.writeFileSync(p, '{not-json');
    assert.strictEqual(cdc.readExistingConfig(p), null);
  } finally { rmTmp(d); }
});

test('writeMergedConfig: atomic, preserves non-merlin entries', () => {
  const d = tmpDir();
  try {
    const p = path.join(d, 'cfg.json');
    fs.writeFileSync(p, JSON.stringify({ mcpServers: { cline: { command: 'cline', args: [] } } }));
    const existing = cdc.readExistingConfig(p);
    const { config } = cdc.mergeMerlinEntry(existing, merlinEntry);
    const ok = cdc.writeMergedConfig(p, config);
    assert.strictEqual(ok, true);
    const reloaded = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(reloaded.mcpServers.cline);
    assert.deepStrictEqual(reloaded.mcpServers.merlin, merlinEntry);
    // No tmp leftover.
    const leftovers = fs.readdirSync(d).filter((n) => n.startsWith('cfg.json.merlin-tmp-'));
    assert.strictEqual(leftovers.length, 0);
  } finally { rmTmp(d); }
});

// ── Decision sentinel ────────────────────────────────────────

test('shouldPrompt: decision=never → fire=false', () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, '.mcp-claude-desktop-prompt'), JSON.stringify({ decision: 'never' }));
    // Stage a fake claude desktop config dir.
    const ccDir = tmpDir();
    const out = cdc.shouldPrompt({
      stateDir: d,
      configPath: path.join(ccDir, 'claude_desktop_config.json'),
      merlinEntry,
      currentMajor: 1,
    });
    assert.strictEqual(out.fire, false);
    assert.strictEqual(out.reason, 'user-chose-never');
    rmTmp(ccDir);
  } finally { rmTmp(d); }
});

test('shouldPrompt: skipped on same major → fire=false', () => {
  const d = tmpDir();
  const ccDir = tmpDir();
  try {
    fs.writeFileSync(path.join(d, '.mcp-claude-desktop-prompt'), JSON.stringify({ decision: 'skipped', major: 1 }));
    const out = cdc.shouldPrompt({
      stateDir: d,
      configPath: path.join(ccDir, 'claude_desktop_config.json'),
      merlinEntry,
      currentMajor: 1,
    });
    assert.strictEqual(out.fire, false);
    assert.strictEqual(out.reason, 'skipped-this-major');
  } finally { rmTmp(d); rmTmp(ccDir); }
});

test('shouldPrompt: skipped on older major → fire=true on bump', () => {
  const d = tmpDir();
  const ccDir = tmpDir();
  try {
    fs.writeFileSync(path.join(d, '.mcp-claude-desktop-prompt'), JSON.stringify({ decision: 'skipped', major: 1 }));
    const out = cdc.shouldPrompt({
      stateDir: d,
      configPath: path.join(ccDir, 'claude_desktop_config.json'),
      merlinEntry,
      currentMajor: 2,
    });
    assert.strictEqual(out.fire, true);
  } finally { rmTmp(d); rmTmp(ccDir); }
});

test('shouldPrompt: missing config dir → fire=false (claude desktop not installed)', () => {
  const d = tmpDir();
  try {
    const out = cdc.shouldPrompt({
      stateDir: d,
      configPath: '/path/that/definitely/does/not/exist/claude_desktop_config.json',
      merlinEntry,
      currentMajor: 1,
    });
    assert.strictEqual(out.fire, false);
    assert.strictEqual(out.reason, 'claude-desktop-not-installed');
  } finally { rmTmp(d); }
});

test('shouldPrompt: matching merlin entry already present → fire=false', () => {
  const d = tmpDir();
  const ccDir = tmpDir();
  try {
    const cfgPath = path.join(ccDir, 'claude_desktop_config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: { merlin: merlinEntry } }));
    const out = cdc.shouldPrompt({
      stateDir: d,
      configPath: cfgPath,
      merlinEntry,
      currentMajor: 1,
    });
    assert.strictEqual(out.fire, false);
    assert.strictEqual(out.reason, 'already-registered');
  } finally { rmTmp(d); rmTmp(ccDir); }
});

test('isRegistered: detects matching entry', () => {
  const ccDir = tmpDir();
  try {
    const cfgPath = path.join(ccDir, 'claude_desktop_config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: { merlin: merlinEntry } }));
    assert.strictEqual(cdc.isRegistered({ configPath: cfgPath, merlinEntry }), true);
  } finally { rmTmp(ccDir); }
});

test('isRegistered: no entry → false', () => {
  const ccDir = tmpDir();
  try {
    const cfgPath = path.join(ccDir, 'claude_desktop_config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: { cline: { command: 'cline', args: [] } } }));
    assert.strictEqual(cdc.isRegistered({ configPath: cfgPath, merlinEntry }), false);
  } finally { rmTmp(ccDir); }
});

test('applyRegistration: writes config + persists decision', () => {
  const d = tmpDir();
  const ccDir = tmpDir();
  try {
    const cfgPath = path.join(ccDir, 'claude_desktop_config.json');
    const out = cdc.applyRegistration({ stateDir: d, configPath: cfgPath, merlinEntry });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.changed, true);
    const reloaded = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.deepStrictEqual(reloaded.mcpServers.merlin, merlinEntry);
    const decisionFile = JSON.parse(fs.readFileSync(path.join(d, '.mcp-claude-desktop-prompt'), 'utf8'));
    assert.strictEqual(decisionFile.decision, 'added');
  } finally { rmTmp(d); rmTmp(ccDir); }
});

test('applyRegistration: corrupt config → ok=false, refuse to clobber', () => {
  const d = tmpDir();
  const ccDir = tmpDir();
  try {
    const cfgPath = path.join(ccDir, 'claude_desktop_config.json');
    fs.writeFileSync(cfgPath, '{not-json');
    const out = cdc.applyRegistration({ stateDir: d, configPath: cfgPath, merlinEntry });
    assert.strictEqual(out.ok, false);
    assert.ok(/unparseable/.test(out.error));
    // Original corrupt file untouched.
    assert.strictEqual(fs.readFileSync(cfgPath, 'utf8'), '{not-json');
  } finally { rmTmp(d); rmTmp(ccDir); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
