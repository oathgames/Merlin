// scrollbar-theme.test.js — REGRESSION GUARD (2026-06-30, scrollbar-theme sweep)
//
// Every full-window panel scroll container must use ONLY the themed 5px webkit
// convention (::-webkit-scrollbar width:5px / thumb var(--hover-8) / transparent
// track — same as #chat and .truesight-scroll). Two failure modes locked:
//  - OS scrollbar showing through (no ::-webkit-scrollbar rule at all).
//  - dual-mechanism drift: setting scrollbar-width/scrollbar-color on the SAME
//    element shadows the webkit rules in Chromium 121+ (Electron 41), rendering
//    a wider bar that doesn't match the rest of the app.
//
// Pure source-scan of style.css.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');

// Full-window panel scroll containers that must carry the 5px webkit convention.
const THEMED = [
  '.magic-panel-scroll',
  '.wisdom-scroll',
  '.palantir-scroll',
  '.brand-switcher-scroll',
  '.archive-panel-scroll',
  '.palantir-detail-card',
  '.activity-raw pre',
  '#agency-brands',
  '.truesight-scroll', // the reference the user asked us to match
];

for (const sel of THEMED) {
  test(`${sel} has the 5px themed webkit scrollbar`, () => {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '::-webkit-scrollbar\\s*\\{\\s*width:\\s*5px');
    assert.ok(re.test(CSS), `${sel} must declare ::-webkit-scrollbar { width: 5px }`);
  });
}

test('no full-window panel scroll container also sets scrollbar-width/color (dual-mechanism drift)', () => {
  // These five were normalized off the standard props; assert their rule blocks
  // no longer contain scrollbar-width/scrollbar-color (which would shadow webkit).
  const normalized = ['.magic-panel-scroll', '.wisdom-scroll', '.palantir-scroll', '.brand-switcher-scroll', '.archive-panel-scroll'];
  for (const sel of normalized) {
    const start = CSS.indexOf(sel + ' {') >= 0 ? CSS.indexOf(sel + ' {') : CSS.indexOf(sel + '{');
    assert.ok(start >= 0, `${sel} rule not found`);
    const block = CSS.slice(start, CSS.indexOf('}', start));
    assert.ok(!/scrollbar-width/.test(block),
      `${sel} must not set scrollbar-width (shadows the webkit 5px rule in Chromium 121+)`);
    assert.ok(!/scrollbar-color/.test(block),
      `${sel} must not set scrollbar-color`);
  }
});
