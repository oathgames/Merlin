// takeover-consistency.test.js — REGRESSION GUARD (2026-07-03, UI
// consistency pass). Every full-page takeover (Truesight, Palantir,
// Archive, Brand switcher) shares ONE header geometry via the
// .takeover-topbar class; per-panel classes carry accents only. The
// Archive is a full-frame takeover like the rest — never again a docked
// sidebar with its own width/pin/expand.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function ruleBlock(selector) {
  const i = CSS.indexOf(selector + ' {');
  assert.ok(i >= 0, `rule not found: ${selector}`);
  return CSS.slice(i, CSS.indexOf('}', i));
}

test('shared .takeover-topbar owns the geometry (single source of header height)', () => {
  const block = ruleBlock('.takeover-topbar');
  assert.ok(/padding: 10px 24px/.test(block), 'shared padding');
  assert.ok(/min-height: 48px/.test(block), 'shared min-height');
  assert.ok(/flex-shrink: 0/.test(block), 'topbar must not compress');
});

test('every takeover topbar uses the shared class in index.html', () => {
  for (const cls of ['truesight-topbar', 'palantir-topbar', 'archive-topbar', 'brand-switcher-topbar']) {
    const re = new RegExp(`class="takeover-topbar ${cls}"`);
    assert.ok(re.test(HTML), `${cls} must be declared as "takeover-topbar ${cls}"`);
  }
});

test('per-panel topbar rules carry accents only, never their own geometry', () => {
  for (const sel of ['.truesight-topbar', '.palantir-topbar', '.archive-topbar', '.brand-switcher-topbar']) {
    const block = ruleBlock(sel);
    for (const banned of ['padding', 'min-height', 'display: flex', 'flex-shrink']) {
      assert.ok(!block.includes(banned),
        `${sel} must not set "${banned}" — geometry lives ONLY in .takeover-topbar (height-drift regression)`);
    }
  }
});

test('archive panel is a full-frame takeover (no sidebar geometry, no slide)', () => {
  const block = ruleBlock('.archive-panel');
  assert.ok(/top: 40px; left: 0; right: 0; bottom: 0/.test(block),
    'archive panel must span the full frame under the titlebar');
  assert.ok(!/width: 340px/.test(block), 'no fixed sidebar width');
  assert.ok(!/translateX/.test(block), 'no slide-in transform (takeovers toggle display)');
  assert.ok(/display: flex/.test(block), 'flex column layout retained');
  assert.ok(!/\.archive-panel\.expanded/.test(CSS), 'the .expanded variant is gone (always full width)');
});

test('archive grid defaults to the wide auto-fill layout', () => {
  const block = ruleBlock('.archive-grid');
  assert.ok(/repeat\(auto-fill, minmax\(160px, 1fr\)\)/.test(block),
    'full-width takeover grid must be the default (was the .expanded variant)');
});
