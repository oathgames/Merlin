// Tests for the modal dedupe guard added in the 2026-04-20 transcription-
// failed-modal endless-loop incident. showModal must:
//   * Suppress an identical modal while one is already visible.
//   * Suppress an identical modal already sitting in the queue.
//   * Suppress an identical modal fired within _MODAL_DEDUPE_COOLDOWN_MS of
//     the matching dismissal.
//   * Still queue genuinely different modals normally.
//   * Never coalesce input-prompt modals (inputPlaceholder set).
//
// renderer.js is a browser script, so we extract showModal + friends into
// a vm sandbox with a minimal DOM stub — same pattern used by
// transcribe-error.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');

// Pull the module-level modal state + showModal body out as one chunk. The
// anchor runs from the `// ── Inline Modal` header to the closing brace of
// `showModal` (matched by the terminating `^}\n` at column 0 on a line that
// precedes the next top-level comment / function). showModalError sits
// right after and we intentionally don't include it — tests don't need it.
const chunkMatch = rendererSrc.match(
  /let _modalQueue = \[\];[\s\S]*?\nfunction showModal\([\s\S]*?\n\}\n/,
);
if (!chunkMatch) throw new Error('modal state + showModal not found — update the extraction anchor');

// Minimal DOM stub: only the ids showModal touches. Every element is a bag
// of properties; classList is a Set with add/remove. We don't render, we
// just need the function to not throw when it flips classes and sets text.
function makeStubDom() {
  const make = () => {
    const classes = new Set();
    return {
      textContent: '',
      innerHTML: '',
      value: '',
      placeholder: '',
      onclick: null,
      onkeydown: null,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
      focus: () => {},
      replaceChildren: () => {},
      _classes: classes,
    };
  };
  const elements = {
    'merlin-modal': make(),
    'merlin-modal-title': make(),
    'merlin-modal-body': make(),
    'merlin-modal-input': make(),
    'merlin-modal-error': make(),
    'merlin-modal-confirm': make(),
    'merlin-modal-cancel': make(),
    'merlin-modal-close': make(),
  };
  return {
    elements,
    document: {
      getElementById: (id) => elements[id],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  };
}

// Fresh sandbox per test — otherwise module-level state leaks between tests.
function makeSandbox(nowFn) {
  const { document, elements } = makeStubDom();
  const ctx = {
    document,
    Node: function Node() {}, // only used for instanceof; stub is fine
    Date: { now: nowFn },
    setTimeout: (fn, _ms) => { fn(); return 0; },
    JSON,
    console,
  };
  vm.createContext(ctx);
  // `let`/`const` declared at the top of a VM script stay in the script's
  // lexical scope and don't attach to the context. Re-export them onto
  // globalThis so the tests can inspect queue/active state between calls.
  const exportShim = `
globalThis.showModal = showModal;
Object.defineProperty(globalThis, '_modalActive', { get: () => _modalActive });
Object.defineProperty(globalThis, '_modalQueue', { get: () => _modalQueue });
Object.defineProperty(globalThis, '_modalActiveSig', { get: () => _modalActiveSig });
Object.defineProperty(globalThis, '_modalLastDismissedSig', { get: () => _modalLastDismissedSig });
Object.defineProperty(globalThis, '_modalLastDismissedAt', { get: () => _modalLastDismissedAt });
`;
  vm.runInContext(chunkMatch[0] + exportShim, ctx);
  return { ctx, elements };
}

test('duplicate modal while one is active is suppressed', () => {
  const { ctx } = makeSandbox(() => 1000);
  ctx.showModal({ title: 'Transcription failed', body: 'X', confirmLabel: 'OK' });
  assert.equal(ctx._modalActive, true);
  assert.equal(ctx._modalQueue.length, 0);

  ctx.showModal({ title: 'Transcription failed', body: 'X', confirmLabel: 'OK' });
  ctx.showModal({ title: 'Transcription failed', body: 'X', confirmLabel: 'OK' });
  ctx.showModal({ title: 'Transcription failed', body: 'X', confirmLabel: 'OK' });
  // Queue stays empty — dedupe rejected all three duplicates.
  assert.equal(ctx._modalQueue.length, 0);
});

test('duplicate modal already queued is suppressed', () => {
  const { ctx } = makeSandbox(() => 1000);
  ctx.showModal({ title: 'A', body: 'first', confirmLabel: 'OK' });
  ctx.showModal({ title: 'B', body: 'second', confirmLabel: 'OK' });   // queued
  ctx.showModal({ title: 'B', body: 'second', confirmLabel: 'OK' });   // dup of queued
  ctx.showModal({ title: 'B', body: 'second', confirmLabel: 'OK' });   // dup of queued
  assert.equal(ctx._modalQueue.length, 1);
});

test('different modals still queue normally', () => {
  const { ctx } = makeSandbox(() => 1000);
  ctx.showModal({ title: 'A', body: 'first', confirmLabel: 'OK' });
  ctx.showModal({ title: 'B', body: 'second', confirmLabel: 'OK' });
  ctx.showModal({ title: 'C', body: 'third', confirmLabel: 'OK' });
  assert.equal(ctx._modalQueue.length, 2);
});

test('cooldown suppresses identical modal within window', () => {
  let now = 1000;
  const { ctx, elements } = makeSandbox(() => now);
  ctx.showModal({ title: 'Transcription failed', body: 'X', confirmLabel: 'OK' });
  // Dismiss by invoking the wired-up OK click handler.
  elements['merlin-modal-confirm'].onclick();
  assert.equal(ctx._modalActive, false);
  assert.equal(ctx._modalLastDismissedSig, JSON.stringify(['Transcription failed', 'X', '', '']));

  // 500 ms later, same modal fires again — should be swallowed.
  now = 1500;
  ctx.showModal({ title: 'Transcription failed', body: 'X', confirmLabel: 'OK' });
  assert.equal(ctx._modalActive, false);
});

test('cooldown expires — same modal shows again after window', () => {
  let now = 1000;
  const { ctx, elements } = makeSandbox(() => now);
  ctx.showModal({ title: 'Transcription failed', body: 'X', confirmLabel: 'OK' });
  elements['merlin-modal-confirm'].onclick();

  // 3 s later (> 2 s cooldown) — genuine new failure should surface.
  now = 4000;
  ctx.showModal({ title: 'Transcription failed', body: 'X', confirmLabel: 'OK' });
  assert.equal(ctx._modalActive, true);
});

test('cooldown does not block a DIFFERENT modal after dismissal', () => {
  let now = 1000;
  const { ctx, elements } = makeSandbox(() => now);
  ctx.showModal({ title: 'Transcription failed', body: 'X', confirmLabel: 'OK' });
  elements['merlin-modal-confirm'].onclick();

  // Immediately fire a different modal — must show regardless of the
  // just-dismissed cooldown.
  now = 1100;
  ctx.showModal({ title: 'Connection Failed', body: 'Y', confirmLabel: 'OK' });
  assert.equal(ctx._modalActive, true);
});

test('input-prompt modals are never deduped', () => {
  const { ctx } = makeSandbox(() => 1000);
  ctx.showModal({
    title: 'Unlock Merlin Pro',
    body: 'Enter a license key.',
    inputPlaceholder: 'License key',
    confirmLabel: 'Activate',
  });
  // Even an identical second call must queue — prompts are interactive.
  ctx.showModal({
    title: 'Unlock Merlin Pro',
    body: 'Enter a license key.',
    inputPlaceholder: 'License key',
    confirmLabel: 'Activate',
  });
  assert.equal(ctx._modalQueue.length, 1);
});

test('endless-loop scenario: 20 rapid-fire identical failures → 1 modal', () => {
  const { ctx } = makeSandbox(() => 1000);
  for (let i = 0; i < 20; i++) {
    ctx.showModal({
      title: 'Transcription failed',
      body: 'That recording didn\'t process cleanly. Tap the mic and try again — Merlin auto-stops when you pause.',
      confirmLabel: 'OK',
    });
  }
  assert.equal(ctx._modalActive, true);
  assert.equal(ctx._modalQueue.length, 0);
});
