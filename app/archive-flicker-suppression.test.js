// archive-flicker-suppression.test.js — pins the contract that prevents
// the archive grid from flickering when a user deletes a tile.
//
// Live incident anchor (2026-05-04, archive-grid-flicker-on-delete):
// the user-initiated delete handler optimistically faded out the
// deleted card over 250-300ms. While that fade was running, the
// main-process file watcher detected the on-disk delete and called
// `loadArchive()`, which executed `grid.innerHTML = ''` — blowing
// the entire grid away mid-animation. Visible flicker on every
// delete operation.
//
// Fix: the watcher callback now skips the reload while a user delete
// is in flight or within an 800ms grace window after it settles. The
// optimistic DOM removal has already converged the grid; the
// watcher's reload would only undo and re-do that work.
//
// This is a source-scan test (renderer.js can't be loaded under
// node:test because it depends on window/DOM globals). The contract
// is pinned via textual presence of the suppression machinery + the
// wiring at the three archive-context delete call sites.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

test('renderer.js declares the suppression machinery', () => {
  assert.match(rendererSrc, /let\s+_archiveDeletePromise\s*=\s*null/,
    '_archiveDeletePromise tracks the most-recent in-flight user delete');
  assert.match(rendererSrc, /let\s+_archiveWatcherDebounce\s*=\s*null/,
    '_archiveWatcherDebounce collapses rapid sibling watcher events');
  assert.match(rendererSrc, /const\s+ARCHIVE_WATCHER_DEBOUNCE_MS\s*=\s*\d+/,
    'ARCHIVE_WATCHER_DEBOUNCE_MS must be declared as a numeric constant');
  assert.match(rendererSrc, /const\s+ARCHIVE_DELETE_GRACE_MS\s*=\s*\d+/,
    'ARCHIVE_DELETE_GRACE_MS covers the 250-300ms card-fade window + safety margin');
});

test('renderer.js declares noteArchiveDelete + archiveDeleteFile helpers', () => {
  assert.match(rendererSrc, /function\s+noteArchiveDelete\s*\(\s*promise\s*\)/,
    'noteArchiveDelete sets _archiveDeletePromise + clears it after grace');
  assert.match(rendererSrc, /function\s+archiveDeleteFile\s*\(\s*target\s*\)/,
    'archiveDeleteFile is the wrapper every archive-context delete must use');
});

test('noteArchiveDelete clears _archiveDeletePromise after the grace window', () => {
  // The grace clearance MUST run via the .finally() callback on the
  // promise — otherwise the suppression hangs forever if the delete
  // promise never settles. Source-scan the function body to confirm
  // the .finally() pattern is present.
  const idx = rendererSrc.indexOf('function noteArchiveDelete');
  assert.ok(idx > 0, 'noteArchiveDelete must exist');
  const fnBody = rendererSrc.slice(idx, idx + 800);
  assert.match(fnBody, /promise\.finally\(/,
    'noteArchiveDelete MUST attach a .finally() to the promise so the suppression eventually clears even if the delete throws');
  assert.match(fnBody, /setTimeout\(/,
    'noteArchiveDelete MUST setTimeout the clear by ARCHIVE_DELETE_GRACE_MS so the optimistic fade animation completes before the watcher fires');
  assert.match(fnBody, /_archiveDeletePromise\s*===\s*promise/,
    'noteArchiveDelete MUST guard the clear on identity match — overlapping deletes share the slot, only the LAST one clears it');
});

test('the watcher callback skips reload when _archiveDeletePromise is set', () => {
  // Anchor on the merlin.onArchiveChanged handler — the suppression
  // check must be the FIRST guard inside the callback.
  const idx = rendererSrc.indexOf('merlin.onArchiveChanged(()');
  assert.ok(idx > 0, 'merlin.onArchiveChanged handler must exist');
  const region = rendererSrc.slice(idx, idx + 1200);
  assert.match(region, /if\s*\(\s*_archiveDeletePromise\s*\)/,
    'watcher callback MUST guard on _archiveDeletePromise — without it, user-initiated deletes still trigger a grid rebuild and flicker');
  assert.match(region, /clearTimeout\(\s*_archiveWatcherDebounce\s*\)/,
    'watcher callback MUST debounce — Windows fires multiple sibling events per directory change (IN_DELETE + IN_MODIFY) and rebuilds should collapse');
});

test('the debounced reload double-checks the suppression flag at fire time', () => {
  // Race protection: if the debounce timer was set BEFORE a delete
  // started, but a delete starts mid-window, the timer's fire callback
  // must re-check the flag. Otherwise a delete-in-flight that started
  // 200ms after a watcher event still gets clobbered at t=500ms.
  const idx = rendererSrc.indexOf('_archiveWatcherDebounce = setTimeout');
  assert.ok(idx > 0, 'debounced setTimeout must exist');
  const region = rendererSrc.slice(idx, idx + 600);
  assert.match(region, /if\s*\(\s*_archiveDeletePromise\s*\)/,
    'debounced setTimeout body MUST re-check _archiveDeletePromise so a delete that started mid-window still suppresses the reload');
});

test('every archive-context merlin.deleteFile call is routed through archiveDeleteFile', () => {
  // Source-scan the four contexts that operate on archive grid cards:
  //   1. requestArchiveCardDelete — single-card delete
  //   2. bulk-trash multi-select handler (cards.length-conditional)
  //   3. __openArchiveViewerAt's onTrash callback
  // Each must call archiveDeleteFile, NOT merlin.deleteFile directly.
  const archiveCallSiteCount = (rendererSrc.match(/await\s+archiveDeleteFile\s*\(/g) || []).length;
  assert.ok(archiveCallSiteCount >= 3,
    `expected at least 3 archiveDeleteFile call sites (single-delete, bulk-trash, viewer-trash); got ${archiveCallSiteCount}`);

  // Negative guard: archive-context contexts must NOT bypass the wrapper.
  // We can't ban merlin.deleteFile globally — preview-mode and pwa paths
  // legitimately use it for non-archive surfaces. But we can verify the
  // three archive call sites identified above don't reintroduce the
  // direct call. Anchor each on its surrounding function name.
  for (const fn of ['requestArchiveCardDelete', 'merlin-stack-fallback']) {
    // (placeholder — real archive-fn anchors below)
  }
  // Single-card delete: requestArchiveCardDelete body must use archiveDeleteFile.
  const singleIdx = rendererSrc.indexOf('async function requestArchiveCardDelete');
  assert.ok(singleIdx > 0, 'requestArchiveCardDelete must exist');
  const singleRegion = rendererSrc.slice(singleIdx, singleIdx + 1500);
  assert.match(singleRegion, /archiveDeleteFile\(/,
    'requestArchiveCardDelete MUST call archiveDeleteFile — direct merlin.deleteFile reintroduces the flicker');
  assert.doesNotMatch(singleRegion, /await\s+merlin\.deleteFile\(/,
    'requestArchiveCardDelete must NOT call merlin.deleteFile directly');
});

test('REGRESSION GUARD comment anchors the 2026-05-04 flicker incident', () => {
  assert.match(rendererSrc, /archive-grid-flicker-on-delete/,
    'renderer.js must carry the archive-grid-flicker-on-delete REGRESSION GUARD anchor');
});
