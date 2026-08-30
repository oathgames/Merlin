// Shape validation for version.json's `updatable` manifest.
//
// REGRESSION GUARD (2026-08-30, update-manifest-dir-entry):
// updatable-coverage.test.js checks ONE direction: every shipped production
// file appears in the manifest. Nothing checked the reverse: that every entry
// IN the manifest is a real, fetchable file.
//
// That gap shipped a live outage. "assets/brands/example/" — a DIRECTORY —
// sat in the array from v1.32.0 through v1.39.0. raw.githubusercontent.com
// 404s on a directory path, downloadAndApplyUpdate collects that 404 into
// fetchFailures, and the 2026-05-01 partial-update guard then hard-aborts the
// entire update before any disk write or version bump. Every bootstrapper
// (unpackaged) install was therefore frozen on its installed version across
// eight releases, downloading 105 files and applying none of them, forever.
// The failure is invisible from the repo side: the manifest is data, no build
// step resolves it, and the app that consumes it lives in a different process.
//
// These tests resolve every entry against the on-disk tree, which is exactly
// what the updater does against the tag.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'version.json'), 'utf8'));
const updatable = manifest.updatable || [];

// Built from a char code rather than a literal so the escaping is unambiguous.
const BACKSLASH = String.fromCharCode(92);
const endsWithSep = (e) => e.endsWith('/') || e.endsWith(BACKSLASH);
const hasParentRef = (e) => e.split('/').flatMap((p) => p.split(BACKSLASH)).includes('..');

test('updatable manifest is a non-empty array of strings', () => {
  assert.ok(Array.isArray(updatable), 'updatable must be an array');
  assert.ok(updatable.length > 0, 'updatable must not be empty');
  for (const entry of updatable) {
    assert.strictEqual(typeof entry, 'string', `entry is not a string: ${JSON.stringify(entry)}`);
    assert.ok(entry.length > 0, 'entry must not be an empty string');
  }
});

test('no updatable entry names a directory', () => {
  // Two ways an entry can be a directory: a trailing separator, or a path that
  // resolves to one on disk. Both 404 on raw.githubusercontent.com.
  const trailing = updatable.filter((e) => endsWithSep(e));
  assert.deepStrictEqual(
    trailing, [],
    `updatable entries end with a path separator, so they name directories and will 404:\n  ${trailing.join('\n  ')}\n` +
    'List the individual files instead.'
  );

  const dirs = updatable.filter((e) => {
    try { return fs.statSync(path.join(repoRoot, e)).isDirectory(); } catch { return false; }
  });
  assert.deepStrictEqual(
    dirs, [],
    `updatable entries resolve to directories on disk and will 404 when fetched:\n  ${dirs.join('\n  ')}`
  );
});

test('every updatable entry exists as a file in the repo', () => {
  // The updater fetches each entry from raw.githubusercontent.com at the
  // release tag. An entry with no corresponding file in the tree is a
  // guaranteed 404, and one 404 aborts the whole update.
  const missing = updatable.filter((e) => {
    try { return !fs.statSync(path.join(repoRoot, e)).isFile(); } catch { return true; }
  });
  assert.deepStrictEqual(
    missing, [],
    `updatable entries have no matching file in the repo and will 404 on fetch:\n  ${missing.join('\n  ')}\n` +
    'Every entry must be a real file committed to the public repo.'
  );
});

test('no updatable entry escapes the install root', () => {
  // Mirrors isSafeUpdatablePath in app/main.js. An entry the updater refuses
  // at runtime is dead weight in the manifest and hides a real intent.
  const unsafe = updatable.filter((e) => path.isAbsolute(e) || hasParentRef(e));
  assert.deepStrictEqual(unsafe, [], `unsafe updatable entries:\n  ${unsafe.join('\n  ')}`);
});

test('updatable entries are unique', () => {
  const seen = new Set();
  const dupes = [];
  for (const e of updatable) {
    if (seen.has(e)) dupes.push(e);
    seen.add(e);
  }
  assert.deepStrictEqual(dupes, [], `duplicate updatable entries:\n  ${dupes.join('\n  ')}`);
});

test('isSafeUpdatablePath in main.js rejects trailing-separator entries', () => {
  // Runtime backstop for a manifest already on a user's disk. Source-scanned
  // because the function is a closure inside downloadAndApplyUpdate.
  const src = fs.readFileSync(path.join(repoRoot, 'app', 'main.js'), 'utf8');
  const fnStart = src.indexOf('const isSafeUpdatablePath');
  assert.ok(fnStart > -1, 'isSafeUpdatablePath not found in app/main.js');
  const body = src.slice(fnStart, fnStart + 600);
  assert.ok(
    body.includes('[/' + BACKSLASH + BACKSLASH + ']$/.test(entry)) return false;'),
    'isSafeUpdatablePath must reject entries ending in a path separator — ' +
    'a directory entry 404s and hard-aborts the whole update.'
  );
});
