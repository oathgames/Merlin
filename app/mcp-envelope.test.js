'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const envelope = require('./mcp-envelope');

test('envelope.ok produces a success envelope with null error', () => {
  const env = envelope.ok({ data: { summary: 'ran', n: 1 } });
  assert.equal(env.ok, true);
  assert.equal(env.error, null);
  assert.deepEqual(env.data, { summary: 'ran', n: 1 });
});

test('envelope.fail requires a code', () => {
  assert.throws(() => envelope.fail({ message: 'no code' }), /code/);
  assert.throws(() => envelope.fail(null), /code/);
});

test('envelope.fail sets ok=false and preserves error fields', () => {
  const env = envelope.fail({
    code: 'RATE_LIMITED',
    message: 'Slow down',
    next_action: 'wait_and_retry',
    retry_after_sec: 30,
  });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'RATE_LIMITED');
  assert.equal(env.error.retry_after_sec, 30);
  assert.equal(env.error.next_action, 'wait_and_retry');
});

test('envelope.render embeds summary + JSON in a single text field', () => {
  const env = envelope.ok({ data: { summary: 'done' } });
  const rendered = envelope.render(env);
  assert.equal(rendered.isError, false);
  assert.equal(rendered.content.length, 1);
  assert.equal(rendered.content[0].type, 'text');
  const text = rendered.content[0].text;
  assert.ok(text.startsWith('done\n\n{'));
  assert.ok(text.includes('"ok": true'));
});

test('envelope.render marks isError on failed envelopes', () => {
  const env = envelope.fail({ code: 'TIMEOUT', message: 'Timed out' });
  const rendered = envelope.render(env);
  assert.equal(rendered.isError, true);
  assert.ok(rendered.content[0].text.startsWith('Timed out\n\n'));
});

test('envelope.parse round-trips an envelope', () => {
  const original = envelope.ok({
    data: { x: 1 },
    cost: { usd_estimated: 0.5, api_calls: 2 },
  });
  const rendered = envelope.render(original);
  const parsed = envelope.parse(rendered);
  assert.deepEqual(parsed.data, { x: 1 });
  assert.equal(parsed.cost.usd_estimated, 0.5);
  assert.equal(parsed.ok, true);
});

test('envelope.summarize prefers data.summary, then data.message, then fallback', () => {
  assert.equal(envelope.summarize(envelope.ok({ data: { summary: 'A' } })), 'A');
  assert.equal(envelope.summarize(envelope.ok({ data: { message: 'B' } })), 'B');
  assert.equal(envelope.summarize(envelope.ok({ data: { other: 1 } })), 'Done.');
});

test('envelope.summarize surfaces error message on failure envelopes', () => {
  const env = envelope.fail({ code: 'NOT_FOUND', message: 'Missing ad 123' });
  assert.equal(envelope.summarize(env), 'Missing ad 123');
});

test('envelope.summarize shows job progress when a jobId is present', () => {
  const env = envelope.ok({
    data: { summary: 'queued' },
    progress: { jobId: 'job-abc', stage: 'uploading', pct: 0.42 },
  });
  const s = envelope.summarize(env);
  assert.ok(s.includes('job-abc'));
  assert.ok(s.includes('uploading'));
  assert.ok(s.includes('42'));
});

test('envelope.render throws on non-objects', () => {
  assert.throws(() => envelope.render(null), /envelope/);
  assert.throws(() => envelope.render('string'), /envelope/);
});

test('envelope.parse returns null on malformed rendered values', () => {
  assert.equal(envelope.parse(null), null);
  assert.equal(envelope.parse({}), null);
  assert.equal(envelope.parse({ content: [] }), null);
  assert.equal(envelope.parse({ content: [{ type: 'text', text: 'no json here' }] }), null);
  assert.equal(envelope.parse({ content: [{ type: 'text', text: 'prefix\n{ malformed' }] }), null);
});
