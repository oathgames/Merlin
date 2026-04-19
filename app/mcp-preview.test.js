'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PreviewTokenStore,
  digestPayload,
  canonicalize,
  DEFAULT_POLICIES,
} = require('./mcp-preview');

// ── digestPayload / canonicalize ──────────────────────────────────────────

test('digestPayload is deterministic for equivalent objects', () => {
  const a = digestPayload({ brand: 'x', ads: [{ id: 1 }, { id: 2 }] });
  const b = digestPayload({ ads: [{ id: 1 }, { id: 2 }], brand: 'x' });
  assert.equal(a, b, 'key order must not change digest');
});

test('digestPayload differs for different content', () => {
  const a = digestPayload({ brand: 'x', dailyBudget: 5 });
  const b = digestPayload({ brand: 'x', dailyBudget: 10 });
  assert.notEqual(a, b);
});

test('digestPayload ignores preview and confirm_token fields', () => {
  const base = digestPayload({ brand: 'x', dailyBudget: 5 });
  const withPreview = digestPayload({ brand: 'x', dailyBudget: 5, preview: true });
  const withToken = digestPayload({ brand: 'x', dailyBudget: 5, confirm_token: 'ct-abc' });
  assert.equal(base, withPreview);
  assert.equal(base, withToken);
});

test('digestPayload is order-sensitive for arrays', () => {
  const a = digestPayload({ ads: [{ id: 1 }, { id: 2 }] });
  const b = digestPayload({ ads: [{ id: 2 }, { id: 1 }] });
  assert.notEqual(a, b, 'array order matters — [ad1, ad2] ≠ [ad2, ad1]');
});

test('canonicalize handles null, primitives, nested structures', () => {
  assert.equal(canonicalize(null), null);
  assert.equal(canonicalize(42), 42);
  assert.equal(canonicalize('hi'), 'hi');
  assert.deepEqual(canonicalize([3, 1, 2]), [3, 1, 2]);
  const c = canonicalize({ b: { d: 1, c: 2 }, a: 1 });
  assert.deepEqual(Object.keys(c), ['a', 'b']);
  assert.deepEqual(Object.keys(c.b), ['c', 'd']);
});

// ── mint ──────────────────────────────────────────────────────────────────

test('mint returns token, expires_at, and blast_radius', () => {
  const store = new PreviewTokenStore();
  const minted = store.mint({
    tool: 'meta_launch_test_batch',
    brand: 'acme',
    payload: { ads: [1, 2, 3, 4, 5] },
    blastRadius: { required: true, reason: 'Launching 5 ads', count: 5 },
  });
  assert.ok(minted.confirm_token.startsWith('ct-'));
  assert.ok(minted.expires_at > Date.now());
  assert.equal(minted.blast_radius.count, 5);
});

test('mint requires tool and payload', () => {
  const store = new PreviewTokenStore();
  assert.throws(() => store.mint({}), /tool and payload/);
  assert.throws(() => store.mint({ tool: 'x' }), /tool and payload/);
  assert.throws(() => store.mint({ payload: {} }), /tool and payload/);
});

test('mint produces unique tokens for each call', () => {
  const store = new PreviewTokenStore();
  const a = store.mint({ tool: 't', brand: 'b', payload: { x: 1 } });
  const b = store.mint({ tool: 't', brand: 'b', payload: { x: 1 } });
  assert.notEqual(a.confirm_token, b.confirm_token);
});

// ── consume ───────────────────────────────────────────────────────────────

test('consume returns ok with blastRadius on exact match', () => {
  const store = new PreviewTokenStore();
  const payload = { ads: [1, 2, 3, 4, 5] };
  const { confirm_token } = store.mint({
    tool: 'meta_launch_test_batch',
    brand: 'acme',
    payload,
    blastRadius: { required: true, count: 5 },
  });
  const result = store.consume(confirm_token, {
    tool: 'meta_launch_test_batch',
    brand: 'acme',
    payload,
  });
  assert.equal(result.ok, true);
  assert.equal(result.blastRadius.count, 5);
});

test('consume is single-use: second consume fails', () => {
  const store = new PreviewTokenStore();
  const payload = { x: 1 };
  const { confirm_token } = store.mint({ tool: 't', brand: 'b', payload });
  assert.equal(store.consume(confirm_token, { tool: 't', brand: 'b', payload }).ok, true);
  const second = store.consume(confirm_token, { tool: 't', brand: 'b', payload });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'token_not_found_or_expired');
});

test('consume rejects malformed tokens', () => {
  const store = new PreviewTokenStore();
  assert.equal(store.consume(null, { tool: 't', brand: 'b', payload: {} }).reason, 'malformed_token');
  assert.equal(store.consume('nothex', { tool: 't', brand: 'b', payload: {} }).reason, 'malformed_token');
  assert.equal(store.consume('', { tool: 't', brand: 'b', payload: {} }).reason, 'malformed_token');
});

test('consume rejects unknown tokens', () => {
  const store = new PreviewTokenStore();
  const r = store.consume('ct-0000000000000000000000000000000000000000000000000000000000000000', {
    tool: 't', brand: 'b', payload: {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'token_not_found_or_expired');
});

test('consume rejects cross-tool reuse and deletes the token', () => {
  const store = new PreviewTokenStore();
  const payload = { x: 1 };
  const { confirm_token } = store.mint({ tool: 'tool_a', brand: 'b', payload });
  const r = store.consume(confirm_token, { tool: 'tool_b', brand: 'b', payload });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_tool');
  // Token should be gone after the mismatch attempt
  const retry = store.consume(confirm_token, { tool: 'tool_a', brand: 'b', payload });
  assert.equal(retry.reason, 'token_not_found_or_expired');
});

test('consume rejects wrong brand', () => {
  const store = new PreviewTokenStore();
  const payload = { x: 1 };
  const { confirm_token } = store.mint({ tool: 't', brand: 'brandA', payload });
  const r = store.consume(confirm_token, { tool: 't', brand: 'brandB', payload });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_brand');
});

test('consume rejects payload tampering (payload_mismatch)', () => {
  const store = new PreviewTokenStore();
  const { confirm_token } = store.mint({
    tool: 'meta_adjust_budget',
    brand: 'b',
    payload: { dailyBudget: 10 },
    blastRadius: { required: true },
  });
  // Attacker tries to confirm with a different budget
  const r = store.consume(confirm_token, {
    tool: 'meta_adjust_budget',
    brand: 'b',
    payload: { dailyBudget: 1000 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payload_mismatch');
});

test('consume accepts key-order change in payload (canonical digest)', () => {
  const store = new PreviewTokenStore();
  const { confirm_token } = store.mint({
    tool: 't',
    brand: 'b',
    payload: { alpha: 1, beta: 2 },
  });
  const r = store.consume(confirm_token, {
    tool: 't',
    brand: 'b',
    payload: { beta: 2, alpha: 1 },
  });
  assert.equal(r.ok, true);
});

test('consume accepts payload that carries preview/confirm_token extras', () => {
  // The caller will typically re-send the original payload WITH the confirm_token
  // on it. The digest must ignore these injected fields.
  const store = new PreviewTokenStore();
  const origPayload = { brand: 'b', ads: [{ id: 1 }] };
  const { confirm_token } = store.mint({ tool: 't', brand: 'b', payload: origPayload });
  const r = store.consume(confirm_token, {
    tool: 't',
    brand: 'b',
    payload: Object.assign({}, origPayload, { confirm_token, preview: false }),
  });
  assert.equal(r.ok, true);
});

// ── TTL expiration ────────────────────────────────────────────────────────

test('expired tokens are swept and return token_not_found_or_expired', async () => {
  const store = new PreviewTokenStore({ ttlMs: 30 });
  const { confirm_token } = store.mint({ tool: 't', brand: 'b', payload: { x: 1 } });
  await new Promise((r) => setTimeout(r, 60));
  const r = store.consume(confirm_token, { tool: 't', brand: 'b', payload: { x: 1 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'token_not_found_or_expired');
});

test('ttlMs: 0 falls back to the default', () => {
  const store = new PreviewTokenStore({ ttlMs: 0 });
  const { expires_at } = store.mint({ tool: 't', brand: 'b', payload: {} });
  // If ttl were 0, expires_at would equal Date.now() — the default is 5 min.
  assert.ok(expires_at - Date.now() > 60_000);
});

// ── stats / reset ─────────────────────────────────────────────────────────

test('stats reports live token count (after sweep)', async () => {
  const store = new PreviewTokenStore({ ttlMs: 30 });
  store.mint({ tool: 't', brand: 'b', payload: { x: 1 } });
  store.mint({ tool: 't', brand: 'b', payload: { x: 2 } });
  assert.equal(store.stats().count, 2);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(store.stats().count, 0, 'expired tokens should not be counted');
});

// ── DEFAULT_POLICIES ──────────────────────────────────────────────────────

test('DEFAULT_POLICIES.bulkLaunch requires preview at >= 5 ads', () => {
  assert.equal(DEFAULT_POLICIES.bulkLaunch({ ads: [1, 2, 3, 4] }).required, false);
  const r = DEFAULT_POLICIES.bulkLaunch({ ads: [1, 2, 3, 4, 5] });
  assert.equal(r.required, true);
  assert.equal(r.count, 5);
});

test('DEFAULT_POLICIES.kill requires preview for campaign-level kill', () => {
  assert.equal(DEFAULT_POLICIES.kill({ adId: 'ad_1' }).required, false);
  const r = DEFAULT_POLICIES.kill({ campaignId: 'c_1' });
  assert.equal(r.required, true);
  assert.equal(r.scope, 'campaign');
});

test('DEFAULT_POLICIES.budgetChange requires preview for >=2x or <=0.25x swings', () => {
  assert.equal(DEFAULT_POLICIES.budgetChange({ dailyBudget: 15 }, 10).required, false);
  assert.equal(DEFAULT_POLICIES.budgetChange({ dailyBudget: 20 }, 10).required, true);
  assert.equal(DEFAULT_POLICIES.budgetChange({ dailyBudget: 2 }, 10).required, true);
  // Missing previous budget: non-blocking
  assert.equal(DEFAULT_POLICIES.budgetChange({ dailyBudget: 1000 }, null).required, false);
});

test('DEFAULT_POLICIES.catalogDelete requires preview for any non-empty list', () => {
  assert.equal(DEFAULT_POLICIES.catalogDelete({ productIds: [] }).required, false);
  const r = DEFAULT_POLICIES.catalogDelete({ productIds: ['p1', 'p2', 'p3'] });
  assert.equal(r.required, true);
  assert.equal(r.count, 3);
});

// ── Tamper-resistance integration test ────────────────────────────────────
//
// This is the single most important test in this file. If an attacker (or
// buggy auto-mode loop) tries to preview a small budget change, pocket the
// confirm_token, then swap in a 100x budget and execute — the digest MUST
// refuse it. Every field of the payload is part of the digest.

test('attack scenario: budget swap after preview is refused', () => {
  const store = new PreviewTokenStore();
  const safePayload = { brand: 'acme', adId: 'ad_1', dailyBudget: 10 };
  const minted = store.mint({
    tool: 'meta_adjust_budget',
    brand: 'acme',
    payload: safePayload,
    blastRadius: { required: true, previousBudget: 5, newBudget: 10 },
  });

  // Attacker changes the budget on the re-invoke but passes the same token.
  const malicious = { brand: 'acme', adId: 'ad_1', dailyBudget: 1000, confirm_token: minted.confirm_token };
  const r = store.consume(minted.confirm_token, {
    tool: 'meta_adjust_budget',
    brand: 'acme',
    payload: malicious,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payload_mismatch', 'budget tampering must be refused');
});
