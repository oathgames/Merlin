// Merlin MCP — Long-Running Job Tracker
//
// Any tool operation that can exceed 30 seconds runs as a background job.
// Tool call returns immediately with { jobId }. The agent polls jobs_poll
// until terminal state (done / failed / cancelled).
//
// Unlocks: 30k-product catalog imports, 500-ad bulk pushes, full-site SEO
// audits — all of which would otherwise hit the 5-minute MCP timeout.
//
// State lives in userData/.merlin-jobs/ (outside workspace). Each job has
// one file; updates are atomic (tmp + rename). Terminal jobs stick around
// for 7 days so the agent can fetch the result after a long delay.
//
// Concurrency: runJobFn is invoked on a microtask so the caller gets the
// jobId synchronously. Jobs do NOT share an event loop semaphore — the
// platform-specific concurrency cap in mcp-concurrency.js is what shapes
// fanout. A job that calls the binary calls it via runBinary, which
// acquires the platform slot in the normal way.
//
// Cancellation: a job sets { cancelRequested: true } on its state; the
// job function is responsible for checking it. For jobs that spawn the
// binary, cancellation kills the child process via the registered cancel
// fn (passed into runJobFn as the second argument).

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_DIR_NAME = '.merlin-jobs';

// Terminal states — once reached, state is frozen except for retention cleanup.
const TERMINAL_STATES = new Set(['done', 'failed', 'cancelled']);

// ── Job shape ─────────────────────────────────────────────────
// {
//   jobId: 'job-<hex>',
//   tool: 'shopify_sync_catalog',
//   brand: 'forever21',
//   createdAt: 1713456789000,
//   updatedAt: 1713456789123,
//   state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled',
//   stage: 'uploading_creative_17_of_50',  // human-readable sub-state
//   pct: 0.34,                               // 0..1
//   etaSec: 180,                             // null if unknown
//   cancelRequested: false,
//   result: <envelope> | null,              // populated on done/failed
//   error: { code, message, ...} | null,
//   meta: { ...arbitrary tool-specific, not secrets }
// }

class JobStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir - Absolute directory for job state files
   * @param {number} [opts.retentionMs] - How long terminal jobs persist
   */
  constructor(opts = {}) {
    if (!opts.dir || typeof opts.dir !== 'string') {
      throw new TypeError('JobStore requires a dir');
    }
    this.dir = opts.dir;
    this.retentionMs = typeof opts.retentionMs === 'number' ? opts.retentionMs : JOB_RETENTION_MS;
    // In-memory registry of { jobId -> { cancelFn } } for running jobs. NOT
    // persisted — a restart loses the ability to cancel in-flight work, which
    // is fine because the binary process is also killed by the restart.
    this._cancelHandles = new Map();
    this._ensureDir();
    this._pruneOld();
  }

  _ensureDir() {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }

  _filePath(jobId) {
    // Validate jobId shape to prevent path traversal.
    if (!/^job-[a-f0-9]{16}$/.test(jobId)) {
      throw new Error(`invalid jobId: ${jobId}`);
    }
    return path.join(this.dir, `${jobId}.json`);
  }

  _readJob(jobId) {
    let raw;
    try {
      raw = fs.readFileSync(this._filePath(jobId), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  _writeJob(job) {
    const fp = this._filePath(job.jobId);
    const tmp = `${fp}.tmp-${crypto.randomBytes(8).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 });
      fs.renameSync(tmp, fp);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }

  _updateJob(jobId, patch) {
    const job = this._readJob(jobId);
    if (!job) return null;
    if (TERMINAL_STATES.has(job.state) && !patch._allowFrozen) {
      // Don't mutate terminal jobs except by retention cleanup.
      return job;
    }
    delete patch._allowFrozen;
    const updated = Object.assign({}, job, patch, { updatedAt: Date.now() });
    this._writeJob(updated);
    return updated;
  }

  /**
   * Start a new job. Returns { jobId } immediately.
   *
   * @param {object} opts
   * @param {string} opts.tool - Tool name (for listing/filter)
   * @param {string} [opts.brand] - Brand name
   * @param {object} [opts.meta] - Arbitrary non-secret metadata
   * @param {function} opts.runFn - async (reportProgress, checkCancelled) => envelope
   *        reportProgress({stage, pct, etaSec}) — update state during run
   *        checkCancelled() — throws if user requested cancel
   */
  start(opts) {
    if (!opts || typeof opts.runFn !== 'function') {
      throw new TypeError('JobStore.start() requires a runFn');
    }
    const jobId = `job-${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();
    const job = {
      jobId,
      tool: opts.tool || 'unknown',
      brand: opts.brand || '',
      createdAt: now,
      updatedAt: now,
      state: 'queued',
      stage: 'queued',
      pct: 0,
      etaSec: null,
      cancelRequested: false,
      result: null,
      error: null,
      meta: opts.meta || null,
    };
    this._writeJob(job);

    // Expose a cancel handle if the runFn registers one. This lets
    // jobs_cancel kill the underlying child process.
    let cancelHandle = null;
    this._cancelHandles.set(jobId, {
      registerCancel: (fn) => { cancelHandle = fn; },
    });

    // Run on a microtask so the caller sees { jobId } immediately.
    queueMicrotask(async () => {
      try {
        this._updateJob(jobId, { state: 'running', stage: 'running' });

        const reportProgress = ({ stage, pct, etaSec } = {}) => {
          const patch = {};
          if (typeof stage === 'string') patch.stage = stage;
          if (typeof pct === 'number') patch.pct = Math.max(0, Math.min(1, pct));
          if (typeof etaSec === 'number') patch.etaSec = Math.max(0, etaSec);
          if (Object.keys(patch).length > 0) this._updateJob(jobId, patch);
        };

        const checkCancelled = () => {
          const latest = this._readJob(jobId);
          if (latest && latest.cancelRequested) {
            const e = new Error('cancelled');
            e.cancelled = true;
            throw e;
          }
        };

        const registerCancel = (fn) => {
          cancelHandle = fn;
        };

        const envelope = await opts.runFn({ reportProgress, checkCancelled, registerCancel });

        this._updateJob(jobId, {
          state: 'done',
          stage: 'done',
          pct: 1,
          etaSec: 0,
          result: envelope || null,
          _allowFrozen: true, // we're writing the terminal state ourselves
        });
      } catch (e) {
        if (e && e.cancelled) {
          this._updateJob(jobId, {
            state: 'cancelled',
            stage: 'cancelled',
            _allowFrozen: true,
          });
        } else {
          this._updateJob(jobId, {
            state: 'failed',
            stage: 'failed',
            error: {
              code: (e && e.code) || 'INTERNAL_ERROR',
              message: (e && e.message) || 'Job failed.',
            },
            _allowFrozen: true,
          });
        }
      } finally {
        this._cancelHandles.delete(jobId);
      }
    });

    return { jobId };
  }

  /**
   * Poll job state. Returns the full job record, or null if not found.
   */
  get(jobId) {
    if (typeof jobId !== 'string') return null;
    try {
      return this._readJob(jobId);
    } catch {
      return null;
    }
  }

  /**
   * List jobs matching filters. Filters default to "recent non-cancelled"
   * but accept { brand?, tool?, state?, limit? }.
   */
  list(filters = {}) {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const jobId = name.slice(0, -5);
      let job;
      try {
        job = this._readJob(jobId);
      } catch {
        continue;
      }
      if (!job) continue;
      if (filters.brand && job.brand !== filters.brand) continue;
      if (filters.tool && job.tool !== filters.tool) continue;
      if (filters.state && job.state !== filters.state) continue;
      out.push(job);
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    if (typeof filters.limit === 'number' && filters.limit > 0) {
      return out.slice(0, filters.limit);
    }
    return out;
  }

  /**
   * Request cancellation. Sets cancelRequested=true; actual cancellation
   * depends on the runFn checking it or the registered cancelHandle
   * killing the child process.
   */
  cancel(jobId) {
    const job = this._readJob(jobId);
    if (!job) return { cancelled: false, reason: 'not_found' };
    if (TERMINAL_STATES.has(job.state)) {
      return { cancelled: false, reason: 'already_terminal', state: job.state };
    }
    this._updateJob(jobId, { cancelRequested: true });
    const handle = this._cancelHandles.get(jobId);
    if (handle && typeof handle.cancelFn === 'function') {
      try { handle.cancelFn(); } catch {}
    }
    return { cancelled: true, reason: 'requested' };
  }

  /**
   * Prune terminal jobs older than retentionMs. Called on construction and
   * safely callable on a cron. Never touches non-terminal jobs.
   */
  _pruneOld() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const fp = path.join(this.dir, name);
      let raw;
      try { raw = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      let job;
      try { job = JSON.parse(raw); } catch { continue; }
      if (!job || !TERMINAL_STATES.has(job.state)) continue;
      if (now - (job.updatedAt || 0) > this.retentionMs) {
        try { fs.unlinkSync(fp); } catch {}
      }
    }
  }
}

module.exports = { JobStore, JOB_RETENTION_MS, TERMINAL_STATES, DEFAULT_DIR_NAME };
