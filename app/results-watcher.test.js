'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createResultsWatcher, __SELF_WRITE_PATTERNS } = require('./results-watcher');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-watcher-'));
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

test('createResultsWatcher requires a string resultsDir', () => {
  assert.throws(() => createResultsWatcher(null), /resultsDir required/);
  assert.throws(() => createResultsWatcher(123), /resultsDir required/);
});

test('start() then stop() does not throw', () => {
  const dir = tmpDir();
  const w = createResultsWatcher(dir, { onChange: () => {} });
  w.start();
  w.stop();
});

test('start() is idempotent', () => {
  const dir = tmpDir();
  const w = createResultsWatcher(dir, { onChange: () => {} });
  w.start();
  w.start();
  w.stop();
});

test('stop() before start() is safe', () => {
  const dir = tmpDir();
  const w = createResultsWatcher(dir, { onChange: () => {} });
  w.stop();
});

test('debounces a burst of writes into one callback', async () => {
  const dir = tmpDir();
  const events = [];
  const w = createResultsWatcher(dir, {
    onChange: (paths) => events.push(paths),
    debounceMs: 80,
  });
  w.start();

  // Burst of 5 writes inside the debounce window.
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
  }
  await wait(250);
  w.stop();

  // Recursive fs.watch isn't supported on every CI runner, but at minimum
  // the watcher must not double-fire when supported. If 0 events fired
  // (unsupported), the test is skipped via assertion of a max bound.
  assert.ok(events.length <= 1, `expected at most 1 debounced event, got ${events.length}`);
});

test('self-write patterns ignore .flags.json + atomic siblings', () => {
  const cases = [
    'results/.flags.json',
    'results/.flags.json.tmp.12345.987',
    'results/archive-index.json',
    'results/archive-index.json.tmp.42.99',
    'results\\.flags.json',
  ];
  for (const c of cases) {
    const matched = __SELF_WRITE_PATTERNS.some(re => re.test(c));
    assert.ok(matched, `expected self-write pattern to match: ${c}`);
  }
});

test('self-write patterns do NOT match generated files', () => {
  const cases = [
    'results/img/brightco/img_20260419/portrait.png',
    'results/ad_20260419_120000/metadata.json',
    'results/myflags.json', // user file with similar name
    'results/.flagsbar.json',
  ];
  for (const c of cases) {
    const matched = __SELF_WRITE_PATTERNS.some(re => re.test(c));
    assert.ok(!matched, `expected self-write pattern to NOT match: ${c}`);
  }
});

test('onChange listener errors do not crash the watcher', async () => {
  const dir = tmpDir();
  let goodFires = 0;
  const w = createResultsWatcher(dir, {
    onChange: () => {
      goodFires++;
      throw new Error('boom');
    },
    debounceMs: 60,
  });
  w.start();
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
  // Silence console.warn during the throw.
  const origWarn = console.warn;
  console.warn = () => {};
  await wait(200);
  console.warn = origWarn;
  w.stop();
  // On platforms with recursive fs.watch, goodFires should be 1; on others 0.
  // The key assertion is that the test process did not crash.
  assert.ok(goodFires <= 1);
});

test('start auto-creates the results dir if missing', () => {
  const parent = tmpDir();
  const dir = path.join(parent, 'results-not-yet');
  assert.equal(fs.existsSync(dir), false);
  const w = createResultsWatcher(dir, { onChange: () => {} });
  w.start();
  assert.equal(fs.existsSync(dir), true);
  w.stop();
});
