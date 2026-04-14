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

function loadKnownBrands(appRoot) {
  // Returns a Set of lowercase brand folder names for reverse-matching
  // loose files to a brand inferred from their path.
  const set = new Set();
  if (!appRoot || typeof appRoot !== 'string') return set;
  const brandsDir = path.join(appRoot, 'assets', 'brands');
  try {
    for (const d of fs.readdirSync(brandsDir, { withFileTypes: true })) {
      if (d.isDirectory() && d.name !== 'example') set.add(d.name.toLowerCase());
    }
  } catch {}
  return set;
}

function inferBrandFromPath(relPath, knownBrands) {
  // relPath is forward-slash normalized and relative to appRoot, e.g.
  //   "results/video/2026-04/ivory-ella/seedance_ivory_ella.mp4"
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

function walk(root, relRoot, knownBrands, depth, runs, loose) {
  // One recursive pass that collects:
  //   runs  — Map keyed by relative folder path → { name, fullPath, relPath, files[] }
  //   loose — Array of { fullPath, relPath, ext, size, mtime, parentRel }
  if (depth > ARCHIVE_MAX_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }

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
      if (ARCHIVE_RUN_FOLDER.test(name)) {
        // Claim this folder as a run — list its files (shallow, no recursion)
        const runFiles = [];
        try {
          for (const f of fs.readdirSync(fullPath, { withFileTypes: true })) {
            if (!f.isFile()) continue;
            const fp = path.join(fullPath, f.name);
            let stat;
            try { stat = fs.statSync(fp); } catch { continue; }
            runFiles.push({ name: f.name, size: stat.size, mtime: stat.mtimeMs });
          }
        } catch {}
        runs.set(relPath, { name, fullPath, relPath, files: runFiles });
      } else {
        // Non-run directory — recurse
        walk(fullPath, relRoot, knownBrands, depth + 1, runs, loose);
      }
    } else if (e.isFile()) {
      if (!ARCHIVE_VIDEO_EXT.test(name) && !ARCHIVE_IMAGE_EXT.test(name)) continue;
      if (archiveShouldIgnoreName(name)) continue;
      let stat;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      loose.push({
        name,
        fullPath,
        relPath,
        parentRel: path.dirname(relPath),
        ext: path.extname(name).toLowerCase(),
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
  }
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

function atomicWriteFile(target, data) {
  // Write to a sibling tmp file then rename. Rename is atomic on both Windows
  // and POSIX (within the same filesystem), so a reader never sees a half-
  // written file. The .tmp suffix uses a random token so concurrent writers
  // don't clobber each other's temp files before rename.
  const token = crypto.randomBytes(4).toString('hex');
  const tmp = target + '.' + token + '.tmp';
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    // Clean up on failure so we don't leave stray .tmp files on disk
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function scanArchive(appRoot, filters = {}) {
  // Defensive guards: appRoot could be null/undefined during unusual startup
  // races (e.g. IPC fires before the workspace path is resolved).
  if (!appRoot || typeof appRoot !== 'string') return [];

  const resultsDir = path.join(appRoot, 'results');
  if (!fs.existsSync(resultsDir)) return [];

  const indexPath = path.join(resultsDir, 'archive-index.json');
  const knownBrands = loadKnownBrands(appRoot);

  const runs = new Map();
  const loose = [];
  walk(resultsDir, appRoot, knownBrands, 0, runs, loose);

  // Hash over the full discovery set — runs + loose files, sorted for
  // determinism. We stringify mtime via Math.floor (NOT `|0`, which coerces
  // to int32 and silently overflows for Unix epoch millisecond values —
  // any two mtimes 49.7 days apart would collide). Brand list is included
  // so that creating a new brand folder busts the cache and loose files get
  // their brand re-inferred on the next scan.
  const runHashBits = [];
  for (const run of runs.values()) {
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
    const raw = fs.readFileSync(indexPath, 'utf8');
    const cached = JSON.parse(raw);
    if (cached && cached.hash === currentHash && Array.isArray(cached.items)) {
      return applyFilters(cached.items, filters);
    }
  } catch {}

  // Build items: first from run folders (rich metadata), then from loose files
  const items = [];
  const claimedFiles = new Set(); // relPaths inside run folders — don't double-count

  for (const run of runs.values()) {
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
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
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
      }
    } catch (err) { console.warn(`[archive] Bad metadata in ${run.name}: ${err.message}`); }

    if (!item.brand) {
      const inferred = inferBrandFromPath(run.relPath, knownBrands);
      if (inferred) item.brand = inferred;
    }

    if (!item.timestamp && run.files.length) {
      item.timestamp = Math.max(...run.files.map(f => f.mtime));
    }

    const portrait = run.files.find(f => /_portrait/i.test(f.name) && ARCHIVE_IMAGE_EXT.test(f.name));
    const thumbnail = run.files.find(f => /_thumbnail/i.test(f.name) && ARCHIVE_IMAGE_EXT.test(f.name));
    const anyImage = run.files.find(f => ARCHIVE_IMAGE_EXT.test(f.name) && !/_square/i.test(f.name));
    const fallbackImage = run.files.find(f => ARCHIVE_IMAGE_EXT.test(f.name));
    const thumbFile = portrait || thumbnail || anyImage || fallbackImage;
    if (thumbFile) item.thumbnail = run.relPath + '/' + thumbFile.name;

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
    atomicWriteFile(indexPath, JSON.stringify({ hash: currentHash, items }, null, 2));
  } catch {}

  return applyFilters(items, filters);
}

module.exports = {
  scanArchive,
  applyFilters,
  loadKnownBrands,
  inferBrandFromPath,
  inferTypeFromFolder,
  prettifyTitle,
  ARCHIVE_VIDEO_EXT,
  ARCHIVE_IMAGE_EXT,
  ARCHIVE_RUN_FOLDER,
};
