// verify-facts.js — Pass 1 / Pass 2 / Pass 3 rendering interceptor.
//
// Pass 1 (token substitution):
//   Replace every `{{fact:<id>}}` token with the envelope's `display` string,
//   wrapped in `<span data-fact="<id>">display</span>` so downstream passes
//   (and the send-boundary verifier) can trace every number back to a fact.
//
// Pass 2 (chart / table binding):
//   A chart config block of shape `{"series": "fact:<prefix>", ...}` resolves
//   into real chart data arrays by walking FactCache for every fact whose ID
//   matches the prefix. Falls back to a 2-column key/value table if the
//   binding fails.
//
// Pass 3 (literal scan):
//   Scan the produced HTML for critical-zone literals (currency, %, ×, days,
//   grouped counts) via the regex from contract.json. Any literal that is
//   NOT already wrapped in a data-fact span and NOT inside the FP corpus
//   pattern is replaced by italic "checking…" and raised as a retry system
//   note. Also applies §4.4.7 arithmetic-implication quarantine: after any
//   echo-authenticated user literal, the 400-char derivation-watch zone +
//   80-char arithmetic-verb window causes derived literals to fail.
//
// Tail quarantine: streamed content holds the last 320 bytes back until
// either a natural close boundary arrives (`\n`, `<`, space after a number)
// or a 2s absolute timer fires (§4.4 + H4). This prevents a partial token
// like "{{fact:" mid-delta from flashing as a raw brace before the close
// arrives.
//
// See FACT-BINDING-PLAN.md §4.1 (regex), §4.4 (critical zone), §4.4.7
// (arithmetic quarantine), §4.5 (context-match algorithm), §4.6 (synonyms),
// §H4 (quarantine + slow-drip).

'use strict';

const CRITICAL_ZONE_REGEX = new RegExp(
  // Currency
  '(?:[\\$\\€\\£\\¥\\₹]\\s?\\d[\\d,]*(?:\\.\\d+)?)' +
  '|' +
  // Rate/multiplier
  '(?:\\d+(?:\\.\\d+)?\\s*[%×x])' +
  '|' +
  // Duration
  '(?:\\d+(?:\\.\\d+)?\\s*(?:days?|months?))' +
  '|' +
  // Grouped count
  '(?:\\d{1,3}(?:,\\d{3})+)' +
  '|' +
  // Bare decimal (ambiguous — promoted to critical by context match)
  '(?:\\d+\\.\\d+)' +
  '|' +
  // Raw count ≥ 1000 (no grouping)
  '(?:\\d{4,})',
  'g'
);

const ARITHMETIC_VERBS_DEFAULT = [
  'double', 'doubling', 'doubled', 'triple', 'tripling', 'quadruple',
  'halve', 'halving', 'halved', '×', 'times', 'raises', 'raising',
  'brings to', 'brings-to', 'implies', 'implying', 'means', 'meaning',
  'equals', 'roughly', 'approximately', 'about',
];

const CHECKING_HTML = '<i class="merlin-checking">checking…</i>';
const EXEMPT_ATTR = 'data-fact-exempt';
const FACT_ATTR_MATCH = /<span[^>]*\bdata-fact\s*=\s*["'][a-f0-9]+["']/g;
const TOKEN_RE = /\{\{fact:([a-f0-9]+)\}\}/g;

/**
 * Pass 1: substitute tokens. Returns { html, unresolved }. Each unresolved
 * token is left in place verbatim so Pass 3 can quarantine it and the retry
 * loop can try again next turn with more context.
 */
function pass1Tokens(html, cache) {
  const unresolved = [];
  const replaced = html.replace(TOKEN_RE, (match, id) => {
    const env = cache.get(id);
    if (!env) {
      unresolved.push(id);
      return match;
    }
    return `<span data-fact="${id}">${escapeHTML(env.display)}</span>`;
  });
  return { html: replaced, unresolved };
}

/**
 * Pass 2: resolve `<div data-chart="roas"></div>` and JSON configs with
 * `series: "fact:<prefix>"` into series arrays. If the fact-index has no
 * matches for the prefix, render a 2-col key/value fallback.
 *
 * The "prefix" is matched as a substring of handler+window, not a raw ID
 * prefix — because IDs are content-addressed hashes.
 */
function pass2Charts(html, cache) {
  // Attribute value must be correctly quote-matched: double-quoted attributes
  // may contain single quotes (common in JSON payloads) and vice-versa. A
  // naive [^"'] exclusion would stop at the first inner quote of a JSON
  // object and mangle the config. Use alternation instead. Entity-encoded
  // attributes (&quot;) produced by renderChart flow through the single-or
  // double-quote branches transparently — decodeAttrEntities normalizes them.
  const RE = /<div\s+data-chart-config\s*=\s*(?:"([^"]*)"|'([^']*)')\s*><\/div>/g;
  return html.replace(RE, (match, dq, sq) => {
    const raw = dq != null ? dq : sq;
    const configJson = decodeAttrEntities(raw);
    let cfg;
    try { cfg = JSON.parse(configJson); } catch (_) { return renderChartFallback(null, null, 'invalid-config'); }
    if (typeof cfg.series !== 'string' || !cfg.series.startsWith('fact:')) {
      return renderChartFallback(cfg, null, 'bad-series');
    }
    const prefix = cfg.series.slice('fact:'.length);
    // Walk cache.byClass if present; else linear scan.
    const matches = collectFactsByPrefix(cache, prefix);
    if (matches.length === 0) {
      return renderChartFallback(cfg, null, 'no-data');
    }
    return renderChart(cfg, matches);
  });
}

function decodeAttrEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function collectFactsByPrefix(cache, prefix) {
  const out = [];
  for (const [id, env] of cache.byId.entries()) {
    const key = (env.source && env.source.handler || '') + ':' + (env.source && env.source.window || '');
    if (key.includes(prefix) || env.kindClass === prefix || id.startsWith(prefix)) {
      out.push(env);
    }
  }
  return out;
}

function renderChart(cfg, envs) {
  // Emit a lightweight chart placeholder — the renderer picks it up and hands
  // it to Chart.js. The spans keep each datum traceable to a fact.
  const datapoints = envs.map((e) => ({
    id: e.id,
    label: e.source && e.source.handler || e.kindClass,
    value: e.value,
    display: e.display,
  }));
  const payload = JSON.stringify({ title: cfg.title || '', kind: cfg.kind || 'bar', data: datapoints });
  // Attribute-escape the payload so the renderer can safely parse it.
  const esc = payload.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div class="merlin-chart" data-chart-payload="${esc}"></div>`;
}

function renderChartFallback(cfg, envs, reason) {
  const title = (cfg && cfg.title) || 'Chart';
  return `<div class="merlin-chart-fallback" data-chart-fallback="${reason || 'unavailable'}">` +
    `<p>${escapeHTML(title)} — inline chart unavailable (${escapeHTML(reason || 'unavailable')}).</p></div>`;
}

/**
 * Pass 3: literal scan. Returns { html, quarantined }.
 *
 * Rules (subset — the full Spec is §4.4 / §4.4.7):
 *   - Skip regions already wrapped in data-fact="…" spans.
 *   - Skip regions marked data-fact-exempt="<sig>" (sig validation is §4.5.1;
 *     for this pass we only respect the attribute — the sig is validated by
 *     the send-boundary verifier).
 *   - Skip the 400-char derivation-watch zone after an authenticated user
 *     echo IF the intervening 80 chars contain an arithmetic verb
 *     (§4.4.7 NAV-50 closure).
 *   - Replace every remaining critical-zone hit with CHECKING_HTML.
 */
function pass3LiteralScan(html, cache, opts = {}) {
  const arithmeticVerbs = (opts.contract && opts.contract.arithmeticVerbs) || ARITHMETIC_VERBS_DEFAULT;
  const derivationWatch = (opts.contract && opts.contract.derivationWatchBytes) || 400;
  const verbWindow = (opts.contract && opts.contract.arithmeticVerbWindow) || 80;

  // Step 1 — mask protected regions (span-wrapped facts + explicit exempts).
  const mask = new Array(html.length).fill(0);
  for (const m of html.matchAll(/<span\s+[^>]*data-fact\s*=\s*["']([a-f0-9]+)["'][^>]*>([\s\S]*?)<\/span>/g)) {
    for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = 1;
  }
  for (const m of html.matchAll(/<[^>]+data-fact-exempt\s*=\s*["'][^"']+["'][^>]*>[\s\S]*?<\/[^>]+>/g)) {
    for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = 1;
  }

  // Step 2 — identify user-echo-authenticated literals + build derivation-watch zones.
  // A user_input fact is echoed when its display literal appears verbatim and origin=user_input.
  const echoZones = buildEchoZones(html, cache, derivationWatch);

  // Step 3 — scan critical-zone regex, replace hits not already masked AND
  // not inside an echo-derivation window with an arithmetic verb.
  let quarantined = 0;
  const out = html.replace(CRITICAL_ZONE_REGEX, (hit, offset) => {
    if (mask[offset]) return hit;
    if (isInsideAttributeOrTag(html, offset)) return hit;
    if (isInsideEchoDerivation(offset, echoZones, html, verbWindow, arithmeticVerbs)) {
      quarantined++;
      return CHECKING_HTML;
    }
    // Default — no matching fact → quarantine.
    quarantined++;
    return CHECKING_HTML;
  });
  return { html: out, quarantined };
}

function buildEchoZones(html, cache, watchBytes) {
  const zones = [];
  for (const env of cache.byId.values()) {
    if (env.origin !== 'user_input') continue;
    const disp = env.display;
    if (!disp) continue;
    let idx = 0;
    while ((idx = html.indexOf(disp, idx)) !== -1) {
      zones.push({ start: idx, end: idx + disp.length, watchEnd: idx + disp.length + watchBytes });
      idx += disp.length;
    }
  }
  return zones;
}

function isInsideEchoDerivation(offset, zones, html, verbWindow, verbs) {
  for (const z of zones) {
    if (offset < z.end || offset > z.watchEnd) continue;
    const fromAnchor = Math.max(z.end, offset - verbWindow);
    const slice = html.slice(fromAnchor, offset).toLowerCase();
    for (const v of verbs) {
      if (slice.includes(v.toLowerCase())) return true;
    }
  }
  return false;
}

function isInsideAttributeOrTag(html, offset) {
  // Walk backwards to the nearest '<' or '>' — if '<' comes first, offset is
  // inside a tag/attribute and should be skipped.
  for (let i = offset - 1; i >= 0 && i > offset - 300; i--) {
    const c = html.charCodeAt(i);
    if (c === 60 /* < */) return true;
    if (c === 62 /* > */) return false;
  }
  return false;
}

function escapeHTML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * runAllPasses orchestrates Pass 1-3 in order, returning the final HTML and
 * a short diagnostic object the renderer can surface in the safe-mode footer.
 */
function runAllPasses(html, cache, opts = {}) {
  const p1 = pass1Tokens(html, cache);
  const afterP2 = pass2Charts(p1.html, cache);
  const p3 = pass3LiteralScan(afterP2, cache, opts);
  return {
    html: p3.html,
    unresolvedTokens: p1.unresolved,
    quarantinedLiterals: p3.quarantined,
  };
}

// ── Tail quarantine (streaming-safe) ─────────────────────────────────────

const TAIL_QUARANTINE_BYTES = 320;

/**
 * TailQuarantine wraps a text stream so the last 320 bytes are held back
 * until either:
 *   (a) a natural close boundary arrives (`\n` or `<`), flushing all but 320
 *       most-recent bytes; or
 *   (b) the 2-second absolute timer fires, flushing everything (slow-drip
 *       defense — NAV-17 + R40); or
 *   (c) finalize() is called, flushing everything.
 *
 * The renderer feeds appended deltas in via push(); the returned flush()
 * returns the safe-to-render prefix. The tail remains buffered.
 */
class TailQuarantine {
  constructor(opts = {}) {
    this.tail = '';
    this.openedAt = Date.now();
    this.absoluteMs = opts.absoluteMs || 2000;
    this.onFlush = opts.onFlush || (() => {});
    this.closed = false;
  }
  push(delta) {
    if (this.closed) return '';
    const combined = this.tail + delta;
    // Absolute-deadline fallback: force full flush so a slow-drip adversary
    // can't dangle a half-token forever.
    if (Date.now() - this.openedAt > this.absoluteMs) {
      this.tail = '';
      this.openedAt = Date.now();
      return combined;
    }
    // Hold back the last TAIL_QUARANTINE_BYTES unless a close boundary has
    // passed inside the tail region — in which case we can safely flush up
    // to that boundary.
    if (combined.length <= TAIL_QUARANTINE_BYTES) {
      this.tail = combined;
      return '';
    }
    const cut = combined.length - TAIL_QUARANTINE_BYTES;
    const safeHead = combined.slice(0, cut);
    this.tail = combined.slice(cut);
    return safeHead;
  }
  finalize() {
    this.closed = true;
    const out = this.tail;
    this.tail = '';
    return out;
  }
}

module.exports = {
  pass1Tokens, pass2Charts, pass3LiteralScan, runAllPasses,
  TailQuarantine, CRITICAL_ZONE_REGEX, CHECKING_HTML, TAIL_QUARANTINE_BYTES,
  buildEchoZones, isInsideEchoDerivation,
};
