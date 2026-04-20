// Voice Activity Detector (VAD) for push-to-talk auto-endpointing.
//
// Purpose: within a PTT recording session the user shouldn't have to tap the
// mic a second time to say "I'm done." We watch the mic energy, wait for the
// user to actually start speaking, then fire `onSilenceDetected` after N ms
// of continuous silence. The caller (renderer.js startRecording) stops the
// MediaRecorder at that point and ships the clip to Whisper.
//
// Why energy-based (not Silero): PTT already gives us most of what Silero
// buys you — the user is committed to speaking, the window is short, and
// background-noise handling matters less than in always-listening mode.
// An adaptive RMS threshold (baseline + 2.5x) calibrated from the first
// ~300 ms of the session catches typical room noise while reliably detecting
// speech. Zero new dependencies, zero ship-size cost, ~1 ms per frame.
// Swappable for Silero ONNX later if we ever go always-listening — the
// callback contract (onSpeechStart / onSilenceDetected / stop) stays the
// same.
//
// Dual-module shim so tests can import the pure thresholder in Node.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MerlinVAD = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  const DEFAULTS = {
    // Frames below this many samples of calibration data are still in the
    // warmup window; treat everything as baseline (no speech yet). 300 ms at
    // 50 Hz polling = 15 frames. Picks up a stable baseline in under half a
    // second on typical rooms.
    calibrationFrames: 15,
    // Multiplier over calibrated baseline to qualify a frame as "speech".
    // 2.5x is the sweet spot on laptop built-in mics: ignores fan hum /
    // keyboard clicks, fires reliably on even a quiet "hmm".
    speechThresholdMultiplier: 2.5,
    // Absolute floor on the speech threshold — if the room is truly silent
    // (baseline ≈ 0), multiplier alone would make any blip qualify. This
    // sets a real-world minimum RMS for "human voice" on a -1..1 sample.
    minAbsoluteThreshold: 0.01,
    // A single sub-threshold frame doesn't end the turn — we require N ms
    // of continuous silence AFTER the user has spoken at least once.
    // 700 ms matches ChatGPT voice + Siri; quick enough to feel snappy,
    // long enough to tolerate mid-sentence breath pauses.
    silenceMs: 700,
    // How often to poll the analyser. 50 Hz = 20 ms → silence detection
    // granularity is ±20 ms, which is well below perceptible.
    pollIntervalMs: 20,
    // Safety cap: if the user never stops speaking, auto-end at this
    // duration. Prevents runaway hot mics. Whisper caps its own input at
    // ~30 min so this is just UX insurance, not a hard requirement.
    maxDurationMs: 60_000,
  };

  // Pure function: given a frame RMS and state, return updated state.
  // Separated from the AudioContext glue so unit tests can drive it with
  // synthetic frames and verify the silence-timer logic without a browser.
  //
  // state shape:
  //   calibrationRmsSum   — accumulator for baseline during warmup
  //   framesSeen          — total frames processed this session
  //   baselineRms         — locked after warmup; 0 during warmup
  //   hasSpokenYet        — flips true on first above-threshold frame
  //   silentSinceMs       — ts of first consecutive sub-threshold frame
  //                         (null while currently in speech or pre-speech)
  //
  // Returns { state, event }. event ∈ { null, 'speech-start', 'silence-end' }.
  function updateState(state, rms, nowMs, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const s = Object.assign({}, state);
    s.framesSeen = (s.framesSeen || 0) + 1;

    // Warmup: accumulate baseline. No speech detection during this window.
    if (s.framesSeen <= o.calibrationFrames) {
      s.calibrationRmsSum = (s.calibrationRmsSum || 0) + rms;
      if (s.framesSeen === o.calibrationFrames) {
        s.baselineRms = s.calibrationRmsSum / o.calibrationFrames;
      }
      return { state: s, event: null };
    }

    const threshold = Math.max(
      (s.baselineRms || 0) * o.speechThresholdMultiplier,
      o.minAbsoluteThreshold,
    );

    let event = null;
    if (rms >= threshold) {
      // Above threshold: real speech frame. Reset silence timer.
      if (!s.hasSpokenYet) {
        s.hasSpokenYet = true;
        event = 'speech-start';
      }
      s.silentSinceMs = null;
    } else {
      // Below threshold: silence. Only counts once the user has spoken.
      if (s.hasSpokenYet) {
        if (s.silentSinceMs == null) {
          s.silentSinceMs = nowMs;
        } else if (nowMs - s.silentSinceMs >= o.silenceMs) {
          event = 'silence-end';
        }
      }
    }
    return { state: s, event };
  }

  // Compute RMS (root mean square) of a Float32 frame buffer. Values in
  // [-1, 1] per Web Audio convention.
  function computeRms(frame) {
    if (!frame || !frame.length) return 0;
    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i];
      sumSq += v * v;
    }
    return Math.sqrt(sumSq / frame.length);
  }

  // Browser glue. Creates an AudioContext → AnalyserNode chain on the
  // provided MediaStream and polls getFloatTimeDomainData at pollIntervalMs.
  //
  // Returns a handle with:
  //   stop()        — disconnect + close context; idempotent
  //   destroyed     — true once stop() has run
  //
  // Callbacks:
  //   onSpeechStart()       — first above-threshold frame after warmup
  //   onSilenceDetected()   — N ms of continuous silence after speech
  //   onMaxDuration()       — safety cap fired
  //
  // Caller invariants:
  //   - Call stop() in every termination path (manual, silence, max, error)
  //   - The MediaStream is NOT owned by this module; caller stops its tracks
  function attachVAD(mediaStream, callbacks, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const cbs = callbacks || {};
    if (typeof window === 'undefined' || !window.AudioContext) {
      // No Web Audio support — caller falls back to manual stop.
      return { stop: () => {}, destroyed: true };
    }
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtor();
    const source = ctx.createMediaStreamSource(mediaStream);
    const analyser = ctx.createAnalyser();
    // FFT size governs the time-domain buffer length. 1024 samples at a
    // typical 48 kHz sample rate = ~21 ms of audio per frame — well matched
    // to the 20 ms poll cadence.
    analyser.fftSize = 1024;
    source.connect(analyser);

    const frameBuf = new Float32Array(analyser.fftSize);
    let state = {};
    const startedAt = Date.now();
    let destroyed = false;
    let intervalId = null;

    const tick = () => {
      if (destroyed) return;
      try {
        analyser.getFloatTimeDomainData(frameBuf);
      } catch (_) {
        return;
      }
      const rms = computeRms(frameBuf);
      const now = Date.now();
      const { state: nextState, event } = updateState(state, rms, now, o);
      state = nextState;
      if (event === 'speech-start' && typeof cbs.onSpeechStart === 'function') {
        try { cbs.onSpeechStart(); } catch (_) {}
      } else if (event === 'silence-end' && typeof cbs.onSilenceDetected === 'function') {
        try { cbs.onSilenceDetected(); } catch (_) {}
      }
      if (now - startedAt >= o.maxDurationMs && typeof cbs.onMaxDuration === 'function') {
        try { cbs.onMaxDuration(); } catch (_) {}
      }
    };

    intervalId = setInterval(tick, o.pollIntervalMs);

    const stop = () => {
      if (destroyed) return;
      destroyed = true;
      if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
      try { source.disconnect(); } catch (_) {}
      try { analyser.disconnect(); } catch (_) {}
      try { ctx.close(); } catch (_) {}
    };

    return {
      stop,
      get destroyed() { return destroyed; },
    };
  }

  return { attachVAD, updateState, computeRms, DEFAULTS };
}));
