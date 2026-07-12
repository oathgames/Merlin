// Unit tests for archive-scanner.js. Run with `node app/archive-scanner.test.js`.
//
// Scenario coverage:
//   1. Standard run folder (ad_YYYYMMDD_HHMMSS with video.mp4 + metadata.json)
//   2. Loose seedance video in brand subfolder (the reported bug)
//   3. Loose image in brand subfolder
//   4. Video with sibling *_thumbnail.jpg (picks the thumbnail, doesn't double-count)
//   5. Corrupted run folder (<10KB video) — skipped
//   6. Cache hit / miss (adding a loose file invalidates the cache)
//   7. Brand inference from folder path
//   8. Filter by type/brand/search
//
// No mocks — exercises the real scanner against a real tmp directory.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');

const { scanArchive, invalidateScanCache, inferBrandFromPath, prettifyTitle } = require('./archive-scanner');

let passed = 0;
let failed = 0;

// Async-aware sequential runner (scanArchive went async in the 2026-07-11
// audit fix): tests queue onto a promise chain and run one at a time, in
// declaration order, awaiting each body.
let _chain = Promise.resolve();
function test(name, fn) {
  _chain = _chain.then(async () => {
    // RSI-archive-perf iter 1, fix 1-1: clear the in-memory walk cache before
    // every test. In production the watcher invalidates whenever results/
    // changes; tests don't run a watcher, so the cache would carry stale data
    // between independent fixture setups.
    try { invalidateScanCache(); } catch {}
    try {
      await fn();
      console.log('  ✓', name);
      passed++;
    } catch (err) {
      console.log('  ✗', name);
      console.log('   ', err.message);
      if (err.stack) console.log('   ', err.stack.split('\n').slice(1, 4).join('\n    '));
      failed++;
    }
  });
}

function makeTmpRoot() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-archive-test-'));
  fs.mkdirSync(path.join(tmpRoot, 'results'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'assets', 'brands', 'ivory-ella'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'assets', 'brands', 'madchill'), { recursive: true });
  return tmpRoot;
}

function cleanup(tmpRoot) {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

function writeBuf(p, bytes) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 0x20));
}

// Build a realistic fake results/ tree covering every scenario
function setupFixture(tmpRoot) {
  const R = path.join(tmpRoot, 'results');

  // 1. Standard run folder — ad_20260414_120000/ with video + metadata + portrait
  const run1 = path.join(R, 'video', '2026-04', 'ivory-ella', 'ad_20260414_120000');
  writeBuf(path.join(run1, 'video.mp4'), 2_000_000);
  writeBuf(path.join(run1, 'portrait.jpg'), 50_000);
  fs.writeFileSync(path.join(run1, 'metadata.json'), JSON.stringify({
    brand: 'ivory-ella',
    product: 'Summer Tee',
    model: 'fal-ai/seedance-2/text-to-video',
    qaPassed: true,
    createdAt: '2026-04-14T12:00:00Z',
  }));

  // 2. Loose seedance video (the reported bug). No metadata, no thumbnail.
  const looseDir = path.join(R, 'video', '2026-04', 'ivory-ella');
  writeBuf(path.join(looseDir, 'seedance_ivory_ella.mp4'), 1_500_000);
  writeBuf(path.join(looseDir, 'seedance_thumbnail.jpg'), 30_000);

  // 3. Loose image at top level
  writeBuf(path.join(R, 'image', '2026-04', 'madchill', 'banner.png'), 100_000);

  // 4. Standard img_ folder with square + portrait
  const run4 = path.join(R, 'image', '2026-04', 'madchill', 'img_20260414_130000');
  writeBuf(path.join(run4, 'portrait.jpg'), 80_000);
  writeBuf(path.join(run4, 'square.jpg'), 75_000);
  fs.writeFileSync(path.join(run4, 'metadata.json'), JSON.stringify({
    brand: 'madchill',
    product: 'Streetwear Hoodie',
    qaPassed: false, // failed QA — should surface ✗ badge
  }));

  // 5. Corrupted video — file present but <10KB
  const run5 = path.join(R, 'video', '2026-04', 'madchill', 'ad_20260414_140000');
  writeBuf(path.join(run5, 'video.mp4'), 500); // way too small

  // 6. Orphan video elsewhere (no brand in path)
  writeBuf(path.join(R, 'orphans', 'mystery_video.mp4'), 900_000);

  // 7. Empty folder
  fs.mkdirSync(path.join(R, 'video', '2026-04', 'empty-brand'), { recursive: true });

  // 8. Transient/ignored artifacts — should NOT appear in the archive
  //    - pasted_*.png: user-pasted chat input
  //    - clipboard_*.jpg: clipboard helper
  //    - anything under logo/ or tmp/ subfolders
  //    - *.partial: half-downloaded files
  writeBuf(path.join(R, 'pasted_1776085824996.png'), 200_000);
  writeBuf(path.join(R, 'clipboard_123.jpg'), 150_000);
  writeBuf(path.join(R, 'logo', 'brand-logo.png'), 80_000);
  writeBuf(path.join(R, 'tmp', 'download.mp4'), 500_000);
  writeBuf(path.join(R, 'video', '2026-04', 'incomplete.mp4.partial'), 400_000);
}

// ── Tests ──

console.log('\narchive-scanner.test.js\n');

test('inferBrandFromPath matches known brand segment', async () => {
  const brands = new Set(['ivory-ella', 'madchill']);
  assert.strictEqual(inferBrandFromPath('results/video/2026-04/ivory-ella/seedance.mp4', brands), 'ivory-ella');
  assert.strictEqual(inferBrandFromPath('results/image/madchill/banner.png', brands), 'madchill');
  assert.strictEqual(inferBrandFromPath('results/random/path/file.mp4', brands), '');
});

test('prettifyTitle handles kebab/snake case', async () => {
  assert.strictEqual(prettifyTitle('seedance_ivory_ella.mp4'), 'Seedance Ivory Ella');
  assert.strictEqual(prettifyTitle('my-cool-product.png'), 'My Cool Product');
});

test('scanArchive discovers standard ad_ run folders', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const items = await scanArchive(tmp);
    const run1 = items.find(i => i.id === 'ad_20260414_120000');
    assert.ok(run1, 'ad_20260414_120000 should be present');
    assert.strictEqual(run1.type, 'video');
    assert.strictEqual(run1.brand, 'ivory-ella');
    assert.strictEqual(run1.product, 'Summer Tee');
    assert.strictEqual(run1.qaPassed, true);
    assert.strictEqual(run1.source, 'run');
  } finally { cleanup(tmp); }
});

test('scanArchive discovers loose seedance video (the reported bug)', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const items = await scanArchive(tmp);
    const loose = items.find(i => i.id && i.id.endsWith('seedance_ivory_ella.mp4'));
    assert.ok(loose, 'Loose seedance video should surface in the archive');
    assert.strictEqual(loose.type, 'video');
    assert.strictEqual(loose.brand, 'ivory-ella', 'Brand should be inferred from folder path');
    assert.strictEqual(loose.source, 'loose');
    assert.ok(loose.thumbnail && loose.thumbnail.endsWith('seedance_thumbnail.jpg'),
      'Sibling *_thumbnail.jpg should be picked up as the thumbnail, got: ' + loose.thumbnail);
  } finally { cleanup(tmp); }
});

test('scanArchive does NOT double-count video thumbnail as a separate image item', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const items = await scanArchive(tmp);
    // There should be exactly one entry for seedance_thumbnail.jpg (as the thumbnail of the video),
    // not a separate image entry.
    const thumbsAsImages = items.filter(i => i.type === 'image' && i.id && i.id.endsWith('seedance_thumbnail.jpg'));
    assert.strictEqual(thumbsAsImages.length, 0, 'Thumbnail should not appear as a standalone image');
  } finally { cleanup(tmp); }
});

test('scanArchive picks up standard img_ run folder with qaPassed=false', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const items = await scanArchive(tmp);
    const img = items.find(i => i.id === 'img_20260414_130000');
    assert.ok(img, 'img_20260414_130000 should be present');
    assert.strictEqual(img.type, 'image');
    assert.strictEqual(img.qaPassed, false);
    assert.ok(/portrait\.jpg$/.test(img.thumbnail), 'Should prefer portrait for thumb');
  } finally { cleanup(tmp); }
});

test('scanArchive discovers loose image in brand subfolder', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const items = await scanArchive(tmp);
    const banner = items.find(i => i.id && i.id.endsWith('banner.png'));
    assert.ok(banner, 'Loose banner.png should be present');
    assert.strictEqual(banner.type, 'image');
    assert.strictEqual(banner.brand, 'madchill');
    assert.strictEqual(banner.source, 'loose');
  } finally { cleanup(tmp); }
});

test('scanArchive drops corrupted runs (<10KB video)', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const items = await scanArchive(tmp);
    const corrupted = items.find(i => i.id === 'ad_20260414_140000');
    assert.strictEqual(corrupted, undefined, 'Corrupted run folder must be dropped');
  } finally { cleanup(tmp); }
});

test('scanArchive finds orphan videos with no brand', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const items = await scanArchive(tmp);
    const orphan = items.find(i => i.id && i.id.endsWith('mystery_video.mp4'));
    assert.ok(orphan, 'Orphan video with no brand in path should still surface');
    assert.strictEqual(orphan.brand, '', 'Brand inference should return empty when no known brand in path');
  } finally { cleanup(tmp); }
});

test('scanArchive skips empty folders', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const items = await scanArchive(tmp);
    const empty = items.find(i => i.id && i.id.includes('empty-brand'));
    assert.strictEqual(empty, undefined);
  } finally { cleanup(tmp); }
});

test('scanArchive caches results and reuses them on unchanged tree (on-disk cache layer)', async () => {
  // This test exercises the ON-DISK cache layer (archive-index.json),
  // which is the secondary cache below the in-memory walk cache. We
  // invalidate the in-memory cache between calls to force the scanner
  // through the walk → hash-compare → on-disk-cache fast path.
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const firstRun = await scanArchive(tmp);
    // Cache file should exist now
    const cachePath = path.join(tmp, 'results', 'archive-index.json');
    assert.ok(fs.existsSync(cachePath), 'Cache file should be written');
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.ok(cached.hash, 'Cache should have a hash');
    assert.strictEqual(cached.items.length, firstRun.length);

    // Second call should hit the on-disk cache — we detect this by
    // corrupting the on-disk cache's items list and confirming the
    // scanner returns the corrupted data (proving it didn't rebuild from
    // disk). Invalidate the in-memory cache first so we're testing the
    // on-disk path specifically.
    cached.items[0].product = 'CACHE_SENTINEL';
    fs.writeFileSync(cachePath, JSON.stringify(cached));
    invalidateScanCache();
    const secondRun = await scanArchive(tmp);
    assert.ok(secondRun.some(i => i.product === 'CACHE_SENTINEL'), 'On-disk cache hit should be used after in-memory invalidation');
  } finally { cleanup(tmp); }
});

test('scanArchive invalidates cache when a loose file is added', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    await scanArchive(tmp); // prime cache

    // Add a new loose video
    writeBuf(path.join(tmp, 'results', 'video', '2026-04', 'ivory-ella', 'veo3_new.mp4'), 1_100_000);
    // Bump the mtime of the containing directory for good measure
    const newTime = new Date();
    fs.utimesSync(path.join(tmp, 'results', 'video', '2026-04', 'ivory-ella'), newTime, newTime);
    // In production this happens via the results-watcher's onChange
    // callback; here we call it directly to simulate the same signal.
    invalidateScanCache();

    const rescanned = await scanArchive(tmp);
    const found = rescanned.find(i => i.id && i.id.endsWith('veo3_new.mp4'));
    assert.ok(found, 'New loose video should appear after rescan');
  } finally { cleanup(tmp); }
});

// RSI-archive-perf iter 1, fix 1-1: verify the in-memory walk cache
// short-circuits the walk entirely when the cache is hot (no invalidation
// between calls). This is the load-bearing perf win.
test('scanArchive in-memory cache returns instantly on repeated calls', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    invalidateScanCache();
    const cold = await scanArchive(tmp); // populates cache

    // Now corrupt the ON-DISK cache file. If the in-memory layer is
    // working, the scanner should NEVER look at the on-disk cache —
    // it should return the in-memory items unchanged.
    const cachePath = path.join(tmp, 'results', 'archive-index.json');
    const onDisk = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    onDisk.items.forEach(i => { i.product = 'ON_DISK_CORRUPTED'; });
    fs.writeFileSync(cachePath, JSON.stringify(onDisk));

    const hot = await scanArchive(tmp);
    assert.strictEqual(hot.length, cold.length, 'Same item count from hot cache');
    assert.ok(!hot.some(i => i.product === 'ON_DISK_CORRUPTED'),
      'In-memory cache must short-circuit the on-disk cache read');
  } finally { cleanup(tmp); }
});

test('scanArchive in-memory cache survives across filter changes', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    invalidateScanCache();
    const all = await scanArchive(tmp);
    const videos = await scanArchive(tmp, { type: 'video' });
    const images = await scanArchive(tmp, { type: 'image' });
    // Cache holds the unfiltered list; each call re-applies filters cheaply.
    assert.ok(videos.length > 0, 'video filter still returns videos');
    assert.ok(images.length > 0, 'image filter still returns images');
    assert.strictEqual(videos.length + images.length, all.length,
      'video + image must equal unfiltered count');
    assert.ok(videos.every(v => v.type === 'video'), 'video filter applied');
    assert.ok(images.every(i => i.type === 'image'), 'image filter applied');
  } finally { cleanup(tmp); }
});

test('invalidateScanCache forces a fresh walk on the next call', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    await scanArchive(tmp); // prime cache

    // Add a file the cache doesn't know about.
    writeBuf(path.join(tmp, 'results', 'video', '2026-04', 'ivory-ella', 'fresh.mp4'), 1_200_000);

    // Without invalidation, cache hides the new file (this is the perf win).
    const stale = await scanArchive(tmp);
    assert.ok(!stale.some(i => i.id && i.id.endsWith('fresh.mp4')),
      'In-memory cache must not re-walk without invalidation');

    // Watcher would call invalidateScanCache; simulate it.
    invalidateScanCache();
    const fresh = await scanArchive(tmp);
    assert.ok(fresh.some(i => i.id && i.id.endsWith('fresh.mp4')),
      'Post-invalidation scan must surface the new file');
  } finally { cleanup(tmp); }
});

test('scanArchive filters by type', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const videos = await scanArchive(tmp, { type: 'video' });
    const images = await scanArchive(tmp, { type: 'image' });
    assert.ok(videos.every(i => i.type === 'video'));
    assert.ok(images.every(i => i.type === 'image'));
    assert.ok(videos.length > 0);
    assert.ok(images.length > 0);
  } finally { cleanup(tmp); }
});

test('scanArchive filters by brand', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const filtered = await scanArchive(tmp, { brand: 'ivory-ella' });
    assert.ok(filtered.length > 0);
    assert.ok(filtered.every(i => i.brand === 'ivory-ella'));
  } finally { cleanup(tmp); }
});

test('scanArchive filters by search text across brand/product/model/id', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const hit = await scanArchive(tmp, { search: 'seedance' });
    assert.ok(hit.some(i => i.id.includes('seedance') || (i.model && i.model.includes('seedance'))),
      'Search should match seedance in id or model');
  } finally { cleanup(tmp); }
});

test('scanArchive ignores pasted_ / clipboard_ / logo/ / tmp/ / *.partial', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const items = await scanArchive(tmp);
    assert.ok(!items.some(i => i.id.includes('pasted_')), 'pasted_ files should be ignored');
    assert.ok(!items.some(i => i.id.includes('clipboard_')), 'clipboard_ files should be ignored');
    assert.ok(!items.some(i => i.id.includes('/logo/')), 'logo/ directory should be ignored');
    assert.ok(!items.some(i => i.id.includes('/tmp/')), 'tmp/ directory should be ignored');
    assert.ok(!items.some(i => i.id.includes('.partial')), '.partial files should be ignored');
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: .partial regex must not false-positive on mid-string matches', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    // "foo.partial.mp4" is a legitimate video name with .partial mid-string.
    // The ignore regex must be end-anchored (.partial$), not substring.
    writeBuf(path.join(tmp, 'results', 'video', '2026-04', 'ivory-ella', 'foo.partial.mp4'), 1_200_000);
    const items = await scanArchive(tmp);
    const hit = items.find(i => i.id && i.id.endsWith('foo.partial.mp4'));
    assert.ok(hit, 'foo.partial.mp4 must be surfaced — .partial only matches as the final extension');
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: foo.mp4.partial IS ignored (incomplete download)', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    writeBuf(path.join(tmp, 'results', 'video', '2026-04', 'ivory-ella', 'incomplete.mp4.partial'), 800_000);
    const items = await scanArchive(tmp);
    assert.ok(!items.some(i => i.id.includes('incomplete.mp4.partial')), 'Final .partial extension must be ignored');
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: editor backup files (foo.jpg~) are ignored', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    writeBuf(path.join(tmp, 'results', 'image', '2026-04', 'madchill', 'draft.png~'), 50_000);
    const items = await scanArchive(tmp);
    assert.ok(!items.some(i => i.id.endsWith('.png~')), 'Editor backup files must be ignored');
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: integer overflow, two mtimes 49.7 days apart must NOT collide', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    // Prime the cache
    await scanArchive(tmp);

    // Craft two files whose mtimes differ by exactly 2^32 ms (49.71 days).
    // With the old `mtime|0` hash, these would coerce to the same int32 and
    // collide. With Math.floor, they must hash differently.
    const file = path.join(tmp, 'results', 'video', '2026-04', 'ivory-ella', 'overflow_test.mp4');
    writeBuf(file, 1_000_000);
    const now = new Date();
    fs.utimesSync(file, now, now);
    // Watcher would invalidate on file create; simulate.
    invalidateScanCache();
    // Record the items from the first scan (mtime A)
    const firstScan = await scanArchive(tmp);
    const firstHit = firstScan.find(i => i.id && i.id.endsWith('overflow_test.mp4'));
    assert.ok(firstHit, 'File should surface with mtime A');
    const mtimeA = firstHit.timestamp;

    // Set mtime exactly 2^32 ms later
    const later = new Date(now.getTime() + 4294967296);
    fs.utimesSync(file, later, later);
    // Watcher would invalidate on mtime change; tests must simulate.
    invalidateScanCache();
    const secondScan = await scanArchive(tmp);
    const secondHit = secondScan.find(i => i.id && i.id.endsWith('overflow_test.mp4'));
    assert.ok(secondHit, 'File should still surface after mtime bump');
    assert.notStrictEqual(secondHit.timestamp, mtimeA, 'Timestamps must differ — cache must have been invalidated');
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: adding a new brand folder busts the cache', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    // Drop a loose file under a folder whose name is not yet a known brand
    const looseDir = path.join(tmp, 'results', 'video', '2026-04', 'new-brand');
    writeBuf(path.join(looseDir, 'preview.mp4'), 900_000);

    // First scan: "new-brand" isn't in assets/brands yet → brand field empty
    const first = await scanArchive(tmp);
    const firstHit = first.find(i => i.id.endsWith('preview.mp4'));
    assert.ok(firstHit);
    assert.strictEqual(firstHit.brand, '', 'Brand should be empty before the brand folder exists');

    // Create the brand folder
    fs.mkdirSync(path.join(tmp, 'assets', 'brands', 'new-brand'), { recursive: true });
    // The brand folder is OUTSIDE results/, so the production watcher
    // (which watches results/) wouldn't fire. Brand-create paths in
    // main.js explicitly invalidate the scan cache (see brand-onboarding
    // flow); tests must do the same.
    invalidateScanCache();

    // Second scan: the cache MUST be busted by the brand-list change so the
    // loose file gets re-inferred with the new brand.
    const second = await scanArchive(tmp);
    const secondHit = second.find(i => i.id.endsWith('preview.mp4'));
    assert.ok(secondHit);
    assert.strictEqual(secondHit.brand, 'new-brand', 'Brand should be inferred after the folder is created');
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: scanner handles null/undefined appRoot without throwing', async () => {
  assert.deepStrictEqual(await scanArchive(null), []);
  assert.deepStrictEqual(await scanArchive(undefined), []);
  assert.deepStrictEqual(await scanArchive(''), []);
  assert.deepStrictEqual(await scanArchive(42), []);
  assert.deepStrictEqual(await scanArchive({}), []);
});

test('ADVERSARIAL: scanner handles non-existent results dir without throwing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-archive-missing-'));
  try {
    // No results/ subfolder
    assert.deepStrictEqual(await scanArchive(tmp), []);
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: atomic write leaves no stray .tmp sidecars in the archive', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    // Run the scanner several times in a row — each write goes through
    // atomicWriteFile, which creates a unique tmp sidecar then renames.
    for (let i = 0; i < 5; i++) await scanArchive(tmp);

    // No archive-index.json.*.tmp files should remain
    const resultsEntries = fs.readdirSync(path.join(tmp, 'results'));
    const strays = resultsEntries.filter(f => /archive-index\.json\..*\.tmp$/.test(f));
    assert.strictEqual(strays.length, 0, 'No stray .tmp sidecars should remain after atomic writes');
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: scanner ignores a synthesized archive-index.json.abc123.tmp in results/', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    // Simulate an interrupted atomic write leaving a stray tmp file.
    // The tmp file happens to be a JSON blob, but the scanner must ignore
    // it regardless (walked as a non-media file anyway, but we want to be
    // explicit about tmp sidecar safety).
    fs.writeFileSync(path.join(tmp, 'results', 'archive-index.json.deadbeef.tmp'), '{"hash":"x","items":[]}');
    const items = await scanArchive(tmp);
    // Scanner should still produce real items, not be confused by the tmp
    assert.ok(items.length > 0, 'Real items should still appear');
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: XSS-ish filenames (<, >, ") surface without throwing', async () => {
  // Filenames with < > " are only valid on POSIX filesystems. Skip on Windows.
  if (process.platform === 'win32') return;
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const naughty = 'weird<script>alert(1)</script>.mp4';
    writeBuf(path.join(tmp, 'results', 'video', '2026-04', 'ivory-ella', naughty), 1_200_000);
    const items = await scanArchive(tmp);
    const hit = items.find(i => i.id && i.id.includes('<script>'));
    assert.ok(hit, 'Scanner must not crash on weird filenames');
    // The scanner doesn't escape — that's the renderer's job. Just ensure the
    // raw path flows through without corruption.
    assert.ok(hit.thumbnail === '' || typeof hit.thumbnail === 'string');
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: duplicate ad_* folder at different depths does not double-count', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    // Two ad_ folders with the same basename at different paths — this is
    // physically possible if a user moves folders around. The scanner keys
    // runs by relative path, not basename, so both should be distinct items.
    const a = path.join(tmp, 'results', 'ad_20260414_999999');
    const b = path.join(tmp, 'results', 'archive', '2026-04', 'ad_20260414_999999');
    writeBuf(path.join(a, 'video.mp4'), 1_500_000);
    fs.writeFileSync(path.join(a, 'metadata.json'), JSON.stringify({ brand: 'a', product: 'A' }));
    writeBuf(path.join(b, 'video.mp4'), 1_500_000);
    fs.writeFileSync(path.join(b, 'metadata.json'), JSON.stringify({ brand: 'b', product: 'B' }));
    const items = await scanArchive(tmp);
    const hits = items.filter(i => i.id === 'ad_20260414_999999');
    assert.strictEqual(hits.length, 2, 'Two run folders with same basename at different paths should both surface');
    const folders = new Set(hits.map(i => i.folder));
    assert.strictEqual(folders.size, 2, 'Distinct folder paths must be preserved');
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: video file under a deeply nested path surfaces', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    // Depth: results/ > a/ > b/ > c/ > d/ > file.mp4 — 5 levels deep
    // Within ARCHIVE_MAX_DEPTH (6) so should surface.
    const deep = path.join(tmp, 'results', 'a', 'b', 'c', 'd');
    writeBuf(path.join(deep, 'file.mp4'), 1_200_000);
    const items = await scanArchive(tmp);
    const hit = items.find(i => i.id && i.id.endsWith('file.mp4'));
    assert.ok(hit, 'Deeply nested but within-depth file should surface');
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: beyond-depth files are NOT scanned (prevents infinite loops on bad trees)', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    // 8 levels deep — beyond MAX_DEPTH=6
    const deep = path.join(tmp, 'results', 'a', 'b', 'c', 'd', 'e', 'f', 'g');
    writeBuf(path.join(deep, 'too_deep.mp4'), 1_200_000);
    const items = await scanArchive(tmp);
    const hit = items.find(i => i.id && i.id.endsWith('too_deep.mp4'));
    assert.strictEqual(hit, undefined, 'Beyond-depth files should be ignored');
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: metadata.json with nonsense content does not crash', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    // Write garbage metadata.json next to a valid ad_ folder's files
    const badRun = path.join(tmp, 'results', 'ad_20260414_120001');
    writeBuf(path.join(badRun, 'video.mp4'), 1_500_000);
    fs.writeFileSync(path.join(badRun, 'metadata.json'), 'this is not JSON { [ (');
    const items = await scanArchive(tmp);
    const hit = items.find(i => i.id === 'ad_20260414_120001');
    assert.ok(hit, 'Run should still surface when metadata.json is corrupt');
    assert.strictEqual(hit.brand, ''); // brand not inferred because path has no known brand
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: symlinks in results/ are not followed (safe on platforms that support them)', async () => {
  if (process.platform === 'win32') return; // Windows symlinks require elevation
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    // Create a symlink pointing to /etc — the scanner must NOT walk it
    try {
      fs.symlinkSync('/etc', path.join(tmp, 'results', 'symlink-escape'));
    } catch { return; } // no symlink support → skip
    const items = await scanArchive(tmp);
    // Nothing from /etc should appear
    assert.ok(!items.some(i => i.id && i.id.includes('symlink-escape')),
      'Symlinked directory must not be walked');
  } finally { cleanup(tmp); }
});

test('ADVERSARIAL: multiple loose videos share thumbnails gracefully', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const dir = path.join(tmp, 'results', 'video', '2026-04', 'ivory-ella');
    writeBuf(path.join(dir, 'hero_a.mp4'), 1_100_000);
    writeBuf(path.join(dir, 'hero_b.mp4'), 1_100_000);
    writeBuf(path.join(dir, 'hero_thumbnail.jpg'), 25_000);
    const items = await scanArchive(tmp);
    const a = items.find(i => i.id.endsWith('hero_a.mp4'));
    const b = items.find(i => i.id.endsWith('hero_b.mp4'));
    assert.ok(a && b, 'Both videos should surface');
    // Both should get a thumbnail (shared is fine — better than none)
    assert.ok(a.thumbnail, 'hero_a should have a thumbnail');
    assert.ok(b.thumbnail, 'hero_b should have a thumbnail');
  } finally { cleanup(tmp); }
});

test('REGRESSION GUARD H001 (2026-05-10): scan terminates at ARCHIVE_MAX_DEPTH on a 12-level tree', async () => {
  // Build results/d0/d1/d2/.../d11/file.mp4 — 12 nested levels under results/.
  // ARCHIVE_MAX_DEPTH=6 means files at depth 7+ (7 nested levels) MUST NOT
  // surface, AND the scan must terminate without spinning. We verify both:
  //   (a) the file at depth 12 is not in the output
  //   (b) a file deliberately placed at depth 6 IS in the output (boundary check)
  //   (c) wall-clock completion under 5s (catches infinite-recursion regressions)
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    let deepDir = path.join(tmp, 'results');
    for (let i = 0; i < 12; i++) deepDir = path.join(deepDir, 'd' + i);
    writeBuf(path.join(deepDir, 'too_deep_h001.mp4'), 1_200_000);

    // Boundary: a file 6 levels under results/ (results/b0/b1/b2/b3/b4/b5/file.mp4)
    // — this is at walk() depth 6, which the guard MUST allow.
    let boundaryDir = path.join(tmp, 'results');
    for (let i = 0; i < 6; i++) boundaryDir = path.join(boundaryDir, 'b' + i);
    writeBuf(path.join(boundaryDir, 'boundary_ok.mp4'), 1_200_000);

    // A file 7 levels under results/ — just past the cap, MUST be skipped.
    let overDir = path.join(tmp, 'results');
    for (let i = 0; i < 7; i++) overDir = path.join(overDir, 'o' + i);
    writeBuf(path.join(overDir, 'over_cap.mp4'), 1_200_000);

    const start = Date.now();
    const items = await scanArchive(tmp);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5000, `Scan must terminate quickly even on deep trees (took ${elapsed}ms)`);
    assert.strictEqual(
      items.find(i => i.id && i.id.endsWith('too_deep_h001.mp4')),
      undefined,
      'File at depth 12 must NOT surface (beyond ARCHIVE_MAX_DEPTH)',
    );
    assert.strictEqual(
      items.find(i => i.id && i.id.endsWith('over_cap.mp4')),
      undefined,
      'File at depth 7 (one past the cap) must NOT surface',
    );
    assert.ok(
      items.find(i => i.id && i.id.endsWith('boundary_ok.mp4')),
      'Boundary file at exactly ARCHIVE_MAX_DEPTH must surface',
    );
  } finally { cleanup(tmp); }
});

test('scanArchive sorts newest first', async () => {
  const tmp = makeTmpRoot();
  try {
    setupFixture(tmp);
    const items = await scanArchive(tmp);
    for (let i = 1; i < items.length; i++) {
      assert.ok(items[i - 1].timestamp >= items[i].timestamp,
        `Items should be in descending order: ${items[i - 1].timestamp} >= ${items[i].timestamp}`);
    }
  } finally { cleanup(tmp); }
});

// ─────────────────────────── story-thumb-broken-archive (2026-05-15) ────────
//
// REGRESSION GUARD: a run folder containing ONLY a 9:16 _story image
// (typical TikTok / Reels / Stories ad) must:
//   (a) still produce a valid thumbnail path pointing at the _story file
//   (b) flag the item with tallThumb=true so the renderer applies
//       object-fit:contain — without this, the archive card's 1:1 aspect
//       ratio + object-fit:cover center-bands the tall image, hiding the
//       headline + persona layers and producing a thumb that looks like
//       a generic product hero shot.
//   (c) prefer _square / _portrait / non-tall variants when present, so
//       multi-aspect runs keep using the rendering-friendly thumb.
//
// Live incident anchor: user generated a Banana Pro Edit ad with
// imageFormat:'story' for the nmnl brand; the archive card thumbnail
// showed only the product/bottle region, indistinguishable from a PDP
// hero, breaking the visual differentiation of story ads in the archive.

test('story-thumb-broken-archive: tall-only run flags tallThumb', async () => {
  const tmp = makeTmpRoot();
  try {
    const dir = path.join(tmp, 'results', 'nmnl', 'img_20260515_090857');
    writeBuf(path.join(dir, 'image_1_story.jpg'), 50_000);
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
      brand: 'nmnl', type: 'image', model: 'banana-pro-edit',
    }));
    const items = await scanArchive(tmp);
    const item = items.find(i => i.id === 'img_20260515_090857');
    assert.ok(item, 'tall-only run should still surface as an archive item');
    assert.ok(item.thumbnail.endsWith('image_1_story.jpg'),
      `thumbnail must point at the _story file; got ${item.thumbnail}`);
    assert.strictEqual(item.tallThumb, true,
      'tall-only thumbnail must flag tallThumb=true so renderer uses object-fit:contain');
  } finally { cleanup(tmp); }
});

test('story-thumb-broken-archive: _square wins over _story when both present', async () => {
  const tmp = makeTmpRoot();
  try {
    const dir = path.join(tmp, 'results', 'nmnl', 'img_20260515_091000');
    writeBuf(path.join(dir, 'image_1_square.jpg'), 50_000);
    writeBuf(path.join(dir, 'image_1_story.jpg'), 50_000);
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ brand: 'nmnl', type: 'image' }));
    const items = await scanArchive(tmp);
    const item = items.find(i => i.id === 'img_20260515_091000');
    assert.ok(item.thumbnail.endsWith('image_1_square.jpg'),
      `_square should win when both _square and _story exist; got ${item.thumbnail}`);
    assert.ok(!item.tallThumb,
      'tallThumb must NOT be set when the picked thumb is _square');
  } finally { cleanup(tmp); }
});

test('story-thumb-broken-archive: _portrait wins over _story', async () => {
  const tmp = makeTmpRoot();
  try {
    const dir = path.join(tmp, 'results', 'nmnl', 'img_20260515_091100');
    writeBuf(path.join(dir, 'image_1_portrait.jpg'), 50_000);
    writeBuf(path.join(dir, 'image_1_story.jpg'), 50_000);
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ brand: 'nmnl', type: 'image' }));
    const items = await scanArchive(tmp);
    const item = items.find(i => i.id === 'img_20260515_091100');
    assert.ok(item.thumbnail.endsWith('image_1_portrait.jpg'),
      `_portrait should win when _portrait and _story both exist; got ${item.thumbnail}`);
    assert.ok(!item.tallThumb,
      'tallThumb must NOT be set when the picked thumb is _portrait');
  } finally { cleanup(tmp); }
});

test('story-thumb-broken-archive: _vertical and _reel variants also flag tallThumb', async () => {
  // Run-folder regex requires img_\d{8}_\d{6}, so each iteration uses
  // a unique 6-digit time suffix instead of name-embedding the variant.
  const cases = [
    { variant: 'vertical', time: '091200' },
    { variant: 'reel',     time: '091300' },
    { variant: '9x16',     time: '091400' },
  ];
  for (const { variant, time } of cases) {
    const tmp = makeTmpRoot();
    try {
      const folderName = `img_20260515_${time}`;
      const dir = path.join(tmp, 'results', 'nmnl', folderName);
      writeBuf(path.join(dir, `image_1_${variant}.jpg`), 50_000);
      fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ brand: 'nmnl', type: 'image' }));
      const items = await scanArchive(tmp);
      const item = items.find(i => i.id === folderName);
      assert.ok(item, `_${variant}-only run should surface as a run item`);
      assert.ok(item.thumbnail && item.thumbnail.endsWith(`image_1_${variant}.jpg`),
        `_${variant} thumbnail path should resolve; got ${item && item.thumbnail}`);
      assert.strictEqual(item.tallThumb, true,
        `_${variant} thumbnail must flag tallThumb=true`);
    } finally { cleanup(tmp); }
  }
});

test('story-thumb-broken-archive: plain image_1.jpg (no aspect suffix) does NOT flag tallThumb', async () => {
  const tmp = makeTmpRoot();
  try {
    const dir = path.join(tmp, 'results', 'nmnl', 'img_20260515_091400');
    writeBuf(path.join(dir, 'image_1.jpg'), 50_000);
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ brand: 'nmnl', type: 'image' }));
    const items = await scanArchive(tmp);
    const item = items.find(i => i.id === 'img_20260515_091400');
    assert.ok(item.thumbnail.endsWith('image_1.jpg'));
    assert.ok(!item.tallThumb, 'plain image_1.jpg should not be tagged tall');
  } finally { cleanup(tmp); }
});

// Source-scan lock for the 2026-07-11 async-walk fix: no synchronous fs
// calls may remain anywhere in the scanner module. The walk used to block
// the Electron main process (and all IPC) 300-800ms per cold scan.
test('archive-scanner.js contains no synchronous fs calls (async walk lock)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'archive-scanner.js'), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  const syncCalls = code.match(/\b(?:readdirSync|statSync|lstatSync|readFileSync|writeFileSync|existsSync|renameSync|unlinkSync|mkdirSync|rmSync|openSync)\s*\(/g) || [];
  assert.deepStrictEqual(syncCalls, [],
    `the scanner walk path must be fully async (fs.promises); found: ${syncCalls.join(', ')}`);
  assert.ok(/const WALK_CONCURRENCY = 8/.test(src),
    'bounded concurrency constant must stay at 8');
});

_chain.then(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
});
