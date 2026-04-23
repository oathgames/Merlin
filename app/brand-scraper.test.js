// Tests for brand-scraper.js pure helpers.
//
// The full scrape flow runs inside an Electron BrowserWindow and can't be
// unit tested in plain node, but the SSRF guard and the parsing helpers
// (palette / fonts / logo / meta-theme) are pure and must be verified
// exhaustively — every one of them sits on a path that could leak
// internal network access or mis-ingest a customer's brand identity.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  validateScrapeURL,
  parseColor,
  extractPaletteFromHtml,
  extractMetaThemeColor,
  extractFontFamilies,
  resolveLogoUrl,
  normalizeUrl,
  raceWithTimeout,
  executeJsWithTimeout,
  ScrapeTimeoutError,
  isUsefulPartial,
  settleOverallRace,
  clonePartial,
  SCRAPE_STAGES,
  DEFAULT_OVERALL_TIMEOUT_MS,
  DEFAULT_EXECUTE_JS_TIMEOUT_MS,
  DEFAULT_LOGO_FETCH_TIMEOUT_MS,
} = require('./brand-scraper');

const FIXTURE_DIR = path.join(__dirname, 'testdata', 'brand');
const realisticHtml = fs.readFileSync(path.join(FIXTURE_DIR, 'realistic.html'), 'utf8');
const minimalHtml   = fs.readFileSync(path.join(FIXTURE_DIR, 'minimal-fallback.html'), 'utf8');

// ─────────────────────────────────────────────────────────────────────
// validateScrapeURL — SSRF fence tests (one per blocked pattern).
// ─────────────────────────────────────────────────────────────────────

test('SSRF guard rejects file:// URLs', () => {
  const r = validateScrapeURL('file:///etc/passwd');
  assert.equal(r.ok, false);
  assert.match(r.error, /http\(s\)/);
});

test('SSRF guard rejects data: URLs', () => {
  const r = validateScrapeURL('data:text/html,<script>alert(1)</script>');
  assert.equal(r.ok, false);
  assert.match(r.error, /http\(s\)/);
});

test('SSRF guard rejects ftp:// URLs', () => {
  const r = validateScrapeURL('ftp://example.com/');
  assert.equal(r.ok, false);
});

test('SSRF guard rejects localhost hostname', () => {
  const r = validateScrapeURL('http://localhost:8080/admin');
  assert.equal(r.ok, false);
  assert.match(r.error, /localhost/);
});

test('SSRF guard rejects IPv4 loopback 127.0.0.1', () => {
  const r = validateScrapeURL('http://127.0.0.1/');
  assert.equal(r.ok, false);
  assert.match(r.error, /loopback/);
});

test('SSRF guard rejects anywhere in 127.0.0.0/8', () => {
  const r = validateScrapeURL('http://127.1.2.3/');
  assert.equal(r.ok, false);
  assert.match(r.error, /loopback/);
});

test('SSRF guard rejects RFC1918 10.0.0.0/8', () => {
  const r = validateScrapeURL('http://10.0.0.5/');
  assert.equal(r.ok, false);
  assert.match(r.error, /private/);
});

test('SSRF guard rejects RFC1918 172.16.0.0/12', () => {
  const a = validateScrapeURL('http://172.16.0.1/');
  assert.equal(a.ok, false);
  const b = validateScrapeURL('http://172.31.255.254/');
  assert.equal(b.ok, false);
  // 172.15 and 172.32 must be treated as PUBLIC (outside /12).
  const c = validateScrapeURL('http://172.15.0.1/');
  assert.equal(c.ok, true, '172.15.x.x is outside the /12 block');
  const d = validateScrapeURL('http://172.32.0.1/');
  assert.equal(d.ok, true, '172.32.x.x is outside the /12 block');
});

test('SSRF guard rejects RFC1918 192.168.0.0/16', () => {
  const r = validateScrapeURL('http://192.168.1.1/');
  assert.equal(r.ok, false);
  assert.match(r.error, /private/);
});

test('SSRF guard rejects link-local 169.254.0.0/16 (AWS metadata)', () => {
  const r = validateScrapeURL('http://169.254.169.254/latest/meta-data/');
  assert.equal(r.ok, false);
  assert.match(r.error, /link-local/);
});

test('SSRF guard rejects 0.0.0.0', () => {
  const r = validateScrapeURL('http://0.0.0.0/');
  assert.equal(r.ok, false);
});

test('SSRF guard rejects IPv6 loopback ::1', () => {
  const r = validateScrapeURL('http://[::1]/');
  assert.equal(r.ok, false);
  assert.match(r.error, /loopback/);
});

test('SSRF guard rejects IPv6 link-local fe80::', () => {
  const r = validateScrapeURL('http://[fe80::1]/');
  assert.equal(r.ok, false);
  assert.match(r.error, /link-local/);
});

test('SSRF guard accepts a legitimate public https URL', () => {
  const r = validateScrapeURL('https://madchill.com/');
  assert.equal(r.ok, true);
});

test('SSRF guard rejects malformed input', () => {
  assert.equal(validateScrapeURL('').ok, false);
  assert.equal(validateScrapeURL(null).ok, false);
  assert.equal(validateScrapeURL(undefined).ok, false);
  assert.equal(validateScrapeURL(42).ok, false);
  assert.equal(validateScrapeURL('not a url').ok, false);
});

// ─────────────────────────────────────────────────────────────────────
// Palette extraction against a realistic fixture.
// ─────────────────────────────────────────────────────────────────────

test('palette extraction picks up brand colors from fixture CSS', () => {
  const colors = extractPaletteFromHtml(realisticHtml);
  // Expect the brand orange, navy accent, text black, white, border shade.
  assert.ok(colors.includes('#ff6f00'), `missing brand orange; got ${colors.join(', ')}`);
  assert.ok(colors.includes('#102a43'), `missing navy accent; got ${colors.join(', ')}`);
  assert.ok(colors.includes('#1a1a1a'), `missing text color; got ${colors.join(', ')}`);
  assert.ok(colors.includes('#ffffff'), `missing white background; got ${colors.join(', ')}`);
  assert.ok(colors.includes('#cc5800'), `missing border shade; got ${colors.join(', ')}`);
});

test('palette extraction de-duplicates repeated hex codes', () => {
  const html = '<style>.a{color:#FF0000} .b{color:#ff0000} .c{background:#FF0000}</style>';
  const colors = extractPaletteFromHtml(html);
  assert.deepEqual(colors, ['#ff0000']);
});

test('palette extraction picks up rgb() values and normalizes to hex', () => {
  const html = '<style>.x{color:rgb(16, 42, 67)}</style>';
  const colors = extractPaletteFromHtml(html);
  assert.deepEqual(colors, ['#102a43']);
});

// ─────────────────────────────────────────────────────────────────────
// Font detection.
// ─────────────────────────────────────────────────────────────────────

test('font detection surfaces CSS font-family declarations', () => {
  const fonts = extractFontFamilies(realisticHtml);
  assert.ok(fonts.includes('Inter'), `missing Inter; got ${fonts.join(', ')}`);
  assert.ok(fonts.includes('Space Grotesk'), `missing Space Grotesk; got ${fonts.join(', ')}`);
});

test('font detection picks up Google Fonts link tags', () => {
  const html = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@400">';
  const fonts = extractFontFamilies(html);
  assert.ok(fonts.includes('Roboto Condensed'));
});

test('font detection de-duplicates across CSS and Google Fonts sources', () => {
  const html = [
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
    '<style>body { font-family: "Inter", sans-serif }</style>',
  ].join('\n');
  const fonts = extractFontFamilies(html);
  // Case-insensitive de-dup. Just one entry.
  const interCount = fonts.filter(f => f.toLowerCase() === 'inter').length;
  assert.equal(interCount, 1);
});

// ─────────────────────────────────────────────────────────────────────
// Logo URL resolution.
// ─────────────────────────────────────────────────────────────────────

test('resolveLogoUrl prefers JSON-LD Organization.logo', () => {
  const url = resolveLogoUrl(realisticHtml, 'https://acme.test/');
  assert.equal(url, 'https://acme.test/assets/logo.png');
});

test('resolveLogoUrl falls back to apple-touch-icon when no JSON-LD', () => {
  const html = [
    '<html><head>',
    '<link rel="apple-touch-icon" href="/assets/apple-touch.png">',
    '<meta property="og:image" content="/og.png">',
    '</head></html>',
  ].join('\n');
  const url = resolveLogoUrl(html, 'https://acme.test/');
  assert.equal(url, 'https://acme.test/assets/apple-touch.png');
});

test('resolveLogoUrl falls back to og:image when no JSON-LD or apple icon', () => {
  const html = '<html><head><meta property="og:image" content="/og.png"></head></html>';
  const url = resolveLogoUrl(html, 'https://acme.test/');
  assert.equal(url, 'https://acme.test/og.png');
});

// ─────────────────────────────────────────────────────────────────────
// meta-theme-color fallback when CSS palette fails.
// ─────────────────────────────────────────────────────────────────────

test('meta-theme-color is extracted as a fallback signal', () => {
  const theme = extractMetaThemeColor(minimalHtml);
  assert.equal(theme, '#4caf50');
});

test('meta-theme-color returns null when absent', () => {
  const theme = extractMetaThemeColor('<html><head><title>x</title></head></html>');
  assert.equal(theme, null);
});

// ─────────────────────────────────────────────────────────────────────
// Happy path on the realistic fixture — every major signal extractable.
// ─────────────────────────────────────────────────────────────────────

test('realistic fixture yields non-empty palette, fonts, and logo', () => {
  const palette = extractPaletteFromHtml(realisticHtml);
  const fonts = extractFontFamilies(realisticHtml);
  const logo = resolveLogoUrl(realisticHtml, 'https://acme.test/');
  assert.ok(palette.length >= 3, `expected at least 3 palette entries, got ${palette.length}`);
  assert.ok(fonts.length >= 2, `expected at least 2 fonts, got ${fonts.length}`);
  assert.equal(logo, 'https://acme.test/assets/logo.png');
});

// ─────────────────────────────────────────────────────────────────────
// normalizeUrl — re-verified here since it's part of the public API
// and sits on the SSRF path.
// ─────────────────────────────────────────────────────────────────────

test('normalizeUrl prepends https:// when scheme is missing', () => {
  assert.equal(normalizeUrl('madchill.com'), 'https://madchill.com');
});

test('normalizeUrl rejects unparseable input', () => {
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl(null), null);
});

test('parseColor handles 3-digit hex, 6-digit hex, rgb, and rgba', () => {
  assert.equal(parseColor('#fff'), '#ffffff');
  assert.equal(parseColor('#FF6F00'), '#ff6f00');
  assert.equal(parseColor('rgb(255, 0, 0)'), '#ff0000');
  assert.equal(parseColor('rgba(0, 255, 0, 1)'), '#00ff00');
  assert.equal(parseColor('rgba(0, 0, 0, 0.05)'), null, 'near-transparent rejected');
});

// ─────────────────────────────────────────────────────────────────────
// REGRESSION GUARD (2026-04-20): timeout wrappers.
//
// A paying user on Forever21.com hit a permanent onboarding hang because
// quantizeLogoColors' injected fetch had no timeout. These tests pin each
// defence-in-depth layer so a future "simplification" can't silently
// regress back to an infinite await.
// ─────────────────────────────────────────────────────────────────────

test('raceWithTimeout resolves with the inner value if it settles first', async () => {
  const v = await raceWithTimeout(Promise.resolve('ok'), 1000, 'fast');
  assert.equal(v, 'ok');
});

test('raceWithTimeout rejects with ScrapeTimeoutError when the timer fires first', async () => {
  const never = new Promise(() => {}); // never settles
  await assert.rejects(
    () => raceWithTimeout(never, 20, 'stall'),
    (err) => {
      assert.ok(err instanceof ScrapeTimeoutError, 'must be ScrapeTimeoutError');
      assert.equal(err.code, 'TIMEOUT');
      assert.equal(err.stage, 'stall');
      assert.ok(typeof err.elapsedMs === 'number' && err.elapsedMs >= 0);
      assert.match(err.message, /timed out after 20ms/);
      return true;
    },
  );
});

test('raceWithTimeout invokes onTimeout side-effect when the timer fires', async () => {
  let cleanupRan = false;
  const never = new Promise(() => {});
  await assert.rejects(() => raceWithTimeout(never, 10, 'cleanup', () => { cleanupRan = true; }));
  assert.equal(cleanupRan, true, 'onTimeout must run before the rejection');
});

test('raceWithTimeout swallows onTimeout exceptions — cleanup is best-effort', async () => {
  const never = new Promise(() => {});
  // If onTimeout itself throws, the timeout rejection must still propagate.
  await assert.rejects(
    () => raceWithTimeout(never, 10, 'throwy-cleanup', () => { throw new Error('cleanup boom'); }),
    (err) => err instanceof ScrapeTimeoutError,
  );
});

test('raceWithTimeout clears the timer on inner resolution (no hanging process)', async () => {
  // If the timer leaked, node's test runner would complain about an open
  // handle keeping the event loop alive. This test passes iff the timer
  // was cleared when the inner promise settled.
  await raceWithTimeout(Promise.resolve(1), 60000, 'clear-on-resolve');
  // If we got here without hanging, the timer was cleared.
});

test('raceWithTimeout clears the timer on inner rejection', async () => {
  await assert.rejects(
    () => raceWithTimeout(Promise.reject(new Error('x')), 60000, 'clear-on-reject'),
    /x/,
  );
});

test('executeJsWithTimeout rejects immediately when the window is destroyed', async () => {
  const fakeWin = { isDestroyed: () => true, webContents: { executeJavaScript: () => new Promise(() => {}) } };
  await assert.rejects(
    () => executeJsWithTimeout(fakeWin, 'noop', 'test'),
    /window destroyed/,
  );
});

test('executeJsWithTimeout races the injected promise against the timeout', async () => {
  const fakeWin = {
    isDestroyed: () => false,
    webContents: { executeJavaScript: () => new Promise(() => {}) }, // never settles
  };
  await assert.rejects(
    () => executeJsWithTimeout(fakeWin, 'noop', 'stall', 15),
    (err) => err instanceof ScrapeTimeoutError && err.stage === 'executeJavaScript:stall',
  );
});

test('executeJsWithTimeout resolves with the injected value when it settles in time', async () => {
  const fakeWin = {
    isDestroyed: () => false,
    webContents: { executeJavaScript: async () => ({ ok: true }) },
  };
  const v = await executeJsWithTimeout(fakeWin, 'return 1', 'fast', 1000);
  assert.deepEqual(v, { ok: true });
});

test('timeout constants are reasonable and internally consistent', () => {
  // The logo fetch timeout must be strictly less than the executeJavaScript
  // timeout — otherwise the inner AbortController never gets the chance to
  // trip before the outer race fires, and we lose the friendly partial
  // result (empty logoColors) in favour of a hard reject.
  assert.ok(
    DEFAULT_LOGO_FETCH_TIMEOUT_MS < DEFAULT_EXECUTE_JS_TIMEOUT_MS,
    'logo fetch timeout must be shorter than executeJavaScript timeout',
  );
  // The overall timeout must exceed the per-call timeouts by enough slack
  // to cover the full scrape budget (primary load + secondary pages + logo
  // quantize). 90s >> 15s is sufficient for ~5 sequential pages.
  assert.ok(
    DEFAULT_OVERALL_TIMEOUT_MS > DEFAULT_EXECUTE_JS_TIMEOUT_MS * 2,
    'overall timeout must leave room for multiple inner calls',
  );
});

test('ScrapeTimeoutError exposes a stable TIMEOUT code for envelope classification', () => {
  const err = new ScrapeTimeoutError('x', { stage: 'overall', elapsedMs: 5000 });
  assert.equal(err.code, 'TIMEOUT');
  assert.equal(err.name, 'ScrapeTimeoutError');
  assert.equal(err.stage, 'overall');
  assert.equal(err.elapsedMs, 5000);
  // `instanceof Error` must still hold so generic error handlers don't
  // mis-route it as a non-Error value.
  assert.ok(err instanceof Error);
});

// ─────────────────────────────────────────────────────────────────────
// REGRESSION GUARD (2026-04-20): brand-scraper BrowserWindow hardening.
//
// The BrowserWindow loads arbitrary third-party origins (the user's site,
// logo CDNs, social preview redirects). Loosening any of the four flags
// below turns a scraper into a remote-code-execution channel on paying
// users' machines. This test source-scans brand-scraper.js and fails if
// the webPreferences block does not contain ALL four locked flags in
// their safe state. Intentionally forgiving on whitespace; intentionally
// unforgiving on value. If a legitimate variant ever needs a different
// config, build it as a SECOND helper with its own test — do not loosen
// the one enforcement point.
// ─────────────────────────────────────────────────────────────────────

const SCRAPER_SOURCE = fs.readFileSync(path.join(__dirname, 'brand-scraper.js'), 'utf8');

test('REGRESSION GUARD (2026-04-20): brand-scraper BrowserWindow webPreferences locks four security flags', () => {
  // Isolate the webPreferences block inside the scrapeBrand BrowserWindow
  // call so we don't match an unrelated literal elsewhere in the file.
  const bwMatch = SCRAPER_SOURCE.match(/new BrowserWindow\s*\(\s*\{[\s\S]*?webPreferences\s*:\s*\{([\s\S]*?)\}/);
  assert.ok(
    bwMatch,
    'brand-scraper.js must construct exactly one BrowserWindow with a literal webPreferences object',
  );
  const prefs = bwMatch[1];

  const MUST_HAVE = [
    { flag: 'nodeIntegration', value: 'false', rationale: 'node access = instant RCE' },
    { flag: 'contextIsolation', value: 'true',  rationale: 'isolation prevents preload leakage' },
    { flag: 'webSecurity',      value: 'true',  rationale: 'same-origin policy blocks file:// exfil' },
    { flag: 'sandbox',          value: 'true',  rationale: 'OS sandbox is the last line of defense' },
  ];

  for (const { flag, value, rationale } of MUST_HAVE) {
    const pattern = new RegExp(`\\b${flag}\\s*:\\s*${value}\\b`);
    assert.match(
      prefs,
      pattern,
      `brand-scraper webPreferences must declare ${flag}: ${value} (${rationale}). ` +
      `A change here rides a straight line from "merged PR" to "RCE on every paying user."`,
    );
  }

  // Belt-and-braces: explicitly fail if the "unsafe" value of any flag is
  // present anywhere in the block. Catches a future edit that adds an
  // override line below the original (e.g. `sandbox: true, ... sandbox: false`).
  const UNSAFE = [
    /\bnodeIntegration\s*:\s*true\b/,
    /\bcontextIsolation\s*:\s*false\b/,
    /\bwebSecurity\s*:\s*false\b/,
    /\bsandbox\s*:\s*false\b/,
  ];
  for (const bad of UNSAFE) {
    assert.doesNotMatch(
      prefs,
      bad,
      `brand-scraper webPreferences contains an unsafe override: ${bad}. Refuse to ship.`,
    );
  }
});

test('REGRESSION GUARD (2026-04-20): brand-scraper BrowserWindow does not declare a preload script', () => {
  // A preload in the scraper window is an automatic exposure of Node APIs
  // to the loaded third-party page — the whole point of `sandbox: true`
  // plus `contextIsolation: true` is that nothing bridges the main-process
  // boundary. If a future PR adds `preload: path.join(...)` here, the
  // sandbox/isolation flags stop mattering for any API the preload exposes.
  const bwMatch = SCRAPER_SOURCE.match(/new BrowserWindow\s*\(\s*\{[\s\S]*?webPreferences\s*:\s*\{([\s\S]*?)\}/);
  assert.ok(bwMatch, 'brand-scraper.js must construct a BrowserWindow with webPreferences');
  const prefs = bwMatch[1];
  assert.doesNotMatch(
    prefs,
    /\bpreload\s*:/,
    'brand-scraper webPreferences must not declare a preload script — it bridges Node into the loaded page',
  );
});

test('REGRESSION GUARD (2026-04-20): brand-scraper only constructs ONE BrowserWindow', () => {
  // If a second BrowserWindow appears in this file, it needs its own
  // hardening review. Refuse to pass silently.
  const matches = SCRAPER_SOURCE.match(/new BrowserWindow\s*\(/g) || [];
  assert.equal(
    matches.length,
    1,
    `brand-scraper.js must construct exactly one BrowserWindow (found ${matches.length}). ` +
    `Any new scraper BrowserWindow needs its own hardened config and its own test coverage.`,
  );
});

// ─────────────────────────────────────────────────────────────────────
// Task 3.5 — partial BrandSignal on overall timeout.
//
// When the outer 90s race fires, scrapeBrand no longer drops everything —
// it resolves with { ok: false, partial, timed_out_stage, error } so the
// caller can decide (via isUsefulPartial) whether the partial is rich
// enough to proceed. Non-timeout rejects still propagate unchanged.
//
// `scrapeBrand` can't be directly unit-tested without Electron, so the
// timeout contract is exercised via the extracted `settleOverallRace`
// helper that wraps the same race + branch. The happy-path shape is
// exercised via a mocked body promise.
// ─────────────────────────────────────────────────────────────────────

test('isUsefulPartial: empty partial is not useful', () => {
  assert.equal(isUsefulPartial(undefined), false);
  assert.equal(isUsefulPartial(null), false);
  assert.equal(isUsefulPartial({}), false);
  assert.equal(isUsefulPartial({ url: 'https://x.test/' }), false);
});

test('isUsefulPartial: title alone is not enough (threshold is >=2 of 4)', () => {
  const p = { primary: { copy: { title: 'Acme Supply Co' } } };
  assert.equal(isUsefulPartial(p), false);
});

test('isUsefulPartial: title + description passes the threshold', () => {
  const p = {
    primary: {
      copy: {
        title: 'Acme Supply Co',
        metaDescription: 'Hand-dipped candles and small-batch soap',
      },
    },
  };
  assert.equal(isUsefulPartial(p), true);
});

test('isUsefulPartial: heroParagraph counts as description', () => {
  const p = {
    primary: {
      copy: {
        title: 'Acme',
        heroParagraph: 'Small-batch candles from Vermont.',
      },
    },
  };
  assert.equal(isUsefulPartial(p), true);
});

test('isUsefulPartial: products + logoColors (no title, no desc) still passes', () => {
  const p = {
    primary: {
      copy: { productTitles: ['Candle A', 'Candle B'] },
      logoCandidates: [],
    },
    logoColors: [{ hex: '#ff6f00', freq: 0.4 }],
  };
  assert.equal(isUsefulPartial(p), true);
});

test('isUsefulPartial: whitespace-only title does NOT count', () => {
  const p = {
    primary: {
      copy: {
        title: '   ',
        metaDescription: 'About us',
      },
    },
  };
  // Only 1 signal (description) — below threshold.
  assert.equal(isUsefulPartial(p), false);
});

test('isUsefulPartial: logoCandidates present counts as logo signal', () => {
  const p = {
    primary: {
      copy: { title: 'Acme' },
      logoCandidates: [{ src: 'https://acme.test/logo.png', weight: 100 }],
    },
  };
  assert.equal(isUsefulPartial(p), true);
});

test('isUsefulPartial: empty arrays do not count', () => {
  const p = {
    primary: {
      copy: { title: 'Acme', productTitles: [] },
      logoCandidates: [],
    },
    logoColors: [],
  };
  // Only title populated — below threshold.
  assert.equal(isUsefulPartial(p), false);
});

test('settleOverallRace: overall timeout resolves with populated partial + timed_out_stage', async () => {
  // Body that never settles — simulate a scrape that hangs past 90s.
  const body = new Promise(() => {});
  const partial = {
    url: 'https://acme.test/',
    capturedAt: '2026-04-23T12:00:00.000Z',
    primary: {
      copy: {
        title: 'Acme Supply Co',
        metaDescription: 'Hand-dipped candles from Vermont',
        productTitles: ['Beeswax Candle', 'Soy Taper'],
      },
      logoCandidates: [{ src: 'https://acme.test/logo.png', weight: 100 }],
    },
  };
  let killed = false;
  const res = await settleOverallRace(body, 20, {
    getPartial: () => partial,
    getStage: () => 'logo-quantize',
    killWindow: () => { killed = true; },
  });
  assert.equal(res.ok, false);
  assert.equal(res.timed_out_stage, 'logo-quantize');
  assert.match(res.error, /timed out after 20ms/);
  // Partial is JSON-cloned (deep copy, not the same reference).
  assert.notEqual(res.partial, partial);
  assert.equal(res.partial.primary.copy.title, 'Acme Supply Co');
  assert.equal(res.partial.primary.copy.productTitles.length, 2);
  assert.equal(killed, true, 'killWindow side-effect must fire on overall timeout');
  // Contract with Cluster-F: isUsefulPartial on the returned partial
  // correctly classifies it as useful.
  assert.equal(isUsefulPartial(res.partial), true);
});

test('settleOverallRace: overall timeout with empty partial → isUsefulPartial false', async () => {
  // Body never settles; partial never got populated because primary-load
  // itself hung.
  const body = new Promise(() => {});
  const partial = {
    url: 'https://slowsite.test/',
    capturedAt: '2026-04-23T12:00:00.000Z',
  };
  const res = await settleOverallRace(body, 20, {
    getPartial: () => partial,
    getStage: () => 'primary-load',
    killWindow: () => {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.timed_out_stage, 'primary-load');
  // Caller MUST be able to distinguish "partial timeout we can use" from
  // "full timeout, show manual entry" via isUsefulPartial.
  assert.equal(isUsefulPartial(res.partial), false);
});

test('settleOverallRace: happy path passes body result through unchanged', async () => {
  const fullResult = {
    ok: true,
    url: 'https://acme.test/',
    capturedAt: '2026-04-23T12:00:00.000Z',
    primary: { copy: { title: 'Acme' } },
    screenshots: { desktop: 'base64...', mobile: 'base64...' },
    logoColors: [{ hex: '#ff6f00', freq: 0.4 }],
    secondaryPages: [],
    partial: { url: 'https://acme.test/', capturedAt: '2026-04-23T12:00:00.000Z' },
  };
  const body = Promise.resolve(fullResult);
  const res = await settleOverallRace(body, 1000, {
    getPartial: () => ({}),
    getStage: () => 'complete',
    killWindow: () => {},
  });
  assert.equal(res, fullResult, 'happy-path result must be returned by identity');
  assert.equal(res.ok, true);
});

test('settleOverallRace: inner timeout (non-overall stage) still propagates as throw', async () => {
  // Simulates an inner ScrapeTimeoutError (e.g. executeJavaScript:collectSignal)
  // — these must NOT be caught and converted to a partial resolve; the caller's
  // existing error classifier depends on them reaching the catch.
  const innerErr = new ScrapeTimeoutError('inner stall', { stage: 'executeJavaScript:collectSignal', elapsedMs: 15000 });
  const body = Promise.reject(innerErr);
  await assert.rejects(
    () => settleOverallRace(body, 1000, {
      getPartial: () => ({}),
      getStage: () => 'primary-signal',
      killWindow: () => {},
    }),
    (err) => {
      assert.ok(err instanceof ScrapeTimeoutError);
      assert.equal(err.stage, 'executeJavaScript:collectSignal');
      return true;
    },
  );
});

test('settleOverallRace: non-TIMEOUT errors (navigation fail, SSRF) still propagate as throw', async () => {
  const navErr = new Error('navigation failed: DNS resolve error (-105) for https://foo.test/');
  const body = Promise.reject(navErr);
  await assert.rejects(
    () => settleOverallRace(body, 1000, {
      getPartial: () => ({}),
      getStage: () => 'primary-load',
      killWindow: () => {},
    }),
    /navigation failed/,
  );
});

test('settleOverallRace: overall timeout clonePartial is deep — mutating original does not affect result', async () => {
  const body = new Promise(() => {});
  const partial = {
    url: 'https://acme.test/',
    primary: { copy: { title: 'Acme', productTitles: ['A', 'B'] } },
  };
  const res = await settleOverallRace(body, 20, {
    getPartial: () => partial,
    getStage: () => 'secondary-pages',
    killWindow: () => {},
  });
  assert.equal(res.ok, false);
  // Mutate the original after the race has resolved — the returned
  // partial must be a deep clone, not the live accumulator reference.
  partial.primary.copy.title = 'MUTATED';
  partial.primary.copy.productTitles.push('C');
  assert.equal(res.partial.primary.copy.title, 'Acme');
  assert.equal(res.partial.primary.copy.productTitles.length, 2);
});

test('clonePartial: strips non-serializable values per REGRESSION GUARD (2026-04-23)', () => {
  // A future stage authors must not accidentally write a BrowserWindow
  // or other Electron handle into `partial`. JSON.stringify drops
  // functions and handles some circular refs cleanly; anything that
  // throws falls back to the safe subset.
  const withFn = { url: 'https://x.test/', secret: () => 42 };
  const cloned = clonePartial(withFn);
  assert.equal(cloned.url, 'https://x.test/');
  assert.equal(cloned.secret, undefined, 'functions must be dropped on clone');

  // Circular refs fall back to the shallow-safe subset.
  const circular = { url: 'https://c.test/', capturedAt: '2026-04-23T00:00:00Z' };
  circular.self = circular;
  const cc = clonePartial(circular);
  assert.equal(cc.url, 'https://c.test/');
  assert.equal(cc.capturedAt, '2026-04-23T00:00:00Z');
  // The 'self' field is either stripped or the whole thing fell back
  // to the safe subset — either way, no stack overflow, no crash.
});

test('clonePartial: handles null/undefined input without throwing', () => {
  assert.deepEqual(clonePartial(null), {});
  assert.deepEqual(clonePartial(undefined), {});
});

test('SCRAPE_STAGES: exposed in a stable order matching the scrapeBrand flow', () => {
  // If a future refactor inserts a new stage, append it near the right
  // position and keep 'complete' last. This test documents the contract.
  assert.ok(Array.isArray(SCRAPE_STAGES));
  assert.ok(SCRAPE_STAGES.includes('pre-navigation'));
  assert.ok(SCRAPE_STAGES.includes('primary-load'));
  assert.ok(SCRAPE_STAGES.includes('primary-signal'));
  assert.ok(SCRAPE_STAGES.includes('secondary-pages'));
  assert.ok(SCRAPE_STAGES.includes('logo-quantize'));
  assert.equal(SCRAPE_STAGES[SCRAPE_STAGES.length - 1], 'complete');
});

// REGRESSION GUARD (2026-04-23): The scrapeBrand return shape is the
// Cluster-F <-> Cluster-G contract. Both ok paths return `{ ok, url,
// capturedAt, primary, screenshots, logoColors, secondaryPages, partial }`;
// the timeout path returns `{ ok:false, partial, timed_out_stage, error }`.
// The shape is exercised end-to-end by settleOverallRace tests above;
// this source-scan pins the invariant that scrapeBrand keeps using
// `settleOverallRace` as the single exit point (not raceWithTimeout
// directly) so the partial-resolve branch can never be bypassed.
test('REGRESSION GUARD (2026-04-23): scrapeBrand routes through settleOverallRace, not raw raceWithTimeout', () => {
  // Extract just the body of scrapeBrand — matches from "async function scrapeBrand"
  // to the first top-level close-brace.
  const fnMatch = SCRAPER_SOURCE.match(/async function scrapeBrand\b[\s\S]*?^}/m);
  assert.ok(fnMatch, 'scrapeBrand function body not found in source');
  const body = fnMatch[0];
  assert.match(
    body,
    /return\s+settleOverallRace\b/,
    'scrapeBrand must return via settleOverallRace so the partial-timeout branch is guaranteed reachable',
  );
  assert.doesNotMatch(
    body,
    /return\s+raceWithTimeout\b/,
    'scrapeBrand must NOT return raceWithTimeout directly — that path rejects on timeout and drops the partial signal',
  );
});
