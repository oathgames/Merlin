// Merlin — brand scraper
//
// Captures brand signal from a live URL using a hidden Electron BrowserWindow
// (zero external dependency — Electron's Chromium IS the scraper). Returns a
// structured BrandSignal JSON object consumed by the brand-guide synthesis
// prompt in .claude/commands/merlin-brand-guide.md.
//
// Quality bar: the synthesis prompt is only as good as this file's output.
// Garbage in → AI slop out. See the comment on collectSignalScript below for
// the weighting rules that separate brand colors from framework defaults.
//
// Public API:
//   scrapeBrand(url, { timeoutMs, extraPages }) → Promise<BrandSignal>
//
// Design notes:
// - Hidden BrowserWindow; show:false means the window is never visible.
// - webSecurity:true, nodeIntegration:false, contextIsolation:true —
//   the scrape script runs in an isolated page context with no Node access.
// - Screenshots captured via webContents.capturePage() in desktop + mobile
//   viewports; we resize between captures so the page re-flows.
// - Logo color quantization runs in the renderer (Canvas API) — no native deps.

'use strict';

let _BrowserWindow;
try {
  // Electron isn't loaded when running the unit tests under plain node,
  // so we defer the require to avoid a hard failure at import time. The
  // runtime scraper call path still requires Electron — only the pure
  // helpers (validateScrapeURL, normalizeUrl, joinUrl) are test-reachable.
  ({ BrowserWindow: _BrowserWindow } = require('electron'));
} catch (_) {
  _BrowserWindow = null;
}
const BrowserWindow = _BrowserWindow;
const path = require('path');

// REGRESSION GUARD (2026-04-19): every scrape entrypoint must fail closed
// before Electron loads the URL. The attack surface is wide:
//   * file:// schemes hand the scraper the local filesystem — the same
//     BrowserWindow that runs `collectSignalScript` can then exfiltrate
//     a user's document tree via the returned signal payload.
//   * data: URLs can inject a crafted HTML document that sits inside the
//     Electron renderer context, bypassing the site isolation we rely on.
//   * Private IP ranges (RFC1918, loopback, link-local) pivot the scraper
//     into an internal-network probe — SSRF vintage 2019 still pays out.
//   * Cloud metadata endpoints (169.254.169.254 AWS IMDS, 100.100.100.200
//     Alibaba, etc.) leak credentials if the app ever runs in a hosted
//     CI/runner. 169.254.0.0/16 is covered by the link-local check.
//   * IPv6 loopback (::1) and fe80::/10 link-local cover the same classes
//     as the IPv4 rules and are common omissions.
// The validator is deliberately conservative: only http(s), only public
// IPs, only a hostname that parses cleanly. Any doubt → reject. A false
// positive on a scrape is a friendly error; a false negative is a pivot.
// Do NOT relax the rules. If a legitimate private endpoint ever needs to
// be scraped, build an OPT-IN allowlist keyed on the brand config — do
// not widen this validator.
function validateScrapeURL(input) {
  if (!input || typeof input !== 'string') {
    return { ok: false, error: 'URL must be a non-empty string' };
  }
  let u;
  try {
    u = new URL(input);
  } catch (_) {
    return { ok: false, error: `Could not parse URL: ${input}` };
  }
  const scheme = (u.protocol || '').toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    return { ok: false, error: `Only http(s) URLs are allowed; got ${scheme || '(none)'}` };
  }
  const host = (u.hostname || '').toLowerCase();
  if (!host) {
    return { ok: false, error: 'URL is missing a hostname' };
  }

  // Hostname-based blocks (covers DNS names that resolve to unsafe ranges
  // AND the literal strings users sometimes paste).
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, error: `Refusing to scrape localhost: ${host}` };
  }

  // IPv6 literal check — URL parsing wraps these in brackets, hostname
  // strips them. "::1" and fe80::/10 link-local addresses are flagged.
  if (host === '::1' || host === '[::1]') {
    return { ok: false, error: 'Refusing to scrape IPv6 loopback (::1)' };
  }
  if (host.startsWith('fe80:') || host.startsWith('[fe80:')) {
    return { ok: false, error: 'Refusing to scrape IPv6 link-local (fe80::/10)' };
  }

  // IPv4 literal parsing. Four dot-separated decimals in 0-255 each.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some(o => o < 0 || o > 255)) {
      return { ok: false, error: `Invalid IPv4 address: ${host}` };
    }
    const [a, b] = octets;
    // 0.0.0.0/8 — "this network"
    if (a === 0) return { ok: false, error: `Refusing to scrape 0.0.0.0/8: ${host}` };
    // 127.0.0.0/8 — loopback
    if (a === 127) return { ok: false, error: `Refusing to scrape loopback (127.0.0.0/8): ${host}` };
    // 10.0.0.0/8 — RFC1918 private
    if (a === 10) return { ok: false, error: `Refusing to scrape private 10.0.0.0/8: ${host}` };
    // 172.16.0.0/12 — RFC1918 private
    if (a === 172 && b >= 16 && b <= 31) {
      return { ok: false, error: `Refusing to scrape private 172.16.0.0/12: ${host}` };
    }
    // 192.168.0.0/16 — RFC1918 private
    if (a === 192 && b === 168) {
      return { ok: false, error: `Refusing to scrape private 192.168.0.0/16: ${host}` };
    }
    // 169.254.0.0/16 — link-local (covers AWS 169.254.169.254 metadata)
    if (a === 169 && b === 254) {
      return { ok: false, error: `Refusing to scrape link-local 169.254.0.0/16: ${host}` };
    }
  }

  return { ok: true, url: u.toString() };
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DEFAULT_TIMEOUT_MS = 30000;

// REGRESSION GUARD (2026-04-20): every long-lived path in scrapeBrand MUST
// be wrapped in a wall-clock timeout. A paying user on Forever21.com hit a
// permanent onboarding hang because quantizeLogoColors' injected fetch had
// no timeout — the logo CDN slow-dripped forever, executeJavaScript never
// resolved, scrapeBrand never returned, and the MCP tool call never sent
// a response back to Claude. The UI froze on "digging into the brand..."
// with no recovery path. The defence-in-depth layers added here:
//   1. DEFAULT_OVERALL_TIMEOUT_MS — hard cap on the whole scrape. Even if
//      every inner timeout misfires, the outer race destroys the window
//      and rejects with a TIMEOUT-classified error.
//   2. DEFAULT_EXECUTE_JS_TIMEOUT_MS — every executeJavaScript() call is
//      raced against this. Electron's executeJavaScript has no built-in
//      timeout; without this, any injected promise that never settles
//      deadlocks the host process.
//   3. DEFAULT_LOGO_FETCH_TIMEOUT_MS — per-logo AbortController embedded
//      in the injected script. 5s is enough for any reasonable CDN; more
//      than that means the site is broken and the scrape should proceed
//      without logo quantization rather than hanging.
// Never replace these with plain awaits. The test suite at
// brand-scraper.test.js pins each layer — if you "simplify" one, the
// tests fail loudly. If a future optimization removes the wrapper, a
// future user hits the same hang.
const DEFAULT_OVERALL_TIMEOUT_MS = 90000;      // whole scrape wall-clock
const DEFAULT_EXECUTE_JS_TIMEOUT_MS = 15000;   // per executeJavaScript call
const DEFAULT_LOGO_FETCH_TIMEOUT_MS = 5000;    // inner fetch() in quantizeLogoColors

// Pages to crawl after the landing page. Each is best-effort; failures are
// swallowed and the guide proceeds with whatever we got.
const DEFAULT_EXTRA_PAGES = ['/about', '/about-us', '/pages/about', '/products', '/collections/all'];

// Sentinel Error subclass so callers (mcp-tools brand_scrape handler) can
// distinguish timeout from a generic scrape failure and surface a TIMEOUT
// envelope that tells Claude to retry-or-split instead of INTERNAL_ERROR.
class ScrapeTimeoutError extends Error {
  constructor(message, { stage, elapsedMs } = {}) {
    super(message);
    this.name = 'ScrapeTimeoutError';
    this.code = 'TIMEOUT';
    this.stage = stage || 'unknown';
    this.elapsedMs = elapsedMs || null;
  }
}

// Race a promise against a timer. The returned promise:
//   - resolves with the inner promise's value if it settles first
//   - rejects with ScrapeTimeoutError if the timer fires first
// The timer is always cleared so we never leak a pending setTimeout.
// `onTimeout` is an optional side-effect (e.g. destroy the window) invoked
// synchronously when the timer fires — runs BEFORE the rejection so any
// cleanup visibly races against whatever pending I/O caused the stall.
function raceWithTimeout(promise, ms, stage, onTimeout) {
  let timer;
  const started = Date.now();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (typeof onTimeout === 'function') {
        try { onTimeout(); } catch (_) { /* best-effort cleanup */ }
      }
      reject(new ScrapeTimeoutError(
        `brand-scraper: ${stage} timed out after ${ms}ms`,
        { stage, elapsedMs: Date.now() - started },
      ));
    }, ms);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

// Wrapper around win.webContents.executeJavaScript that enforces a timeout.
// Electron's API returns a promise that can hang forever if the injected
// script awaits a never-resolving value (e.g. fetch() with no AbortController
// against a slow CDN). We race it; on timeout, we do NOT touch the window —
// the outer scrapeBrand() race is responsible for destroying the window so
// subsequent calls fail fast.
function executeJsWithTimeout(win, script, stage, timeoutMs) {
  const ms = timeoutMs || DEFAULT_EXECUTE_JS_TIMEOUT_MS;
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error(`brand-scraper: window destroyed before ${stage}`));
  }
  return raceWithTimeout(
    win.webContents.executeJavaScript(script, true),
    ms,
    `executeJavaScript:${stage}`,
  );
}

async function scrapeBrand(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const overallTimeoutMs = opts.overallTimeoutMs || DEFAULT_OVERALL_TIMEOUT_MS;
  const extraPages = opts.extraPages || DEFAULT_EXTRA_PAGES;

  const normalized = normalizeUrl(url);
  if (!normalized) {
    throw new Error(`brand-scraper: invalid URL "${url}"`);
  }

  // SSRF fence — fail closed before allocating the BrowserWindow.
  const guard = validateScrapeURL(normalized);
  if (!guard.ok) {
    throw new Error(`brand-scraper: ${guard.error}`);
  }

  const win = new BrowserWindow({
    show: false,
    width: DESKTOP_VIEWPORT.width,
    height: DESKTOP_VIEWPORT.height,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      sandbox: true,
      backgroundThrottling: false,
      offscreen: false,
    },
  });

  // Some Shopify/Cloudflare edges return a challenge page to default Electron
  // UAs. A recent Chrome UA sails through almost every time.
  win.webContents.setUserAgent(DEFAULT_UA);

  // Hard kill switch for the outer timeout. Destroying the window while a
  // capturePage or executeJavaScript is in flight causes Electron to reject
  // those pending promises — which unwinds any inner awaits even if the
  // per-call timeouts above have been bypassed by a pathological page.
  const killWindow = () => { if (!win.isDestroyed()) win.destroy(); };

  const body = (async () => {
    try {
      const primary = await capturePage(win, normalized, timeoutMs);

      // Best-effort secondary pages for richer copy/palette signal. Failures
      // don't block the guide — we just lose a bit of signal.
      const secondary = [];
      for (const subpath of extraPages) {
        if (win.isDestroyed()) break;
        const subUrl = joinUrl(normalized, subpath);
        if (!subUrl || subUrl === normalized) continue;
        try {
          const snap = await capturePage(win, subUrl, Math.min(timeoutMs, 15000), { screenshots: false });
          if (snap && snap.signal) secondary.push({ url: subUrl, signal: snap.signal });
        } catch (_) { /* ignore — best effort */ }
      }

      // Quantize dominant colors from the best logo candidate (if raster).
      // This is best-effort; failures never block the guide.
      const logoColors = await quantizeLogoColors(win, primary.signal.logoCandidates, normalized);

      return {
        url: normalized,
        capturedAt: new Date().toISOString(),
        primary: primary.signal,
        screenshots: primary.screenshots,       // { desktop: base64png, mobile: base64png }
        logoColors,                              // [{hex, freq}] from Canvas quantization
        secondaryPages: secondary,               // copy & palette from /about, /products, etc.
      };
    } finally {
      killWindow();
    }
  })();

  // Outer wall-clock race. If the body hangs past overallTimeoutMs, destroy
  // the window (unwinds pending Electron promises) and reject with TIMEOUT.
  return raceWithTimeout(body, overallTimeoutMs, 'overall', killWindow);
}

async function capturePage(win, url, timeoutMs, opts = {}) {
  const includeScreenshots = opts.screenshots !== false;

  // Belt-and-braces: capturePage is also reached from the secondary-page
  // loop with a joined URL. If a pathological base + subpath produced
  // something unsafe, we still refuse here.
  const guard = validateScrapeURL(url);
  if (!guard.ok) {
    throw new Error(`brand-scraper: ${guard.error}`);
  }

  await loadUrl(win, url, timeoutMs);

  // Let fonts + above-the-fold images settle; computed styles need the
  // stylesheet cascade resolved. 1.2s covers most sites.
  await delay(1200);

  const signal = await executeJsWithTimeout(win, collectSignalScript(), 'collectSignal');

  let screenshots = null;
  if (includeScreenshots) {
    screenshots = {};
    // Desktop capture at current viewport. capturePage has no documented
    // timeout but typically resolves synchronously — race it anyway so a
    // GPU hang can't deadlock the scrape.
    const desktop = await raceWithTimeout(
      win.webContents.capturePage(),
      DEFAULT_EXECUTE_JS_TIMEOUT_MS,
      'capturePage:desktop',
    );
    screenshots.desktop = desktop.toPNG().toString('base64');

    // Mobile viewport — resize triggers reflow; wait briefly before capture.
    win.setContentSize(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height);
    await executeJsWithTimeout(
      win,
      `window.innerWidth=${MOBILE_VIEWPORT.width};window.dispatchEvent(new Event('resize'));`,
      'resizeMobile',
    );
    await delay(600);
    const mobile = await raceWithTimeout(
      win.webContents.capturePage(),
      DEFAULT_EXECUTE_JS_TIMEOUT_MS,
      'capturePage:mobile',
    );
    screenshots.mobile = mobile.toPNG().toString('base64');

    // Restore desktop size for subsequent captures
    win.setContentSize(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
    await delay(200);
  }

  return { signal, screenshots };
}

function loadUrl(win, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      win.webContents.removeListener('did-finish-load', onLoad);
      win.webContents.removeListener('did-fail-load', onFail);
      if (err) reject(err); else resolve();
    };
    const onLoad = () => done(null);
    const onFail = (_e, code, desc, failedUrl) => {
      // ERR_ABORTED (-3) fires on navigation redirects before the final load
      // completes — ignore it; did-finish-load will still fire on the new URL.
      if (code === -3) return;
      done(new Error(`navigation failed: ${desc} (${code}) for ${failedUrl}`));
    };
    const timer = setTimeout(() => done(new Error(`navigation timeout after ${timeoutMs}ms for ${url}`)), timeoutMs);
    win.webContents.on('did-finish-load', onLoad);
    win.webContents.on('did-fail-load', onFail);
    win.loadURL(url).catch(done);
  });
}

// Script injected into the page context. Runs with zero privileges. Must be
// a pure function expression returning a serializable object.
//
// WEIGHTING RULES — the heart of the "brand vs framework color" disambiguation:
//   A color found on the primary <button> / first h1 / nav link counts for far
//   more than the same color found on a footer <a>. We rank colors by the
//   cumulative "importance score" of the elements they appear on. A Shopify
//   theme-default teal that only appears on a footer border gets weight ~1;
//   the brand's actual primary orange on the CTA and H1 gets weight ~50.
//
// The synthesis prompt re-weights this output with vision context (logo +
// screenshot), so our job is to surface candidates, not make final calls.
function collectSignalScript() {
  return `(() => {
    const norm = (s) => (s || '').trim();
    const hostname = location.hostname;
    const origin = location.origin;

    // ── JSON-LD Organization schema — highest-quality signal ──
    const jsonLd = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      try {
        const parsed = JSON.parse(s.textContent);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        arr.forEach(obj => {
          if (obj && (obj['@type'] === 'Organization' || obj['@type'] === 'WebSite' || obj['@type'] === 'LocalBusiness')) {
            jsonLd.push(obj);
          }
        });
      } catch (_) { /* bad JSON-LD, ignore */ }
    });

    // ── Meta signals ──
    const meta = {};
    document.querySelectorAll('meta').forEach(m => {
      const k = m.getAttribute('name') || m.getAttribute('property');
      const v = m.getAttribute('content');
      if (k && v) meta[k.toLowerCase()] = v;
    });

    // ── Link-rel icons (apple-touch-icon, icon) ──
    const linkIcons = [];
    document.querySelectorAll('link[rel*="icon"]').forEach(l => {
      const rel = (l.getAttribute('rel') || '').toLowerCase();
      const href = l.getAttribute('href');
      const sizes = l.getAttribute('sizes') || '';
      if (!href) return;
      const abs = new URL(href, origin).href;
      let maxSize = 0;
      sizes.split(/\\s+/).forEach(s => {
        const m = s.match(/(\\d+)x(\\d+)/);
        if (m) maxSize = Math.max(maxSize, parseInt(m[1], 10));
      });
      linkIcons.push({ rel, href: abs, maxSize });
    });

    // ── Logo candidates — priority order ──
    // 1) JSON-LD logo
    // 2) apple-touch-icon (usually ≥180px)
    // 3) <link rel=icon sizes>= 192
    // 4) inline SVG inside <header>
    // 5) <img> with logo/brand in class/id/alt
    // 6) og:image
    // 7) favicon (last resort — often 32px)
    const logoCandidates = [];
    jsonLd.forEach(o => {
      const l = o.logo;
      if (typeof l === 'string') logoCandidates.push({ src: new URL(l, origin).href, source: 'json-ld', weight: 100 });
      else if (l && l.url) logoCandidates.push({ src: new URL(l.url, origin).href, source: 'json-ld', weight: 100 });
    });
    linkIcons
      .filter(i => i.rel.includes('apple-touch-icon'))
      .forEach(i => logoCandidates.push({ src: i.href, source: 'apple-touch-icon', weight: 90, size: i.maxSize }));
    linkIcons
      .filter(i => i.rel.includes('icon') && !i.rel.includes('apple') && i.maxSize >= 192)
      .forEach(i => logoCandidates.push({ src: i.href, source: 'link-icon-hires', weight: 80, size: i.maxSize }));

    const header = document.querySelector('header') || document.querySelector('[role="banner"]') || document.body;
    header.querySelectorAll('svg').forEach((svg, idx) => {
      if (idx > 2) return; // cap
      const cls = (svg.getAttribute('class') || '').toLowerCase();
      const weight = cls.includes('logo') || cls.includes('brand') ? 85 : 60;
      logoCandidates.push({ src: null, svgOuterHtml: svg.outerHTML.slice(0, 30000), source: 'header-svg', weight });
    });

    header.querySelectorAll('img').forEach(img => {
      const cls = (img.getAttribute('class') || '').toLowerCase();
      const id = (img.getAttribute('id') || '').toLowerCase();
      const alt = (img.getAttribute('alt') || '').toLowerCase();
      const isLogo = /logo|brand|header|wordmark/.test(cls + ' ' + id + ' ' + alt);
      if (isLogo && img.src) {
        logoCandidates.push({ src: new URL(img.src, origin).href, source: 'header-img-logo', weight: 75 });
      }
    });

    if (meta['og:image']) {
      logoCandidates.push({ src: new URL(meta['og:image'], origin).href, source: 'og-image', weight: 40 });
    }
    linkIcons
      .filter(i => i.rel.includes('icon') && !i.rel.includes('apple') && i.maxSize < 192)
      .forEach(i => logoCandidates.push({ src: i.href, source: 'favicon', weight: 20, size: i.maxSize }));

    // De-dupe logo candidates by src, keep highest weight
    const logoMap = new Map();
    for (const c of logoCandidates) {
      const key = c.src || c.svgOuterHtml;
      if (!key) continue;
      if (!logoMap.has(key) || logoMap.get(key).weight < c.weight) logoMap.set(key, c);
    }
    const logos = Array.from(logoMap.values()).sort((a, b) => b.weight - a.weight).slice(0, 6);

    // ── Weighted palette extraction ──
    // Selectors ranked by brand-signal importance.
    const selectorWeights = [
      { sel: 'button, [role="button"], .btn, .button', w: 10, where: 'cta' },
      { sel: 'a.button, a.btn, a[class*="cta"], input[type="submit"]', w: 10, where: 'cta' },
      { sel: 'h1', w: 8, where: 'h1' },
      { sel: 'h2', w: 5, where: 'h2' },
      { sel: 'header a, nav a, [role="banner"] a', w: 6, where: 'nav' },
      { sel: '.hero, [class*="hero"], section:first-of-type', w: 7, where: 'hero' },
      { sel: 'body', w: 2, where: 'body' },
      { sel: 'footer, footer *', w: 1, where: 'footer' },
    ];

    const palette = new Map(); // hex -> {weight, roles:Set, contexts:[]}
    const addColor = (hex, weight, where) => {
      if (!hex) return;
      const norm = normalizeHex(hex);
      if (!norm) return;
      // Skip pure transparent / near-transparent
      if (norm === '#00000000' || norm === 'transparent') return;
      const existing = palette.get(norm) || { weight: 0, roles: new Set(), contexts: [] };
      existing.weight += weight;
      existing.roles.add(where);
      if (existing.contexts.length < 5) existing.contexts.push(where);
      palette.set(norm, existing);
    };

    function normalizeHex(v) {
      v = (v || '').trim().toLowerCase();
      if (!v || v === 'transparent' || v === 'none' || v === 'inherit' || v === 'initial' || v === 'currentcolor') return null;
      // rgb(r, g, b) or rgba(r, g, b, a)
      let m = v.match(/^rgba?\\(([^)]+)\\)/);
      if (m) {
        const parts = m[1].split(',').map(s => s.trim());
        if (parts.length >= 3) {
          const r = parseInt(parts[0], 10);
          const g = parseInt(parts[1], 10);
          const b = parseInt(parts[2], 10);
          const a = parts[3] !== undefined ? parseFloat(parts[3]) : 1;
          if (a < 0.1) return null; // near-transparent
          if ([r, g, b].some(n => Number.isNaN(n) || n < 0 || n > 255)) return null;
          return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
        }
      }
      // #rgb / #rrggbb / #rrggbbaa
      m = v.match(/^#([0-9a-f]{3,8})$/);
      if (m) {
        const hex = m[1];
        if (hex.length === 3) return '#' + hex.split('').map(c => c + c).join('');
        if (hex.length === 6) return '#' + hex;
        if (hex.length === 8) return '#' + hex.slice(0, 6); // strip alpha
      }
      return null;
    }

    for (const { sel, w, where } of selectorWeights) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
      let seen = 0;
      nodes.forEach(el => {
        if (seen > 30) return; // cap per selector — don't drown in footer links
        seen++;
        const cs = getComputedStyle(el);
        addColor(cs.color, w, where);
        addColor(cs.backgroundColor, w, where);
        addColor(cs.borderColor, Math.ceil(w / 2), where);
      });
    }

    // CSS custom properties on :root — often holds the brand's declared palette
    const rootStyle = getComputedStyle(document.documentElement);
    const cssVars = {};
    // Walk stylesheets for --color-* custom properties
    try {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try { rules = sheet.cssRules; } catch (_) { continue; } // cross-origin sheets
        if (!rules) continue;
        for (const rule of Array.from(rules)) {
          if (rule.selectorText === ':root' && rule.style) {
            for (let i = 0; i < rule.style.length; i++) {
              const prop = rule.style[i];
              if (prop.startsWith('--')) {
                const val = rule.style.getPropertyValue(prop).trim();
                cssVars[prop] = val;
                if (/color|bg|background|border|accent|brand|primary/.test(prop)) {
                  const hex = normalizeHex(val);
                  if (hex) addColor(hex, 6, 'css-var:' + prop);
                }
              }
            }
          }
        }
      }
    } catch (_) { /* stylesheet access can throw on cross-origin */ }

    // theme-color + msapplication-TileColor meta tags
    if (meta['theme-color']) addColor(normalizeHex(meta['theme-color']), 8, 'theme-color-meta');
    if (meta['msapplication-tilecolor']) addColor(normalizeHex(meta['msapplication-tilecolor']), 6, 'tile-color-meta');

    const paletteArr = Array.from(palette.entries())
      .map(([hex, v]) => ({ hex, weight: v.weight, roles: Array.from(v.roles), contexts: v.contexts }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 24);

    // ── Typography ──
    const fontUsage = new Map(); // family -> { weight, roles }
    const typographyTargets = [
      { sel: 'h1', role: 'display', w: 10 },
      { sel: 'h2', role: 'heading', w: 6 },
      { sel: 'h3', role: 'heading', w: 4 },
      { sel: 'button, .btn', role: 'ui', w: 5 },
      { sel: 'body, p', role: 'body', w: 8 },
      { sel: 'nav a', role: 'nav', w: 3 },
    ];
    for (const { sel, role, w } of typographyTargets) {
      let nodes; try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
      let seen = 0;
      nodes.forEach(el => {
        if (seen > 5) return;
        seen++;
        const cs = getComputedStyle(el);
        const family = (cs.fontFamily || '').split(',')[0].trim().replace(/['"]/g, '');
        if (!family) return;
        const key = family.toLowerCase();
        const existing = fontUsage.get(key) || { family, weight: 0, roles: new Set(), sizes: [] };
        existing.weight += w;
        existing.roles.add(role);
        if (existing.sizes.length < 4) existing.sizes.push({ role, size: cs.fontSize, fontWeight: cs.fontWeight });
        fontUsage.set(key, existing);
      });
    }

    // Google Fonts links (high-confidence list of loaded families)
    const googleFontFamilies = [];
    document.querySelectorAll('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]').forEach(l => {
      const href = l.getAttribute('href') || '';
      const m = href.match(/family=([^&]+)/);
      if (!m) return;
      m[1].split('|').forEach(f => {
        const fam = decodeURIComponent(f.split(':')[0]).replace(/\\+/g, ' ');
        if (fam) googleFontFamilies.push(fam);
      });
    });

    const typography = Array.from(fontUsage.values())
      .map(f => ({ family: f.family, weight: f.weight, roles: Array.from(f.roles), sizes: f.sizes }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 8);

    // ── Copy samples ──
    const textOf = (sel, max = 300) => {
      const el = document.querySelector(sel);
      if (!el) return '';
      return norm(el.textContent).slice(0, max);
    };
    const collect = (sel, limit = 5, max = 200) => {
      const out = [];
      document.querySelectorAll(sel).forEach(el => {
        if (out.length >= limit) return;
        const t = norm(el.textContent);
        if (t && t.length > 3) out.push(t.slice(0, max));
      });
      return out;
    };

    const copy = {
      title: document.title || '',
      h1: textOf('h1', 400),
      metaDescription: meta['description'] || meta['og:description'] || '',
      heroParagraph: textOf('h1 ~ p, [class*="hero"] p, section:first-of-type p', 500),
      productTitles: collect('[class*="product"] h2, [class*="product"] h3, .product-title, .product-card__title', 6, 120),
      productDescriptions: collect('[class*="product"] p, .product-card__description', 4, 200),
      footerTagline: textOf('footer p', 300),
      ctas: collect('button, a.button, a.btn, [class*="cta"]', 10, 60),
    };

    // ── Social profiles (from JSON-LD sameAs + common header/footer links) ──
    const social = new Set();
    jsonLd.forEach(o => {
      if (Array.isArray(o.sameAs)) o.sameAs.forEach(u => social.add(u));
    });
    document.querySelectorAll('a[href*="instagram.com"], a[href*="facebook.com"], a[href*="tiktok.com"], a[href*="twitter.com"], a[href*="x.com"], a[href*="youtube.com"], a[href*="linkedin.com"], a[href*="pinterest.com"]').forEach(a => {
      if (a.href) social.add(a.href);
    });

    // ── Organization basics ──
    const org = {};
    jsonLd.forEach(o => {
      if (o.name) org.name = o.name;
      if (o.description) org.description = o.description;
      if (o.slogan) org.slogan = o.slogan;
    });

    return {
      url: location.href,
      hostname,
      org,
      copy,
      palette: paletteArr,
      cssVars,
      typography,
      googleFontFamilies: Array.from(new Set(googleFontFamilies)),
      logoCandidates: logos,
      social: Array.from(social),
      meta,
      jsonLd: jsonLd.slice(0, 3), // cap payload size
    };
  })()`;
}

// ── Logo color quantization ──
// If the top-ranked logo candidate is a raster image, draw it onto an offscreen
// canvas in the renderer and extract 5-8 dominant colors via simple k-means
// over downsampled pixels. These colors are the truest brand palette (a
// designer deliberately chose them) and the synthesis prompt weights them
// higher than CSS-extracted colors.
async function quantizeLogoColors(win, candidates, baseUrl) {
  if (!candidates || candidates.length === 0) return [];
  if (!win || win.isDestroyed()) return [];
  // Pick the highest-weight candidate with a raster src (skip inline SVGs —
  // we already gave those to the prompt as text, and vision reads them fine).
  const target = candidates.find(c => c.src && !/\.svg(\?|$)/i.test(c.src));
  if (!target) return [];

  // REGRESSION GUARD (2026-04-20): the injected fetch MUST carry an
  // AbortController tied to setTimeout. The original version shipped a
  // bare fetch(url, { credentials:'omit', mode:'cors' }) — Forever21.com's
  // logo CDN slow-dripped the response, the promise never resolved, the
  // surrounding executeJavaScript never returned, and the MCP tool hung
  // forever. The UI froze mid-onboarding. Keep BOTH the inner abort AND
  // the outer executeJsWithTimeout below — they defend against different
  // failure modes (slow CDN vs. any other infinite await in the script).
  const fetchMs = DEFAULT_LOGO_FETCH_TIMEOUT_MS;
  const script = `(async () => {
    const url = ${JSON.stringify(target.src)};
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), ${fetchMs});
    try {
      const resp = await fetch(url, { credentials: 'omit', mode: 'cors', signal: controller.signal });
      if (!resp.ok) return { error: 'fetch-status-' + resp.status };
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob);
      const W = 64, H = 64;
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, W, H);
      const data = ctx.getImageData(0, 0, W, H).data;
      // Bucket by rounded 6-bit RGB (4096 buckets). Count and pick top 8.
      const buckets = new Map();
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a < 128) continue; // skip transparent
        // Snap to 6-bit (0..63), then back to 8-bit center
        const r = (data[i] >> 2) << 2 | 2;
        const g = (data[i + 1] >> 2) << 2 | 2;
        const b = (data[i + 2] >> 2) << 2 | 2;
        const key = (r << 16) | (g << 8) | b;
        buckets.set(key, (buckets.get(key) || 0) + 1);
      }
      const total = Array.from(buckets.values()).reduce((a, b) => a + b, 0);
      const top = Array.from(buckets.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([k, count]) => {
          const r = (k >> 16) & 0xff, g = (k >> 8) & 0xff, b = k & 0xff;
          const hex = '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
          return { hex, freq: count / total };
        });
      return { colors: top };
    } catch (e) {
      return { error: String(e && e.message || e) };
    } finally {
      clearTimeout(abortTimer);
    }
  })()`;
  try {
    // Outer timeout ≥ inner timeout + pixel-processing budget. 10s is
    // generous; if the browser process somehow ignores the AbortController
    // (known Electron bug with image-blob streams on old versions), the
    // outer race still unwinds the await.
    const result = await executeJsWithTimeout(win, script, 'quantizeLogoColors', DEFAULT_EXECUTE_JS_TIMEOUT_MS);
    if (result && Array.isArray(result.colors)) return result.colors;
  } catch (_) { /* quantization is best-effort — never block the guide */ }
  return [];
}

// ── Pure parsing helpers (test-reachable without Electron) ──
//
// The in-page collectSignalScript does the heavy lifting via live DOM
// APIs. These helpers mirror its logic against raw HTML strings so unit
// tests can exercise them deterministically. They are conservative —
// their goal is to confirm that signal is extractable from representative
// fixtures, not to replicate the full DOM walker.

/**
 * Parse a hex/rgb(a) color expression. Shared with the in-page version.
 * Returns a lowercased `#rrggbb` string, or null if unparseable / invisible.
 */
function parseColor(input) {
  if (!input || typeof input !== 'string') return null;
  const v = input.trim().toLowerCase();
  if (!v || v === 'transparent' || v === 'none' || v === 'inherit' ||
      v === 'initial' || v === 'currentcolor') {
    return null;
  }
  let m = v.match(/^rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map(s => s.trim());
    if (parts.length >= 3) {
      const r = parseInt(parts[0], 10);
      const g = parseInt(parts[1], 10);
      const b = parseInt(parts[2], 10);
      const a = parts[3] !== undefined ? parseFloat(parts[3]) : 1;
      if (a < 0.1) return null;
      if ([r, g, b].some(n => Number.isNaN(n) || n < 0 || n > 255)) return null;
      return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
    }
  }
  m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    const hex = m[1];
    if (hex.length === 3) return '#' + hex.split('').map(c => c + c).join('');
    if (hex.length === 6) return '#' + hex;
    if (hex.length === 8) return '#' + hex.slice(0, 6);
  }
  return null;
}

/**
 * Regex-extract palette candidates from a raw CSS or HTML string.
 * Picks up hex and rgb() colors from inline styles, <style> blocks, and
 * attribute values. De-duplicates, preserves first-seen order.
 */
function extractPaletteFromHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const seen = new Set();
  const out = [];
  // Hex colors (3, 6, or 8 digits). Require a # prefix to avoid matching
  // random hex-y substrings like SHA1 fragments.
  const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
  const rgbRe = /rgba?\([^)]+\)/gi;
  for (const match of html.matchAll(hexRe)) {
    const norm = parseColor(match[0]);
    if (norm && !seen.has(norm)) { seen.add(norm); out.push(norm); }
  }
  for (const match of html.matchAll(rgbRe)) {
    const norm = parseColor(match[0]);
    if (norm && !seen.has(norm)) { seen.add(norm); out.push(norm); }
  }
  return out;
}

/**
 * Best-effort extraction of a meta-theme-color value. Returns the
 * normalized hex or null.
 */
function extractMetaThemeColor(html) {
  if (!html || typeof html !== 'string') return null;
  // Accept both attribute orders: name="theme-color" content="#xxx"
  // and content="#xxx" name="theme-color".
  const matches = html.match(/<meta\b[^>]*name\s*=\s*["']theme-color["'][^>]*>/i);
  if (!matches) return null;
  const content = matches[0].match(/content\s*=\s*["']([^"']+)["']/i);
  if (!content) return null;
  return parseColor(content[1]);
}

/**
 * Pull font-family names referenced in the fixture. Catches CSS
 * `font-family: ...;` declarations and Google Fonts `<link>` tags. Returns
 * a de-duplicated array of family names (first token only).
 */
function extractFontFamilies(html) {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  // CSS font-family declarations. Match up to the first ; or } (end of
  // rule / block). Strip optional quotes afterwards.
  const cssRe = /font-family\s*:\s*([^;}\n]+)/gi;
  for (const m of html.matchAll(cssRe)) {
    const first = m[1].split(',')[0].trim().replace(/^["']|["']$/g, '');
    if (first && !seen.has(first.toLowerCase())) {
      seen.add(first.toLowerCase());
      out.push(first);
    }
  }
  // Google Fonts link tags
  const linkRe = /<link\b[^>]*href\s*=\s*["']([^"']*fonts\.googleapis\.com[^"']*)["']/gi;
  for (const m of html.matchAll(linkRe)) {
    const href = m[1];
    const family = href.match(/family=([^&]+)/);
    if (!family) continue;
    for (const f of family[1].split('|')) {
      const fam = decodeURIComponent(f.split(':')[0]).replace(/\+/g, ' ');
      if (fam && !seen.has(fam.toLowerCase())) {
        seen.add(fam.toLowerCase());
        out.push(fam);
      }
    }
  }
  return out;
}

/**
 * Resolve a logo URL from a fixture. Priority:
 *   1. JSON-LD Organization.logo
 *   2. <link rel="apple-touch-icon">
 *   3. <img> inside <header> with class/id/alt matching logo/brand/wordmark
 *   4. <meta property="og:image">
 * Returns absolute URL resolved against baseUrl, or null.
 */
function resolveLogoUrl(html, baseUrl) {
  if (!html || typeof html !== 'string') return null;
  const resolve = (href) => {
    if (!href) return null;
    try { return new URL(href, baseUrl).href; } catch (_) { return null; }
  };
  // 1. JSON-LD
  const jsonLdBlocks = html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of jsonLdBlocks) {
    try {
      const parsed = JSON.parse(m[1]);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const obj of arr) {
        if (!obj) continue;
        if (obj['@type'] === 'Organization' || obj['@type'] === 'WebSite' || obj['@type'] === 'LocalBusiness') {
          if (typeof obj.logo === 'string') return resolve(obj.logo);
          if (obj.logo && obj.logo.url) return resolve(obj.logo.url);
        }
      }
    } catch (_) { /* invalid JSON-LD, skip */ }
  }
  // 2. apple-touch-icon
  const apple = html.match(/<link\b[^>]*rel\s*=\s*["']apple-touch-icon["'][^>]*>/i);
  if (apple) {
    const href = apple[0].match(/href\s*=\s*["']([^"']+)["']/i);
    if (href) return resolve(href[1]);
  }
  // 3. header <img> with logo-ish class/id/alt
  const headerBlock = html.match(/<header\b[\s\S]*?<\/header>/i);
  if (headerBlock) {
    const imgRe = /<img\b[^>]*>/gi;
    for (const m of headerBlock[0].matchAll(imgRe)) {
      const tag = m[0];
      const cls = (tag.match(/class\s*=\s*["']([^"']+)["']/i) || [, ''])[1].toLowerCase();
      const id  = (tag.match(/id\s*=\s*["']([^"']+)["']/i)  || [, ''])[1].toLowerCase();
      const alt = (tag.match(/alt\s*=\s*["']([^"']+)["']/i) || [, ''])[1].toLowerCase();
      if (/logo|brand|wordmark/.test(cls + ' ' + id + ' ' + alt)) {
        const src = tag.match(/src\s*=\s*["']([^"']+)["']/i);
        if (src) return resolve(src[1]);
      }
    }
  }
  // 4. og:image
  const og = html.match(/<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*>/i);
  if (og) {
    const content = og[0].match(/content\s*=\s*["']([^"']+)["']/i);
    if (content) return resolve(content[1]);
  }
  return null;
}

// ── URL helpers ──
function normalizeUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    return u.origin + (u.pathname === '/' ? '' : u.pathname);
  } catch (_) { return null; }
}

function joinUrl(base, subpath) {
  try {
    return new URL(subpath, base).href;
  } catch (_) { return null; }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  scrapeBrand,
  validateScrapeURL,
  normalizeUrl,
  joinUrl,
  parseColor,
  extractPaletteFromHtml,
  extractMetaThemeColor,
  extractFontFamilies,
  resolveLogoUrl,
  raceWithTimeout,
  executeJsWithTimeout,
  ScrapeTimeoutError,
  DEFAULT_OVERALL_TIMEOUT_MS,
  DEFAULT_EXECUTE_JS_TIMEOUT_MS,
  DEFAULT_LOGO_FETCH_TIMEOUT_MS,
};
