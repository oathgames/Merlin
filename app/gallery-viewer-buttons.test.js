// gallery-viewer-buttons.test.js — Wave-F-9 regression guard for the
// "button-only-clickable-on-icon" report (2026-05-03). The full-screen
// creative viewer (.gv-viewer) wraps its top toolbar with
// pointer-events:none so the gradient header doesn't block clicks on
// the stage backdrop. The four action buttons (★ keep / ✗ reject /
// 🗑 trash / ✕ close) live two levels deep inside the toolbar
// (.gv-toolbar > .gv-actions > .gv-action). The pre-fix CSS used a
// direct-child selector (.gv-toolbar > *) which restored
// pointer-events on the .gv-actions flex container only — under
// Electron WebKit the buttons themselves still inherited the
// toolbar's `none` and only registered clicks on the inner glyph
// text node, not the surrounding 36×36 button bbox.
//
// This test fails if a future "tighten the selector" sweep reverts
// the descendant selector to a direct-child one, so the bug can't
// silently come back.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cssPath = path.join(__dirname, 'style.css');
const galleryPath = path.join(__dirname, 'gallery-viewer.js');

test('style.css uses descendant selector to restore pointer-events on every gv-toolbar control', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  // The descendant selector is critical — direct-child (>) was the bug.
  assert.match(
    css,
    /\.gv-toolbar\s+\*\s*\{\s*pointer-events:\s*auto\s*;?\s*\}/,
    '.gv-toolbar must use a descendant selector (`.gv-toolbar *`) to restore pointer-events on nested .gv-action buttons. The direct-child form (`.gv-toolbar > *`) only restored events on .gv-actions, leaving the buttons clickable only on their glyph text node.'
  );
  // Defense-in-depth: the toolbar itself MUST still be pointer-events:none
  // (otherwise the gradient header blocks clicks on the stage backdrop
  // behind it — close-on-backdrop-click stops working).
  assert.match(
    css,
    /\.gv-toolbar\s*\{[^}]*pointer-events:\s*none/,
    '.gv-toolbar must keep pointer-events:none so the gradient header does not block clicks on the stage backdrop.'
  );
  // Negative guard: the broken direct-child form must not reappear.
  assert.doesNotMatch(
    css,
    /\.gv-toolbar\s*>\s*\*\s*\{\s*pointer-events:\s*auto/,
    'REGRESSION: .gv-toolbar > * { pointer-events: auto } is the bug — descendants like .gv-action lose pointer-events under WebKit. Use the descendant selector instead.'
  );
});

test('gallery-viewer.js still nests .gv-action buttons inside .gv-actions inside .gv-toolbar', () => {
  // Source-scan: confirms the structural assumption the CSS fix relies
  // on. If the buttons get hoisted out of .gv-actions in a refactor,
  // this test passes (no longer relevant) but the CSS rule still works.
  // The point is to fail loudly if .gv-actions stops being the
  // grandchild container the CSS bug surfaced from.
  const src = fs.readFileSync(galleryPath, 'utf8');
  assert.match(src, /className\s*=\s*['"]gv-toolbar(\s|['"])/, 'gallery-viewer.js must construct .gv-toolbar');
  assert.match(src, /className\s*=\s*['"]gv-actions['"]/, 'gallery-viewer.js must construct .gv-actions');
  assert.match(src, /className\s*=\s*['"]gv-action\s+gv-flag-keep['"]/, 'gallery-viewer.js must construct the keep button');
  assert.match(src, /className\s*=\s*['"]gv-action\s+gv-flag-reject['"]/, 'gallery-viewer.js must construct the reject button');
  assert.match(src, /className\s*=\s*['"]gv-action\s+gv-trash['"]/, 'gallery-viewer.js must construct the trash button');
  assert.match(src, /className\s*=\s*['"]gv-action\s+gv-close['"]/, 'gallery-viewer.js must construct the close button');
  // The buttons are appended to .gv-actions (verified by the appendChild
  // call sequence in gallery-viewer.js around line 250). If a refactor
  // changes the container, the CSS rule still works (descendant matches
  // any depth) but this test pins the canonical shape.
  assert.match(src, /actions\.appendChild\(flagKeep\)/);
  assert.match(src, /actions\.appendChild\(flagReject\)/);
  assert.match(src, /actions\.appendChild\(trashBtn\)/);
  assert.match(src, /actions\.appendChild\(closeBtn\)/);
});
