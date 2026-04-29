// codex-2026-04-29-hardening.test.js
//
// Regression guards for the 2026-04-29 enterprise review pass. main.js and
// renderer.js boot Electron / DOM contexts at require time, so these tests
// follow the same source-scan + extracted-eval pattern as
// main-codex-hardening.test.js: read the file, assert the structure exists,
// and where the logic is self-contained, eval the function in isolation
// to exercise it.
//
// Covered:
//   1. deepLinkIsSafe — rejects non-merlin: schemes, oversize input,
//      control chars, malformed URLs; returns canonical href on success.
//      (Codex P2 #10)
//   2. validateRendererState — key allowlist + type checks for the
//      save-state IPC handler. Anything outside the allowlist or wrong
//      shape rejects. (Codex P2 #11)
//   3. renderMarkdown DOMPurify fallback — fails closed (HTML-escapes)
//      when DOMPurify is undefined instead of returning raw marked
//      output. (Codex P1 #5)

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const RENDERER_JS = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

// Extract a top-level function body by name. Throws if not found or
// can't be cleanly delimited. Used to lift main.js helpers into the
// test process without booting Electron.
function extractFunction(src, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  let depth = 0;
  let i = m.index + m[0].length - 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(m.index, i + 1);
      }
    }
  }
  throw new Error(`function ${name} not closed`);
}

// ── 1. deepLinkIsSafe ──────────────────────────────────────────────────

test('deepLinkIsSafe is defined in main.js', () => {
  assert.match(MAIN_JS, /function\s+deepLinkIsSafe\s*\(/);
});

test('deepLinkIsSafe rejects non-string, oversize, control-char, non-merlin URLs', () => {
  const fnSrc = extractFunction(MAIN_JS, 'deepLinkIsSafe');
  const constSrc = 'const DEEP_LINK_MAX_LEN = 4096;';
  const isSafe = new Function(`${constSrc}\n${fnSrc}\nreturn deepLinkIsSafe;`)();

  // Non-string inputs.
  assert.equal(isSafe(undefined), null);
  assert.equal(isSafe(null), null);
  assert.equal(isSafe(123), null);
  assert.equal(isSafe({}), null);
  assert.equal(isSafe([]), null);

  // Empty / oversize.
  assert.equal(isSafe(''), null);
  assert.equal(isSafe('merlin://x' + 'a'.repeat(5000)), null);

  // Control characters embedded.
  assert.equal(isSafe('merlin://activate?token=abc\nmalicious'), null);
  assert.equal(isSafe('merlin://activate\rfoo'), null);
  assert.equal(isSafe('merlin://act\x00ivate'), null);
  assert.equal(isSafe('merlin://activate\x7Fextra'), null);

  // Wrong scheme — even ones that look close.
  assert.equal(isSafe('https://merlingotme.com/'), null);
  assert.equal(isSafe('merlinx://activate'), null);
  assert.equal(isSafe('javascript://%0aalert(1)'), null);
  assert.equal(isSafe('file:///etc/passwd'), null);
  assert.equal(isSafe('not a url at all'), null);

  // Valid merlin:// URLs return the canonical href.
  const ok = isSafe('merlin://activate?token=abc123');
  assert.equal(typeof ok, 'string');
  assert.match(ok, /^merlin:\/\//);
  assert.match(ok, /token=abc123/);
});

test('deepLinkIsSafe rejects scheme with leading whitespace (URL-parse must reject too)', () => {
  const fnSrc = extractFunction(MAIN_JS, 'deepLinkIsSafe');
  const constSrc = 'const DEEP_LINK_MAX_LEN = 4096;';
  const isSafe = new Function(`${constSrc}\n${fnSrc}\nreturn deepLinkIsSafe;`)();

  // Leading space is a control-or-space char (0x20) — but our regex only
  // catches < 0x20. URL parser must catch this since 'merlin:' won't be
  // the protocol of ' merlin://x'.
  assert.equal(isSafe(' merlin://x'), null);
});

test('deliverDeepLink uses deepLinkIsSafe (forwards canonical href, not raw input)', () => {
  // Source-scan: deliverDeepLink must call deepLinkIsSafe and forward
  // the safe value, not the raw url. Catches a future edit that
  // re-introduces win.webContents.send(..., url) after parsing.
  const m = MAIN_JS.match(/function\s+deliverDeepLink\s*\([\s\S]{0,800}?\n\}/);
  assert(m, 'deliverDeepLink not found');
  assert.match(m[0], /deepLinkIsSafe\(url\)/);
  assert.match(m[0], /webContents\.send\(\s*['"]merlin-deep-link['"]\s*,\s*safe\s*\)/);
  assert.doesNotMatch(
    m[0],
    /webContents\.send\(\s*['"]merlin-deep-link['"]\s*,\s*url\s*\)/,
    'deliverDeepLink must forward the canonical safe href, not the raw url',
  );
});

// ── 2. validateRendererState (save-state schema) ───────────────────────

test('SAVE_STATE_RENDERER_SCHEMA is declared with the expected keys', () => {
  assert.match(MAIN_JS, /const\s+SAVE_STATE_RENDERER_SCHEMA\s*=\s*\{/);
  // Pull just the schema literal.
  const m = MAIN_JS.match(/const\s+SAVE_STATE_RENDERER_SCHEMA\s*=\s*\{([\s\S]*?)\};/);
  assert(m, 'schema literal not found');
  assert.match(m[1], /activeBrand\s*:/);
  assert.match(m[1], /progressDismissed\s*:/);
});

test('validateRendererState enforces allowlist and per-key types', () => {
  const fnSrc = extractFunction(MAIN_JS, 'validateRendererState');
  const schemaSrc = MAIN_JS.match(/const\s+SAVE_STATE_RENDERER_SCHEMA\s*=\s*\{[\s\S]*?\};/)[0];
  const validate = new Function(`${schemaSrc}\n${fnSrc}\nreturn validateRendererState;`)();

  // Non-objects rejected.
  assert.equal(validate(null).ok, false);
  assert.equal(validate(undefined).ok, false);
  assert.equal(validate('string').ok, false);
  assert.equal(validate(42).ok, false);
  assert.equal(validate([]).ok, false);

  // Empty object rejected.
  assert.equal(validate({}).ok, false);

  // Unknown keys rejected.
  assert.equal(validate({ malicious: true }).ok, false);
  assert.equal(validate({ activeBrand: 'foo', extra: 1 }).ok, false);
  assert.equal(validate({ __proto__: { polluted: true } }).ok, false);

  // Wrong types rejected.
  assert.equal(validate({ activeBrand: 123 }).ok, false);
  assert.equal(validate({ progressDismissed: 'yes' }).ok, false);
  assert.equal(validate({ progressDismissed: 1 }).ok, false);
  assert.equal(validate({ activeBrand: 'a'.repeat(300) }).ok, false);

  // Too many keys rejected.
  const big = {};
  for (let i = 0; i < 20; i++) big['k' + i] = i;
  assert.equal(validate(big).ok, false);

  // Valid payloads pass and return a sanitized object containing ONLY
  // allowed keys (defends against a reviewer accidentally widening
  // writeState to consume the unsanitized input).
  const okBrand = validate({ activeBrand: 'mybrand' });
  assert.equal(okBrand.ok, true);
  assert.deepEqual(okBrand.sanitized, { activeBrand: 'mybrand' });

  const okDismissed = validate({ progressDismissed: true });
  assert.equal(okDismissed.ok, true);
  assert.deepEqual(okDismissed.sanitized, { progressDismissed: true });

  const okBoth = validate({ activeBrand: 'b', progressDismissed: false });
  assert.equal(okBoth.ok, true);
  assert.deepEqual(okBoth.sanitized, { activeBrand: 'b', progressDismissed: false });

  // null activeBrand is allowed (clears the active brand).
  const okClear = validate({ activeBrand: null });
  assert.equal(okClear.ok, true);
});

test('save-state ipc handler routes through validateRendererState', () => {
  // Catches a future edit that reverts to writeState(data) without
  // validation.
  const m = MAIN_JS.match(/ipcMain\.handle\(\s*['"]save-state['"][\s\S]{0,400}?\}\)\s*;?/);
  assert(m, 'save-state handler not found');
  assert.match(m[0], /validateRendererState\(\s*data\s*\)/);
  assert.match(m[0], /writeState\(\s*v\.sanitized\s*\)/);
  assert.doesNotMatch(
    m[0],
    /writeState\(\s*data\s*\)/,
    'save-state handler must pass v.sanitized, not the raw data',
  );
});

// ── 3. renderMarkdown DOMPurify fallback ───────────────────────────────

test('renderMarkdown fails closed when DOMPurify is undefined', () => {
  // Window the source around the DOMPurify branch and assert both
  // sanitized (DOMPurify defined) and HTML-escaped (DOMPurify missing)
  // paths exist. We don't try to bound the whole renderMarkdown body
  // here — it's long (>200 lines) and the structural assertions don't
  // care about the rest.
  const idx = RENDERER_JS.indexOf('typeof DOMPurify');
  assert(idx >= 0, 'DOMPurify branch missing in renderer.js');
  const window_ = RENDERER_JS.slice(idx, idx + 1500);
  // Sanitized path.
  assert.match(window_, /DOMPurify\.sanitize\(\s*marked\.parse/);
  // Fail-closed escape path — the hallmark of "fall back to escaped
  // text" rather than rendering raw markdown.
  assert.match(window_, /&amp;/);
  assert.match(window_, /&lt;/);
  assert.match(window_, /&gt;/);
  // Negative: the previous fail-open form `: marked.parse(text);` must
  // not reappear directly under the DOMPurify check.
  assert.doesNotMatch(
    window_,
    /\?\s*DOMPurify\.sanitize[\s\S]{0,400}?:\s*marked\.parse\(text\)\s*;/,
    'renderMarkdown must NOT fall back to raw marked.parse — that is the XSS regression Codex P1 #5 closed',
  );
});

// ── 4. .merlin-trial untracked guard ───────────────────────────────────

test('.merlin-trial is listed in .gitignore (no longer tracked)', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.match(gi, /^\s*\.merlin-trial\s*$/m);
});
