// archive-tiles-clickable.test.js — regression guard for the
// "archive tiles not clickable + sparkle instead of image + stale
// Live status" incident (2026-05-03).
//
// Pre-fix the click handler in renderer.js short-circuited on
// `isStaticCard` (cards rendering the sparkle placeholder because
// neither creativePath nor creativeUrl was populated). For
// externally-running ads whose Meta CDN signed URL had expired
// (~24h old) every tile was a dead pixel — no way to inspect the
// metrics, no way to trigger a refresh, no signal to the user that
// the data was stale. The fix has three parts:
//
//   1. Click handler always opens the preview, falling through to
//      `noThumbnail: true` mode when neither path nor URL is available.
//   2. openArchivePreview's noThumbnail branch shows a metrics panel
//      built from the live-ad object plus a "↻ Refresh thumbnail"
//      action that fires merlin.refreshLiveAds.
//   3. populateArchivePanel renders an archive-staleness-chip when
//      the newest updatedAt is older than 4h, and auto-fires
//      refreshLiveAds once per panel populate to close the freshness
//      loop without user action.
//
// This test pins all three so a future "tighten the click handler"
// or "remove the chip — too noisy" sweep can't silently revert the
// fix.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rendererPath = path.join(__dirname, 'renderer.js');
const stylePath = path.join(__dirname, 'style.css');

test('archive card click handler does NOT short-circuit on isStaticCard', () => {
  const src = fs.readFileSync(rendererPath, 'utf8');
  // Pre-fix bug pattern: `if (isStaticCard) return;` inside the
  // card click handler. This MUST NOT come back.
  assert.doesNotMatch(
    src,
    /card\.addEventListener\(\s*['"]click['"]\s*,\s*\(\s*\)\s*=>\s*\{\s*\n\s*if\s*\(\s*isStaticCard\s*\)\s*return\s*;/,
    'REGRESSION: archive card click handler short-circuits on isStaticCard. The pre-fix behavior left every sparkle-placeholder tile as a dead pixel — no way to inspect metrics or trigger a thumbnail refresh. Remove the early-return.'
  );
});

test('archive card click handler routes sparkle tiles to noThumbnail preview mode', () => {
  const src = fs.readFileSync(rendererPath, 'utf8');
  assert.match(
    src,
    /noThumbnail:\s*true/,
    'archive card click handler must fall through to openArchivePreview({ noThumbnail: true, ad }) when neither creativePath nor creativeUrl is available — gives the user metrics + refresh action instead of a dead pixel.'
  );
});

test('openArchivePreview noThumbnail branch wires the refresh button to refreshLiveAds', () => {
  const src = fs.readFileSync(rendererPath, 'utf8');
  // The refresh-thumbnail button must exist in the source AND its click
  // handler must call merlin.refreshLiveAds. Source-scan ensures the
  // entire chain is intact (button → click → IPC).
  assert.match(src, /preview-refresh-btn/, 'noThumbnail branch must render the .preview-refresh-btn');
  assert.match(src, /↻\s*Refresh thumbnail from Meta/, 'noThumbnail branch must show the refresh-thumbnail label');
  // Look for the refreshLiveAds call inside the click handler. Anchored
  // on the button class to avoid matching unrelated refreshLiveAds calls.
  assert.match(
    src,
    /preview-refresh-btn[\s\S]{0,500}?merlin\.refreshLiveAds/,
    'preview-refresh-btn click handler must call merlin.refreshLiveAds to actually re-fetch the creative URL'
  );
});

test('populateArchivePanel renders the staleness chip + auto-refreshes when stale', () => {
  const src = fs.readFileSync(rendererPath, 'utf8');
  assert.match(src, /archive-staleness-chip/, 'live-ads grid must render an archive-staleness-chip showing the cache age');
  assert.match(src, /STALE_THRESHOLD_MS\s*=\s*4\s*\*\s*60\s*\*\s*60\s*\*\s*1000/, 'staleness threshold must be 4 hours');
  // Auto-refresh path: the chip's stale branch must call refreshLiveAds.
  assert.match(
    src,
    /archive-staleness-chip-stale[\s\S]{0,800}?merlin\.refreshLiveAds/,
    'when the chip enters the stale state, refreshLiveAds must auto-fire so the user does not have to manually click ↻'
  );
  // Auto-refresh guard against firing more than once per populate.
  assert.match(
    src,
    /__merlinAutoRefreshFiredFor/,
    'auto-refresh must guard against firing more than once per populate (refresh-storm protection)'
  );
});

test('style.css carries the preview-refresh-btn + archive-staleness-chip rules', () => {
  const css = fs.readFileSync(stylePath, 'utf8');
  assert.match(css, /\.preview-refresh-btn\s*\{/, 'preview-refresh-btn must have a CSS rule');
  assert.match(css, /\.preview-refresh-btn:disabled/, 'preview-refresh-btn must have a disabled state for the in-flight refresh');
  assert.match(css, /\.archive-staleness-chip\s*\{/, 'archive-staleness-chip must have a CSS rule');
  assert.match(css, /\.archive-staleness-chip-stale/, 'archive-staleness-chip-stale variant must exist for the >4h-old state');
});

test('live-ad metrics panel renders status + spend + CTR fields when present', () => {
  const src = fs.readFileSync(rendererPath, 'utf8');
  // The live-ad metrics panel is what surfaces the ad name + spend +
  // CTR + ROAS + impressions when the user clicks a sparkle-placeholder
  // tile. Without these fields the noThumbnail mode would just be an
  // empty box with a refresh button — useless to the user looking at
  // their ad lineup.
  for (const field of ['adName', 'liveAd.spend', 'liveAd.ctr', 'liveAd.lastRoas', 'liveAd.impressions', 'liveAd.status']) {
    assert.match(
      src,
      new RegExp(field.replace('.', '\\.')),
      `live-ad metrics panel must read ${field} so externally-running ads surface their performance even without a cached thumbnail`
    );
  }
});
