// Per-brand conversation threads.
//
// Each brand gets its own Claude Agent SDK session (resumed by sessionId) plus
// a lightweight bubble log used by the renderer to rehydrate the chat when the
// user switches brands. The SDK persists the authoritative transcript at
// ~/.claude/projects/<cwd-hash>/<session_id>.jsonl; this file only stores the
// minimum the UI needs: which session belongs to which brand, plus a flat list
// of user/claude bubbles to re-paint on switch.
//
// File format (.merlin-threads.json):
//   {
//     "brands": {
//       "<brand-id>": {
//         "sessionId": "<uuid>" | null,
//         "lastActiveAt": "2026-04-18T12:34:56.000Z",
//         "bubbles": [ { "role": "user" | "claude", "text": "...", "ts": epoch_ms } ]
//       }
//     }
//   }
//
// Bubbles are capped at MAX_BUBBLES (oldest pruned first) so the file never
// grows unbounded. The SDK transcript on disk is the source of truth for
// Claude's memory; bubbles are UI-only.
//
// Storage model (2026-07-11 audit fix): the parsed object lives IN MEMORY as
// the single source of truth (the Electron main process is the only writer).
// The old model re-did readFileSync + JSON.parse + pretty-print stringify +
// writeFileSync + renameSync of the whole multi-brand file on EVERY
// appendBubble, inside the send-message IPC path, and the cost grew with
// usage (500 bubbles x N brands x 20KB texts). Now:
//   - load once lazily per appRoot, mutate in memory;
//   - flush via a debounced (FLUSH_DELAY_MS) async atomic write (temp +
//     rename), timer unref'd so it never holds the process open;
//   - flushSync() runs on app quit (main.js before-quit) to persist any
//     pending window synchronously.
// Durability tradeoff, on purpose: a hard crash between debounced flushes
// loses at most the last FLUSH_DELAY_MS of bubbles. Bubbles are a UI
// rehydration cache, not the transcript (the SDK's jsonl is), so losing a
// sub-second window is invisible next to the crash itself; sessionId writes
// matter more and still land on the next flush or the quit hook.
// Pretty-printing was dropped (JSON.stringify without indent): the file is
// machine-read only and indentation tripled its size.

const fs = require('fs');
const path = require('path');

const MAX_BUBBLES = 500;
const MAX_TEXT_LEN = 20000;
const FLUSH_DELAY_MS = 750; // debounce window, also the max crash-loss window

let _flushDelayMs = FLUSH_DELAY_MS;

// appRoot -> { data, timer, dirty, writes }
// Keyed by appRoot so tests with distinct temp roots stay isolated;
// production only ever uses one.
const _states = new Map();

function filePath(appRoot) {
  return path.join(appRoot, '.merlin-threads.json');
}

function _normalize(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { brands: {} };
  if (!parsed.brands || typeof parsed.brands !== 'object' || Array.isArray(parsed.brands)) parsed.brands = {};
  return parsed;
}

function _readFromDisk(appRoot) {
  try {
    const raw = fs.readFileSync(filePath(appRoot), 'utf8');
    return _normalize(JSON.parse(raw));
  } catch {
    return { brands: {} };
  }
}

function _state(appRoot) {
  let st = _states.get(appRoot);
  if (!st) {
    st = { data: _readFromDisk(appRoot), timer: null, dirty: false, writes: 0 };
    _states.set(appRoot, st);
  }
  return st;
}

function _serialize(st) {
  // No pretty-print: machine-read only.
  return JSON.stringify(st.data);
}

async function _flushAsync(appRoot) {
  const st = _states.get(appRoot);
  if (!st || !st.dirty) return true;
  st.dirty = false;
  const full = filePath(appRoot);
  const tmp = full + '.tmp';
  try {
    await fs.promises.writeFile(tmp, _serialize(st));
    await fs.promises.rename(tmp, full);
    st.writes += 1;
    return true;
  } catch (e) {
    st.dirty = true; // keep pending: the next mutation or the quit hook retries
    console.error('[threads] flush failed:', e.message);
    return false;
  }
}

function _scheduleFlush(appRoot) {
  const st = _state(appRoot);
  st.dirty = true;
  if (st.timer) return; // coalesce: one write per debounce window
  st.timer = setTimeout(() => {
    st.timer = null;
    _flushAsync(appRoot).catch(() => {});
  }, _flushDelayMs);
  // Never hold the process open for a bubble-cache write.
  if (typeof st.timer.unref === 'function') st.timer.unref();
}

// Synchronous flush for the quit path: after before-quit the event loop may
// never run the pending async flush, so write NOW. Also cancels the timer.
// Safe to call any time; no-op when nothing is pending.
function flushSync(appRoot) {
  const st = _states.get(appRoot);
  if (!st || !st.dirty) return true;
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  const full = filePath(appRoot);
  const tmp = full + '.tmp';
  try {
    fs.writeFileSync(tmp, _serialize(st));
    fs.renameSync(tmp, full);
    st.dirty = false;
    st.writes += 1;
    return true;
  } catch (e) {
    console.error('[threads] sync flush failed:', e.message);
    return false;
  }
}

// Back-compat read: returns the in-memory object (loaded lazily from disk on
// first touch). Callers must treat it as read-only; mutations go through the
// exported mutators so the debounced flush sees them.
function read(appRoot) {
  return _state(appRoot).data;
}

// Back-compat write: replace the whole object and persist immediately
// (the old contract was a synchronous write; seeding/tests rely on it).
function write(appRoot, data) {
  const st = _state(appRoot);
  st.data = _normalize(data);
  st.dirty = true;
  return flushSync(appRoot);
}

function ensureBrand(data, brand) {
  if (!data.brands[brand]) {
    data.brands[brand] = { sessionId: null, lastActiveAt: null, bubbles: [] };
  }
  const b = data.brands[brand];
  if (!Array.isArray(b.bubbles)) b.bubbles = [];
  if (typeof b.sessionId !== 'string' && b.sessionId !== null) b.sessionId = null;
  return b;
}

function getThread(appRoot, brand) {
  if (!brand) return { sessionId: null, lastActiveAt: null, bubbles: [] };
  const entry = ensureBrand(_state(appRoot).data, brand);
  // Copy the container + bubbles array so callers can't mutate the live
  // store by accident (bubble objects themselves are treated as immutable).
  return { ...entry, bubbles: entry.bubbles.slice() };
}

function getSessionId(appRoot, brand) {
  if (!brand) return null;
  return ensureBrand(_state(appRoot).data, brand).sessionId || null;
}

function setSessionId(appRoot, brand, sessionId) {
  if (!brand || typeof sessionId !== 'string' || !sessionId) return false;
  const entry = ensureBrand(_state(appRoot).data, brand);
  if (entry.sessionId === sessionId) return true;
  entry.sessionId = sessionId;
  entry.lastActiveAt = new Date().toISOString();
  _scheduleFlush(appRoot);
  return true;
}

function touch(appRoot, brand) {
  if (!brand) return false;
  const entry = ensureBrand(_state(appRoot).data, brand);
  entry.lastActiveAt = new Date().toISOString();
  _scheduleFlush(appRoot);
  return true;
}

function appendBubble(appRoot, brand, role, text) {
  if (!brand) return false;
  if (role !== 'user' && role !== 'claude') return false;
  if (typeof text !== 'string' || !text.length) return false;
  const trimmed = text.length > MAX_TEXT_LEN ? text.slice(0, MAX_TEXT_LEN) : text;
  const entry = ensureBrand(_state(appRoot).data, brand);
  entry.bubbles.push({ role, text: trimmed, ts: Date.now() });
  if (entry.bubbles.length > MAX_BUBBLES) {
    entry.bubbles = entry.bubbles.slice(-MAX_BUBBLES);
  }
  entry.lastActiveAt = new Date().toISOString();
  _scheduleFlush(appRoot);
  return true;
}

function clearThread(appRoot, brand) {
  if (!brand) return false;
  const data = _state(appRoot).data;
  if (!data.brands[brand]) return true;
  data.brands[brand] = { sessionId: null, lastActiveAt: null, bubbles: [] };
  _scheduleFlush(appRoot);
  return true;
}

function listBrands(appRoot) {
  return Object.keys(_state(appRoot).data.brands);
}

module.exports = {
  MAX_BUBBLES,
  MAX_TEXT_LEN,
  FLUSH_DELAY_MS,
  filePath,
  read,
  write,
  getThread,
  getSessionId,
  setSessionId,
  touch,
  appendBubble,
  clearThread,
  listBrands,
  flushSync,
  // Test-only hooks. NOT part of the public API.
  _testHooks: {
    setFlushDelayForTest(ms) {
      _flushDelayMs = Number.isFinite(ms) && ms > 0 ? ms : FLUSH_DELAY_MS;
    },
    // Drop all cached state + pending timers so each test starts cold.
    resetForTests() {
      for (const st of _states.values()) {
        if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      }
      _states.clear();
      _flushDelayMs = FLUSH_DELAY_MS;
    },
    getWriteCount(appRoot) {
      const st = _states.get(appRoot);
      return st ? st.writes : 0;
    },
    isDirty(appRoot) {
      const st = _states.get(appRoot);
      return st ? st.dirty : false;
    },
    flushAsync: _flushAsync,
  },
};
