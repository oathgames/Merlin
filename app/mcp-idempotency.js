// Merlin MCP — Idempotency Store
//
// File-backed cache keyed on (brand, tool, idempotencyKey). A retry of a
// write operation with the same key returns the cached result instead of
// invoking the binary again. Prevents duplicate ad creation / duplicate
// campaign launches when auto-mode retries a transient failure.
//
// TTL: 24 hours. After expiry, a retry with the same key re-invokes the
// binary — acceptable because the original operation's platform-side effect
// has typically propagated and further retries are the user's problem.
//
// Storage: one JSON file per day in userData/.merlin-idempotency/. Old
// files pruned on startup. We do NOT try to keep a long-running cache in
// memory — Electron may be killed any time, and we need the cache to
// survive a restart for the retry-safety guarantee to hold.
//
// File path is inside Electron userData (app.getPath('userData')), NOT the
// workspace — this is important because the workspace hook blocks writes
// to most config-like paths.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_DIR_NAME = '.merlin-idempotency';

/**
 * Build a stable hash for the idempotency tuple. Uses SHA-256 truncated
 * to 32 hex chars — collision probability on the ~10M-keys-per-24h scale
 * is effectively zero (birthday bound ~2^64).
 */
function hashKey(brand, tool, idempotencyKey) {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') return null;
  if (idempotencyKey.length < 4 || idempotencyKey.length > 256) return null;
  const h = crypto.createHash('sha256');
  h.update(`${brand || ''}\0${tool || ''}\0${idempotencyKey}`);
  return h.digest('hex').slice(0, 32);
}

class IdempotencyStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir - Absolute directory for cache files
   * @param {number} [opts.ttlMs] - Time-to-live in ms (default 24h)
   */
  constructor(opts = {}) {
    if (!opts.dir || typeof opts.dir !== 'string') {
      throw new TypeError('IdempotencyStore requires a dir');
    }
    this.dir = opts.dir;
    this.ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    this._ensureDir();
    this._pruneExpired();
  }

  _ensureDir() {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }

  _filePath(hash) {
    return path.join(this.dir, `${hash}.json`);
  }

  /**
   * Look up a cached result. Returns the cached { result, storedAt } or null.
   * Automatically ignores entries older than ttlMs.
   */
  get(brand, tool, idempotencyKey) {
    const hash = hashKey(brand, tool, idempotencyKey);
    if (!hash) return null;
    const fp = this._filePath(hash);
    let raw;
    try {
      raw = fs.readFileSync(fp, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt file — treat as miss, delete so next put() overwrites cleanly.
      try { fs.unlinkSync(fp); } catch {}
      return null;
    }
    if (!parsed || typeof parsed.storedAt !== 'number') return null;
    if (Date.now() - parsed.storedAt > this.ttlMs) {
      try { fs.unlinkSync(fp); } catch {}
      return null;
    }
    return parsed;
  }

  /**
   * Store a result. Atomic write (tmp + rename) so a kill mid-write cannot
   * leave a partial file that poisons the cache.
   */
  put(brand, tool, idempotencyKey, result) {
    const hash = hashKey(brand, tool, idempotencyKey);
    if (!hash) return false;
    const fp = this._filePath(hash);
    const tmp = `${fp}.tmp-${crypto.randomBytes(8).toString('hex')}`;
    const payload = JSON.stringify({
      brand: brand || '',
      tool: tool || '',
      storedAt: Date.now(),
      result,
    });
    try {
      fs.writeFileSync(tmp, payload, { mode: 0o600 });
      fs.renameSync(tmp, fp);
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      console.warn(`[mcp-idempotency] put() failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Remove a specific entry. Used when a cached result turns out to be
   * stale (e.g. platform-side state changed underneath).
   */
  invalidate(brand, tool, idempotencyKey) {
    const hash = hashKey(brand, tool, idempotencyKey);
    if (!hash) return false;
    try {
      fs.unlinkSync(this._filePath(hash));
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  }

  /**
   * Prune expired entries. Called on construction and can be called by a
   * daily cron. Silent on errors — pruning is best-effort.
   */
  _pruneExpired() {
    let entries;
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const fp = path.join(this.dir, name);
      let stat;
      try {
        stat = fs.statSync(fp);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs > this.ttlMs) {
        try { fs.unlinkSync(fp); } catch {}
      }
    }
  }

  /**
   * Snapshot: how many entries, how much disk. Used by tests and by a
   * future /status tool.
   */
  stats() {
    let count = 0;
    let bytes = 0;
    let entries;
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return { count: 0, bytes: 0 };
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      count += 1;
      try { bytes += fs.statSync(path.join(this.dir, name)).size; } catch {}
    }
    return { count, bytes };
  }
}

/**
 * Generate a new idempotency key client-side. Agents that don't pass one
 * get a time-based key that is unique per call but NOT retry-safe across
 * process restarts — the only way to get true retry safety is for the
 * caller to pass its own stable key and reuse it on retry.
 *
 * Format: `auto-<hex24>` — distinguishable from caller-supplied keys for
 * logging. Callers supplying their own keys should use their own format.
 */
function generateKey() {
  return `auto-${crypto.randomBytes(12).toString('hex')}`;
}

module.exports = {
  IdempotencyStore,
  hashKey,
  generateKey,
  DEFAULT_TTL_MS,
  DEFAULT_DIR_NAME,
};
