// Merlin artifact parser.
//
// The Go binary emits a sentinel-wrapped JSON bundle at the end of every
// generation pipeline (image, video, voice, blog) describing exactly which
// files were produced and any per-item QA metadata. The parser:
//
//   1. Extracts the sentinel block from the binary's stdout.
//   2. Returns the parsed bundle so the renderer can draw an enterprise-
//      grade gallery card in the chat.
//   3. Returns the stdout with the sentinel block REPLACED by a markdown
//      gallery — this is what Claude sees in its tool result. Markdown is
//      the most reliable instruction for "include these previews in your
//      reply" because Claude already echoes markdown verbatim. The
//      renderer's existing image/video regex (renderer.js:947) turns each
//      markdown image into a `merlin://`-prefixed `<img>` automatically.
//
// REGRESSION GUARD (2026-04-19, inline-artifact-render incident):
// Before this parser, generated artifacts surfaced as raw "Image: D:/..."
// stdout lines that Claude paraphrased into prose ("All 5 done. Want to
// push them?"), forcing the user to ask "can you render them here?" on
// every run. The contract is: binary emits the sentinel, parser strips it,
// markdown gallery + structured `artifacts` payload reach the chat. Do
// not bypass either layer — the markdown is for Claude's prose echo, the
// structured payload is for the renderer's gallery card. Both together.

'use strict';

const SENTINEL_OPEN = '<<<MERLIN_ARTIFACTS:v1';
const SENTINEL_CLOSE = 'MERLIN_ARTIFACTS>>>';

// Match the sentinel block including any whitespace around it. The JSON
// payload may be pretty-printed or compact — we only require the open/close
// markers to be on their own lines, which the Go emitter guarantees.
const SENTINEL_RE = new RegExp(
  '\\n*' +
    escapeForRegex(SENTINEL_OPEN) +
    '\\s*\\n([\\s\\S]*?)\\n\\s*' +
    escapeForRegex(SENTINEL_CLOSE) +
    '\\s*\\n*',
  'g'
);

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a `merlin://` URL from a file path. Encodes each path segment so
// filenames with spaces, parentheses, or non-ASCII characters survive the
// trip through HTML attributes. Mirrors renderer.js:merlinUrl — kept in
// sync manually because mcp-tools runs in main, not renderer.
//
// Idempotent: input `results/img/foo%20bar.png` MUST round-trip to
// `merlin://results/img/foo%20bar.png`, not `%2520bar`. Reached by
// decoding each segment first (collapsing prior encoding), then
// re-encoding canonically. A stray `%` (e.g. `5%off.png`) makes
// decodeURIComponent throw — fall back to direct encode in that case so
// real filenames with literal percent signs still produce a valid URL.
function toMerlinUrl(rawPath) {
  if (!rawPath) return '';
  const normalized = String(rawPath).replace(/\\/g, '/').replace(/^merlin:\/\//, '');
  return 'merlin://' + normalized.split('/').map((seg) => {
    try {
      return encodeURIComponent(decodeURIComponent(seg));
    } catch {
      return encodeURIComponent(seg);
    }
  }).join('/');
}

// Escape a string for safe use as HTML attribute or text content. The
// gallery HTML is later passed through DOMPurify, but we still escape at
// emission so a label containing `"` can't break out of an attribute even
// before sanitization.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render a single artifact as an HTML `<figure>`. The renderer's marked +
// DOMPurify pipeline preserves figure/figcaption/img/video/audio/div by
// default (video/audio attrs are added via ADD_ATTR in renderer.js). The
// `merlin:` URI scheme is whitelisted by ALLOWED_URI_REGEXP.
function renderItemHtml(item) {
  const url = toMerlinUrl(item.path);
  const label = item.label || (item.path ? item.path.split('/').pop() : '');
  const safeLabel = escapeHtml(label);
  const safeUrl = escapeHtml(url);
  const qaBadge = item.qa && item.qa.pass === false
    ? `<span class="merlin-artifact-qa" title="${escapeHtml(item.qa.reason || 'QA flagged')}">QA</span>`
    : '';
  let body;
  switch (item.kind) {
    case 'video':
      body = `<video src="${safeUrl}" controls playsinline preload="metadata"></video>`;
      break;
    case 'audio':
      body = `<audio src="${safeUrl}" controls preload="metadata"></audio>`;
      break;
    case 'image':
    default:
      // REGRESSION GUARD (2026-05-03, chat-gallery-partial-render v2):
      // decoding="async" pushes bitmap decode off the main thread, so
      // a slow CDN response can't block the chat thread or paint a
      // partial frame in the visible card. The renderer's gallery
      // hook attaches an onload listener that flips
      // data-loaded="true"; CSS in .merlin-artifact img keeps IMG
      // opacity:0 + shows a shimmer ::before until that flag flips.
      // Together: no half-rendered images in chat.
      body = `<img src="${safeUrl}" alt="${safeLabel}" loading="lazy" decoding="async">`;
      break;
  }
  return `<figure class="merlin-artifact merlin-artifact-${escapeHtml(item.kind || 'image')}">${body}<figcaption>${safeLabel}${qaBadge}</figcaption></figure>`;
}

// Build the gallery HTML block that replaces the sentinel in stdout.
// The header names kind + count + model so Claude has clear context for
// its prose summary; the grid itself is a single self-contained HTML
// block so Claude can echo it verbatim into its reply. The renderer
// styles `.merlin-gallery` as a responsive grid (style.css).
//
// We emit HTML rather than markdown because (a) `<video>`/`<audio>` have
// no native markdown form, (b) wrapping items in a `<div>` grid is
// impossible in pure markdown, and (c) the renderer pipeline (marked +
// DOMPurify) preserves the structure intact. If Claude paraphrases the
// gallery away the bundles[] payload still reaches the renderer for a
// fallback render path (see renderer.js).
function renderGalleryMarkdown(bundle) {
  if (!bundle || !Array.isArray(bundle.items) || bundle.items.length === 0) {
    return '';
  }
  const kindNoun = bundle.kind === 'video' ? 'video' : bundle.kind === 'audio' ? 'audio clip' : 'image';
  const count = bundle.items.length;
  const headline = bundle.summary
    || `${count} ${kindNoun}${count === 1 ? '' : 's'} generated`;
  const metaParts = [];
  if (bundle.model) metaParts.push(bundle.model);
  if (bundle.brand) metaParts.push(bundle.brand);
  if (bundle.product) metaParts.push(bundle.product);
  const metaLine = metaParts.length
    ? `<div class="merlin-gallery-meta">${escapeHtml(metaParts.join(' · '))}</div>`
    : '';
  const items = bundle.items.map(renderItemHtml).join('');
  // Surrounding blank lines force marked to treat the block as raw HTML
  // and not wrap it in <p> tags or attempt to parse markdown inside.
  return [
    '',
    `<div class="merlin-gallery" data-kind="${escapeHtml(bundle.kind || 'image')}" data-count="${count}">`,
    `<div class="merlin-gallery-header"><div class="merlin-gallery-title">${escapeHtml(headline)}</div>${metaLine}</div>`,
    `<div class="merlin-gallery-grid">${items}</div>`,
    `</div>`,
    '',
  ].join('\n');
}

// Render a dashboard bundle as a ```html fenced markdown block.
//
// The Go binary pre-renders a complete, standalone HTML document (inline
// CSS + inline SVG, zero scripts). We wrap it in a triple-backtick-html
// fence so the existing HTML-artifact path in renderer.js (search for
// /```html\n/ — it extracts fenced blocks BEFORE marked parses them and
// injects them into a sandboxed iframe with sandbox="allow-scripts" and
// CSP default-src 'none'; connect-src 'none') picks it up verbatim.
//
// This is the cheapest possible integration: zero renderer.js changes,
// full reuse of the audited iframe sandbox. Trade-off: summary line lives
// above the fence rather than inside it, but that's upside — Claude's
// prose echo benefits from the summary being plainly visible in markdown.
function renderDashboardMarkdown(bundle) {
  if (!bundle || typeof bundle.html !== 'string' || bundle.html.trim() === '') {
    return '';
  }
  // Defensive: if Go ever emits "```" inside the HTML (shouldn't — our
  // renderer never produces backticks), we'd break out of the fence and
  // expose raw HTML that bypasses the iframe sandbox. Replace any stray
  // triple-backtick sequence. No legitimate dashboard HTML contains three
  // consecutive backticks, so this is lossless in practice.
  const safeHtml = bundle.html.replace(/```/g, '` ``');
  const summary = bundle.summary || 'Merlin dashboard';
  const metaParts = [];
  if (bundle.brand) metaParts.push(bundle.brand);
  const metaLine = metaParts.length
    ? ` _(${metaParts.map(escapeHtml).join(' · ')})_`
    : '';
  return [
    '',
    `**${escapeHtml(summary)}**${metaLine}`,
    '',
    '```html',
    safeHtml,
    '```',
    '',
  ].join('\n');
}

// Extract one or more sentinel bundles from raw stdout. Multiple bundles
// can occur in chained pipelines (e.g. an image pipeline that also clones
// a voice). Returns { bundles: [], cleanText: string, galleryMarkdown: string }.
//
// `cleanText` has every sentinel block replaced with the corresponding
// gallery OR dashboard markdown so Claude sees a single coherent stream.
// The separate `galleryMarkdown` is provided for callers that want to
// render artifacts independently (e.g. push as a structured chat event
// before the rest of the prose renders). Its name is historical — it now
// also carries dashboard fences.
function extractArtifacts(stdout) {
  if (!stdout || typeof stdout !== 'string') {
    return { bundles: [], cleanText: stdout || '', galleryMarkdown: '' };
  }
  const bundles = [];
  const galleryParts = [];
  let cleanText = stdout.replace(SENTINEL_RE, (_, jsonBlob) => {
    let bundle;
    try {
      bundle = JSON.parse(jsonBlob);
    } catch (e) {
      // Malformed sentinel — leave the original block in stdout so the
      // user at least sees the file paths in raw form, and skip the
      // render for this block. We don't want a parse failure to make
      // the entire chat response disappear.
      return jsonBlob;
    }
    bundles.push(bundle);
    const md = bundle.kind === 'dashboard'
      ? renderDashboardMarkdown(bundle)
      : renderGalleryMarkdown(bundle);
    if (md) galleryParts.push(md);
    return '\n' + md + '\n';
  });
  return { bundles, cleanText, galleryMarkdown: galleryParts.join('\n') };
}

module.exports = {
  SENTINEL_OPEN,
  SENTINEL_CLOSE,
  extractArtifacts,
  renderGalleryMarkdown,
  renderDashboardMarkdown,
  toMerlinUrl,
};
