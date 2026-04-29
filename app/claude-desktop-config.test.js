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
//
// Claude Code (two-file model) — added 2026-04-29 after live incident
// where v1.20.0 wrote .mcp.json correctly but never enabled merlin in
// ~/.claude.json's enabledMcpjsonServers, so Claude Code refused to
// load it (security model: per-project trust required).
//  16. claudeCodeConfigPath: ~/.claude.json on every OS
//  17. claudeCodeProjectMcpPath: <project>/.mcp.json
//  18. resolveProjectKey: missing path → error
//  19. resolveProjectKey: file (not dir) → error
//  20. resolveProjectKey: real dir → ok + absolute path
//  21. mergeMcpJsonMerlinEntry: empty → adds mcpServers + merlin
//  22. mergeMcpJsonMerlinEntry: preserves other servers
//  23. mergeMcpJsonMerlinEntry: same entry → no-op
//  24. mergeClaudeJsonEnable: no projects map → creates it
//  25. mergeClaudeJsonEnable: project entry exists, no enabled list → adds list with merlin
//  26. mergeClaudeJsonEnable: appends merlin without removing other entries
//  27. mergeClaudeJsonEnable: idempotent — merlin already enabled → no-op
//  28. mergeClaudeJsonEnable: removes merlin from disabledMcpjsonServers
//  29. mergeClaudeJsonEnable: preserves all other top-level fields
//  30. mergeClaudeJsonEnable: preserves other projects untouched
//  31. applyRegistrationClaudeCode: writes both files + remembers project
//  32. applyRegistrationClaudeCode: refuses corrupt .mcp.json
//  33. applyRegistrationClaudeCode: refuses corrupt ~/.claude.json
//  34. applyRegistrationClaudeCode: idempotent — re-run on registered project → changed=false
//  35. isRegisteredClaudeCode: only true when BOTH files match
//  36. listClaudeCodeProjectsStatus: enumerates remembered + live state
//  37. rememberClaudeCodeProject: dedups + atomic
//  38. detectInstalledClients: returns shape {desktop, code}

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

test('shouldPrompt: neither client installed → fire=false', () => {
  const d = tmpDir();
  try {
    const out = cdc.shouldPrompt({
      stateDir: d,
      configPath: '/path/that/definitely/does/not/exist/claude_desktop_config.json',
      merlinEntry,
      currentMajor: 1,
      installedClients: { desktop: false, code: false },
    });
    assert.strictEqual(out.fire, false);
    assert.strictEqual(out.reason, 'no-claude-host-installed');
  } finally { rmTmp(d); }
});

test('shouldPrompt: only Claude Code installed (no Desktop config dir) → fire=true', () => {
  // Gitar PR #163 regression guard: pre-fix a Claude-Code-only user
  // never saw the autoprompt because shouldPrompt bailed on
  // claude-desktop-not-installed before any Code-side check.
  const d = tmpDir();
  try {
    const out = cdc.shouldPrompt({
      stateDir: d,
      configPath: '/path/that/definitely/does/not/exist/claude_desktop_config.json',
      merlinEntry,
      currentMajor: 1,
      installedClients: { desktop: false, code: true },
    });
    assert.strictEqual(out.fire, true);
    assert.strictEqual(out.reason, 'prompt-needed');
  } finally { rmTmp(d); }
});

test('shouldPrompt: Desktop-only + matching merlin entry already present → fire=false', () => {
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
      installedClients: { desktop: true, code: false },
    });
    assert.strictEqual(out.fire, false);
    assert.strictEqual(out.reason, 'already-registered');
  } finally { rmTmp(d); rmTmp(ccDir); }
});

test('shouldPrompt: BOTH installed + Desktop already-registered → STILL fires (Code-side enablement may be needed)', () => {
  // Gitar PR #163 regression guard: with Code installed, even a
  // matching Desktop registration must not suppress the prompt —
  // the user may want to enable a new project for Code.
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
      installedClients: { desktop: true, code: true },
    });
    assert.strictEqual(out.fire, true);
    assert.strictEqual(out.reason, 'prompt-needed');
  } finally { rmTmp(d); rmTmp(ccDir); }
});

test('shouldPrompt: decision=added (with major stamp) → fire=false on same major (Gitar PR #163)', () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, '.mcp-claude-desktop-prompt'),
      JSON.stringify({ decision: 'added', major: 1 }));
    const out = cdc.shouldPrompt({
      stateDir: d,
      configPath: '/never',
      merlinEntry,
      currentMajor: 1,
      installedClients: { desktop: true, code: true },
    });
    assert.strictEqual(out.fire, false);
    assert.strictEqual(out.reason, 'already-added-this-major');
  } finally { rmTmp(d); }
});

test('shouldPrompt: decision=added (with major stamp) → fire=true on major bump', () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, '.mcp-claude-desktop-prompt'),
      JSON.stringify({ decision: 'added', major: 1 }));
    const out = cdc.shouldPrompt({
      stateDir: d,
      configPath: '/never',
      merlinEntry,
      currentMajor: 2,
      installedClients: { desktop: true, code: true },
    });
    assert.strictEqual(out.fire, true);
  } finally { rmTmp(d); }
});

test('shouldPrompt: legacy decision=added (no major field, v1.20.0 sentinel) → fire=false (treat as current major)', () => {
  const d = tmpDir();
  try {
    // v1.20.0 wrote 'added' without a major field. We must remain
    // compatible with those sentinels — treat as if stamped with the
    // current major so existing users don't get re-prompted.
    fs.writeFileSync(path.join(d, '.mcp-claude-desktop-prompt'),
      JSON.stringify({ decision: 'added', at: 1234567890 })); // no major field
    const out = cdc.shouldPrompt({
      stateDir: d,
      configPath: '/never',
      merlinEntry,
      currentMajor: 1,
      installedClients: { desktop: true, code: true },
    });
    assert.strictEqual(out.fire, false);
    assert.strictEqual(out.reason, 'already-added-this-major');
  } finally { rmTmp(d); }
});

test('shouldPrompt: backward compat — no installedClients param → falls back to detection', () => {
  // Older callers (before v1.20.5) called shouldPrompt without
  // installedClients. The function MUST still work, falling back to
  // detectInstalledClients(). We exercise this path by passing a
  // never-existent configPath and asserting we don't crash; the actual
  // fire/no-fire depends on the test machine's installed clients,
  // which is not what we're asserting — we're asserting the function
  // returns a valid {fire, reason} envelope without throwing.
  const d = tmpDir();
  try {
    const out = cdc.shouldPrompt({
      stateDir: d,
      configPath: '/never-exists-' + Date.now(),
      merlinEntry,
      currentMajor: 1,
      // installedClients deliberately omitted
    });
    assert.strictEqual(typeof out, 'object');
    assert.strictEqual(typeof out.fire, 'boolean');
    assert.strictEqual(typeof out.reason, 'string');
  } finally { rmTmp(d); }
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

// ── Claude Code: path helpers ────────────────────────────────

test('claudeCodeConfigPath: ~/.claude.json on every OS', () => {
  const p = cdc.claudeCodeConfigPath();
  assert.ok(p.endsWith('.claude.json'));
  assert.ok(p.includes(os.homedir()));
});

test('claudeCodeProjectMcpPath: <project>/.mcp.json', () => {
  const p = cdc.claudeCodeProjectMcpPath('/some/project');
  assert.strictEqual(p, path.join('/some/project', '.mcp.json'));
});

// ── Claude Code: project-key resolution ──────────────────────

test('resolveProjectKey: missing path → error', () => {
  const r = cdc.resolveProjectKey('/path/that/does/not/exist/abc-xyz-' + Date.now());
  assert.strictEqual(r.ok, false);
  assert.ok(/does not exist/i.test(r.error));
});

test('resolveProjectKey: file (not dir) → error', () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'file.txt');
    fs.writeFileSync(f, 'hi');
    const r = cdc.resolveProjectKey(f);
    assert.strictEqual(r.ok, false);
    assert.ok(/not a directory/i.test(r.error));
  } finally { rmTmp(d); }
});

test('resolveProjectKey: real dir → ok + absolute path', () => {
  const d = tmpDir();
  try {
    const r = cdc.resolveProjectKey(d);
    assert.strictEqual(r.ok, true);
    assert.ok(path.isAbsolute(r.key));
    // realpath collapses to canonical form; key should round-trip via fs.statSync.
    assert.ok(fs.statSync(r.key).isDirectory());
  } finally { rmTmp(d); }
});

test('resolveProjectKey: empty string → error', () => {
  const r = cdc.resolveProjectKey('');
  assert.strictEqual(r.ok, false);
  assert.ok(/empty/i.test(r.error));
});

// ── Claude Code: .mcp.json merge ─────────────────────────────

test('mergeMcpJsonMerlinEntry: empty → adds mcpServers + merlin', () => {
  const out = cdc.mergeMcpJsonMerlinEntry({}, merlinEntry);
  assert.strictEqual(out.changed, true);
  assert.deepStrictEqual(out.config.mcpServers.merlin, merlinEntry);
});

test('mergeMcpJsonMerlinEntry: preserves other servers', () => {
  const existing = {
    mcpServers: {
      'other-mcp': { command: 'other', args: ['x'] },
    },
    extraField: 'preserved',
  };
  const out = cdc.mergeMcpJsonMerlinEntry(existing, merlinEntry);
  assert.strictEqual(out.changed, true);
  assert.deepStrictEqual(out.config.mcpServers['other-mcp'], { command: 'other', args: ['x'] });
  assert.deepStrictEqual(out.config.mcpServers.merlin, merlinEntry);
  assert.strictEqual(out.config.extraField, 'preserved');
  // Caller's input must not be mutated.
  assert.strictEqual(existing.mcpServers.merlin, undefined);
});

test('mergeMcpJsonMerlinEntry: same entry → no-op', () => {
  const existing = { mcpServers: { merlin: merlinEntry } };
  const out = cdc.mergeMcpJsonMerlinEntry(existing, merlinEntry);
  assert.strictEqual(out.changed, false);
});

// ── Claude Code: ~/.claude.json merge ────────────────────────

test('mergeClaudeJsonEnable: no projects map → creates it', () => {
  const existing = { numStartups: 7, theme: 'dark' };
  const out = cdc.mergeClaudeJsonEnable(existing, 'C:\\proj');
  assert.strictEqual(out.changed, true);
  assert.deepStrictEqual(out.config.projects['C:\\proj'].enabledMcpjsonServers, ['merlin']);
  assert.strictEqual(out.config.numStartups, 7);
  assert.strictEqual(out.config.theme, 'dark');
});

test('mergeClaudeJsonEnable: project entry exists, no enabled list → adds list with merlin', () => {
  const existing = {
    projects: {
      '/proj': { allowedTools: ['x'], hasTrustDialogAccepted: true },
    },
  };
  const out = cdc.mergeClaudeJsonEnable(existing, '/proj');
  assert.strictEqual(out.changed, true);
  assert.deepStrictEqual(out.config.projects['/proj'].enabledMcpjsonServers, ['merlin']);
  assert.deepStrictEqual(out.config.projects['/proj'].allowedTools, ['x']);
  assert.strictEqual(out.config.projects['/proj'].hasTrustDialogAccepted, true);
});

test('mergeClaudeJsonEnable: appends merlin without removing other entries', () => {
  const existing = {
    projects: {
      '/proj': { enabledMcpjsonServers: ['other-mcp', 'foo'] },
    },
  };
  const out = cdc.mergeClaudeJsonEnable(existing, '/proj');
  assert.strictEqual(out.changed, true);
  assert.deepStrictEqual(out.config.projects['/proj'].enabledMcpjsonServers, ['other-mcp', 'foo', 'merlin']);
});

test('mergeClaudeJsonEnable: idempotent — merlin already enabled → no-op', () => {
  const existing = {
    projects: {
      '/proj': { enabledMcpjsonServers: ['merlin', 'other'] },
    },
  };
  const out = cdc.mergeClaudeJsonEnable(existing, '/proj');
  assert.strictEqual(out.changed, false);
  // Order preserved.
  assert.deepStrictEqual(existing.projects['/proj'].enabledMcpjsonServers, ['merlin', 'other']);
});

test('mergeClaudeJsonEnable: removes merlin from disabledMcpjsonServers when re-enabling', () => {
  const existing = {
    projects: {
      '/proj': {
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: ['merlin', 'other'],
      },
    },
  };
  const out = cdc.mergeClaudeJsonEnable(existing, '/proj');
  assert.strictEqual(out.changed, true);
  assert.deepStrictEqual(out.config.projects['/proj'].enabledMcpjsonServers, ['merlin']);
  assert.deepStrictEqual(out.config.projects['/proj'].disabledMcpjsonServers, ['other']);
});

test('mergeClaudeJsonEnable: preserves all other top-level fields', () => {
  const existing = {
    numStartups: 42,
    installMethod: 'npm',
    autoUpdates: true,
    cachedDynamicConfigs: { foo: 'bar' },
    projects: {
      '/proj': { enabledMcpjsonServers: [] },
    },
  };
  const out = cdc.mergeClaudeJsonEnable(existing, '/proj');
  assert.strictEqual(out.changed, true);
  assert.strictEqual(out.config.numStartups, 42);
  assert.strictEqual(out.config.installMethod, 'npm');
  assert.strictEqual(out.config.autoUpdates, true);
  assert.deepStrictEqual(out.config.cachedDynamicConfigs, { foo: 'bar' });
});

test('mergeClaudeJsonEnable: preserves other projects untouched', () => {
  const existing = {
    projects: {
      '/proj-a': { enabledMcpjsonServers: ['only-a'], hasTrustDialogAccepted: true },
      '/proj-b': { enabledMcpjsonServers: [] },
    },
  };
  const out = cdc.mergeClaudeJsonEnable(existing, '/proj-b');
  assert.strictEqual(out.changed, true);
  // proj-a untouched.
  assert.deepStrictEqual(out.config.projects['/proj-a'].enabledMcpjsonServers, ['only-a']);
  assert.strictEqual(out.config.projects['/proj-a'].hasTrustDialogAccepted, true);
  // proj-b updated.
  assert.deepStrictEqual(out.config.projects['/proj-b'].enabledMcpjsonServers, ['merlin']);
});

test('mergeClaudeJsonEnable: deep-clones — caller mutating output other-project entry does NOT mutate input (Gitar PR #163)', () => {
  // Pre-fix Object.assign({}, cfg.projects) shallow-copied the projects
  // map but left other-project entry refs shared with `existing`.
  // Post-fix uses JSON deep-clone on the entire input.
  const existing = {
    projects: {
      '/proj-target': { enabledMcpjsonServers: [] },
      '/proj-other': { enabledMcpjsonServers: ['only-other'], hasTrustDialogAccepted: true },
    },
  };
  const out = cdc.mergeClaudeJsonEnable(existing, '/proj-target');
  // Mutate the OTHER project in the returned config aggressively.
  out.config.projects['/proj-other'].enabledMcpjsonServers.push('mutation-test');
  out.config.projects['/proj-other'].hasTrustDialogAccepted = false;
  // Caller's input must remain pristine.
  assert.deepStrictEqual(existing.projects['/proj-other'].enabledMcpjsonServers, ['only-other']);
  assert.strictEqual(existing.projects['/proj-other'].hasTrustDialogAccepted, true);
});

test('mergeClaudeJsonEnable: does NOT invent disabledMcpjsonServers field if absent', () => {
  // If Claude Code never wrote disabledMcpjsonServers for this project,
  // we MUST NOT add it during enablement — we only add the enable list.
  const existing = { projects: { '/proj': { allowedTools: [] } } };
  const out = cdc.mergeClaudeJsonEnable(existing, '/proj');
  assert.strictEqual(out.changed, true);
  assert.deepStrictEqual(out.config.projects['/proj'].enabledMcpjsonServers, ['merlin']);
  assert.strictEqual(out.config.projects['/proj'].disabledMcpjsonServers, undefined);
});

// ── Claude Code: applyRegistrationClaudeCode (integration) ───

test('applyRegistrationClaudeCode: writes both files + remembers project', () => {
  const stateDir = tmpDir();
  const projDir = tmpDir();
  const homeDir = tmpDir();
  const claudeJsonPath = path.join(homeDir, '.claude.json');
  try {
    // Pre-existing ~/.claude.json with another project so we verify
    // preservation across the merge.
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      numStartups: 5,
      projects: { '/some/other': { enabledMcpjsonServers: ['only-other'] } },
    }, null, 2));

    const out = cdc.applyRegistrationClaudeCode({
      stateDir,
      claudeJsonPath,
      projectRoot: projDir,
      merlinEntry,
    });
    assert.strictEqual(out.ok, true, 'expected ok=true, got: ' + JSON.stringify(out));
    assert.strictEqual(out.changed, true);

    // .mcp.json written with merlin entry.
    const mcpJson = JSON.parse(fs.readFileSync(out.mcpJsonPath, 'utf8'));
    assert.deepStrictEqual(mcpJson.mcpServers.merlin, merlinEntry);

    // ~/.claude.json updated with merlin enabled at the project key.
    const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    assert.deepStrictEqual(claudeJson.projects[out.projectKey].enabledMcpjsonServers, ['merlin']);
    // Other project untouched.
    assert.deepStrictEqual(claudeJson.projects['/some/other'].enabledMcpjsonServers, ['only-other']);
    // Other top-level field untouched.
    assert.strictEqual(claudeJson.numStartups, 5);

    // Remembered.
    const remembered = cdc.readClaudeCodeProjects(stateDir);
    assert.ok(remembered.includes(out.projectKey));
  } finally { rmTmp(stateDir); rmTmp(projDir); rmTmp(homeDir); }
});

test('applyRegistrationClaudeCode: refuses corrupt .mcp.json', () => {
  const stateDir = tmpDir();
  const projDir = tmpDir();
  const homeDir = tmpDir();
  try {
    fs.writeFileSync(path.join(projDir, '.mcp.json'), '{not-json');
    const out = cdc.applyRegistrationClaudeCode({
      stateDir,
      claudeJsonPath: path.join(homeDir, '.claude.json'),
      projectRoot: projDir,
      merlinEntry,
    });
    assert.strictEqual(out.ok, false);
    assert.ok(/unparseable/i.test(out.error));
    // Original corrupt file untouched.
    assert.strictEqual(fs.readFileSync(path.join(projDir, '.mcp.json'), 'utf8'), '{not-json');
  } finally { rmTmp(stateDir); rmTmp(projDir); rmTmp(homeDir); }
});

test('applyRegistrationClaudeCode: refuses corrupt ~/.claude.json (after .mcp.json write)', () => {
  const stateDir = tmpDir();
  const projDir = tmpDir();
  const homeDir = tmpDir();
  const claudeJsonPath = path.join(homeDir, '.claude.json');
  try {
    fs.writeFileSync(claudeJsonPath, '{garbage');
    const out = cdc.applyRegistrationClaudeCode({
      stateDir,
      claudeJsonPath,
      projectRoot: projDir,
      merlinEntry,
    });
    assert.strictEqual(out.ok, false);
    assert.ok(/unparseable/i.test(out.error));
    // ~/.claude.json untouched.
    assert.strictEqual(fs.readFileSync(claudeJsonPath, 'utf8'), '{garbage');
  } finally { rmTmp(stateDir); rmTmp(projDir); rmTmp(homeDir); }
});

test('applyRegistrationClaudeCode: idempotent — re-run on registered project → changed=false', () => {
  const stateDir = tmpDir();
  const projDir = tmpDir();
  const homeDir = tmpDir();
  const claudeJsonPath = path.join(homeDir, '.claude.json');
  try {
    const first = cdc.applyRegistrationClaudeCode({
      stateDir, claudeJsonPath, projectRoot: projDir, merlinEntry,
    });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.changed, true);

    const second = cdc.applyRegistrationClaudeCode({
      stateDir, claudeJsonPath, projectRoot: projDir, merlinEntry,
    });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.changed, false, 'expected idempotent re-run, got: ' + JSON.stringify(second));
  } finally { rmTmp(stateDir); rmTmp(projDir); rmTmp(homeDir); }
});

test('applyRegistrationClaudeCode: missing project root → ok=false (validated path)', () => {
  const stateDir = tmpDir();
  const homeDir = tmpDir();
  try {
    const out = cdc.applyRegistrationClaudeCode({
      stateDir,
      claudeJsonPath: path.join(homeDir, '.claude.json'),
      projectRoot: '/path/does/not/exist/abc-' + Date.now(),
      merlinEntry,
    });
    assert.strictEqual(out.ok, false);
    assert.ok(/does not exist/i.test(out.error));
  } finally { rmTmp(stateDir); rmTmp(homeDir); }
});

// ── Claude Code: status / detection ──────────────────────────

test('isRegisteredClaudeCode: only true when BOTH files match', () => {
  const stateDir = tmpDir();
  const projDir = tmpDir();
  const homeDir = tmpDir();
  const claudeJsonPath = path.join(homeDir, '.claude.json');
  try {
    // Initially: nothing.
    assert.strictEqual(cdc.isRegisteredClaudeCode({
      projectRoot: projDir, projectKey: projDir, claudeJsonPath, merlinEntry,
    }), false);

    // Only .mcp.json written → still false.
    fs.writeFileSync(path.join(projDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { merlin: merlinEntry } }));
    assert.strictEqual(cdc.isRegisteredClaudeCode({
      projectRoot: projDir, projectKey: projDir, claudeJsonPath, merlinEntry,
    }), false);

    // Only ~/.claude.json written → still false.
    fs.unlinkSync(path.join(projDir, '.mcp.json'));
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      projects: { [projDir]: { enabledMcpjsonServers: ['merlin'] } },
    }));
    assert.strictEqual(cdc.isRegisteredClaudeCode({
      projectRoot: projDir, projectKey: projDir, claudeJsonPath, merlinEntry,
    }), false);

    // Both written, matching merlin entry → TRUE.
    fs.writeFileSync(path.join(projDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { merlin: merlinEntry } }));
    assert.strictEqual(cdc.isRegisteredClaudeCode({
      projectRoot: projDir, projectKey: projDir, claudeJsonPath, merlinEntry,
    }), true);

    // .mcp.json has the wrong shim path → false (overwrite wanted).
    fs.writeFileSync(path.join(projDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { merlin: { command: 'old', args: ['old.js'] } } }));
    assert.strictEqual(cdc.isRegisteredClaudeCode({
      projectRoot: projDir, projectKey: projDir, claudeJsonPath, merlinEntry,
    }), false);
  } finally { rmTmp(stateDir); rmTmp(projDir); rmTmp(homeDir); }
});

test('listClaudeCodeProjectsStatus: enumerates remembered + live state', () => {
  const stateDir = tmpDir();
  const projA = tmpDir();
  const projB = tmpDir();
  const homeDir = tmpDir();
  const claudeJsonPath = path.join(homeDir, '.claude.json');
  try {
    cdc.rememberClaudeCodeProject(stateDir, projA);
    cdc.rememberClaudeCodeProject(stateDir, projB);

    // projA fully wired.
    fs.writeFileSync(path.join(projA, '.mcp.json'),
      JSON.stringify({ mcpServers: { merlin: merlinEntry } }));
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      projects: { [projA]: { enabledMcpjsonServers: ['merlin'] } },
    }));

    const status = cdc.listClaudeCodeProjectsStatus({ stateDir, claudeJsonPath, merlinEntry });
    assert.strictEqual(status.length, 2);
    const a = status.find((s) => s.path === projA);
    const b = status.find((s) => s.path === projB);
    assert.ok(a && a.enabled === true, 'projA should be enabled');
    assert.ok(b && b.enabled === false, 'projB should NOT be enabled');
  } finally { rmTmp(stateDir); rmTmp(projA); rmTmp(projB); rmTmp(homeDir); }
});

test('rememberClaudeCodeProject: dedups + atomic', () => {
  const stateDir = tmpDir();
  try {
    assert.strictEqual(cdc.rememberClaudeCodeProject(stateDir, '/a'), true);
    assert.strictEqual(cdc.rememberClaudeCodeProject(stateDir, '/b'), true);
    assert.strictEqual(cdc.rememberClaudeCodeProject(stateDir, '/a'), true); // dup
    const list = cdc.readClaudeCodeProjects(stateDir);
    assert.deepStrictEqual(list, ['/a', '/b']); // sorted, deduped
    // No tmp leftover.
    const leftovers = fs.readdirSync(stateDir).filter((n) => n.endsWith('.tmp'));
    assert.strictEqual(leftovers.length, 0);
  } finally { rmTmp(stateDir); }
});

test('detectInstalledClients: returns shape {desktop, code}', () => {
  const out = cdc.detectInstalledClients();
  assert.strictEqual(typeof out, 'object');
  assert.strictEqual(typeof out.desktop, 'boolean');
  assert.strictEqual(typeof out.code, 'boolean');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
