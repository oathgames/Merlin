// Regression guards for the stale plaintext brand-config incident
// (2026-07-13). The workspace split migration (migrateTreeToSplit) moved
// .merlin-config-<brand>.json files flat into StateDir, but the config I/O
// layer only ever reads <ContentDir>/.claude/tools, so pre-vault brand
// configs sat in %APPDATA%\Merlin with PLAINTEXT Meta access tokens for
// months (acme-labs + bright-co, discovered 2026-07-13). migrateTokensToVault
// could never catch them: tools-dir-only scan, one-shot _migrationVersion
// gate already set.
//
// Behavioral tests exercise app/brand-config-sweep.js against real temp
// dirs with an injected in-memory vault. Source-scan tests lock down the
// main.js wiring (boot-chain call, no one-shot gate, dep injection).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sweepStaleBrandConfigs, parseBrandConfigName } = require('./brand-config-sweep');
const { isSensitiveConfigKey, isVaultRedactionMarker } = require('./oauth-persist');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const SWEEP_JS = fs.readFileSync(path.join(__dirname, 'brand-config-sweep.js'), 'utf8');

// ── Harness ─────────────────────────────────────────────────────

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-sweep-'));
  const toolsDir = path.join(root, 'content', '.claude', 'tools');
  const strayDir = path.join(root, 'state');
  const brandsDir = path.join(root, 'content', 'assets', 'brands');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.mkdirSync(strayDir, { recursive: true });
  fs.mkdirSync(brandsDir, { recursive: true });
  return { root, toolsDir, strayDir, brandsDir };
}

function makeVault(initial) {
  const store = new Map(Object.entries(initial || {}));
  const puts = [];
  return {
    store,
    puts,
    vaultGet: (brand, key) => store.get(brand + '/' + key) || null,
    vaultPut: (brand, key, value) => { puts.push({ brand, key }); store.set(brand + '/' + key, value); },
  };
}

function runSweep(fx, vault, opts) {
  const logs = [];
  const result = sweepStaleBrandConfigs({
    toolsDir: fx.toolsDir,
    strayDirs: (opts && opts.strayDirs) || [fx.strayDir],
    brandsDir: fx.brandsDir,
    isSensitiveKey: isSensitiveConfigKey,
    isRedactionMarker: isVaultRedactionMarker,
    vaultGet: vault.vaultGet,
    vaultPut: vault.vaultPut,
    log: (line) => logs.push(line),
  });
  return { result, logs };
}

function writeStray(fx, brand, cfg) {
  const p = path.join(fx.strayDir, `.merlin-config-${brand}.json`);
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

function addLiveBrand(fx, brand) {
  fs.mkdirSync(path.join(fx.brandsDir, brand), { recursive: true });
}

const FAKE_META_TOKEN = 'EAAfaketesttoken1234567890abcdefFAKE';
const FAKE_FAL_KEY = '00000000-1111-2222-3333-444444444444:deadbeef';

// ── Behavioral: live brand, vault then delete ──────────────────

test('live brand stray: plaintext secrets vaulted, file deleted', () => {
  const fx = makeFixture();
  addLiveBrand(fx, 'acme-labs');
  const p = writeStray(fx, 'acme-labs', {
    metaAccessToken: FAKE_META_TOKEN,
    falApiKey: FAKE_FAL_KEY,
    metaAdAccountId: 'act_123456789',
    metaPageId: '987654321',
  });
  const vault = makeVault();
  const { result, logs } = runSweep(fx, vault);

  assert.equal(fs.existsSync(p), false, 'stray file must be deleted');
  assert.equal(vault.vaultGet('acme-labs', 'metaAccessToken'), FAKE_META_TOKEN);
  assert.equal(vault.vaultGet('acme-labs', 'falApiKey'), FAKE_FAL_KEY);
  assert.deepEqual(result.deleted, ['.merlin-config-acme-labs.json']);
  assert.equal(result.preservedKeys, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'vaulted-and-deleted');
  assert.deepEqual(logs[0].preserved.sort(), ['falApiKey', 'metaAccessToken']);
});

test('non-sensitive keys (account/page/pixel ids, budgets) are never vaulted', () => {
  const fx = makeFixture();
  addLiveBrand(fx, 'bright-co');
  writeStray(fx, 'bright-co', {
    dailyAdBudget: 25,
    metaAdAccountId: 'act_123456789',
    metaPageId: '111',
    metaPixelId: '222',
  });
  const vault = makeVault();
  const { result } = runSweep(fx, vault);

  assert.equal(vault.puts.length, 0, 'no vault writes for non-sensitive keys');
  assert.equal(result.deleted.length, 1, 'file still deleted (nothing to preserve)');
});

test('live brand stray: existing vault entry is NEVER clobbered by a stale value', () => {
  const fx = makeFixture();
  addLiveBrand(fx, 'acme-labs');
  writeStray(fx, 'acme-labs', { metaAccessToken: 'EAAstaleAprilTokenFAKE000000' });
  const vault = makeVault({ 'acme-labs/metaAccessToken': 'EAAfreshCurrentTokenFAKE111111' });
  const { result, logs } = runSweep(fx, vault);

  assert.equal(vault.vaultGet('acme-labs', 'metaAccessToken'), 'EAAfreshCurrentTokenFAKE111111',
    'fresher live vault entry must survive');
  assert.equal(vault.puts.length, 0, 'no vaultPut when the slot is occupied');
  assert.equal(result.deleted.length, 1, 'superseded stray still deleted');
  assert.deepEqual(logs[0].superseded, ['metaAccessToken']);
});

// ── Behavioral: retired brand, delete without vaulting ─────────

test('retired brand stray: deleted, nothing vaulted', () => {
  const fx = makeFixture();
  const p = writeStray(fx, 'dead-brand', { metaAccessToken: FAKE_META_TOKEN });
  const vault = makeVault();
  const { result, logs } = runSweep(fx, vault);

  assert.equal(fs.existsSync(p), false);
  assert.equal(vault.puts.length, 0, 'retired brand credentials are not archived');
  assert.equal(logs[0].action, 'deleted-retired-brand');
  assert.equal(result.preservedKeys, 0);
});

test('the example scaffold brand is treated as retired', () => {
  const fx = makeFixture();
  addLiveBrand(fx, 'example');
  const p = writeStray(fx, 'example', { metaAccessToken: FAKE_META_TOKEN });
  const vault = makeVault();
  runSweep(fx, vault);
  assert.equal(fs.existsSync(p), false);
  assert.equal(vault.puts.length, 0);
});

// ── Behavioral: never delete before the vault write is confirmed ─

test('vault write failure keeps the file on disk for a next-boot retry', () => {
  const fx = makeFixture();
  addLiveBrand(fx, 'acme-labs');
  const p = writeStray(fx, 'acme-labs', { metaAccessToken: FAKE_META_TOKEN });
  const logs = [];
  const result = sweepStaleBrandConfigs({
    toolsDir: fx.toolsDir,
    strayDirs: [fx.strayDir],
    brandsDir: fx.brandsDir,
    isSensitiveKey: isSensitiveConfigKey,
    isRedactionMarker: isVaultRedactionMarker,
    vaultGet: () => null,       // readback never confirms
    vaultPut: () => {},         // put silently fails (mirrors main.js catch-all)
    log: (line) => logs.push(line),
  });

  assert.equal(fs.existsSync(p), true, 'file must survive an unconfirmed vault write');
  assert.equal(result.deleted.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /vault write unconfirmed/);
  assert.equal(logs[0].action, 'kept-vault-write-failed');
});

// ── Behavioral: what the sweep must leave alone ─────────────────

test('canonical tools dir is never touched, even when listed as a stray dir', () => {
  const fx = makeFixture();
  addLiveBrand(fx, 'boltco');
  const p = path.join(fx.toolsDir, '.merlin-config-boltco.json');
  fs.writeFileSync(p, JSON.stringify({ metaAccessToken: FAKE_META_TOKEN }));
  const vault = makeVault();
  // Deliberately pass toolsDir (and a case-mangled variant) as stray dirs.
  const variant = process.platform === 'win32' ? fx.toolsDir.toUpperCase() : fx.toolsDir;
  const { result } = runSweep(fx, vault, { strayDirs: [fx.toolsDir, variant] });

  assert.equal(fs.existsSync(p), true, 'live config home must never be swept');
  assert.equal(result.deleted.length, 0);
  assert.equal(vault.puts.length, 0);
});

test('tmp atomic-write siblings and non-matching files are skipped', () => {
  const fx = makeFixture();
  const tmp = path.join(fx.strayDir, '.merlin-config-tmp-abc123.json');
  const global = path.join(fx.strayDir, 'merlin-config.json');
  const other = path.join(fx.strayDir, '.merlin-tokens-boltco');
  fs.writeFileSync(tmp, '{}');
  fs.writeFileSync(global, JSON.stringify({ metaAccessToken: FAKE_META_TOKEN }));
  fs.writeFileSync(other, 'x');
  const vault = makeVault();
  const { result } = runSweep(fx, vault);

  assert.equal(fs.existsSync(tmp), true, 'tmp siblings belong to _maybeSweepConfigTmp');
  assert.equal(fs.existsSync(global), true, 'the GLOBAL config is out of scope');
  assert.equal(fs.existsSync(other), true);
  assert.equal(result.deleted.length, 0);
  assert.equal(parseBrandConfigName('.merlin-config-tmp-abc123.json'), null);
  assert.equal(parseBrandConfigName('merlin-config.json'), null);
  assert.equal(parseBrandConfigName('.merlin-config-acme-labs.json'), 'acme-labs');
});

test('vault placeholders and redaction markers are not treated as plaintext', () => {
  const fx = makeFixture();
  addLiveBrand(fx, 'boltco');
  writeStray(fx, 'boltco', {
    metaAccessToken: '@@VAULT:metaAccessToken@@',
    klaviyoApiKey: '[stored securely]',
  });
  const vault = makeVault();
  const { result } = runSweep(fx, vault);

  assert.equal(vault.puts.length, 0, 'placeholders/markers must not be vaulted');
  assert.equal(result.deleted.length, 1, 'already-vaulted stray is still dead weight, deleted');
});

test('unparseable stray is left in place and logged', () => {
  const fx = makeFixture();
  const p = path.join(fx.strayDir, '.merlin-config-broken.json');
  fs.writeFileSync(p, '{not json');
  const vault = makeVault();
  const { result, logs } = runSweep(fx, vault);

  assert.equal(fs.existsSync(p), true, 'never destroy what we cannot inspect');
  assert.equal(result.errors.length, 1);
  assert.equal(logs[0].action, 'skipped-unparseable');
});

test('missing stray dir and empty stray list are safe no-ops', () => {
  const fx = makeFixture();
  const vault = makeVault();
  const a = runSweep(fx, vault, { strayDirs: [path.join(fx.root, 'no-such-dir')] });
  assert.equal(a.result.deleted.length, 0);
  assert.equal(a.result.errors.length, 0);
  const b = sweepStaleBrandConfigs({
    toolsDir: fx.toolsDir, strayDirs: [], brandsDir: fx.brandsDir,
    isSensitiveKey: isSensitiveConfigKey, isRedactionMarker: isVaultRedactionMarker,
    vaultGet: () => null, vaultPut: () => {}, log: () => {},
  });
  assert.equal(b.deleted.length, 0);
});

test('sweep is idempotent: second run is a zero-action no-op', () => {
  const fx = makeFixture();
  addLiveBrand(fx, 'acme-labs');
  writeStray(fx, 'acme-labs', { metaAccessToken: FAKE_META_TOKEN });
  const vault = makeVault();
  runSweep(fx, vault);
  const second = runSweep(fx, vault);

  assert.equal(second.result.deleted.length, 0);
  assert.equal(second.result.errors.length, 0);
  assert.equal(second.logs.length, 0);
});

test('log lines carry key names only, never secret values', () => {
  const fx = makeFixture();
  addLiveBrand(fx, 'acme-labs');
  writeStray(fx, 'acme-labs', { metaAccessToken: FAKE_META_TOKEN, falApiKey: FAKE_FAL_KEY });
  const vault = makeVault();
  const { logs } = runSweep(fx, vault);

  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes(FAKE_META_TOKEN), 'activity.jsonl is plaintext, no token values in logs');
  assert.ok(!serialized.includes(FAKE_FAL_KEY));
});

// ── Source-scan: main.js wiring ─────────────────────────────────

function extractFunction(name, src) {
  const start = src.indexOf('function ' + name);
  if (start < 0) return '';
  const open = src.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

test('main.js requires brand-config-sweep and calls it in the boot migration chain', () => {
  assert.ok(/require\(['"]\.\/brand-config-sweep['"]\)/.test(MAIN_JS),
    'main.js must require ./brand-config-sweep');
  const bootIdx = MAIN_JS.indexOf('try { migrateStrayBrandFiles(); }');
  assert.ok(bootIdx > 0, 'boot migration chain must exist');
  const after = MAIN_JS.slice(bootIdx, bootIdx + 800);
  assert.ok(/sweepStaleBrandConfigsOnBoot\(\)/.test(after),
    'sweepStaleBrandConfigsOnBoot() must run in the deferred boot chain after the other migrations');
});

test('boot sweep has NO one-shot version/flag gate (the gate was the original bug)', () => {
  const body = extractFunction('sweepStaleBrandConfigsOnBoot', MAIN_JS);
  assert.ok(body, 'sweepStaleBrandConfigsOnBoot must exist in main.js');
  assert.ok(!/_migrationVersion/.test(body),
    'sweep must not consult _migrationVersion, it runs every boot');
  assert.ok(!/Migrated|_sweepDone|localStorage/i.test(body),
    'sweep must not be gated behind a one-shot config flag');
});

test('boot sweep injects the real vault primitives and both stray dir candidates', () => {
  const body = extractFunction('sweepStaleBrandConfigsOnBoot', MAIN_JS);
  assert.ok(/strayDirs:\s*\[stateDir,\s*defaultStateDir\(\)\]/.test(body),
    'sweep must scan both the resolved StateDir and the OS default state dir');
  assert.ok(/vaultGet,\s*\n?\s*vaultPut/.test(body.replace(/\r/g, '')),
    'sweep must use the shared vaultGet/vaultPut primitives (namespace parity with the OAuth flow)');
  assert.ok(/isSensitiveKey:\s*isSensitiveConfigKey/.test(body),
    'sweep must classify secrets via oauth-persist.isSensitiveConfigKey, no parallel key list');
});

test('sweep module keeps its dated REGRESSION GUARD block', () => {
  assert.ok(/REGRESSION GUARD \(2026-07-13, plaintext brand configs stranded in StateDir\)/.test(SWEEP_JS),
    'brand-config-sweep.js must keep the dated regression-guard comment');
  assert.ok(/Never delete before the vault write is CONFIRMED/.test(SWEEP_JS),
    'rule 4 (confirm-before-delete) prose must stay');
});
