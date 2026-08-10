// Merlin keep/reject flag sidecar.
//
// The Archive viewer needs a 1-keystroke way for the user to mark a creative
// as "keep" (★) or "reject" (✗) while flying through hundreds of generated
// candidates. We persist those flags to a single sidecar JSON at
// `results/.flags.json` instead of mutating each per-run `metadata.json`:
//
//   1. The Go binary owns metadata.json — we don't fight it for ownership.
//   2. A single sidecar means one file watch invalidates the whole UI state.
//   3. Loose files (no metadata.json) get the same flag treatment as run
//      folders, with no special-case write path.
//   4. A sidecar wipe is recoverable (re-flag) — a metadata.json corruption
//      could break the binary's downstream pipeline.
//
// Schema:
//   {
//     "version": 1,
//     "flags": {
//       "<rel-path-from-results>": { "flag": "keep" | "reject", "ts": <ms> }
//     }
//   }
//
// The relative path is the SAME identifier the Archive uses for an item:
// for run folders it's the folder path (e.g. "img/brightco/img_20260419..."),
// for loose files it's the file path. Removing a flag deletes the entry.
//
// Concurrency: every write goes through an in-process serial queue so two
// rapid flag-toggles can't race a read-modify-write. Cross-process safety
// is not a concern — only the Electron main process ever writes this file
// and `app.requestSingleInstanceLock()` (main.js) guarantees one instance.

'use strict';

const fs = require('fs');
const path = require('path');

const SIDECAR_NAME = '.flags.json';
const SCHEMA_VERSION = 1;
const VALID_FLAGS = new Set(['keep', 'reject']);

// Each resultsDir gets its own serial write queue so concurrent flag toggles
// for the same brand workspace don't lose updates. WeakMap-style by string
// key because resultsDir is a path, not an object.
const writeQueues = new Map();

function sidecarPath(resultsDir) {
  if (!resultsDir || typeof resultsDir !== 'string') {
    throw new Error('results-flags: resultsDir required');
  }
  return path.join(resultsDir, SIDECAR_NAME);
}

function emptyState() {
  return { version: SCHEMA_VERSION, flags: {} };
}

// Normalize a relative path to forward slashes + no leading/trailing slash.
// Same shape we hand to the renderer for `data-folder`/`data-file` attrs, so
// flag lookup matches the Archive's natural identifier without round-tripping
// through the filesystem.
function normalizeKey(key) {
  if (typeof key !== 'string') return '';
  return key.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

async function readFlags(resultsDir) {
  const file = sidecarPath(resultsDir);
  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyState();
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed sidecar — return empty state rather than throw, so a corrupt
    // file becomes a one-time "lost flags" event instead of bricking the
    // Archive. The next write rebuilds it cleanly.
    return emptyState();
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.flags || typeof parsed.flags !== 'object') {
    return emptyState();
  }
  // Filter the loaded flags down to known shapes so a stale-schema or
  // hand-edited file can't smuggle unexpected keys into renderer state.
  const cleaned = { version: SCHEMA_VERSION, flags: {} };
  for (const [k, v] of Object.entries(parsed.flags)) {
    const key = normalizeKey(k);
    if (!key || !v || typeof v !== 'object') continue;
    if (!VALID_FLAGS.has(v.flag)) continue;
    const ts = Number.isFinite(v.ts) ? v.ts : Date.now();
    cleaned.flags[key] = { flag: v.flag, ts };
  }
  return cleaned;
}

// Serial write: every mutation runs through the same chain so two callers
// can't read-modify-write into a torn file. Atomic via .tmp + rename.
function enqueueWrite(resultsDir, mutator) {
  const file = sidecarPath(resultsDir);
  const prev = writeQueues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const state = await readFlags(resultsDir);
    const result = await mutator(state);
    const out = state || emptyState();
    out.version = SCHEMA_VERSION;
    const tmp = file + '.tmp.' + process.pid + '.' + Date.now();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify(out, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);
    return result;
  });
  writeQueues.set(file, next);
  // Don't let the queue grow unbounded if every caller awaits — once the
  // chain settles, drop the reference so GC can reclaim closed-over state.
  next.finally(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file);
  }).catch(() => {});
  return next;
}

async function setFlag(resultsDir, key, flag) {
  const k = normalizeKey(key);
  if (!k) throw new Error('results-flags: key required');
  if (flag != null && !VALID_FLAGS.has(flag)) {
    throw new Error('results-flags: flag must be "keep", "reject", or null');
  }
  return enqueueWrite(resultsDir, (state) => {
    if (flag == null) {
      delete state.flags[k];
    } else {
      state.flags[k] = { flag, ts: Date.now() };
    }
    return { success: true };
  });
}

// Bulk apply: array of { key, flag } pairs in one queued write so a "reject
// all unflagged" sweep is one atomic file write. Per-pair flag of `null`
// removes the entry. Invalid pairs are skipped (don't fail the batch — the
// Archive may pass stale items that have since been deleted from disk).
async function setFlagsBulk(resultsDir, updates) {
  if (!Array.isArray(updates)) throw new Error('results-flags: updates must be an array');
  return enqueueWrite(resultsDir, (state) => {
    let applied = 0;
    for (const u of updates) {
      if (!u || typeof u !== 'object') continue;
      const k = normalizeKey(u.key);
      if (!k) continue;
      const f = u.flag;
      if (f == null) {
        if (state.flags[k]) { delete state.flags[k]; applied++; }
        continue;
      }
      if (!VALID_FLAGS.has(f)) continue;
      state.flags[k] = { flag: f, ts: Date.now() };
      applied++;
    }
    return { success: true, applied };
  });
}

// Remove flags for paths that no longer exist on disk. Called after a bulk
// trash so the sidecar doesn't accumulate dead entries forever. The caller
// passes the list of keys to drop — we don't stat the filesystem here so the
// module stays pure.
async function dropKeys(resultsDir, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return { success: true, dropped: 0 };
  return enqueueWrite(resultsDir, (state) => {
    let dropped = 0;
    for (const raw of keys) {
      const k = normalizeKey(raw);
      if (k && state.flags[k]) { delete state.flags[k]; dropped++; }
    }
    return { success: true, dropped };
  });
}

module.exports = {
  SIDECAR_NAME,
  SCHEMA_VERSION,
  readFlags,
  setFlag,
  setFlagsBulk,
  dropKeys,
  // Exposed for tests only.
  __normalizeKey: normalizeKey,
};
