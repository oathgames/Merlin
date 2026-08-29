// brand-dirs.js, the single source of truth for "which directories under
// assets/brands/ are actually brands."
//
// REGRESSION GUARD (2026-08-29, ghost-brand-directory incident):
//
// THE BUG: a run using the slug "rebecca-taylor" (the real brand is
// "rebeccataylor", no hyphen) failed on a missing Meta token. The Go
// engine's error log did an unconditional mkdir of assets/brands/<slug>/
// before appending, so the ERROR ITSELF created a brand directory holding
// exactly one file, activity.jsonl. The engine fix (brand_resolve.go +
// logActivity, same date) stops new ghosts being born. This module is the
// containment half: every consumer that enumerates brand directories must
// agree on what counts, so an existing ghost, a backup folder, or a
// scaffolding leftover never reads back as a live client.
//
// Before this module, main.js had NINE separate copies of
//   readdirSync(brandsDir).filter(d => d.isDirectory() && d.name !== 'example')
// Each one accepted any directory at all. Concretely:
//   - brands-index.json (consumed by commands + scheduled tasks) listed the
//     ghost as status:"active" alongside the real brand, so an index reader
//     saw two Rebecca Taylor clients with no way to tell which was real. It
//     also listed 'backup-benebone-2026-08-11-revive-contamination' and its
//     '_backup-' twin.
//   - The 4-hourly token watchdog fired watchdog-check against the ghost and
//     appended a heartbeat, keeping its mtime as fresh as the real brand's.
//     That is why the ghost looked alive for nine days.
//
// WHAT COUNTS AS A BRAND (isBrandDir): a directory that is not reserved, not
// prefixed with '_' or 'backup-', has a slug-shaped name, and holds at least
// one BRAND_MARKER_FILES entry. The marker list mirrors brandMarkerFiles in
// autocmo-core/brand_resolve.go, keep the two in sync.
//
// DO NOT re-inline a raw readdirSync-plus-name-filter over assets/brands.
// brand-dirs.test.js source-scans app/*.js and fails CI if one reappears.

'use strict';

const fs = require('fs');
const path = require('path');

// Mirrors brandMarkerFiles in autocmo-core/brand_resolve.go. A directory
// holding none of these has never been through onboarding and is not a brand.
//
// activity.jsonl stays on the list: a connected, in-use brand always has one,
// and it is the only marker some long-lived brands carry. It is safe as a
// marker again precisely because the engine no longer creates one for an
// unknown slug, if you ever restore that mkdir, this marker becomes a
// self-legitimizing loop and BOTH fixes are undone.
const BRAND_MARKER_FILES = Object.freeze([
  'brand.md',
  'brand-manifest.json',
  'activity.jsonl',
]);

// Shared helper folders that live under assets/brands/ but are not brands.
// 'example' is the shipped sample; the others are asset pools referenced by
// brand content.
const RESERVED_BRAND_DIRS = Object.freeze(new Set([
  'example',
  'references',
  'avatars',
  'voices',
]));

// A brand slug is what slugifyBrandName produces (see brand-slug.js).
// Anything else on disk is a stray directory, not a brand.
const BRAND_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/i;

// Prefixes reserved for non-brand bookkeeping directories: '_' for internal
// or retired trees, 'backup-' for the dated copies taken before a risky
// migration. Both currently exist in live trees.
function hasReservedPrefix(name) {
  return name.startsWith('_') || name.startsWith('backup-');
}

// isBrandDirName applies every name-only rule. Split out from isBrandDir so
// callers that already know a directory exists can filter without a stat.
function isBrandDirName(name) {
  if (typeof name !== 'string' || name === '') return false;
  if (RESERVED_BRAND_DIRS.has(name)) return false;
  if (hasReservedPrefix(name)) return false;
  return BRAND_SLUG_RE.test(name);
}

// isBrandDir reports whether <brandsDir>/<name> is a real brand: the name
// rules above plus at least one marker file on disk.
function isBrandDir(brandsDir, name) {
  if (!isBrandDirName(name)) return false;
  for (const marker of BRAND_MARKER_FILES) {
    try {
      if (fs.existsSync(path.join(brandsDir, name, marker))) return true;
    } catch {}
  }
  return false;
}

// listBrandDirs returns the sorted slugs of every real brand under brandsDir.
// Returns [] when the directory is unreadable, callers must treat an empty
// result as "could not enumerate", never as "the user has no brands".
function listBrandDirs(brandsDir) {
  let entries;
  try {
    entries = fs.readdirSync(brandsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isDirectory() && isBrandDir(brandsDir, d.name))
    .map((d) => d.name)
    .sort();
}

module.exports = {
  BRAND_MARKER_FILES,
  RESERVED_BRAND_DIRS,
  isBrandDirName,
  isBrandDir,
  listBrandDirs,
};
