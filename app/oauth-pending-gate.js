// oauth-pending-gate.js: cheap pre-spawn gate for the OAuth pending-flow
// poller in main.js.
//
// Why this exists (2026-07-11 audit fix): runOAuthPendingPoll execFiles the
// Go binary every 30s for the app lifetime (~2,880 spawns/day) gated only on
// window visibility, even though the binary maintains a pending-state file
// (`.merlin-oauth-pending.json`, written next to the config so it lands under
// StateDir) that answers "is there anything pending?" with a single fs.stat.
// This gate skips the spawn when:
//   (a) the pending-state file does not exist at any candidate path, or
//   (b) the file's mtime is unchanged since the last EMPTY result AND the
//       last `emptyThreshold` (default 3) polls all came back empty.
// Everything else spawns normally. force() punches through the gate for one
// poll and resets the learned state: call it when an OAuth flow starts or
// when the renderer requests an immediate refresh (oauth-pending-refresh
// IPC), so a just-started flow is never invisible for a stale-gate reason.
//
// Dedup strategy note (CLAUDE.md Dedup Contract): this is strategy 2, a live
// state check against the source of truth. The binary's pending-state file
// IS the durable key; stat() is the O(1) query that runs before the
// expensive external call (the process spawn).

'use strict';

const DEFAULT_EMPTY_THRESHOLD = 3;

// createOAuthPendingGate({ fsImpl, candidates, emptyThreshold })
//   fsImpl       : fs module (injectable for tests). Only statSync is used.
//   candidates   : absolute paths where the binary may keep the pending
//                   file (flat StateDir for new installs, legacy
//                   .claude/tools/ nesting for old ones). First hit wins.
//   emptyThreshold: consecutive empty polls required before the
//                   unchanged-mtime skip engages.
function createOAuthPendingGate(opts) {
  const o = opts || {};
  const fsImpl = o.fsImpl || require('fs');
  const candidates = Array.isArray(o.candidates) ? o.candidates.filter(Boolean) : [];
  const emptyThreshold = Number.isInteger(o.emptyThreshold) && o.emptyThreshold > 0
    ? o.emptyThreshold
    : DEFAULT_EMPTY_THRESHOLD;

  let lastEmptyMtimeMs = null; // mtime observed at the most recent empty result
  let consecutiveEmpty = 0;    // empty results since the last non-empty one
  let forced = false;          // next shouldSpawn() bypasses the gate once

  function statPendingFile() {
    for (const p of candidates) {
      try {
        const st = fsImpl.statSync(p);
        return { path: p, mtimeMs: st.mtimeMs };
      } catch {
        // absent or unreadable: try the next candidate
      }
    }
    return null;
  }

  return {
    // Punch through the gate on the next poll and forget learned state.
    // Called when an OAuth flow starts and on renderer-forced refreshes.
    force() {
      forced = true;
      consecutiveEmpty = 0;
      lastEmptyMtimeMs = null;
    },

    // Decide whether the poller should spawn the binary this tick.
    // Returns { spawn, reason, mtimeMs }. When spawn is false the caller
    // pushes an empty pending payload to the renderer and skips execFile.
    shouldSpawn() {
      if (forced) {
        forced = false;
        return { spawn: true, reason: 'forced', mtimeMs: null };
      }
      const st = statPendingFile();
      if (!st) {
        return { spawn: false, reason: 'no-pending-file', mtimeMs: null };
      }
      if (
        lastEmptyMtimeMs !== null &&
        st.mtimeMs === lastEmptyMtimeMs &&
        consecutiveEmpty >= emptyThreshold
      ) {
        return { spawn: false, reason: 'unchanged-and-empty', mtimeMs: st.mtimeMs };
      }
      return { spawn: true, reason: 'poll', mtimeMs: st.mtimeMs };
    },

    // Report a completed spawn so the gate can learn. `wasEmpty` is whether
    // the binary returned zero pending flows; `mtimeMs` is the value from
    // the shouldSpawn() that authorized the spawn (null on forced polls,
    // which intentionally never arms the unchanged-mtime skip).
    record(wasEmpty, mtimeMs) {
      if (wasEmpty) {
        consecutiveEmpty += 1;
        if (mtimeMs !== null && mtimeMs !== undefined) lastEmptyMtimeMs = mtimeMs;
      } else {
        consecutiveEmpty = 0;
        lastEmptyMtimeMs = null;
      }
    },

    // Test-only introspection.
    _state() {
      return { lastEmptyMtimeMs, consecutiveEmpty, forced, emptyThreshold };
    },
  };
}

module.exports = { createOAuthPendingGate, DEFAULT_EMPTY_THRESHOLD };
