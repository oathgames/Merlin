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
