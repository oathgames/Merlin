// bulk-upload.js — pure helpers for the bulk-upload IPC handler in main.js.
//
// CONTEXT: drag-drop / multi-select bulk file ingestion drops files into
// assets/brands/<brand>/inbox/. We:
//   1. Validate each file (size cap, brand-safe filename).
//   2. SHA-256 hash to dedup against everything already in inbox/ AND
//      products/<*>/references/ — same image twice is the most common user
//      mistake, especially for users dragging the same camera roll twice.
//   3. Copy (NEVER move — source may be inside Photos.app or Pictures
//      libraries; mutating those would surprise users) into inbox/ with a
//      sha-prefixed safe name.
//   4. Hand the list of newly-copied basenames to the Go binary's
//      match-asset-to-product action for fuzzy product association.
//   5. The IPC handler then moves the auto-classified files into the
//      product's references/ folder.
//
// This file is the pure logic that has no Electron dependency: filename
// sanitization, hash computation, brand validation, target path resolution.
// Extracting it lets the test suite verify the validators without booting
// IPC. The Electron-side orchestration stays in main.js where ipcMain.handle
// is registered.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// 500 MB per-file ceiling per the original brief. A real video bulk-upload
// can reasonably be hundreds of MB (4K 60s clips); enforcing a tighter cap
// would push users into the "split your upload" trap that no production app
// makes them face. We DO cap to keep one rogue terabyte file from filling
// the disk before the user notices.
const MAX_FILE_BYTES = 500 * 1024 * 1024;

// Match the preload's BRAND_RE — anchored, lowercase ascii + dash + underscore,
// 1-100 chars. The check is duplicated on purpose: preload validates strings
// from the renderer; this validates the FIELD VALUE on the trusted main side
// so a future code path that bypasses preload still hits the same gate.
const BRAND_RE = /^[a-z0-9_-]{1,100}$/i;

// Allowed media extensions. We don't trust the MIME the renderer hands us
// (it's set from File.type which is OS/extension-derived anyway); we
// re-derive from the user-visible extension. Anything not in the list is
// rejected before we hash a single byte.
const MEDIA_EXT_ALLOWLIST = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif',
  '.mp4', '.mov', '.webm', '.m4v', '.avi',
]);

function isValidBrandName(brand) {
  return typeof brand === 'string' && BRAND_RE.test(brand);
}

// sanitizeFilename returns a safe basename derived from the user-supplied
// filename. We:
//   - basename only (no directory components)
//   - reject empties, "." and ".."
//   - drop dotfile leading dots
//   - replace anything that isn't ascii alnum / dot / dash / underscore with _
//   - cap length so a pathological 4096-char filename can't blow up the
//     target FS path
function sanitizeFilename(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  const base = path.basename(raw);
  if (!base || base === '.' || base === '..') return '';
  // Drop leading dots so ".gitignore" → "gitignore"; this also collapses
  // the macOS "._foo" resource-fork artefacts to "foo".
  let stripped = base.replace(/^\.+/, '');
  if (!stripped) return '';
  // Replace illegal chars with _. We deliberately keep the extension dot.
  const sanitized = stripped.replace(/[^A-Za-z0-9._-]/g, '_');
  // Cap to a sane max — most filesystems allow 255, but path-joining adds
  // up so 200 leaves headroom.
  return sanitized.slice(0, 200);
}

// hasAllowedExtension verifies the basename ends in one of the media types
// we accept. We check after sanitization so a sketchy ".exe" isn't snuck
// past via mixed-case or trailing whitespace.
function hasAllowedExtension(name) {
  const ext = path.extname(name).toLowerCase();
  return MEDIA_EXT_ALLOWLIST.has(ext);
}

// sha256File streams the file through a hash. We avoid readFileSync because
// 500 MB videos shouldn't pin RAM. The 64 KB chunk size is the same that
// Node's docs use in their own examples — fast on modern SSDs without
// buffering the whole file.
function sha256File(filepath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filepath, { highWaterMark: 64 * 1024 });
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// buildTargetName produces the on-disk filename inside inbox/. We prefix the
// short SHA so two files with the same user-visible name (very common — every
// camera saves IMG_0001.JPG) don't collide. 8 hex chars = 4 bytes = 1 in 4
// billion collision odds per pair, well below the threshold where users
// would ever notice.
function buildTargetName(sha256Hex, sanitizedName) {
  const prefix = sha256Hex.slice(0, 8);
  return `${prefix}_${sanitizedName}`;
}

// resolveBrandPaths returns the canonical paths for a given brand. Caller
// must have already validated `brand` via isValidBrandName.
function resolveBrandPaths(appRoot, brand) {
  const brandDir = path.join(appRoot, 'assets', 'brands', brand);
  return {
    brandDir,
    inboxDir: path.join(brandDir, 'inbox'),
    productsDir: path.join(brandDir, 'products'),
  };
}

// validateInputFile is the per-file contract used by the IPC handler. Returns
// { ok: false, reason } for rejections, { ok: true, ... } for accepts.
//
// Reasons:
//   missing-name       — file.name was empty or non-string
//   bad-name           — sanitized to empty or contains a path component
//   bad-extension      — extension not in the media allowlist
//   missing-source     — file.path was empty
//   not-found          — fs.statSync failed
//   too-large          — byte count exceeds MAX_FILE_BYTES
//   not-a-file         — fs entry is a dir, symlink-to-dir, etc.
function validateInputFile(file) {
  if (!file || typeof file !== 'object') return { ok: false, reason: 'bad-input' };
  const name = sanitizeFilename(file.name);
  if (!name) return { ok: false, reason: file.name ? 'bad-name' : 'missing-name' };
  if (!hasAllowedExtension(name)) return { ok: false, reason: 'bad-extension' };
  const src = typeof file.path === 'string' ? file.path : '';
  if (!src) return { ok: false, reason: 'missing-source' };
  let stat;
  try { stat = fs.statSync(src); } catch { return { ok: false, reason: 'not-found' }; }
  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
  if (stat.size > MAX_FILE_BYTES) return { ok: false, reason: 'too-large', size: stat.size };
  return { ok: true, name, src, size: stat.size };
}

module.exports = {
  MAX_FILE_BYTES,
  MEDIA_EXT_ALLOWLIST,
  BRAND_RE,
  isValidBrandName,
  sanitizeFilename,
  hasAllowedExtension,
  sha256File,
  buildTargetName,
  resolveBrandPaths,
  validateInputFile,
};
