// Merlin MCP — Blast-Radius Gate (Preview + Confirm)
//
// For operations whose blast radius crosses a threshold (many ads killed,
// large budget, catalog-scale delete), the caller MUST first invoke the
// tool with { preview: true }. The preview returns:
//   { previewedPayload, confirm_token, expires_at, blast_radius }
//
// To actually execute, the caller re-invokes with { confirm_token }. The
// token is single-use, short-TTL (default 5 minutes), and cryptographically
// tied to the exact payload — changing any field invalidates it.
//
// Threshold policy lives in each tool's definition, not here. This module
// provides the primitives: token mint, token consume, payload-digest pinning.
//
// Storage: in-memory only. Tokens expire fast and losing them on restart
// is a feature, not a bug (forces a fresh preview after any crash).

'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Payload digest ────────────────────────────────────────────
// Canonical JSON digest — sorts object keys so { a:1, b:2 } and { b:2, a:1 }
// produce the same hash. Arrays keep their order (order matters for ads[]).

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const keys = Object.keys(value).sort();
  const out = {};
  for (const k of keys) {
    if (k === 'preview' || k === 'confirm_token') continue; // never part of digest
    out[k] = canonicalize(value[k]);
  }
  return out;
}

function digestPayload(payload) {
  const json = JSON.stringify(canonicalize(payload || {}));
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 32);
}

// ── Token store ───────────────────────────────────────────────

class PreviewTokenStore {
  constructor(opts = {}) {
    this.ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    // Map<token, { payloadDigest, tool, brand, expiresAt, blastRadius }>
    this.tokens = new Map();
  }

  _sweep() {
    const now = Date.now();
    for (const [t, entry] of this.tokens.entries()) {
      if (entry.expiresAt < now) this.tokens.delete(t);
    }
  }

  /**
   * Mint a confirm_token for a previewed payload.
   * @param {object} opts
   * @param {string} opts.tool - Tool name (prevents cross-tool token reuse)
   * @param {string} opts.brand - Brand name
   * @param {object} opts.payload - The payload that will be executed
   * @param {object} opts.blastRadius - Tool-specific impact summary
   * @returns {{ confirm_token, expires_at, blast_radius }}
   */
  mint(opts) {
    if (!opts || typeof opts.tool !== 'string' || !opts.payload) {
      throw new TypeError('mint() requires tool and payload');
    }
    this._sweep();
    const token = `ct-${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt = Date.now() + this.ttlMs;
    this.tokens.set(token, {
      payloadDigest: digestPayload(opts.payload),
      tool: opts.tool,
      brand: opts.brand || '',
      expiresAt,
      blastRadius: opts.blastRadius || null,
    });
    return {
      confirm_token: token,
      expires_at: expiresAt,
      blast_radius: opts.blastRadius || null,
    };
  }

  /**
   * Consume a token: verifies it exists, hasn't expired, matches the exact
   * tool + brand + payload, then DELETES it (single-use). Returns the
   * blast radius on success, or a structured reason on failure.
   *
   * @returns {{ ok: true, blastRadius } | { ok: false, reason }}
   */
  consume(token, opts) {
    if (typeof token !== 'string' || !token.startsWith('ct-')) {
      return { ok: false, reason: 'malformed_token' };
    }
    this._sweep();
    const entry = this.tokens.get(token);
    if (!entry) return { ok: false, reason: 'token_not_found_or_expired' };

    if (entry.tool !== opts.tool) {
      // Cross-tool reuse. Delete so the caller can't keep probing.
      this.tokens.delete(token);
      return { ok: false, reason: 'wrong_tool' };
    }
    if ((entry.brand || '') !== (opts.brand || '')) {
      this.tokens.delete(token);
      return { ok: false, reason: 'wrong_brand' };
    }
    const digest = digestPayload(opts.payload);
    if (digest !== entry.payloadDigest) {
      this.tokens.delete(token);
      return { ok: false, reason: 'payload_mismatch' };
    }
    this.tokens.delete(token);
    return { ok: true, blastRadius: entry.blastRadius };
  }

  stats() {
    this._sweep();
    return { count: this.tokens.size };
  }

  _reset() {
    this.tokens.clear();
  }
}

// ── Default blast-radius policies ─────────────────────────────
//
// Tools can define their own. These are sensible defaults for ad-platform
// write operations. A tool declares `blastRadius: (payload, cfg) => { ... }`
// in its defineTool() call; the foundation calls it to decide if preview
// is required.

const DEFAULT_POLICIES = {
  // Launching a batch of N ads is high-impact when N >= 5.
  bulkLaunch: (payload) => {
    const n = Array.isArray(payload.ads) ? payload.ads.length : 1;
    return n >= 5
      ? { required: true, reason: `Launching ${n} ads`, count: n }
      : { required: false };
  },
  // Killing an ad is low-impact for a single ad, high-impact for a campaign.
  kill: (payload) => {
    // Killing a whole campaign disables every ad under it — always preview.
    if (payload.campaignId && !payload.adId) {
      return { required: true, reason: 'Kill entire campaign', scope: 'campaign' };
    }
    return { required: false };
  },
  // Budget change >2x is high-impact (and >10x triggers the existing
  // cents-detection guard, which refuses entirely).
  budgetChange: (payload, previousBudget) => {
    if (!previousBudget || !payload.dailyBudget) return { required: false };
    const ratio = payload.dailyBudget / previousBudget;
    if (ratio >= 2 || ratio <= 0.25) {
      return {
        required: true,
        reason: `Budget change ${Math.round(ratio * 100)}% of current`,
        previousBudget,
        newBudget: payload.dailyBudget,
      };
    }
    return { required: false };
  },
  // Catalog-scale delete: always preview.
  catalogDelete: (payload) => {
    const n = Array.isArray(payload.productIds) ? payload.productIds.length : 0;
    if (n === 0) return { required: false };
    return {
      required: true,
      reason: `Delete ${n} products`,
      count: n,
    };
  },
};

// ── Singleton default store ───────────────────────────────────
const defaultStore = new PreviewTokenStore();

module.exports = {
  PreviewTokenStore,
  digestPayload,
  canonicalize,
  DEFAULT_POLICIES,
  DEFAULT_TTL_MS,
  // Convenience bound methods
  mint: (opts) => defaultStore.mint(opts),
  consume: (token, opts) => defaultStore.consume(token, opts),
  _default: defaultStore,
};
