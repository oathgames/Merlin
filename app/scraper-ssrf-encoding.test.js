// REGRESSION GUARD (2026-07-04, SEC RSI — SSRF encoded-IP bypass)
//
// Live finding (adversarial pentest): brand-scraper.js's validateScrapeURL —
// the SSRF fence that runs before a hidden BrowserWindow loads an arbitrary
// customer-supplied URL — matched IPv4 literals with ONLY /\d+\.\d+\.\d+\.\d+/.
// A browser's network stack (inet_aton) also resolves the integer, octal, hex,
// and short forms, so every one of these reached a private/loopback address
// while sailing past the dotted-decimal-only check:
//   http://2130706433/      → 127.0.0.1   (decimal integer)
//   http://0x7f000001/      → 127.0.0.1   (hex)
//   http://0177.0.0.1/      → 127.0.0.1   (octal octet)
//   http://127.1/           → 127.0.0.1   (short form)
//   http://[::ffff:127.0.0.1]/            (IPv4-mapped IPv6)
// The fix canonicalizes the host through parseLooseIPv4 (+ IPv4-mapped IPv6
// handling) and runs the same private-range checks on the canonical octets.
// webSecurity:true + credentials:'omit' blunt the impact, but the validator's
// own "public IPs only" contract must actually hold. This locks it.
//
// Run with: node --test app/scraper-ssrf-encoding.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateScrapeURL } = require('./brand-scraper');

// Every encoding of a private / loopback / link-local / CGNAT address must be
// rejected. Grouped by the canonical address they decode to.
const MUST_BLOCK = [
  // 127.0.0.1 loopback, all encodings
  'http://2130706433/',
  'http://0x7f000001/',
  'http://0x7f.0.0.1/',
  'http://0177.0.0.1/',
  'http://127.1/',
  'http://127.0.1/',
  'http://[::ffff:127.0.0.1]/',
  'http://[::ffff:7f00:1]/',
  'http://[::1]/',
  'http://[::]/',        // IPv6 unspecified — resolves to loopback on many stacks
  'http://[::0]/',
  // 192.168.0.1 (decimal 3232235521)
  'http://3232235521/',
  'http://0xc0a80001/',
  // 169.254.169.254 AWS IMDS (decimal 2852039166)
  'http://2852039166/',
  'http://0xa9fea9fe/',
  // 10.0.0.1 short/hex
  'http://0x0a000001/',
  // CGNAT 100.64.0.1 (decimal 1681915905)
  'http://1681915905/',
  // IPv6 unique-local
  'http://[fd00::1]/',
];

// Legitimate public destinations — must NOT be false-positived.
const MUST_ALLOW = [
  'https://www.northwind.com/',
  'https://retailco.com/collections/all',
  'http://93.184.216.34/',      // example.com public IP (dotted decimal)
  'http://8.8.8.8/',            // public
  'http://1681915714/',         // 100.63.255.66 — public, just below CGNAT
  'https://shop.example.co.uk/products',
];

test('every encoded form of a private/loopback IP is blocked', () => {
  for (const url of MUST_BLOCK) {
    const r = validateScrapeURL(url);
    assert.equal(r.ok, false, `SSRF fence must reject ${url} (decodes to a private/loopback address)`);
    assert.match(r.error, /Refusing to scrape/, `rejection for ${url} should be a scrape-refusal message`);
  }
});

test('legitimate public URLs are still allowed (no false positives)', () => {
  for (const url of MUST_ALLOW) {
    const r = validateScrapeURL(url);
    assert.equal(r.ok, true, `public URL must be allowed: ${url} (got: ${r.error})`);
  }
});

test('the dotted-decimal-only regex is gone from the IPv4 branch', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'brand-scraper.js'), 'utf8');
  // The canonicalizing helper and the shared range checker must both exist.
  assert.match(src, /function parseLooseIPv4\(/, 'parseLooseIPv4 canonicalizer must exist');
  assert.match(src, /function ipv4PrivacyError\(/, 'shared ipv4PrivacyError checker must exist');
  // The old narrow match must no longer be the guard's sole IPv4 detector:
  // the numeric-host test now accepts hex (0x) and short forms.
  assert.match(src, /0x\[0-9a-f\]\+\|\[0-9\]\+/, 'validator must detect hex/integer numeric hosts');
});

test('malformed numeric hosts are rejected, not passed through', () => {
  // 999.1.1.1 is not a valid IPv4 in any base — must not silently allow.
  const r = validateScrapeURL('http://999.1.1.1/');
  assert.equal(r.ok, false, 'a malformed 4-part numeric host must be rejected');
});
