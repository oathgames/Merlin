// window-state.js: persist and restore the main BrowserWindow geometry.
//
// Audit finding (2026-07-11, Fable audit F7): every launch reset the window
// to the hardcoded 900x670 because nothing saved getBounds(). Every S-tier
// desktop app (Slack, Linear, Notion, 1Password) restores size, position,
// and maximized state across launches.
//
// Pure helpers live here so the clamp logic is unit-testable without
// Electron. main.js wires them: restore in createWindow (clamped against
// the live display set so a detached monitor can never strand the window
// off-screen), save on debounced resize/move and a final flush on close,
// stored under the windowBounds key of .merlin-state.json.
'use strict';

// Pixels of the window's top strip (title bar / drag region) that must stay
// on some display for a saved position to be trusted.
const VISIBLE_STRIP = 48;

function isFiniteNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// Validate saved bounds against the current display set.
// Returns:
//   {x, y, width, height}  when the saved position still shows enough of the
//                          title bar on some display
//   {width, height}        when the size is usable but the position is stale
//                          (detached monitor); Electron centers the window
//                          when x/y are omitted from BrowserWindow options
//   null                   when the saved value is unusable
function clampWindowBounds(saved, displays, { minWidth = 500, minHeight = 400 } = {}) {
  if (!saved || typeof saved !== 'object') return null;
  const { x, y } = saved;
  let { width, height } = saved;
  if (!isFiniteNum(width) || !isFiniteNum(height)) return null;
  const areas = (displays || []).map((d) => d && d.workArea).filter(Boolean);
  if (!areas.length) return null;
  const maxW = Math.max(...areas.map((a) => a.width));
  const maxH = Math.max(...areas.map((a) => a.height));
  width = Math.min(Math.max(Math.round(width), minWidth), maxW);
  height = Math.min(Math.max(Math.round(height), minHeight), maxH);
  if (!isFiniteNum(x) || !isFiniteNum(y)) return { width, height };
  const onScreen = areas.some((a) =>
    x + width > a.x + VISIBLE_STRIP &&
    x < a.x + a.width - VISIBLE_STRIP &&
    y >= a.y - 8 &&
    y < a.y + a.height - VISIBLE_STRIP);
  return onScreen ? { x: Math.round(x), y: Math.round(y), width, height } : { width, height };
}

// Debounced save with a final synchronous flush for the close path. save()
// failures are swallowed: geometry persistence is never worth a crash.
function createBoundsSaver(save, delayMs = 600) {
  let timer = null;
  const run = (snapshot) => {
    try { save(snapshot()); } catch { /* best effort */ }
  };
  return {
    schedule(snapshot) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; run(snapshot); }, delayMs);
      if (timer.unref) timer.unref();
    },
    flush(snapshot) {
      if (timer) { clearTimeout(timer); timer = null; }
      run(snapshot);
    },
  };
}

module.exports = { clampWindowBounds, createBoundsSaver, VISIBLE_STRIP };
