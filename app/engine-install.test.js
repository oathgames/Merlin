// REGRESSION GUARD (2026-09-04, engine-update-fail-open + non-atomic-swap):
// Locks down the two defects described at the top of app/engine-install.js:
//   1. ensureBinary installed the engine unverified when a release published
//      no checksums.txt, or when the manifest had no line for this asset.
//   2. The install unlinked the incumbent binary BEFORE renaming the new one
//      into place, so a failed rename left the user with no engine at all.
//
// Every fs interaction here is against an in-memory mock so the assertions
// are about ORDER and RECOVERY, not about this machine's filesystem.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const realCrypto = require('node:crypto');

const {
  expectedHashFor,
  resolveExpectedHash,
  atomicReplaceBinary,
} = require('./engine-install.js');

const ASSET = 'Merlin-windows-amd64.exe';
const HASH_A = 'a'.repeat(64);
const bufFor = (s) => Buffer.from(s, 'utf8');
const sha = (b) => realCrypto.createHash('sha256').update(b).digest('hex');

// ── mock fs ────────────────────────────────────────────────────────────
// files: Map<path, Buffer>. `fail` lets a test make a single operation on a
// single path throw, which is how the "rename blew up" branch is exercised.
function makeFs(initial = {}, fail = {}) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  const calls = [];
  const boom = (op, p) => {
    if (fail[op] && fail[op] === p) {
      const e = new Error(`EPERM: operation not permitted, ${op} '${p}'`);
      e.code = 'EPERM';
      throw e;
    }
  };
  return {
    files,
    calls,
    existsSync(p) { calls.push(['existsSync', p]); return files.has(p); },
    writeFileSync(p, buf) { calls.push(['writeFileSync', p]); boom('write', p); files.set(p, Buffer.from(buf)); },
    readFileSync(p) {
      calls.push(['readFileSync', p]);
      if (!files.has(p)) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    unlinkSync(p) {
      calls.push(['unlinkSync', p]);
      if (!files.has(p)) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
      files.delete(p);
    },
    renameSync(from, to) {
      calls.push(['renameSync', from, to]);
      boom('rename', from);
      if (!files.has(from)) { const e = new Error(`ENOENT: ${from}`); e.code = 'ENOENT'; throw e; }
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

// ── expectedHashFor ────────────────────────────────────────────────────

test('expectedHashFor reads a sha256sum manifest, including the * binary-mode prefix', () => {
  const txt = `${HASH_A}  other-asset\n${'b'.repeat(64)} *${ASSET}\n`;
  assert.strictEqual(expectedHashFor(txt, ASSET), 'b'.repeat(64));
});

test('expectedHashFor rejects a non-64-hex hash rather than trusting it', () => {
  assert.strictEqual(expectedHashFor(`deadbeef  ${ASSET}\n`, ASSET), '');
});

test('expectedHashFor returns empty when the asset has no line', () => {
  assert.strictEqual(expectedHashFor(`${HASH_A}  something-else\n`, ASSET), '');
});

// ── resolveExpectedHash — FAIL CLOSED ──────────────────────────────────

test('FAIL CLOSED: a release with NO checksums.txt asset throws, never resolves', async () => {
  await assert.rejects(
    () => resolveExpectedHash({ checksumAsset: null, assetName: ASSET, httpsGet: async () => '' }),
    (e) => {
      assert.match(e.message, /integrity/i, 'message must contain "integrity" so humanizeUpdateError routes it');
      assert.match(e.message, /no checksums\.txt/i);
      return true;
    },
  );
});

test('FAIL CLOSED: a manifest that omits this asset throws and does NOT retry', async () => {
  let fetches = 0;
  await assert.rejects(
    () => resolveExpectedHash({
      checksumAsset: { browser_download_url: 'https://x/checksums.txt' },
      assetName: ASSET,
      httpsGet: async () => { fetches++; return `${HASH_A}  some-other-asset\n`; },
      sleep: async () => {},
    }),
    /integrity/i,
  );
  assert.strictEqual(fetches, 1, 'a published-but-silent manifest is a publishing bug, not a transient failure');
});

test('FAIL CLOSED: every checksum fetch failing throws after the retry budget', async () => {
  let fetches = 0;
  await assert.rejects(
    () => resolveExpectedHash({
      checksumAsset: { browser_download_url: 'https://x/checksums.txt' },
      assetName: ASSET,
      httpsGet: async () => { fetches++; throw new Error('ETIMEDOUT'); },
      sleep: async () => {},
    }),
    /integrity/i,
  );
  assert.strictEqual(fetches, 3);
});

test('resolveExpectedHash recovers on a retry and returns the digest', async () => {
  let fetches = 0;
  const hash = await resolveExpectedHash({
    checksumAsset: { browser_download_url: 'https://x/checksums.txt' },
    assetName: ASSET,
    httpsGet: async () => {
      fetches++;
      if (fetches === 1) throw new Error('ECONNRESET');
      return `${HASH_A}  ${ASSET}\n`;
    },
    sleep: async () => {},
  });
  assert.strictEqual(hash, HASH_A);
  assert.strictEqual(fetches, 2);
});

// ── atomicReplaceBinary ────────────────────────────────────────────────

test('happy path: stages .new, backs up to .bak, renames in, then drops .bak', () => {
  const target = path.join('C:', 'bin', 'Merlin.exe');
  const buf = bufFor('new-engine');
  const mock = makeFs({ [target]: 'old-engine' });

  const r = atomicReplaceBinary({ fs: mock, crypto: realCrypto, targetPath: target, buffer: buf, expectedHash: sha(buf) });

  assert.deepStrictEqual(r, { replaced: true, backedUp: true });
  assert.strictEqual(mock.files.get(target).toString(), 'new-engine');
  assert.ok(!mock.files.has(`${target}.new`), '.new must not linger');
  assert.ok(!mock.files.has(`${target}.bak`), '.bak must be dropped only after a successful rename');

  // ORDER: the incumbent is moved aside, never unlinked, before the swap.
  const renames = mock.calls.filter((c) => c[0] === 'renameSync');
  assert.deepStrictEqual(renames[0], ['renameSync', target, `${target}.bak`]);
  assert.deepStrictEqual(renames[1], ['renameSync', `${target}.new`, target]);
  assert.ok(
    !mock.calls.some((c) => c[0] === 'unlinkSync' && c[1] === target),
    'the running binary must NEVER be unlinked — that is the defect this replaces',
  );
});

test('a failed rename restores the .bak so the user is never left with no engine', () => {
  const target = path.join('C:', 'bin', 'Merlin.exe');
  const buf = bufFor('new-engine');
  // Make the SECOND rename (.new -> target) explode.
  const mock = makeFs({ [target]: 'old-engine' }, { rename: `${target}.new` });

  assert.throws(
    () => atomicReplaceBinary({ fs: mock, crypto: realCrypto, targetPath: target, buffer: buf, expectedHash: sha(buf) }),
    /install|unchanged/i,
  );
  assert.ok(mock.files.has(target), 'the engine must still exist after a failed update');
  assert.strictEqual(mock.files.get(target).toString(), 'old-engine', 'the ORIGINAL engine must be restored');
  assert.ok(!mock.files.has(`${target}.new`), 'the staged file must be cleaned up');
});

test('a locked incumbent aborts the update and leaves the engine untouched', () => {
  const target = path.join('C:', 'bin', 'Merlin.exe');
  const buf = bufFor('new-engine');
  const mock = makeFs({ [target]: 'old-engine' }, { rename: target });

  assert.throws(
    () => atomicReplaceBinary({ fs: mock, crypto: realCrypto, targetPath: target, buffer: buf, expectedHash: sha(buf) }),
    /unchanged/i,
  );
  assert.strictEqual(mock.files.get(target).toString(), 'old-engine');
  assert.ok(!mock.files.has(`${target}.new`));
});

test('a hash mismatch on the staged file aborts before the incumbent is touched', () => {
  const target = path.join('C:', 'bin', 'Merlin.exe');
  const mock = makeFs({ [target]: 'old-engine' });

  assert.throws(
    () => atomicReplaceBinary({
      fs: mock, crypto: realCrypto, targetPath: target, buffer: bufFor('tampered'), expectedHash: HASH_A,
    }),
    /checksum mismatch/i,
  );
  assert.strictEqual(mock.files.get(target).toString(), 'old-engine');
  assert.ok(!mock.files.has(`${target}.new`));
  assert.ok(!mock.calls.some((c) => c[0] === 'renameSync'), 'no rename may run once the hash fails');
});

test('a fresh install (no incumbent) installs without a .bak', () => {
  const target = path.join('C:', 'bin', 'Merlin.exe');
  const buf = bufFor('new-engine');
  const mock = makeFs({});
  const r = atomicReplaceBinary({ fs: mock, crypto: realCrypto, targetPath: target, buffer: buf, expectedHash: sha(buf) });
  assert.deepStrictEqual(r, { replaced: true, backedUp: false });
  assert.strictEqual(mock.files.get(target).toString(), 'new-engine');
});

test('atomicReplaceBinary refuses to run without a 64-hex expected digest', () => {
  const target = path.join('C:', 'bin', 'Merlin.exe');
  const mock = makeFs({ [target]: 'old-engine' });
  assert.throws(
    () => atomicReplaceBinary({ fs: mock, crypto: realCrypto, targetPath: target, buffer: bufFor('x'), expectedHash: '' }),
    /integrity/i,
  );
  assert.ok(!mock.calls.some((c) => c[0] === 'writeFileSync'), 'nothing may be staged without a digest');
});

// ── main.js call-site lockdown ─────────────────────────────────────────

test('SOURCE: ensureBinary has no `if (checksumAsset)` fail-open wrapper left', () => {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = src.indexOf('async function ensureBinary(');
  assert.ok(start > 0, 'ensureBinary not found in main.js');
  const raw = src.slice(start, src.indexOf('\nasync function ', start + 10));
  assert.ok(raw.length > 0 && raw.length < 20000, 'ensureBinary slice looks wrong');
  // Strip comment lines — the REGRESSION GUARD block quotes the old
  // fail-open expression verbatim and must not trip the scan.
  const body = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(
    !/if\s*\(\s*checksumAsset\s*\)/.test(body),
    'verification must be unconditional — `if (checksumAsset)` is the fail-open hole',
  );
  assert.ok(
    /engineInstall\.resolveExpectedHash\(/.test(body),
    'ensureBinary must resolve the expected hash through the fail-closed helper',
  );
  assert.ok(
    /engineInstall\.atomicReplaceBinary\(/.test(body),
    'ensureBinary must install through the atomic swap helper',
  );
  assert.ok(
    !/fs\.unlinkSync\(binaryPath\)/.test(body),
    'the running binary must never be unlinked ahead of a rename',
  );
});
