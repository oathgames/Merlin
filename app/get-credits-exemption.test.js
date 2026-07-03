// get-credits-exemption.test.js — REGRESSION GUARD (2026-07-03, rate-limit
// enforcement audit). get-credits is the ONE main-process path allowed to call
// metered third-party APIs (HeyGen, ElevenLabs) directly, and only because it
// is TTL-cached + single-flight. This locks those guards so the exemption
// can't silently decay into an unmetered hot path (heygen's bucket is 5/min).
//
// Pure source-scan (main.js can't be require()d outside Electron).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('get-credits is TTL-cached and single-flight (documented rate-limit exemption)', () => {
  const i = MAIN.indexOf("ipcMain.handle('get-credits'");
  assert.ok(i >= 0, 'get-credits handler exists');
  const guard = MAIN.slice(Math.max(0, i - 1600), i + 900);
  assert.ok(/_creditsCache/.test(guard), 'TTL cache map must exist');
  assert.ok(/_creditsInflight/.test(guard), 'single-flight map must exist');
  assert.ok(/CREDITS_CACHE_MS = 10 \* 60 \* 1000/.test(guard), '10-minute TTL');
  assert.ok(/rate-limit enforcement audit/.test(guard),
    'the exemption must stay documented at the handler');
});

test('no OTHER main-process path calls the HeyGen/ElevenLabs API hosts directly', () => {
  // The two quota probes inside _getCreditsImpl are the only allowed
  // occurrences of these hosts in main.js.
  const heygen = (MAIN.match(/api\.heygen\.com/g) || []).length;
  const eleven = (MAIN.match(/api\.elevenlabs\.io/g) || []).length;
  assert.ok(heygen <= 1, `api.heygen.com appears ${heygen} times in main.js; only the get-credits probe is exempt`);
  assert.ok(eleven <= 1, `api.elevenlabs.io appears ${eleven} times in main.js; only the get-credits probe is exempt`);
});
