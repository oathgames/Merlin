// Tests for spellbook.js — the extracted pure renderer for the Spellbook
// panel. These tests stand up a minimal DOM shim (enough for
// createElement + appendChild + classList + addEventListener) so we can
// verify the rendered structure without spinning up jsdom or Electron.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ─────────────────────────────────────────────────────────────────────
// Tiny DOM shim. Just enough to exercise buildTemplateRow and
// renderSpellbook — do not mistake this for a full spec implementation.
// ─────────────────────────────────────────────────────────────────────

function makeElement(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    children: [],
    childNodes: [],
    _listeners: {},
    classList: {
      _set: new Set(),
      add(...c) { for (const x of c) this._set.add(x); },
      remove(...c) { for (const x of c) this._set.delete(x); },
      contains(c) { return this._set.has(c); },
      toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
    },
    dataset: {},
    attributes: {},
    _innerHTML: '',
    _textContent: '',
    get className() { return Array.from(this.classList._set).join(' '); },
    set className(v) {
      this.classList._set = new Set(String(v || '').split(/\s+/).filter(Boolean));
    },
    set innerHTML(v) {
      this._innerHTML = v;
      // Best-effort "children by class name" for the test. We don't need
      // full parsing — only the test assertions matter.
    },
    get innerHTML() { return this._innerHTML; },
    set textContent(v) { this._textContent = String(v); },
    get textContent() {
      if (this._textContent) return this._textContent;
      // Derive from innerHTML (strip tags)
      return this._innerHTML.replace(/<[^>]+>/g, '');
    },
    appendChild(child) {
      this.children.push(child);
      this.childNodes.push(child);
      return child;
    },
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    dispatchEvent(type) {
      for (const fn of (this._listeners[type] || [])) fn();
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
  };
  return el;
}

function installDomGlobals() {
  const elements = {}; // by id
  global.document = {
    createElement: (tag) => makeElement(tag),
    getElementById(id) { return elements[id] || null; },
    _register(id, el) { elements[id] = el; },
  };
}

installDomGlobals();

const { SPELLS, MORNING_BRIEFING_PRESET, renderSpellbook, toggleSpellbook, buildTemplateRow } = require('./spellbook');

// ─────────────────────────────────────────────────────────────────────
// SPELLS constant shape.
// ─────────────────────────────────────────────────────────────────────

test('SPELLS constant has the expected shape for every template', () => {
  assert.ok(Array.isArray(SPELLS));
  assert.ok(SPELLS.length >= 5, 'expected at least 5 preloaded spells');
  for (const s of SPELLS) {
    assert.ok(typeof s.spell === 'string' && s.spell.length > 0, `missing spell id: ${JSON.stringify(s)}`);
    assert.ok(typeof s.cron === 'string' && /^[\d*\/,\-]+(\s+[\d*\/,\-]+){4}$/.test(s.cron),
      `bad cron on ${s.spell}: ${s.cron}`);
    assert.ok(typeof s.name === 'string' && s.name.length > 0);
    assert.ok(typeof s.desc === 'string' && s.desc.length > 0);
    assert.ok(typeof s.prompt === 'string' && s.prompt.length > 0);
  }
});

test('SPELLS contains the Morning Briefing preset', () => {
  const mb = SPELLS.find(s => s.spell === 'morning-briefing');
  assert.ok(mb, 'morning-briefing preset missing from SPELLS');
  assert.equal(mb.name, MORNING_BRIEFING_PRESET.name);
});

test('SPELLS entries have unique IDs', () => {
  const ids = SPELLS.map(s => s.spell);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, `duplicate spell IDs: ${ids.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────
// buildTemplateRow + renderSpellbook DOM output.
// ─────────────────────────────────────────────────────────────────────

test('buildTemplateRow produces a row with expected class and inner HTML', () => {
  const row = buildTemplateRow(SPELLS[0], () => {});
  assert.ok(row.classList.contains('spell-row'));
  assert.ok(row.classList.contains('spell-row-template'));
  assert.match(row.innerHTML, /spell-dot/);
  assert.match(row.innerHTML, /spell-info/);
  assert.match(row.innerHTML, new RegExp(SPELLS[0].name));
});

test('buildTemplateRow stores the spell id on dataset', () => {
  const row = buildTemplateRow(SPELLS[0], () => {});
  assert.equal(row.dataset.spell, SPELLS[0].spell);
});

test('buildTemplateRow click fires onSpellClick with the template', () => {
  let captured = null;
  const row = buildTemplateRow(SPELLS[0], (t) => { captured = t; });
  row.dispatchEvent('click');
  assert.equal(captured, SPELLS[0]);
});

test('renderSpellbook appends one row per spell', () => {
  const container = makeElement('div');
  const rows = renderSpellbook(container, SPELLS, () => {});
  assert.equal(rows.length, SPELLS.length);
  assert.equal(container.children.length, SPELLS.length);
});

test('renderSpellbook renders an empty-state when the list is empty', () => {
  const container = makeElement('div');
  const rows = renderSpellbook(container, [], () => {});
  assert.equal(rows.length, 0);
  assert.equal(container.children.length, 1);
  assert.ok(container.children[0].classList.contains('spellbook-empty'));
});

test('renderSpellbook accepts non-array input gracefully (treats as empty)', () => {
  const container = makeElement('div');
  const rows = renderSpellbook(container, null, () => {});
  assert.equal(rows.length, 0);
  assert.equal(container.children.length, 1);
});

test('renderSpellbook throws when given no container', () => {
  assert.throws(() => renderSpellbook(null, SPELLS, () => {}),
    /container must be a DOM node/);
});

test('renderSpellbook click on a rendered row fires onSpellClick with the right template', () => {
  const container = makeElement('div');
  const captured = [];
  const rows = renderSpellbook(container, SPELLS, (t) => captured.push(t));
  // Click the second row.
  rows[1].dispatchEvent('click');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].spell, SPELLS[1].spell);
});

// ─────────────────────────────────────────────────────────────────────
// toggleSpellbook visibility wiring.
// ─────────────────────────────────────────────────────────────────────

test('toggleSpellbook hides and shows the #magic-panel', () => {
  const panel = makeElement('div');
  panel.classList.add('hidden'); // starts hidden
  global.document._register('magic-panel', panel);
  const shown = toggleSpellbook(true);
  assert.equal(shown, true);
  assert.equal(panel.classList.contains('hidden'), false);
  const hidden = toggleSpellbook(false);
  assert.equal(hidden, false);
  assert.equal(panel.classList.contains('hidden'), true);
});

test('toggleSpellbook returns false when the panel is missing', () => {
  global.document._register('magic-panel', null);
  assert.equal(toggleSpellbook(true), false);
});

// ─────────────────────────────────────────────────────────────────────
// Behavior preservation — the SPELLS prompt texts must not embed any
// obviously-broken characters (this would regress if someone smart-
// quoted the strings during a copy-paste).
// ─────────────────────────────────────────────────────────────────────

test('SPELLS prompts contain only printable text', () => {
  for (const s of SPELLS) {
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\x00-\x08\x0b-\x1f]/.test(s.prompt),
      `${s.spell} prompt has control chars`);
  }
});
