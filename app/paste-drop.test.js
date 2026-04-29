// Unit tests for app/paste-drop.js — the pure helpers the renderer's
// paste/drop chip flow uses. Run with `node app/paste-drop.test.js`.
//
// Coverage:
//   - MIME → extension mapping (paste accepts png/jpeg/webp; rejects gif/svg/html)
//   - file-extension allowlist (drag-drop accepts media; rejects .exe / .pdf / .zip)
//   - PASTED_BLOB_MAX_BYTES is bounded for clipboard payloads
//   - SHA prefix length stays in lockstep with bulk-upload's BULK_SHA_PREFIX_LEN
//   - human-byte formatter for chip labels
//   - filename truncation preserves extension
//   - attachment dedup by absolute path
//   - "Attached files:" message formatter (single, multi, empty, attachments-only)
//   - PASTE_MIME_TO_EXT is a strict subset of the bulk-upload allowlist
//   - case insensitivity on MIME (some clipboards uppercase image/PNG)

'use strict';

const assert = require('node:assert/strict');

const pd = require('./paste-drop');
const { MEDIA_EXT_ALLOWLIST, SHA_PREFIX_LEN } = require('./bulk-upload');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}: ${e.message}`);
    failed++;
  }
}

console.log('paste-drop helpers');

// ── MIME → ext mapping ─────────────────────────────────────────
test('pasteMimeToExt accepts image/png', () => {
  assert.equal(pd.pasteMimeToExt('image/png'), 'png');
});
test('pasteMimeToExt accepts image/jpeg', () => {
  assert.equal(pd.pasteMimeToExt('image/jpeg'), 'jpg');
});
test('pasteMimeToExt accepts image/webp', () => {
  assert.equal(pd.pasteMimeToExt('image/webp'), 'webp');
});
test('pasteMimeToExt is case-insensitive (some clipboards uppercase the MIME)', () => {
  assert.equal(pd.pasteMimeToExt('IMAGE/PNG'), 'png');
  assert.equal(pd.pasteMimeToExt('Image/Jpeg'), 'jpg');
});
test('pasteMimeToExt rejects non-image MIMEs', () => {
  assert.equal(pd.pasteMimeToExt('text/html'), null);
  assert.equal(pd.pasteMimeToExt('application/pdf'), null);
  assert.equal(pd.pasteMimeToExt('image/svg+xml'), null);
  assert.equal(pd.pasteMimeToExt('image/gif'), null);
  assert.equal(pd.pasteMimeToExt(''), null);
  assert.equal(pd.pasteMimeToExt(null), null);
  assert.equal(pd.pasteMimeToExt(undefined), null);
});

// ── PASTE_MIME_TO_EXT must be a strict subset of bulk-upload allowlist ─
test('every PASTE_MIME_TO_EXT extension is also accepted by bulk-upload', () => {
  for (const ext of Object.values(pd.PASTE_MIME_TO_EXT)) {
    assert.ok(
      MEDIA_EXT_ALLOWLIST.has(`.${ext}`),
      `paste accepts .${ext} but bulk-upload doesn't — chip would land then IPC would reject`,
    );
  }
});

// ── Drag-drop extension allowlist ──────────────────────────────
test('hasMediaExt accepts standard image / video extensions', () => {
  for (const name of ['photo.png', 'photo.PNG', 'photo.jpg', 'photo.jpeg', 'photo.gif',
                       'photo.webp', 'photo.heic', 'photo.HEIF', 'clip.mp4', 'clip.MOV',
                       'clip.webm', 'clip.m4v', 'clip.avi']) {
    assert.ok(pd.hasMediaExt(name), `expected ${name} to be accepted`);
  }
});
test('hasMediaExt rejects executables, archives, docs', () => {
  for (const name of ['malware.exe', 'archive.zip', 'doc.pdf', 'page.html', 'script.js',
                       'image.svg', 'image.bmp', 'noext']) {
    assert.ok(!pd.hasMediaExt(name), `expected ${name} to be rejected`);
  }
});
test('hasMediaExt rejects non-string input', () => {
  assert.equal(pd.hasMediaExt(null), false);
  assert.equal(pd.hasMediaExt(undefined), false);
  assert.equal(pd.hasMediaExt(123), false);
  assert.equal(pd.hasMediaExt({}), false);
});

// ── Size cap ───────────────────────────────────────────────────
test('PASTED_BLOB_MAX_BYTES is 25 MB', () => {
  assert.equal(pd.PASTED_BLOB_MAX_BYTES, 25 * 1024 * 1024);
});
test('ATTACHMENT_MAX_BYTES_PER_FILE matches bulk-upload (500 MB)', () => {
  // Drag-drop chip cap and IPC backend cap MUST agree — otherwise the chip
  // accepts a file the IPC will later reject, surfacing a delayed error.
  assert.equal(pd.ATTACHMENT_MAX_BYTES_PER_FILE, 500 * 1024 * 1024);
});

// ── SHA prefix consistency (REGRESSION GUARD on bulk-upload PR #140) ──
test('BULK_SHA_PREFIX_LEN re-exported = bulk-upload SHA_PREFIX_LEN', () => {
  assert.equal(pd.BULK_SHA_PREFIX_LEN, SHA_PREFIX_LEN);
  assert.equal(pd.BULK_SHA_PREFIX_LEN, 16);
});

// ── formatBytes ────────────────────────────────────────────────
test('formatBytes < 1 KB shows bytes', () => {
  assert.equal(pd.formatBytes(0), '0 B');
  assert.equal(pd.formatBytes(512), '512 B');
});
test('formatBytes KB rounds to integer', () => {
  assert.equal(pd.formatBytes(1024), '1 KB');
  assert.equal(pd.formatBytes(1536), '2 KB');
  assert.equal(pd.formatBytes(900 * 1024), '900 KB');
});
test('formatBytes MB rounds to 1 decimal', () => {
  assert.equal(pd.formatBytes(1.2 * 1024 * 1024), '1.2 MB');
  assert.equal(pd.formatBytes(15 * 1024 * 1024), '15.0 MB');
});
test('formatBytes rejects bad input', () => {
  assert.equal(pd.formatBytes(NaN), '');
  assert.equal(pd.formatBytes(-1), '');
  assert.equal(pd.formatBytes(undefined), '');
  assert.equal(pd.formatBytes('hello'), '');
});

// ── truncateName ───────────────────────────────────────────────
test('truncateName leaves short names alone', () => {
  assert.equal(pd.truncateName('photo.png'), 'photo.png');
});
test('truncateName preserves extension on long names', () => {
  const out = pd.truncateName('campaign_overview_final_v3.png', 24);
  assert.ok(out.endsWith('.png'), `expected .png to be preserved, got "${out}"`);
  assert.ok(out.includes('…'), `expected ellipsis, got "${out}"`);
});
test('truncateName handles names without extensions', () => {
  const out = pd.truncateName('a-very-long-filename-with-no-extension', 12);
  assert.equal(out.length, 12);
  assert.ok(out.endsWith('…'));
});

// ── shouldAddAttachment (dedup) ────────────────────────────────
test('shouldAddAttachment accepts new path', () => {
  assert.equal(
    pd.shouldAddAttachment([{ path: '/a/b.png' }], { path: '/c/d.png' }),
    true,
  );
});
test('shouldAddAttachment rejects duplicate path', () => {
  assert.equal(
    pd.shouldAddAttachment([{ path: '/a/b.png' }, { path: '/c/d.png' }], { path: '/a/b.png' }),
    false,
  );
});
test('shouldAddAttachment rejects empty / missing path', () => {
  assert.equal(pd.shouldAddAttachment([], { path: '' }), false);
  assert.equal(pd.shouldAddAttachment([], {}), false);
  assert.equal(pd.shouldAddAttachment([], null), false);
});

// ── formatAttachmentsForMessage ────────────────────────────────
test('formatAttachmentsForMessage: empty attachments returns text unchanged', () => {
  assert.equal(pd.formatAttachmentsForMessage('hello', []), 'hello');
  assert.equal(pd.formatAttachmentsForMessage('', []), '');
});
test('formatAttachmentsForMessage: text + 1 file', () => {
  const out = pd.formatAttachmentsForMessage('look at this', [{ path: '/a/b.png' }]);
  assert.equal(out, 'look at this\n\nAttached file:\n- /a/b.png');
});
test('formatAttachmentsForMessage: text + multiple files uses plural header', () => {
  const out = pd.formatAttachmentsForMessage(
    'sort these',
    [{ path: '/a/1.png' }, { path: '/a/2.png' }],
  );
  assert.equal(out, 'sort these\n\nAttached files:\n- /a/1.png\n- /a/2.png');
});
test('formatAttachmentsForMessage: attachments-only (no typed text) returns only block', () => {
  const out = pd.formatAttachmentsForMessage('', [{ path: '/a/b.png' }]);
  assert.equal(out, 'Attached file:\n- /a/b.png');
});
test('formatAttachmentsForMessage: whitespace-only text treated as empty', () => {
  const out = pd.formatAttachmentsForMessage('   \n  ', [{ path: '/a/b.png' }]);
  assert.equal(out, 'Attached file:\n- /a/b.png');
});
test('formatAttachmentsForMessage: gracefully handles malformed entries', () => {
  const out = pd.formatAttachmentsForMessage('hi', [{ path: '/a/b.png' }, null, {}]);
  // A malformed entry contributes an empty path line — never a crash.
  assert.ok(out.includes('/a/b.png'));
  assert.ok(out.startsWith('hi\n\nAttached files:'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
