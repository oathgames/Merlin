// Tests for artifact-parser.js — the bridge between Go binary stdout and
// the renderer's inline artifact gallery. The parser is what made the
// "I can't see them, can you render them here?" regression impossible:
// every failure mode below is a real way the chat could lose previews.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SENTINEL_OPEN,
  SENTINEL_CLOSE,
  extractArtifacts,
  renderGalleryMarkdown,
  renderDashboardMarkdown,
  toMerlinUrl,
} = require('./artifact-parser');

function wrap(json) {
  return `${SENTINEL_OPEN}\n${json}\n${SENTINEL_CLOSE}`;
}

test('toMerlinUrl encodes path segments and normalizes backslashes', () => {
  assert.equal(toMerlinUrl('results/img/foo bar.png'), 'merlin://results/img/foo%20bar.png');
  assert.equal(toMerlinUrl('D:\\autocmo-work\\results\\img\\001.png'), 'merlin://D%3A/autocmo-work/results/img/001.png');
  assert.equal(toMerlinUrl('merlin://already/encoded.png'), 'merlin://already/encoded.png');
  assert.equal(toMerlinUrl(''), '');
  assert.equal(toMerlinUrl(null), '');
});

test('toMerlinUrl is idempotent — already percent-encoded segments do NOT double-encode', () => {
  // The bug Gitar caught on PR #69: input already contains %20, naive
  // encodeURIComponent re-encodes the % to %25 producing %2520.
  assert.equal(
    toMerlinUrl('results/img/foo%20bar.png'),
    'merlin://results/img/foo%20bar.png'
  );
  assert.equal(
    toMerlinUrl('merlin://results/img/foo%20bar.png'),
    'merlin://results/img/foo%20bar.png'
  );
  // Round-trip: re-running on the output produces the same URL.
  const once = toMerlinUrl('results/img/foo bar.png');
  assert.equal(toMerlinUrl(once), once);
  // Mixed: one segment encoded, another with a literal space.
  assert.equal(
    toMerlinUrl('merlin://foo%20bar/baz qux.png'),
    'merlin://foo%20bar/baz%20qux.png'
  );
});

test('toMerlinUrl handles literal % in filenames without throwing', () => {
  // `decodeURIComponent('5%off')` throws URIError — fallback path must
  // still produce a usable URL rather than crashing the gallery render.
  assert.equal(
    toMerlinUrl('results/img/5%off.png'),
    'merlin://results/img/5%25off.png'
  );
  assert.equal(
    toMerlinUrl('a%b%c'),
    'merlin://a%25b%25c'
  );
});

test('extractArtifacts returns no bundles when no sentinel is present', () => {
  const stdout = 'Plain stdout with no sentinel block.';
  const out = extractArtifacts(stdout);
  assert.deepEqual(out.bundles, []);
  assert.equal(out.cleanText, stdout);
  assert.equal(out.galleryMarkdown, '');
});

test('extractArtifacts handles empty/null input safely', () => {
  assert.deepEqual(extractArtifacts(''), { bundles: [], cleanText: '', galleryMarkdown: '' });
  assert.deepEqual(extractArtifacts(null), { bundles: [], cleanText: '', galleryMarkdown: '' });
  assert.deepEqual(extractArtifacts(undefined), { bundles: [], cleanText: '', galleryMarkdown: '' });
});

test('extractArtifacts strips a single image bundle and substitutes gallery HTML', () => {
  const bundle = {
    kind: 'image',
    runDir: 'results/img_20260419_120000',
    brand: 'brightco',
    product: 'hoodie',
    model: 'banana-pro-edit',
    items: [
      { path: 'results/img_20260419_120000/001/portrait.png', kind: 'image', label: '001 portrait', format: 'portrait' },
      { path: 'results/img_20260419_120000/001/square.png',   kind: 'image', label: '001 square',   format: 'square'   },
    ],
    summary: '2 images generated',
  };
  const stdout = `Working...\n${wrap(JSON.stringify(bundle))}\nDone.`;
  const { bundles, cleanText, galleryMarkdown } = extractArtifacts(stdout);

  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].items.length, 2);
  assert.equal(bundles[0].model, 'banana-pro-edit');

  // Sentinel is gone, gallery is in
  assert.ok(!cleanText.includes(SENTINEL_OPEN), 'open sentinel must be stripped');
  assert.ok(!cleanText.includes(SENTINEL_CLOSE), 'close sentinel must be stripped');
  assert.ok(cleanText.includes('merlin-gallery'), 'gallery wrapper must be present');
  assert.ok(cleanText.includes('2 images generated'), 'headline must be present');
  assert.ok(cleanText.includes('banana-pro-edit'), 'model meta must be present');

  // Each item became a <figure> with an <img>
  assert.match(cleanText, /<figure class="merlin-artifact merlin-artifact-image">/);
  assert.equal((cleanText.match(/<figure /g) || []).length, 2);
  assert.match(cleanText, /<img src="merlin:\/\/results\/img_20260419_120000\/001\/portrait\.png"/);

  // Surrounding text preserved
  assert.ok(cleanText.startsWith('Working...'));
  assert.ok(cleanText.trim().endsWith('Done.'));

  // Independent gallery markdown payload
  assert.ok(galleryMarkdown.includes('merlin-gallery'));
});

test('extractArtifacts handles multiple sentinel blocks (chained pipelines)', () => {
  const a = { kind: 'image', items: [{ path: 'a.png', kind: 'image', label: 'A' }] };
  const b = { kind: 'audio', items: [{ path: 'b.mp3', kind: 'audio', label: 'B voice' }] };
  const stdout = [
    'first pipeline',
    wrap(JSON.stringify(a)),
    'between',
    wrap(JSON.stringify(b)),
    'last',
  ].join('\n');

  const out = extractArtifacts(stdout);
  assert.equal(out.bundles.length, 2);
  assert.equal((out.cleanText.match(/<div class="merlin-gallery"/g) || []).length, 2);
  assert.match(out.cleanText, /<audio src="merlin:\/\/b\.mp3"/);
  assert.match(out.cleanText, /<img src="merlin:\/\/a\.png"/);
});

test('extractArtifacts on malformed JSON leaves the original block instead of vanishing', () => {
  const stdout = `before\n${wrap('{ this is not json }')}\nafter`;
  const out = extractArtifacts(stdout);
  // No bundle parsed, no gallery emitted — but the original JSON blob is
  // preserved in cleanText so the user at least sees raw output rather
  // than silent loss.
  assert.equal(out.bundles.length, 0);
  assert.ok(out.cleanText.includes('{ this is not json }'),
    'malformed payload must be preserved so we never silently swallow output');
  assert.ok(!out.cleanText.includes('merlin-gallery'));
});

test('renderGalleryMarkdown renders video items with <video> tags', () => {
  const md = renderGalleryMarkdown({
    kind: 'video',
    model: 'seedance-2',
    items: [
      { path: 'results/ad/master.mp4', kind: 'video', label: 'master cut' },
      { path: 'results/ad/feed_4x5.mp4', kind: 'video', label: '4:5 feed' },
    ],
  });
  assert.match(md, /<video src="merlin:\/\/results\/ad\/master\.mp4" controls/);
  assert.match(md, /data-kind="video"/);
  assert.match(md, /<figcaption>master cut<\/figcaption>/);
});

test('renderGalleryMarkdown surfaces QA failure badges for flagged items', () => {
  const md = renderGalleryMarkdown({
    kind: 'image',
    items: [
      { path: 'a.png', kind: 'image', label: 'pass', qa: { pass: true, score: 0.9 } },
      { path: 'b.png', kind: 'image', label: 'fail', qa: { pass: false, reason: 'ref-mismatch' } },
    ],
  });
  // Only the failing item gets the badge, with the reason in the title attr.
  assert.equal((md.match(/merlin-artifact-qa/g) || []).length, 1);
  assert.match(md, /title="ref-mismatch"/);
});

test('renderGalleryMarkdown returns empty string when bundle has no items', () => {
  assert.equal(renderGalleryMarkdown(null), '');
  assert.equal(renderGalleryMarkdown({ kind: 'image' }), '');
  assert.equal(renderGalleryMarkdown({ kind: 'image', items: [] }), '');
});

test('renderGalleryMarkdown escapes HTML in labels and metadata', () => {
  const md = renderGalleryMarkdown({
    kind: 'image',
    brand: 'evil & co <script>',
    items: [{ path: 'a.png', kind: 'image', label: '"><img src=x>' }],
  });
  // Raw <script> / unescaped quotes must NOT survive into the gallery.
  assert.ok(!md.includes('<script>'), 'brand HTML must be escaped');
  assert.ok(!md.includes('"><img src=x>'), 'label HTML must be escaped');
  assert.match(md, /evil &amp; co/);
});

test('extractArtifacts singular grammar for one image', () => {
  const out = extractArtifacts(wrap(JSON.stringify({
    kind: 'image',
    items: [{ path: 'one.png', kind: 'image', label: 'only' }],
  })));
  assert.match(out.cleanText, /1 image generated/);
  assert.ok(!out.cleanText.includes('1 images'), 'must use singular');
});

// --- Dashboard bundle branch -------------------------------------------
//
// REGRESSION GUARD (2026-04-20, live-dashboard-artifact): dashboards ride
// the SAME sentinel as image/video galleries but carry a pre-rendered HTML
// document in `bundle.html` instead of an `items[]` array. The parser wraps
// the HTML in a ```html fenced block so renderer.js's existing sandboxed-
// iframe path picks it up (extracts before marked parses, iframes with
// sandbox="allow-scripts" + CSP default-src 'none'). If this branch regresses,
// dashboards render as raw HTML in the chat OR blow away Claude's prose
// summary — both were observed during the initial integration.

test('renderDashboardMarkdown wraps bundle.html in ```html fenced block', () => {
  const html = '<!doctype html><html><body><div class="dash">ok</div></body></html>';
  const md = renderDashboardMarkdown({
    kind: 'dashboard',
    html,
    summary: 'Brightco performance — last 7 days',
    brand: 'brightco',
  });
  assert.match(md, /^\s*\*\*Brightco performance — last 7 days\*\*/);
  assert.match(md, /_\(brightco\)_/);
  assert.match(md, /```html\n[\s\S]*<div class="dash">ok<\/div>[\s\S]*\n```/);
});

test('renderDashboardMarkdown returns empty string for missing/empty html', () => {
  assert.equal(renderDashboardMarkdown(null), '');
  assert.equal(renderDashboardMarkdown({}), '');
  assert.equal(renderDashboardMarkdown({ kind: 'dashboard' }), '');
  assert.equal(renderDashboardMarkdown({ kind: 'dashboard', html: '' }), '');
  assert.equal(renderDashboardMarkdown({ kind: 'dashboard', html: '   \n\t ' }), '');
});

test('renderDashboardMarkdown escapes stray triple-backticks so fence stays intact', () => {
  // Shouldn't happen (our Go renderer never emits backticks), but if it
  // ever did, a raw ``` inside the body breaks out of the fence and
  // bypasses the iframe sandbox. The replacement is lossless for any
  // real dashboard HTML.
  const html = '<pre>foo ``` bar</pre>';
  const md = renderDashboardMarkdown({ kind: 'dashboard', html, summary: 'x' });
  assert.ok(!md.includes('foo ``` bar'), 'stray triple-backtick must be escaped');
  assert.match(md, /foo ` `` bar/);
  // Only one opening + one closing fence.
  assert.equal((md.match(/^```html$/gm) || []).length, 1);
  assert.equal((md.match(/^```$/gm) || []).length, 1);
});

test('renderDashboardMarkdown escapes summary + brand for the markdown line', () => {
  const md = renderDashboardMarkdown({
    kind: 'dashboard',
    html: '<div>ok</div>',
    summary: 'evil & <script>',
    brand: '"><img>',
  });
  // The header lives OUTSIDE the fence, so it's markdown — HTML
  // entities are the right escape level here (marked will render them
  // literally, DOMPurify will pass them through).
  assert.ok(!md.includes('<script>'), 'summary must not leak raw <script>');
  assert.ok(!md.includes('"><img>'), 'brand must not leak raw tag');
  assert.match(md, /evil &amp; &lt;script&gt;/);
});

test('renderDashboardMarkdown omits brand line when bundle.brand is absent', () => {
  const md = renderDashboardMarkdown({
    kind: 'dashboard',
    html: '<div>ok</div>',
    summary: 'Week in review',
  });
  assert.match(md, /\*\*Week in review\*\*/);
  assert.ok(!md.includes('_('), 'no brand meta line when brand missing');
});

test('extractArtifacts routes kind="dashboard" to the fenced-html branch', () => {
  const bundle = {
    kind: 'dashboard',
    html: '<!doctype html><html><body><h1>Dashboard</h1></body></html>',
    summary: '7-day snapshot',
    brand: 'brightco',
  };
  const stdout = `preamble\n${wrap(JSON.stringify(bundle))}\nepilogue`;
  const { bundles, cleanText } = extractArtifacts(stdout);

  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].kind, 'dashboard');
  // Dashboards use the fenced-HTML path, NOT the gallery grid.
  assert.ok(!cleanText.includes('merlin-gallery'), 'dashboards must not use the gallery wrapper');
  assert.match(cleanText, /```html\n[\s\S]*<h1>Dashboard<\/h1>[\s\S]*\n```/);
  assert.ok(cleanText.startsWith('preamble'));
  assert.ok(cleanText.trim().endsWith('epilogue'));
  // Sentinels stripped.
  assert.ok(!cleanText.includes(SENTINEL_OPEN));
  assert.ok(!cleanText.includes(SENTINEL_CLOSE));
});

test('extractArtifacts handles mixed dashboard + gallery bundles in one stdout', () => {
  const dash = {
    kind: 'dashboard',
    html: '<div class="kpi">ok</div>',
    summary: 'Snapshot',
  };
  const gallery = {
    kind: 'image',
    items: [{ path: 'a.png', kind: 'image', label: 'A' }],
  };
  const stdout = [
    'top',
    wrap(JSON.stringify(dash)),
    'middle',
    wrap(JSON.stringify(gallery)),
    'bottom',
  ].join('\n');

  const { bundles, cleanText } = extractArtifacts(stdout);
  assert.equal(bundles.length, 2);
  assert.equal(bundles[0].kind, 'dashboard');
  assert.equal(bundles[1].kind, 'image');
  // Both render paths present: fenced html + gallery div.
  assert.match(cleanText, /```html/);
  assert.match(cleanText, /<div class="merlin-gallery"/);
});

test('extractArtifacts treats a dashboard bundle without html as a no-op (still recorded)', () => {
  const stdout = wrap(JSON.stringify({ kind: 'dashboard', summary: 'empty' }));
  const { bundles, cleanText } = extractArtifacts(stdout);
  // Bundle is still parsed so downstream observability / chat-event code
  // can see a dashboard ran — but no fenced block is emitted.
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].kind, 'dashboard');
  assert.ok(!cleanText.includes('```html'), 'no fenced block without html');
});
