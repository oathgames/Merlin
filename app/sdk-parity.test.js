// Tests for app/sdk-parity.js — pure helpers powering the v1.19.5 SDK
// parity work. Run: `node app/sdk-parity.test.js`. Uses Node's built-in
// test runner.
//
// Coverage:
//   - queueBadgeReducer initial state + queued/drained transitions
//   - queueBadgeReducer reset on session boundary
//   - queueBadgeReducer clamps depth at 50, ignores malformed events
//   - queueBadgeReducer hides badge at depth 0
//   - formatPreToolStatus rejects missing required fields
//   - formatPreToolStatus formats singular vs plural
//   - formatPreToolStatus accepts cost-only (no ETA)
//   - isRawErrorVerbatim accepts exact match, accepts ≥24-char substring,
//     rejects paraphrased fabrications
//   - renderQueuedBadgeMessage singular/plural copy
//   - pluralize handles common ad nouns

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  queueBadgeReducer,
  formatPreToolStatus,
  isRawErrorVerbatim,
  renderQueuedBadgeMessage,
  pluralize,
} = require('./sdk-parity');

// ── queueBadgeReducer ───────────────────────────────────────────

test('queueBadgeReducer: initial state hides the badge', () => {
  const r = queueBadgeReducer(undefined, { type: 'reset' });
  assert.deepEqual(r.state, { depth: 0, lastChange: null });
  assert.equal(r.badge, null);
});

test('queueBadgeReducer: depth=1 renders "queued (1)"', () => {
  const r = queueBadgeReducer({ depth: 0, lastChange: null }, { type: 'queued', depth: 1 });
  assert.equal(r.state.depth, 1);
  assert.equal(r.state.lastChange, 'queued');
  assert.equal(r.badge, 'queued (1)');
});

test('queueBadgeReducer: depth grows on successive queued events', () => {
  let s = { depth: 0, lastChange: null };
  ({ state: s } = queueBadgeReducer(s, { type: 'queued', depth: 1 }));
  ({ state: s } = queueBadgeReducer(s, { type: 'queued', depth: 2 }));
  const r = queueBadgeReducer(s, { type: 'queued', depth: 3 });
  assert.equal(r.state.depth, 3);
  assert.equal(r.badge, 'queued (3)');
});

test('queueBadgeReducer: drained events shrink the badge until empty', () => {
  let { state, badge } = queueBadgeReducer(undefined, { type: 'queued', depth: 3 });
  assert.equal(badge, 'queued (3)');
  ({ state, badge } = queueBadgeReducer(state, { type: 'drained', depth: 2 }));
  assert.equal(badge, 'queued (2)');
  ({ state, badge } = queueBadgeReducer(state, { type: 'drained', depth: 1 }));
  assert.equal(badge, 'queued (1)');
  ({ state, badge } = queueBadgeReducer(state, { type: 'drained', depth: 0 }));
  assert.equal(badge, null);
  assert.equal(state.depth, 0);
});

test('queueBadgeReducer: reset clears state regardless of prior depth', () => {
  const start = { depth: 7, lastChange: 'queued' };
  const r = queueBadgeReducer(start, { type: 'reset' });
  assert.deepEqual(r.state, { depth: 0, lastChange: null });
  assert.equal(r.badge, null);
});

test('queueBadgeReducer: clamps depth above 50 (matches main.js cap)', () => {
  const r = queueBadgeReducer({ depth: 0, lastChange: null }, { type: 'queued', depth: 999 });
  assert.equal(r.state.depth, 50);
  assert.equal(r.badge, 'queued (50)');
});

test('queueBadgeReducer: malformed event preserves prior state', () => {
  const start = { depth: 2, lastChange: 'queued' };
  // Missing type
  let r = queueBadgeReducer(start, {});
  assert.equal(r.state.depth, 2);
  assert.equal(r.badge, 'queued (2)');
  // Wrong type
  r = queueBadgeReducer(start, { type: 'unknown' });
  assert.equal(r.state.depth, 2);
  assert.equal(r.badge, 'queued (2)');
  // Null event
  r = queueBadgeReducer(start, null);
  assert.equal(r.state.depth, 2);
});

test('queueBadgeReducer: negative or non-finite depth is ignored', () => {
  const start = { depth: 5, lastChange: 'queued' };
  let r = queueBadgeReducer(start, { type: 'queued', depth: -1 });
  assert.equal(r.state.depth, 5);
  r = queueBadgeReducer(start, { type: 'queued', depth: NaN });
  assert.equal(r.state.depth, 5);
  r = queueBadgeReducer(start, { type: 'queued', depth: Infinity });
  assert.equal(r.state.depth, 5);
});

test('queueBadgeReducer: depth floor (e.g. 1.7) rounds down to integer', () => {
  const r = queueBadgeReducer({ depth: 0, lastChange: null }, { type: 'queued', depth: 3.9 });
  assert.equal(r.state.depth, 3);
  assert.equal(r.badge, 'queued (3)');
});

// ── formatPreToolStatus ─────────────────────────────────────────

test('formatPreToolStatus: rejects missing action', () => {
  assert.equal(
    formatPreToolStatus({ count: 12, context: 'VELA cherry refs', eta: '36min' }),
    null
  );
});

test('formatPreToolStatus: rejects missing count (or zero)', () => {
  assert.equal(
    formatPreToolStatus({ action: 'image', count: 0, context: 'VELA cherry refs', eta: '36min' }),
    null
  );
});

test('formatPreToolStatus: rejects missing context', () => {
  assert.equal(
    formatPreToolStatus({ action: 'image', count: 12, eta: '36min' }),
    null
  );
});

test('formatPreToolStatus: requires at least ETA or cost (rule: stop and ask if neither known)', () => {
  assert.equal(
    formatPreToolStatus({ action: 'image', count: 12, context: 'VELA cherry refs' }),
    null
  );
});

test('formatPreToolStatus: emits canonical sentence with all fields', () => {
  const s = formatPreToolStatus({
    action: 'image',
    count: 12,
    context: 'VELA cherry refs',
    eta: '36min',
    cost: '$1.20 fal',
  });
  assert.equal(s, 'Generating 12 images using VELA cherry refs — ~36min, ~$1.20 fal.');
});

test('formatPreToolStatus: singular for count=1', () => {
  const s = formatPreToolStatus({
    action: 'video',
    count: 1,
    context: 'vela-cherry references',
    eta: '90s',
  });
  assert.equal(s, 'Generating 1 video using vela-cherry references — ~90s.');
});

test('formatPreToolStatus: cost-only is acceptable (real-money tools without ETA)', () => {
  const s = formatPreToolStatus({
    action: 'voiceover',
    count: 3,
    context: 'cloned voice "Ryan"',
    cost: '$0.30 elevenlabs',
  });
  assert.equal(s, 'Generating 3 voiceovers using cloned voice "Ryan" — ~$0.30 elevenlabs.');
});

test('formatPreToolStatus: trims whitespace', () => {
  const s = formatPreToolStatus({
    action: '  image  ',
    count: 4,
    context: '  VELA references  ',
    eta: '  12min  ',
  });
  assert.equal(s, 'Generating 4 images using VELA references — ~12min.');
});

// ── isRawErrorVerbatim ──────────────────────────────────────────

test('isRawErrorVerbatim: exact substring match returns true', () => {
  const raw = 'fal.ai 404: model openai/gpt-image-2/edit not found';
  const surface = `Got an error: ${raw}. What would you like me to try?`;
  assert.equal(isRawErrorVerbatim(raw, surface), true);
});

test('isRawErrorVerbatim: paraphrased diagnosis returns false (the confabulation case)', () => {
  const raw = 'fal.ai 404: model openai/gpt-image-2/edit not found';
  // The exact incident-pattern from the 2026-04-29 RSI brief — the agent
  // confabulated "the binary's slug registry doesn't recognize this model"
  // when the tool actually returned a plain 404.
  const surface = "The binary's slug registry doesn't recognize this model.";
  assert.equal(isRawErrorVerbatim(raw, surface), false);
});

test('isRawErrorVerbatim: short raw error (< 24 chars) requires exact substring', () => {
  assert.equal(isRawErrorVerbatim('404 Not Found', 'Got 404 Not Found.'), true);
  assert.equal(isRawErrorVerbatim('404 Not Found', 'The page was missing.'), false);
});

test('isRawErrorVerbatim: long raw error matches via 24-char window', () => {
  const raw = 'rate limit exceeded — try again in 60 seconds (Meta Marketing API)';
  // Surface only contains a chunk of the raw error, but enough for the helper
  // to confirm "this is the error verbatim, the agent didn't paraphrase."
  const surface = "I hit 'rate limit exceeded — try again in 60 seconds' from Meta. Want me to wait and retry?";
  assert.equal(isRawErrorVerbatim(raw, surface), true);
});

test('isRawErrorVerbatim: empty / non-string inputs return false', () => {
  assert.equal(isRawErrorVerbatim('', 'something'), false);
  assert.equal(isRawErrorVerbatim('something', ''), false);
  assert.equal(isRawErrorVerbatim(null, 'something'), false);
  assert.equal(isRawErrorVerbatim('something', null), false);
  assert.equal(isRawErrorVerbatim(undefined, undefined), false);
});

// ── renderQueuedBadgeMessage ────────────────────────────────────

test('renderQueuedBadgeMessage: depth=0 returns null', () => {
  assert.equal(renderQueuedBadgeMessage(0), null);
  assert.equal(renderQueuedBadgeMessage(-1), null);
  assert.equal(renderQueuedBadgeMessage(NaN), null);
});

test('renderQueuedBadgeMessage: depth=1 uses singular phrasing', () => {
  const m = renderQueuedBadgeMessage(1);
  assert.match(m, /finishing the current step first/);
  assert.match(m, /Got your message/);
});

test('renderQueuedBadgeMessage: depth>=2 includes the count', () => {
  const m = renderQueuedBadgeMessage(3);
  assert.match(m, /Got your 3 messages/);
  assert.match(m, /work through them in order/);
});

// ── pluralize ───────────────────────────────────────────────────

test('pluralize handles ad-domain nouns', () => {
  assert.equal(pluralize('image'), 'images');
  assert.equal(pluralize('video'), 'videos');
  assert.equal(pluralize('ad'), 'ads');
  assert.equal(pluralize('blog'), 'blogs');
  assert.equal(pluralize('post'), 'posts');
  assert.equal(pluralize('email'), 'emails');
  assert.equal(pluralize('voiceover'), 'voiceovers');
  assert.equal(pluralize('headline'), 'headlines');
});
