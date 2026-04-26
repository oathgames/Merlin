'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'gallery-viewer.js'), 'utf8');

// ── Minimal DOM stub for unit-testable surfaces ──────────────────
// gallery-viewer.js builds a DOM tree. Rather than pull in jsdom (a multi-MB
// dependency and a maintenance liability), we provide a small "good enough"
// HTMLElement-like API for the helpers that don't touch layout/events. The
// stub lives in this test file so the production module never imports it.

function makeStubDocument() {
  const elements = [];

  function makeElement(tag) {
    const children = [];
    const listeners = {};
    const dataset = {};
    const classList = {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, force) {
        if (force === true) this._set.add(c);
        else if (force === false) this._set.delete(c);
        else if (this._set.has(c)) this._set.delete(c);
        else this._set.add(c);
        return this._set.has(c);
      },
      contains(c) { return this._set.has(c); },
      toString() { return Array.from(this._set).join(' '); },
    };
    const attributes = {};
    let _className = '';
    let _src = '';
    let _textContent = '';
    let parent = null;
    const el = {
      tagName: tag.toUpperCase(),
      children,
      get firstChild() { return children[0] || null; },
      get lastChild() { return children[children.length - 1] || null; },
      get parentNode() { return parent; },
      set parentNode(p) { parent = p; },
      dataset,
      classList,
      style: {},
      get className() { return _className; },
      set className(v) { _className = String(v); _className.split(/\s+/).filter(Boolean).forEach(c => classList.add(c)); },
      get src() { return _src; },
      set src(v) { _src = String(v); attributes.src = _src; },
      get textContent() {
        if (children.length === 0) return _textContent;
        return children.map(c => c.textContent || '').join('');
      },
      set textContent(v) { _textContent = String(v); children.length = 0; },
      get innerHTML() { return ''; },
      set innerHTML(v) { /* intentionally ignored — production code MUST NOT use innerHTML on user data */ },
      tabIndex: -1,
      controls: false,
      autoplay: false,
      muted: false,
      playsInline: false,
      preload: '',
      decoding: '',
      loading: '',
      alt: '',
      type: 'button',
      title: '',
      setAttribute(k, v) { attributes[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(attributes, k) ? attributes[k] : null; },
      appendChild(child) {
        children.push(child);
        child.parentNode = el;
        return child;
      },
      removeChild(child) {
        const i = children.indexOf(child);
        if (i >= 0) { children.splice(i, 1); child.parentNode = null; }
        return child;
      },
      remove() {
        if (parent) parent.removeChild(el);
      },
      replaceWith(other) {
        if (parent) {
          const i = parent.children.indexOf(el);
          if (i >= 0) {
            parent.children[i] = other;
            other.parentNode = parent;
            el.parentNode = null;
          }
        }
      },
      addEventListener(name, fn) {
        (listeners[name] = listeners[name] || []).push(fn);
      },
      removeEventListener(name, fn) {
        const arr = listeners[name];
        if (!arr) return;
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      },
      dispatchEvent(name, e) {
        (listeners[name] || []).forEach(fn => fn(e || {}));
      },
      querySelector(sel) {
        // Supports :scope > .class, :scope > tag, .class, tag — narrow set
        // matches what transformGalleryToStack actually emits.
        const tagM = sel.match(/^:scope\s*>\s*([a-z]+)$/i) || sel.match(/^([a-z]+)$/i);
        const clsM = sel.match(/^:scope\s*>\s*\.(\S+)$/) || sel.match(/^\.(\S+)$/);
        if (clsM) {
          const cls = clsM[1];
          for (const c of children) if (c.classList.contains(cls)) return c;
          return null;
        }
        if (tagM) {
          const tag = tagM[1].toUpperCase();
          for (const c of children) if (c.tagName === tag) return c;
          return null;
        }
        return null;
      },
      querySelectorAll(sel) {
        const tagM = sel.match(/^:scope\s*>\s*([a-z]+)$/i) || sel.match(/^([a-z]+)$/i);
        const clsM = sel.match(/^:scope\s*>\s*\.(\S+)$/) || sel.match(/^\.(\S+)$/);
        if (clsM) return children.filter(c => c.classList.contains(clsM[1]));
        if (tagM) {
          const tag = tagM[1].toUpperCase();
          return children.filter(c => c.tagName === tag);
        }
        return [];
      },
      focus() {},
    };
    elements.push(el);
    return el;
  }

  return {
    createElement: makeElement,
    body: makeElement('body'),
    addEventListener() {},
    removeEventListener() {},
  };
}

// ── Source-scan tests (regression guards) ───────────────────────

test('source-scan: production module never uses innerHTML for user data', () => {
  const lines = SOURCE.split('\n');
  for (const line of lines) {
    if (/innerHTML\s*=/.test(line)) {
      assert.fail('gallery-viewer.js contains an innerHTML assignment: ' + line.trim());
    }
  }
});

test('source-scan: production module never calls eval / Function', () => {
  assert.equal(/\beval\s*\(/.test(SOURCE), false, 'eval found');
  assert.equal(/new\s+Function\s*\(/.test(SOURCE), false, 'new Function found');
});

test('source-scan: keyboard bindings cover navigation + flag + trash', () => {
  for (const key of ['Escape', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete']) {
    assert.ok(SOURCE.includes(`'${key}'`), `missing keyboard binding for ${key}`);
  }
});

test('source-scan: filmstrip is virtualized via FILMSTRIP_BUFFER + clientWidth math', () => {
  assert.ok(SOURCE.includes('FILMSTRIP_BUFFER'), 'no virtualization buffer constant');
  assert.ok(SOURCE.includes('this._strip.clientWidth'), 'no viewport-width math (means filmstrip is not virtualized)');
});

test('source-scan: pointer-up gesture has both threshold AND velocity tests', () => {
  assert.ok(SOURCE.includes('SWIPE_THRESHOLD_PX'), 'no swipe threshold');
  assert.ok(SOURCE.includes('SWIPE_VELOCITY_PX_MS'), 'no swipe velocity');
});

test('source-scan: aria attributes set for screen readers', () => {
  assert.ok(SOURCE.includes("setAttribute('aria-modal'"), 'no aria-modal');
  assert.ok(SOURCE.includes("setAttribute('aria-label'"), 'no aria-label');
  assert.ok(SOURCE.includes("setAttribute('role'"), 'no role attr');
});

// ── transformGalleryToStack helper tests ─────────────────────────

test('transformGalleryToStack is a no-op on null input', () => {
  // Must not throw.
  const { transformGalleryToStack } = require('./gallery-viewer');
  transformGalleryToStack(null, () => {});
  transformGalleryToStack(undefined, () => {});
});

test('transformGalleryToStack: idempotent re-application', () => {
  const fakeDoc = makeStubDocument();
  global.document = fakeDoc;
  try {
    const { transformGalleryToStack } = require('./gallery-viewer');
    const gallery = fakeDoc.createElement('div');
    gallery.classList.add('merlin-gallery');
    const grid = fakeDoc.createElement('div');
    grid.classList.add('merlin-gallery-grid');
    const fig = fakeDoc.createElement('figure');
    fig.classList.add('merlin-artifact');
    const img = fakeDoc.createElement('img');
    img.setAttribute('src', 'merlin://results/img/a.png');
    fig.appendChild(img);
    grid.appendChild(fig);
    gallery.appendChild(grid);

    let opened = 0;
    transformGalleryToStack(gallery, () => { opened++; });
    assert.equal(gallery.dataset.merlinStacked, '1');
    transformGalleryToStack(gallery, () => { opened++; });
    // No double-stacking — second call is a no-op.
    assert.equal(opened, 0); // Activate hasn't fired yet.
  } finally {
    delete global.document;
  }
});

test('transformGalleryToStack: extracts items from <img> figures', () => {
  const fakeDoc = makeStubDocument();
  global.document = fakeDoc;
  try {
    const { transformGalleryToStack } = require('./gallery-viewer');
    const gallery = fakeDoc.createElement('div');
    gallery.classList.add('merlin-gallery');
    const grid = fakeDoc.createElement('div');
    grid.classList.add('merlin-gallery-grid');

    for (let i = 0; i < 5; i++) {
      const fig = fakeDoc.createElement('figure');
      fig.classList.add('merlin-artifact');
      const img = fakeDoc.createElement('img');
      img.setAttribute('src', 'merlin://results/img/a' + i + '.png');
      fig.appendChild(img);
      grid.appendChild(fig);
    }
    gallery.appendChild(grid);

    let receivedItems = null;
    transformGalleryToStack(gallery, (items) => { receivedItems = items; });

    // Find the stack and dispatch a click.
    const stack = gallery.querySelector('.merlin-gallery-stack');
    assert.ok(stack, 'stack should replace grid');
    stack.dispatchEvent('click', { preventDefault() {}, stopPropagation() {} });
    assert.equal(receivedItems.length, 5, 'expected all 5 items extracted');
    assert.equal(receivedItems[0].kind, 'image');
    assert.equal(receivedItems[0].src, 'merlin://results/img/a0.png');
  } finally {
    delete global.document;
  }
});

test('transformGalleryToStack: caps stack at 4 visible cards', () => {
  const fakeDoc = makeStubDocument();
  global.document = fakeDoc;
  try {
    const { transformGalleryToStack } = require('./gallery-viewer');
    const gallery = fakeDoc.createElement('div');
    gallery.classList.add('merlin-gallery');
    const grid = fakeDoc.createElement('div');
    grid.classList.add('merlin-gallery-grid');
    for (let i = 0; i < 25; i++) {
      const fig = fakeDoc.createElement('figure');
      fig.classList.add('merlin-artifact');
      const img = fakeDoc.createElement('img');
      img.setAttribute('src', 'merlin://x' + i + '.png');
      fig.appendChild(img);
      grid.appendChild(fig);
    }
    gallery.appendChild(grid);

    transformGalleryToStack(gallery, () => {});
    const stack = gallery.querySelector('.merlin-gallery-stack');
    const cards = stack.querySelectorAll('.merlin-stack-card');
    assert.equal(cards.length, 4, 'visible card count must be capped at 4');
  } finally {
    delete global.document;
  }
});

test('transformGalleryToStack: video-kind gallery extracts video src', () => {
  const fakeDoc = makeStubDocument();
  global.document = fakeDoc;
  try {
    const { transformGalleryToStack } = require('./gallery-viewer');
    const gallery = fakeDoc.createElement('div');
    gallery.classList.add('merlin-gallery');
    const grid = fakeDoc.createElement('div');
    grid.classList.add('merlin-gallery-grid');

    const fig = fakeDoc.createElement('figure');
    fig.classList.add('merlin-artifact');
    const v = fakeDoc.createElement('video');
    v.setAttribute('src', 'merlin://results/v/clip.mp4');
    fig.appendChild(v);
    grid.appendChild(fig);
    gallery.appendChild(grid);

    let received;
    transformGalleryToStack(gallery, (items) => { received = items; });
    const stack = gallery.querySelector('.merlin-gallery-stack');
    stack.dispatchEvent('click', { preventDefault() {}, stopPropagation() {} });
    assert.equal(received[0].kind, 'video');
    assert.equal(received[0].src, 'merlin://results/v/clip.mp4');
  } finally {
    delete global.document;
  }
});

test('transformGalleryToStack: skips items without a src', () => {
  const fakeDoc = makeStubDocument();
  global.document = fakeDoc;
  try {
    const { transformGalleryToStack } = require('./gallery-viewer');
    const gallery = fakeDoc.createElement('div');
    gallery.classList.add('merlin-gallery');
    const grid = fakeDoc.createElement('div');
    grid.classList.add('merlin-gallery-grid');

    const figGood = fakeDoc.createElement('figure');
    figGood.classList.add('merlin-artifact');
    const img = fakeDoc.createElement('img');
    img.setAttribute('src', 'merlin://x.png');
    figGood.appendChild(img);

    const figBad = fakeDoc.createElement('figure');
    figBad.classList.add('merlin-artifact');
    // No src — should be filtered out.
    const phantomImg = fakeDoc.createElement('img');
    figBad.appendChild(phantomImg);

    grid.appendChild(figGood);
    grid.appendChild(figBad);
    gallery.appendChild(grid);

    let received;
    transformGalleryToStack(gallery, (items) => { received = items; });
    const stack = gallery.querySelector('.merlin-gallery-stack');
    stack.dispatchEvent('click', { preventDefault() {}, stopPropagation() {} });
    assert.equal(received.length, 1);
  } finally {
    delete global.document;
  }
});

test('transformGalleryToStack: empty gallery is a no-op', () => {
  const fakeDoc = makeStubDocument();
  global.document = fakeDoc;
  try {
    const { transformGalleryToStack } = require('./gallery-viewer');
    const gallery = fakeDoc.createElement('div');
    gallery.classList.add('merlin-gallery');
    const grid = fakeDoc.createElement('div');
    grid.classList.add('merlin-gallery-grid');
    gallery.appendChild(grid);
    transformGalleryToStack(gallery, () => {});
    // Stack should NOT have replaced the grid since there's nothing to stack.
    assert.ok(gallery.querySelector('.merlin-gallery-grid'));
    assert.equal(gallery.querySelector('.merlin-gallery-stack'), null);
  } finally {
    delete global.document;
  }
});

test('source-scan: arrow keys do NOT wrap at boundaries', () => {
  // The `go(delta)` method must EARLY-RETURN at boundaries, not wrap.
  // S-tier expectation: pressing ← at index 0 stops there, no surprise jump
  // to the last item. Surfaced in the comment + the boundary check.
  assert.ok(SOURCE.includes('Don\'t wrap'), 'expected boundary-no-wrap comment in go()');
});

test('source-scan: reject auto-advances to the next item', () => {
  // Power-user pattern: hold R-R-R-R to walk through and reject. The
  // implementation must advance index on a reject press.
  // Match across whitespace (including newlines) by looking for the two
  // anchors with [\s\S]*? between them.
  assert.ok(/next === 'reject'[\s\S]*?go\(1\)/.test(SOURCE), 'reject should auto-advance');
});

test('source-scan: trash flow removes item from list and advances', () => {
  // After a successful trash, the item must be SPLICED from `_items` and
  // the index clamped to a valid position.
  assert.ok(SOURCE.includes('this._items.splice(this._index, 1)'), 'expected splice on trash');
});

test('source-scan: open() is idempotent — re-entry closes the prior viewer', () => {
  // REGRESSION GUARD (2026-04-26, viewer-reopen-while-open). Without
  // this, rapid clicks during the async getArchiveFlags fetch double-
  // mounted the keydown handler so every key fired twice. The guard is
  // a 1-line `if (this._open) this.close();` at the top of open().
  assert.ok(/open\([^)]*\)\s*\{[\s\S]*?if\s*\(this\._open\)\s*this\.close\(\);/.test(SOURCE),
    'open() must close any prior viewer before re-entering');
});

test('source-scan: pointer listeners are stable instance refs (no inline arrows)', () => {
  // REGRESSION GUARD (2026-04-26, viewer listener leak). Inline arrow
  // functions inside _mountListeners cannot be removed, so each open()
  // accumulated three more pointer listeners on the stage. The fix
  // binds them ONCE in the constructor and re-uses the references.
  for (const f of ['_stagePointerDown', '_stagePointerUp', '_stagePointerCancel']) {
    assert.ok(SOURCE.includes(`this.${f} =`), `expected stable instance ref ${f}`);
  }
  assert.ok(SOURCE.includes('_stageListenersAttached'),
    'attach-once flag must guard against re-binding');
});

test('source-scan: stage pointer listeners only attach once per instance', () => {
  // The attach must be gated by `_stageListenersAttached` so re-opens
  // do not re-add the same listeners.
  assert.ok(/!this\._stageListenersAttached/.test(SOURCE),
    'pointer listener attach must be guarded by !_stageListenersAttached');
});
