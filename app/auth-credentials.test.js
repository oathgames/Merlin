// Behavioral tests for app/auth-credentials.js.
//
// Covers the three decision branches that drive Merlin's silent OAuth
// refresh post-2026-04-27:
//
//   A. extractToken(raw): parses the credentials JSON and surfaces
//      {token, raw, expiresAt, refreshable} — must NOT auto-reject
//      tokens past expiry as long as a refreshToken is present, because
//      the SDK refreshes silently from the file using that token.
//
//   B. readFileCredentialsForSession(): returns a session-mode descriptor
//      ONLY when the file has refresh capability. When refresh is
//      unavailable (no refreshToken, malformed file, missing file) it
//      returns null so startSession() falls through to the legacy env-
//      injection path. Crucially: returning a value here means
//      startSession MUST NOT inject CLAUDE_CODE_OAUTH_TOKEN env, because
//      the SDK's env path explicitly returns refreshToken=null and
//      defeats refresh.
//
// Run: node app/auth-credentials.test.js

const assert = require('assert');
const { extractToken, readFileCredentialsForSession } = require('./auth-credentials');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.log('  ✗', name);
    console.log('   ', err && err.stack ? err.stack.split('\n')[0] : err);
    failed++;
  }
}

// ─── extractToken ──────────────────────────────────────────────────────────

test('extractToken returns null on null/undefined/empty input', () => {
  assert.strictEqual(extractToken(null), null);
  assert.strictEqual(extractToken(undefined), null);
  assert.strictEqual(extractToken(''), null);
});

test('extractToken returns null on non-string input', () => {
  assert.strictEqual(extractToken(42), null);
  assert.strictEqual(extractToken({}), null);
  assert.strictEqual(extractToken([]), null);
});

test('extractToken returns null on malformed JSON', () => {
  assert.strictEqual(extractToken('{not json'), null);
  assert.strictEqual(extractToken('"bare-string"'), null);
});

test('extractToken returns null when accessToken is missing', () => {
  assert.strictEqual(extractToken(JSON.stringify({})), null);
  assert.strictEqual(extractToken(JSON.stringify({ claudeAiOauth: {} })), null);
  assert.strictEqual(extractToken(JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } })), null);
});

// NOTE: test fixtures intentionally use FAKE_* placeholders rather than
// the real Anthropic prefixes (sk-ant-oat01-, sk-ant-ort01-). Even though
// these strings have no entropy and are obviously test values, secret-
// scanners (GitGuardian, TruffleHog) flag any sk-ant- prefix as a
// generic high-entropy secret on PR submission. Using FAKE_ here keeps
// the tests semantically equivalent while staying scanner-clean.
test('extractToken parses the canonical {claudeAiOauth: {...}} format', () => {
  const raw = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'FAKE_ACCESS_TOKEN_canonical',
      refreshToken: 'FAKE_REFRESH_TOKEN_canonical',
      expiresAt: 1777324912941,
      scopes: ['user:inference'],
    },
  });
  const out = extractToken(raw);
  assert.ok(out, 'should return a result object');
  assert.strictEqual(out.token, 'FAKE_ACCESS_TOKEN_canonical');
  assert.strictEqual(out.raw, raw);
  assert.strictEqual(out.expiresAt, 1777324912941);
  assert.strictEqual(out.refreshable, true);
});

test('extractToken parses the flat {accessToken: ...} fallback format', () => {
  const raw = JSON.stringify({
    accessToken: 'FAKE_ACCESS_TOKEN_flat',
    refreshToken: 'FAKE_REFRESH_TOKEN_flat',
    expiresAt: 9000000000000,
  });
  const out = extractToken(raw);
  assert.strictEqual(out.token, 'FAKE_ACCESS_TOKEN_flat');
  assert.strictEqual(out.refreshable, true);
});

test('extractToken handles ISO-string expiresAt by converting to ms', () => {
  const raw = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'tok',
      expiresAt: '2030-01-02T03:04:05Z',
    },
  });
  const out = extractToken(raw);
  assert.strictEqual(typeof out.expiresAt, 'number');
  assert.strictEqual(out.expiresAt, new Date('2030-01-02T03:04:05Z').getTime());
});

test('extractToken returns null expiresAt when field is missing', () => {
  const raw = JSON.stringify({
    claudeAiOauth: { accessToken: 'tok', refreshToken: 'r' },
  });
  const out = extractToken(raw);
  assert.strictEqual(out.expiresAt, null);
});

test('extractToken treats unparseable expiresAt as null (does not throw)', () => {
  const raw = JSON.stringify({
    claudeAiOauth: { accessToken: 'tok', expiresAt: 'not a date' },
  });
  const out = extractToken(raw);
  assert.strictEqual(out.expiresAt, null);
});

test('extractToken marks refreshable=false when refreshToken is empty/missing', () => {
  const noRefresh = extractToken(JSON.stringify({
    claudeAiOauth: { accessToken: 'tok' },
  }));
  assert.strictEqual(noRefresh.refreshable, false);

  const emptyRefresh = extractToken(JSON.stringify({
    claudeAiOauth: { accessToken: 'tok', refreshToken: '' },
  }));
  assert.strictEqual(emptyRefresh.refreshable, false);
});

// REGRESSION GUARD: this is the load-bearing test for the silent-refresh fix.
// If extractToken ever re-introduces expiry rejection, paying users get
// forced into a browser sign-in on every token TTL boundary even though the
// SDK could have refreshed for them.
test('extractToken does NOT reject expired tokens (caller decides)', () => {
  const raw = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'tok',
      refreshToken: 'r',
      expiresAt: Date.now() - 24 * 60 * 60 * 1000, // 24h ago
    },
  });
  const out = extractToken(raw);
  assert.ok(out, 'expired token must still parse — SDK refreshes from file');
  assert.strictEqual(out.token, 'tok');
  assert.strictEqual(out.refreshable, true);
  assert.ok(out.expiresAt < Date.now(), 'expiresAt should reflect the past timestamp');
});

// ─── readFileCredentialsForSession ─────────────────────────────────────────

function fakeFs(files) {
  return {
    readFileSync: (p, enc) => {
      if (Object.prototype.hasOwnProperty.call(files, p)) {
        if (files[p] === '__ENOENT__') {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return files[p];
      }
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  };
}

const path = require('path');
const HOME = '/tmp/auth-creds-test-home';
const CANONICAL = path.join(HOME, '.claude', '.credentials.json');
const NODOT = path.join(HOME, '.claude', 'credentials.json');

test('readFileCredentialsForSession returns null when no file exists', () => {
  const out = readFileCredentialsForSession({ fs: fakeFs({}), homeDir: HOME });
  assert.strictEqual(out, null);
});

test('readFileCredentialsForSession returns null on a malformed canonical file', () => {
  const out = readFileCredentialsForSession({
    fs: fakeFs({ [CANONICAL]: 'not json' }),
    homeDir: HOME,
  });
  assert.strictEqual(out, null);
});

test('readFileCredentialsForSession returns null when file has accessToken but NO refreshToken', () => {
  const raw = JSON.stringify({
    claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 60_000 },
  });
  const out = readFileCredentialsForSession({
    fs: fakeFs({ [CANONICAL]: raw }),
    homeDir: HOME,
  });
  // No refresh capability → null → caller falls through to env injection.
  assert.strictEqual(out, null);
});

test('readFileCredentialsForSession surfaces a fresh refreshable file', () => {
  const fresh = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'tok-fresh',
      refreshToken: 'r-fresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
  });
  const out = readFileCredentialsForSession({
    fs: fakeFs({ [CANONICAL]: fresh }),
    homeDir: HOME,
  });
  assert.ok(out, 'fresh refreshable file should produce a session descriptor');
  assert.strictEqual(out.source, 'file');
  assert.strictEqual(out.token, 'tok-fresh');
  assert.strictEqual(out.refreshable, true);
  assert.strictEqual(out.expired, false);
});

test('readFileCredentialsForSession marks expired=true on a stale-but-refreshable file', () => {
  const stale = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'tok-stale',
      refreshToken: 'r-stale',
      expiresAt: Date.now() - 24 * 60 * 60 * 1000,
    },
  });
  const out = readFileCredentialsForSession({
    fs: fakeFs({ [CANONICAL]: stale }),
    homeDir: HOME,
  });
  assert.ok(out, 'expired-but-refreshable file MUST still produce a descriptor');
  assert.strictEqual(out.expired, true);
  assert.strictEqual(out.refreshable, true);
  // The whole point — this is what disables env injection so the SDK can refresh.
});

test('readFileCredentialsForSession falls back to no-dot variant and persists to canonical', () => {
  const raw = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'tok-nodot',
      refreshToken: 'r-nodot',
      expiresAt: Date.now() + 60_000,
    },
  });
  const persisted = [];
  const out = readFileCredentialsForSession({
    fs: fakeFs({ [CANONICAL]: '__ENOENT__', [NODOT]: raw }),
    homeDir: HOME,
    persist: (r) => persisted.push(r),
  });
  assert.ok(out);
  assert.strictEqual(out.token, 'tok-nodot');
  assert.deepStrictEqual(persisted, [raw], 'no-dot variant must be normalized to canonical');
});

test('readFileCredentialsForSession does NOT call persist when canonical was used', () => {
  const raw = JSON.stringify({
    claudeAiOauth: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 60_000 },
  });
  const persisted = [];
  readFileCredentialsForSession({
    fs: fakeFs({ [CANONICAL]: raw }),
    homeDir: HOME,
    persist: (r) => persisted.push(r),
  });
  assert.strictEqual(persisted.length, 0, 'persist should not be called when canonical was the source');
});

test('readFileCredentialsForSession survives a throwing persist', () => {
  const raw = JSON.stringify({
    claudeAiOauth: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 60_000 },
  });
  const out = readFileCredentialsForSession({
    fs: fakeFs({ [CANONICAL]: '__ENOENT__', [NODOT]: raw }),
    homeDir: HOME,
    persist: () => { throw new Error('disk full'); },
  });
  assert.ok(out, 'a persist failure must not cascade — return the descriptor anyway');
  assert.strictEqual(out.token, 'tok');
});

// ─── done ──────────────────────────────────────────────────────────────────
console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
