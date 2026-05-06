// Source-scan regression guard for the merlin:// protocol handler's
// 0-byte file handling.
//
// REGRESSION GUARD (2026-05-06, image-card-unavailable incident):
// Live user report: "Image still appears as unavailable once rendered
// with the card style." The Go binary's image pipeline emits the
// gallery sentinel slightly before the bytes hit disk on Windows
// (during atomic write or partial flush window). Pre-fix the merlin://
// handler stat()ed the file, saw size=0, and returned 200 OK with an
// empty body — the browser treated the empty content-type=image
// response as a successful load (no `error` event), but rendered
// nothing visible. The user saw an empty card forever.
//
// Fix: reject 0-byte files with HTTP 425 Too Early. The browser fires
// `error` on the IMG, which the stack's retry-on-error path
// (gallery-viewer.js, see gallery-viewer.test.js) picks up and re-tries
// after 600ms — enough time for the producer-side write to complete.
//
// This test source-scans main.js to lock the fix in. Without the
// 0-byte rejection, the retry path can never recover from this race
// (because no `error` ever fires), so the regression guard is
// load-bearing.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('merlin:// handler rejects 0-byte files with HTTP 425 Too Early', () => {
  // Find the merlin:// protocol handler region.
  const handlerStart = MAIN_JS.indexOf("protocol.handle('merlin'");
  assert.ok(handlerStart > 0, "protocol.handle('merlin', ...) must exist");
  // Take a generous slice — the handler is ~150 lines.
  const handler = MAIN_JS.slice(handlerStart, handlerStart + 6000);

  // The 0-byte check must exist with status 425.
  assert.ok(/stat\.size\s*===\s*0/.test(handler),
    'handler must check stat.size === 0 to detect not-yet-written files');
  assert.ok(/status:\s*425/.test(handler),
    'handler must return HTTP 425 (Too Early) on 0-byte files so the browser fires `error` and the IMG retry path fires');

  // The 0-byte check must run AFTER the stat() but BEFORE the
  // streaming response is built — otherwise we'd ship an empty body
  // with a 200 OK header.
  const statIdx = handler.search(/fs\.statSync\(filePath\)/);
  const zeroIdx = handler.search(/stat\.size\s*===\s*0/);
  const streamIdx = handler.search(/fs\.createReadStream\(filePath/);
  assert.ok(statIdx > 0 && zeroIdx > 0 && streamIdx > 0,
    'handler must contain stat, 0-byte check, and stream construction');
  assert.ok(statIdx < zeroIdx,
    '0-byte check must run AFTER fs.statSync (needs the size)');
  assert.ok(zeroIdx < streamIdx,
    '0-byte check must run BEFORE createReadStream — otherwise we stream an empty body with 200 OK and the browser silently renders nothing');
});

test('REGRESSION GUARD comment names the image-card-unavailable incident', () => {
  // Locking the comment to the incident date + name keeps the
  // regression-guard intent grep-able. If a future edit removes the
  // 0-byte check without updating this anchor, both tests fail.
  assert.ok(MAIN_JS.includes('image-card-unavailable'),
    'main.js must carry an "image-card-unavailable" REGRESSION GUARD comment anchor');
});
