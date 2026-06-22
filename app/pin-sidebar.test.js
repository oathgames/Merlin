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

test('style.css reserves 340px on body when a sidebar is pinned', () => {
  // REGRESSION GUARD (2026-05-05, pin-sidebar bugfix — input-bar-centering):
  //
  // The fix changes the layout strategy from "margin-right:340px on
  // every centered child" to "padding-right:340px on body". The
  // previous approach left `margin-left:auto` intact on `#input-bar`
  // (which has `max-width:752px; margin:0 auto;` for centered single-
  // column layout), so adding `margin-right:340px` right-aligned the
  // bar against the sidebar instead of centering it within the visible
  // chat area.
  //
  // padding-right on body shrinks the content area for ALL flex-column
  // children — chat, input-bar, chat-status all get the same reduced
  // parent width, and their own `margin: 0 auto` correctly recenters.
  // The titlebar is exempted via `margin-right:-340px` so its window
  // controls stay at the absolute window-right edge.
  //
  // Both selector forms (html[data-pinned-sidebar=...] for first paint,
  // body.has-pinned-...-sidebar for runtime) must apply.
  for (const required of [
    /html\[data-pinned-sidebar="archive"\]\s+body/,
    /html\[data-pinned-sidebar="magic"\]\s+body/,
    /body\.has-pinned-archive-sidebar/,
    /body\.has-pinned-magic-sidebar/,
  ]) {
    assert.match(styleCss, required,
      `style.css must include selector matching ${required} for the pinned-sidebar body padding rule`);
  }
  assert.match(styleCss, /padding-right:340px/,
    'pinned-sidebar selectors must use padding-right:340px on body (matches sidebar width)');
});

test('style.css restores titlebar to full width when sidebar is pinned', () => {
  // The window controls (theme/wisdom/archive/magic/min/max/close) live
  // in #titlebar and must stay at the absolute right edge of the window
  // — even when the body has padding-right:340px reserving space below
  // for the pinned sidebar. Negative margin-right cancels the body's
  // padding for the titlebar specifically. Sidebars start at top:40px
  // (below the 40px titlebar) so there's no visual conflict.
  for (const required of [
    /html\[data-pinned-sidebar="archive"\]\s+#titlebar/,
    /html\[data-pinned-sidebar="magic"\]\s+#titlebar/,
    /body\.has-pinned-archive-sidebar\s+#titlebar/,
    /body\.has-pinned-magic-sidebar\s+#titlebar/,
  ]) {
    assert.match(styleCss, required,
      `style.css must include selector matching ${required} so the titlebar stays full-width when pinned`);
  }
  assert.match(styleCss, /#titlebar\{margin-right:-340px\}/,
    'titlebar pinned-state rule must use margin-right:-340px to negate the body padding');
});

test('style.css declares smooth transition on body padding + titlebar margin', () => {
  // Without the transition, pinning/unpinning snaps the layout
  // instantly while the sidebar slides — visual jank. The transition
  // matches the sidebar's own transform timing (.25s cubic-bezier).
  assert.match(styleCss, /body\{transition:padding-right/,
    'body must transition padding-right so the chat reflow animates with the sidebar slide');
  assert.match(styleCss, /#titlebar\{transition:margin-right/,
    '#titlebar must transition margin-right so its width-restore glides in step with the body padding');
});

test('style.css does NOT use the legacy per-element margin-right approach', () => {
  // REGRESSION GUARD (2026-05-05, pin-sidebar bugfix — input-bar-centering):
  // The legacy approach assigned `margin-right:340px` to #chat,
  // #input-bar, and #chat-status individually. For #input-bar and
  // #chat-status — which use `margin: 0 auto` for centering — this
  // right-aligned them against the sidebar instead of centering within
  // the visible chat area. We now drive the layout from body padding.
  //
  // If a future refactor re-introduces `body.has-pinned-* #input-bar
  // {margin-right:340px}`, this test fails — pointing the author back
  // to the padding-on-body approach.
  const legacyPatterns = [
    /body\.has-pinned-(?:magic|archive)-sidebar\s+#input-bar\s*\{[^}]*margin-right:\s*340px/,
    /body\.has-pinned-(?:magic|archive)-sidebar\s+#chat-status\s*\{[^}]*margin-right:\s*340px/,
    /html\[data-pinned-sidebar="(?:magic|archive)"\]\s+#input-bar\s*\{[^}]*margin-right:\s*340px/,
    /html\[data-pinned-sidebar="(?:magic|archive)"\]\s+#chat-status\s*\{[^}]*margin-right:\s*340px/,
  ];
  for (const pattern of legacyPatterns) {
    assert.doesNotMatch(styleCss, pattern,
      `style.css must NOT use the legacy "margin-right:340px on centered children" approach — it fights with margin:0 auto and right-aligns the input bar. Use padding-right on body instead. Pattern: ${pattern}`);
  }
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

// ── 2026-05-05 bugfix: click-outside + cross-panel hides respect pin ───

test('magic-panel click-outside handler bails when sidebar is pinned', () => {
  // REGRESSION GUARD (2026-05-05, pin-sidebar bugfix — click-outside-leak):
  //
  // Pre-fix, every click on the chat transcript or any UI outside the
  // magic panel hid it instantly — even when the user had explicitly
  // pinned it. The pin button became cosmetic. Worse, hiding the panel
  // without clearing the body class left the chat reflowed around an
  // invisible 340px void.
  //
  // Find the click-outside handler region: the "Close panel on any
  // outside click" comment is the single grep anchor. The handler MUST
  // bail (return early) when `body.has-pinned-magic-sidebar` is set.
  const anchorIdx = rendererSrc.indexOf('Close panel on any outside click');
  assert.ok(anchorIdx > 0, 'magic-panel click-outside anchor comment must exist');
  // Take a generous slice — the handler is ~25 lines after the anchor.
  const region = rendererSrc.slice(anchorIdx, anchorIdx + 1800);
  assert.match(region, /classList\.contains\(['"]has-pinned-magic-sidebar['"]\)/,
    'magic-panel click-outside handler MUST check body.classList.contains("has-pinned-magic-sidebar") and bail before hiding');
  // The bail must be a return (early exit) BEFORE the panel.add('hidden')
  // call. Source-scan: the pinned-check must appear before the final
  // panel.classList.add('hidden') in the handler body.
  const pinnedCheckIdx = region.search(/classList\.contains\(['"]has-pinned-magic-sidebar['"]\)/);
  const hideCallIdx = region.search(/panel\.classList\.add\(['"]hidden['"]\)/);
  assert.ok(pinnedCheckIdx > 0 && hideCallIdx > 0,
    'click-outside handler must contain both the pinned-check and the hide call');
  assert.ok(pinnedCheckIdx < hideCallIdx,
    'pinned-check MUST run BEFORE the hide call — otherwise the panel hides regardless of pin state');
});

test('magic-panel Escape handler bails when sidebar is pinned', () => {
  // REGRESSION GUARD (2026-05-05, pin-sidebar bugfix — escape-dismisses-pin):
  //
  // Symmetric with the click-outside handler. Escape is a frequent
  // accidental press (often after closing a modal) and would silently
  // undo the user's pin commitment. Pinned panels stay open — the pin
  // button is the only way to dismiss.
  const anchorIdx = rendererSrc.indexOf('Escape closes the Magic panel');
  assert.ok(anchorIdx > 0, 'Escape handler anchor comment must exist');
  const region = rendererSrc.slice(anchorIdx, anchorIdx + 1500);
  assert.match(region, /classList\.contains\(['"]has-pinned-magic-sidebar['"]\)/,
    'magic-panel Escape handler MUST check body.classList.contains("has-pinned-magic-sidebar") and bail before hiding');
});

test('archive-panel click-outside handler bails when sidebar is pinned', () => {
  // REGRESSION GUARD (2026-05-05, pin-sidebar bugfix — archive-click-outside):
  // Mirrors the magic-panel handler. Archive's click-outside is more
  // narrow (it only fires on chat-transcript clicks), but the same
  // dismissal-leak applied — the pin button was cosmetic.
  const anchorIdx = rendererSrc.indexOf('Close archive when clicking into the chat transcript');
  assert.ok(anchorIdx > 0, 'archive-panel click-outside anchor comment must exist');
  const region = rendererSrc.slice(anchorIdx, anchorIdx + 1800);
  assert.match(region, /classList\.contains\(['"]has-pinned-archive-sidebar['"]\)/,
    'archive-panel click-outside handler MUST check body.classList.contains("has-pinned-archive-sidebar") and bail before hiding');
  const pinnedCheckIdx = region.search(/classList\.contains\(['"]has-pinned-archive-sidebar['"]\)/);
  const hideCallIdx = region.search(/panel\.classList\.add\(['"]hidden['"]\)/);
  assert.ok(pinnedCheckIdx > 0 && hideCallIdx > 0,
    'archive click-outside handler must contain both the pinned-check and the hide call');
  assert.ok(pinnedCheckIdx < hideCallIdx,
    'pinned-check MUST run BEFORE the hide call');
});

test('hideSidebarPanel helper exists + clears pin state in lockstep', () => {
  // REGRESSION GUARD (2026-05-05, pin-sidebar bugfix — pin-state-leak):
  //
  // The helper is the ONLY safe way to hide a sidebar panel from
  // miscellaneous code paths (custom-spell click, sendChatFromPanel,
  // showFirstRunPrompt, agency-overlay open, ad context-menu pause/
  // resume, archive merge-to-chat). Direct calls to
  // `panel.classList.add('hidden')` are review blockers because they
  // leave the `body.has-pinned-*-sidebar` class set, reflowing the
  // chat around an invisible 340px reservation.
  assert.match(rendererSrc, /function\s+hideSidebarPanel\s*\(\s*id\s*\)/,
    'hideSidebarPanel(id) helper must exist as the safe path for ad-hoc panel hides');
  // The helper body must call setSidebarPinned(id, false) in addition
  // to hiding the panel — that's the whole point.
  const fnIdx = rendererSrc.indexOf('function hideSidebarPanel');
  assert.ok(fnIdx > 0);
  const fnBody = rendererSrc.slice(fnIdx, fnIdx + 600);
  assert.match(fnBody, /classList\.add\(\s*['"]hidden['"]\s*\)/,
    'hideSidebarPanel must hide the panel');
  assert.match(fnBody, /setSidebarPinned\(\s*id\s*,\s*false\s*\)/,
    'hideSidebarPanel MUST call setSidebarPinned(id, false) so the body class clears in lockstep with the panel hiding');
});

test('every inline magic/archive panel hide is paired with setSidebarPinned(false)', () => {
  // REGRESSION GUARD (2026-05-05, pin-sidebar bugfix — pin-state-leak):
  //
  // Source-scan: every line that hides a sidebar panel directly
  // (without going through hideSidebarPanel) MUST be followed within
  // a small window by a setSidebarPinned(id, false) call. This catches
  // a future refactor that adds a new sidebar-hide path and forgets
  // to clear pin state.
  //
  // Bypass exception: setSidebarPinned itself doesn't hide the panel
  // (it only manages pin state) — the regex below targets ONLY the
  // `getElementById('<id>-panel').classList.add('hidden')` shape.
  const lines = rendererSrc.split('\n');
  const offendingHides = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/getElementById\(['"](magic|archive)-panel['"]\)\.classList\.add\(['"]hidden['"]\)/);
    if (!match) continue;
    const id = match[1];
    // Look ahead 6 lines for the paired setSidebarPinned(id, false).
    // Six lines is the empirical max distance across the current
    // codebase; tighter than 10 to keep the pairing visually obvious.
    const window = lines.slice(i, i + 6).join('\n');
    const pairRegex = new RegExp(`setSidebarPinned\\(\\s*['"]${id}['"]\\s*,\\s*false\\s*\\)`);
    if (!pairRegex.test(window)) {
      offendingHides.push(`line ${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepStrictEqual(offendingHides, [],
    'every inline `getElementById("<id>-panel").classList.add("hidden")` must be paired with setSidebarPinned("<id>", false) within 6 lines, OR be replaced with hideSidebarPanel(id). Offenders:\n  ' + offendingHides.join('\n  '));
});

test('cross-panel buttons clear the OTHER sidebar pin when force-hiding it', () => {
  // REGRESSION GUARD (2026-05-05, pin-sidebar bugfix; updated 2026-06-22 RSI):
  //
  // Force-hiding a sibling sidebar must ALSO clear its pin, else the chat stays
  // reflowed around an invisible sidebar. The per-handler setSidebarPinned calls
  // were centralized into closeOtherOverlays -> hideSidebarPanel (which clears
  // the pin). Assert (a) every opener delegates to closeOtherOverlays, (b) the
  // helper force-hides both sidebars via hideSidebarPanel, and (c)
  // hideSidebarPanel clears the pin. The invariant is preserved, now in one place.
  for (const [btn, keep] of [['magic-btn', 'magic-panel'], ['archive-btn', 'archive-panel'], ['wisdom-header-btn', 'wisdom-overlay']]) {
    const idx = rendererSrc.indexOf(`getElementById('${btn}').addEventListener`);
    assert.ok(idx > 0, `${btn} click handler must exist`);
    const region = rendererSrc.slice(idx, idx + 2500);
    assert.ok(region.includes(`closeOtherOverlays('${keep}')`),
      `${btn} handler MUST delegate sibling-hiding to closeOtherOverlays('${keep}')`);
  }

  const cooIdx = rendererSrc.indexOf('function closeOtherOverlays(');
  assert.ok(cooIdx > 0, 'closeOtherOverlays must exist');
  const cooRegion = rendererSrc.slice(cooIdx, cooIdx + 900);
  assert.match(cooRegion, /hideSidebarPanel\('magic'\)/, 'closeOtherOverlays must force-hide the magic sidebar');
  assert.match(cooRegion, /hideSidebarPanel\('archive'\)/, 'closeOtherOverlays must force-hide the archive sidebar');

  const hspIdx = rendererSrc.indexOf('function hideSidebarPanel(');
  assert.ok(hspIdx > 0, 'hideSidebarPanel must exist');
  const hspRegion = rendererSrc.slice(hspIdx, hspIdx + 300);
  assert.match(hspRegion, /setSidebarPinned\(\s*id\s*,\s*false\s*\)/,
    'hideSidebarPanel MUST clear the pin when hiding a sidebar (the cross-panel-hide invariant)');
});
