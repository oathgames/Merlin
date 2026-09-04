// REGRESSION GUARD (2026-09-04, unvalidated-base64-into-innerHTML):
//
// The assistant-message image branch in renderer.js built its markup as
//
//   imgBubble.innerHTML =
//     `<img src="data:${mimeType};base64,${block.source.data}" ...>`;
//
// `mimeType` was sanitized; `block.source.data` was not. It arrives over the
// SDK stream and was length-checked only (>100, <10MB). A single `"` inside it
// closes the src attribute and everything after it is parsed as markup in a
// chat bubble, inside a renderer that holds the whole IPC bridge.
//
// The fix validates the assembled data URL against a strict allowlist — known
// raster mime types plus the base64 alphabet, nothing else — and builds the
// element through the DOM instead of a template string.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

// The exact expression shipped in renderer.js, re-derived here so the test
// exercises the real predicate rather than a copy that can drift.
function shippedPattern() {
  const m = RENDERER.match(/if \(!(\/\^data:image[^\n]*?\/)\.test\(dataUrl\)\) \{/);
  assert.ok(m, 'the data-URL validation regex was not found in renderer.js');
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

const RE = shippedPattern();
const ok = (u) => RE.test(u);

test('SOURCE: the image branch no longer interpolates source.data into innerHTML', () => {
  assert.ok(
    !/innerHTML = `<img src="data:\$\{mimeType\}/.test(RENDERER),
    'the innerHTML template is the injection sink and must stay gone',
  );
  assert.match(RENDERER, /imgEl\.src = dataUrl;/, 'the element must be built through the DOM');
  assert.match(RENDERER, /imgBubble\.replaceChildren\(imgEl\)/);
});

test('SOURCE: validation runs BEFORE any bubble is created', () => {
  const i = RENDERER.indexOf('if (!/^data:image');
  const j = RENDERER.indexOf('const imgBubble = addClaudeBubble();');
  assert.ok(i > 0 && j > i, 'a bubble must never be created for a payload that fails validation');
  const between = RENDERER.slice(i, j);
  assert.match(between, /continue;/, 'a failed payload must skip the block entirely');
});

test('accepts the four legitimate raster mime types', () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']) {
    assert.ok(ok(`data:${mime};base64,iVBORw0KGgoAAAANSUhEUg==`), `${mime} must be accepted`);
  }
});

test('rejects a payload that breaks out of the src attribute', () => {
  assert.ok(!ok('data:image/png;base64,AAAA" onerror="alert(1)'));
  assert.ok(!ok('data:image/png;base64,AAAA"><script>alert(1)</script>'));
  assert.ok(!ok('data:image/png;base64,AAAA\'>x'));
});

test('rejects whitespace, newlines and angle brackets inside the payload', () => {
  assert.ok(!ok('data:image/png;base64,AA AA'));
  assert.ok(!ok('data:image/png;base64,AA\nAA'));
  assert.ok(!ok('data:image/png;base64,AA<AA'));
});

test('rejects a non-image or script-bearing mime', () => {
  assert.ok(!ok('data:text/html;base64,PHNjcmlwdD4='));
  assert.ok(!ok('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), 'SVG can carry script — not on the allowlist');
  assert.ok(!ok('javascript:alert(1)'));
});

test('rejects an empty payload', () => {
  assert.ok(!ok('data:image/png;base64,'));
});
