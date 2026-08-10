// Archive scanner — discovers ALL generated media under results/, regardless
// of whether it lives in a structured ad_*/img_* run folder (produced by the
// binary's standard pipeline) or as a loose file written by an ad-hoc code
// path (fal/veo/heygen/arcads one-offs, manual drops, legacy data).
//
// Split out from main.js so it can be unit-tested in isolation. The only
// Electron-specific bit is the appRoot argument; everything else is pure Node
// fs/path/crypto.
//
// Discovery strategy:
//   1. Walk results/ recursively (depth-limited) looking for both:
//      a. Run folders (basename matches ad_YYYYMMDD_HHMMSS or img_YYYYMMDD_HHMMSS)
//      b. Media files (.mp4/.mov/.webm/.m4v for video, .jpg/.jpeg/.png/.webp for image)
//   2. Files inside a run folder are grouped into that run's item (with metadata.json)
//   3. Files outside a run folder become synthetic items — one per media file
//   4. For videos, find a sibling *_thumbnail.{jpg,png,webp} if present
//   5. Type is inferred from run folder prefix OR file extension
//   6. Brand is inferred from metadata OR the nearest parent folder name that
//      matches a known brand in assets/brands/
//
// Cache invalidation uses a hash over the *file list* (path + mtime + size),
// not just folder mtimes — so adding a loose file instantly busts the cache.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARCHIVE_VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
const ARCHIVE_IMAGE_EXT = /\.(jpg|jpeg|png|webp)$/i;
const ARCHIVE_RUN_FOLDER = /^(ad|img)_\d{8}_\d{6}(_v\d+)?$/;
const ARCHIVE_MAX_DEPTH = 6;

// ──────────────────────────────────────────────────────────────────────────
// In-memory walk cache (RSI-archive-perf iter 1, fix 1-1).
//
// Why this exists: the file-on-disk archive-index.json cache (further down in
// scanArchive) saves the parse+item-build work on a cache hit, but it can
// only confirm the hit AFTER walking results/ to recompute the content hash.
// On a brand with 1000+ assets the walk itself is the bottleneck (200-500ms
// on SSD, 500-800ms on HDD), and it ran on every IPC call even when nothing
// had changed since the previous scan.
//
// The fix layers a process-lifetime cache on top: scanArchive holds the
// most recent walk result. The results-watcher (results-watcher.js) is the
// authoritative signal that results/ has changed. When it fires, main.js
// calls invalidateScanCache(); next scanArchive call walks fresh. Until
// then, the cache returns instantly — turning the median archive open from
// "300ms walk + 50ms parse + 50ms filter" into "0ms walk + 5ms filter."
//
// REGRESSION GUARD (2026-05-13, rsi-archive-perf iter 1): The cache MUST
// be keyed by appRoot — a multi-instance / workspace-switch scenario
// otherwise serves stale data from the previous workspace. The watcher is
// also the ONLY thing allowed to invalidate; scanArchive itself never
// flushes its own cache (that would defeat the purpose). filters are NOT
// part of the cache key — filtering is cheap and applied per-call to the
// cached items array.
let _walkCache = null; // { appRoot, items, builtAt } | null

function invalidateScanCache() {
  _walkCache = null;
}
const ARCHIVE_MIN_VIDEO_BYTES = 10 * 1024; // 10KB — smaller than this is almost certainly a truncated/corrupted write
const ARCHIVE_MIN_IMAGE_BYTES = 1024;       // 1KB — allow legitimate small thumbnails but drop empty stubs

// Filenames the scanner should ignore even though they have a media extension.
// These are transient / user-input artifacts, not "generated media". Each
// pattern is explicitly anchored to avoid mid-string false positives (e.g. a
// legitimate "foo.partial.mp4" must NOT match ".partial$").
const ARCHIVE_IGNORE_PATTERNS = [
  /^pasted_\d+/i,    // user-pasted chat input — filename is pasted_<Date.now()>.ext
  /^clipboard_/i,     // clipboard helper artifacts
  /^_tmp/i,           // temporary file prefix
  /\.partial$/i,      // half-written download ("foo.mp4.partial")
  /\.tmp$/i,          // final ".tmp" extension
  /~$/,               // editor backup ("foo.jpg~")
];
const ARCHIVE_IGNORE_DIRS = new Set(['logo', 'tmp', 'downloads', 'cache', '_tmp', 'node_modules', '.git']);

function archiveShouldIgnoreName(name) {
  for (const re of ARCHIVE_IGNORE_PATTERNS) {
    if (re.test(name)) return true;
  }
  return false;
}

async function loadKnownBrands(appRoot) {
  // Returns a Set of lowercase brand folder names for reverse-matching
  // loose files to a brand inferred from their path. Async since the
  // 2026-07-11 audit fix: the whole scan path is non-blocking now.
  const set = new Set();
  if (!appRoot || typeof appRoot !== 'string') return set;
  const brandsDir = path.join(appRoot, 'assets', 'brands');
  try {
    for (const d of await fs.promises.readdir(brandsDir, { withFileTypes: true })) {
      if (d.isDirectory() && d.name !== 'example') set.add(d.name.toLowerCase());
    }
  } catch {}
  return set;
}

function inferBrandFromPath(relPath, knownBrands) {
  // relPath is forward-slash normalized and relative to appRoot, e.g.
  //   "results/video/2026-04/acme-labs/seedance_acme_labs.mp4"
  // We scan each path segment and return the first one that matches a known brand.
  const parts = relPath.split('/');
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (knownBrands.has(lower)) return lower;
  }
  return '';
}

function inferTypeFromFolder(relPath) {
  // relPath like "results/video/..." or "results/image/..." — second segment hints at type
  const parts = relPath.split('/');
  if (parts.length >= 2) {
    const seg = parts[1].toLowerCase();
    if (seg === 'video' || seg === 'videos') return 'video';
    if (seg === 'image' || seg === 'images') return 'image';
  }
  return '';
}

function prettifyTitle(base) {
  // Strip extension, snake/kebab → spaces, title-case each word
  return base
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// Concurrency bound for the async walk (2026-07-11 audit fix). 8 directory
// tasks in flight at once: enough to hide per-call disk latency, small
// enough to stay polite on HDDs and AV-scanned Windows installs.
const WALK_CONCURRENCY = 8;

async function statSafe(p) {
  try { return await fs.promises.stat(p); } catch { return null; }
}

// Tiny semaphore: bounds how many directory tasks run concurrently.
function makeSemaphore(limit) {
  let active = 0;
  const waiters = [];
  return async function run(fn) {
    if (active >= limit) await new Promise((resolve) => waiters.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

async function walk(rootDir, relRoot, runs, loose) {
  // One traversal pass that collects:
  //   runs  — Map keyed by relative folder path → { name, fullPath, relPath, files[] }
  //   loose — Array of { fullPath, relPath, ext, size, mtime, parentRel }
  //
  // ASYNC WALK (2026-07-11 audit fix): the old implementation was a
  // synchronous recursive readdirSync/statSync walk that blocked the
  // Electron main process (and therefore ALL IPC) for 300-800ms per cold
  // scan. This version uses fs.promises with a bounded worker pool
  // (WALK_CONCURRENCY directory tasks in flight): same discovery contract,
  // same depth budget, zero main-thread blocking.
  //
  // REGRESSION GUARD (2026-05-10, H001): depth MUST be checked at the top of
  // every directory task AND before every descent below. If a future
  // refactor removes either site, a pathological results/ tree (symlink
  // loop a user accidentally created, deeply-nested junk drawer left over
  // from an old pipeline) will spin the scanner indefinitely.
  // ARCHIVE_MAX_DEPTH = 6 means we walk results/ itself at depth 0 and stop
  // at depth 7 (i.e. 6 levels of nested directories under results/).
  // Confirmed by archive-scanner.test.js's "ADVERSARIAL: beyond-depth
  // files…" + "REGRESSION GUARD H001 …" tests.
  const withSlot = makeSemaphore(WALK_CONCURRENCY);
  const pending = new Set();

  function schedule(dir, depth) {
    const p = withSlot(() => processDir(dir, depth)).catch(() => {});
    pending.add(p);
    p.finally(() => pending.delete(p));
  }

  async function processDir(root, depth) {
    if (depth > ARCHIVE_MAX_DEPTH) return; // H001: top-of-task guard
    let entries;
    try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      const name = e.name;
      if (name === '.' || name === '..') continue;
      // Skip the scanner's own index file AND any atomic-write tmp sidecar
      // (archive-index.json.<hex>.tmp) so the writer doesn't race with itself.
      if (name === 'archive-index.json' || /^archive-index\.json\..*\.tmp$/.test(name)) continue;
      // Skip transient directories we never want to surface (logo assets, tmp dirs)
      if (e.isDirectory() && ARCHIVE_IGNORE_DIRS.has(name.toLowerCase())) continue;
      const fullPath = path.join(root, name);
      const relPath = path.relative(relRoot, fullPath).replace(/\\/g, '/');

      if (e.isDirectory()) {
        // Note: Dirent.isDirectory() is false for symlinks, so symlinked
        // directories are never walked, same semantics as the old
        // readdirSync walk (pinned by the symlink adversarial test).
        if (ARCHIVE_RUN_FOLDER.test(name)) {
          // Claim this folder as a run: list its files (shallow, no recursion)
          const runFiles = [];
          let files;
          try { files = await fs.promises.readdir(fullPath, { withFileTypes: true }); } catch { files = []; }
          for (const f of files) {
            if (!f.isFile()) continue;
            const st = await statSafe(path.join(fullPath, f.name));
            if (!st) continue;
            runFiles.push({ name: f.name, size: st.size, mtime: st.mtimeMs });
          }
          runs.set(relPath, { name, fullPath, relPath, files: runFiles });
        } else {
          // Non-run directory: descend, but only if the next level is
          // still within the depth budget. The top-of-task guard catches
          // it on the next task too, but checking before scheduling avoids
          // one extra readdir per pathological subtree (H001 guard).
          if (depth + 1 > ARCHIVE_MAX_DEPTH) continue;
          schedule(fullPath, depth + 1);
        }
      } else if (e.isFile()) {
        if (!ARCHIVE_VIDEO_EXT.test(name) && !ARCHIVE_IMAGE_EXT.test(name)) continue;
        if (archiveShouldIgnoreName(name)) continue;
        const st = await statSafe(fullPath);
        if (!st) continue;
        loose.push({
          name,
          fullPath,
          relPath,
          parentRel: path.dirname(relPath),
          ext: path.extname(name).toLowerCase(),
          size: st.size,
          mtime: st.mtimeMs,
        });
      }
    }
  }

  schedule(rootDir, 0);
  // Drain: the pending set grows while tasks discover subdirectories.
  while (pending.size > 0) {
    await Promise.all(Array.from(pending));
  }

  // The concurrent walk discovers entries in nondeterministic order; sort
  // so downstream item order (and therefore tie-broken output order) is
  // stable across scans.
  loose.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

function applyFilters(items, filters = {}) {
  let filtered = items;
  if (filters.brand) {
    const b = filters.brand.toLowerCase();
    filtered = filtered.filter(i => i.brand && i.brand.toLowerCase() === b);
  }
  if (filters.type) {
    filtered = filtered.filter(i => i.type === filters.type);
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    filtered = filtered.filter(i =>
      (i.brand && i.brand.toLowerCase().includes(q)) ||
      (i.product && i.product.toLowerCase().includes(q)) ||
      (i.model && i.model.toLowerCase().includes(q)) ||
      i.id.toLowerCase().includes(q)
    );
  }
  return filtered;
}

async function atomicWriteFile(target, data) {
  // Write to a sibling tmp file then rename. Rename is atomic on both Windows
  // and POSIX (within the same filesystem), so a reader never sees a half-
  // written file. The .tmp suffix uses a random token so concurrent writers
  // don't clobber each other's temp files before rename.
  const token = crypto.randomBytes(4).toString('hex');
  const tmp = target + '.' + token + '.tmp';
  await fs.promises.writeFile(tmp, data);
  try {
    await fs.promises.rename(tmp, target);
  } catch (err) {
    // Clean up on failure so we don't leave stray .tmp files on disk
    try { await fs.promises.unlink(tmp); } catch {}
    throw err;
  }
}

// ASYNC (2026-07-11 audit fix): scanArchive is now async end-to-end: the
// walk, metadata reads, index cache read, and index write all go through
// fs.promises so a cold scan never blocks the Electron main process (it
// used to freeze ALL IPC for 300-800ms). The only caller is the
// get-archive-items IPC handler in main.js, which awaits it. Result shape,
// cache-key semantics, and watcher invalidation are unchanged.
async function scanArchive(appRoot, filters = {}) {
  // Defensive guards: appRoot could be null/undefined during unusual startup
  // races (e.g. IPC fires before the workspace path is resolved).
  if (!appRoot || typeof appRoot !== 'string') return [];

  // FAST PATH (RSI-archive-perf iter 1, fix 1-1): if the watcher hasn't
  // invalidated the in-memory cache since the last walk, return the cached
  // items directly. Skips the 200-500ms recursive tree walk that
  // previously fired on every IPC call. Filters are still applied per-call
  // because they're cheap and call-specific.
  if (_walkCache && _walkCache.appRoot === appRoot && Array.isArray(_walkCache.items)) {
    return applyFilters(_walkCache.items, filters);
  }

  const resultsDir = path.join(appRoot, 'results');
  const resultsStat = await statSafe(resultsDir);
  if (!resultsStat || !resultsStat.isDirectory()) return [];

  const indexPath = path.join(resultsDir, 'archive-index.json');
  const knownBrands = await loadKnownBrands(appRoot);

  const runs = new Map();
  const loose = [];
  await walk(resultsDir, appRoot, runs, loose);
  // Deterministic run order regardless of concurrent discovery order.
  const runList = Array.from(runs.values())
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  // Hash over the full discovery set — runs + loose files, sorted for
  // determinism. We stringify mtime via Math.floor (NOT `|0`, which coerces
  // to int32 and silently overflows for Unix epoch millisecond values —
  // any two mtimes 49.7 days apart would collide). Brand list is included
  // so that creating a new brand folder busts the cache and loose files get
  // their brand re-inferred on the next scan.
  const runHashBits = [];
  for (const run of runList) {
    const bits = run.files.map(f => `${f.name}:${f.size}:${Math.floor(f.mtime)}`).sort().join(',');
    runHashBits.push(`R:${run.relPath}|${bits}`);
  }
  const looseHashBits = loose.map(f => `F:${f.relPath}|${f.size}|${Math.floor(f.mtime)}`).sort();
  const brandHashBits = Array.from(knownBrands).sort();
  const currentHash = crypto.createHash('md5')
    .update('runs:\n').update(runHashBits.sort().join('\n'))
    .update('\nloose:\n').update(looseHashBits.join('\n'))
    .update('\nbrands:\n').update(brandHashBits.join('\n'))
    .update('\nv2') // bump when the scanner shape changes so old caches are ignored
    .digest('hex');

  try {
    const raw = await fs.promises.readFile(indexPath, 'utf8');
    const cached = JSON.parse(raw);
    if (cached && cached.hash === currentHash && Array.isArray(cached.items)) {
      return applyFilters(cached.items, filters);
    }
  } catch {}

  // Build items: first from run folders (rich metadata), then from loose files
  const items = [];
  const claimedFiles = new Set(); // relPaths inside run folders — don't double-count

  for (const run of runList) {
    const item = {
      id: run.name,
      type: run.name.startsWith('ad_') ? 'video' : 'image',
      source: 'run',
      timestamp: 0,
      brand: '',
      product: '',
      status: 'completed',
      qaPassed: null,
      model: '',
      thumbnail: '',
      files: run.files.map(f => f.name),
      folder: run.relPath,
    };

    const tsMatch = run.name.match(/(\d{8})_(\d{6})/);
    if (tsMatch) {
      const d = tsMatch[1], t = tsMatch[2];
      const parsed = new Date(
        `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}`
      ).getTime();
      if (!isNaN(parsed)) item.timestamp = parsed;
    }

    const metaPath = path.join(run.fullPath, 'metadata.json');
    try {
      // Direct async read; ENOENT is the normal "no metadata" case and is
      // silent (the old code gated on existsSync for the same effect).
      const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
      if (meta.brand) item.brand = meta.brand;
      if (meta.product) item.product = meta.product;
      if (meta.status) item.status = meta.status;
      if (meta.model) item.model = meta.model;
      if (meta.qaPassed !== undefined) item.qaPassed = meta.qaPassed;
      if (meta.type) item.type = meta.type;
      if (meta.tags) item.tags = meta.tags;
      if (meta.createdAt) {
        const t = new Date(meta.createdAt).getTime();
        if (!isNaN(t)) item.timestamp = t;
      }
      // RSI iter 4 (2026-05-13): pass-through persona × LP × Andromeda
      // signature fields written by the binary's runImagePipeline. The
      // archive card render in renderer.js uses these to surface
      // "→ <persona> → <LP path>" on every card. Missing on pre-iter-4
      // runs, card render handles absence gracefully.
      if (meta.personaSlug)    item.personaSlug    = meta.personaSlug;
      if (meta.personaLabel)   item.personaLabel   = meta.personaLabel;
      if (meta.landingPageUrl) item.landingPageUrl = meta.landingPageUrl;
      if (meta.race)           item.race           = meta.race;
      if (meta.context)        item.context        = meta.context;
      if (meta.style)          item.style          = meta.style;
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.warn(`[archive] Bad metadata in ${run.name}: ${err.message}`);
      }
    }

    if (!item.brand) {
      const inferred = inferBrandFromPath(run.relPath, knownBrands);
      if (inferred) item.brand = inferred;
    }

    if (!item.timestamp && run.files.length) {
      item.timestamp = Math.max(...run.files.map(f => f.mtime));
    }

    // Thumbnail picker (in order of preference):
    //   1. _square   — pre-cropped 1:1 thumbnail that fills the archive card
    //                   cleanly with object-fit: cover. Preferred when present
    //                   because no further cropping is needed.
    //   2. _portrait — 4:5 portrait, still works with cover (slight top/bottom
    //                   crop) without losing the hero composition.
    //   3. _thumbnail — explicit thumbnail sibling.
    //   4. any non-_story image — landscape / square /portrait / unspecified.
    //   5. _story / _vertical / _9x16 — 9:16 tall. WORKS but gets center-banded
    //                   by object-fit:cover, hiding the headline + product
    //                   layers. Used as last-resort thumbnail; the renderer
    //                   applies a `archive-card-thumb-tall` class so the
    //                   thumb falls back to object-fit:contain (letterboxed)
    //                   so the FULL story-ad composition is visible.
    //   6. anything   — final fallback.
    //
    // REGRESSION GUARD (2026-05-15, story-thumb-broken-archive): pre-fix the
    // picker preferred ANY non-_square image (line was `!/_square/i.test`),
    // which would pick a `_story` image when a run was story-only. The
    // archive card's `aspect-ratio: 1` + `object-fit: cover` then cropped
    // the 9:16 image to its middle band, displaying only the product/
    // bottle region and hiding the headline + persona layers. Result: users
    // generating story-format ads saw thumbnails identical to a generic
    // product hero shot, making story ads visually indistinguishable in
    // the archive grid. Fix: prefer _square > _portrait > _thumbnail >
    // non-tall over tall, and flag tall thumbnails so the renderer can
    // apply object-fit:contain.
    const TALL_FORMAT_RE = /_(story|vertical|9x16|reel|reels)\./i;
    const square = run.files.find(f => /_square/i.test(f.name) && ARCHIVE_IMAGE_EXT.test(f.name));
    const portrait = run.files.find(f => /_portrait/i.test(f.name) && ARCHIVE_IMAGE_EXT.test(f.name));
    const thumbnail = run.files.find(f => /_thumbnail/i.test(f.name) && ARCHIVE_IMAGE_EXT.test(f.name));
    const nonTallImage = run.files.find(f => ARCHIVE_IMAGE_EXT.test(f.name) && !TALL_FORMAT_RE.test(f.name) && !/_(square|portrait|thumbnail)/i.test(f.name));
    const tallImage = run.files.find(f => ARCHIVE_IMAGE_EXT.test(f.name) && TALL_FORMAT_RE.test(f.name));
    const fallbackImage = run.files.find(f => ARCHIVE_IMAGE_EXT.test(f.name));
    const thumbFile = square || portrait || thumbnail || nonTallImage || tallImage || fallbackImage;
    if (thumbFile) {
      item.thumbnail = run.relPath + '/' + thumbFile.name;
      // tallThumb=true when the chosen thumbnail is a 9:16 / story-format
      // file. Renderer reads this to switch to object-fit:contain so the
      // full composition is visible in the archive card.
      if (TALL_FORMAT_RE.test(thumbFile.name)) {
        item.tallThumb = true;
      }
    }

    if (item.files.length === 0) continue;

    if (item.type === 'video') {
      const videoFiles = run.files.filter(f => ARCHIVE_VIDEO_EXT.test(f.name));
      if (videoFiles.length === 0) continue;
      if (!videoFiles.some(f => f.size > ARCHIVE_MIN_VIDEO_BYTES)) continue;
    } else if (item.type === 'image') {
      const imageFiles = run.files.filter(f => ARCHIVE_IMAGE_EXT.test(f.name));
      if (imageFiles.length === 0) continue;
      if (!imageFiles.some(f => f.size > ARCHIVE_MIN_IMAGE_BYTES)) continue;
    }

    for (const f of run.files) claimedFiles.add(run.relPath + '/' + f.name);

    items.push(item);
  }

  // Loose-file pass
  const looseByParent = new Map();
  for (const f of loose) {
    if (claimedFiles.has(f.relPath)) continue;
    if (!looseByParent.has(f.parentRel)) looseByParent.set(f.parentRel, []);
    looseByParent.get(f.parentRel).push(f);
  }

  for (const [parentRel, files] of looseByParent.entries()) {
    const videos = files.filter(f => ARCHIVE_VIDEO_EXT.test(f.name) && f.size > ARCHIVE_MIN_VIDEO_BYTES);
    const images = files.filter(f => ARCHIVE_IMAGE_EXT.test(f.name) && f.size > ARCHIVE_MIN_IMAGE_BYTES);

    const inferredBrand = inferBrandFromPath(parentRel, knownBrands);
    const inferredType = inferTypeFromFolder(parentRel);

    const claimedImagesInFolder = new Set();
    for (const v of videos) {
      const vBase = v.name.replace(/\.[^.]+$/, '');
      let thumbCandidate =
        images.find(i => i.name.toLowerCase() === vBase.toLowerCase() + '.jpg') ||
        images.find(i => i.name.toLowerCase().startsWith(vBase.toLowerCase() + '_thumbnail')) ||
        images.find(i => /_thumbnail\./i.test(i.name)) ||
        images.find(i => i.name.toLowerCase().startsWith(vBase.toLowerCase())) ||
        images[0];

      if (thumbCandidate) claimedImagesInFolder.add(thumbCandidate.name);

      items.push({
        id: v.relPath,
        type: 'video',
        source: 'loose',
        timestamp: v.mtime,
        brand: inferredBrand,
        product: prettifyTitle(v.name),
        status: 'completed',
        qaPassed: null,
        model: '',
        thumbnail: thumbCandidate ? thumbCandidate.relPath : '',
        files: [v.name].concat(thumbCandidate ? [thumbCandidate.name] : []),
        folder: parentRel,
      });
    }

    for (const i of images) {
      if (claimedImagesInFolder.has(i.name)) continue;
      if (inferredType === 'video' && videos.length === 0 && /_thumbnail/i.test(i.name)) continue;

      items.push({
        id: i.relPath,
        type: 'image',
        source: 'loose',
        timestamp: i.mtime,
        brand: inferredBrand,
        product: prettifyTitle(i.name),
        status: 'completed',
        qaPassed: null,
        model: '',
        thumbnail: i.relPath,
        files: [i.name],
        folder: parentRel,
      });
    }
  }

  items.sort((a, b) => b.timestamp - a.timestamp);

  try {
    await atomicWriteFile(indexPath, JSON.stringify({ hash: currentHash, items }, null, 2));
  } catch {}

  // Populate the in-memory walk cache so subsequent calls within the same
  // process can skip the walk entirely until the results-watcher invalidates.
  _walkCache = { appRoot, items, builtAt: Date.now() };

  return applyFilters(items, filters);
}

module.exports = {
  scanArchive,
  invalidateScanCache,
  applyFilters,
  loadKnownBrands,
  inferBrandFromPath,
  inferTypeFromFolder,
  prettifyTitle,
  ARCHIVE_VIDEO_EXT,
  ARCHIVE_IMAGE_EXT,
  ARCHIVE_RUN_FOLDER,
};
