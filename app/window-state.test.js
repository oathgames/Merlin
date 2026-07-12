// Tests for window-state.js (Fable audit F7: window geometry persistence)
// and the shell-PATH cache in main.js's fixPath (Fable audit P6).
//
// Run with: node --test app/window-state.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { clampWindowBounds, createBoundsSaver, VISIBLE_STRIP } = require('./window-state');
const MAIN_JS = readFileSync(path.join(__dirname, 'main.js'), 'utf8');

const PRIMARY = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const LEFT_MONITOR = { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };

test('on-screen saved bounds are restored as-is', () => {
  const out = clampWindowBounds({ x: 100, y: 80, width: 1200, height: 800 }, [PRIMARY]);
  assert.deepEqual(out, { x: 100, y: 80, width: 1200, height: 800 });
});

test('negative-coordinate monitor positions survive the clamp', () => {
  const out = clampWindowBounds({ x: -1800, y: 60, width: 1000, height: 700 }, [PRIMARY, LEFT_MONITOR]);
  assert.deepEqual(out, { x: -1800, y: 60, width: 1000, height: 700 });
});

test('a detached-monitor position falls back to size-only (Electron centers)', () => {
  const out = clampWindowBounds({ x: -1800, y: 60, width: 1000, height: 700 }, [PRIMARY]);
  assert.deepEqual(out, { width: 1000, height: 700 });
  assert.ok(!('x' in out) && !('y' in out), 'stale position must be dropped');
});

test('a position with less than the visible strip on-screen is treated as stale', () => {
  // Window hangs almost entirely off the right edge.
  const x = PRIMARY.workArea.width - (VISIBLE_STRIP - 8);
  const out = clampWindowBounds({ x, y: 100, width: 900, height: 670 }, [PRIMARY]);
  assert.ok(!('x' in out), 'off-screen-right position dropped');
});

test('a title bar above the display top is treated as stale', () => {
  const out = clampWindowBounds({ x: 100, y: -200, width: 900, height: 670 }, [PRIMARY]);
  assert.ok(!('x' in out), 'above-screen position dropped');
});

test('size is clamped to [min, largest workArea]', () => {
  const big = clampWindowBounds({ x: 0, y: 0, width: 5000, height: 4000 }, [PRIMARY]);
  assert.equal(big.width, 1920);
  assert.equal(big.height, 1040);
  const tiny = clampWindowBounds({ x: 0, y: 0, width: 50, height: 40 }, [PRIMARY], { minWidth: 500, minHeight: 400 });
  assert.equal(tiny.width, 500);
  assert.equal(tiny.height, 400);
});

test('junk input returns null', () => {
  assert.equal(clampWindowBounds(null, [PRIMARY]), null);
  assert.equal(clampWindowBounds({ width: 'x', height: 100 }, [PRIMARY]), null);
  assert.equal(clampWindowBounds({ width: 900, height: 670 }, []), null);
});

test('missing x/y restores size only', () => {
  const out = clampWindowBounds({ width: 1100, height: 750 }, [PRIMARY]);
  assert.deepEqual(out, { width: 1100, height: 750 });
});

test('createBoundsSaver debounces rapid schedules into one save and flush is immediate', async () => {
  const saves = [];
  const saver = createBoundsSaver((s) => saves.push(s), 20);
  const snap = () => ({ width: 1, height: 2 });
  saver.schedule(snap);
  saver.schedule(snap);
  saver.schedule(snap);
  assert.equal(saves.length, 0, 'nothing saved before the debounce window');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(saves.length, 1, 'rapid schedules coalesce to one save');
  saver.schedule(snap);
  saver.flush(() => ({ width: 9, height: 9 }));
  assert.equal(saves.length, 2, 'flush cancels the pending timer and saves once');
  assert.deepEqual(saves[1], { width: 9, height: 9 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(saves.length, 2, 'no trailing save after flush');
});

test('a throwing save never propagates', () => {
  const saver = createBoundsSaver(() => { throw new Error('disk'); }, 5);
  assert.doesNotThrow(() => saver.flush(() => ({})));
});

// ── main.js wiring source-scans ─────────────────────────────────────────

test('createWindow restores clamped windowBounds from state', () => {
  assert.ok(MAIN_JS.includes("require('./window-state')"), 'module imported');
  assert.ok(/clampWindowBounds\(savedWinBounds,\s*screen\.getAllDisplays\(\)/.test(MAIN_JS),
    'restore path clamps against the live display set');
  assert.ok(MAIN_JS.includes('readState().windowBounds'), 'bounds read from state');
});

test('geometry saves on debounced resize/move and flushes on close', () => {
  assert.ok(/win\.on\('resize',\s*\(\)\s*=>\s*winBoundsSaver\.schedule/.test(MAIN_JS), 'resize scheduled');
  assert.ok(/win\.on\('move',\s*\(\)\s*=>\s*winBoundsSaver\.schedule/.test(MAIN_JS), 'move scheduled');
  assert.ok(/win\.on\('close',[\s\S]{0,120}winBoundsSaver\.flush/.test(MAIN_JS), 'close flushes');
  assert.ok(MAIN_JS.includes('writeState({ windowBounds: snap })'), 'saved under the windowBounds key');
  assert.ok(MAIN_JS.includes('win.getNormalBounds()'), 'normal bounds saved while maximized');
});

test('fixPath uses the shell-PATH cache and only blocks on first launch', () => {
  assert.ok(MAIN_JS.includes('.merlin-shell-path'), 'cache file present');
  const fnStart = MAIN_JS.indexOf('(function fixPath()');
  const fnEnd = MAIN_JS.indexOf('})();', fnStart);
  const body = MAIN_JS.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'fixPath IIFE found');
  // The synchronous spawn must sit inside the no-cache (else) branch: the
  // cached branch uses the async exec refresh.
  const cachedIdx = body.indexOf('if (cachedShellPath) {');
  const asyncIdx = body.indexOf('exec(pathCmd', cachedIdx);
  const syncIdx = body.indexOf('execSync(pathCmd', cachedIdx);
  assert.ok(cachedIdx > -1, 'cache gate present');
  assert.ok(asyncIdx > cachedIdx, 'cached branch refreshes asynchronously');
  assert.ok(syncIdx > asyncIdx, 'synchronous spawn only in the no-cache branch');
});
