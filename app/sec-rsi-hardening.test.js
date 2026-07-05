// REGRESSION GUARD (2026-07-04, SEC RSI — renderer class-attr escaping + nav lock)
//
// Two low-severity defense-in-depth hardenings from the adversarial pentest:
//
//  (1) Two renderer sinks interpolated a platform identifier directly into a
//      CSS class attribute without sanitizing:
//        - the perf platform-breakdown dropdown: `platform-${p.name...}` +
//          the badge text `${p.name}` (unescaped);
//        - the archive card badge: `platform-${ad.platform...}`.
//      Both values are system-controlled TODAY (fixed platform ids from the Go
//      binary), so not currently exploitable — but a future change routing an
//      account/campaign name into that field would silently open an attribute-
//      injection hole. The class now strips to [a-z0-9] and the text is
//      escapeHtml'd, closing the convention gap.
//
//  (2) The main BrowserWindow had setWindowOpenHandler(deny) but no
//      will-navigate handler. CSP (`default-src 'self'`) already blocks remote
//      loads, but a will-navigate lock is the belt-and-suspenders layer that
//      denies any attempt to navigate the window off the local index.html.
//
// Pure source-scan (renderer.js / main.js aren't requireable under node:test).
//
// Run with: node --test app/sec-rsi-hardening.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// ── (1) Renderer class-attribute sanitization ───────────────────────────

test('perf platform-dropdown sanitizes the class and escapes p.name', () => {
  // The class suffix must strip to [a-z0-9]; the visible text must be escaped.
  assert.match(
    RENDERER,
    /platform-\$\{String\(p\.name \|\| ''\)\.split\(' '\)\[0\]\.toLowerCase\(\)\.replace\(\/\[\^a-z0-9\]\/g, ''\)\}/,
    'the platform-dropdown class must strip p.name to [a-z0-9] before interpolation',
  );
  assert.match(
    RENDERER,
    /platform-badge platform-\$\{String\(p\.name[^}]*\}">\$\{escapeHtml\(p\.name\)\}/,
    'the platform-dropdown badge text must be escapeHtml(p.name), not raw ${p.name}',
  );
});

test('archive card platform badge sanitizes the class suffix', () => {
  assert.match(
    RENDERER,
    /platform-\$\{\(ad\.platform \|\| ''\)\.toLowerCase\(\)\.replace\(\/\[\^a-z0-9\]\/g, ''\)\}/,
    'the archive card platform class must strip ad.platform to [a-z0-9]',
  );
});

test('archive campaign-header badge sanitizes the class suffix (3rd sink)', () => {
  // escapeHtml does NOT escape double-quotes, so it is unsafe inside a class
  // attribute; the class suffix must strip to [a-z0-9] like the other two sinks.
  assert.match(
    RENDERER,
    /platform-\$\{g\.platform\.toLowerCase\(\)\.replace\(\/\[\^a-z0-9\]\/g, ''\)\}/,
    'the campaign-header platform class must strip g.platform to [a-z0-9], not rely on escapeHtml (quote-unsafe in an attribute)',
  );
});

// ── (2) Main window navigation lock ─────────────────────────────────────

test('main window installs a will-navigate handler that prevents off-page navigation', () => {
  assert.match(
    MAIN,
    /win\.webContents\.on\('will-navigate'/,
    'the main BrowserWindow must register a will-navigate handler (defense-in-depth with the CSP)',
  );
  // The handler must actually block: preventDefault + external open for http(s).
  const idx = MAIN.indexOf("win.webContents.on('will-navigate'");
  assert.ok(idx > 0, 'will-navigate handler present');
  const slice = MAIN.slice(idx, idx + 700);
  assert.match(slice, /event\.preventDefault\(\)/, 'will-navigate must preventDefault on a disallowed navigation');
  assert.match(slice, /openExternalSafe\(navUrl\)/, 'http(s) navigations must be handed to the OS browser, not loaded in-window');
});
