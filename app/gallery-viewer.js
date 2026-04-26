// Merlin shared gallery viewer.
//
// One full-screen viewer used by BOTH chat-rendered artifact galleries
// (collapsed stack of 1–4 cards, click to expand into the viewer) and
// the Archive tab (multi-select grid → click any card to open the viewer
// rooted at that item, then arrow / swipe through every visible item).
//
// Design principles (S-tier batch review at scale):
//   - Keyboard-first. Every action a power user runs hundreds of times in a
//     row has a single keystroke: ←/→/↑/↓ navigate, Space toggles keep,
//     X/Backspace/Delete trashes, Esc closes, Home/End jump to ends,
//     Enter opens the action menu. All bindings work without modifiers.
//   - The filmstrip is virtualized — even 5,000 items render in O(1)
//     visible thumbs. Item DOM is created on demand and recycled.
//   - Touch / trackpad swipe via PointerEvents (works on Windows touchpad,
//     Mac trackpad, iPad). Velocity-aware: a flick advances regardless of
//     how far the gesture traveled.
//   - Rule 14 sandbox parity: the viewer is built into the renderer DOM
//     (already runs with contextIsolation: true, sandbox: true, webSecurity:
//     true) — no preload, no eval, no innerHTML on user-controlled strings.
//     Every label / src is set via property assignment or `textContent`.
//
// Public API:
//   const v = createGalleryViewer(host?: HTMLElement);
//   v.open({ items, startIndex, mode, onTrash, onSetFlag, onClose, getFlag });
//   v.close();
//   v.isOpen() -> boolean;
//
// `items` is an array of:
//   { key: string,           // stable identifier (used for flag lookups)
//     src: string,           // merlin:// or absolute URL of the media
//     kind: 'image'|'video'|'audio',
//     label?: string,        // shown in the toolbar
//     meta?: string,         // small text under the label
//     qa?: { pass: bool, reason?: string },
//   }
//
// Modes:
//   'chat'    — viewer over a single batch from the chat (no flag UI by
//               default, just review + trash).
//   'archive' — viewer over the Archive's currently-visible filtered set.
//               Shows ★ keep / ✗ reject controls; persists via onSetFlag.
//
// onTrash(key, item)        -> Promise<{ success, error? }>; viewer advances.
// onSetFlag(key, flag)      -> Promise<void>; flag is 'keep'|'reject'|null.
// getFlag(key)              -> 'keep'|'reject'|null|undefined.
// onClose()                 -> void.

'use strict';

// Dual-module shim: loaded as a global (window.MerlinGalleryViewer) in the
// renderer (which has no `require`), and as a CommonJS module in the
// node-based test harness. Keep both export paths intact when editing —
// matches the pattern in archive-campaign-group.js.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MerlinGalleryViewer = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {

const VIEWER_CLASS = 'gv-viewer';
const ROLE_DIALOG = 'dialog';

// Filmstrip virtualization knobs.
const FILMSTRIP_ITEM_W = 84;     // px — single thumb width including gap
const FILMSTRIP_BUFFER = 6;      // extra thumbs rendered each side of the viewport

// Swipe gesture thresholds.
const SWIPE_THRESHOLD_PX = 60;
const SWIPE_VELOCITY_PX_MS = 0.6;

class GalleryViewer {
  constructor(host) {
    this._host = host || (typeof document !== 'undefined' ? document.body : null);
    if (!this._host) throw new Error('gallery-viewer: no host element');
    this._root = null;
    this._items = [];
    this._index = 0;
    this._mode = 'chat';
    this._opts = {};
    this._open = false;

    // Filmstrip DOM (recycled across sessions).
    this._strip = null;
    this._stripInner = null;
    this._stripThumbs = new Map(); // index -> element

    // Main stage references.
    this._stage = null;
    this._stageMedia = null;
    this._counterEl = null;
    this._labelEl = null;
    this._metaEl = null;
    this._flagBtns = null; // { keep, reject }
    this._qaBadge = null;

    // Pointer / keyboard handlers — bound ONCE per instance and reused
    // across every open/close cycle. Inline arrow functions here would
    // leak listeners on every open() (each open re-registers, none of
    // the previous ones can be removed because the function reference
    // changes). REGRESSION GUARD (2026-04-26, viewer listener leak):
    // these references must remain stable for the lifetime of the
    // viewer instance.
    this._keyHandler = (e) => this._onKey(e);
    this._pointerStart = null;
    this._stripScrollHandler = () => this._renderFilmstrip();
    this._stagePointerDown = (e) => this._onPointerDown(e);
    this._stagePointerUp = (e) => this._onPointerUp(e);
    this._stagePointerCancel = () => { this._pointerStart = null; };
    this._stageListenersAttached = false;
  }

  isOpen() { return this._open; }

  open(opts) {
    if (!opts || !Array.isArray(opts.items) || opts.items.length === 0) {
      throw new Error('gallery-viewer: items required');
    }
    // REGRESSION GUARD (2026-04-26, viewer reopen-while-open): rapid
    // clicks during the async flag-fetch in __openArchiveViewerAt could
    // call open() while a viewer was already up, double-mounting the
    // keydown listener and making every key (incl. Delete) fire twice.
    // Tear down cleanly before re-entering.
    if (this._open) this.close();
    this._items = opts.items.slice();
    const start = Number.isInteger(opts.startIndex) ? opts.startIndex : 0;
    this._index = Math.max(0, Math.min(start, this._items.length - 1));
    this._mode = opts.mode === 'archive' ? 'archive' : 'chat';
    this._opts = opts;

    if (!this._root) this._buildRoot();
    this._renderToolbar();
    this._renderStage();
    this._renderFilmstrip();
    this._mountListeners();
    this._host.appendChild(this._root);
    this._open = true;

    // Focus the root so keystrokes flow to the viewer immediately.
    setTimeout(() => { try { this._root.focus(); } catch {} }, 0);
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this._unmountListeners();
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._stripThumbs.clear();
    if (typeof this._opts.onClose === 'function') {
      try { this._opts.onClose(); } catch {}
    }
    this._items = [];
    this._opts = {};
  }

  // Programmatic navigation. Wraps at the ends.
  go(delta) {
    if (this._items.length === 0) return;
    const next = this._index + delta;
    if (next < 0 || next >= this._items.length) {
      // Don't wrap — the user expects "I'm at the end" feedback when
      // they hit the boundary, not a surprise jump to the other side.
      return;
    }
    this._index = next;
    this._renderToolbar();
    this._renderStage();
    this._renderFilmstrip(true);
  }

  goTo(index) {
    if (index < 0 || index >= this._items.length) return;
    this._index = index;
    this._renderToolbar();
    this._renderStage();
    this._renderFilmstrip(true);
  }

  current() {
    return this._items[this._index] || null;
  }

  // ── DOM construction ─────────────────────────────────────────

  _buildRoot() {
    const root = document.createElement('div');
    root.className = VIEWER_CLASS;
    root.setAttribute('role', ROLE_DIALOG);
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Creative viewer');
    root.tabIndex = -1;

    // Top toolbar — counter, label, action buttons, close.
    const top = document.createElement('div');
    top.className = 'gv-toolbar gv-toolbar-top';

    const counter = document.createElement('div');
    counter.className = 'gv-counter';
    top.appendChild(counter);

    const labels = document.createElement('div');
    labels.className = 'gv-labels';
    const labelEl = document.createElement('div');
    labelEl.className = 'gv-label';
    const metaEl = document.createElement('div');
    metaEl.className = 'gv-meta';
    labels.appendChild(labelEl);
    labels.appendChild(metaEl);
    top.appendChild(labels);

    const actions = document.createElement('div');
    actions.className = 'gv-actions';

    const flagKeep = document.createElement('button');
    flagKeep.type = 'button';
    flagKeep.className = 'gv-action gv-flag-keep';
    flagKeep.setAttribute('aria-label', 'Keep (Space)');
    flagKeep.title = 'Keep — Space';
    flagKeep.textContent = '★';

    const flagReject = document.createElement('button');
    flagReject.type = 'button';
    flagReject.className = 'gv-action gv-flag-reject';
    flagReject.setAttribute('aria-label', 'Reject (R)');
    flagReject.title = 'Reject — R';
    flagReject.textContent = '✗';

    const trashBtn = document.createElement('button');
    trashBtn.type = 'button';
    trashBtn.className = 'gv-action gv-trash';
    trashBtn.setAttribute('aria-label', 'Move to Trash (Delete)');
    trashBtn.title = 'Move to Trash — Delete';
    trashBtn.textContent = '🗑';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'gv-action gv-close';
    closeBtn.setAttribute('aria-label', 'Close (Esc)');
    closeBtn.title = 'Close — Esc';
    closeBtn.textContent = '×';

    flagKeep.addEventListener('click', (e) => { e.stopPropagation(); this._toggleFlag('keep'); });
    flagReject.addEventListener('click', (e) => { e.stopPropagation(); this._toggleFlag('reject'); });
    trashBtn.addEventListener('click', (e) => { e.stopPropagation(); this._trashCurrent(); });
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });

    actions.appendChild(flagKeep);
    actions.appendChild(flagReject);
    actions.appendChild(trashBtn);
    actions.appendChild(closeBtn);
    top.appendChild(actions);

    // Stage — large preview area with prev/next buttons.
    const stageWrap = document.createElement('div');
    stageWrap.className = 'gv-stage-wrap';

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'gv-arrow gv-arrow-prev';
    prevBtn.setAttribute('aria-label', 'Previous (←)');
    prevBtn.textContent = '‹';
    prevBtn.addEventListener('click', (e) => { e.stopPropagation(); this.go(-1); });

    const stage = document.createElement('div');
    stage.className = 'gv-stage';
    stage.addEventListener('click', (e) => {
      // Click on stage backdrop = close. Click on the media itself = no-op.
      if (e.target === stage) this.close();
    });

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'gv-arrow gv-arrow-next';
    nextBtn.setAttribute('aria-label', 'Next (→)');
    nextBtn.textContent = '›';
    nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this.go(1); });

    stageWrap.appendChild(prevBtn);
    stageWrap.appendChild(stage);
    stageWrap.appendChild(nextBtn);

    // QA badge floats over the stage.
    const qaBadge = document.createElement('div');
    qaBadge.className = 'gv-qa-badge';
    qaBadge.style.display = 'none';
    stageWrap.appendChild(qaBadge);

    // Filmstrip.
    const strip = document.createElement('div');
    strip.className = 'gv-strip';
    const stripInner = document.createElement('div');
    stripInner.className = 'gv-strip-inner';
    strip.appendChild(stripInner);
    strip.addEventListener('scroll', this._stripScrollHandler);

    root.appendChild(top);
    root.appendChild(stageWrap);
    root.appendChild(strip);

    this._root = root;
    this._stage = stage;
    this._counterEl = counter;
    this._labelEl = labelEl;
    this._metaEl = metaEl;
    this._flagBtns = { keep: flagKeep, reject: flagReject };
    this._qaBadge = qaBadge;
    this._strip = strip;
    this._stripInner = stripInner;
  }

  // ── Rendering ────────────────────────────────────────────────

  _renderToolbar() {
    const total = this._items.length;
    const cur = this._items[this._index] || {};
    if (this._counterEl) this._counterEl.textContent = `${this._index + 1} / ${total}`;
    if (this._labelEl) this._labelEl.textContent = cur.label || '';
    if (this._metaEl) this._metaEl.textContent = cur.meta || '';

    // Flag buttons reflect current state.
    if (this._mode === 'archive' && this._flagBtns) {
      const flag = this._currentFlag();
      this._flagBtns.keep.classList.toggle('is-active', flag === 'keep');
      this._flagBtns.reject.classList.toggle('is-active', flag === 'reject');
      this._flagBtns.keep.style.display = '';
      this._flagBtns.reject.style.display = '';
    } else if (this._flagBtns) {
      this._flagBtns.keep.style.display = 'none';
      this._flagBtns.reject.style.display = 'none';
    }

    // QA badge.
    if (this._qaBadge) {
      if (cur.qa && cur.qa.pass === false) {
        this._qaBadge.style.display = '';
        this._qaBadge.textContent = 'QA: ' + (cur.qa.reason || 'flagged');
      } else {
        this._qaBadge.style.display = 'none';
      }
    }
  }

  _renderStage() {
    const cur = this._items[this._index];
    if (!this._stage || !cur) return;
    while (this._stage.firstChild) this._stage.removeChild(this._stage.firstChild);

    let media;
    switch (cur.kind) {
      case 'video':
        media = document.createElement('video');
        media.controls = true;
        media.autoplay = true;
        media.playsInline = true;
        media.preload = 'metadata';
        break;
      case 'audio':
        media = document.createElement('audio');
        media.controls = true;
        media.preload = 'metadata';
        break;
      case 'image':
      default:
        media = document.createElement('img');
        media.alt = cur.label || '';
        media.decoding = 'async';
        break;
    }
    media.className = 'gv-media';
    media.src = cur.src;
    this._stage.appendChild(media);
    this._stageMedia = media;
  }

  // Virtualized filmstrip — only renders thumbs whose center is within
  // the strip viewport (plus a small buffer so scroll is seamless).
  _renderFilmstrip(centerOnCurrent) {
    if (!this._strip || !this._stripInner) return;
    const total = this._items.length;
    const totalWidth = total * FILMSTRIP_ITEM_W;
    this._stripInner.style.width = totalWidth + 'px';

    const stripWidth = this._strip.clientWidth || 800;
    if (centerOnCurrent) {
      const targetScroll = this._index * FILMSTRIP_ITEM_W - (stripWidth / 2 - FILMSTRIP_ITEM_W / 2);
      this._strip.scrollLeft = Math.max(0, Math.min(totalWidth - stripWidth, targetScroll));
    }
    const scrollLeft = this._strip.scrollLeft;

    const startIdx = Math.max(0, Math.floor(scrollLeft / FILMSTRIP_ITEM_W) - FILMSTRIP_BUFFER);
    const endIdx = Math.min(total - 1, Math.ceil((scrollLeft + stripWidth) / FILMSTRIP_ITEM_W) + FILMSTRIP_BUFFER);

    // Drop any thumb outside [startIdx, endIdx]; render any missing inside.
    for (const [idx, el] of Array.from(this._stripThumbs.entries())) {
      if (idx < startIdx || idx > endIdx) {
        el.remove();
        this._stripThumbs.delete(idx);
      }
    }
    for (let i = startIdx; i <= endIdx; i++) {
      let el = this._stripThumbs.get(i);
      if (!el) {
        el = this._createThumb(i);
        this._stripInner.appendChild(el);
        this._stripThumbs.set(i, el);
      }
      this._updateThumbState(el, i);
    }
  }

  _createThumb(index) {
    const item = this._items[index];
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'gv-thumb';
    el.style.position = 'absolute';
    el.style.left = (index * FILMSTRIP_ITEM_W) + 'px';
    el.style.width = (FILMSTRIP_ITEM_W - 8) + 'px';
    el.dataset.index = String(index);

    if (item.kind === 'image' && item.src) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = item.src;
      el.appendChild(img);
    } else if (item.kind === 'video' && item.src) {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.src = item.src;
      el.appendChild(v);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'gv-thumb-placeholder';
      placeholder.textContent = item.kind === 'audio' ? '♪' : '✦';
      el.appendChild(placeholder);
    }

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(el.dataset.index);
      if (Number.isFinite(idx)) this.goTo(idx);
    });

    return el;
  }

  _updateThumbState(el, index) {
    el.classList.toggle('is-current', index === this._index);
    if (this._mode === 'archive') {
      const item = this._items[index];
      const flag = (typeof this._opts.getFlag === 'function')
        ? this._opts.getFlag(item.key) : null;
      el.classList.toggle('is-keep', flag === 'keep');
      el.classList.toggle('is-reject', flag === 'reject');
    }
  }

  // ── Listeners ────────────────────────────────────────────────

  _mountListeners() {
    document.addEventListener('keydown', this._keyHandler, true);
    // Stage pointer listeners attach ONCE to the persistent stage element
    // (the stage div outlives open/close cycles — it's only built when
    // _root is first constructed). Re-attaching on every open would leak
    // listeners across cycles. The bound references on `this._stage*`
    // are stable for the instance lifetime so removeEventListener can
    // pair them if we ever need to.
    if (this._stage && !this._stageListenersAttached) {
      this._stage.addEventListener('pointerdown', this._stagePointerDown);
      this._stage.addEventListener('pointerup', this._stagePointerUp);
      this._stage.addEventListener('pointercancel', this._stagePointerCancel);
      this._stageListenersAttached = true;
    }
  }

  _unmountListeners() {
    document.removeEventListener('keydown', this._keyHandler, true);
    // Strip scroll listener IS removed on every close because the strip
    // element persists between opens too — but the listener was added
    // in _buildRoot() ONCE, not in _mountListeners. So this remove is
    // technically a no-op pair on instances that never rebuilt; leaving
    // it here matches the symmetry of the keydown handler.
    if (this._strip) this._strip.removeEventListener('scroll', this._stripScrollHandler);
  }

  _onKey(e) {
    if (!this._open) return;
    // Don't intercept keys while typing in an input INSIDE the viewer
    // (no such input today, but future filter chips may live here).
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    let handled = true;
    switch (e.key) {
      case 'Escape':           this.close(); break;
      case 'ArrowLeft':        this.go(-1); break;
      case 'ArrowRight':       this.go(1); break;
      case 'ArrowUp':          this.go(-1); break;
      case 'ArrowDown':        this.go(1); break;
      case 'Home':             this.goTo(0); break;
      case 'End':              this.goTo(this._items.length - 1); break;
      case 'Delete':
      case 'Backspace':        this._trashCurrent(); break;
      case ' ':
      case 'Spacebar':         this._toggleFlag('keep'); break;
      case 'r':
      case 'R':                this._toggleFlag('reject'); break;
      case 'x':
      case 'X':                this._trashCurrent(); break;
      default:                 handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  _onPointerDown(e) {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen' && e.button !== 0) return;
    this._pointerStart = { x: e.clientX, y: e.clientY, t: Date.now() };
  }

  _onPointerUp(e) {
    if (!this._pointerStart) return;
    const dx = e.clientX - this._pointerStart.x;
    const dy = e.clientY - this._pointerStart.y;
    const dt = Math.max(1, Date.now() - this._pointerStart.t);
    this._pointerStart = null;
    const absX = Math.abs(dx), absY = Math.abs(dy);
    // Vertical swipes are reserved for future "dismiss" gestures —
    // ignore for now.
    if (absY > absX) return;
    const velocity = absX / dt;
    if (absX > SWIPE_THRESHOLD_PX || velocity > SWIPE_VELOCITY_PX_MS) {
      this.go(dx < 0 ? 1 : -1);
    }
  }

  // ── Actions ──────────────────────────────────────────────────

  _currentFlag() {
    if (this._mode !== 'archive') return null;
    const cur = this._items[this._index];
    if (!cur || typeof this._opts.getFlag !== 'function') return null;
    return this._opts.getFlag(cur.key) || null;
  }

  async _toggleFlag(flag) {
    if (this._mode !== 'archive') return;
    const cur = this._items[this._index];
    if (!cur || typeof this._opts.onSetFlag !== 'function') return;
    const current = this._currentFlag();
    const next = current === flag ? null : flag;
    try { await this._opts.onSetFlag(cur.key, next); }
    catch {}
    // Update toolbar + thumb regardless of persistence success — the
    // renderer will re-sync on the next archive event if a write failed.
    this._renderToolbar();
    const thumb = this._stripThumbs.get(this._index);
    if (thumb) this._updateThumbState(thumb, this._index);
    // Auto-advance after a reject-press so power-users can hammer R-R-R-R
    // through a batch without manually moving forward.
    if (next === 'reject' && this._index < this._items.length - 1) {
      this.go(1);
    }
  }

  async _trashCurrent() {
    const cur = this._items[this._index];
    if (!cur || typeof this._opts.onTrash !== 'function') return;
    let result;
    try { result = await this._opts.onTrash(cur.key, cur); }
    catch (err) { result = { success: false, error: err && err.message }; }
    if (!result || !result.success) return;
    // Remove the item, drop its thumb, advance.
    this._items.splice(this._index, 1);
    if (this._items.length === 0) { this.close(); return; }
    if (this._index >= this._items.length) this._index = this._items.length - 1;
    // Rebuild thumbs since indices shifted — clear + lazy-rebuild.
    for (const [, el] of this._stripThumbs) { try { el.remove(); } catch {} }
    this._stripThumbs.clear();
    this._renderToolbar();
    this._renderStage();
    this._renderFilmstrip(true);
  }
}

function createGalleryViewer(host) {
  return new GalleryViewer(host);
}

// ── Collapsed-stack rendering for chat artifact galleries ──────
//
// Transforms an existing `.merlin-gallery` element (the open grid emitted
// by artifact-parser.js) into a stacked-card preview that, when clicked,
// opens the shared viewer with the full list. Idempotent: calling twice
// on the same element is a no-op (guarded via data-merlin-stacked).
//
// The transformation preserves the gallery header + meta line so Claude's
// prose echo still sees the structured summary; only the grid below is
// replaced with the stack.

function transformGalleryToStack(galleryEl, openViewer) {
  if (!galleryEl || galleryEl.dataset.merlinStacked === '1') return;
  galleryEl.dataset.merlinStacked = '1';

  const grid = galleryEl.querySelector(':scope > .merlin-gallery-grid');
  if (!grid) return;
  const figures = Array.from(grid.querySelectorAll(':scope > .merlin-artifact'));
  if (figures.length === 0) return;

  // Extract item descriptors from the existing DOM (parser-emitted).
  const items = figures.map((fig) => {
    const img = fig.querySelector(':scope > img');
    const video = fig.querySelector(':scope > video');
    const audio = fig.querySelector(':scope > audio');
    const captionEl = fig.querySelector(':scope > figcaption');
    const qaEl = captionEl && captionEl.querySelector('.merlin-artifact-qa');
    let kind = 'image', src = '';
    if (video) { kind = 'video'; src = video.getAttribute('src') || ''; }
    else if (audio) { kind = 'audio'; src = audio.getAttribute('src') || ''; }
    else if (img) { kind = 'image'; src = img.getAttribute('src') || ''; }
    const label = captionEl ? (captionEl.firstChild ? String(captionEl.firstChild.textContent || '').trim() : '') : '';
    const qaPass = !qaEl;
    return {
      key: src,
      src,
      kind,
      label,
      meta: '',
      qa: qaPass ? null : { pass: false, reason: qaEl.getAttribute('title') || 'QA flagged' },
    };
  }).filter(it => it.src);

  if (items.length === 0) return;

  // Build the stack.
  const stack = document.createElement('div');
  stack.className = 'merlin-gallery-stack';
  stack.setAttribute('role', 'button');
  stack.setAttribute('tabindex', '0');
  stack.setAttribute('aria-label', `Open ${items.length} ${items[0].kind === 'video' ? 'video' : 'image'}${items.length === 1 ? '' : 's'}`);

  const visibleCount = Math.min(4, items.length);
  for (let i = 0; i < visibleCount; i++) {
    const card = document.createElement('div');
    card.className = 'merlin-stack-card';
    card.style.zIndex = String(visibleCount - i);
    const it = items[i];
    if (it.kind === 'video') {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.src = it.src;
      card.appendChild(v);
    } else if (it.kind === 'audio') {
      const ph = document.createElement('div');
      ph.className = 'merlin-stack-placeholder';
      ph.textContent = '♪';
      card.appendChild(ph);
    } else {
      const im = document.createElement('img');
      im.alt = '';
      im.loading = 'lazy';
      im.decoding = 'async';
      im.src = it.src;
      card.appendChild(im);
    }
    stack.appendChild(card);
  }

  const expandHint = document.createElement('div');
  expandHint.className = 'merlin-stack-hint';
  expandHint.textContent = items.length === 1
    ? 'Click to open'
    : `Click to view all ${items.length}`;
  stack.appendChild(expandHint);

  const onActivate = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (typeof openViewer === 'function') openViewer(items, 0);
  };
  stack.addEventListener('click', onActivate);
  stack.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') onActivate(e);
  });

  // Replace the grid with the stack.
  grid.replaceWith(stack);
}

return {
  GalleryViewer,
  createGalleryViewer,
  transformGalleryToStack,
  // Exposed for tests only.
  __FILMSTRIP_ITEM_W: FILMSTRIP_ITEM_W,
  __SWIPE_THRESHOLD_PX: SWIPE_THRESHOLD_PX,
};

}));
