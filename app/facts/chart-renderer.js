// chart-renderer.js — mounts inline SVG charts from pass-2 payloads.
//
// Pass 2 of the fact-binding pipeline (verify-facts.js) converts a
// `<div data-chart-config=...>` placeholder into:
//   <div class="merlin-chart" data-chart-payload="...encoded JSON..."></div>
//
// This module scans a DOM subtree for those placeholders, decodes the
// payload, and swaps in a lightweight SVG chart. We ship NO external
// dependency (Chart.js would add ~200KB to the installer); an SVG bar/line
// renderer covers every kind the dashboard emits today.
//
// Each rendered datapoint keeps its `<title data-fact="<id>">` annotation so
// the send-boundary verifier (Phase 9) can still trace the number.

'use strict';

const CHART_SELECTOR = 'div.merlin-chart[data-chart-payload]';

// Safe attribute-entity decoder — matches the encoder in verify-facts.js.
function decodeAttr(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function parsePayload(el) {
  const raw = el.getAttribute('data-chart-payload') || '';
  try { return JSON.parse(decodeAttr(raw)); }
  catch (e) { return null; }
}

/**
 * Mount charts inside the given root. `root` can be any Element (typically a
 * freshly-updated message bubble) or document. No-op when no matching
 * elements are present. Idempotent — re-entry on the same subtree simply
 * re-renders with the same payload.
 */
function mountCharts(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  const nodes = root.querySelectorAll(CHART_SELECTOR);
  let mounted = 0;
  for (const el of nodes) {
    const payload = parsePayload(el);
    if (!payload || !Array.isArray(payload.data) || payload.data.length === 0) {
      el.innerHTML = renderFallbackHTML(payload);
      continue;
    }
    const kind = (payload.kind || 'bar').toLowerCase();
    let svg;
    switch (kind) {
      case 'line': svg = renderLine(payload); break;
      case 'donut':
      case 'pie':  svg = renderDonut(payload); break;
      case 'bar':
      default:     svg = renderBar(payload); break;
    }
    el.innerHTML = svg;
    mounted++;
  }
  return mounted;
}

// ── Renderers ─────────────────────────────────────────────────────────────

const W = 560, H = 220, PAD_L = 48, PAD_R = 16, PAD_T = 24, PAD_B = 36;

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function escapeXML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function renderBar(p) {
  const data = p.data;
  const n = data.length;
  const vals = data.map((d) => toNumber(d.value));
  const maxV = Math.max(1, ...vals);
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const barW = innerW / n * 0.72;
  const gap = innerW / n * 0.28;
  const bars = data.map((d, i) => {
    const v = toNumber(d.value);
    const h = (v / maxV) * innerH;
    const x = PAD_L + i * (barW + gap) + gap / 2;
    const y = PAD_T + (innerH - h);
    const id = escapeXML(d.id || '');
    const lbl = escapeXML(d.label || '');
    const disp = escapeXML(d.display != null ? d.display : String(v));
    return (
      `<g><rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" ` +
      `fill="#7aa4ff" data-fact="${id}"><title>${lbl}: ${disp}</title></rect>` +
      `<text x="${(x + barW / 2).toFixed(2)}" y="${(H - PAD_B + 14).toFixed(2)}" text-anchor="middle" font-size="11" fill="#cbd5e1">${lbl}</text></g>`
    );
  }).join('');
  return svgFrame(p, bars);
}

function renderLine(p) {
  const data = p.data;
  const n = data.length;
  const vals = data.map((d) => toNumber(d.value));
  const maxV = Math.max(1, ...vals);
  const minV = Math.min(0, ...vals);
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const step = n > 1 ? innerW / (n - 1) : 0;
  const pts = data.map((d, i) => {
    const v = toNumber(d.value);
    const x = PAD_L + i * step;
    const y = PAD_T + innerH - ((v - minV) / (maxV - minV || 1)) * innerH;
    return [x, y, d];
  });
  const path = pts.map(([x, y], i) => (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2)).join(' ');
  const dots = pts.map(([x, y, d]) => (
    `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3" fill="#7aa4ff" data-fact="${escapeXML(d.id || '')}">` +
    `<title>${escapeXML(d.label || '')}: ${escapeXML(d.display != null ? d.display : String(toNumber(d.value)))}</title></circle>`
  )).join('');
  const labels = pts.map(([x, , d]) => (
    `<text x="${x.toFixed(2)}" y="${(H - PAD_B + 14).toFixed(2)}" text-anchor="middle" font-size="11" fill="#cbd5e1">${escapeXML(d.label || '')}</text>`
  )).join('');
  return svgFrame(p, `<path d="${path}" fill="none" stroke="#7aa4ff" stroke-width="2"/>${dots}${labels}`);
}

function renderDonut(p) {
  const data = p.data;
  const vals = data.map((d) => toNumber(d.value));
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const cx = W / 2, cy = H / 2, r = 80, ir = 46;
  let angle = -Math.PI / 2;
  const palette = ['#7aa4ff', '#8de5a1', '#ffb38a', '#d9a8ff', '#ffd966', '#ff8fa3'];
  const arcs = data.map((d, i) => {
    const v = toNumber(d.value);
    const slice = (v / total) * Math.PI * 2;
    const a2 = angle + slice;
    const large = slice > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const x3 = cx + ir * Math.cos(a2), y3 = cy + ir * Math.sin(a2);
    const x4 = cx + ir * Math.cos(angle), y4 = cy + ir * Math.sin(angle);
    const path = `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} L${x3.toFixed(2)},${y3.toFixed(2)} A${ir},${ir} 0 ${large} 0 ${x4.toFixed(2)},${y4.toFixed(2)} Z`;
    angle = a2;
    return (
      `<path d="${path}" fill="${palette[i % palette.length]}" data-fact="${escapeXML(d.id || '')}">` +
      `<title>${escapeXML(d.label || '')}: ${escapeXML(d.display != null ? d.display : String(v))}</title></path>`
    );
  }).join('');
  return svgFrame(p, arcs);
}

function svgFrame(p, inner) {
  const title = escapeXML(p.title || '');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" aria-label="${title}">` +
    (title ? `<text x="${PAD_L}" y="16" font-size="13" fill="#e2e8f0">${title}</text>` : '') +
    inner +
    '</svg>'
  );
}

function renderFallbackHTML(payload) {
  // Must escape: `payload.title` originates from Claude's chart config JSON
  // and lands in innerHTML. The happy path runs through svgFrame which
  // calls escapeXML; the empty-data fallback used to interpolate the raw
  // string. A chart config with empty `data` plus a title like
  // `<img src onerror=alert(1)>` would fire the XSS here. Same escape
  // function the SVG path uses — keeps the two rendering code paths in
  // lockstep on untrusted-input hygiene.
  const title = escapeXML((payload && payload.title) || 'Chart');
  return `<p><em>${title}</em> — no data available.</p>`;
}

module.exports = { mountCharts, CHART_SELECTOR };
