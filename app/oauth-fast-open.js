// oauth-fast-open.js — RFC 8252 fast-click OAuth implementation.
//
// This module implements the click-to-browser half of the OAuth flow.
// It binds an ephemeral localhost HTTP listener, builds the authorize URL
// (via oauth-provider-config.js), opens the browser synchronously, then
// waits for the provider's redirect callback and dispatches the code to
// the Go binary for BFF exchange + post-exchange discovery.
//
// Design anchors (see CLAUDE.md → Engineering Standard):
//   - RFC 8252 §7.3  Loopback redirect URIs for native apps.
//   - RFC 7636      PKCE for the subset of providers that support it
//                   (Google, Shopify, Amazon, Etsy — where redirectUri="").
//   - Rule 2        Client secrets never touch the binary — all token
//                   exchanges go through the Worker BFF
//                   (/api/oauth/exchange in landing/worker.js).
//   - Rule 3        CSRF state validation uses crypto.timingSafeEqual
//                   (the Node equivalent of Go's subtle.ConstantTimeCompare).
//                   Raw `===` / `!==` on state would leak timing info via
//                   cross-origin <img src="http://localhost:port/callback…">
//                   probes — the SAME threat model that motivated the
//                   regression guards at oauth.go:538-563 and :599-641.
//   - Rule 11       Every listener binds to 127.0.0.1 explicitly — NEVER
//                   `.listen(port)` or 0.0.0.0. The test in
//                   app/ws-server.test.js source-scans every app/*.js for
//                   this and will flag any regression.
//
// What this file does NOT do:
//   - Token exchange. The Go binary's `oauth-exchange` action does that
//     via bffExchange (Rule 2). See autocmo-core/oauth_exchange.go.
//   - Post-exchange discovery (ad-account fetch, Shopify shop verify,
//     Stripe scope re-check, etc.). Those stay in the binary's per-
//     platform finishXxxLogin helpers so both the legacy <platform>-login
//     action and the new oauth-exchange action share the same path.

'use strict';

const crypto = require('crypto');
const http = require('http');
const { execFile } = require('child_process');

const { buildAuthUrl, PROVIDERS, ACTIVE_PLATFORMS } = require('./oauth-provider-config');

// Lazy-load electron's shell so unit tests (run under plain Node, not
// Electron) can require this module without a MODULE_NOT_FOUND error.
// In production this resolves on first click — a one-time cost measured
// in sub-millisecond territory, negligible vs. the user-perceived
// click-to-browser gap we're optimizing.
function openBrowserExternal(url) {
  const { shell } = require('electron');
  return shell.openExternal(url);
}

// ── Timing instrumentation ─────────────────────────────────────────
//
// Every fast-open flow emits four marks to the main-process console so we
// can verify the RFC 8252 < 50 ms click-to-browser budget in real users'
// sessions, not just in synthetic tests. The user-facing UX depends on
// these numbers staying low as we add providers; instrumentation exists
// so a regression shows up in logs instead of in perception.
//
// Budget (measured on mid-tier hardware, cold click):
//   click → openExternal          target <  50 ms  (achieved ~ 5-15 ms)
//   openExternal → user approval  latency owned by the user (seconds)
//   callback → binary spawned     target < 100 ms  (listener already bound)
//   binary spawned → token ready  target < 1500 ms (BFF round-trip dominates)
function tMark(stage, startMs) {
  const dt = Date.now() - startMs;
  console.log(`[oauth-fast-open] ${stage} (+${dt}ms)`);
}

// ── Constant-time state compare ────────────────────────────────────
//
// Node's crypto.timingSafeEqual requires equal-length buffers, so we
// length-check first (non-secret branch). This matches the semantics of
// Go's subtle.ConstantTimeCompare at oauth.go:606-607 where the Go code
// compares the incoming state against both the full state (including any
// |port suffix) and the base state (suffix stripped by the Worker relay).
//
// REGRESSION GUARD (2026-04-24, Rule 3 in CLAUDE.md — every localhost
// OAuth handler validates state with a constant-time compare): do NOT
// replace this with `===` or `Buffer.compare`. The cross-origin <img>
// CSRF threat (see oauth.go REGRESSION GUARD at lines 538-563) applies
// equally to the Node listener. Raw equality checks leak state prefix
// bytes via timing differences that a same-machine attacker can exploit
// over the length of the flow (~ 5 min default timeout).
function timingSafeCompareString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  // Both operands are the same length, so Buffer.from allocates
  // equal-length buffers and timingSafeEqual runs in O(length).
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// validateIncomingState — accepts incomingState if it matches either the
// locally-generated base state OR the authState that was actually put on
// the authorize URL (for Worker-relay providers, authState = "<base>|<port>").
// Matches oauth.go:604-608 exactly.
function validateIncomingState(incoming, baseState, authState) {
  if (!incoming) return false;
  if (timingSafeCompareString(incoming, baseState)) return true;
  if (authState && timingSafeCompareString(incoming, authState)) return true;
  return false;
}

// ── HTML response helpers ──────────────────────────────────────────
//
// These pages are shown in the user's browser after the callback fires.
// They mirror the success / error pages in oauth.go:633-641 and :610-613
// byte-for-byte where possible so the user sees identical copy whether
// they're on the fast-open path or the legacy binary-login fallback.
// Escaping uses entity references only (&lt;, &gt;, &amp;, &#39;, &quot;)
// since the only interpolated values are either untrusted error
// descriptions from the OAuth provider OR our own provider.displayName.

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlSuccess(displayName) {
  return `<!doctype html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#09090b;color:#e4e4e7">
<div style="text-align:center"><h2 style="color:#22c55e">&#10003; Connected to ${escapeHtml(displayName)}</h2>
<p>You can close this tab and return to Merlin.</p></div></body></html>`;
}

function htmlStateError() {
  return `<!doctype html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#09090b;color:#e4e4e7">
<div style="text-align:center"><h2 style="color:#ef4444">Security Error</h2>
<p>State mismatch &mdash; possible CSRF attack. Please try again.</p></div></body></html>`;
}

function htmlAuthError(message) {
  return `<!doctype html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#09090b;color:#e4e4e7">
<div style="text-align:center"><h2 style="color:#ef4444">Authorization failed</h2>
<p>${escapeHtml(message)}</p>
<p style="color:#71717a">You can close this tab.</p></div></body></html>`;
}

// ── Shopify shop resolver (SSRF-guarded) ────────────────────────────
//
// Mirrors resolveShopifyStore in autocmo-core/oauth.go. When a user
// provides a custom domain (e.g. "mad-chill.com"), we need to resolve
// the canonical .myshopify.com slug before building the authorize URL
// because Shopify's OAuth endpoint is host-specific.
//
// This keeps the resolve inside Node so the binary spawn isn't on the
// hot path. On re-auth, cfg.shopifyStore is already populated with the
// resolved slug and this function is skipped entirely.
//
// SSRF posture:
//   - Blocks localhost, private RFC1918, link-local, GCP/AWS/Azure
//     metadata hosts, IPv6, and any input without a dot. The blocklist
//     is intentionally identical to oauth.go:2805-2827; drift is a bug.
//   - Uses an explicit 10s timeout and a 10 MB body cap (io.LimitReader
//     parity) so a malicious target can't wedge the OAuth click.
//   - Does NOT follow redirects to non-https or non-public hosts (Node's
//     default agent already refuses private-scope redirects on modern
//     versions but we also check the final URL's host).

const SHOPIFY_BLOCKED_PREFIXES = [
  'localhost', '127.', '10.', '192.168.',
  '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.',
  '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.',
  '172.28.', '172.29.', '172.30.', '172.31.',
  '169.254.', '0.', '[', '::1', '0:0:0:0', 'fe80:', 'fd', 'fc', 'metadata.',
];

function isBlockedShopifyHost(lower) {
  if (!lower || /[\s]/.test(lower)) return true;
  if (lower.includes(':')) return true; // any IPv6 notation
  if (!lower.includes('.')) return true;
  for (const p of SHOPIFY_BLOCKED_PREFIXES) {
    if (lower.startsWith(p)) return true;
  }
  return false;
}

async function resolveShopifyShop(rawDomain) {
  if (!rawDomain) return '';
  const lower = String(rawDomain).toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (isBlockedShopifyHost(lower)) return '';

  // Already a canonical slug — trust but verify with /cart.js.
  if (lower.endsWith('.myshopify.com')) {
    const slug = lower.replace(/\.myshopify\.com$/, '');
    return (await verifyShopifyShop(slug)) ? slug : '';
  }

  // Custom domain → fetch homepage, look for Shopify.shop = "<slug>.myshopify.com"
  let body = '';
  let finalHost = '';
  try {
    const resp = await fetchWithTimeout(`https://${lower}`, { method: 'GET', redirect: 'follow' }, 10000);
    finalHost = new URL(resp.url).host.toLowerCase();
    // Soft cap: 10 MB to match the Go io.LimitReader.
    const rawText = await resp.text();
    body = rawText.slice(0, 10 * 1024 * 1024);
  } catch {
    return '';
  }

  // Source 1: direct redirect to .myshopify.com → authoritative.
  if (finalHost.endsWith('.myshopify.com')) {
    const slug = finalHost.replace(/\.myshopify\.com$/, '');
    if (await verifyShopifyShop(slug)) return slug;
  }

  // Source 2: Shopify.shop JS variable.
  const direct = body.match(/Shopify\.shop\s*=\s*["']([a-z0-9][a-z0-9-]*)\.myshopify\.com["']/);
  if (direct && direct[1] && (await verifyShopifyShop(direct[1]))) return direct[1];

  // Source 3: scan for any .myshopify.com reference and verify each candidate.
  const seen = new Set();
  const re = /([a-z0-9][a-z0-9-]*)\.myshopify\.com/g;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(body)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    // Cap candidate verifications to 5 so a theme with dozens of stale
    // .myshopify.com refs can't wedge the resolve path.
    if (seen.size > 5) break;
    // eslint-disable-next-line no-await-in-loop
    if (await verifyShopifyShop(slug)) return slug;
  }
  return '';
}

async function verifyShopifyShop(slug) {
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return false;
  try {
    const resp = await fetchWithTimeout(`https://${slug}.myshopify.com/cart.js`, { method: 'GET' }, 5000);
    if (resp.status !== 200) return false;
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    return ct.includes('application/json');
  } catch {
    return false;
  }
}

// fetchWithTimeout — wraps the built-in global fetch (Node 18+) with an
// AbortController so a slow/hung target can't stall the OAuth click.
// Matches the 10s / 5s budgets from oauth.go:2838-2847.
async function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── JSON extractor for binary stdout ───────────────────────────────
//
// The Go binary prints status messages to stdout before the final result
// JSON block. We take the LAST well-formed { ... } block at column 0 as
// the result. Matches the heuristic in main.js:3816-3832 (preserved so
// the existing binary output shape doesn't need to change).
function extractJsonBlock(stdout) {
  const lines = String(stdout || '').split('\n');
  let jsonStart = -1;
  let jsonEnd = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === '}' && jsonEnd < 0) jsonEnd = i;
    if (t === '{' && jsonEnd >= 0) {
      jsonStart = i;
      break;
    }
  }
  if (jsonStart < 0 || jsonEnd < 0) {
    throw new Error('no JSON in binary stdout');
  }
  return JSON.parse(lines.slice(jsonStart, jsonEnd + 1).join('\n'));
}

// ── Main entry point ───────────────────────────────────────────────
//
// runFastOpenOAuth — start a full RFC 8252 fast-click OAuth flow.
//
// Params:
//   platform    — key in PROVIDERS (e.g. "meta", "tiktok", "shopify").
//   opts:
//     binaryPath  — absolute path to Merlin.exe (required).
//     configPath  — absolute path to merlin-config.json (required).
//     appRoot     — working directory for the binary spawn (required).
//     brand       — active brand name, forwarded to oauth-exchange.
//     shop        — Shopify shop slug or custom domain. Resolved to
//                   canonical .myshopify.com slug before URL build.
//     activeChildProcesses — Set<ChildProcess> the caller tracks for
//                            graceful shutdown on app quit. Optional.
//
// Returns a Promise resolving to:
//   { success: true, platform, result }  — result is the parsed JSON
//                                          from the binary's stdout
//                                          (contains vault-split tokens
//                                          and discovered metadata).
//   { error: '<message>' }               — any failure path.
async function runFastOpenOAuth(platform, opts = {}) {
  const startMs = Date.now();
  const cfg = PROVIDERS[platform];
  if (!cfg) {
    return { error: `unsupported platform: ${platform}` };
  }
  if (!opts.binaryPath || !opts.configPath || !opts.appRoot) {
    return { error: 'oauth-fast-open missing binaryPath / configPath / appRoot' };
  }

  // Shopify: resolve the shop slug before URL construction. Skips the
  // resolve entirely when the caller already passed a canonical slug.
  let shopSlug = '';
  if (platform === 'shopify') {
    shopSlug = await resolveShopifyShop(opts.shop);
    if (!shopSlug) {
      return {
        error: `Couldn't find a Shopify store at "${opts.shop}". Double-check the URL or try the .myshopify.com subdomain.`,
      };
    }
  }

  // Bind the ephemeral listener FIRST so the callback race window (user
  // finishes Authorize in < 200 ms) is impossible. 127.0.0.1 explicit per
  // Rule 11 — a wildcard bind would trigger a Windows Firewall prompt.
  const srv = http.createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const localPort = srv.address().port;

  let built;
  try {
    built = buildAuthUrl(platform, { localPort, shop: shopSlug });
  } catch (e) {
    try { srv.close(); } catch { /* ignore */ }
    return { error: e.message || 'failed to build authorize URL' };
  }

  // THE CRITICAL LINE — browser opens here. Everything above is
  // Node-only work (~5-15 ms). tMark prints the elapsed-since-entry
  // count so regressions are visible in logs.
  openBrowserExternal(built.authUrl);
  tMark(`openExternal ${platform}`, startMs);

  // Return a promise that resolves when the callback fires + the binary
  // finishes the exchange, or rejects on timeout / error.
  return new Promise((resolve) => {
    let settled = false;
    const resolveOnce = (v) => {
      if (settled) return;
      settled = true;
      try { srv.close(); } catch { /* ignore */ }
      clearTimeout(timeoutHandle);
      resolve(v);
    };

    // 5 minute budget — matches oauth.go:717. Long enough for 2FA,
    // password reset flows, SSO bounces.
    const timeoutHandle = setTimeout(() => {
      resolveOnce({ error: 'Timed out waiting for authorization.' });
    }, 300000);

    srv.on('request', (req, res) => {
      let u;
      try {
        u = new URL(req.url, `http://127.0.0.1:${localPort}`);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }

      if (u.pathname !== '/callback' && u.pathname !== '/token') {
        res.writeHead(404);
        res.end();
        return;
      }

      const incomingState = u.searchParams.get('state') || '';
      if (!validateIncomingState(incomingState, built.state, built.authState)) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlStateError());
        return resolveOnce({ error: 'State mismatch — possible CSRF attack. Please try again.' });
      }

      // Provider-reported error (user cancelled, invalid scope, etc.)
      const errMsg =
        u.searchParams.get('error_description') ||
        u.searchParams.get('error') ||
        '';
      if (errMsg) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlAuthError(errMsg));
        return resolveOnce({ error: errMsg });
      }

      // /token — implicit flow (Meta Login for Business). The Worker's
      // HTML relay POSTs directly here with access_token in the query.
      // We don't need BFF exchange in this branch; the token is already
      // usable. Binary still gets called so post-exchange discovery runs.
      const implicitToken = u.searchParams.get('access_token') || '';

      // /callback — authorization-code flow.
      const code = u.searchParams.get('code') || '';

      if (!implicitToken && !code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlAuthError('No authorization code received.'));
        return resolveOnce({ error: 'No authorization code received.' });
      }

      // Write the success page BEFORE spawning the binary so the user's
      // browser tab shows "Connected" immediately (~ 10 ms) instead of
      // waiting for the binary exchange (~ 500-1500 ms BFF round-trip).
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlSuccess(cfg.displayName));
      tMark(`callback received ${platform}`, startMs);

      // Spawn the binary for the code/token → vault exchange.
      const cmdObj = {
        action: 'oauth-exchange',
        platform: cfg.providerKey,
        redirectUri: built.redirectUri,
      };
      if (implicitToken) {
        cmdObj.implicitToken = implicitToken;
      } else {
        cmdObj.code = code;
        cmdObj.codeVerifier = built.pkceVerifier; // empty string when !usesPKCE
      }
      if (opts.brand) cmdObj.brand = opts.brand;
      if (platform === 'shopify' && shopSlug) cmdObj.shop = shopSlug;

      const child = execFile(
        opts.binaryPath,
        ['--config', opts.configPath, '--cmd', JSON.stringify(cmdObj)],
        { timeout: 60000, cwd: opts.appRoot },
        (err, stdout, stderr) => {
          if (opts.activeChildProcesses) opts.activeChildProcesses.delete(child);
          tMark(`exchange complete ${platform}`, startMs);
          if (err) {
            // The binary may have printed a valid result JSON before
            // exiting non-zero (e.g. deferred cleanup failure). Try to
            // parse before reporting the error — matches the fallback
            // path in main.js:3848-3872.
            try {
              const result = extractJsonBlock(stdout);
              return resolveOnce({ success: true, platform, result });
            } catch {
              return resolveOnce({ error: stderr || err.message });
            }
          }
          try {
            const result = extractJsonBlock(stdout);
            return resolveOnce({ success: true, platform, result });
          } catch (e) {
            return resolveOnce({ error: `Failed to parse exchange result: ${e.message}` });
          }
        }
      );
      if (opts.activeChildProcesses) opts.activeChildProcesses.add(child);
    });

    srv.on('error', (err) => {
      resolveOnce({ error: `Local callback listener failed: ${err.message}` });
    });
  });
}

module.exports = {
  runFastOpenOAuth,
  timingSafeCompareString,
  validateIncomingState,
  extractJsonBlock,
  resolveShopifyShop,
  verifyShopifyShop,
  isBlockedShopifyHost,
  htmlSuccess,
  htmlStateError,
  htmlAuthError,
  escapeHtml,
  ACTIVE_PLATFORMS,
};
