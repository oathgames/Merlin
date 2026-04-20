// Unit tests for voice-activity-detector.js. Run with:
//   node app/voice-activity-detector.test.js
//
// These tests exercise the pure thresholder (updateState + computeRms).
// The AudioContext glue is not covered here — it's a ~30-line adapter that
// feeds real frame data into updateState and is smoke-tested end-to-end in
// the renderer (manual: tap mic, speak, stop talking, confirm auto-stop).
//
// Why the split: updateState encodes every decision that matters for UX —
// warmup length, speech detection threshold, silence-end timing, the
// "never fire silence before first speech" rule. If any of those regresses,
// PTT breaks in a way the user notices immediately (false auto-stop,
// endless recording, etc). Keep this file green.

const assert = require('assert');
const { updateState, computeRms, DEFAULTS } = require('./voice-activity-detector');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  \u2713', name);
    passed++;
  } catch (err) {
    console.error('  \u2717', name);
    console.error('   ', err && err.message ? err.message : err);
    failed++;
  }
}

// Drive updateState with a sequence of (rms, ms-delta) frames. Returns the
// ordered list of events the detector emits.
function run(frames, opts) {
  let state = {};
  let now = 0;
  const events = [];
  for (const [rms, dt] of frames) {
    now += (dt || DEFAULTS.pollIntervalMs);
    const r = updateState(state, rms, now, opts);
    state = r.state;
    if (r.event) events.push(r.event);
  }
  return { events, state };
}

// ── computeRms ───────────────────────────────────────────────

test('computeRms of zero buffer is 0', () => {
  assert.strictEqual(computeRms(new Float32Array(1024)), 0);
});

test('computeRms of constant buffer equals the constant', () => {
  const buf = new Float32Array(1024).fill(0.5);
  assert.ok(Math.abs(computeRms(buf) - 0.5) < 1e-9);
});

test('computeRms tolerates empty / null input', () => {
  assert.strictEqual(computeRms(null), 0);
  assert.strictEqual(computeRms(new Float32Array(0)), 0);
});

// ── Warmup ────────────────────────────────────────────────────

test('no speech events fire during calibration window', () => {
  // 15 loud frames during warmup must emit nothing.
  const frames = Array(DEFAULTS.calibrationFrames).fill([0.5, 20]);
  const { events } = run(frames);
  assert.deepStrictEqual(events, []);
});

test('baseline is computed at end of warmup', () => {
  const frames = Array(DEFAULTS.calibrationFrames).fill([0.02, 20]);
  const { state } = run(frames);
  assert.ok(Math.abs(state.baselineRms - 0.02) < 1e-9);
});

// ── Speech detection ────────────────────────────────────────

test('speech-start fires on first above-threshold frame after warmup', () => {
  // Quiet warmup then a clear speech frame.
  const frames = [
    ...Array(DEFAULTS.calibrationFrames).fill([0.005, 20]),
    [0.3, 20],
  ];
  const { events } = run(frames);
  assert.deepStrictEqual(events, ['speech-start']);
});

test('no speech-start on sub-threshold frame (below multiplier)', () => {
  // Baseline 0.02 → threshold ≈ 0.05 (2.5x). A 0.03 frame is below.
  const frames = [
    ...Array(DEFAULTS.calibrationFrames).fill([0.02, 20]),
    [0.03, 20],
    [0.03, 20],
  ];
  const { events } = run(frames);
  assert.deepStrictEqual(events, []);
});

test('absolute floor prevents false-trigger in perfectly silent room', () => {
  // Baseline 0 → multiplier alone would make ANY blip qualify. Floor = 0.01.
  const frames = [
    ...Array(DEFAULTS.calibrationFrames).fill([0, 20]),
    [0.005, 20],   // below floor → no event
    [0.02,  20],   // above floor → speech-start
  ];
  const { events } = run(frames);
  assert.deepStrictEqual(events, ['speech-start']);
});

// ── Silence detection ────────────────────────────────────────

test('silence-end fires after silenceMs of continuous quiet after speech', () => {
  // Warmup quiet, one speech frame, then 700ms+ of silence.
  const frames = [
    ...Array(DEFAULTS.calibrationFrames).fill([0.005, 20]),
    [0.3, 20],
    // 36 silent frames at 20ms = 720 ms — just above the 700 ms threshold.
    ...Array(36).fill([0.005, 20]),
  ];
  const { events } = run(frames);
  assert.deepStrictEqual(events, ['speech-start', 'silence-end']);
});

test('silence-end does NOT fire before silenceMs has elapsed', () => {
  const frames = [
    ...Array(DEFAULTS.calibrationFrames).fill([0.005, 20]),
    [0.3, 20],
    // 20 silent frames at 20ms = 400ms — below the 700ms threshold.
    ...Array(20).fill([0.005, 20]),
  ];
  const { events } = run(frames);
  assert.deepStrictEqual(events, ['speech-start']);
});

test('silence-end does NOT fire if user never spoke', () => {
  // 100 quiet frames after warmup. hasSpokenYet never flips, no silence-end.
  const frames = [
    ...Array(DEFAULTS.calibrationFrames).fill([0.005, 20]),
    ...Array(100).fill([0.005, 20]),
  ];
  const { events } = run(frames);
  assert.deepStrictEqual(events, []);
});

test('silence timer resets when speech resumes mid-pause', () => {
  // Speech → 400ms silence (no fire) → speech → 720ms silence (fires once).
  const frames = [
    ...Array(DEFAULTS.calibrationFrames).fill([0.005, 20]),
    [0.3, 20],
    ...Array(20).fill([0.005, 20]),  // 400ms pause — no fire
    [0.3, 20],                        // speech resumes (no new speech-start — already spoken)
    ...Array(36).fill([0.005, 20]),  // 720ms pause — fires once
  ];
  const { events } = run(frames);
  assert.deepStrictEqual(events, ['speech-start', 'silence-end']);
});

test('speech-start fires exactly once per session', () => {
  // Speech at multiple moments must not re-emit speech-start.
  const frames = [
    ...Array(DEFAULTS.calibrationFrames).fill([0.005, 20]),
    [0.3, 20],  // speech-start
    [0.005, 20],
    [0.3, 20],  // no new start — already spoken
    [0.3, 20],
  ];
  const { events } = run(frames);
  assert.deepStrictEqual(events, ['speech-start']);
});

// ── Option overrides ─────────────────────────────────────────

test('opts override silenceMs', () => {
  // Custom 200 ms endpoint — fires faster.
  const frames = [
    ...Array(DEFAULTS.calibrationFrames).fill([0.005, 20]),
    [0.3, 20],
    ...Array(11).fill([0.005, 20]),  // 220 ms pause
  ];
  const { events } = run(frames, { silenceMs: 200 });
  assert.deepStrictEqual(events, ['speech-start', 'silence-end']);
});

test('opts override calibrationFrames', () => {
  const frames = [
    [0.005, 20], [0.005, 20],  // 2-frame warmup
    [0.3, 20],
  ];
  const { events } = run(frames, { calibrationFrames: 2 });
  assert.deepStrictEqual(events, ['speech-start']);
});

// ── Run ──────────────────────────────────────────────────────

console.log(`\nvoice-activity-detector tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
