// Streaming sentence extractor for the live-TTS pipeline.
//
// Called on every Claude text delta with the accumulated `cleaned` text and
// the index already consumed. Returns any newly-complete sentences (or
// sufficiently long clauses) plus the updated consumed index. Incomplete
// tails are preserved — the caller passes the same `cleaned` text on the
// next call, and we resume from `nextIdx`.
//
// Design notes:
//   * STRONG boundary = terminal punctuation ([.!?]) followed by whitespace,
//     or a blank-line paragraph break (\n\n+). A buffered fragment >= 12
//     chars flushes at a strong boundary.
//   * SOFT / CLAUSE boundary = comma/semicolon/colon followed by whitespace,
//     or an em-dash (optionally followed by whitespace). A buffered fragment
//     >= 80 chars flushes at a soft boundary. The threshold is a deliberate
//     trade-off: a lower value (was 40) shaves TTFB by another ~200 ms but
//     fragments every mid-length sentence into 2-3 Kokoro calls, and each
//     call introduces an audible gap in the handoff. 80 chars keeps most
//     normal prose sentences whole (one Kokoro call → smooth prosody)
//     while still early-flushing any genuinely long multi-clause opener
//     so audio starts before Claude's period arrives.
//   * We don't use end-of-string as a boundary because Claude's next token
//     may extend the current clause.
//   * A fragment shorter than the relevant threshold is coalesced with the
//     next one. Short fragments ("Hi.", "1.", "Go!") produce ~200 ms of
//     Kokoro overhead per fragment for ~300 ms of audio, which is wasted
//     work and sounds choppy. Pairing them halves the overhead without
//     hurting latency on normal prose.
//   * No lookbehind — keeps this runnable in every browser Electron ships
//     with, and simpler regex is easier to reason about.
//
// Dual-module shim: loaded as a global (window.MerlinSentenceSplitter) in the
// renderer, and as a CommonJS module in the node-based test harness. Keep
// both export paths intact when editing.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MerlinSentenceSplitter = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  // Unified boundary regex. Each alternation uses a distinct capture group
  // so we can tell strong vs soft after the match without re-scanning.
  //   group 1: [.!?]           — strong terminal punctuation
  //   group 2: \n\n+           — strong paragraph break
  //   group 3: [,;:]           — soft clause punctuation
  //   group 4: [—–]            — em/en dash (soft)
  // The trailing \s+ / \s* is part of the match so the next scan resumes at
  // the start of the next fragment rather than re-swallowing leading space.
  const BOUNDARY_RE = /([.!?])\s+|(\n\n+)|([,;:])\s+|([\u2014\u2013])\s*/g;
  const MIN_SENTENCE_CHARS = 12;
  const MIN_CLAUSE_CHARS = 80;

  // Extract every complete sentence (or long-enough clause) that has appeared
  // in `cleaned` since `fromIdx`. Returns:
  //   sentences: string[]   — ready to hand to Kokoro, in order
  //   nextIdx:   number     — updated consumed index for the next call
  //
  // Invariant: on every call, the caller passes the same consumed prefix of
  // `cleaned` that it passed last time plus any new content. The function is
  // stateless across calls — all state lives in `fromIdx`.
  function extractCompleteSentences(cleaned, fromIdx) {
    if (typeof cleaned !== 'string') return { sentences: [], nextIdx: fromIdx | 0 };
    const start = Math.max(0, Math.min(fromIdx | 0, cleaned.length));
    const tail = cleaned.slice(start);
    const out = [];
    let buf = '';
    let lastFlushEnd = 0;
    let cursor = 0;
    BOUNDARY_RE.lastIndex = 0;
    let m;
    while ((m = BOUNDARY_RE.exec(tail)) !== null) {
      const endAt = m.index + m[0].length;
      buf += tail.slice(cursor, endAt);
      cursor = endAt;
      const trimmed = buf.trim();
      const isStrong = Boolean(m[1] || m[2]);
      const threshold = isStrong ? MIN_SENTENCE_CHARS : MIN_CLAUSE_CHARS;
      if (trimmed.length >= threshold) {
        out.push(trimmed);
        buf = '';
        lastFlushEnd = cursor;
      }
      // else: keep accumulating. cursor advances but lastFlushEnd does not,
      // so the partial group is re-scanned on the next call with more text.
    }
    return { sentences: out, nextIdx: start + lastFlushEnd };
  }

  // Flush whatever is left — called at end-of-stream. Ignores the length
  // minimum because no more text will ever arrive to pair with it.
  function drainRemaining(cleaned, fromIdx) {
    if (typeof cleaned !== 'string') return '';
    const start = Math.max(0, Math.min(fromIdx | 0, cleaned.length));
    const rest = cleaned.slice(start).trim();
    return rest || '';
  }

  return { extractCompleteSentences, drainRemaining, MIN_SENTENCE_CHARS, MIN_CLAUSE_CHARS };
}));
