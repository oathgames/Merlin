// Tests for RSI §G7 cleanup tasks (Cluster-L, group 7).
//
// Covers:
//   G7a — .audit-exceptions.json exists at repo root as a valid JSON array
//         so CI's npm-audit gate has a stable file to read (see
//         autocmo-core/.github/workflows/release.yml:340).
//   G7b — before-quit invokes jobStore.shutdown() on the last-known MCP
//         ctx. Necessary because JobStore keeps a setInterval for
//         retention pruning; without shutdown the event loop holds the
//         process open past before-quit.
//
// Source-scan (+ one JSON.parse).
//
// Run with: node --test app/shutdown-hygiene.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const AUDIT_EXCEPTIONS_PATH = path.join(__dirname, '..', '.audit-exceptions.json');

// ─── G7a ─────────────────────────────────────────────────────────────
test('G7a — .audit-exceptions.json exists and is a valid JSON array', () => {
  assert.ok(
    fs.existsSync(AUDIT_EXCEPTIONS_PATH),
    '.audit-exceptions.json exists at repo root',
  );
  const raw = fs.readFileSync(AUDIT_EXCEPTIONS_PATH, 'utf8');
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, 'parses as JSON');
  assert.ok(Array.isArray(parsed), 'file contents are a JSON array');
  // Any entries MUST conform to {cve, reason, expires} — CI enforces
  // this too (release.yml:357) but lint it here so editors catch it
  // before push. A bare empty array is fine.
  for (const exc of parsed) {
    assert.ok(exc && typeof exc === 'object', 'each entry is an object');
    assert.ok(typeof exc.cve === 'string' && exc.cve, 'entry has a cve');
    assert.ok(typeof exc.reason === 'string' && exc.reason, 'entry has a reason');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(exc.expires || ''), 'expires is YYYY-MM-DD');
  }
});

// ─── G7b ─────────────────────────────────────────────────────────────
test('G7b — before-quit calls jobStore.shutdown on _lastMcpCtx', () => {
  const handlerIdx = MAIN_JS.indexOf("app.on('before-quit'");
  assert.ok(handlerIdx > 0, 'before-quit handler registered');
  const end = MAIN_JS.indexOf('\n  });\n', handlerIdx);
  const body = MAIN_JS.slice(handlerIdx, end);
  // Guarded access — _lastMcpCtx may be null (tests, failed MCP init)
  // and jobStore may be absent on the ctx (cold-start before tools
  // populate it).
  assert.ok(
    body.includes('_lastMcpCtx') && body.includes('jobStore'),
    'handler references _lastMcpCtx and jobStore',
  );
  assert.ok(
    /_lastMcpCtx\s*&&\s*_lastMcpCtx\.jobStore/.test(body),
    'guarded access: `_lastMcpCtx && _lastMcpCtx.jobStore`',
  );
  assert.ok(
    /_lastMcpCtx\.jobStore\.shutdown\(\)/.test(body),
    'shutdown() invoked on the JobStore',
  );
  // Clear the ref after shutdown so a subsequent before-quit (rare —
  // macOS "quit all windows then re-open then quit") doesn't try to
  // shut down the same (now frozen) JobStore.
  assert.ok(
    body.includes('_lastMcpCtx = null'),
    'ref cleared after shutdown',
  );
  // Defensive: the whole cleanup is wrapped in try/catch so a JobStore
  // exception can't leak past before-quit and block app.quit().
  assert.ok(
    /try\s*\{[\s\S]*?_lastMcpCtx\.jobStore\.shutdown[\s\S]*?\}\s*catch/.test(body),
    'shutdown wrapped in try/catch',
  );
});

test('G7b — _lastMcpCtx is assigned after createMerlinMcpServer succeeds', () => {
  const idx = MAIN_JS.indexOf('const merlinMcp = await createMerlinMcpServer(');
  assert.ok(idx > 0, 'createMerlinMcpServer call site found');
  // The assignment MUST come after the await — before the await, ctx
  // is not yet populated with jobStore.
  const region = MAIN_JS.slice(idx, idx + 500);
  const assignIdx = region.indexOf('_lastMcpCtx = mcpCtx');
  const awaitIdx = region.indexOf('await createMerlinMcpServer(');
  assert.ok(assignIdx > 0 && assignIdx > awaitIdx, '_lastMcpCtx assigned after createMerlinMcpServer resolves');
  // The ctx passed to createMerlinMcpServer is `mcpCtx` (not an
  // anonymous literal) so that the same reference is held in
  // _lastMcpCtx after the call mutates it to add jobStore.
  const ctorCallIdx = region.indexOf('createMerlinMcpServer(mcpCtx)');
  assert.ok(ctorCallIdx > 0, 'ctx passed by reference (named variable, not inline literal)');
});

test('G7b — _lastMcpCtx is declared at module scope', () => {
  // Declaration MUST be at top-level, not inside a function — otherwise
  // before-quit (which runs much later) can't see it.
  assert.ok(
    /^let\s+_lastMcpCtx\s*=\s*null\s*;/m.test(MAIN_JS),
    '`let _lastMcpCtx = null` at module scope',
  );
});
