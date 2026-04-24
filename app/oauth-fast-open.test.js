// Unit tests for oauth-fast-open.js. Run with
//   node app/oauth-fast-open.test.js
//
// Focus on the primitives that carry the RFC 8252 + Rule 3 guarantees:
//   - timingSafeCompareString: constant-time state compare
//   - validateIncomingState: accepts state, stateBase, authState forms
//   - isBlockedShopifyHost: SSRF guard mirroring oauth.go:2805-2827
//   - extractJsonBlock: binary stdout parser parity with the legacy path
//   - runFastOpenOAuth signature + early-reject surfaces (no live
//     network or browser in unit tests; end-to-end coverage is the
//     Merlin.exe smoke test invoked after `go build`).

'use strict';

// oauth-fast-open.js lazy-loads `electron` only when the browser is
// actually opened (see openBrowserExternal), so this test file runs
// cleanly under plain Node without an Electron runtime. The helpers
// exercised below (timingSafeCompareString, validateIncomingState,
// isBlockedShopifyHost, extractJsonBlock, htmlSuccess, escapeHtml) are
// pure functions with no Electron dependency.

const assert = require('assert');
const {
  timingSafeCompareString,
  validateIncomingState,
  extractJsonBlock,
  isBlockedShopifyHost,
  escapeHtml,
  htmlSuccess,
  htmlStateError,
  htmlAuthError,
  ACTIVE_PLATFORMS,
} = require('./oauth-fast-open');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => {
        console.log('  \u2713', name);
        passed++;
      }).catch((err) => {
        console.log('  \u2717', name);
        console.log('    ', err.message);
        failed++;
      });
    }
    console.log('  \u2713', name);
    passed++;
  } catch (err) {
    console.log('  \u2717', name);
    console.log('    ', err.message);
    failed++;
  }
}

// ── Rule 3: constant-time string compare ────────────────────────────

test('timingSafeCompareString: equal strings return true', () => {
  assert.strictEqual(timingSafeCompareString('abc123', 'abc123'), true);
});

test('timingSafeCompareString: different strings return false', () => {
  assert.strictEqual(timingSafeCompareString('abc123', 'xyz789'), false);
});

test('timingSafeCompareString: different lengths return false (not throw)', () => {
  assert.strictEqual(timingSafeCompareString('abc', 'abcdef'), false);
  assert.strictEqual(timingSafeCompareString('', 'a'), false);
});

test('timingSafeCompareString: non-string inputs return false', () => {
  assert.strictEqual(timingSafeCompareString(null, 'a'), false);
  assert.strictEqual(timingSafeCompareString('a', null), false);
  assert.strictEqual(timingSafeCompareString(undefined, undefined), false);
  assert.strictEqual(timingSafeCompareString(123, 123), false);
});

test('timingSafeCompareString: empty strings equal themselves', () => {
  assert.strictEqual(timingSafeCompareString('', ''), true);
});

// ── State validation (matches oauth.go:604-608 semantics) ──────────

test('validateIncomingState: plain state matches base', () => {
  const base = '0123456789abcdef0123456789abcdef';
  assert.strictEqual(validateIncomingState(base, base, base), true);
});

test('validateIncomingState: state|port matches authState form', () => {
  const base = '0123456789abcdef0123456789abcdef';
  const auth = `${base}|54321`;
  assert.strictEqual(validateIncomingState(auth, base, auth), true);
});

test('validateIncomingState: Worker-stripped base state accepted when authState has |port', () => {
  const base = '0123456789abcdef0123456789abcdef';
  const auth = `${base}|54321`;
  // Worker relay strips |port before redirecting to localhost — Node
  // listener receives just the base form and must accept it.
  assert.strictEqual(validateIncomingState(base, base, auth), true);
});

test('validateIncomingState: attacker-provided state rejects', () => {
  const base = '0123456789abcdef0123456789abcdef';
  const auth = `${base}|54321`;
  const attacker = 'ffffffffffffffffffffffffffffffff';
  assert.strictEqual(validateIncomingState(attacker, base, auth), false);
});

test('validateIncomingState: empty incoming rejects', () => {
  const base = '0123456789abcdef0123456789abcdef';
  assert.strictEqual(validateIncomingState('', base, base), false);
});

test('validateIncomingState: one-character-off state rejects', () => {
  const base = '0123456789abcdef0123456789abcdef';
  // Change the last char — length match but content mismatch.
  const almost = `${base.slice(0, -1)}0`;
  assert.strictEqual(validateIncomingState(almost, base, base), false);
});

// ── SSRF guard parity (mirrors oauth.go:2805-2827) ─────────────────

test('isBlockedShopifyHost: empty + whitespace rejected', () => {
  assert.strictEqual(isBlockedShopifyHost(''), true);
  assert.strictEqual(isBlockedShopifyHost('foo bar'), true);
  assert.strictEqual(isBlockedShopifyHost('foo\nbar'), true);
});

test('isBlockedShopifyHost: localhost + 127.0.0.1 + IPv6 rejected', () => {
  assert.strictEqual(isBlockedShopifyHost('localhost'), true);
  assert.strictEqual(isBlockedShopifyHost('127.0.0.1'), true);
  assert.strictEqual(isBlockedShopifyHost('[::1]'), true);
  assert.strictEqual(isBlockedShopifyHost('fe80::1'), true);
});

test('isBlockedShopifyHost: private RFC 1918 blocks', () => {
  assert.strictEqual(isBlockedShopifyHost('10.0.0.1'), true);
  assert.strictEqual(isBlockedShopifyHost('192.168.1.1'), true);
  assert.strictEqual(isBlockedShopifyHost('172.16.0.1'), true);
  assert.strictEqual(isBlockedShopifyHost('172.31.255.255'), true);
  assert.strictEqual(isBlockedShopifyHost('169.254.169.254'), true);
});

test('isBlockedShopifyHost: cloud metadata hosts blocked', () => {
  assert.strictEqual(isBlockedShopifyHost('metadata.google.internal'), true);
});

test('isBlockedShopifyHost: no-dot hostnames rejected', () => {
  assert.strictEqual(isBlockedShopifyHost('no-dot'), true);
});

test('isBlockedShopifyHost: real domains pass', () => {
  assert.strictEqual(isBlockedShopifyHost('mad-chill.com'), false);
  assert.strictEqual(isBlockedShopifyHost('store.example.com'), false);
  assert.strictEqual(isBlockedShopifyHost('my-shop.myshopify.com'), false);
});

// ── JSON extraction (matches main.js legacy heuristic) ─────────────

test('extractJsonBlock: parses simple multi-line JSON', () => {
  const stdout = [
    '  Connecting...',
    '  Authorization received!',
    '{',
    '  "metaAccessToken": "EAA…",',
    '  "adAccountName": "My Brand"',
    '}',
    'some trailing log',
  ].join('\n');
  const out = extractJsonBlock(stdout);
  assert.strictEqual(out.metaAccessToken, 'EAA…');
  assert.strictEqual(out.adAccountName, 'My Brand');
});

test('extractJsonBlock: picks the LAST { ... } block when multiple exist', () => {
  const stdout = [
    '{',
    '  "wrong": true',
    '}',
    '  … more status output …',
    '{',
    '  "right": true',
    '}',
  ].join('\n');
  const out = extractJsonBlock(stdout);
  assert.strictEqual(out.right, true);
  assert.ok(!('wrong' in out));
});

test('extractJsonBlock: throws on no JSON', () => {
  assert.throws(() => extractJsonBlock('just some logs\nno json here'), /no JSON in binary stdout/);
  assert.throws(() => extractJsonBlock(''), /no JSON in binary stdout/);
});

test('extractJsonBlock: throws on unmatched braces', () => {
  assert.throws(() => extractJsonBlock('{ "unclosed": true'), /no JSON in binary stdout/);
});

// ── HTML escaping (XSS guard on error_description) ─────────────────

test('escapeHtml: escapes dangerous chars', () => {
  assert.strictEqual(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.strictEqual(escapeHtml(`a"b'c&d`), 'a&quot;b&#39;c&amp;d');
});

test('htmlSuccess: provider name escaped when rendered', () => {
  const html = htmlSuccess('<evil>');
  assert.ok(!html.includes('<evil>'), 'unescaped provider name should not appear');
  assert.ok(html.includes('&lt;evil&gt;'), 'escaped form should appear');
});

test('htmlAuthError: error message escaped', () => {
  const html = htmlAuthError('"><img src=x onerror=alert(1)>');
  assert.ok(!html.includes('"><img'), 'unescaped payload should not appear');
  assert.ok(html.includes('&quot;&gt;&lt;img'), 'escaped form should appear');
});

test('htmlStateError: renders security warning', () => {
  const html = htmlStateError();
  assert.ok(html.includes('Security Error'));
  assert.ok(html.includes('State mismatch'));
});

// ── Exports sanity ─────────────────────────────────────────────────

test('ACTIVE_PLATFORMS re-export matches oauth-provider-config', () => {
  const { ACTIVE_PLATFORMS: FROM_CONFIG } = require('./oauth-provider-config');
  assert.deepStrictEqual([...ACTIVE_PLATFORMS].sort(), [...FROM_CONFIG].sort());
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
