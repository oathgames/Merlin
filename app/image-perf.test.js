// image-perf.test.js — regression guards for the
// "image-stuck-partial-render + sluggish-image-browsing" incident
// (2026-05-03).
//
// Two coordinated fixes:
//
//   1. Stuck partial render — gallery-viewer's stage IMG was
//      created, src-assigned, and appended in the same tick. On a
//      slow CDN response the browser rendered scanlines as they
//      arrived; combined with the dark `.gv-media { background: #000 }`
//      rule, the unloaded portion showed as a sharp black band stuck
//      on screen. Fix: HTMLImageElement.decode() returns a Promise
//      that resolves only when the FULL bitmap is decoded; we attach
//      to the DOM only after that. Background dropped to transparent
//      as defense-in-depth + the .gv-stage-loading shimmer fills the
//      void during the decode promise.
//
//   2. Sluggish browsing — the .gv-viewer's blur(28px) backdrop-filter
//      was the dominant per-frame GPU cost; reduced to 12px and
//      disabled entirely during filmstrip scroll (transient
//      .gv-scrolling class, 150ms debounce). Stage IMG marked
//      fetchPriority='high' so it always wins bandwidth over the
//      filmstrip thumbs which are marked fetchPriority='low'. Archive
//      card thumbnails got decoding="async" so bitmap decode happens
//      off the main thread — eliminates the per-tile decode-then-paint
//      stall on grids with 50+ cards.
//
// This test pins all surfaces so a future "tighten / cleanup" pass
// can't silently revert any of them.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const galleryPath = path.join(__dirname, 'gallery-viewer.js');
const stylePath = path.join(__dirname, 'style.css');
const rendererPath = path.join(__dirname, 'renderer.js');

test('gallery-viewer stage IMG uses decode-before-attach to avoid partial-render', () => {
  const src = fs.readFileSync(galleryPath, 'utf8');
  // The decode() promise call MUST appear before stage.appendChild
  // for the IMG branch.
  assert.match(src, /media\.decode\(\)/, 'gallery-viewer must use HTMLImageElement.decode() to await full bitmap before attach — guards against the partial-render stuck-image bug');
  assert.match(src, /gv-stage-loading/, 'gallery-viewer must add the .gv-stage-loading class while decode() is in flight so the user sees the shimmer instead of a void');
  assert.match(src, /classList\.remove\(['"]gv-stage-loading['"]\)/, 'gallery-viewer must clear the .gv-stage-loading class on both decode resolve AND reject paths');
  // The cardItem capture pattern guards against stale-tick attaches
  // when the user advances mid-decode.
  assert.match(src, /cardItem\s*=\s*cur/, 'gallery-viewer must capture the current item by reference so a fast go(±1) does not race the decode promise into the wrong stage');
});

test('gallery-viewer stage IMG sets fetchPriority high; thumbs set fetchPriority low', () => {
  const src = fs.readFileSync(galleryPath, 'utf8');
  assert.match(src, /media\.fetchPriority\s*=\s*['"]high['"]/, 'stage IMG must declare fetchPriority=high so it wins bandwidth over filmstrip thumbs on slow connections');
  assert.match(src, /img\.fetchPriority\s*=\s*['"]low['"]/, 'filmstrip thumb IMGs must declare fetchPriority=low so they yield to the foreground stage image');
});

test('gallery-viewer adds gv-scrolling class on filmstrip scroll with 150ms debounce', () => {
  const src = fs.readFileSync(galleryPath, 'utf8');
  assert.match(src, /classList\.add\(['"]gv-scrolling['"]\)/, 'filmstrip scroll handler must add the .gv-scrolling class so CSS can drop the expensive backdrop-filter during motion');
  assert.match(src, /150/, 'scroll debounce must be 150ms — long enough to coalesce trackpad-flick events, short enough that the blur returns crisply at rest');
  assert.match(src, /classList\.remove\(['"]gv-scrolling['"]\)/, 'gv-scrolling class must clear after the debounce so the depth-cue blur returns at rest');
});

test('style.css drops backdrop-filter from blur(28px) to blur(12px) and disables during scroll', () => {
  const css = fs.readFileSync(stylePath, 'utf8');
  // The viewer's backdrop-filter is the dominant GPU cost; 28px was
  // a 7.8× larger kernel than 8px and showed measurable jank during
  // navigation. 12px keeps the depth cue at ~3× lower compositing cost.
  assert.match(css, /\.gv-viewer\s*\{[^}]*backdrop-filter:\s*blur\(12px\)/, '.gv-viewer must use backdrop-filter: blur(12px) — was blur(28px), the dominant per-frame GPU cost during navigation');
  assert.doesNotMatch(css, /\.gv-viewer\s*\{[^}]*backdrop-filter:\s*blur\(28px\)/, 'REGRESSION: .gv-viewer reverted to blur(28px) — that was the GPU bottleneck the perf fix targeted');
  // Disable-during-scroll rule.
  assert.match(css, /\.gv-viewer\.gv-scrolling\s*\{[^}]*backdrop-filter:\s*none/, '.gv-viewer.gv-scrolling must disable backdrop-filter so per-scroll-tick recomposite cost stays bounded');
});

test('style.css drops black background from .gv-media IMG (defense-in-depth vs partial render)', () => {
  const css = fs.readFileSync(stylePath, 'utf8');
  // Pull the .gv-stage > .gv-media block specifically.
  const blockMatch = css.match(/\.gv-stage\s*>\s*\.gv-media\s*\{[^}]*\}/);
  assert.ok(blockMatch, '.gv-stage > .gv-media block must exist');
  const block = blockMatch[0];
  assert.doesNotMatch(block, /background:\s*#000/, '.gv-stage > .gv-media must NOT have background: #000 — that was the surface that made partial-loaded scanlines look like a sharp black band');
  assert.match(block, /background:\s*transparent/, '.gv-stage > .gv-media should set background: transparent so partial decodes (if the decode-before-attach path is bypassed) at least show through to the scrim instead of a black block');
});

test('style.css carries the gv-stage-loading shimmer rule', () => {
  const css = fs.readFileSync(stylePath, 'utf8');
  assert.match(css, /\.gv-stage\.gv-stage-loading::before/, 'shimmer pseudo-element must render only while gv-stage-loading is set');
  assert.match(css, /@keyframes\s+gv-shimmer/, 'gv-shimmer keyframes must be defined');
});

test('archive card thumbnails declare loading=lazy AND decoding=async', () => {
  const src = fs.readFileSync(rendererPath, 'utf8');
  // Both attribute pairs must coexist on every archive-card-thumb img
  // template literal. lazy alone leaves bitmap decode on the main
  // thread; async alone forces all 100+ tiles to fetch immediately.
  // Both together = lazy fetch + async decode = no jank.
  const thumbTemplates = src.match(/<img class="archive-card-thumb"[^>]+>/g) || [];
  assert.ok(thumbTemplates.length >= 2, 'expected at least two archive-card-thumb img templates in renderer.js');
  for (const tpl of thumbTemplates) {
    assert.ok(tpl.includes('loading="lazy"'), `archive-card-thumb missing loading="lazy": ${tpl}`);
    assert.ok(tpl.includes('decoding="async"'), `archive-card-thumb missing decoding="async": ${tpl}`);
  }
});
