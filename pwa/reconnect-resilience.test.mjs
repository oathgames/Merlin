// Regression test for the three RSI Loop 6 (2026-05-03) reconnect fixes:
//
//   1. The `online` listener must NOT zero reconnectAttempts. Pre-fix
//      every cellular flap collapsed the exponential backoff and
//      triggered a thundering-herd reconnect against the relay. The
//      correct anchor for "network is genuinely back" is ws.onopen,
//      which already zeros the counter.
//
//   2. visibilitychange→visible on a healthy socket must request a
//      fresh history snapshot so the foreground UI reflects what the
//      desktop did while the tab was backgrounded (autonomous spell,
//      scheduled task, desktop-typed message). Idempotent: dedups
//      against RENDERED_TS server-side.
//
//   3. The relay durable.js MAX_CONNECTIONS cap must NEVER evict the
//      desktop. Pre-fix `existing[0].close(...)` kicked whichever
//      socket landed at index 0 in insertion order — typically the
//      desktop, since it dials first at app launch. The fix filters to
//      PWA attachments and evicts the OLDEST PWA only.
//
// Run with: node --test pwa/reconnect-resilience.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.join(__dirname, '..');
const PWA_JS = readFileSync(path.join(REPO, 'pwa', 'pwa.js'), 'utf8');

function loadDurableJs() {
  const candidates = [
    path.join(REPO, '..', 'autocmo-core', 'relay', 'durable.js'),
    path.join(REPO, '..', '..', '..', 'autocmo-core', 'relay', 'durable.js'),
    path.join(REPO, '..', '..', 'autocmo-core', 'relay', 'durable.js'),
  ];
  for (const p of candidates) if (existsSync(p)) return readFileSync(p, 'utf8');
  return null;
}
const DURABLE_JS = loadDurableJs();

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ── Fix #1: online listener does not zero reconnectAttempts ──────────
test('online listener does NOT zero reconnectAttempts (preserves backoff under flap)', () => {
  // Find the addEventListener('online', ...) handler block.
  const m = PWA_JS.match(/addEventListener\(['"]online['"][\s\S]*?\)\s*;?/);
  assert.ok(m, 'online listener registration not found in pwa.js');
  // Walk to find the arrow body + its closing brace.
  const start = PWA_JS.indexOf('addEventListener(\'online\'');
  const arrowStart = PWA_JS.indexOf('=>', start);
  assert.ok(arrowStart > 0, 'online arrow not found');
  const openBrace = PWA_JS.indexOf('{', arrowStart);
  let depth = 1;
  let i = openBrace + 1;
  for (; i < PWA_JS.length && depth > 0; i++) {
    if (PWA_JS[i] === '{') depth++;
    else if (PWA_JS[i] === '}') depth--;
  }
  const body = stripComments(PWA_JS.slice(openBrace, i));
  // Executable code (post-comment-strip) must NOT zero reconnectAttempts.
  assert.ok(
    !/reconnectAttempts\s*=\s*0/.test(body),
    'online listener must NOT contain reconnectAttempts = 0 (pre-fix bug — collapsed backoff under cellular flap, thundering-herd against the relay). The correct anchor for "network is back" is ws.onopen.'
  );
  // It MUST still kick a reconnect when the socket isn't open.
  assert.ok(
    /scheduleReconnect\(\)/.test(body),
    'online listener must call scheduleReconnect() when ws is not OPEN — otherwise an offline → online transition leaves the user stranded'
  );
});

test('ws.onopen still zeros reconnectAttempts (the actual anchor)', () => {
  // The onopen handler is the ONLY place that should reset the counter
  // — that's the signal "network path verified working." Pre-fix two
  // places zeroed it (onopen + online); the duplicate in online was
  // the bug.
  const m = PWA_JS.match(/ws\.onopen\s*=\s*\(\)\s*=>\s*\{[\s\S]*?reconnectAttempts\s*=\s*0/);
  assert.ok(m, 'ws.onopen must zero reconnectAttempts — the anchor for verified-good network');
});

// ── Fix #2: visibilitychange requests history on return-to-foreground ─
test('visibilitychange handler requests history on return-to-foreground when WS is healthy', () => {
  // Walk the visibility handler body.
  const start = PWA_JS.indexOf('visibilitychange');
  assert.ok(start > 0, 'visibilitychange handler not found');
  const openBrace = PWA_JS.indexOf('{', start);
  let depth = 1;
  let i = openBrace + 1;
  for (; i < PWA_JS.length && depth > 0; i++) {
    if (PWA_JS[i] === '{') depth++;
    else if (PWA_JS[i] === '}') depth--;
  }
  const body = PWA_JS.slice(openBrace, i);
  // Must call requestHistory in the healthy-socket branch.
  assert.ok(
    /requestHistory\(\)/.test(body),
    'visibilitychange handler must call requestHistory() when the socket is healthy — otherwise foreground tab returns showing stale chat (desktop may have advanced the conversation while backgrounded)'
  );
});

// ── Fix #3: relay MAX_CONNECTIONS cap never evicts the desktop ───────
test('durable.js MAX_CONNECTIONS eviction filters to PWA role (never closes the desktop)', () => {
  if (!DURABLE_JS) {
    console.log('  (skipped — durable.js not reachable from this worktree)');
    return;
  }
  // Locate the cap branch — `existing.length >= MAX_CONNECTIONS`.
  const idx = DURABLE_JS.indexOf('existing.length >= MAX_CONNECTIONS');
  assert.ok(idx > 0, 'MAX_CONNECTIONS cap branch not found in durable.js');
  // Window: 800 chars after the cap test should cover the eviction body.
  const window = DURABLE_JS.slice(idx, idx + 800);
  // Pre-fix this branch was a single line: `try { existing[0].close(...) }`
  // The fix MUST filter to role:'pwa' before picking a victim.
  assert.ok(
    /role\s*===?\s*['"]pwa['"]/.test(window),
    'MAX_CONNECTIONS eviction must filter by role:"pwa" — closing the desktop here black-holes every PWA→desktop send (sendToDesktop loop fails silently)'
  );
  // The eviction must reference a sorted-by-connectedAt selection so we
  // kick the OLDEST PWA, not a random one.
  assert.ok(
    /connectedAt/.test(window),
    'MAX_CONNECTIONS eviction must sort by connectedAt — kicking the oldest PWA preserves the user\'s most-recent device'
  );
});

test('durable.js carries the RSI Loop 6 REGRESSION GUARD comment', () => {
  if (!DURABLE_JS) return;
  assert.ok(
    /REGRESSION GUARD \(2026-05-03, RSI Loop 6\)/.test(DURABLE_JS),
    'durable.js must carry the RSI Loop 6 REGRESSION GUARD on the MAX_CONNECTIONS eviction path'
  );
});
