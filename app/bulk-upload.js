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

// MAX_BASENAME_LEN — most filesystems allow 255 bytes; path-joining adds up,
// so 200 leaves headroom. Used by sanitizeFilename's extension-preserving
// truncation. Exported so tests can pin to the same constant.
const MAX_BASENAME_LEN = 200;

// sanitizeFilename returns a safe basename derived from the user-supplied
// filename. We:
//   - basename only (no directory components)
//   - reject empties, "." and ".."
//   - drop dotfile leading dots
//   - replace anything that isn't ascii alnum / dot / dash / underscore with _
//   - cap length so a pathological 4096-char filename can't blow up the
//     target FS path — and preserve the extension when truncating, so a
//     300-char name doesn't lose `.jpg` and then get rejected by the
//     extension allowlist with a misleading "bad-extension" reason
//     (REGRESSION GUARD 2026-04-28, Gitar finding on PR #139).
function sanitizeFilename(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  // Strip directory components from BOTH POSIX and Windows-style paths.
  // path.basename on POSIX (Linux CI) leaves backslashes intact, so a
  // user-supplied "C:\Users\me\IMG_0001.JPG" survives as the whole
  // string and gets mangled into "C__Users__me__IMG_0001.JPG" by the
  // alnum-replace below — which then fails the extension allowlist
  // and breaks legitimate Windows uploads under WSL / Docker Desktop /
  // Linux test runners. Run BOTH basenames so the result is OS-
  // agnostic; path.win32.basename treats `\` and `/` as separators on
  // every platform, and path.posix.basename catches `/` first so a
  // path containing both styles ("C:\dir/IMG.jpg") still resolves.
  const base = path.win32.basename(path.posix.basename(raw));
  if (!base || base === '.' || base === '..') return '';
  // Drop leading dots so ".gitignore" → "gitignore"; this also collapses
  // the macOS "._foo" resource-fork artefacts to "foo".
  let stripped = base.replace(/^\.+/, '');
  if (!stripped) return '';
  // Replace illegal chars with _. We deliberately keep the extension dot.
  const sanitized = stripped.replace(/[^A-Za-z0-9._-]/g, '_');
  if (sanitized.length <= MAX_BASENAME_LEN) return sanitized;
  // Truncate the stem, NOT the extension — losing `.jpg` cascades into
  // the allowlist check returning bad-extension on what's really a long
  // legitimate filename.
  const ext = path.extname(sanitized);
  const stem = sanitized.slice(0, sanitized.length - ext.length);
  const maxStem = MAX_BASENAME_LEN - ext.length;
  // Pathological case: extension itself is >= MAX_BASENAME_LEN. Keep at
  // least one stem char so the result isn't ".ext" (which path.basename
  // treats as a dotfile, not an extension). Math.max(1, maxStem) handles
  // ext.length >= MAX_BASENAME_LEN by retaining a 1-char stem; the total
  // length may exceed MAX_BASENAME_LEN in this edge case but that's
  // acceptable (and any sane FS will still accept it).
  return stem.slice(0, Math.max(1, maxStem)) + ext;
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

// SHA_PREFIX_LEN — number of hex chars used to disambiguate filenames inside
// inbox/ + as the dedup key against existing files. 16 hex = 64 bits → 1%
// birthday-collision threshold at ~4 billion files (vs ~9,300 at 8 hex /
// 32 bits, which a brand with hundreds of products × dozens of refs each
// could realistically hit). Also feeds the prefix-read regex in main.js;
// keep both sides in sync (REGRESSION GUARD 2026-04-28, Gitar finding on
// PR #139). The matching regex pattern is exported as SHA_PREFIX_RE.
const SHA_PREFIX_LEN = 16;
const SHA_PREFIX_RE = /^([0-9a-f]{16})_/;

// buildTargetName produces the on-disk filename inside inbox/. We prefix the
// short SHA so two files with the same user-visible name (very common — every
// camera saves IMG_0001.JPG) don't collide.
function buildTargetName(sha256Hex, sanitizedName) {
  const prefix = sha256Hex.slice(0, SHA_PREFIX_LEN);
  return `${prefix}_${sanitizedName}`;
}

// PRODUCT_SLUG_RE — character-class allowlist for product folder names. NOT
// sufficient on its own: `..` passes this regex because each dot matches
// the class. isValidProductSlug below layers the explicit traversal-
// sentinel rejection on top.
const PRODUCT_SLUG_RE = /^[A-Za-z0-9._-]{1,200}$/;

// isValidProductSlug — defense-in-depth check on the productSlug field
// returned by the Go matcher's match-asset-to-product action. The Go side
// already validates folder shape, but we re-check here so a hand-crafted
// JSON (compromised binary, race with a manual edit, future bug) can't
// path-traverse out of products/<slug>/references/.
//
// REGRESSION GUARD (2026-04-28, Gitar PR #139): a prior version did the
// re-check inline as `/^[A-Za-z0-9._-]{1,200}$/.test(slug)`. The literal
// string `..` passed that regex because `.` is in the character class,
// so a malicious matcher could return product:".." and writes would land
// in <brandDir>/references/ instead of <brandDir>/products/<slug>/
// references/. Layered fix: char-class regex + explicit `.`/`..`
// rejection + reject anything that's all dots (`...`, `....` etc.,
// future-proofing against POSIX edge cases where consecutive dots are
// collapsed by path.join).
function isValidProductSlug(slug) {
  if (typeof slug !== 'string' || !PRODUCT_SLUG_RE.test(slug)) return false;
  if (slug === '.' || slug === '..') return false;
  if (/^\.+$/.test(slug)) return false;
  return true;
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
  MAX_BASENAME_LEN,
  MEDIA_EXT_ALLOWLIST,
  BRAND_RE,
  PRODUCT_SLUG_RE,
  SHA_PREFIX_LEN,
  SHA_PREFIX_RE,
  isValidBrandName,
  isValidProductSlug,
  sanitizeFilename,
  hasAllowedExtension,
  sha256File,
  buildTargetName,
  resolveBrandPaths,
  validateInputFile,
};
