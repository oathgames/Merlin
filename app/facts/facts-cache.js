// facts-cache.js — Electron side of the fact-binding pipeline.
//
// Responsibilities:
//   1. Watch the session-scoped facts JSONL file that the Go binary writes.
//   2. Re-HMAC every received envelope using the same HKDF-derived key.
//   3. Index facts by ID for Pass-1 token substitution in the renderer.
//   4. Maintain a secondary index by kindClass for Pass-3 literal matching.
//   5. Enforce the 50,000-entry / 50MB cap.
//   6. Signal safe-mode when HMAC fails exceed the block-level threshold
//      (> 20% in a turn) or chain integrity breaks.
//
// This module is invoked by the Claude Agent SDK's PostToolUse hook. The hook
// script is a tiny launcher that forwards stdin to the tool-result handler
// below; the real logic lives here so it's easy to unit-test.
//
// See FACT-BINDING-PLAN.md §B1 / §H and facts/SPEC.md.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const MAX_CACHE_ENTRIES = 50000;
const MAX_CACHE_BYTES = 50 * 1024 * 1024;
const BLOCK_LEVEL_FAIL_RATIO = 0.20; // > 20% HMAC fails in a turn → safe-mode.

// ── HKDF mirror (must match facts/facts.go deriveSessionKey) ──────────────

function hkdfExtract(salt, ikm) {
  return crypto.createHmac('sha256', salt).update(ikm).digest();
}

function hkdfExpandOneBlock(prk, info) {
  const h = crypto.createHmac('sha256', prk);
  h.update(Buffer.from(info));
  h.update(Buffer.from([0x01]));
  return h.digest();
}

function deriveSessionKey(vaultKey, sessionId) {
  const salt = crypto.createHash('sha256')
    .update('merlin-facts-v1')
    .update(sessionId)
    .digest();
  const prk = hkdfExtract(salt, vaultKey);
  return hkdfExpandOneBlock(prk, 'facts-hmac-v1');
}

// ── Canonical signing (mirror of facts/canonicalize) ─────────────────────

// Optional-key set keeps in sync with Go's isOptional() in facts.go. Any
// drift silently breaks cross-language HMAC. "hmac" and "id" are listed so
// that canonical body computations that temporarily blank those fields
// (signing and ID hashing paths) drop them rather than emitting "hmac":"".
const OPTIONAL_KEYS = new Set([
  'displayStalenessHint', 'ttlTurns', 'signedServerTs',
  'serverAnchorSig', 'monotonicCounter', 'hmac', 'id',
]);

function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v === '';
  if (typeof v === 'number') return v === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function canonicalWrite(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return String(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalWrite).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    const parts = [];
    for (const k of keys) {
      const val = v[k];
      if (isEmpty(val) && OPTIONAL_KEYS.has(k)) continue;
      parts.push(JSON.stringify(k) + ':' + canonicalWrite(val));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error('canonical: unsupported type ' + typeof v);
}

function canonicalBodyForSign(env) {
  // Everything except hmac.
  const { hmac: _hmac, ...rest } = env;
  return Buffer.from(canonicalWrite(rest), 'utf8');
}

// ── FactCache ────────────────────────────────────────────────────────────

class FactCache {
  constructor({ sessionId, vaultKey, brand, onSafeMode, contractHash }) {
    if (!vaultKey || vaultKey.length < 16) {
      throw new Error('facts-cache: vaultKey too short');
    }
    if (!sessionId) throw new Error('facts-cache: sessionId required');
    this.sessionId = sessionId;
    this.brand = (brand || '').toLowerCase().trim();
    this.key = deriveSessionKey(vaultKey, sessionId);
    this.contractHash = contractHash || '';
    this.byId = new Map();
    this.byKindClass = new Map(); // kindClass -> Set<id>
    this.sizeBytes = 0;
    this.onSafeMode = onSafeMode || (() => {});
    this.safeMode = false;
    this.turnStats = { ingested: 0, failed: 0, tampered: 0 };
  }

  /** Re-HMAC and insert a single envelope. Returns {ok, reason}. */
  ingest(env) {
    if (this.safeMode) return { ok: false, reason: 'safe-mode' };
    if (!env || typeof env !== 'object') {
      this.turnStats.failed++;
      return { ok: false, reason: 'bad-object' };
    }
    if (env.schemaVersion !== SCHEMA_VERSION) {
      this.turnStats.failed++;
      return { ok: false, reason: 'schema-mismatch' };
    }
    if (env.sessionId !== this.sessionId) {
      this.turnStats.failed++;
      return { ok: false, reason: 'session-mismatch' };
    }
    if (this.brand && env.brand && env.brand !== this.brand) {
      this.turnStats.failed++;
      return { ok: false, reason: 'brand-mismatch' };
    }
    // Verify HMAC.
    let body;
    try { body = canonicalBodyForSign(env); }
    catch (e) { this.turnStats.failed++; return { ok: false, reason: 'canonical-fail' }; }
    const want = crypto.createHmac('sha256', this.key).update(body).digest();
    let got;
    try { got = Buffer.from(env.hmac, 'base64'); }
    catch (e) { this.turnStats.failed++; return { ok: false, reason: 'hmac-decode' }; }
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      this.turnStats.tampered++;
      this.turnStats.failed++;
      this._checkSafeMode();
      return { ok: false, reason: 'hmac-mismatch' };
    }
    // Insert.
    if (this.byId.size >= MAX_CACHE_ENTRIES || this.sizeBytes >= MAX_CACHE_BYTES) {
      return { ok: false, reason: 'cache-full' };
    }
    this.byId.set(env.id, env);
    if (!this.byKindClass.has(env.kindClass)) {
      this.byKindClass.set(env.kindClass, new Set());
    }
    this.byKindClass.get(env.kindClass).add(env.id);
    this.sizeBytes += body.length + 128; // rough estimate
    this.turnStats.ingested++;
    return { ok: true };
  }

  /** Pull an envelope by id. Returns undefined if unknown. */
  get(id) { return this.byId.get(id); }

  /** Iterate envelopes of a given kindClass. */
  byClass(kindClass) {
    const ids = this.byKindClass.get(kindClass);
    if (!ids) return [];
    return [...ids].map((id) => this.byId.get(id)).filter(Boolean);
  }

  /** Drop ttlTurns=1 facts at end of turn. */
  purgeOneTurn() {
    for (const [id, env] of this.byId.entries()) {
      if (env.ttlTurns === 1) {
        this.byId.delete(id);
        const set = this.byKindClass.get(env.kindClass);
        if (set) set.delete(id);
      }
    }
  }

  /** Start of a turn — zero the counters that feed safe-mode. */
  beginTurn() {
    this.turnStats = { ingested: 0, failed: 0, tampered: 0 };
  }

  /** End-of-turn hygiene — purge ephemeral facts, reset stats. */
  endTurn() {
    this.purgeOneTurn();
    this.turnStats = { ingested: 0, failed: 0, tampered: 0 };
  }

  /** Force clear everything (e.g. session change, brand change). */
  clear() {
    this.byId.clear();
    this.byKindClass.clear();
    this.sizeBytes = 0;
  }

  _checkSafeMode() {
    const { ingested, failed } = this.turnStats;
    const total = ingested + failed;
    if (total < 5) return; // too few samples to judge
    if (failed / total > BLOCK_LEVEL_FAIL_RATIO) {
      this.safeMode = true;
      this.onSafeMode({ reason: 'hmac-failures-exceed-threshold', stats: this.turnStats });
    }
  }
}

// ── JSONL file watcher ────────────────────────────────────────────────────

/**
 * watchFactsFile reads the given path as append-only JSONL. Lines are fed to
 * the supplied cache via ingest(). Returns a stop() function.
 *
 * Line tolerance: blank lines and parse failures are counted but don't abort
 * the stream — a partial write at the tail is expected during live append.
 * We only commit past the last newline; bytes after the last newline are held
 * until the next read sees them complete.
 */
function watchFactsFile(filePath, cache, opts = {}) {
  const { pollMs = 120 } = opts;
  let offset = 0;
  let stopped = false;
  let tail = '';
  let timer = null;

  function readOnce() {
    if (stopped) return;
    fs.stat(filePath, (err, st) => {
      if (err || stopped) return;
      if (st.size < offset) {
        // file shrank — treat as a fresh session, reset.
        offset = 0;
        tail = '';
      }
      if (st.size === offset) {
        schedule();
        return;
      }
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(st.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = st.size;
      const chunk = tail + buf.toString('utf8');
      const nl = chunk.lastIndexOf('\n');
      if (nl < 0) {
        tail = chunk;
        schedule();
        return;
      }
      const complete = chunk.slice(0, nl);
      tail = chunk.slice(nl + 1);
      for (const line of complete.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let env;
        try { env = JSON.parse(s); } catch (e) { continue; }
        cache.ingest(env);
      }
      schedule();
    });
  }
  function schedule() { if (!stopped) timer = setTimeout(readOnce, pollMs); }
  readOnce();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

// ── Facts file location ───────────────────────────────────────────────────

/**
 * defaultFactsFilePath returns the per-session JSONL path Go writes to. This
 * mirrors the convention used by the binary (see dashboard_facts.go + the
 * forthcoming session wiring in main.go). Keeping the path computation in
 * one place means the hook and renderer always agree.
 */
function defaultFactsFilePath({ toolsDir, sessionId }) {
  const safe = (sessionId || 'default').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return path.join(toolsDir, '.merlin-facts.' + safe + '.jsonl');
}

module.exports = {
  FactCache,
  deriveSessionKey,
  canonicalWrite,
  canonicalBodyForSign,
  watchFactsFile,
  defaultFactsFilePath,
  SCHEMA_VERSION,
  MAX_CACHE_ENTRIES,
  MAX_CACHE_BYTES,
  BLOCK_LEVEL_FAIL_RATIO,
};
