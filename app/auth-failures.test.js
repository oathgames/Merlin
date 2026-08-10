// Tests for auth-failures.js and its wiring: the revoked-grant tile fix
// (2026-07-11 audit).
//
// Bug: getConnections marked 'expired' by token AGE alone (55 days). A grant
// revoked server-side 401s on every call while the tile stays green. The MCP
// layer already classifies those errors as TOKEN_EXPIRED (mcp-errors.js);
// these tests pin the full loop:
//   classify TOKEN_EXPIRED → flag persists → getConnections overlay shows
//   'expired' → successful reconnect / successful action clears it.
// main.js requires electron, so its wiring (store instance, getConnections
// overlay, applyExchangeResult clear, mcpCtx hook) is pinned by source scan.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createAuthFailureStore, scopeKey } = require('./auth-failures');
const { platformForAuthSignal, noteAuthSignalFromResult } = require('./mcp-tools');

// In-memory stand-in for main.js readState/writeState (shallow merge, like
// writeState's `{ ...readState(), ...data }`).
function makeMemoryState(initial = {}) {
  let state = { ...initial };
  return {
    readState: () => ({ ...state }),
    writeState: (data) => { state = { ...state, ...data }; return true; },
    _get: () => state,
  };
}

// ── Store behavior ───────────────────────────────────────────────────

test('mark persists a per-platform-per-brand flag and the overlay reports expired', () => {
  const mem = makeMemoryState();
  const store = createAuthFailureStore({ ...mem });
  assert.equal(store.mark('meta', 'brightco'), true);
  const connected = [
    { platform: 'meta', status: 'connected' },
    { platform: 'tiktok', status: 'connected' },
  ];
  store.applyToConnections(connected, 'brightco');
  assert.equal(connected[0].status, 'expired', 'flagged platform must show expired');
  assert.equal(connected[1].status, 'connected', 'unflagged platform stays green');
});

test('flags are brand-scoped: another brand and the global scope stay green', () => {
  const mem = makeMemoryState();
  const store = createAuthFailureStore({ ...mem });
  store.mark('meta', 'brightco');
  const otherBrand = [{ platform: 'meta', status: 'connected' }];
  store.applyToConnections(otherBrand, 'acmelabs');
  assert.equal(otherBrand[0].status, 'connected');
  const globalScope = [{ platform: 'meta', status: 'connected' }];
  store.applyToConnections(globalScope, '');
  assert.equal(globalScope[0].status, 'connected');
});

test('empty brand maps to the _global scope on both sides', () => {
  const mem = makeMemoryState();
  const store = createAuthFailureStore({ ...mem });
  store.mark('slack', '');
  assert.equal(scopeKey('slack', ''), 'slack|_global');
  const conns = [{ platform: 'slack', status: 'connected' }];
  store.applyToConnections(conns, '');
  assert.equal(conns[0].status, 'expired');
});

test('successful reconnect clears the flag and the tile goes back to connected', () => {
  const mem = makeMemoryState();
  const store = createAuthFailureStore({ ...mem });
  store.mark('google', 'brightco');
  assert.equal(store.clear('google', 'brightco'), true);
  const conns = [{ platform: 'google', status: 'connected' }];
  store.applyToConnections(conns, 'brightco');
  assert.equal(conns[0].status, 'connected');
});

test('overlay never touches non-connected statuses (slack needs-setup, age-based expired)', () => {
  const mem = makeMemoryState();
  const store = createAuthFailureStore({ ...mem });
  store.mark('slack', '');
  const conns = [{ platform: 'slack', status: 'expired' }]; // bot-token-only needs-setup state
  store.applyToConnections(conns, '');
  assert.equal(conns[0].status, 'expired', 'status is untouched, not double-processed');
});

test('onChange fires only on real mutations', () => {
  const mem = makeMemoryState();
  let changes = 0;
  const store = createAuthFailureStore({ ...mem, onChange: () => { changes += 1; } });
  store.mark('meta', 'b');       // 1: new flag
  store.mark('meta', 'b');       // no-op, already flagged
  store.clear('meta', 'b');      // 2: removed
  store.clear('meta', 'b');      // no-op, absent
  store.clear('tiktok', 'b');    // no-op, never flagged
  assert.equal(changes, 2, 'connections-changed must not be spammed by no-op marks/clears');
});

test('store survives corrupt state shapes', () => {
  const store = createAuthFailureStore({
    readState: () => ({ authFailures: 'not-an-object' }),
    writeState: () => true,
  });
  assert.equal(store.mark('meta', 'b'), true);
  const conns = [{ platform: 'meta', status: 'connected' }];
  // snapshot() falls back to {} on the corrupt shape: no throw.
  store.applyToConnections(conns, 'b');
  assert.equal(conns[0].status, 'connected');
});

// ── MCP-layer signal (mcp-tools.js) ──────────────────────────────────

test('platformForAuthSignal maps action prefixes to connection-panel platforms', () => {
  assert.equal(platformForAuthSignal('meta-insights'), 'meta');
  assert.equal(platformForAuthSignal('google-ads-push'), 'google');
  assert.equal(platformForAuthSignal('google-analytics-traffic'), 'google');
  assert.equal(platformForAuthSignal('merchant-status'), 'google');
  assert.equal(platformForAuthSignal('shopify-orders'), 'shopify');
  assert.equal(platformForAuthSignal('threads-post'), 'meta', 'Threads rides the Meta grant');
  // Aggregates cannot attribute a token failure to one platform.
  assert.equal(platformForAuthSignal('dashboard'), null);
  assert.equal(platformForAuthSignal('generate'), null);
  assert.equal(platformForAuthSignal(undefined), null);
});

test('TOKEN_EXPIRED classification reports token_expired through the ctx hook', () => {
  const calls = [];
  const ctx = { notePlatformAuthResult: (p, b, o) => calls.push([p, b, o]) };
  noteAuthSignalFromResult(ctx, 'meta-insights', { brand: 'brightco' }, true,
    'Meta API error: OAuth token has expired, please re-authenticate');
  assert.deepStrictEqual(calls, [['meta', 'brightco', 'token_expired']]);
});

test('a successful action reports success (clears the flag downstream)', () => {
  const calls = [];
  const ctx = { notePlatformAuthResult: (p, b, o) => calls.push([p, b, o]) };
  noteAuthSignalFromResult(ctx, 'meta-insights', { brand: 'brightco' }, false, 'ROAS 3.2 ...');
  assert.deepStrictEqual(calls, [['meta', 'brightco', 'success']]);
});

test('non-auth errors (rate limit, timeout) do not touch the flag', () => {
  const calls = [];
  const ctx = { notePlatformAuthResult: (p, b, o) => calls.push([p, b, o]) };
  noteAuthSignalFromResult(ctx, 'meta-insights', { brand: 'b' }, true,
    'merlin rate limit: meta minute cap reached, try again in 12s');
  noteAuthSignalFromResult(ctx, 'tiktok-push', { brand: 'b' }, true,
    'context deadline exceeded');
  assert.deepStrictEqual(calls, [], 'rate limits and timeouts say nothing about the grant');
});

test('unmapped actions and hook-less contexts are silent no-ops', () => {
  const calls = [];
  const ctx = { notePlatformAuthResult: (p, b, o) => calls.push([p, b, o]) };
  noteAuthSignalFromResult(ctx, 'dashboard', { brand: 'b' }, true, 'token has expired');
  assert.deepStrictEqual(calls, []);
  // No hook on ctx: must not throw (unit-test contexts omit it).
  assert.doesNotThrow(() => noteAuthSignalFromResult({}, 'meta-insights', { brand: 'b' }, false, ''));
  assert.doesNotThrow(() => noteAuthSignalFromResult(null, 'meta-insights', { brand: 'b' }, false, ''));
});

// ── main.js wiring (source scan; main.js requires electron) ───────────

function mainSrc() {
  return fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
}

test('main.js instantiates the store over readState/writeState with a connections-changed onChange', () => {
  const src = mainSrc();
  const m = src.match(/const authFailureStore = require\('\.\/auth-failures'\)\.createAuthFailureStore\(\{[\s\S]{0,600}?\}\);/);
  assert.ok(m, 'authFailureStore instantiation not found in main.js');
  assert.match(m[0], /readState/, 'store must persist via readState');
  assert.match(m[0], /writeState/, 'store must persist via writeState');
  assert.match(m[0], /connections-changed/, 'mutations must broadcast connections-changed');
});

test('getConnections applies the revoked-grant overlay', () => {
  const src = mainSrc();
  const fnIdx = src.indexOf('function getConnections(brandName)');
  assert.ok(fnIdx >= 0, 'getConnections not found');
  const body = src.slice(fnIdx, src.indexOf('\n}', fnIdx));
  assert.match(body, /authFailureStore\.applyToConnections\(connected, brandName\)/,
    'getConnections must run the auth-failures overlay before returning');
});

test('applyExchangeResult and the fast-open no-parse path clear the flag on reconnect', () => {
  const src = mainSrc();
  const aer = src.indexOf('function applyExchangeResult(platform, brandName, isGlobalPlatform, parsed)');
  assert.ok(aer >= 0, 'applyExchangeResult not found');
  const aerBody = src.slice(aer, src.indexOf('\n}', aer));
  assert.match(aerBody, /authFailureStore\.clear\(platform/,
    'applyExchangeResult must clear the revoked-grant flag on a completed exchange');
  // Fast-open empty-parse success path (binary persisted tokens itself).
  const guard = src.indexOf('v1.4 Google Ads tile-not-green fix');
  assert.ok(guard >= 0, 'fast-open no-parse guard comment not found');
  const window = src.slice(guard, guard + 900);
  assert.match(window, /authFailureStore\.clear\(platform/,
    'the fast-open no-parse success path must also clear the flag, or the overlay keeps the tile expired after a good reconnect');
});

test('mcpCtx exposes notePlatformAuthResult routing to mark/clear', () => {
  const src = mainSrc();
  const m = src.match(/notePlatformAuthResult:\s*\(platform, brandName, outcome\) => \{[\s\S]{0,400}?\},/);
  assert.ok(m, 'mcpCtx.notePlatformAuthResult not found in main.js');
  assert.match(m[0], /token_expired/, 'token_expired outcome must be handled');
  assert.match(m[0], /authFailureStore\.mark\(/, 'token_expired must mark the flag');
  assert.match(m[0], /authFailureStore\.clear\(/, 'success must clear the flag');
});
