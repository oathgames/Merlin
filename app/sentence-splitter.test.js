// Unit tests for sentence-splitter.js. Run with:
//   node app/sentence-splitter.test.js
//
// The splitter is the *only* thing deciding what Kokoro synthesises and when,
// so every edge case that would produce a bad stream — dropped text,
// duplicated text, premature flush of "Dr." as its own sentence, unflushed
// tail at end-of-stream — is covered here. Keep this file green.

const assert = require('assert');
const {
  extractCompleteSentences,
  drainRemaining,
  MIN_SENTENCE_CHARS,
  MIN_CLAUSE_CHARS,
  FIRST_FLUSH_CLAUSE_CHARS,
} = require('./sentence-splitter');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.error('  ✗', name);
    console.error('   ', err && err.message ? err.message : err);
    failed++;
  }
}

// ── Core sentence extraction ────────────────────────────────────

test('single complete sentence with trailing space', () => {
  const { sentences, nextIdx } = extractCompleteSentences('Hello world. ', 0);
  assert.deepStrictEqual(sentences, ['Hello world.']);
  assert.strictEqual(nextIdx, 13);
});

test('incomplete sentence (no trailing whitespace) is held back', () => {
  const { sentences, nextIdx } = extractCompleteSentences('Hello world.', 0);
  assert.deepStrictEqual(sentences, []);
  assert.strictEqual(nextIdx, 0);
});

test('two sentences flushed, tail held', () => {
  const input = 'First thing. Second thing! Tail';
  const { sentences, nextIdx } = extractCompleteSentences(input, 0);
  assert.deepStrictEqual(sentences, ['First thing.', 'Second thing!']);
  // nextIdx should sit right after the "! " that closed the second sentence,
  // i.e. at the first char of the unflushed tail.
  assert.strictEqual(input.slice(nextIdx), 'Tail');
});

test('streaming simulation: chunks arrive, cursor advances correctly', () => {
  // Claude's stream arrives in deltas; the caller hands us the whole buffer
  // each time with the previous nextIdx. Verify nothing is dropped or doubled.
  let buffer = '';
  let idx = 0;
  const allSentences = [];

  const feed = (chunk) => {
    buffer += chunk;
    const { sentences, nextIdx } = extractCompleteSentences(buffer, idx);
    allSentences.push(...sentences);
    idx = nextIdx;
  };

  feed('First reply.');            // no trailing ws → held
  feed(' ');                       // now "First reply. " → flush
  feed('Here comes another sentence which is long.');  // held
  feed('\n');                      // flush
  feed('Tail without terminator'); // never flushes

  assert.deepStrictEqual(allSentences, [
    'First reply.',
    'Here comes another sentence which is long.',
  ]);
  assert.strictEqual(buffer.slice(idx), 'Tail without terminator');
});

// ── Short-sentence coalescing ──────────────────────────────────

test('short first sentence coalesces with next', () => {
  // "Hi." is only 3 chars; must not be flushed solo (wastes a Kokoro call).
  const input = 'Hi. Longer follow-up sentence. ';
  const { sentences, nextIdx } = extractCompleteSentences(input, 0);
  assert.deepStrictEqual(sentences, ['Hi. Longer follow-up sentence.']);
  assert.strictEqual(nextIdx, input.length);
});

test('multiple short fragments coalesce until threshold', () => {
  // "Hi. Ok. Go. " individually below threshold, combined ≥ 12 chars.
  const input = 'Hi. Ok. Go. Bye now. ';
  const { sentences } = extractCompleteSentences(input, 0);
  assert.strictEqual(sentences.length, 1, `expected 1 bundle, got ${sentences.length}: ${JSON.stringify(sentences)}`);
  assert.ok(sentences[0].length >= MIN_SENTENCE_CHARS);
  assert.ok(sentences[0].includes('Hi.'));
  assert.ok(sentences[0].includes('Bye now.'));
});

test('paragraph break flushes even without terminal punctuation', () => {
  const input = '# Heading text here\n\nBody begins.';
  const { sentences, nextIdx } = extractCompleteSentences(input, 0);
  // "# Heading text here" is ≥ 12 chars; the \n\n triggers a flush.
  assert.deepStrictEqual(sentences, ['# Heading text here']);
  assert.strictEqual(input.slice(nextIdx), 'Body begins.');
});

// ── Edge cases that have caused real bugs in streaming TTS ─────

test('trailing period with newline flushes', () => {
  const { sentences } = extractCompleteSentences('Done.\n', 0);
  // "Done." is 5 chars — below threshold on its own, so it waits.
  assert.deepStrictEqual(sentences, []);
});

test('mixed punctuation: first flushes, short second is held', () => {
  // "Is that right?" = 14 chars → flushes alone.
  // "Absolutely!"    = 11 chars → below MIN_SENTENCE_CHARS, held for the
  //                    next delta so Kokoro doesn't waste a synth call on
  //                    a sub-second fragment.
  const input = 'Is that right? Absolutely! ';
  const { sentences, nextIdx } = extractCompleteSentences(input, 0);
  assert.deepStrictEqual(sentences, ['Is that right?']);
  assert.strictEqual(input.slice(nextIdx), 'Absolutely! ');
});

test('short trailing sentence is held for coalescing', () => {
  const input = 'Is that right? Ok! ';
  const { sentences, nextIdx } = extractCompleteSentences(input, 0);
  assert.deepStrictEqual(sentences, ['Is that right?']);
  // "Ok! " is held for the next delta — nextIdx points at the 'O'.
  assert.strictEqual(input.slice(nextIdx), 'Ok! ');
});

test('empty input returns empty result', () => {
  assert.deepStrictEqual(extractCompleteSentences('', 0), { sentences: [], nextIdx: 0 });
});

test('non-string input is tolerated', () => {
  assert.deepStrictEqual(extractCompleteSentences(null, 0), { sentences: [], nextIdx: 0 });
  assert.deepStrictEqual(extractCompleteSentences(undefined, 5), { sentences: [], nextIdx: 5 });
});

test('fromIdx past end of string clamps safely', () => {
  const { sentences, nextIdx } = extractCompleteSentences('Hi.', 99);
  assert.deepStrictEqual(sentences, []);
  assert.strictEqual(nextIdx, 3);
});

test('numbered list items flush as single coalesced chunk when short', () => {
  // "1. First.\n2. Second.\n3. Third.\n" — each item is below threshold on its
  // own because the trim drops leading "N. " but the full fragment "1. First."
  // is still 9 chars. Must coalesce.
  const input = '1. First.\n2. Second.\n3. Third.\n';
  const { sentences } = extractCompleteSentences(input, 0);
  // Every periodperiod is followed by whitespace (the \n). Expect them bundled.
  assert.ok(sentences.length >= 1);
  assert.ok(sentences.every((s) => s.length >= MIN_SENTENCE_CHARS));
});

test('long sentence flushes immediately even if alone', () => {
  const input = 'This is a long enough sentence to clear the threshold. ';
  const { sentences, nextIdx } = extractCompleteSentences(input, 0);
  assert.strictEqual(sentences.length, 1);
  assert.strictEqual(sentences[0], 'This is a long enough sentence to clear the threshold.');
  assert.strictEqual(nextIdx, input.length);
});

test('resume: second call with more text does not re-emit first sentence', () => {
  const input1 = 'This is the first complete sentence. ';
  const r1 = extractCompleteSentences(input1, 0);
  assert.deepStrictEqual(r1.sentences, ['This is the first complete sentence.']);

  const input2 = input1 + 'And this is the second one. ';
  const r2 = extractCompleteSentences(input2, r1.nextIdx);
  assert.deepStrictEqual(r2.sentences, ['And this is the second one.']);
});

// ── drainRemaining: end-of-stream flush ────────────────────────

test('drainRemaining returns the unflushed tail', () => {
  assert.strictEqual(drainRemaining('Hi.', 0), 'Hi.');
});

test('drainRemaining returns empty when everything was already flushed', () => {
  const input = 'Long enough sentence here. ';
  const { nextIdx } = extractCompleteSentences(input, 0);
  assert.strictEqual(drainRemaining(input, nextIdx), '');
});

test('drainRemaining trims whitespace', () => {
  assert.strictEqual(drainRemaining('Tail.   \n\n  ', 0), 'Tail.');
});

test('drainRemaining tolerates out-of-range idx', () => {
  assert.strictEqual(drainRemaining('Hi.', 999), '');
  assert.strictEqual(drainRemaining('Hi.', -5), 'Hi.');
});

// ── Clause-boundary flushing (S-tier TTS TTFB) ─────────────────
// The clause boundary is what closes the "Claude just said a sentence, now
// wait for the period" gap. Flushing on commas / em-dashes / semicolons
// once we've accumulated ≥MIN_CLAUSE_CHARS lets Kokoro start speaking the
// first long clause of a reply sooner. The threshold is tuned for
// conversational fluidity: too low and every mid-sentence comma produces
// an audible Kokoro gap; too high and we lose the TTFB benefit entirely.

test('long clause flushes on comma when >= MIN_CLAUSE_CHARS', () => {
  // >80 chars before the comma — well above MIN_CLAUSE_CHARS.
  const input = 'For the first part of our long opening clause here that clearly spans quite a lot, we continue on. ';
  const { sentences, nextIdx } = extractCompleteSentences(input, 0);
  assert.strictEqual(sentences.length, 2, `expected 2 flushes, got ${JSON.stringify(sentences)}`);
  assert.ok(sentences[0].endsWith(','));
  assert.ok(sentences[0].length >= MIN_CLAUSE_CHARS);
  assert.strictEqual(nextIdx, input.length);
});

test('short clause does NOT flush on comma (below MIN_CLAUSE_CHARS)', () => {
  // "Quick note," is 11 chars — well below clause threshold. Must wait for
  // a strong boundary.
  const input = 'Quick note, more text here. ';
  const { sentences, nextIdx } = extractCompleteSentences(input, 0);
  assert.strictEqual(sentences.length, 1, `expected 1 flush, got ${JSON.stringify(sentences)}`);
  assert.strictEqual(sentences[0], 'Quick note, more text here.');
  assert.strictEqual(nextIdx, input.length);
});

test('mid-length sentence with comma does NOT flush early (smooth prosody)', () => {
  // Previously at MIN_CLAUSE_CHARS=40 this would have split into two
  // Kokoro calls. At 80 it stays as one sentence → one smooth
  // synth → no audible gap at the comma.
  const input = 'That is a reasonable opening clause here, and then comes the rest of the thought. ';
  const { sentences } = extractCompleteSentences(input, 0);
  assert.strictEqual(sentences.length, 1, `expected 1 flush, got ${JSON.stringify(sentences)}`);
  assert.ok(sentences[0].endsWith('.'));
});

test('em-dash flushes when clause is long enough', () => {
  // >80 chars before the em-dash, so it clears MIN_CLAUSE_CHARS.
  const input = 'A long enough opening thought here as shown before the dash appears in this sentence\u2014then the rest of the long sentence. ';
  const { sentences } = extractCompleteSentences(input, 0);
  assert.strictEqual(sentences.length, 2, `expected 2 flushes, got ${JSON.stringify(sentences)}`);
  assert.ok(sentences[0].endsWith('\u2014'));
});

test('semicolon flushes when clause is long enough', () => {
  // Clause >=MIN_CLAUSE_CHARS flushes on `;`. Tail must also clear
  // MIN_SENTENCE_CHARS to emit on its own — otherwise it's held for the
  // next delta.
  const input = 'Here is the first part that clearly exceeds eighty characters as written in this clause right here; and here follows a proper second sentence. ';
  const { sentences } = extractCompleteSentences(input, 0);
  assert.strictEqual(sentences.length, 2, `expected 2 flushes, got ${JSON.stringify(sentences)}`);
  assert.ok(sentences[0].endsWith(';'));
  assert.ok(sentences[1].endsWith('.'));
});

test('clause flush then sentence continues: no duplication', () => {
  // Simulates streaming: the caller feeds cumulative text and advances idx.
  // Must not re-emit the clause on the next call.
  let buffer = '';
  let idx = 0;
  const all = [];
  const feed = (chunk) => {
    buffer += chunk;
    const r = extractCompleteSentences(buffer, idx);
    all.push(...r.sentences);
    idx = r.nextIdx;
  };
  feed('This is the first long opening clause that clearly exceeds eighty characters in length, ');
  feed('and this is the rest of the sentence. ');
  assert.strictEqual(all.length, 2);
  assert.ok(all[0].endsWith(','));
  assert.ok(all[1].endsWith('.'));
  assert.strictEqual(buffer.slice(idx), '');
});

test('mixed strong + soft boundaries: strong takes precedence for short buf', () => {
  // "Hi." (3 chars) — held. Comma then arrives at 11 total — still below 80.
  // Period at end (cumulative >=12 chars) flushes.
  const input = 'Hi. Wait, done here. ';
  const { sentences } = extractCompleteSentences(input, 0);
  assert.strictEqual(sentences.length, 1);
  assert.strictEqual(sentences[0], 'Hi. Wait, done here.');
});

test('MIN_CLAUSE_CHARS constant is exported and sensible', () => {
  assert.ok(typeof MIN_CLAUSE_CHARS === 'number');
  assert.ok(MIN_CLAUSE_CHARS > MIN_SENTENCE_CHARS);
  assert.ok(MIN_CLAUSE_CHARS <= 120);
});

// ── First-flush TTFB path (opts.minClauseChars) ────────────────

test('FIRST_FLUSH_CLAUSE_CHARS is exported and below default', () => {
  assert.ok(typeof FIRST_FLUSH_CLAUSE_CHARS === 'number');
  assert.ok(FIRST_FLUSH_CLAUSE_CHARS > 0);
  assert.ok(FIRST_FLUSH_CLAUSE_CHARS < MIN_CLAUSE_CHARS,
    'first-flush threshold must be lower than the default so it actually shaves TTFB');
});

test('opts.minClauseChars lets a mid-length clause flush early', () => {
  // 42-char opener with a comma — normally held (< 80), but flushes when the
  // caller supplies FIRST_FLUSH_CLAUSE_CHARS (30) for the opening clause.
  const input = 'Okay, pulling your dashboard numbers now, one moment.';
  const { sentences, nextIdx } = extractCompleteSentences(
    input, 0, { minClauseChars: FIRST_FLUSH_CLAUSE_CHARS },
  );
  assert.ok(sentences.length >= 1, 'expected at least one early flush');
  assert.ok(sentences[0].length < MIN_CLAUSE_CHARS,
    'early flush should include the pre-comma clause, below the default threshold');
  assert.ok(nextIdx > 0);
});

test('default threshold holds the same clause (no early flush)', () => {
  // Same input — with the default 80-char threshold, the comma alone should
  // not trigger a flush. Only the terminal period flushes the whole thing.
  const input = 'Okay, pulling your dashboard numbers now, one moment.';
  // Terminal period + trailing space needed for strong-boundary match.
  const { sentences } = extractCompleteSentences(input + ' ', 0);
  assert.deepStrictEqual(sentences, [input]);
});

test('opts.minClauseChars below zero falls back to default', () => {
  // Defensive: a bad override shouldn\'t break the splitter. 0 / negative /
  // non-number opts silently fall back to MIN_CLAUSE_CHARS.
  const input = 'Okay, pulling your dashboard numbers now, one moment.';
  const { sentences } = extractCompleteSentences(input + ' ', 0, { minClauseChars: 0 });
  assert.deepStrictEqual(sentences, [input]);
  const { sentences: s2 } = extractCompleteSentences(input + ' ', 0, { minClauseChars: -5 });
  assert.deepStrictEqual(s2, [input]);
  const { sentences: s3 } = extractCompleteSentences(input + ' ', 0, { minClauseChars: 'wide' });
  assert.deepStrictEqual(s3, [input]);
});

// ── Run ────────────────────────────────────────────────────────

console.log(`\nsentence-splitter tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
