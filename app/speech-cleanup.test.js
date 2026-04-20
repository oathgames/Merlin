// Unit tests for speech-cleanup.js. Run with:
//   node app/speech-cleanup.test.js
//
// Every rule below comes from a real case of Kokoro reading markdown aloud:
// asterisks, backticks, emoji shortcodes, URL slashes, header hashes. Keep
// this file green so the TTS layer never regresses to spelling out syntax.

const assert = require('assert');
const { cleanTextForSpeech } = require('./speech-cleanup');

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

// ── Non-string / empty inputs ─────────────────────────────────

test('null returns empty string', () => {
  assert.strictEqual(cleanTextForSpeech(null), '');
});

test('undefined returns empty string', () => {
  assert.strictEqual(cleanTextForSpeech(undefined), '');
});

test('number returns empty string (never crashes)', () => {
  assert.strictEqual(cleanTextForSpeech(42), '');
});

test('empty string stays empty', () => {
  assert.strictEqual(cleanTextForSpeech(''), '');
});

test('plain prose passes through unchanged', () => {
  const s = 'Your CTR is up twelve percent this week.';
  assert.strictEqual(cleanTextForSpeech(s), s);
});

// ── Inline markdown emphasis ──────────────────────────────────

test('bold ** strips to word only', () => {
  assert.strictEqual(cleanTextForSpeech('This is **bold** text.'), 'This is bold text.');
});

test('italic * strips to word only', () => {
  assert.strictEqual(cleanTextForSpeech('This is *italic* text.'), 'This is italic text.');
});

test('bold __ strips to word only', () => {
  assert.strictEqual(cleanTextForSpeech('This is __strong__ text.'), 'This is strong text.');
});

test('italic _ strips to word only', () => {
  assert.strictEqual(cleanTextForSpeech('This is _soft_ text.'), 'This is soft text.');
});

test('strikethrough ~~ strips to word only', () => {
  assert.strictEqual(cleanTextForSpeech('Avoid ~~this~~ approach.'), 'Avoid this approach.');
});

test('inline `code` strips backticks', () => {
  assert.strictEqual(cleanTextForSpeech('Run `npm test` first.'), 'Run npm test first.');
});

test('multiple emphases in one sentence all strip', () => {
  const out = cleanTextForSpeech('**Bold** and *italic* and `code` together.');
  assert.strictEqual(out, 'Bold and italic and code together.');
});

test('stray un-paired asterisks are removed', () => {
  // Claude sometimes emits "* note:" as a lead-in. We strip the marker
  // without eating the word.
  assert.strictEqual(cleanTextForSpeech('* See the docs.'), 'See the docs.');
});

// ── Block markdown ────────────────────────────────────────────

test('# headers strip the hash', () => {
  assert.strictEqual(cleanTextForSpeech('# Welcome'), 'Welcome');
});

test('## headers strip the hashes', () => {
  assert.strictEqual(cleanTextForSpeech('## Today\'s plan'), "Today's plan");
});

test('blockquote > strips the marker', () => {
  assert.strictEqual(cleanTextForSpeech('> Quoted line.'), 'Quoted line.');
});

test('- bullet list items keep their text', () => {
  const out = cleanTextForSpeech('- First item\n- Second item\n- Third item');
  assert.ok(!out.includes('-'));
  assert.ok(out.includes('First item'));
  assert.ok(out.includes('Second item'));
  assert.ok(out.includes('Third item'));
});

test('1. numbered list items keep their text but drop the marker', () => {
  const out = cleanTextForSpeech('1. First\n2. Second\n3. Third');
  assert.ok(!/\d\./.test(out), `numbering should be gone: ${out}`);
  assert.ok(out.includes('First'));
});

test('horizontal rule --- is stripped', () => {
  const out = cleanTextForSpeech('Intro.\n\n---\n\nOutro.');
  assert.ok(!out.includes('---'));
  assert.ok(out.includes('Intro'));
  assert.ok(out.includes('Outro'));
});

test('fenced code block is removed entirely', () => {
  const out = cleanTextForSpeech('Here is code:\n```js\nconst x = 1;\n```\nDone.');
  assert.ok(!out.includes('```'));
  assert.ok(!out.includes('const x'));
  assert.ok(out.includes('Here is code'));
  assert.ok(out.includes('Done.'));
});

// ── Links / URLs ──────────────────────────────────────────────

test('markdown link keeps the label and drops the URL', () => {
  const out = cleanTextForSpeech('See [our site](https://merlingotme.com) for details.');
  assert.strictEqual(out, 'See our site for details.');
});

test('image markdown keeps alt text and drops the URL', () => {
  const out = cleanTextForSpeech('![hero banner](https://example.com/hero.png)');
  assert.strictEqual(out, 'hero banner');
});

test('bare URL is removed (would otherwise read slashes aloud)', () => {
  const out = cleanTextForSpeech('Visit https://merlingotme.com today.');
  assert.ok(!out.includes('https'));
  assert.ok(!out.includes('merlingotme'));
  assert.ok(out.includes('Visit'));
  assert.ok(out.includes('today'));
});

test('autolink <https://...> is removed', () => {
  const out = cleanTextForSpeech('Go to <https://merlingotme.com> now.');
  assert.ok(!out.includes('https'));
  assert.ok(out.includes('now'));
});

// ── Emojis / HTML / tables ────────────────────────────────────

test('emoji is stripped', () => {
  const out = cleanTextForSpeech('Great work! 🎉 You did it.');
  assert.ok(!/[\p{Extended_Pictographic}]/u.test(out), `emoji should be gone: ${out}`);
  assert.ok(out.includes('Great work'));
  assert.ok(out.includes('You did it'));
});

test('multi-codepoint emoji (family, flag, ZWJ) is stripped', () => {
  const out = cleanTextForSpeech('Team 👨‍👩‍👧 ready. 🇺🇸');
  assert.ok(!/[\p{Extended_Pictographic}\u200D]/u.test(out), `zwj/emoji should be gone: ${out}`);
  assert.ok(out.includes('Team'));
  assert.ok(out.includes('ready'));
});

test('HTML tags are stripped', () => {
  const out = cleanTextForSpeech('Visit <b>bold</b> and <i>italic</i> sections.');
  assert.ok(!out.includes('<'));
  assert.ok(!out.includes('>'));
  assert.ok(out.includes('bold'));
  assert.ok(out.includes('italic'));
});

test('table pipes become commas', () => {
  const out = cleanTextForSpeech('Name | Value | Status\nAds | 42 | ok');
  assert.ok(!out.includes('|'));
  assert.ok(out.includes('Name'));
  assert.ok(out.includes('Value'));
});

test('table separator row is stripped', () => {
  const out = cleanTextForSpeech('A | B\n---|---\n1 | 2');
  assert.ok(!out.includes('---'));
});

// ── Whitespace / punctuation cleanup ──────────────────────────

test('runs of whitespace collapse to one space', () => {
  assert.strictEqual(cleanTextForSpeech('Too    many   spaces'), 'Too many spaces');
});

test('paragraph breaks become sentence boundaries', () => {
  // \n\n → ". " so Kokoro gets a clear boundary for prosody.
  const out = cleanTextForSpeech('First thought.\n\nSecond thought.');
  assert.ok(out.includes('First thought.'));
  assert.ok(out.includes('Second thought.'));
  assert.ok(!out.includes('\n\n'));
});

test('orphaned period after whitespace is tightened', () => {
  // After cleanup, `"foo " + "."` shouldn't become `"foo ."`.
  assert.strictEqual(cleanTextForSpeech('End  .'), 'End.');
});

test('runs of periods collapse to one', () => {
  assert.strictEqual(cleanTextForSpeech('Wait... now.'), 'Wait. now.');
});

// ── Realistic end-to-end cases ────────────────────────────────

test('real Merlin reply: headline + bullets + emphasis', () => {
  const input =
    '## Performance snapshot\n\n' +
    'Your **ROAS** is up *significantly* this week — see [dashboard](https://merlingotme.com/dash) for details. 🎉\n\n' +
    '- CTR: **2.4%**\n' +
    '- CPC: `$0.87`\n' +
    '- Spend: $124';
  const out = cleanTextForSpeech(input);
  assert.ok(!out.includes('#'));
  assert.ok(!out.includes('*'));
  assert.ok(!out.includes('`'));
  assert.ok(!out.includes('🎉'));
  assert.ok(!out.includes('https'));
  assert.ok(!out.includes('['));
  assert.ok(out.includes('Performance snapshot'));
  assert.ok(out.includes('ROAS'));
  assert.ok(out.includes('significantly'));
  assert.ok(out.includes('dashboard'));
  assert.ok(out.includes('CTR'));
  assert.ok(out.includes('2.4%'));
});

test('real Merlin reply: code fence between prose', () => {
  const input = 'Here is the config:\n```json\n{"key": "value"}\n```\nDoes that work?';
  const out = cleanTextForSpeech(input);
  assert.ok(!out.includes('```'));
  assert.ok(!out.includes('"key"'));
  assert.ok(out.includes('Here is the config'));
  assert.ok(out.includes('Does that work'));
});

test('idempotent on already-clean prose', () => {
  const s = 'Your ROAS is up twelve percent this week.';
  assert.strictEqual(cleanTextForSpeech(cleanTextForSpeech(s)), s);
});

// ── Run ────────────────────────────────────────────────────────

console.log(`\nspeech-cleanup tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
