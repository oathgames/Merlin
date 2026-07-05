'use strict';
// REGRESSION GUARD (2026-07-03, mac-compat): the x64 mac DMG shipped an arm64
// bundled Node, which passed fs.accessSync(X_OK) and was trusted, so the Agent
// SDK died with "Bad CPU type" on Intel and the app was permanently mute.
// getBundledNodePath now rejects a wrong-arch Mach-O via bundledNodeArchOK.
// These tests exercise the header parser with synthetic Mach-O buffers.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// Extract bundledNodeArchOK and run it with injected fs + process so we can
// feed synthetic Mach-O headers without a real binary on disk.
function loadArchChecker(procArch, headerBytes) {
  const fnStart = MAIN_JS.indexOf('function bundledNodeArchOK');
  const fnEnd = MAIN_JS.indexOf('\n// Check if a real standalone Node', fnStart);
  assert.ok(fnStart > 0 && fnEnd > fnStart, 'bundledNodeArchOK found in main.js');
  const block = MAIN_JS.slice(fnStart, fnEnd);

  const mockFs = {
    openSync: () => 7,
    closeSync: () => {},
    readSync: (fd, buf) => {
      if (headerBytes == null) throw new Error('unreadable');
      headerBytes.copy(buf, 0, 0, Math.min(headerBytes.length, buf.length));
      return Math.min(headerBytes.length, buf.length);
    },
  };
  const proc = { platform: 'darwin', arch: procArch };
  // eslint-disable-next-line no-new-func
  const factory = new Function('fs', 'process', 'Buffer', `${block}\nreturn bundledNodeArchOK;`);
  return factory(mockFs, proc, Buffer);
}

// Thin 64-bit Mach-O: magic 0xFEEDFACF (LE), cputype at offset 4 (LE).
function thinMacho(cputype) {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cputype, 4);
  return b;
}
const CPU_X86_64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;

test('bundledNodeArchOK: x64 header on x64 host → accepted', () => {
  const ok = loadArchChecker('x64', thinMacho(CPU_X86_64));
  assert.equal(ok('/fake/node'), true);
});

test('bundledNodeArchOK: arm64 header on x64 host → REJECTED (the shipped bug)', () => {
  const ok = loadArchChecker('x64', thinMacho(CPU_ARM64));
  assert.equal(ok('/fake/node'), false, 'an arm64 node on an Intel Mac must be rejected');
});

test('bundledNodeArchOK: arm64 header on arm64 host → accepted', () => {
  const ok = loadArchChecker('arm64', thinMacho(CPU_ARM64));
  assert.equal(ok('/fake/node'), true);
});

test('bundledNodeArchOK: x64 header on arm64 host → REJECTED', () => {
  const ok = loadArchChecker('arm64', thinMacho(CPU_X86_64));
  assert.equal(ok('/fake/node'), false);
});

test('bundledNodeArchOK: universal (fat) binary → accepted on any arch', () => {
  const fat = Buffer.alloc(12);
  fat.writeUInt32BE(0xcafebabe, 0); // fat headers are big-endian
  assert.equal(loadArchChecker('x64', fat)('/fake/node'), true);
  assert.equal(loadArchChecker('arm64', fat)('/fake/node'), true);
});

test('bundledNodeArchOK: fail-open on unreadable header', () => {
  const ok = loadArchChecker('x64', null); // readSync throws
  assert.equal(ok('/fake/node'), true, 'unreadable header must not reject a possibly-fine binary');
});

test('bundledNodeArchOK: fail-open on unknown magic', () => {
  const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
  assert.equal(loadArchChecker('x64', junk)('/fake/node'), true);
});

test('getBundledNodePath calls bundledNodeArchOK before trusting the binary', () => {
  const gp = MAIN_JS.slice(MAIN_JS.indexOf('function getBundledNodePath'));
  const body = gp.slice(0, gp.indexOf('\n}'));
  assert.ok(body.includes('bundledNodeArchOK('), 'getBundledNodePath must gate on the arch check');
});

test('fact-binding prelude resolves the engine via getBinaryPath, not a hardcoded path', () => {
  // The old code hardcoded <appRoot>/.claude/tools/Merlin, which never exists
  // on a mac install. Assert the session-prelude spawn uses getBinaryPath().
  const anchor = MAIN_JS.indexOf("action: 'session-prelude'");
  assert.ok(anchor > 0, 'session-prelude spawn present');
  const region = MAIN_JS.slice(anchor - 800, anchor);
  assert.ok(region.includes('getBinaryPath()'), 'fact-binding must resolve engine via getBinaryPath()');
});

test('MERLIN_TOOLS_DIR is exported to the engine so bundled ffmpeg/ffprobe resolve on mac', () => {
  assert.ok(
    MAIN_JS.includes("process.env.MERLIN_TOOLS_DIR = path.join(appInstall, '.claude', 'tools')"),
    'main.js must point the engine at the bundled tools dir via MERLIN_TOOLS_DIR',
  );
});
