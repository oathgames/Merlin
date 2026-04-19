// Async init barrier used to serialize session starts against rapid
// dropdown switches. The problem it solves:
//
//   startSession() is async and fire-and-forget from the switch-brand IPC
//   handler — it awaits a subscription check, an SDK import, and MCP boot
//   before reaching its `activeQuery = query(...)` assignment. If a second
//   switch lands inside that pre-assignment window, activeQuery is still
//   null, the handler's abort sequence no-ops, and two startSessions run
//   in parallel — they race on the activeQuery singleton and leave the UI
//   pointing at one brand while the live SDK session runs as another.
//
// The barrier gives switch-brand a single promise to await before it
// issues its abort sequence, ensuring every prior init has either:
//   - Finished and set activeQuery (abort path works normally), OR
//   - Returned early without creating a query (abort is a no-op, but state
//     is deterministic).
//
// Usage:
//   const barrier = createInitBarrier();
//   // When a new init starts:
//   const release = barrier.arm();
//   try {
//     // ...init work that may early-return or throw...
//   } finally {
//     release();
//   }
//
//   // When a consumer needs to serialize against the init:
//   await barrier.whenReady(); // resolves when current init (if any) finishes
//
// Sequencing guarantee: arm() chains — if called while a prior init is
// still running, the new barrier is not considered "ready" until the prior
// one completes. This matches the real flow where rapid init attempts
// should serialize, not interleave.

'use strict';

function createInitBarrier() {
  // Resolves when the CURRENT armed init is done. Null when no init is
  // in-flight. Never rejects — errors inside an armed init are the
  // caller's business, we just signal completion.
  let current = null;

  function arm() {
    const prior = current;
    let resolve;
    const mine = new Promise((r) => { resolve = r; });
    current = mine;
    // Arm returns a release function. It is the caller's responsibility
    // to invoke release() in a finally block so every exit path — early
    // return, successful completion, thrown error — unblocks waiters.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try { resolve(); } catch {}
      if (current === mine) current = null;
    };
    // If a prior init is still in-flight, new waiters must see BOTH
    // complete before proceeding. We wrap `mine` in a promise that awaits
    // the prior first, then `mine`.
    if (prior) {
      const chained = (async () => {
        try { await prior; } catch {}
        await mine;
      })();
      current = chained;
      // Keep `current` pointing at the chained promise so later arm()
      // calls chain onto it. But our release() still needs to resolve
      // `mine` so the chain can complete.
      return { release, ready: chained };
    }
    return { release, ready: mine };
  }

  function whenReady() {
    return current ? current.catch(() => {}) : Promise.resolve();
  }

  function isArmed() {
    return current !== null;
  }

  return { arm, whenReady, isArmed };
}

module.exports = { createInitBarrier };
