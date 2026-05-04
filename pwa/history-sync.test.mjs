// Regression test for the chat-history sync wiring (RSI Loop 4, 2026-05-03).
//
// Before this fix, opening the PWA after a desktop chat session showed an
// empty conversation — the desktop had full per-brand history in
// `app/threads.js` (`.merlin-threads.json`, up to 500 bubbles per brand)
// but NO wire protocol existed to expose it to a PWA. Page reloads, brand
// switches, and disconnect/reconnect all cleared the visible chat. This is
// the cold-load gap the user reported.
//
// The fix wires three layers:
//   1. PWA mints `{type:'request-history', limit:N}` on auth-ok and
//      the desktop replies with a single `{type:'history-snapshot',
//      payload:{brand, bubbles}}` frame.
//   2. The relay (durable.js) forwards both new types — extends
//      DESKTOP_TO_PWA_TYPES, PWA_TO_DESKTOP_TYPES, ENVELOPE_FIELDS
//      (added `limit`), and lightValidate.
//   3. The PWA persists chat to localStorage on every render so a page
//      reload paints instantly without waiting for the WS handshake.
//      The wire snapshot dedups against the cache by ts.
//
// Run with: node --test pwa/history-sync.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.join(__dirname, '..');
const PWA_JS = readFileSync(path.join(REPO, 'pwa', 'pwa.js'), 'utf8');
const WS_SERVER = readFileSync(path.join(REPO, 'app', 'ws-server.js'), 'utf8');
const RELAY_CLIENT = readFileSync(path.join(REPO, 'app', 'relay-client.js'), 'utf8');
const MAIN_JS = readFileSync(path.join(REPO, 'app', 'main.js'), 'utf8');

function loadDurableJs() {
  const candidates = [
    path.join(REPO, '..', 'autocmo-core', 'relay', 'durable.js'),
    path.join(REPO, '..', '..', '..', 'autocmo-core', 'relay', 'durable.js'),
    path.join(REPO, '..', '..', 'autocmo-core', 'relay', 'durable.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}
const DURABLE_JS = loadDurableJs();

// ── PWA-side ──────────────────────────────────────────────────────────
test('pwa.js carries the RSI Loop 4 REGRESSION GUARD comment', () => {
  assert.ok(
    /REGRESSION GUARD \(2026-05-03, RSI Loop 4\)/.test(PWA_JS),
    'pwa.js must carry the RSI Loop 4 REGRESSION GUARD — explains the cold-load chat-empty incident the fix prevents'
  );
});

test('pwa.js declares the history cache + helpers', () => {
  assert.ok(
    /HISTORY_CACHE_KEY\s*=\s*['"]merlin\.chat\.cache\.v1['"]/.test(PWA_JS),
    'pwa.js must declare HISTORY_CACHE_KEY for localStorage chat persistence'
  );
  for (const name of ['loadHistoryCache', 'saveHistoryCache', 'rehydrateFromCache', 'applyHistorySnapshot', 'requestHistory', 'renderHistoryBubble']) {
    assert.ok(
      new RegExp('function\\s+' + name + '\\s*\\(').test(PWA_JS),
      `pwa.js must declare function ${name} — load-bearing for the history sync wiring`
    );
  }
});

test('pwa.js requests history on auth-ok', () => {
  // The auth-ok case must invoke requestHistory after drainOutbox, so
  // queued sends land before we ask for the prior snapshot (avoids a
  // brief race where the snapshot arrives before our queued message).
  const re = /case\s+['"]auth-ok['"]\s*:[\s\S]{0,800}requestHistory\(\)/;
  assert.ok(
    re.test(PWA_JS),
    'auth-ok case must invoke requestHistory() — without it the PWA never asks the desktop for prior chat'
  );
});

test('pwa.js handles history-snapshot WS frames', () => {
  assert.ok(
    /case\s+['"]history-snapshot['"][\s\S]{0,200}applyHistorySnapshot\(/.test(PWA_JS),
    'pwa.js ws.onmessage must handle case "history-snapshot" via applyHistorySnapshot()'
  );
});

test('pwa.js init() rehydrates the cache before connecting', () => {
  // Cache rehydrate is a UX win: paint instantly, then sync over wire.
  // It MUST run before the WS connect path, not after, otherwise a
  // 1-3s relay handshake leaves the user staring at a blank chat.
  const initStart = PWA_JS.indexOf('async function init(');
  assert.ok(initStart > 0, 'init() function must exist');
  const initBody = PWA_JS.slice(initStart, initStart + 1500);
  const rehydrateIdx = initBody.indexOf('rehydrateFromCache(');
  const connectIdx = Math.min(
    ...['connectLan(', 'connectRelay(', 'parseHash(']
      .map((s) => initBody.indexOf(s))
      .filter((i) => i > 0)
  );
  assert.ok(rehydrateIdx > 0, 'init() must call rehydrateFromCache()');
  assert.ok(rehydrateIdx < connectIdx, 'rehydrateFromCache() must run BEFORE the WS connect path so the cached chat paints first');
});

test('pwa.js dedup: addUserBubble accepts skipCache and respects RENDERED_TS', () => {
  // The history-rehydrate path passes skipCache to avoid double-writing
  // the cache for messages that came FROM the cache. RENDERED_TS is the
  // dedup key against same-session history-snapshot replies.
  assert.ok(
    /function\s+addUserBubble\s*\(\s*text\s*,\s*opts\s*\)/.test(PWA_JS),
    'addUserBubble must accept (text, opts) so renderHistoryBubble can pass skipCache'
  );
  assert.ok(
    /skipCache/.test(PWA_JS) && /RENDERED_TS/.test(PWA_JS),
    'pwa.js must reference skipCache + RENDERED_TS — the dedup is not optional'
  );
});

test('pwa.js finalizeBubble persists assistant text to cache (round-trip)', () => {
  // When the assistant turn ends, its full text must be cached too —
  // otherwise a page reload after an assistant reply would only show
  // the user side of the conversation.
  const startIdx = PWA_JS.indexOf('function finalizeBubble(');
  assert.ok(startIdx > 0, 'finalizeBubble must exist');
  const body = PWA_JS.slice(startIdx, startIdx + 800);
  assert.ok(
    /appendCacheBubble\(/.test(body) && /role:\s*['"]claude['"]/.test(body),
    'finalizeBubble must call appendCacheBubble({role:"claude",...}) so assistant turns survive page reload'
  );
});

// ── Desktop-side: ws-server.js ────────────────────────────────────────
test('ws-server.js routes request-history to onRequestHistory and replies on the same socket', () => {
  assert.ok(
    /case\s+['"]request-history['"]\s*:[\s\S]{0,800}onRequestHistory\(/.test(WS_SERVER),
    'ws-server.js must handle case "request-history" by calling onRequestHistory'
  );
  // Must reply via ws.send (LAN: targeted single-recipient delivery),
  // not via wss-broadcast — otherwise other paired phones get painted
  // over their own local cache.
  const m = WS_SERVER.match(/case\s+['"]request-history['"]\s*:[\s\S]+?break;\s*\}/);
  assert.ok(m, 'request-history case body extractable');
  assert.ok(
    /ws\.send\(/.test(m[0]),
    'request-history reply must use ws.send (per-socket), not broadcast'
  );
  assert.ok(
    /history-snapshot/.test(m[0]),
    'reply frame must be type history-snapshot'
  );
});

test('ws-server.js setHandlers wires onRequestHistory', () => {
  assert.ok(
    /onRequestHistory\s*=\s*handlers\.onRequestHistory/.test(WS_SERVER),
    'ws-server.js setHandlers must wire onRequestHistory from handlers bag'
  );
});

// ── Desktop-side: relay-client.js ─────────────────────────────────────
test('relay-client.js routes request-history and forwards history-snapshot via DESKTOP_TYPES', () => {
  assert.ok(
    /case\s+['"]request-history['"]\s*:[\s\S]{0,800}onRequestHistory\(/.test(RELAY_CLIENT),
    'relay-client.js must handle case "request-history"'
  );
  assert.ok(
    /forward\(\s*['"]history-snapshot['"]/.test(RELAY_CLIENT),
    'relay-client.js must forward history-snapshot through the relay'
  );
  // DESKTOP_TYPES allowlist must include history-snapshot or forward()
  // refuses to send it.
  const setMatch = RELAY_CLIENT.match(/const\s+DESKTOP_TYPES\s*=\s*new\s+Set\(\[([^\]]+)\]\)/);
  assert.ok(setMatch, 'DESKTOP_TYPES set must exist');
  assert.ok(
    /['"]history-snapshot['"]/.test(setMatch[1]),
    'DESKTOP_TYPES must include "history-snapshot" or forward() will refuse the frame'
  );
});

// ── Desktop-side: main.js ─────────────────────────────────────────────
test('main.js mobileHandlers exposes onRequestHistory backed by threads.getThread', () => {
  assert.ok(
    /onRequestHistory\s*:\s*async/.test(MAIN_JS),
    'main.js mobileHandlers must declare onRequestHistory'
  );
  // Must consult threads.getThread for the active brand.
  const handlerStart = MAIN_JS.indexOf('onRequestHistory: async');
  assert.ok(handlerStart > 0);
  const body = MAIN_JS.slice(handlerStart, handlerStart + 800);
  assert.ok(
    /threads\.getThread\(/.test(body),
    'onRequestHistory must read threads.getThread(activeBrand) — the source-of-truth bubble log'
  );
  assert.ok(
    /readState\(\)\.activeBrand/.test(body),
    'onRequestHistory must scope to the current active brand (readState().activeBrand)'
  );
  // Limit must be clamped (no unbounded array stringify).
  assert.ok(
    /Math\.min\(\s*500/.test(body) || /Math\.min\(500/.test(body),
    'onRequestHistory must clamp the requested limit to 500 (matches threads.MAX_BUBBLES)'
  );
});

// ── Relay-side: durable.js ────────────────────────────────────────────
test('durable.js DESKTOP_TO_PWA_TYPES + PWA_TO_DESKTOP_TYPES include the new types', () => {
  if (!DURABLE_JS) {
    console.log('  (skipped — durable.js not reachable from this worktree)');
    return;
  }
  const dt = DURABLE_JS.match(/const\s+DESKTOP_TO_PWA_TYPES\s*=\s*new\s+Set\(\[([\s\S]+?)\]\)/);
  const pt = DURABLE_JS.match(/const\s+PWA_TO_DESKTOP_TYPES\s*=\s*new\s+Set\(\[([\s\S]+?)\]\)/);
  assert.ok(dt && pt);
  assert.ok(
    /['"]history-snapshot['"]/.test(dt[1]),
    'durable.js DESKTOP_TO_PWA_TYPES must include "history-snapshot"'
  );
  assert.ok(
    /['"]request-history['"]/.test(pt[1]),
    'durable.js PWA_TO_DESKTOP_TYPES must include "request-history"'
  );
});

test('durable.js ENVELOPE_FIELDS includes "limit"', () => {
  if (!DURABLE_JS) {
    console.log('  (skipped)');
    return;
  }
  const m = DURABLE_JS.match(/const\s+ENVELOPE_FIELDS\s*=\s*\[([^\]]+)\]/);
  assert.ok(m);
  assert.ok(
    /['"]limit['"]/.test(m[1]),
    'ENVELOPE_FIELDS must include "limit" — the request-history envelope carries it top-level'
  );
});

test('durable.js lightValidate rejects out-of-bound limit on request-history', () => {
  if (!DURABLE_JS) {
    console.log('  (skipped)');
    return;
  }
  // Find the request-history case in lightValidate and assert it caps
  // limit at 500 (threads.MAX_BUBBLES) — the pathological-DOS guard.
  const m = DURABLE_JS.match(/case\s+['"]request-history['"]\s*:[\s\S]+?(?=case|default)/);
  assert.ok(m, 'lightValidate request-history case not found');
  assert.ok(
    /500/.test(m[0]),
    'lightValidate must cap request-history limit at 500'
  );
});
