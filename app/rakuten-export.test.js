'use strict';

// Rakuten Advertising export wiring (2026-10-07). The Reporting API allows ONE
// report request in flight per account, and rakuten-export can span years of
// 28-day chunks, so: the app-side slot is 1, export runs as a background job
// (it cannot fit the MCP call boundary), and the job is restart-resumable
// because the engine checkpoints every chunk in its manifest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { DEFAULT_CAPS } = require('./mcp-concurrency');
const { RESTART_RESUMABLE_EXPORT_ACTIONS, parseExportProgressLine } = require('./mcp-tools');

const toolsSrc = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');

function rakutenToolBlock() {
  const start = toolsSrc.indexOf("name: 'rakuten',");
  assert.ok(start > 0, 'rakuten tool missing');
  const end = toolsSrc.indexOf('}, tool, z, ctx));', start);
  return toolsSrc.slice(start, end);
}

test('rakuten holds one concurrent slot, matching the one-in-flight API limit', () => {
  assert.equal(DEFAULT_CAPS.rakuten, 1);
});

test('rakuten export is in the action enum and maps to the rakuten-export engine action', () => {
  const block = rakutenToolBlock();
  assert.match(block, /z\.enum\(\[[^\]]*'export'[^\]]*\]\)/);
  assert.match(block, /export:\s*'rakuten-export'/);
});

test('rakuten export runs as a background job, never inline in the MCP call', () => {
  const block = rakutenToolBlock();
  assert.match(block, /args\.action === 'export' && ctx\.jobStore/);
  assert.match(block, /startExportJob\(ctx, 'rakuten', 'rakuten-export', args\)/);
});

test('rakuten-export is restart-resumable (read-only, approval-free, checkpointed)', () => {
  assert.ok(RESTART_RESUMABLE_EXPORT_ACTIONS.has('rakuten-export'));
});

test('the engine heartbeat line format parses for the stall watchdog', () => {
  const p = parseExportProgressLine('MERLIN_PROGRESS stage=rakuten_export chunks_done=3 chunks_total=14 rows=120');
  assert.deepEqual(p, { stage: 'rakuten_export', counts: { chunks_done: 3, chunks_total: 14, rows: 120 } });
});
