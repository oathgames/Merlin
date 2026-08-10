// Tests for threads.js: in-memory store + debounced atomic flush
// (2026-07-11 audit fix).
//
// The old model re-did readFileSync + parse + pretty stringify + write +
// rename of the whole multi-brand .merlin-threads.json on EVERY appendBubble
// inside the send-message IPC path. Now the parsed object lives in memory
// (main process is the only writer), mutations schedule one debounced async
// atomic write, and main.js's before-quit flushes synchronously.
//
// Durability tradeoff pinned here on purpose: a hard crash between debounced
// flushes loses at most the last FLUSH_DELAY_MS of bubbles. That is
// acceptable: bubbles are a UI rehydration cache, the SDK transcript is the
// real record.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const threads = require('./threads');
const { _testHooks } = threads;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'threads-test-'));
}

function readDisk(appRoot) {
  return JSON.parse(fs.readFileSync(threads.filePath(appRoot), 'utf8'));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('rapid appends coalesce into a single debounced write', async () => {
  _testHooks.resetForTests();
  _testHooks.setFlushDelayForTest(30);
  const root = tmpRoot();
  try {
    for (let i = 0; i < 10; i++) {
      assert.equal(threads.appendBubble(root, 'brightco', 'user', `msg ${i}`), true);
    }
    assert.equal(_testHooks.getWriteCount(root), 0, 'no write inside the debounce window');
    await sleep(120);
    assert.equal(_testHooks.getWriteCount(root), 1, '10 appends must produce exactly 1 write');
    const disk = readDisk(root);
    assert.equal(disk.brands.brightco.bubbles.length, 10, 'the single write carries every append');
  } finally {
    _testHooks.resetForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('flush payload is compact JSON, not pretty-printed', async () => {
  _testHooks.resetForTests();
  _testHooks.setFlushDelayForTest(10);
  const root = tmpRoot();
  try {
    threads.appendBubble(root, 'b', 'claude', 'hello');
    await sleep(60);
    const raw = fs.readFileSync(threads.filePath(root), 'utf8');
    assert.ok(!raw.includes('\n  '), 'no indentation: the file is machine-read only');
  } finally {
    _testHooks.resetForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('quit flush (flushSync) persists the pending window immediately', () => {
  _testHooks.resetForTests();
  // Long delay: the debounce timer will NOT fire during this test, so the
  // only way the data lands on disk is the explicit quit-path flush.
  _testHooks.setFlushDelayForTest(60_000);
  const root = tmpRoot();
  try {
    threads.appendBubble(root, 'brightco', 'user', 'about to quit');
    threads.setSessionId(root, 'brightco', 'sess-123');
    assert.equal(_testHooks.isDirty(root), true, 'mutations are pending');
    assert.equal(threads.flushSync(root), true);
    assert.equal(_testHooks.isDirty(root), false, 'flushSync drained the pending state');
    const disk = readDisk(root);
    assert.equal(disk.brands.brightco.bubbles[0].text, 'about to quit');
    assert.equal(disk.brands.brightco.sessionId, 'sess-123');
    // Idempotent when clean.
    assert.equal(threads.flushSync(root), true);
    assert.equal(_testHooks.getWriteCount(root), 1, 'a clean flushSync is a no-op');
  } finally {
    _testHooks.resetForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a crash between debounces loses at most the debounce window (documented tradeoff)', async () => {
  _testHooks.resetForTests();
  _testHooks.setFlushDelayForTest(10);
  const root = tmpRoot();
  try {
    threads.appendBubble(root, 'b', 'user', 'flushed message');
    await sleep(60); // first window flushes
    assert.equal(_testHooks.getWriteCount(root), 1);
    _testHooks.setFlushDelayForTest(60_000);
    threads.appendBubble(root, 'b', 'user', 'lost in the crash window');
    // Simulate the hard crash: drop the in-memory state without flushing.
    _testHooks.resetForTests();
    const disk = readDisk(root);
    const texts = disk.brands.b.bubbles.map((x) => x.text);
    assert.deepStrictEqual(texts, ['flushed message'],
      'only the un-flushed debounce window is lost; everything before it survives');
  } finally {
    _testHooks.resetForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reads are served from memory before any flush lands (no stale disk reads)', () => {
  _testHooks.resetForTests();
  _testHooks.setFlushDelayForTest(60_000);
  const root = tmpRoot();
  try {
    threads.appendBubble(root, 'b', 'user', 'in memory only');
    threads.setSessionId(root, 'b', 'sess-9');
    assert.equal(fs.existsSync(threads.filePath(root)), false, 'nothing on disk yet');
    const t = threads.getThread(root, 'b');
    assert.equal(t.bubbles.length, 1);
    assert.equal(t.bubbles[0].text, 'in memory only');
    assert.equal(threads.getSessionId(root, 'b'), 'sess-9');
    assert.deepStrictEqual(threads.listBrands(root), ['b']);
  } finally {
    _testHooks.resetForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getThread returns a copy: caller mutations cannot corrupt the store', () => {
  _testHooks.resetForTests();
  const root = tmpRoot();
  try {
    threads.appendBubble(root, 'b', 'user', 'original');
    const t = threads.getThread(root, 'b');
    t.bubbles.push({ role: 'user', text: 'injected', ts: 0 });
    t.sessionId = 'hijacked';
    const fresh = threads.getThread(root, 'b');
    assert.equal(fresh.bubbles.length, 1);
    assert.equal(fresh.sessionId, null);
  } finally {
    _testHooks.resetForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy write() persists immediately and read() reflects the cache', () => {
  _testHooks.resetForTests();
  const root = tmpRoot();
  try {
    const seeded = { brands: { x: { sessionId: 's', lastActiveAt: null, bubbles: [] } } };
    assert.equal(threads.write(root, seeded), true);
    assert.equal(readDisk(root).brands.x.sessionId, 's', 'write() stays synchronous (old contract)');
    assert.equal(threads.read(root).brands.x.sessionId, 's');
    // Malformed input normalizes instead of corrupting the store.
    threads.write(root, 'garbage');
    assert.deepStrictEqual(threads.read(root), { brands: {} });
  } finally {
    _testHooks.resetForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('existing file on disk hydrates the cache on first touch', () => {
  _testHooks.resetForTests();
  const root = tmpRoot();
  try {
    fs.writeFileSync(threads.filePath(root),
      JSON.stringify({ brands: { old: { sessionId: 'prev', lastActiveAt: null, bubbles: [{ role: 'user', text: 'hi', ts: 1 }] } } }));
    assert.equal(threads.getSessionId(root, 'old'), 'prev');
    assert.equal(threads.getThread(root, 'old').bubbles.length, 1);
  } finally {
    _testHooks.resetForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MAX_BUBBLES cap prunes oldest, clearThread resets, invalid inputs refused', async () => {
  _testHooks.resetForTests();
  _testHooks.setFlushDelayForTest(10);
  const root = tmpRoot();
  try {
    for (let i = 0; i < threads.MAX_BUBBLES + 25; i++) {
      threads.appendBubble(root, 'b', 'user', `m${i}`);
    }
    const t = threads.getThread(root, 'b');
    assert.equal(t.bubbles.length, threads.MAX_BUBBLES);
    assert.equal(t.bubbles[0].text, 'm25', 'oldest pruned first');
    assert.equal(threads.appendBubble(root, '', 'user', 'x'), false);
    assert.equal(threads.appendBubble(root, 'b', 'system', 'x'), false);
    assert.equal(threads.appendBubble(root, 'b', 'user', ''), false);
    assert.equal(threads.clearThread(root, 'b'), true);
    assert.equal(threads.getThread(root, 'b').bubbles.length, 0);
    await sleep(60); // let pending flushes settle before rmSync
  } finally {
    _testHooks.resetForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('main.js before-quit flushes threads synchronously (source scan)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const idx = src.indexOf("app.on('before-quit'");
  assert.ok(idx >= 0, 'before-quit handler not found in main.js');
  const body = src.slice(idx, idx + 4000);
  assert.match(body, /threads\.flushSync\(appRoot\)/,
    'before-quit must flush the debounced thread cache or the last window of bubbles is lost on quit');
});
