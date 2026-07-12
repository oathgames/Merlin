// switch-coalescer.js: last-click-wins serialization for brand switches.
//
// The problem (2026-07-11, "sometimes I have to click a brand twice"):
// the switch-brand IPC handler used a boolean in-flight guard that REJECTED
// a second click with "switch already in progress", and bailed with
// "previous session did not stop in time, try again" when the prior SDK
// loop took more than 2s to unwind. Both paths punted the retry to the
// user: the first click wiped the chat, snapped back, and only a second
// click landed.
//
// This module replaces the reject-and-retry design with a serialized queue
// where the LAST requested brand always wins:
//   - Calls are chained: only one switch body runs at a time (the
//     activeQuery singleton cannot race).
//   - A call that is still queued when a NEWER call arrives resolves with
//     { success: false, superseded: true } without doing any work; the
//     newest call performs the real switch. The renderer treats superseded
//     as "a later click owns the UI" and touches nothing.
//   - The in-flight switch is never abandoned mid-body; a newer click waits
//     behind it, then runs.
//
// Every caller therefore gets a terminal answer: success, superseded, or a
// genuine failure after the switch body's own (extended) patience runs out.
'use strict';

function createSwitchCoalescer() {
  let seq = 0;
  let chain = Promise.resolve();

  return {
    // run(target, doSwitch): enqueue a switch to `target`. doSwitch(target)
    // is invoked only if no newer run() arrived while this one was queued.
    // Never rejects: doSwitch errors surface as { success: false, error }.
    run(target, doSwitch) {
      seq += 1;
      const mySeq = seq;
      const result = chain.then(() => {
        if (mySeq !== seq) {
          return { success: false, superseded: true };
        }
        return doSwitch(target);
      });
      // Keep the chain alive whatever happens to this link: failures become
      // resolved values so one bad switch can never wedge every later one.
      chain = result.then(() => undefined, () => undefined);
      return result.catch((err) => ({
        success: false,
        error: (err && err.message) || 'switch failed',
      }));
    },
  };
}

module.exports = { createSwitchCoalescer };
