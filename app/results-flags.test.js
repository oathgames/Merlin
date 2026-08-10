'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const flagsModule = require('./results-flags');
const { readFlags, setFlag, setFlagsBulk, dropKeys, SIDECAR_NAME, SCHEMA_VERSION, __normalizeKey } = flagsModule;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-flags-'));
}

test('readFlags returns empty state when sidecar missing', async () => {
  const dir = tmpDir();
  const state = await readFlags(dir);
  assert.equal(state.version, SCHEMA_VERSION);
  assert.deepEqual(state.flags, {});
});

test('setFlag persists and round-trips a keep flag', async () => {
  const dir = tmpDir();
  await setFlag(dir, 'img/brightco/run_001', 'keep');
  const state = await readFlags(dir);
  assert.equal(state.flags['img/brightco/run_001'].flag, 'keep');
  assert.ok(Number.isFinite(state.flags['img/brightco/run_001'].ts));
});

test('setFlag with null removes the entry', async () => {
  const dir = tmpDir();
  await setFlag(dir, 'a/b', 'reject');
  await setFlag(dir, 'a/b', null);
  const state = await readFlags(dir);
  assert.equal(state.flags['a/b'], undefined);
});

test('setFlag rejects an unknown flag value', async () => {
  const dir = tmpDir();
  await assert.rejects(() => setFlag(dir, 'x', 'maybe'), /flag must be/);
});

test('setFlag normalizes Windows backslash paths to forward slashes', async () => {
  const dir = tmpDir();
  await setFlag(dir, 'img\\brightco\\run_001', 'keep');
  const state = await readFlags(dir);
  assert.ok(state.flags['img/brightco/run_001']);
  assert.equal(state.flags['img\\brightco\\run_001'], undefined);
});

test('setFlagsBulk applies many updates atomically', async () => {
  const dir = tmpDir();
  const result = await setFlagsBulk(dir, [
    { key: 'a', flag: 'keep' },
    { key: 'b', flag: 'reject' },
    { key: 'c', flag: 'keep' },
  ]);
  assert.equal(result.applied, 3);
  const state = await readFlags(dir);
  assert.equal(state.flags['a'].flag, 'keep');
  assert.equal(state.flags['b'].flag, 'reject');
  assert.equal(state.flags['c'].flag, 'keep');
});

test('setFlagsBulk skips invalid entries without failing the batch', async () => {
  const dir = tmpDir();
  const result = await setFlagsBulk(dir, [
    { key: 'a', flag: 'keep' },
    { key: '', flag: 'keep' },
    null,
    { key: 'b', flag: 'rubbish' },
    { key: 'c', flag: 'reject' },
  ]);
  assert.equal(result.applied, 2);
  const state = await readFlags(dir);
  assert.equal(state.flags['a'].flag, 'keep');
  assert.equal(state.flags['c'].flag, 'reject');
  assert.equal(state.flags['b'], undefined);
});

test('setFlagsBulk with flag=null removes existing entries', async () => {
  const dir = tmpDir();
  await setFlag(dir, 'a', 'keep');
  await setFlag(dir, 'b', 'reject');
  await setFlagsBulk(dir, [
    { key: 'a', flag: null },
    { key: 'b', flag: null },
  ]);
  const state = await readFlags(dir);
  assert.deepEqual(state.flags, {});
});

test('dropKeys removes specified entries only', async () => {
  const dir = tmpDir();
  await setFlagsBulk(dir, [
    { key: 'a', flag: 'keep' },
    { key: 'b', flag: 'reject' },
    { key: 'c', flag: 'keep' },
  ]);
  const result = await dropKeys(dir, ['a', 'b', 'nonexistent']);
  assert.equal(result.dropped, 2);
  const state = await readFlags(dir);
  assert.equal(state.flags['a'], undefined);
  assert.equal(state.flags['b'], undefined);
  assert.equal(state.flags['c'].flag, 'keep');
});

test('readFlags recovers from a corrupted sidecar', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, SIDECAR_NAME), '{ this is not json');
  const state = await readFlags(dir);
  assert.deepEqual(state.flags, {});
});

test('readFlags drops entries with unknown flag values', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, SIDECAR_NAME), JSON.stringify({
    version: SCHEMA_VERSION,
    flags: {
      good: { flag: 'keep', ts: 123 },
      bad: { flag: 'pinned', ts: 456 },
      malformed: 'not-an-object',
    },
  }));
  const state = await readFlags(dir);
  assert.equal(state.flags['good'].flag, 'keep');
  assert.equal(state.flags['bad'], undefined);
  assert.equal(state.flags['malformed'], undefined);
});

test('concurrent setFlag calls do not lose updates', async () => {
  const dir = tmpDir();
  const ops = [];
  for (let i = 0; i < 25; i++) {
    ops.push(setFlag(dir, `item_${i}`, i % 2 === 0 ? 'keep' : 'reject'));
  }
  await Promise.all(ops);
  const state = await readFlags(dir);
  for (let i = 0; i < 25; i++) {
    assert.equal(state.flags[`item_${i}`].flag, i % 2 === 0 ? 'keep' : 'reject', `lost ${i}`);
  }
});

test('write uses atomic .tmp + rename (no partial reads)', async () => {
  const dir = tmpDir();
  await setFlag(dir, 'a', 'keep');
  // After completion, no .tmp leftovers should remain. The write queue may
  // briefly create a .tmp.<pid>.<ts> file; once the chain drains it must be
  // gone (renamed atomically).
  const leftovers = fs.readdirSync(dir).filter(f => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('normalizeKey strips leading and trailing slashes', () => {
  assert.equal(__normalizeKey('/a/b/'), 'a/b');
  assert.equal(__normalizeKey('a/b'), 'a/b');
  assert.equal(__normalizeKey('\\a\\b\\'), 'a/b');
});

test('readFlags missing flag key returns undefined for that key', async () => {
  const dir = tmpDir();
  await setFlag(dir, 'present', 'keep');
  const state = await readFlags(dir);
  assert.equal(state.flags['absent'], undefined);
  assert.equal(state.flags['present'].flag, 'keep');
});
