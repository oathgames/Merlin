// pin-sidebar.test.js — pins the contract for the "pin sidebar open"
// UX feature on the Magic + Archive right-rail sidebars.
//
// User-facing: clicking the pin button on a sidebar header keeps the
// sidebar open AND shifts the chat viewport left by 340px (matching
// the sidebar's width) so content reflows instead of being overlaid.
// Persisted in localStorage so the pin survives app restarts.
//
// Source-scan only — renderer.js depends on window/DOM globals and
// can't be loaded under node:test. The contract is locked via
// presence of the helper functions, the CSS class names, the
// localStorage keys, and the boot-script in index.html that restores
// state BEFORE first paint (no FOUC flicker on cold start).

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');

// ── HTML — both sidebar headers carry a pin button ─────────────

test('index.html declares pin buttons on Magic + Archive headers', () => {
  assert.match(indexHtml, /id="magic-pin"[^>]*data-sidebar="magic"/,
    '#magic-pin button must exist on the Magic panel header with data-sidebar="magic"');
  assert.match(indexHtml, /id="archive-pin"[^>]*data-sidebar="archive"/,
    '#archive-pin button must exist on the Archive panel header with data-sidebar="archive"');
});

test('pin buttons declare aria-pressed for screen readers + state styling', () => {
  // The CSS uses [aria-pressed="true"] to flip the active visual state,
  // and the JS toggles aria-pressed on click. Both ATs and CSS depend
  // on this attribute being present at parse time.
  const magicMatch = indexHtml.match(/id="magic-pin"[^>]*>/);
  assert.ok(magicMatch, '#magic-pin must exist');
  assert.match(magicMatch[0], /aria-pressed="false"/,
    '#magic-pin must declare aria-pressed="false" initially (matched at parse time so SR users hear the pressed/unpressed state from the first paint)');
  const archiveMatch = indexHtml.match(/id="archive-pin"[^>]*>/);
  assert.ok(archiveMatch, '#archive-pin must exist');
  assert.match(archiveMatch[0], /aria-pressed="false"/,
    '#archive-pin must declare aria-pressed="false" initially');
});

// ── Boot script — apply pin state BEFORE first paint ───────────

test('index.html restores pin state in <head> BEFORE body paints', () => {
  // REGRESSION GUARD (2026-05-04, pin-sidebar-csp-blocked audit followup):
  // the boot logic MUST live in an external file. Inline <script> blocks
  // in index.html are silently blocked by the meta CSP `script-src
  // 'self'` (no 'unsafe-inline'). External files referenced via src=
  // satisfy 'self'.
  const headMatch = indexHtml.match(/<head>[\s\S]*?<\/head>/);
  assert.ok(headMatch, '<head> region must exist');
  const headSrc = headMatch[0];
  assert.match(headSrc, /<script\s+src="boot-pin\.js"/,
    'index.html must reference boot-pin.js via <script src> — inline <script> is CSP-blocked');
  // Negative guard: the pin logic must NOT be in any inline <script>
  // block in <head>. (The pre-existing theme-restore inline IIFE has
  // its own separate concern and is allowed to remain — its
  // semantics are theme-related, not pin-related, and replacing it
  // is out of scope for this audit fix.)
  const inlineScripts = headSrc.match(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g) || [];
  for (const script of inlineScripts) {
    assert.ok(!script.includes('merlin.sidebar-pin.'),
      'pin logic must NOT be in an inline <script> in <head> — CSP blocks it. Move to boot-pin.js.');
  }
});

test('boot-pin.js enforces mutual exclusivity (only one sidebar pinned at a time)', () => {
  const bootPinPath = path.join(__dirname, 'boot-pin.js');
  assert.ok(fs.existsSync(bootPinPath), 'app/boot-pin.js must exist');
  const bootPinSrc = fs.readFileSync(bootPinPath, 'utf8');
  assert.match(bootPinSrc, /merlin\.sidebar-pin\./,
    'boot-pin.js must read the merlin.sidebar-pin.* localStorage keys');
  assert.match(bootPinSrc, /data-pinned-sidebar/,
    'boot-pin.js must set data-pinned-sidebar on documentElement so the CSS first-paint rule applies');
  // The break statement after the first stored=true match prevents the
  // boot script from setting data-pinned-sidebar twice. This mirrors
  // the runtime mutual-exclusivity in setSidebarPinned (renderer.js).
  assert.match(bootPinSrc, /break;\s*\/\/\s*only one sidebar pinned at a time/,
    'boot-pin.js must `break` after honoring the first stored pin to avoid setting data-pinned-sidebar twice');
});

// ── CSS — chat reflow when a sidebar is pinned ─────────────────

test('style.css shrinks chat by 340px when a sidebar is pinned', () => {
  // Both selector forms (html[data-pinned-sidebar=...] for first paint,
  // body.has-pinned-...-sidebar for runtime) must shrink #chat,
  // #input-bar, AND #chat-status. Any selector missed = layout
  // misaligned (e.g. input bar overflows the pinned sidebar).
  for (const required of [
    /html\[data-pinned-sidebar="archive"\]\s+#chat/,
    /html\[data-pinned-sidebar="archive"\]\s+#input-bar/,
    /html\[data-pinned-sidebar="archive"\]\s+#chat-status/,
    /body\.has-pinned-archive-sidebar\s+#chat/,
    /body\.has-pinned-archive-sidebar\s+#input-bar/,
    /body\.has-pinned-archive-sidebar\s+#chat-status/,
    /html\[data-pinned-sidebar="magic"\]\s+#chat/,
    /body\.has-pinned-magic-sidebar\s+#chat/,
  ]) {
    assert.match(styleCss, required,
      `style.css must include selector matching ${required}`);
  }
  // The shrink amount must be 340px — matches .magic-panel +
  // .archive-panel width. Any other value misaligns the chat.
  assert.match(styleCss, /margin-right:340px/,
    'pinned-sidebar selectors must use margin-right:340px (matches sidebar width)');
});

test('style.css declares smooth transition on the chat margin', () => {
  // Without the transition, pinning/unpinning snaps the chat width
  // instantly while the sidebar slides — visual jank. The transition
  // matches the sidebar's own transform timing (.25s cubic-bezier).
  assert.match(styleCss, /#chat,#input-bar,#chat-status\{transition:margin-right/,
    'chat + input + status must transition margin-right so the reflow animates with the sidebar slide');
});

// ── JS — runtime helpers + persistence + restore ───────────────

test('renderer.js declares setSidebarPinned with persistence + body class wiring', () => {
  assert.match(rendererSrc, /function\s+setSidebarPinned\s*\(\s*id\s*,\s*pinned\s*\)/,
    'setSidebarPinned(id, pinned) is the single entry point for runtime pin toggling');
  assert.match(rendererSrc, /SIDEBAR_PIN_KEY_PREFIX\s*=\s*['"]merlin\.sidebar-pin\./,
    'localStorage key prefix must match the boot-script key shape ("merlin.sidebar-pin.<id>")');
  assert.match(rendererSrc, /SIDEBAR_BODY_CLASS_PREFIX\s*=\s*['"]has-pinned-/,
    'body class prefix must match the CSS rule shape ("has-pinned-<id>-sidebar")');
});

test('setSidebarPinned enforces mutual exclusivity (unpin the other on pin)', () => {
  const fnIdx = rendererSrc.indexOf('function setSidebarPinned');
  assert.ok(fnIdx > 0, 'setSidebarPinned must exist');
  const fnBody = rendererSrc.slice(fnIdx, fnIdx + 1500);
  assert.match(fnBody, /Mutual exclusivity/,
    'setSidebarPinned body must carry the mutual-exclusivity comment anchor');
  assert.match(fnBody, /for\s*\(\s*(?:const|let|var)\s+other/,
    'setSidebarPinned must iterate the OTHER sidebar IDs and unpin them when pinning one');
});

test('renderer.js restores pin state on launch (mirrors the boot script)', () => {
  // The boot script in <head> handles first-paint by setting
  // data-pinned-sidebar on documentElement. Renderer.js's restore loop
  // promotes that to the body class + opens the panel + flips the pin
  // button aria-pressed. Both must run on every launch so the runtime
  // state is consistent.
  assert.match(rendererSrc, /Restore pin state on launch/,
    'restore-on-launch comment anchor must be present so the loop is grep-able');
  assert.match(rendererSrc, /panel\.classList\.remove\(['"]hidden['"]\)/,
    'restore loop must un-hide the panel that was pinned at last shutdown');
});

test('renderer.js sidebar-close handlers unpin implicitly', () => {
  // Without this, closing a sidebar leaves the body class set and the
  // chat reflow reserves 340px for an empty void. Both magic-close
  // and archive-close MUST call setSidebarPinned(id, false).
  const magicCloseIdx = rendererSrc.indexOf("document.getElementById('magic-close')");
  assert.ok(magicCloseIdx > 0, 'magic-close handler must exist');
  const magicRegion = rendererSrc.slice(magicCloseIdx, magicCloseIdx + 600);
  assert.match(magicRegion, /setSidebarPinned\(['"]magic['"],\s*false\)/,
    'magic-close handler MUST call setSidebarPinned("magic", false) so the body class clears when the panel hides');
  const archiveCloseIdx = rendererSrc.indexOf("document.getElementById('archive-close')");
  assert.ok(archiveCloseIdx > 0, 'archive-close handler must exist');
  const archiveRegion = rendererSrc.slice(archiveCloseIdx, archiveCloseIdx + 600);
  assert.match(archiveRegion, /setSidebarPinned\(['"]archive['"],\s*false\)/,
    'archive-close handler MUST call setSidebarPinned("archive", false)');
});

test('REGRESSION GUARD comment anchors the pin-sidebar feature', () => {
  assert.match(rendererSrc, /pin-sidebar feature/,
    'renderer.js must carry a "pin-sidebar feature" REGRESSION GUARD anchor for grep-ability');
});

// ── Audit-followup pins (2026-05-04) ─────────────────────────────

test('setSidebarPinned(false) clears the html data-pinned-sidebar attr', () => {
  // REGRESSION GUARD (2026-05-04, audit followup — stale-html-attr-leak):
  // pre-fix the data-attr was set by the boot script and never touched
  // again at runtime. Unpinning a sidebar removed the body class but left
  // <html data-pinned-sidebar="..."> set, and the CSS rule kept the
  // chat shrunk to a 340px void on the right.
  const fnIdx = rendererSrc.indexOf('function setSidebarPinned');
  assert.ok(fnIdx > 0, 'setSidebarPinned must exist');
  const fnBody = rendererSrc.slice(fnIdx, fnIdx + 2500);
  assert.match(fnBody, /removeAttribute\(\s*['"]data-pinned-sidebar['"]\s*\)/,
    'setSidebarPinned MUST removeAttribute("data-pinned-sidebar") on the unpin path so the html attr clears in step with the body class');
  // Identity guard: only clear the attr if it currently matches THIS id —
  // otherwise the mutual-exclusivity unpin path (where one sidebar's
  // unpin runs alongside the other's pin) would clobber the new pin.
  assert.match(fnBody, /getAttribute\(\s*['"]data-pinned-sidebar['"]\s*\)\s*===\s*id/,
    'setSidebarPinned MUST identity-check the attr before clearing — without this, mid-mutual-exclusivity unpin could clobber the new pin');
});
