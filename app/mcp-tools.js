// Merlin MCP — Tool Definitions
//
// Every tool is registered via `defineTool({...})` from mcp-define-tool.js.
// That wrapper enforces annotations (destructive / idempotent / costImpact /
// brandRequired) at construction time and routes every call through the
// reliability pipeline:
//
//   brand-check → idempotency-lookup → preview-gate → concurrency-slot
//   → handler → envelope → idempotency-store
//
// Claude NEVER sees credentials. The handler spawns the Go binary with a
// temp config in the OS temp dir (so the workspace hook guard doesn't block
// it), redacts the output, and returns a structured envelope that the agent
// can branch on without regex-parsing English.

'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { redactOutput } = require('./mcp-redact');
const { extractArtifacts } = require('./artifact-parser');
const envelope = require('./mcp-envelope');
const errors = require('./mcp-errors');
const { defineTool } = require('./mcp-define-tool');
const { DEFAULT_POLICIES } = require('./mcp-preview');
const { buildMetaIntentTools } = require('./mcp-meta-intent');

// Regex shared between the MCP zod tightening here and the main-process
// assertBrandSafe() guard in main.js. Mirror of app/preload.js:BRAND_RE.
//
// Why tighten at the MCP layer too: the preload gate validates renderer IPC
// args, but MCP calls bypass the renderer and arrive via stdio. Without a
// regex here, a tool call like { brand: "../../.." } would reach zod as a
// plain string and flow into path.join() (see writeBrandTokens /
// readBrandConfig in main.js) before the defense-in-depth guard rejected
// it. Validating at the schema layer fails faster, with a clearer error
// back to the caller, and documents the contract.
const BRAND_NAME_PATTERN = /^[a-z0-9_-]{1,100}$/i;

// ── Progress event emission (Task 3.1) ───────────────────────
//
// MCP tools cannot stream partial results from a single tool call — the
// call settles exactly once. For long-running tools like `brand_scrape`
// (up to 90s), we fire progress EVENTS via ctx.emitProgress so the
// renderer (Cluster-M §3.6) can animate a live pill without blocking
// the agent. The model still narrates from its own side (SKILL.md
// "Narration exception for long tools" section added by Cluster-E);
// this channel is UI-only.
//
// Event shape (every payload carries these fields):
//   {
//     channel: 'mcp-progress',          // fixed string; preload.js routes on this
//     tool:    'brand_scrape',          // originating tool name
//     scrapeId: '<32 hex>',             // unique per invocation, correlates multi-stage UI
//     stage:   'start' | 'scanning' | 'done' | 'error' | 'timeout',
//     label:   'Reading homepage',      // short human label — matches SKILL narration examples
//     pct:     0.0 .. 1.0,              // optional coarse progress
//     url:     'https://...',           // original request URL
//     ts:      <unix-ms>,               // event timestamp
//     detail?: { products?: number, logoCandidates?: number, logoColors?: number,
//                secondaryPages?: number, error?: string },
//   }
//
// emitScrapeProgress is a no-op when ctx.emitProgress is missing (unit
// tests, older Electron hosts that haven't wired the IPC channel yet).
// Errors inside the emitter NEVER propagate — this is best-effort telemetry.
function emitScrapeProgress(ctx, payload) {
  if (!ctx || typeof ctx.emitProgress !== 'function') return;
  try {
    ctx.emitProgress(Object.assign({
      channel: 'mcp-progress',
      ts: Date.now(),
    }, payload));
  } catch (_) { /* never let a telemetry emit crash a tool call */ }
}

// ── Scrape-timeout tracker (Task 3.2) ────────────────────────
//
// Per-URL "did this URL already time out in this session?" tracker, so
// a SECOND scrape timeout on the same URL bumps the agent into the
// manual-entry fallback path instead of looping on retry_or_split
// forever. Scoped to the module (not global), 10-minute TTL per entry,
// bounded in size so a pathological agent that generates thousands of
// distinct URLs cannot leak memory. LRU-ish: when we exceed the cap, we
// drop the oldest half of entries (cheap, predictable, no heap growth).
const SCRAPE_TIMEOUT_TTL_MS = 10 * 60 * 1000;      // 10 minutes
const SCRAPE_TIMEOUT_MAX_ENTRIES = 512;            // bound memory footprint
const _scrapeTimeoutTracker = new Map();           // url → timeoutAtMs (expiry)

// Normalize a URL for tracking. Different case / trailing-slash variants
// of the same site should count as the SAME url, otherwise the fallback
// never triggers (the agent retries with `https://Example.com/` after
// `https://example.com` timed out and we miss the match). Best-effort —
// if parsing fails we fall back to the raw trimmed string.
function _normalizeTrackedUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    const host = (u.hostname || '').toLowerCase();
    const pathname = (u.pathname || '/').replace(/\/+$/, '') || '/';
    return `${u.protocol}//${host}${pathname}${u.search || ''}`;
  } catch (_) {
    return trimmed.toLowerCase();
  }
}

function _pruneScrapeTimeoutTracker(now) {
  // Drop expired entries.
  for (const [k, exp] of _scrapeTimeoutTracker) {
    if (exp <= now) _scrapeTimeoutTracker.delete(k);
  }
  // Cap size — drop the oldest ~half if we're still over the limit.
  if (_scrapeTimeoutTracker.size > SCRAPE_TIMEOUT_MAX_ENTRIES) {
    const drop = Math.ceil(_scrapeTimeoutTracker.size / 2);
    const it = _scrapeTimeoutTracker.keys();
    for (let i = 0; i < drop; i++) {
      const k = it.next().value;
      if (k === undefined) break;
      _scrapeTimeoutTracker.delete(k);
    }
  }
}

function _hasRecentScrapeTimeout(url) {
  const key = _normalizeTrackedUrl(url);
  if (!key) return false;
  const now = Date.now();
  _pruneScrapeTimeoutTracker(now);
  const exp = _scrapeTimeoutTracker.get(key);
  return typeof exp === 'number' && exp > now;
}

function _recordScrapeTimeout(url) {
  const key = _normalizeTrackedUrl(url);
  if (!key) return;
  const now = Date.now();
  _scrapeTimeoutTracker.set(key, now + SCRAPE_TIMEOUT_TTL_MS);
  _pruneScrapeTimeoutTracker(now);
}

// Test-only — resets the tracker between tests so order doesn't leak.
function _resetScrapeTimeoutTrackerForTests() {
  _scrapeTimeoutTracker.clear();
}

// ── Budget validation ────────────────────────────────────────
//
// Claude occasionally pre-converts dollar budgets to cents (e.g. passes 1000
// meaning $10/day) because it knows Meta/TikTok/Google APIs take cents under
// the hood. The MCP schema says "dollars", but Claude has misread this in the
// past — and once the value reaches the binary it gets multiplied by 100 AGAIN,
// turning a $10/day request into a $1000/day spend commitment. The user sees
// $1000/day on the approval card and rightly panics.
//
// This guard is defense-in-depth: detect values that are clearly nonsense for
// daily ad budgets and REJECT the tool call with an explanatory error so Claude
// can correct and retry. The binary also has a hard cap (see main.go validate).
//
// We use TWO signals:
//   1. Absolute ceiling — reject anything ≥ BUDGET_HARD_CEILING (no sane user
//      runs a $5000/day solo DTC ad budget; we assume 5000+ means cents).
//   2. Relative to maxDailyAdBudget — if the user configured a cap and the
//      requested budget exceeds it by more than 10x, treat as cents.
//
// Normal ad budgets for solo DTC founders: $5-$500/day. We reject anything
// above $1000/day unless the user's configured cap is at least 1/10 of that.
const BUDGET_HARD_CEILING = 5000; // dollars — above this is almost certainly cents

function validateBudget(ctx, args, platform) {
	const budget = args.dailyBudget;
	if (budget === undefined || budget === null) return null;
	if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) {
		return `dailyBudget must be a positive number in dollars (e.g. 10 for $10/day). Got: ${budget}`;
	}
	if (budget === 0) return null;

	// Read user's configured cap to check for "relative cents" (budget > 10x cap).
	let maxCap = 0;
	try {
		const brand = args.brand || '';
		const cfg = brand ? ctx.readBrandConfig(brand) : ctx.readConfig();
		maxCap = Number(cfg.maxDailyAdBudget || cfg.dailyAdBudget || 0);
	} catch {}

	// Absolute ceiling — anything this high is almost certainly Claude pre-converting.
	if (budget >= BUDGET_HARD_CEILING) {
		return `dailyBudget=${budget} looks like cents, not dollars. ${platform} ads: pass dollars (e.g. 10 for $10/day). If you really need $${budget}/day, ask the user to confirm and raise maxDailyAdBudget in config. NEVER pre-convert dollars to cents — Merlin handles that internally.`;
	}

	// Relative ceiling — budget more than 10x the user's configured cap is very likely cents.
	if (maxCap > 0 && budget > maxCap * 10) {
		return `dailyBudget=${budget} is more than 10x your configured max of $${maxCap}/day. This looks like cents, not dollars — Claude should pass ${Math.round(budget / 100)} for $${Math.round(budget / 100)}/day. NEVER pre-convert to cents.`;
	}

	// Also validate nested ads[] entries (bulk-push / carousel paths)
	if (Array.isArray(args.ads)) {
		for (let i = 0; i < args.ads.length; i++) {
			const nested = args.ads[i];
			if (!nested || typeof nested !== 'object') continue;
			const nb = nested.dailyBudget;
			if (nb === undefined || nb === null || nb === 0) continue;
			if (typeof nb !== 'number' || !Number.isFinite(nb) || nb < 0) {
				return `ads[${i}].dailyBudget must be a positive number in dollars. Got: ${nb}`;
			}
			if (nb >= BUDGET_HARD_CEILING) {
				return `ads[${i}].dailyBudget=${nb} looks like cents. Pass dollars (e.g. 10 for $10/day).`;
			}
			if (maxCap > 0 && nb > maxCap * 10) {
				return `ads[${i}].dailyBudget=${nb} is more than 10x your $${maxCap}/day cap. Likely cents — pass ${Math.round(nb / 100)}.`;
			}
		}
	}

	return null;
}

// ── Brand enforcement ────────────────────────────────────────
//
// Multi-brand users store tokens in brand-scoped configs (.merlin-config-{brand}.json).
// If Claude calls a brand-scoped action (e.g. dashboard, meta-insights) without
// specifying a brand, the binary silently falls back to the global config —
// which may have no tokens at all — and produces empty output. That's the
// "connected Meta Ads yields $0 revenue" failure mode.
//
// Defense: any binary action that operates on brand-scoped data MUST receive
// an explicit brand argument. The allowlist below enumerates actions that are
// genuinely brand-agnostic (utilities, voice management shared across brands,
// OAuth login flows that may write to global OR brand config, etc.). Every
// other action defaults to BRAND-REQUIRED, so new actions added in the future
// inherit the safe default without needing a code change here.
//
// When enforcement triggers, we return a loud, explanatory error rather than
// silently falling back to any "active brand" state — that would introduce a
// race condition under concurrent scheduled tasks for different brands.
// ── meta_audit action → engine action ────────────────────────────────
//
// REGRESSION GUARD (2026-07-26, unreachable-engine-actions incident):
// this used to be an inline ternary chain inside the meta_audit handler,
// which meant (a) nothing outside the handler could see which engine actions
// the tool can reach, and (b) the fallthrough silently prefixed 'meta-' onto
// any unmapped value. Both properties are why an engine action with no MCP
// route stayed invisible for months. As an exported map it is testable:
// app/mcp-meta-action-reachability.test.js walks it in both directions —
// every value must be a real `case "<x>":` in autocmo-core/main.go, and every
// meta engine action must be reachable from here (or explicitly exempted).
//
// Values are the ENGINE action verbatim, not a suffix. 'aware-audience' is
// the one that proves why: its Go case carries no `meta-` prefix, so the old
// prefix-everything fallthrough could never have reached it.
const META_AUDIT_ACTION_MAP = Object.freeze({
  'list-audiences':             'meta-audit-audiences',
  'list-conversions':           'meta-audit-conversions',
  'audit-audience-rule':        'meta-audit-audience-rule',
  'audit-retargeting-cascade':  'meta-audit-retargeting-cascade',
  'audit-pixel':                'meta-audit-pixel',
  'audit-events':               'meta-audit-events',
  'audit-frequency-caps':       'meta-audit-frequency-caps',
  'audit-catalog':              'meta-audit-catalog',
  'audit-change-history':       'meta-audit-change-history',
  'audit-account-state':        'meta-audit-account-state',
  'audit-delivery-breakdown':   'meta-audit-delivery-breakdown',
  // Account inventory reads (2026-07-26).
  'list-adsets':                'meta-list-adsets',
  'list-ads':                   'meta-list-ads',
  'inspect-adset':              'meta-inspect-adset',
  'list-videos':                'meta-list-videos',
  'list-catalog-sets':          'meta-catalog-sets',
  // Which ORGANIC posts have ad spend behind them. Distinct from list-ads:
  // a boosted post is identified by source_instagram_media_id / object_story_id,
  // never by a permalink, which every IG ad has including dark posts.
  'list-boosted-posts':         'meta-boosted-posts',
  'resolve-geo':                'meta-geo-resolve',
  'aware-audience':             'aware-audience',
});

/**
 * Resolve a meta_audit action enum value to its engine action.
 * Unknown values fall back to the legacy `meta-` prefix so a new enum entry
 * that forgets a map row still behaves as it did before — the reachability
 * test is what turns that omission into a CI failure rather than a 404.
 */
function metaAuditEngineAction(action) {
  return META_AUDIT_ACTION_MAP[action] || ('meta-' + action);
}

const BRAND_OPTIONAL_ACTIONS = new Set([
  // Installer / utility
  'setup', 'version', 'update', 'subscribe', 'archive', 'dry-run',
  'api-key-setup', 'verify-key',
  // Voice + avatar management — these resources are shared across brands
  'list-voices', 'list-avatars', 'clone-voice', 'delete-voice',
  // Collective wisdom — keyed on vertical, not brand
  'wisdom',
  // Global notification channels
  'discord-login', 'discord-setup', 'discord-post',
  'slack-login', 'slack-exchange', 'slack-post',
  // OAuth login flows — user may connect globally or per-brand; the binary
  // writes to the correct scope based on whether brand was passed.
  // REGRESSION GUARD (2026-05-10, A004): pinterest-login, snapchat-login,
  // and twitter-login were dropped because their case statements were
  // also removed from main.go's action router during the v1.22.0 RSI
  // cleanup. Leaving them in this allowlist would silently let an LLM
  // call an unreachable action with no brand and get a generic "unknown
  // action" error from the binary instead of the specific BRAND_MISSING
  // envelope — confusing the agent's recovery path.
  'meta-login', 'tiktok-login', 'google-login', 'amazon-login',
  'shopify-login', 'klaviyo-login', 'etsy-login', 'reddit-login',
  'linkedin-login',
  'stripe-login',
  // AppLovin + Postscript are API-key connectors (no OAuth). The *-login
  // actions in the binary just verify the key and persist it — no brand
  // context needed for the global-scoped case.
  'applovin-max-login', 'applovin-ad-login', 'postscript-login',
  // Landing page audit takes a raw URL, no brand context needed
  'landing-audit',
  // Funnel teardown (Stefan Georgi RMBC) also URL-driven, brand-agnostic.
  'funnel-teardown',
  // Foreplay competitor ad spying — keyed on the competitor's domain/brand/ad,
  // never on the user's own brand. Output goes to <outputDir>/competitor-ads/
  // which is brand-agnostic by design (one research library across brands).
  'foreplay-brands-by-domain', 'foreplay-ads-by-brand', 'foreplay-ads-by-page',
  'foreplay-ad-duplicates', 'foreplay-download-ad', 'foreplay-usage',
  // Brand-guide validate is a pure JSON dry-run; write/read are brand-scoped.
  'validate-brand-guide',
]);

// Normalize `brand` input — empty string, undefined, and null all mean
// "not provided". Non-string values are rejected upstream by Zod but we
// defend anyway.
function isBrandMissing(brand) {
  if (brand === undefined || brand === null) return true;
  if (typeof brand !== 'string') return true;
  if (brand.trim() === '') return true;
  return false;
}

// ── Revoked-grant signal (2026-07-11 audit fix) ─────────────────────
//
// getConnections in main.js marks 'expired' by token age alone, so a grant
// revoked server-side keeps a green tile while every action 401s. runBinary
// is the single funnel for every platform action, so this is where the real
// auth outcome is observable: a result that classifies as TOKEN_EXPIRED
// flags the platform (per brand) via ctx.notePlatformAuthResult, and any
// success clears the flag. main.js persists the flag (auth-failures.js) and
// getConnections downgrades flagged platforms to 'expired' so the existing
// reconnect UX takes over.
//
// Only actions with an unambiguous platform prefix participate: aggregate
// actions (dashboard, wisdom, generate) cannot attribute a token failure to
// one platform and are intentionally unmapped. Longest prefix first.
const AUTH_SIGNAL_PLATFORM_PREFIXES = [
  ['google-analytics-', 'google'],
  ['google-ads-', 'google'],
  // Google Merchant Center rides the same Google OAuth grant.
  ['merchant-', 'google'],
  ['meta-', 'meta'],
  ['tiktok-', 'tiktok'],
  ['amazon-', 'amazon'],
  ['shopify-', 'shopify'],
  ['etsy-', 'etsy'],
  ['reddit-', 'reddit'],
  ['linkedin-', 'linkedin'],
  ['stripe-', 'stripe'],
  ['klaviyo-', 'klaviyo'],
  // Threads rides the Meta grant (no separate OAuth): a Threads token
  // failure means the Meta connection needs reconnecting.
  ['threads-', 'meta'],
];

function platformForAuthSignal(action) {
  if (typeof action !== 'string') return null;
  for (const [prefix, platform] of AUTH_SIGNAL_PLATFORM_PREFIXES) {
    if (action.startsWith(prefix)) return platform;
  }
  return null;
}

// Feed one binary result into the auth-failure store via the optional ctx
// hook. Never throws: this is telemetry for the connections panel, a bug
// here must not break the tool result path.
function noteAuthSignalFromResult(ctx, action, args, errored, text) {
  try {
    if (!ctx || typeof ctx.notePlatformAuthResult !== 'function') return;
    const platform = platformForAuthSignal(action);
    if (!platform) return;
    const brand = (args && typeof args.brand === 'string') ? args.brand : '';
    if (!errored) {
      ctx.notePlatformAuthResult(platform, brand, 'success');
      return;
    }
    const classified = errors.classifyBinaryError(text || '');
    if (classified && classified.code === 'TOKEN_EXPIRED') {
      ctx.notePlatformAuthResult(platform, brand, 'token_expired');
    }
    // Other error classes (rate limit, timeout, 5xx) say nothing about the
    // grant: leave the flag as-is.
  } catch {}
}

// ── Shared binary runner ─────────────────────────────────────

/**
 * Spawn the Merlin binary with a sanitized temp config and return
 * redacted output. This is the ONLY path from MCP tools to the binary.
 *
 * @param {object} ctx - Context from main.js (getBinaryPath, readBrandConfig, appRoot, etc.)
 * @param {string} action - Binary action name (e.g., "meta-insights")
 * @param {object} args - MCP tool input args (mapped to Command struct fields)
 * @param {object} opts - { timeout?: number }
 * @returns {Promise<{text: string, error?: boolean}>}
 */
async function runBinary(ctx, action, args, opts = {}) {
  // Hard-refuse brand-scoped actions that didn't receive a brand argument.
  // This turns what used to be a silent "empty dashboard" data corruption
  // into a loud, actionable error that pushes Claude to re-call with brand.
  // Runs BEFORE the binary-exists check so enforcement is consistent even on
  // broken installs. Intentionally NO fallback to session state — that would
  // introduce a race condition under concurrent per-brand scheduled tasks.
  if (isBrandMissing(args.brand) && !BRAND_OPTIONAL_ACTIONS.has(action)) {
    return {
      text: `Refusing ${action}: no brand specified. This action operates on brand-scoped data and cannot run without a brand. Retry the tool call with an explicit brand argument, e.g. { action: "${args.action || action}", brand: "<brand-name>" }. If multiple brands are set up, pick the one the user is asking about.`,
      error: true,
    };
  }

  // Wait for the startup ensure+version check. Scheduled tasks / chat-driven
  // tool calls that fire during app launch would otherwise race past the
  // version check and run on a stale binary — writing output to the wrong
  // directory, exactly like the bug Part A fixes. Awaiting is a no-op once
  // the check has completed; ctx.awaitStartupChecks is optional to keep
  // unit-test contexts simple.
  if (typeof ctx.awaitStartupChecks === 'function') {
    try { await ctx.awaitStartupChecks(); } catch {}
  }

  // Guard: binary version is below the minimum required by this Electron
  // release. Refuse LOUDLY so the user sees why the action failed instead
  // of watching a silent empty result pile up in the logs.
  if (typeof ctx.isBinaryTooOld === 'function' && ctx.isBinaryTooOld()) {
    return {
      text: `Engine needs to update to v${ctx.minBinaryVersion || '1.0.7'}. Check your network connection and restart Merlin.`,
      error: true,
    };
  }

  const binaryPath = ctx.getBinaryPath();
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    return { text: 'Merlin engine not found. Try reinstalling or running /update.', error: true };
  }

  // Build STRICT brand-scoped config with vault-resolved tokens.
  // REGRESSION GUARD (2026-06-30, cross-brand leak sweep): this is the ONE
  // config resolver for the entire MCP tool surface (meta_ads, dashboard,
  // truesight, every ad platform, shopify, klaviyo, stripe, …). It MUST use
  // buildStrictBrandConfig, NOT readBrandConfig. readBrandConfig is a global ⊕
  // brand overlay — plain legacy creds and non-sensitive BRAND_KEYS
  // (metaAdAccountId, shopifyStore, …) left in the global config merge into
  // EVERY brand, so an agent calling mcp__merlin__dashboard({action:'truesight',
  // brand}) or meta_ads for Brand B would receive Brand A's ad account. This is
  // the exact class as the Truesight IPC leak (main.js truesight handler, fixed
  // the same day). buildStrictBrandConfig strips ALL BRAND_KEYS from the global
  // base and overlays only the brand's own creds — no global fallback. The
  // readBrandConfig fallback below exists ONLY for unit-test contexts whose ctx
  // predates the strict resolver; production main.js always supplies it (see
  // cross-brand-config-scope.test.js which fails CI if the production ctx omits it).
  const brandName = args.brand || '';
  const resolveBrandCfg = (typeof ctx.buildStrictBrandConfig === 'function')
    ? ctx.buildStrictBrandConfig
    : ctx.readBrandConfig;
  const cfg = brandName ? resolveBrandCfg(brandName) : ctx.readConfig();

  // OAuth client secrets are handled server-side (BFF pattern).
  // The Go binary calls merlingotme.com/api/oauth/exchange directly.
  // No secrets are injected into the config from the Electron app.

  // Warm the binary's license token BEFORE entering the Promise executor.
  // The executor callback is synchronous, so `await` inside it was a
  // SyntaxError that prevented this whole module from loading via require().
  // runBinary is already async, so awaiting here is valid.
  if (ctx.ensureBinaryLicenseToken) {
    try { await ctx.ensureBinaryLicenseToken(`mcp-${action}`); } catch {}
  }

  return new Promise((resolve) => {
    if (!cfg || Object.keys(cfg).length === 0) {
      return resolve({ text: 'No configuration found. Connect a platform first.', error: true });
    }

    // Build the Command JSON from MCP args
    const cmdObj = { action };
    // Map MCP field names to binary Command struct fields
    for (const [k, v] of Object.entries(args)) {
      if (k === 'action') continue; // already set
      // Strip pipeline fields that are MCP-only — the binary doesn't know about them.
      if (k === 'idempotencyKey' || k === 'preview' || k === 'confirm_token') continue;
      if (v !== undefined && v !== null && v !== '') {
        cmdObj[k] = v;
      }
    }

    // Pipe config over stdin instead of writing it to os.tmpdir() as a
    // plaintext JSON file. The old flow wrote resolved vault secrets to
    // disk with mode 0o600 (ineffective on Windows) and relied on a
    // best-effort unlink in the exit callback — a crash/kill between write
    // and exit left secrets on disk indefinitely. With stdin the bytes
    // never leave RAM.
    //
    // The binary still needs a --config *path hint* because downstream
    // code (logActivity, activity.jsonl, output dir derivation) walks up
    // from it to find the project root. We pass the real workspace path
    // even though the binary won't read the file.
    const configPathHint = path.join(ctx.appRoot, '.claude', 'tools', 'merlin-config.json');

    const timeout = opts.timeout || 300000; // 5 min default
    const child = execFile(
      binaryPath,
      ['--config-stdin', '--config', configPathHint, '--cmd', JSON.stringify(cmdObj)],
      {
        timeout,
        cwd: ctx.appRoot,
        // Node's execFile default maxBuffer is 1MB, which SIGTERM-kills the
        // engine mid-response on large outputs (catalog pulls, insights
        // sweeps). main.js grants the same binary 32MB for its own execFile
        // sites; keep this call site in lockstep.
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        // Track for cleanup on app exit
        if (ctx.activeChildProcesses) ctx.activeChildProcesses.delete(child);

        if (err && !stdout) {
          // Binary failed with no output — redact the error message too
          const errMsg = redactOutput('', stderr || err.message);
          noteAuthSignalFromResult(ctx, action, args, true, errMsg);
          return resolve({ text: errMsg || 'Action failed. Try again.', error: true });
        }

        // Redact BOTH stdout and stderr
        const sanitized = redactOutput(stdout || '', stderr || '');
        // Revoked-grant tile signal: see noteAuthSignalFromResult above.
        noteAuthSignalFromResult(ctx, action, args, !!err, sanitized);

        // Persist the GA4 property id from a successful discover so later GA
        // calls (traffic, funnel, conversions) no longer need it passed on
        // every call (live incident 2026-07-11). runGoogleAnalyticsDiscover
        // emits GA4DiscoverResult as JSON whose PropertyID field is tagged
        // "googleAnalyticsPropertyId" precisely so this Electron path can
        // persist it — the same brand-scoped write meta-discover uses for its
        // ad-account/page/pixel ids. Brand-scoped (BRAND_KEYS + vault.go
        // brandScopedKeys) so it never leaks cross-brand. Best-effort: a parse
        // miss never fails the tool call.
        if (!err && action === 'google-analytics-discover' && brandName &&
            typeof ctx.writeBrandTokens === 'function') {
          try {
            const m = sanitized.match(/"googleAnalyticsPropertyId"\s*:\s*"(\d{1,20})"/);
            if (m && m[1]) ctx.writeBrandTokens(brandName, { googleAnalyticsPropertyId: m[1] });
          } catch { /* persistence is best-effort — never break the read */ }
        }
        // Extract artifact bundles emitted by the binary's sentinel block.
        // `cleanText` substitutes each sentinel with a markdown gallery so
        // Claude echoes the inline previews verbatim; `bundles` is the
        // structured payload for the renderer to draw a gallery card. See
        // app/artifact-parser.js for the contract (REGRESSION GUARD 2026-04-19).
        const { cleanText, bundles } = extractArtifacts(sanitized);
        resolve({
          text: cleanText || 'Done.',
          artifacts: bundles && bundles.length ? bundles : undefined,
          error: err ? true : false,
        });
      }
    );

    // Write the config JSON to stdin and close. Guarded because the
    // child may exit early (bad binary, missing exe) before we finish
    // writing; the stream emits 'error' in that case and we'd otherwise
    // crash the Electron main process.
    try {
      if (child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.write(JSON.stringify(cfg));
        child.stdin.end();
      }
    } catch {}

    if (ctx.activeChildProcesses) ctx.activeChildProcesses.add(child);
  });
}

// ── Binary-result → envelope adapter ─────────────────────────
//
// Every tool handler in this file ends with `return toEnvelope(result)`. The
// adapter classifies errors with mcp-errors and wraps successes into the
// universal envelope shape. The defineTool wrapper adds meta/cost/rendering.

function firstLine(text) {
  if (!text || typeof text !== 'string') return 'Done.';
  const idx = text.indexOf('\n');
  const line = (idx >= 0 ? text.slice(0, idx) : text).trim();
  return line || 'Done.';
}

/**
 * Convert a runBinary result into an envelope.
 *
 * @param {{text: string, error?: boolean}} result
 * @param {object} [opts] - { data?, meta?, nextSuggested?, errorNextAction? }
 *
 * REGRESSION GUARD (2026-05-10, D003): nextSuggested + errorNextAction were
 * declared on the envelope shape but never populated by any handler — so the
 * agent had no breadcrumb on what to do next after a successful spend tool
 * fired or after a budget-cap rejection. Five high-impact tools now thread
 * nextSuggested through this adapter (meta_setup_account → audit/perf,
 * meta_launch_test_ad → review_performance, meta_launch_test_batch →
 * review_performance, brand_scrape → brand_guide/brand_activate, brand_activate
 * → connection_status) and three spend tools surface "Check budget context
 * via dashboard" on error envelopes.
 */
function toEnvelope(result, opts = {}) {
  if (result && result.error) {
    const classified = errors.classifyOrFallback(result.text, result.text || 'Action failed');
    if (opts.errorNextAction && !classified.next_action) {
      classified.next_action = opts.errorNextAction;
    }
    return envelope.fail(classified, opts.meta ? { meta: opts.meta } : undefined);
  }
  const text = (result && result.text) || '';
  return envelope.ok({
    data: Object.assign(
      { summary: firstLine(text), text },
      opts.data || {},
    ),
    nextSuggested: opts.nextSuggested,
    meta: opts.meta,
  });
}

/**
 * Short-circuit helper for input-validation errors before we touch the binary.
 */
function validationEnvelope(message, data) {
  return envelope.fail(errors.makeError('INVALID_INPUT', { message }), data ? { data } : undefined);
}

// ── Tool builder ─────────────────────────────────────────────

/**
 * Build all tool definitions. Called from mcp-server.js with the SDK's
 * `tool` function and Zod (`z`) injected — avoids requiring them directly
 * (they come from the dynamic SDK import).
 */
function buildTools(tool, z, ctx) {
  const tools = [];
  // Canonical brand-name zod schema — use `brandSchema.optional()` or
  // `brandSchema.describe(...)` at every `brand: ...` input. See the
  // BRAND_NAME_PATTERN comment above for why this is defense-in-depth.
  const brandSchema = z.string().regex(BRAND_NAME_PATTERN, 'invalid brand');

  // ── connection_status ─────────────────────────────────────
  tools.push(defineTool({
    name: 'connection_status',
    description: 'Check which platforms are connected for a brand. Returns true/false per platform — never exposes tokens.',
    destructive: false,
    idempotent: true,
    costImpact: 'none',
    brandRequired: false,
    input: { brand: brandSchema.optional().describe('Brand name (uses active brand if omitted)') },
    handler: async ({ brand }) => {
      try {
        const connections = ctx.getConnections(brand || '');
        const status = {};
        const detail = {};
        for (const c of connections) {
          status[c.platform] = c.status;
        }
        // REGRESSION GUARD (2026-05-10, C001): Slack reports 'expired' when a
        // bot token exists but slackWebhookUrl is missing — that's not actually
        // expired, the user just hasn't pasted the webhook URL needed for
        // posting. Surface a 'partial' state with a human-readable explanation
        // so the renderer can paint a yellow/orange tile (token present but
        // posting unavailable) rather than a red "expired/reconnect" tile that
        // would push the user back through OAuth they've already completed.
        // Detection: if Slack came back as 'expired' but readBrandConfig shows
        // a bot token AND no webhook URL, downgrade to 'partial'.
        if (status.slack === 'expired') {
          let cfg = {};
          try {
            cfg = brand
              ? (typeof ctx.readBrandConfig === 'function' ? ctx.readBrandConfig(brand) : {})
              : (typeof ctx.readConfig === 'function' ? ctx.readConfig() : {});
          } catch { /* ignore — fall through */ }
          const hasBot = !!cfg.slackBotToken;
          const hasWebhook = !!cfg.slackWebhookUrl;
          if (hasBot && !hasWebhook) {
            status.slack = 'partial';
            detail.slack = 'Token connected; paste webhook URL to enable posting';
          }
        }
        const out = {
          summary: `Checked ${Object.keys(status).length} platforms`,
          connections: status,
        };
        if (Object.keys(detail).length > 0) out.detail = detail;
        return out;
      } catch (e) {
        return envelope.fail(errors.makeError('INTERNAL_ERROR', { message: e.message }));
      }
    },
  }, tool, z, ctx));

  // ── meta_ads (legacy multiplexer — see mcp-meta-intent.js for the 13-tool split) ─
  tools.push(defineTool({
    name: 'meta_ads',
    description: 'Manage Meta/Facebook ad campaigns — create ads, check performance, pause/scale ads, discover accounts. For new code, prefer the intent-specific tools (meta_launch_test_ad, meta_review_performance, meta_scale_winner, etc.) — they validate inputs more tightly and surface clearer errors.',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    // Stays brandRequired:false because the action enum includes 'setup',
    // 'discover', 'adlib' which legitimately operate brand-less (account
    // discovery, competitor research). Per-action enforcement lives in
    // runBinary via BRAND_OPTIONAL_ACTIONS. New code should prefer the
    // intent-specific tools (meta_launch_test_ad, meta_review_performance,
    // meta_scale_winner) which ARE brandRequired:true. (codex API audit
    // P2 #1 — flipped most tools, but multi-action tools whose enum spans
    // brand-required AND brand-optional actions stay false.)
    brandRequired: false,
    concurrency: { platform: 'meta' },
    preview: false,
    input: {
      // 'adlib' was REMOVED here on 2026-07-26. It never worked: the handler
      // built 'meta-adlib' and autocmo-core/main.go has never had that case,
      // so every call returned "unknown action" (flagged as a known gap in
      // app/mcp-action-go-parity.test.js on 2026-05-10 and left broken). Ad
      // Library research now lives on meta_research_competitor_ads, which
      // routes to the real 'competitor-scan' action. The handler below
      // refuses 'adlib' explicitly and names the replacement, because the SDK
      // does not enforce this enum at call time — dropping the value alone
      // would leave the same silent 404.
      action: z.enum(['push', 'insights', 'kill', 'activate', 'duplicate', 'setup', 'discover', 'warmup', 'retarget', 'lookalike', 'setup-retargeting', 'catalog', 'budget', 'bulk-push', 'lockdown', 'import']).describe('The operation to perform'),
      brand: brandSchema.optional().describe('Brand name'),
      adId: z.string().optional().describe('Ad ID (for kill/duplicate/lockdown)'),
      campaignId: z.string().optional().describe('Target campaign ID'),
      campaignName: z.string().optional().describe('Campaign name'),
      adImagePath: z.string().optional().describe('Path to ad image'),
      adVideoPath: z.string().optional().describe('Path to ad video'),
      adHeadline: z.string().optional().describe('Ad headline text'),
      adBody: z.string().optional().describe('Ad primary text'),
      adLink: z.string().optional().describe('Destination URL'),
      dailyBudget: z.number().optional().describe('Daily budget in DOLLARS (not cents). Example: pass 10 for $10/day, 50 for $50/day, 200 for $200/day. NEVER pre-convert to cents — Merlin handles the cents conversion internally when calling the platform\'s API. If the user says "$10 a day", pass 10. If unsure, ask the user.'),
      batchCount: z.coerce.number().int().optional().describe('Days of data (-1=today, 7=last week, 30=last month)'),
      sortBy: z.string().optional().describe('Sort results by: spend, roas, ctr, clicks, impressions, cpc, purchases'),
      sortOrder: z.string().optional().describe('Sort order: desc (default) or asc'),
      limit: z.number().optional().describe('Max results to return (e.g. 5 for top 5)'),
      // Bulk & advanced features
      //
      // REGRESSION GUARD (2026-07-25, unreachable-engine-params incident):
      // zod strips unknown keys, so any Command field NOT declared here is
      // silently dropped before runBinary ever builds the --cmd JSON, so the
      // engine capability ships but stays unreachable from the app. Live hit:
      // a bulk-push with campaignName "OrganicBoost" failed twice with
      // `campaign "OrganicBoost" not found ... or set createCampaignIfMissing`
      // and there was NO way to set it, because it wasn't in this schema.
      // Every key below must stay spelled EXACTLY as the Go `json:"..."` tag
      // on Command (main.go) / BulkAd: runBinary copies keys through
      // verbatim, so a rename on either side breaks the wire silently.
      // Locked by app/mcp-meta-param-reachability.test.js.
      ads: z.array(z.object({ imagePath: z.string().optional(), videoPath: z.string().optional(), headline: z.string().optional(), body: z.string().optional(), link: z.string().optional(), dailyBudget: z.number().optional(), hookStyle: z.string().optional(), postId: z.string().optional(), name: z.string().optional() })).optional().describe('Array of ads for bulk-push (up to 50). Each ad accepts an optional `name`, the explicit ad name shown in Ads Manager. Omit it and the ad gets an auto-generated name, which makes a batch that reuses several distinct posts impossible to tell apart in reporting.'),
      sharedAdSet: z.boolean().optional().describe('bulk-push only: put EVERY ad in ONE ad set carrying the full dailyBudget, instead of the default one-ad-set-per-ad (ABO) split. Use for cold creative testing where Meta should concentrate budget on the best creatives rather than force an equal per-ad share.'),
      adSetName: z.string().optional().describe('bulk-push shared-ad-set mode only: explicit name for the ad set that gets created. Empty = auto-named.'),
      createCampaignIfMissing: z.boolean().optional().describe('When campaignName names a campaign that does not exist, create it (objective from the brand config; ABO unless campaignBudgetMode says otherwise) instead of failing. Off by default so a typo\'d campaignName errors instead of minting a junk campaign. New campaigns are always created PAUSED.'),
      // Rule 23 reachability: both fields are copied through runBinary into
      // the --cmd JSON and read by Command.CampaignBudgetMode /
      // Command.CampaignDailyBudget (see metaCreateCampaign in meta.go).
      campaignBudgetMode: z.string().optional().describe('Budget mode for a campaign created by createCampaignIfMissing. \'cbo\' puts the daily budget on the CAMPAIGN - Meta then DISCARDS ad-set budgets, so do NOT also pass dailyBudget (the engine hard-errors on that combination). Omitted or anything else means ABO, with the budget on the ad set.'),
      campaignDailyBudget: z.number().optional().describe('Campaign-level daily budget in DOLLARS. Read only under campaignBudgetMode \'cbo\', where it is the real spend governor and is validated against maxDailyAdBudget - an over-cap value is refused, never silently clamped.'),
      adFormat: z.enum(['single', 'carousel', 'collection']).optional().describe('Ad format (default: single)'),
      carouselCards: z.array(z.object({ imagePath: z.string().optional(), videoPath: z.string().optional(), headline: z.string().optional(), description: z.string().optional(), link: z.string().optional() })).optional().describe('Carousel card data (2-10 cards)'),
      postId: z.string().optional().describe('Existing post ID to reuse as ad creative (preserves social proof)'),
      languages: z.array(z.string()).optional().describe('ISO 639-1 codes for multi-language variants (e.g. ["es","fr","de"])'),
      // NOT a launch-status control. The refusal lives in the handler below;
      // the engine only reads cmd.Status on meta-import.
      status: z.string().optional().describe('READ FILTER for action:"import" ONLY. One of active, paused, all. This does NOT set the status new ads launch with; passing status:"PAUSED" on push/bulk-push is refused rather than silently ignored. Launch status comes from the brand config key metaLaunchStatus (default ACTIVE).'),
    },
    handler: async (args) => {
      // Cents-detection guard (defense-in-depth; binary has its own cap).
      const budgetError = validateBudget(ctx, args, 'Meta');
      if (budgetError) return validationEnvelope(budgetError);

      // REGRESSION GUARD (2026-07-25, status-is-not-launch-status):
      // `status` reads as "the status to launch with" but the engine only
      // consumes cmd.Status on meta-import (runMetaImport's effective_status
      // read filter). On every other action it was a SILENT no-op, so a
      // caller passing status:"PAUSED" on a bulk-push got live ads spending
      // real money while believing they were staged. Refuse loudly instead:
      // the failure mode of the silent version is unexpected ad spend, and
      // there is no per-call launch-status override to fall back on
      // (getMetaLaunchStatus reads the brand config key metaLaunchStatus).
      // Nothing that works today breaks, because the engine ignored this field on
      // these actions anyway.
      if (args.status !== undefined && args.status !== null && args.status !== '' && args.action !== 'import') {
        return validationEnvelope(
          `meta_ads: \`status\` is a read filter for action:"import" only. It does NOT control the status ads launch with, and passing it on "${args.action}" would be silently ignored. ` +
          'To launch ads paused, set the brand config key `metaLaunchStatus` to "PAUSED" (default is "ACTIVE"), then re-run. ' +
          'Otherwise retry without `status`.'
        );
      }

      // See the enum comment above: 'adlib' has never been routable. Refuse it
      // by name so the agent gets a recovery path instead of "unknown action".
      if (args.action === 'adlib') {
        return validationEnvelope(
          'meta_ads action "adlib" does not exist and never has — the Meta Ad Library is not reachable from this tool. ' +
          'Use mcp__merlin__meta_research_competitor_ads({brand, competitors: ["Name One","Name Two"]}) instead.'
        );
      }

      const action = 'meta-' + (args.action === 'setup-retargeting' ? 'setup-retargeting' : args.action);
      const result = await runBinary(ctx, action, args);

      // After discover: parse the JSON output and auto-save the discovered
      // ad account, page, and pixel IDs to the brand config. The binary
      // prints these for "Claude to parse and write into config" — but Claude
      // can't write config files (hooks block it). So we do it here.
      if (args.action === 'discover' && !result.error && result.text) {
        try {
          const jsonMatch = result.text.match(/\{[\s\S]*"adAccountId"[\s\S]*\}/);
          if (jsonMatch) {
            const discovered = JSON.parse(jsonMatch[0]);
            const brandName = args.brand || '';
            const updates = {};
            if (discovered.adAccountId) updates.metaAdAccountId = discovered.adAccountId;
            if (discovered.pageId) updates.metaPageId = discovered.pageId;
            if (discovered.pixelId) updates.metaPixelId = discovered.pixelId;
            if (Object.keys(updates).length > 0) {
              if (brandName) {
                ctx.writeBrandTokens(brandName, updates);
              } else {
                const cfg = ctx.readConfig();
                Object.assign(cfg, updates);
                ctx.writeConfig(cfg);
              }
            }
          }
        } catch (e) {
          console.error('[meta-discover] Failed to auto-save IDs:', e.message);
        }
      }

      return toEnvelope(result);
    },
  }, tool, z, ctx));

  // ── Meta intent tools (new surface — see mcp-meta-intent.js) ─
  //
  // Every operation the legacy meta_ads multiplexer does is also exposed as
  // a narrow intent tool with tight schemas and per-action preview gating.
  // meta_ads stays for backwards compatibility; new agent code should prefer
  // the intent tools because they fail fast on bad inputs and surface clear
  // blast-radius confirmations.
  for (const t of buildMetaIntentTools({
    tool, z, ctx, defineTool, runBinary,
    validateBudget: (ctx, args, platformLabel) => validateBudget(ctx, args, platformLabel),
  })) {
    tools.push(t);
  }

  // ── meta_audit (read-only inspection) ───────────────────────
  //
  // Inspection layer for Meta assets — gives Merlin (and the user via natural
  // language) the ability to interrogate audiences, conversions, pixels,
  // retargeting cascades, frequency caps, and catalogs WITHOUT a trip to Ads
  // Manager. Every action is a GET on the Graph API; no writes by
  // construction (see autocmo-core/meta_audit.go file header).
  //
  // Action surface:
  //   list-audiences          — every custom audience on the ad account, sorted
  //                              newest-first, with operation/delivery status
  //                              and approximate count.
  //   audit-audience-rule     — full targeting rule for one audience (raw JSON
  //                              preserved). Pass the audience id via adId.
  //   audit-retargeting-cascade — walks active ad sets, cross-references
  //                              custom_audiences ∪ excluded_custom_audiences,
  //                              flags the classic "include site visitors,
  //                              forget to exclude purchasers" leak.
  //   list-conversions        — every custom conversion + when each last fired.
  //   audit-pixel             — pixel health: last_fired_time, automatic
  //                              matching status, top events over 7d, plus
  //                              match-rate-approx where the Marketing API
  //                              still exposes it. Flags never-fired pixels,
  //                              automatic matching disabled, no Purchase
  //                              events in last 7d. server_events_match_rate
  //                              was deprecated by Meta and is no longer
  //                              requested — use audit-events for per-event
  //                              match quality instead.
  //   audit-events            — per-event Event Match Quality (EMQ) — the
  //                              0-10 score Meta displays in Events Manager →
  //                              Data Sources. Returns a row per event with
  //                              Grade (Great ≥8 / Good ≥6 / Low <6), event
  //                              count over 7d, and plain-English findings
  //                              ("Match quality is low — turn on Automatic
  //                              Advanced Matching, verify CAPI sends hashed
  //                              email + phone"). Use this to answer "is my
  //                              pixel set up right" / "audit my events" /
  //                              "check EMQ".
  //   audit-frequency-caps    — every active ad set's frequency_control_specs;
  //                              flags ad sets with no cap (fatigue risk).
  //   audit-catalog           — review status counts + top disapproval reasons
  //                              + sample of disapproved products. Pass the
  //                              catalog id via catalogId.
  //
  // REGRESSION GUARD (2026-07-26, unreachable-engine-actions incident):
  // the seven list-*/inspect-*/resolve-*/aware-audience actions below were
  // shipped in the ENGINE (autocmo-core/main.go dispatcher) with no MCP tool
  // routing to them at all — one level up from the 2026-07-25 unreachable-PARAM
  // incident that produced app/mcp-meta-param-reachability.test.js. An action
  // no tool names is not merely undiscoverable, it is unreachable: there is no
  // arg spelling that gets you there. `meta-list-adsets` in particular is the
  // read the F21 / RIPIT / Rebecca Taylor workflows need constantly ("which ad
  // sets exist, and are the staged ones actually PAUSED?") and it had no path
  // through the app for its entire life.
  //
  // meta_audit is the right home for all of them: read-only by construction,
  // already the inspection surface, and no widening of the legacy meta_ads
  // multiplexer. Every enum value below MUST have a matching branch in the
  // handler's action map — an unmapped value falls through to `meta-<value>`,
  // which is right for some and wrong for aware-audience (no meta- prefix).
  // Locked by app/mcp-meta-action-reachability.test.js.
  //
  // No budget validation needed (read-only, no spend impact). preview is
  // false because it's safe-by-construction — the agent can call any action
  // without a confirmation card.
  tools.push(defineTool({
    name: 'meta_audit',
    description: 'Inspect Meta ad assets — list custom audiences and custom conversions, read the targeting rule of an audience, audit your retargeting cascade for the "forgot to exclude purchasers" leak, run pixel diagnostics (last fired time, automatic matching status, top events, match rate where available), audit per-event Event Match Quality (EMQ) scores so the user can see exactly which events have a Low / Good / Great match grade and what to fix (mirrors the EMQ column in Events Manager → Data Sources), list frequency caps across active ad sets, and audit a product catalog\'s review status. Also the account INVENTORY surface: list-adsets returns every ad set with its parent campaign id/name/status, its own effective status, optimization goal, daily budget and destination link (pass status:"paused" to find staged drafts, status:"all" for everything) — this is how you verify a campaign really was staged PAUSED before anyone activates it; list-ads returns the ads inside one ad set with their creative format and per-placement image hashes; inspect-adset dumps one ad set\'s full settings plus a sample creative\'s toggles so a new ad set can be built to match a proven winner; list-videos lists videos already uploaded to the ad account; list-catalog-sets lists a catalog\'s product sets and feeds (this is where the productSetId for DPA setup comes from); resolve-geo checks that US state names resolve to Meta region keys before a geo-targeted build; aware-audience returns the tiered warm/addressable audience pool (the retargeting-readiness leading indicator). All actions are READ-ONLY GETs against the Graph API — never writes, never spend impact. Use when the user says "audit my retargeting", "what\'s my pixel match quality", "audit my events setup", "check my EMQ", "list my custom audiences", "what ad sets do I have", "are those campaigns actually paused", "show me the ads in that ad set", "what videos are uploaded", "what product sets exist", or "is my catalog healthy".',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: false,
    input: {
      action: z.enum([
        'list-audiences',
        'audit-audience-rule',
        'audit-retargeting-cascade',
        'list-conversions',
        'audit-pixel',
        'audit-events',
        'audit-frequency-caps',
        'audit-catalog',
        'audit-change-history',
        'audit-account-state',
        'audit-delivery-breakdown',
        // Account inventory reads (2026-07-26). Engine actions that existed
        // for months with no MCP route — see the REGRESSION GUARD above.
        'list-adsets',
        'list-ads',
        'inspect-adset',
        'list-videos',
        'list-catalog-sets',
        'resolve-geo',
        'aware-audience',
        'list-boosted-posts',
      ]).describe('The audit operation to perform. All actions read-only. audit-events surfaces per-event Event Match Quality (EMQ) scores (0-10, graded Great/Good/Low) from Meta\'s Dataset Quality API plus actionable fix advice for any event below 8.0. audit-change-history pulls the account Change History (who changed what, when — budget/bid/status/audience edits flagged, old→new values) to trace a delivery shift to a specific edit vs. the auction; pass windowDays to look back further than 7. audit-delivery-breakdown pulls insights sliced by day (to pinpoint WHEN delivery moved) and/or by dimension via breakdowns= (WHERE it moved). audit-account-state reads account_status, disable_reason, and spend-cap-vs-spent to rule out an account-level stall. list-adsets is the account inventory read: every ad set with parent campaign id/name/status, its own effective status, optimization goal, daily budget and destination link — pass status:"paused" to locate staged drafts, status:"all" to see everything (default "active"). list-ads lists the ads inside ONE ad set (pass targetAdSetId) with creative format and per-placement image hashes. inspect-adset dumps one ad set\'s settings plus a sample creative\'s toggles for cloning a winner (pass the AD SET id via adId). list-videos lists videos already uploaded to the ad account. list-catalog-sets lists a catalog\'s product sets + feeds (pass catalogId) — the source of the productSetId that meta_dpa_setup takes. resolve-geo resolves US state names in geoRegions AND city names in geoCities (\"Dallas, TX\") to Meta keys so a geo build can be verified before it runs; city names are not unique, so it reports the resolved city with its state. aware-audience returns the tiered warm/addressable audience pool. list-boosted-posts lists every ORGANIC social post the account has run ads against, deduped, with a link to each and the ads using it (answers \"which of our posts have we put spend behind?\"); it identifies a boost by source_instagram_media_id or object_story_id, never by instagram_permalink_url, which every Instagram-placed ad carries including dark posts that were never published organically.'),
      brand: brandSchema.describe('Brand name for vault-scoped Meta credentials.'),
      adId: z.string().optional().describe('For audit-audience-rule: the custom-audience numeric id. For audit-pixel and audit-events: optional pixel id override (defaults to brand cfg metaPixelId). For inspect-adset: the AD SET id to inspect.'),
      targetAdSetId: z.string().optional().describe('For list-ads: the ad set whose ads to list. Falls back to adId when omitted.'),
      geoRegions: z.array(z.string()).optional().describe('For resolve-geo: US state names to resolve to Meta region keys (e.g. ["Florida","New Jersey"]). Verifies the keys before a geo-targeted build rather than discovering a bad name mid-push.'),
      geoCities: z.array(z.string()).optional().describe('For resolve-geo: US city names to resolve to Meta city keys, optionally disambiguated as "City, ST" (e.g. ["Dallas, TX"]). City names are NOT unique (there are four US Dallases), so the resolved city AND its state are reported; a state hint that matches nothing errors rather than silently targeting another state. Combines with geoRegions as a union.'),
      geoCityRadius: z.number().optional().describe('Targeting radius in MILES around each geoCities entry. Default 25. Meta requires a radius on city targeting.'),
      agentName: z.string().optional().describe('For audit-events: the Conversions API integration\'s agent name, used to scope Meta\'s Dataset Quality API EMQ query. Find it in Events Manager → Data Sources → your dataset → the integration\'s name (e.g. the Shopify/Stape/Elevar/GTM integration). Optional — if omitted Merlin still attempts the query and tells the user how to find it.'),
      catalogId: z.string().optional().describe('For audit-catalog and list-catalog-sets: the Meta product catalog id (find it via mcp__merlin__meta_ads({action:"catalog"}) or in Commerce Manager). list-catalog-sets falls back to the ad account\'s owning business when omitted.'),
      // 'paused' was added for list-adsets (2026-07-26): locating a STAGED
      // draft ad set is the whole point of that read, and 'active'|'all' alone
      // cannot express it. audit-retargeting-cascade / audit-frequency-caps
      // treat any non-"all" value as their "active" default, so widening the
      // enum cannot change what those two actions return.
      status: z.enum(['active', 'paused', 'all']).optional().describe('Ad-set status filter. For list-adsets: "active" (default) | "paused" (non-active only — use this to find staged drafts) | "all". For audit-retargeting-cascade and audit-frequency-caps: "active" (default) or "all".'),
      limit: z.number().optional().describe('Max records to return per page. Defaults: list-audiences=250, list-conversions=100, audit-catalog=200, list-videos=25. Hard caps: 500 (list-videos: 200).'),
      windowDays: z.number().optional().describe('For audit-change-history and audit-delivery-breakdown: lookback window in days. Default 7. Use e.g. 30 to trace a change further back.'),
      timeIncrement: z.number().optional().describe('For audit-delivery-breakdown: insights bucket size in days. 1 = daily (default, to see WHICH day delivery moved). Pass -1 for a single aggregate window.'),
      breakdowns: z.string().optional().describe('For audit-delivery-breakdown: comma-separated dimensions to slice by (allow-listed): publisher_platform, platform_position, device_platform, impression_device, age, gender, country, region, dma. Unknown values are dropped.'),
      level: z.enum(['account', 'campaign', 'adset', 'ad']).optional().describe('For audit-delivery-breakdown: aggregation level. Default account.'),
    },
    handler: async (args) => {
      const action = metaAuditEngineAction(args.action);
      return toEnvelope(await runBinary(ctx, action, args));
    },
  }, tool, z, ctx));

  // ── google_analytics ───────────────────────────────────
  // GA4 read + write surface. Eight READ actions inspect a property
  // (discover/traffic/conversions/attribution/landing-pages/audit-property/
  // realtime/funnel); eight WRITE actions program the measurement plan
  // (create/archive key events, create custom dimensions/metrics, create
  // audiences, update property settings, update data-stream Enhanced
  // Measurement, attach the standard Shopify ecommerce events).
  //
  // update-stream-settings is the remediation half of audit-property: the
  // audit already reports "Enhanced Measurement off" as a finding, and
  // before this action the only fix was manual work in the GA4 console.
  //
  // SAFETY MODEL: destructive: true because the tool ships writes. preview
  // is gated PER-ACTION via blastRadius below: the eight write actions
  // require the approval-card → confirm_token round-trip, the read
  // actions skip it. The Go binary's analytics.go ALSO refuses any write
  // unless cmd.Approved is true (Hard-Won Security Rule 18) — defense in
  // depth so a bypass at this layer still hits the binary's check. The
  // handler does NOT auto-set args.approved; the renderer's approval card
  // supplies it on user click.
  //
  // GA4 has no API for funnel explorations themselves — those live in the
  // Explorations workspace UI. What IS programmable, and what makes
  // funnels POSSIBLE, is the underlying measurement plan. The write
  // actions automate that plan so brands can skip the manual click-through
  // GA4 otherwise requires.
  tools.push(defineTool({
    name: 'google_analytics',
    description: 'Read + write Google Analytics 4. READ: discover property + measurement IDs, pull traffic (sessions/users/engagement) by date or channel, list key conversion events with revenue, compare first-touch vs last-touch attribution by channel, walk landing pages with per-URL engagement metrics (auto-populates seo-signals.json), audit a property for health (key events, data stream, enhanced measurement, industry category), pull realtime activity (last 30 min by country / page / device — no date range), or run a funnel report against ordered event steps (defaults to the standard DTC ecommerce funnel: view_item → add_to_cart → begin_checkout → purchase). WRITE (programmatic measurement-plan setup that powers funnel explorations in the GA4 UI): create-key-event marks an event as a conversion; create-custom-dimension / create-custom-metric add reportable fields scoped to event/user/item; create-audience defines a cohort for funnel comparison; update-property-settings patches industry category / time zone / currency / display name; update-stream-settings turns Enhanced Measurement on or off per signal on a web data stream (master switch plus scrolls, outbound clicks, site search, video engagement, file downloads, form interactions, and page changes for single-page-app route tracking) and is the fix for the "Enhanced Measurement off" finding audit-property reports; attach-shopify-events one-click wires the standard ecommerce funnel (purchase / add_to_cart / begin_checkout / view_item / view_item_list / search / sign_up / generate_lead) idempotently. Every write requires an approval card — the renderer prompts the user before the call lands. Use when the user says "how is organic traffic", "sessions last week", "what\'s converting in GA", "who is on my site right now", "live visitors", "where is my checkout funnel leaking", "audit my GA4 property", "set up my GA4 conversions", "wire up GA4 for shopify", "mark X as a conversion", "create a GA4 audience for cart abandoners", "fix my GA4 timezone", "turn on enhanced measurement", or "GA4 is not tracking my quiz steps / SPA page views".',
    destructive: true,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'google_analytics' },
    preview: true,
    // Per-action gating: only the seven write actions require the approval
    // card. Read actions return { required: false } and pass straight through
    // the foundation's preview gate (mcp-define-tool.js).
    blastRadius: (payload) => {
      const writeActions = new Set([
        'create-key-event',
        'archive-key-event',
        'create-custom-dimension',
        'create-custom-metric',
        'create-audience',
        'update-property-settings',
        'update-stream-settings',
        'attach-shopify-events',
      ]);
      if (writeActions.has(payload && payload.action)) {
        const reasons = {
          'create-key-event':            'Mark a GA4 event as a conversion',
          'archive-key-event':           'Un-mark a GA4 event as a conversion',
          'create-custom-dimension':     'Add a GA4 custom dimension',
          'create-custom-metric':        'Add a GA4 custom metric',
          'create-audience':             'Create a GA4 audience',
          'update-property-settings':    'Patch GA4 property settings',
          'update-stream-settings':      'Change which visitor interactions GA4 measures automatically on the website',
          'attach-shopify-events':       'Mark the 8 standard ecommerce events as GA4 conversions (idempotent)',
        };
        return { required: true, reason: reasons[payload.action], action: payload.action };
      }
      return { required: false };
    },
    input: {
      action: z.enum([
        // Read
        'discover', 'traffic', 'conversions', 'attribution', 'landing-pages', 'audit-property',
        'realtime', 'funnel',
        // Write — measurement plan setup
        'create-key-event', 'archive-key-event',
        'create-custom-dimension', 'create-custom-metric',
        'create-audience',
        'update-property-settings',
        'update-stream-settings',
        'attach-shopify-events',
      ]).describe('Operation to perform. Read actions are safe; write actions surface an approval card.'),
      brand: brandSchema,
      batchCount: z.coerce.number().int().optional().describe('Days of data (positive integer; default 7). Negative interpreted as today only. Read actions only. Ignored by realtime (always last 30 min).'),
      level: z.string().optional().describe('For traffic: "date" (default) or "channel". For realtime: "country" (default), "page", or "device".'),
      limit: z.number().optional().describe('Max rows to return (clamps to 1000).'),
      analyticsFunnelSteps: z.array(z.string()).optional().describe('For funnel: ordered list of GA4 event names (≥2). Empty → standard DTC ecommerce funnel: view_item → add_to_cart → begin_checkout → purchase.'),
      analyticsPropertyId: z.string().optional().describe('Per-call override for the configured GA4 property. Useful for agencies running against multiple properties under one Google account.'),
      // ── Write fields ─────────────────────────────────────────
      analyticsEventName: z.string().optional().describe('For create-key-event: the event name (e.g. "purchase", "sign_up").'),
      analyticsCountingMethod: z.enum(['ONCE_PER_EVENT', 'ONCE_PER_SESSION']).optional().describe('Default ONCE_PER_EVENT.'),
      analyticsDefaultValue: z.number().optional().describe('Default conversion value for revenue tagging on create-key-event.'),
      analyticsParameterName: z.string().optional().describe('For create-custom-dimension / create-custom-metric: the GA4 event parameter name to map.'),
      analyticsDisplayName: z.string().optional().describe('Human-readable name shown in GA4 UI.'),
      analyticsDescription: z.string().optional().describe('Optional description for create-* actions.'),
      analyticsScope: z.enum(['EVENT', 'USER', 'ITEM']).optional().describe('Custom dimension scope (default EVENT). Custom metrics are EVENT-only.'),
      analyticsMeasurementUnit: z.enum(['STANDARD', 'CURRENCY', 'FEET', 'METERS', 'KILOMETERS', 'MILES', 'MILLISECONDS', 'SECONDS', 'MINUTES', 'HOURS']).optional().describe('Custom metric unit.'),
      analyticsAudience: z.any().optional().describe('Full Audience resource body (filterClauses, membershipDurationDays, displayName, etc). Open-ended JSON — passed through to the GA4 Admin API verbatim.'),
      analyticsKeyEventName: z.string().optional().describe('For archive-key-event: the GA4 event name (or full keyEvents resource path).'),
      patchBody: z.record(z.any()).optional().describe('For update-property-settings: field map. Allowed: industryCategory, timeZone, currencyCode, displayName.'),
      analyticsStreamId: z.string().optional().describe('For update-stream-settings: which GA4 data stream to patch. Bare numeric id or full "properties/{p}/dataStreams/{s}" path. Omit when the property has exactly one web stream; the engine resolves it and refuses to guess when there are several.'),
      analyticsStreamSettings: z.record(z.boolean()).optional().describe('For update-stream-settings: sparse map of Enhanced Measurement toggles. Keys: streamEnabled (master switch), scrollsEnabled, outboundClicksEnabled, siteSearchEnabled, videoEngagementEnabled, fileDownloadsEnabled, formInteractionsEnabled, pageChangesEnabled (SPA route changes). Only the keys you pass are changed. Turning on a sub-signal while the master switch is off is refused, since it would collect nothing. Include streamEnabled:true in the same call.'),
      approved: z.boolean().optional().describe('Approval flag for write actions. Set by the Electron approval card; set true here only with explicit user approval to proceed.'),
    },
    // Handler does NOT auto-set args.approved — that bypasses the safety
    // rail. The renderer's approval card supplies it on user click. For
    // tests, runBinary accepts args.approved and passes it through to the
    // binary as cmd.Approved.
    handler: async (args) => toEnvelope(await runBinary(ctx, 'google-analytics-' + args.action, args)),
  }, tool, z, ctx));

  // ── google_tag_manager ─────────────────────────────────
  //
  // Reads are open; the three write actions surface an approval card. The
  // blast radius here is larger than any other tool in this file: publishing
  // changes what JavaScript runs on a paying customer's live website. The
  // reasons below are written for a non-technical reader, because the card is
  // the last thing standing between an agent and a live site.
  tools.push(defineTool({
    name: 'google_tag_manager',
    description: 'Audit and instrument Google Tag Manager. READ: discover lists the GTM accounts and containers this Google login can reach (never auto-selects one — a single login often reaches several brands); audit diagnoses the container and is the highest-value action here, catching duplicate conversion tags that double-count revenue and inflate ROAS, missing GA4 configuration, tags that can never fire because they have no trigger, tracking IDs that disagree with the rest of Merlin, likely PII capture, and missing consent settings, plus a funnel-coverage report showing which of view_item / add_to_cart / begin_checkout / purchase are actually instrumented; list-versions shows what is live and the change history. WRITE (each needs approval, and nothing reaches the live site implicitly): install-ga4 stages a full GA4 ecommerce funnel into a separate "Merlin (staged)" workspace and reports the dataLayer events the site still has to push; create-version snapshots that workspace WITHOUT publishing; publish makes a named version live. Merlin never creates Custom HTML tags. Use when the user says "why are there no conversions", "my tracking is broken", "audit my tag manager", "set up conversion tracking", "instrument the funnel", "is my pixel firing", or "why is revenue double counted".',
    destructive: true,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'google_tag_manager' },
    preview: true,
    blastRadius: (payload) => {
      const reasons = {
        'install-ga4':    'Stage GA4 funnel tags in a separate Merlin workspace (NOT live until you publish)',
        'install-quiz-funnel': 'Stage per-step questionnaire tracking in a separate Merlin workspace (NOT live until you publish)',
        'create-version': 'Snapshot the staged workspace as a container version (NOT live until you publish)',
        'publish':        'PUBLISH to the live website — this changes what runs on every page for real visitors',
      };
      const action = payload && payload.action;
      if (Object.prototype.hasOwnProperty.call(reasons, action)) {
        return { required: true, reason: reasons[action], action };
      }
      return { required: false };
    },
    input: {
      action: z.enum([
        // Read
        'discover', 'audit', 'list-versions',
        // Write — staged, then versioned, then published; each separately approved
        'install-ga4', 'install-quiz-funnel', 'create-version', 'publish',
      ]).describe('Operation to perform. Read actions are safe; write actions surface an approval card. Nothing affects the live site until publish.'),
      brand: brandSchema,
      gtmAccountId: z.string().optional().describe('GTM account id from discover. Required once you have more than one.'),
      gtmContainerId: z.string().optional().describe('GTM container id from discover. Merlin never guesses this: one Google login commonly reaches several brand containers, and writing tags to the wrong website is silent.'),
      gtmWorkspaceId: z.string().optional().describe('Optional workspace override. Defaults to the Merlin staging workspace, then the container default.'),
      gtmMeasurementId: z.string().optional().describe('For install-ga4: the GA4 measurement id in G-XXXXXXX form (from Admin, Data Streams). Defaults to the configured value for the brand. A numeric property id is a DIFFERENT identifier and will be rejected.'),
      gtmStepSelector: z.string().optional().describe('For install-quiz-funnel: CSS selector for the element clicked to advance a step. Defaults to button[data-question-index].'),
      gtmStepAttribute: z.string().optional().describe('For install-quiz-funnel: the attribute on that element holding the step number. Defaults to data-question-index.'),
      versionName: z.string().optional().describe('For create-version: a human label for the snapshot.'),
      versionId: z.string().optional().describe('For publish: the exact version id to make live. Required — publishing "whatever is latest" is how an unreviewed change reaches a live site.'),
      approved: z.boolean().optional().describe('Approval flag for write actions. Set by the Electron approval card; set true here only with explicit user approval to proceed.'),
    },
    // Handler does NOT auto-set args.approved — that bypasses the safety rail.
    handler: async (args) => toEnvelope(await runBinary(ctx, 'gtm-' + args.action, args)),
  }, tool, z, ctx));

  // ── tiktok_ads ───────────────────────────────────────────
  tools.push(defineTool({
    name: 'tiktok_ads',
    description: 'Manage TikTok ad campaigns — create ads, check performance, pause/scale ads.',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'tiktok' },
    preview: false,
    input: {
      action: z.enum(['push', 'insights', 'kill', 'duplicate', 'setup', 'lookalike']).describe('The operation to perform'),
      brand: brandSchema,
      adId: z.string().optional(),
      campaignId: z.string().optional(),
      dailyBudget: z.number().optional(),
      adImagePath: z.string().optional(),
      adVideoPath: z.string().optional(),
      adHeadline: z.string().optional(),
      adBody: z.string().optional(),
      adLink: z.string().optional(),
      batchCount: z.coerce.number().int().optional().describe('Days of data (-1=today, 7=last week, 30=last month)'),
      sortBy: z.string().optional().describe('Sort results by: spend, roas, ctr, clicks'),
      limit: z.number().optional().describe('Max results to return'),
    },
    handler: async (args) => {
      const budgetError = validateBudget(ctx, args, 'TikTok');
      if (budgetError) return validationEnvelope(budgetError);
      return toEnvelope(await runBinary(ctx, 'tiktok-' + args.action, args));
    },
  }, tool, z, ctx));

  // ── google_ads ───────────────────────────────────────────
  tools.push(defineTool({
    name: 'google_ads',
    description: 'Manage Google Ads campaigns — create, check performance, pause/scale.',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'google' },
    preview: false,
    input: {
      action: z.enum(['push', 'insights', 'kill', 'duplicate', 'setup', 'status']).describe('Operation'),
      brand: brandSchema,
      adId: z.string().optional(),
      campaignId: z.string().optional(),
      adImagePath: z.string().optional(),
      adHeadline: z.string().optional(),
      adBody: z.string().optional(),
      adLink: z.string().optional().describe('Final URL'),
      dailyBudget: z.number().optional(),
      batchCount: z.coerce.number().int().optional().describe('Days of data (-1=today, 7=last week, 30=last month)'),
      sortBy: z.string().optional().describe('Sort results by: spend, roas, ctr, clicks, conversions'),
      limit: z.number().optional().describe('Max results to return'),
    },
    handler: async (args) => {
      const budgetError = validateBudget(ctx, args, 'Google Ads');
      if (budgetError) return validationEnvelope(budgetError);
      return toEnvelope(await runBinary(ctx, 'google-ads-' + args.action, args));
    },
  }, tool, z, ctx));

  // ── amazon_ads ───────────────────────────────────────────
  tools.push(defineTool({
    name: 'amazon_ads',
    description: 'Manage Amazon Advertising — Sponsored Products, orders, product status.',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'amazon' },
    preview: false,
    input: {
      action: z.enum(['push', 'insights', 'kill', 'setup', 'status', 'products', 'orders']).describe('Operation'),
      brand: brandSchema,
      adId: z.string().optional(),
      campaignId: z.string().optional(),
      dailyBudget: z.number().optional(),
      batchCount: z.coerce.number().int().optional().describe('Days of data'),
    },
    handler: async (args) => {
      const budgetError = validateBudget(ctx, args, 'Amazon');
      if (budgetError) return validationEnvelope(budgetError);
      // REGRESSION GUARD (2026-05-10, A002): the prior code computed the
      // binary action via a conditional prefix swap on a hardcoded
      // ['products','orders'] list. Adding a new read-only action (e.g.
      // 'inventory') would silently route to amazon-ads-inventory and 404,
      // because the conditional defaults to the ads prefix on miss. The
      // explicit map below mirrors the actionMap pattern used by seo /
      // content / voice / competitor_spy and fails loudly with
      // INVALID_INPUT when the action is unknown.
      const actionMap = {
        'products': 'amazon-products',
        'orders':   'amazon-orders',
        'status':   'amazon-ads-status',
        'setup':    'amazon-ads-setup',
        'push':     'amazon-ads-push',
        'insights': 'amazon-ads-insights',
        'kill':     'amazon-ads-kill',
      };
      if (!actionMap[args.action]) return validationEnvelope(`Unknown amazon_ads action: ${args.action}`);
      return toEnvelope(await runBinary(ctx, actionMap[args.action], args));
    },
  }, tool, z, ctx));

  // ── shopify ──────────────────────────────────────────────
  tools.push(defineTool({
    name: 'shopify',
    description: 'Shopify store data — products, orders, analytics, customer cohorts, import.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'shopify' },
    input: {
      action: z.enum(['products', 'orders', 'import', 'analytics', 'cohorts']).describe('Operation'),
      brand: brandSchema,
      batchCount: z.coerce.number().int().optional().describe('Days of data (for analytics/orders)'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'shopify-' + args.action, args)),
  }, tool, z, ctx));

  // ── klaviyo ──────────────────────────────────────────────
  // Action surface:
  //   performance | lists | campaigns                    → reporting (read-only)
  //   templates-list | template-get | template-create    → email template CRUD
  //   template-update | template-delete
  //   templates-bulk-upload                              → folder of HTML → many
  //                                                        templates in one call
  //
  // FLOW CAVEAT (live 2026-04-29 incident, Ryan / POG): Klaviyo Flows
  // themselves are NOT API-creatable. The public API exposes flow read +
  // status toggle, but flow construction (trigger, branches, time delays,
  // message slot wiring) is UI-only as of revision 2024-10-15. After
  // bulk-upload, the user wires Flows in the Klaviyo UI and selects from
  // the templates we just uploaded by name. The merlin-social SKILL.md
  // surfaces this manual step explicitly so the LLM never tells the user
  // "I created your flows" — that would be confabulation.
  //
  // Action-specific argument requirements (validated server-side in the
  // binary; the zod schema here is the broader surface — Zod doesn't
  // express "field required when action=X" cleanly, so we keep all
  // template fields optional and let the binary fail loudly with the
  // exact missing-field message):
  //   templates-list           — no extra args
  //   template-get             — templateId
  //   template-create          — templateName, htmlContent
  //   template-update          — templateId, plus templateName and/or htmlContent
  //   template-delete          — templateId
  //   templates-bulk-upload    — brand (REQUIRED — directory must be inside
  //                              assets/brands/<brand>/), dir, optional
  //                              nameTemplate ("POG / 01-welcome / {basename}"),
  //                              optional applyTokens (default true)
  //
  // Flow API surface (added 2026-04-29, v1.20.7 — closes the gap that the
  // prior klaviyo_templates.go HISTORY block + merlin-social SKILL incorrectly
  // documented as "UI-only"):
  //   flows-list               — no extra args (returns id/name/status/trigger_type/created/updated)
  //   flow-get                 — flowId, optional includeDefinition (default true)
  //   flow-create              — flowBody {name, trigger:{type,...}, steps:[{type,...}]}
  //                              CAN-SPAM gate runs BEFORE HTTP — refused if violated.
  //   flow-update-status       — flowId, status (draft|manual|live)
  //   flow-delete              — flowId
  //   flows-bulk-import        — manifestPath (must live under
  //                              assets/brands/<brand>/email/), brand (REQUIRED),
  //                              optional forceReimport. Reads
  //                              {manifest_version, brand, flows:[...]}.
  //                              Per-flow CAN-SPAM gate refuses violators
  //                              with verbatim rule reasons; sequential POST
  //                              with 6s spacing (shares the templates-bulk-
  //                              upload pacing because Klaviyo's per-minute
  //                              cap is plan-tier-global, not per-endpoint).
  tools.push(defineTool({
    name: 'klaviyo',
    description: 'Klaviyo email marketing — performance reports, lists, campaigns + email template CRUD (list/get/create/update/delete) + bulk template upload from a folder of HTML files + full programmatic Flows API (list/get/create/update-status/delete + bulk-import a manifest of email automations with CAN-SPAM gate). Performance analytics: flow-performance returns sends/opens/clicks/conversions/recovered-revenue per flow over a window; flow-message-performance breaks the same stats out per individual email inside one flow ("which subject line is winning"); metric-aggregate returns per-day counts of any tracked metric ("how many times did Started Checkout fire"). Token swap translates {{UNSUB_URL}} / {{ FIRST_NAME }} / {{COMPANY_ADDRESS}} placeholders into Klaviyo Django tags. When to use (REGRESSION GUARD 2026-05-10, E003 — agent-routing hints): For email-flow ROI ("how is my welcome series doing"), use action="flow-performance". For per-email A/B inside a flow ("which welcome email is winning"), use "flow-message-performance". For metric time-series ("how many checkouts last week"), use "metric-aggregate".',
    // REGRESSION GUARD (2026-04-29, Gitar PR #151 finding): klaviyo
    // tool's expanded action surface includes template-create / -update /
    // -delete and bulk-template-upload (51+ writes per call). Every other
    // write-capable tool in this file uses destructive:true so the
    // mcp-define-tool preview/confirm token flow gates risky calls. Was
    // shipped as destructive:false alongside the read-only performance/
    // lists/campaigns actions; corrected here.
    destructive: true,
    // preview:false matches every other ad-platform tool (meta_ads,
    // tiktok_ads, google_ads, amazon_ads — all destructive:true,
    // preview:false). Klaviyo template ops have the same risk profile
    // as ad pushes: external write, no reversibility for delete, but
    // the user explicitly invoked the tool with their own data. Setting
    // preview:true here would force a two-step confirm flow on every
    // bulk-upload-of-51-templates call — friction with no upside since
    // the user already provided the directory path. The validate-mcp-
    // annotations test requires this field to be explicit when
    // destructive:true (Gitar PR #153 CI finding).
    preview: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'klaviyo' },
    input: {
      action: z.enum([
        // Read-only reporting (structural — flows + templates list, metric definitions).
        // The "performance" action is misleadingly named — it returns metric / flow
        // METADATA, not actual performance numbers. For real ROI numbers, use the
        // three "*-performance" actions below (added 2026-05-09 per live user feedback).
        'performance', 'lists', 'campaigns',
        // Email campaign send / schedule (live sends to a real list). Both run the
        // SPF/DKIM/DMARC email-auth preflight and require the approval card
        // (campaign-send / campaign-schedule are in CARDED_DESTRUCTIVE_ACTIONS).
        'campaign-send', 'campaign-schedule',
        // Performance reports — actual numbers a marketer evaluates flow ROI on.
        // All three are read-only POST-bodies-as-filter against Klaviyo's
        // 2024-10-15 reports API. flow-performance returns sends/opens/clicks/
        // conversions/recovered-revenue per flow. flow-message-performance is
        // the same statistics grouped by flow_message_id (which subject line is
        // winning). metric-aggregate returns per-day counts of any tracked metric.
        'flow-performance', 'flow-message-performance', 'metric-aggregate',
        // Email template CRUD + bulk
        'templates-list', 'template-get', 'template-create',
        'template-update', 'template-delete', 'templates-bulk-upload',
        // Flow CRUD + bulk
        'flows-list', 'flow-get', 'flow-create',
        'flow-update-status', 'flow-delete', 'flows-bulk-import',
        // Segments: list (read-only) + programmatic create — unblocks
        // segment-triggered flows (winback/sunset) without a manual
        // Klaviyo-UI step. Condition GROUPS are ANDed; conditions WITHIN
        // a group are ORed.
        'segments-list', 'segment-create',
      ]).describe('Operation'),
      brand: brandSchema,
      batchCount: z.coerce.number().int().optional().describe('Days of data (performance/campaigns/flow-performance/flow-message-performance/metric-aggregate). Default 30.'),
      // Campaign send / schedule fields (live email sends)
      campaignId: z.string().optional().describe('Klaviyo campaign ID to send/schedule (campaign-send, campaign-schedule). The campaign must already exist as a draft in Klaviyo.'),
      replyTo: z.string().optional().describe('From/reply-to email (e.g. hello@yourbrand.com) for campaign-send/campaign-schedule. REQUIRED — Merlin derives the sending domain from it to verify SPF/DKIM/DMARC before the send.'),
      scheduleTime: z.string().optional().describe('RFC-3339 timestamp for campaign-schedule (e.g. 2026-06-01T14:00:00Z).'),
      approved: z.boolean().optional().describe('Approval flag for live sends (campaign-send/campaign-schedule). Set by the Electron approval card on user click; the binary REFUSES the send without it. Do not set true unless the user explicitly approved sending to a real list.'),
      // Template fields (used by template-* + bulk-upload actions)
      templateId: z.string().optional().describe('Klaviyo template ID (get/update/delete)'),
      templateName: z.string().optional().describe('Display name for the template (create/update)'),
      htmlContent: z.string().optional().describe('Raw email HTML body (create/update). Max 5 MB.'),
      dir: z.string().optional().describe('Directory of .html files for bulk-upload (must be inside assets/brands/<brand>/)'),
      nameTemplate: z.string().optional().describe('Format string for bulk-upload, e.g. "POG / 01-welcome / {basename}". {basename} = filename without extension.'),
      applyTokens: z.boolean().optional().describe('Translate generic placeholders ({{UNSUB_URL}}, {{ FIRST_NAME }}, {{COMPANY_NAME}}, …) into Klaviyo Django tags. Default true for bulk-upload, false for single template-create/update.'),
      // Flow fields (used by flow-* + flows-bulk-import actions, AND flow-performance / flow-message-performance)
      flowId: z.string().optional().describe('Klaviyo flow ID. Required for flow-get/update-status/delete and flow-message-performance; optional for flow-performance (when omitted, returns ALL flows).'),
      // Performance fields
      metricId: z.string().optional().describe('Klaviyo metric ID for metric-aggregate (pick one from the metrics list shown by the legacy "performance" action). Required for metric-aggregate.'),
      flowBody: z.any().optional().describe('Full flow body for flow-create. Shape: {name, trigger:{type, list_id?, metric?}, steps:[{type, ...}]}. Step types: "delay" {duration_seconds}, "send_email" {subject, preheader, from_email, from_name, template_id?, body?}, "wait_until" {time_of_day, timezone}, "branch" {condition}. The binary runs CheckFlowCANSPAM before any HTTP — trigger.type must be on the documented-consent allowlist (list_added, segment_added, profile_subscribed_marketing, ecommerce_placed_order, ecommerce_started_checkout, viewed_product, custom_event), every send_email step must have an unsubscribe token + physical address + subject + from_name. Failures REFUSE the create (no auto-fix).'),
      segmentBody: z.any().optional().describe('Full segment body for segment-create. Shape: {name, definition:{condition_groups:[{conditions:[{type:"profile-metric", metric_id, measurement:"count"|"sum", measurement_filter:{type:"numeric",operator,value}, timeframe_filter:{type:"date",operator:"in-the-last"|"alltime"|..., quantity?, unit?}}]}]}}. Condition GROUPS are ANDed together; conditions WITHIN a group are ORed — "zero opens AND zero clicks in 60d" needs two groups of one condition each. metric_id values come from the "performance" action\'s tracked-metrics list. The binary validates the envelope (name + non-empty condition_groups) and refuses duplicate segment names against live Klaviyo state; condition-schema errors surface verbatim from Klaviyo\'s 400 responses.'),
      // REGRESSION GUARD (2026-04-29, Gitar PR #166): was z.string().optional()
      // — switched to z.enum so the LLM sees the valid set in the JSON Schema
      // tool spec without parsing the .describe() text, and typos are
      // rejected at schema validation before the binary is invoked. Matches
      // the codebase convention used by every other fixed-set field.
      status: z.enum(['draft', 'manual', 'live']).optional().describe('Target flow status for flow-update-status.'),
      includeDefinition: z.boolean().optional().describe('When true on flow-get, request the heavy `definition` blob (full flow topology) via additional-fields[flow]=definition. Default true. Set false to skip and get only the summary attributes.'),
      manifestPath: z.string().optional().describe('Filesystem path to a flow manifest JSON for flows-bulk-import. MUST live under assets/brands/<brand>/email/ — the binary refuses arbitrary paths to block traversal. Manifest shape: {manifest_version, brand, flows:[{name, status?, trigger, steps}, ...]}. References uploaded templates by template_id (run templates-bulk-upload first to get the IDs).'),
      forceReimport: z.boolean().optional().describe('When true, flows-bulk-import bypasses the live-state dedup that refuses duplicate-by-name imports. Use this only when intentionally creating a second copy.'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'klaviyo-' + args.action, args)),
  }, tool, z, ctx));

  // ── mailchimp ────────────────────────────────────────────
  // Mailchimp email marketing — audiences, campaigns, and aggregate
  // performance reports. Read-only as of v1.22.x (no campaign-send /
  // audience-mutation actions yet). The API key is pasted via the
  // Connections panel modal (API_KEY_PLATFORMS → "mailchimp") and
  // saved as cfg.mailchimpApiKey; the binary parses the `-<dc>`
  // suffix on every call to construct <dc>.api.mailchimp.com URLs.
  //
  // No OAuth — Mailchimp's Marketplace OAuth needs multi-week
  // partner review and a private API key covers every scope we use
  // (audiences:read, campaigns:read/write, reports:read).
  tools.push(defineTool({
    name: 'mailchimp',
    description: 'Mailchimp email marketing — full Klaviyo-parity surface: audiences, campaigns, performance, template CRUD + bulk-upload, campaign send/schedule/test, and Classic Automations control. Read-only actions (status / audiences / campaigns / campaign-content / performance / templates-list / template-get / automations-list / automation-emails) are HTTP GETs, no approval card. campaign-content exports one campaign\'s fully-rendered HTML with Mailchimp merge tags normalized to the generic token set (applyTokens default true; unmapped tags reported, never dropped) — use it to migrate creative content off Mailchimp, since template HTML built in Mailchimp\'s new editor is unrecoverable via template-get. Destructive actions (template-create/update/delete/bulk-upload, campaign-create/set-content/send-test/send/schedule/delete, automation-pause/start) gate through the standard approval card; campaign-send + campaign-schedule additionally run CheckMailchimpCampaignCANSPAM and REFUSE the call when subject_line / from_name / reply_to / *|UNSUB|* tag / physical-address tag is missing. Templates: applyTokens (default true) swaps {{UNSUB_URL}}, {{ FIRST_NAME }}, {{LAST_NAME}}, {{EMAIL}}, {{FULL_NAME}}, {{LIST_NAME}}, {{COMPANY_NAME}}, {{COMPANY_ADDRESS}} for Mailchimp merge tags (*|UNSUB|*, *|FNAME|*, etc.) so the same source HTML works on Klaviyo and Mailchimp. Bulk-upload reads a directory of .html files (cap 5 MB each, concurrency 3). Routing hints: For audience ROI use action="performance". For template management ("upload my 12 email templates") use "templates-bulk-upload" with dir + nameTemplate. For a one-off send use create → set-content → send-test → send. For workflow control ("pause the welcome series") use "automation-pause" with campaignId set to the workflow id (Mailchimp does not API-create automations — only list / control / inspect).',
    // Destructive at the tool level because the surface includes 11
    // write actions (template create/update/delete, bulk-upload,
    // campaign create/set-content/send-test/send/schedule/delete,
    // automation pause/start). The host's approval-card path uses
    // input.action to decide WHICH writes need the card (vs the
    // read-only ones). Same pattern as the Klaviyo tool above.
    destructive: true,
    preview: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'mailchimp' },
    input: {
      action: z.enum([
        // Read-only reporting. campaign-content exports one campaign's
        // rendered HTML (+ merge tags normalized to the generic token
        // set) — the migration path OFF Mailchimp, since new-editor
        // template HTML is unrecoverable via /templates/{id}.
        'status', 'audiences', 'campaigns', 'campaign-content', 'performance',
        // Email template CRUD + bulk.
        'templates-list', 'template-get', 'template-create',
        'template-update', 'template-delete', 'templates-bulk-upload',
        // Campaign write surface (manual broadcasts).
        'campaign-create', 'campaign-set-content', 'campaign-send-test',
        'campaign-send', 'campaign-schedule', 'campaign-delete',
        // Classic Automations control (workflow create is UI-only
        // on Mailchimp's side — list / control / inspect only).
        'automations-list', 'automation-emails', 'automation-pause',
        'automation-start',
      ]).describe('Operation'),
      brand: brandSchema,
      limit: z.coerce.number().int().optional().describe('Max rows for campaigns (1-1000, default 25) and performance (1-100, default 10).'),
      status: z.enum(['save', 'paused', 'schedule', 'sending', 'sent']).optional().describe('Filter campaigns by status. Only used by action="campaigns".'),
      // Template fields.
      templateId: z.string().optional().describe('Mailchimp template ID (integer-as-string). Required for template-get / -update / -delete and for campaign-set-content when sourcing from a template instead of raw HTML.'),
      templateName: z.string().optional().describe('Display name on Mailchimp\'s side (template-create / -update).'),
      htmlContent: z.string().optional().describe('Raw email HTML body. Max 5 MB. Used by template-create / template-update / campaign-set-content. When applyTokens is true (default) the body is run through the merge-tag swap before POST.'),
      dir: z.string().optional().describe('Directory of .html / .htm files for templates-bulk-upload. MUST resolve inside assets/brands/<brand>/ (validated server-side).'),
      nameTemplate: z.string().optional().describe('Format string for bulk-upload, e.g. "POG / 01-welcome / {basename}". {basename} = filename without extension. Same shape as the klaviyo tool — source HTML is portable.'),
      applyTokens: z.boolean().optional().describe('Translate generic placeholders ({{UNSUB_URL}}, {{ FIRST_NAME }}, {{COMPANY_NAME}}, {{COMPANY_ADDRESS}}, etc.) to Mailchimp merge tags (*|UNSUB|*, *|FNAME|*, etc.) before POST. Default true for template-create / -update / -bulk-upload / campaign-set-content. On campaign-content the swap runs in REVERSE (merge tags → generic tokens) so the exported HTML is platform-portable. Set false to preserve the HTML byte-for-byte in either direction.'),
      // Campaign + automation fields.
      campaignId: z.string().optional().describe('Mailchimp campaign ID — required for campaign-content / set-content / send-test / send / schedule / delete. Also reused as the automation/workflow ID for automation-emails / automation-pause / automation-start (Mailchimp workflow IDs share the same alphanumeric shape as campaign IDs).'),
      audienceId: z.string().optional().describe('Mailchimp audience (list) ID — required for campaign-create. Pull this from the audiences action.'),
      subjectLine: z.string().optional().describe('Campaign subject line — required for campaign-create. CAN-SPAM-gated at send time (empty subject REFUSES the send).'),
      fromName: z.string().optional().describe('Sender display name — required for campaign-create. CAN-SPAM-gated at send time.'),
      replyTo: z.string().optional().describe('Reply-to email address — required for campaign-create. CAN-SPAM-gated at send time.'),
      preheader: z.string().optional().describe('Preview text shown next to the subject in inbox UIs. Optional but recommended (lifts open rate ~5-15%).'),
      scheduleTime: z.string().optional().describe('RFC-3339 UTC timestamp for campaign-schedule, e.g. "2026-06-01T14:00:00+00:00". Mailchimp rounds to the nearest 15-minute slot.'),
      testEmails: z.string().optional().describe('Comma-separated list of recipient addresses for campaign-send-test (max 50 — Mailchimp\'s hard cap on /actions/test). Addresses must be on the authenticated account\'s allowlist.'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'mailchimp-' + args.action, args)),
  }, tool, z, ctx));

  // ── applovin ─────────────────────────────────────────────
  // AppLovin reporting. Two independent endpoints:
  //   - MAX (publisher, r.applovin.com/maxReport) — monetization for app owners
  //   - AppDiscovery (advertiser, r.applovin.com/report) — UA campaign performance
  // Management (campaign create/edit) requires a partner NDA and is intentionally
  // surfaced as "manage" so the binary can return a clear escalation error.
  tools.push(defineTool({
    name: 'applovin',
    description: 'AppLovin reporting — MAX monetization (publisher) and AppDiscovery UA performance (advertiser).',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: false,
    concurrency: { platform: 'applovin' },
    input: {
      action: z.enum(['status', 'max-report', 'ad-report', 'campaign-performance', 'manage']).describe('Operation'),
      brand: brandSchema.optional(),
      batchCount: z.coerce.number().int().optional().describe('Days of data (default 7, max 365)'),
      limit: z.number().optional().describe('Max rows returned'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'applovin-' + args.action, args)),
  }, tool, z, ctx));

  // ── postscript ───────────────────────────────────────────
  // Postscript SMS. send-campaign and send-message go through preflightTCPA
  // (quiet hours, consent, 10DLC) before hitting the wire. List endpoints are
  // read-only reporting. Login is an API-key verify flow.
  //
  // FULL automations API surface added 2026-04-29 (postscript-full-coverage):
  // Postscript exposes Automations as fully-scriptable (unlike Klaviyo Flows
  // which are dashboard-only). bulk-import-flow runs CheckFlowTCPA on every
  // flow before any HTTP call — TCPA failures REFUSE the import (no auto-fix).
  // Token swap maps {{FIRST_NAME}} / {{COUPON_URL}} / {{UNSUB_REPLY}} to
  // Postscript-native merge tokens before send.
  tools.push(defineTool({
    name: 'postscript',
    description: 'Postscript SMS — subscribers, campaigns, keywords, automations (list + create + activate + bulk-import-flow with TCPA gate, token swap, dashboard-URL surfacing).',
    // Gitar PR #154 finding: the postscript tool's enum mixes read-only
    // and destructive actions (automation-create / -delete / -activate /
    // -deactivate / step-create / step-delete / bulk-import-flow are
    // genuinely state-mutating). MCP clients (Claude Desktop, Codex, etc.)
    // read these annotations to decide whether to gate a call behind a
    // confirmation modal. The tool-level annotation is necessarily the
    // conservative ceiling since one tool object spans all actions.
    // Marking destructive write paths as non-destructive lets a
    // misrouted call fire without user review — the same pattern Klaviyo
    // (which also added templates-bulk-upload alongside read actions)
    // got right at line 745 with a comment block. preview:false matches
    // klaviyo's pragmatic UX choice for bulk-flow imports where the
    // user already provided the manifest path.
    destructive: true,
    idempotent: true,
    preview: false,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'postscript' },
    input: {
      action: z.enum([
        // Read-only
        'status', 'subscribers', 'campaigns', 'keywords', 'automations',
        // Automation CRUD
        'automation-get', 'automation-create', 'automation-update',
        'automation-delete', 'automation-activate', 'automation-deactivate',
        // Step CRUD
        'automation-steps', 'automation-step-create',
        'automation-step-update', 'automation-step-delete',
        // Bulk
        'bulk-import-flow',
      ]).describe('Operation'),
      brand: brandSchema,
      limit: z.number().optional().describe('Max rows returned'),
      automationId: z.string().optional().describe('Automation (flow) ID for get/update/delete/activate/deactivate'),
      stepId: z.string().optional().describe('Step ID inside an automation (for step update/delete)'),
      automationFlow: z.any().optional().describe('Full automation body for automation-create. Shape: {name, trigger:{type, list_id?, keyword?}, steps:[{type, ...}]}. The binary runs CheckFlowTCPA before any HTTP call — first send_message must contain "Reply STOP" or {{UNSUB_REPLY}}, trigger.type must be on the opt-in allowlist (subscriber_added_to_list, keyword, checkout, product_purchased, cart_abandoned, browse_abandoned, back_in_stock), and brand must have postscriptTenDLCID set.'),
      automationStep: z.any().optional().describe('Single step body for automation-step-create. Shape: {type: "delay"|"send_message"|"wait_until"|"branch", duration_seconds?, body?, media_url?, template?, time_of_day?, timezone?, condition?}'),
      patchBody: z.any().optional().describe('JSON patch object for automation-update / automation-step-update. Postscript refuses unknown fields — only send fields you intend to change.'),
      manifestPath: z.string().optional().describe('Filesystem path to a flow manifest JSON for bulk-import-flow. MUST live under assets/brands/<brand>/ — the binary refuses arbitrary paths to block traversal. Manifest shape: {flows: [{name, trigger, steps}, ...]}.'),
      activate: z.boolean().optional().describe('When true on automation-create or bulk-import-flow, flip the new automation from draft → active immediately. Default false (drafts only — safer; user reviews in Postscript dashboard before going live).'),
      forceReimport: z.boolean().optional().describe('When true, bulk-import-flow bypasses the live-state dedup that refuses duplicate-by-name imports. Use this only when intentionally creating a second copy.'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'postscript-' + args.action, args)),
  }, tool, z, ctx));

  // ── clarity ──────────────────────────────────────────────
  // Microsoft Clarity behavioral analytics (read-only Data Export API).
  // Brand-scoped: each brand connects its own Clarity project token.
  //   connect  → opens the Clarity dashboard so the user can generate a
  //              Data Export API token (Settings → Data Export).
  //   verify   → validates a pasted token with a real API probe and, on
  //              success, persists it for the brand + seeds the cache.
  //   status   → reports connection state (no API call).
  //   insights → pulls the behavioral snapshot (rage/dead clicks, scroll
  //              depth, JS errors). Cache-aware — Clarity caps the API at
  //              10 pulls/project/day, so clarity.go serves a 6h-TTL
  //              per-brand snapshot rather than hitting the wire each call.
  tools.push(defineTool({
    name: 'clarity',
    description: 'Microsoft Clarity behavioral analytics — connect a brand\'s Clarity project, then pull real visitor friction (rage clicks, dead clicks, scroll depth, JavaScript errors). connect → opens Clarity so the user can generate a Data Export API token. verify → validates and saves a pasted token. status → checks connection state. insights → pulls the behavioral snapshot (cached 6h to respect Clarity\'s 10-pulls/day limit). Clarity data also auto-enriches landing-audit and funnel-teardown for connected brands.',
    destructive: false,
    idempotent: true,
    preview: false,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'clarity' },
    input: {
      action: z.enum(['connect', 'verify', 'status', 'insights']).describe('connect → open Clarity to generate a token. verify → validate + save a pasted token (requires apiKey). status → check connection. insights → pull the behavioral snapshot.'),
      brand: brandSchema,
      apiKey: z.string().optional().describe('The Clarity Data Export API token to validate (required for verify). Generated in Clarity → Settings → Data Export → Generate new API token by a project admin.'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'clarity-' + args.action, args)),
  }, tool, z, ctx));

  // ── posthog ──────────────────────────────────────────────
  // PostHog product/ecommerce analytics (read-only HogQL Query API).
  // Brand-scoped: each brand connects its own PostHog project.
  //   connect  → opens PostHog so the user can mint a Personal API Key.
  //   verify   → validates a pasted key, auto-detects the US/EU region,
  //              resolves the project, and persists it for the brand.
  //   status   → reports connection state (no API call).
  //   insights → pulls the ecommerce snapshot — conversion funnel
  //              (view → cart → checkout → purchase), revenue, orders,
  //              top products, top pages. Cached 2h.
  tools.push(defineTool({
    name: 'posthog',
    description: 'PostHog product & ecommerce analytics — connect a brand\'s PostHog project, then pull its real conversion funnel (product views → add-to-cart → checkout → orders), revenue, top products, and top pages. connect → opens PostHog to mint a Personal API Key. verify → validates a pasted key (auto-detects US/EU region, resolves the project); pass host for self-hosted PostHog and projectId to pin a specific project. status → checks connection. insights → pulls the ecommerce snapshot (cached 2h). PostHog data also auto-enriches landing-audit and funnel-teardown for connected brands.',
    destructive: false,
    idempotent: true,
    preview: false,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'posthog' },
    input: {
      action: z.enum(['connect', 'verify', 'status', 'insights']).describe('connect → open PostHog to mint a Personal API Key. verify → validate + save a pasted key (requires apiKey). status → check connection. insights → pull the ecommerce analytics snapshot.'),
      brand: brandSchema,
      apiKey: z.string().optional().describe('The PostHog Personal API Key to validate (required for verify). Minted in PostHog → Settings → Personal API Keys with the "Query Read" and "Project Read" scopes.'),
      host: z.string().optional().describe('Optional for verify: PostHog region or host — "us" (default), "eu", or a full base URL for self-hosted PostHog. Omit to auto-detect the region from the key.'),
      projectId: z.string().optional().describe('Optional for verify: pin a specific PostHog project id. Omit to use the first project the key can access.'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'posthog-' + args.action, args)),
  }, tool, z, ctx));

  // ── email ────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'email',
    description: 'Email marketing — audit email program, check revenue attribution.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    input: {
      action: z.enum(['audit', 'revenue']).describe('Operation'),
      brand: brandSchema,
      batchCount: z.coerce.number().int().optional().describe('Days of data'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'email-' + args.action, args)),
  }, tool, z, ctx));

  // ── seo ──────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'seo',
    description: 'SEO tools — audit, keyword research, rankings, fix alt text, track rankings, find gaps.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    input: {
      action: z.enum(['audit', 'keywords', 'rankings', 'fix-alt', 'track', 'gaps', 'update-rank']).describe('Operation'),
      brand: brandSchema,
      url: z.string().optional().describe('Target URL (for audit)'),
      keywords: z.string().optional().describe('Comma-separated seed keywords. REQUIRED for "keywords" (research — each seed is expanded via Google Autocomplete + Gemini volume/difficulty estimates) and for "track" (each is added to the rank tracker). Example: "scented candles, luxury incense, reed diffuser". Ignored by other actions.'),
    },
    handler: async (args) => {
      const actionMap = { 'fix-alt': 'seo-fix-alt', 'update-rank': 'seo-update-rank' };
      const action = actionMap[args.action] || 'seo-' + args.action;
      // The engine reads seed keywords from blogBody (seo-keywords + seo-track).
      // The tool exposes them as `keywords` for clarity; forward them so the seeds
      // actually reach the binary. Pre-fix the seo tool had no seed field at all,
      // so `keywords`/`track` always saw an empty blogBody and fatal-erred with
      // "blogBody required" (2026-07-21 APOTHEKE incident).
      const binArgs = { ...args };
      if (args.keywords && !binArgs.blogBody) binArgs.blogBody = args.keywords;
      return toEnvelope(await runBinary(ctx, action, binArgs));
    },
  }, tool, z, ctx));

  // ── content ──────────────────────────────────────────────
  tools.push(defineTool({
    name: 'content',
    description: 'Create ad images, blog posts, social posts, and batch variations.',
    destructive: true,
    idempotent: true,
    costImpact: 'generation',
    brandRequired: true,
    concurrency: { platform: 'fal' },
    preview: false,
    input: {
      action: z.enum(['image', 'batch', 'blog-post', 'blog-list', 'social-post', 'quiz-funnel-gen']).describe('Operation. quiz-funnel-gen generates a Stefan Georgi-canonical 7-frame quiz funnel from the brand manifest persona + pain_state; output is a standalone HTML + manifest.json in results/quiz_<brand>_<ts>/. Approval-gated.'),
      brand: brandSchema,
      product: z.string().optional(),
      imagePrompt: z.string().optional().describe('Freeform image prompt'),
      imageCount: z.number().optional().describe('Number of images (1-4)'),
      imageFormat: z.string().optional().describe('Aspect-ratio output set. Tokens (case-insensitive): "portrait" or "4:5" (1080×1350, Feed-native); "square" or "1:1" (1080×1080, universal); "story", "9:16", "vertical", "reel", "reels" (1080×1920, Stories/Reels/TikTok/Shorts); "landscape" or "16:9" (1920×1080, YouTube/web hero); "both" = portrait+square (default — Feed coverage); "all" = portrait+square+story (full ad-platform spread, one generation). Unknown tokens log a warning and fall back to "both" rather than silently coercing — pre-fix imageFormat:"9:16" silently produced 4:5+1:1, defeating Stories placements.'),
      imageModel: z.string().optional().describe('Full fal.ai model slug (preferred) or legacy alias. ALWAYS pass the full slug when possible — the binary accepts any "fal-ai/..." path directly, so new models work without app updates. Examples: "fal-ai/nano-banana-pro", "fal-ai/nano-banana-pro/edit", "fal-ai/bytedance/seedream/v4.5/text-to-image", "fal-ai/flux-pro/v1.1", "fal-ai/ideogram/v3", "fal-ai/imagen4/preview/ultra". Use the "/edit" variant when reference images exist. If the user asks for a model you don\'t know the exact slug for, fetch https://fal.ai/models to find it. Legacy aliases ("flux", "ideogram", "recraft", "seedream", "imagen", "imagen-ultra", "banana", "banana-edit", "banana-pro", "banana-pro-edit") still work but may resolve to outdated slugs.'),
      adBrief: z.any().optional().describe('Structured ad brief object. In addition to the 7-lock fields, populate the 4 camouflage-ad fields when the goal is paid social distribution: openingScenario (relatable moment the avatar lives — kitchen 7am, Uber back seat), conflictBeat {timestamp ≤ 5.0, description as felt experience not product spec, kind: "conflict"}, interruptBeats[] (3–6 spikes spaced ≥1.5s apart with kind: "twist"/"reveal"/"interrupt"/"resolve"), platformNative ("reel"/"tiktok"/"feed"/"stories"). Missing fields cost rubric points; the binary writes rubric.json to the run folder.'),
      varyDimension: z.string().optional().describe('Batch variety axis when imageCount>1. "" or "auto" = pick from populated brief fields (default when imageCount>1). "scenario" | "lighting" | "subject" | "mood" = explicit axis. "none" = disable rotation (rare; for A/B testing a single variable).'),
      compositeMode: z.boolean().optional().describe('When true, the pipeline composites the real product photo from productRefPath onto the AI-generated scene rather than letting the model hallucinate the product. REQUIRED to be true when the brand has a brand-manifest.json (the binary refuses the call otherwise — error prefix mcp__merlin__content: brand_manifest_violation:). Always pass true unless you specifically want a brand-agnostic stock-style image with no real product.'),
      productRefPath: z.string().optional().describe('Absolute or repo-relative path to the canonical product reference photo to composite. When the brand has a brand-manifest.json, this MUST resolve to one of products[].assets.* or generic_assets.* in the manifest — the binary refuses any other path with mcp__merlin__content: brand_manifest_violation:. Read the manifest first and pick the asset that matches the requested product (e.g. products[].assets.hero_photo for the lifestyle shot, generic_assets.tub_master for the bare product render).'),
      promptShell: z.enum(['', 'social-feed', 'studio', 'editorial', 'flat-color', 'cinematic', 'none']).optional().describe('Framing preamble preset for the assembled image prompt. The preamble is weighted heavier than later prompt anchors by fal models — pick the preset that MATCHES the editorial direction of the ad concept, not the default, or it overrides your prompt body (live incident: 2026-05-02 POG, default "social-feed creative realism" turned a "flat solid color background, no scene" prompt into a kitchen lifestyle scene). Presets: "" / "social-feed" → "branded social-feed creative realism" (default; lifestyle reels, UGC, paid-social DTC). "studio" → "high-end studio product photography realism" (clean catalog shots, hero stills). "editorial" → "editorial product photography, magazine composition, generous whitespace realism" (premium-playful: POG, Liquid Death, Olipop, Poppi). "flat-color" → "flat solid color background, minimalist studio composition, single hero subject realism" (color-block ads, brand palette focus). "cinematic" → "cinematic still, atmospheric volumetric light, premium minimalist composition" (luxury minimalism: Cymbiotika, AG1). "none" → no shell emitted (escape hatch when the user prompt carries explicit framing). When a brand-manifest.json declares image_gen_defaults.prompt_shell, that value is used unless this field overrides it.'),
      referenceImages: z.array(z.string()).optional(),
      referencesDir: z.string().optional(),
      templatePath: z.string().optional(),
      batchCount: z.coerce.number().int().optional().describe('Number of variations (for batch)'),
      blogTitle: z.string().optional(),
      blogBody: z.string().optional(),
      blogTags: z.string().optional(),
      blogImage: z.string().optional(),
      blogSummary: z.string().optional(),
      socialPlatform: z.string().optional(),
      socialCaption: z.string().optional(),
      socialImageUrl: z.string().optional(),
      socialImagePath: z.string().optional(),
    },
    handler: async (args) => {
      const actionMap = { 'blog-post': 'blog-post', 'blog-list': 'blog-list', 'social-post': 'social-post' };
      const action = actionMap[args.action] || args.action;
      return toEnvelope(await runBinary(ctx, action, args));
    },
  }, tool, z, ctx));

  // ── video ────────────────────────────────────────────────
  // Longer runs — mark longRunning so a future caller layer can choose to
  // route this through mcp-jobs for async status polling.
  tools.push(defineTool({
    name: 'video',
    description: 'Generate video ads — talking head, product showcase, etc.',
    destructive: true,
    idempotent: true,
    costImpact: 'generation',
    brandRequired: true,
    longRunning: true,
    // REGRESSION GUARD (2026-05-06, codex API audit P2 #2):
    // Resolve concurrency by provider so LLM auto-mode can't saturate
    // the wrong provider's queue. Pre-fix every video gen routed
    // through the 'fal' slot regardless of whether it actually used
    // veo/arcads/heygen — a 25-video heygen burst would queue against
    // fal's slot budget instead of heygen's. The function takes args at
    // call time and returns the platform name; mcp-concurrency.js owns
    // the slot map. Falls back to 'fal' for unknown / unset providers.
    concurrency: {
      platform: (args) => {
        const p = String(args && args.provider || '').toLowerCase();
        if (p === 'veo') return 'google_ai';
        if (p === 'heygen') return 'heygen';
        if (p === 'arcads') return 'arcads';
        return 'fal';
      },
    },
    preview: false,
    input: {
      brand: brandSchema,
      product: z.string().optional(),
      script: z.string().optional().describe('Custom script text'),
      format: z.string().optional().describe('"9:16", "16:9", or "1:1"'),
      duration: z.number().optional().describe('Duration in seconds'),
      provider: z.string().optional().describe('"fal", "veo", "arcads", "heygen"'),
      falModel: z.string().optional().describe('Full fal.ai model slug (preferred) or legacy alias. ALWAYS pass the full slug — the binary accepts any "fal-ai/..." path directly, so new models work without app updates. Examples: "fal-ai/bytedance/seedance/v2/pro/text-to-video", "fal-ai/veo3", "fal-ai/kling-video/v2.1/master/text-to-video", "fal-ai/minimax/video-01-live". If the user asks for a model you don\'t know the exact slug for, fetch https://fal.ai/models to find it before calling this tool. NEVER SUBSTITUTE — if the user asks for Seedance and you can\'t find the slug, stop and ask them. Do NOT pick a different model "as a fallback". The binary will fail loudly on any silent substitution. Legacy aliases ("kling", "veo", "seedance", "seedance-2", "minimax", "wan", "hunyuan") still work but resolve to possibly-outdated slugs.'),
      mode: z.string().optional().describe('"talking-head", "product-showcase", "auto"'),
      avatarId: z.string().optional(),
      voiceId: z.string().optional(),
      productHook: z.string().optional(),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'generate', args)),
  }, tool, z, ctx));

  // ── voice ────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'voice',
    description: 'Voice management — clone voices, list available voices/avatars, delete voices.',
    destructive: true,
    idempotent: true,
    costImpact: 'generation',
    brandRequired: false,
    // REGRESSION GUARD (2026-05-06, codex API audit P2 #2):
    // list-avatars hits HeyGen's API; the other voice actions hit
    // ElevenLabs. Pre-fix all four routed through the 'elevenlabs' slot,
    // so a list-avatars burst contended against in-flight voice clones.
    // Now: clone/list/delete → 'elevenlabs', list-avatars → 'heygen'.
    concurrency: {
      platform: (args) => (args && args.action === 'list-avatars') ? 'heygen' : 'elevenlabs',
    },
    preview: false,
    input: {
      action: z.enum(['clone', 'list', 'delete', 'list-avatars']).describe('Operation'),
      brand: brandSchema.optional(),
      voiceName: z.string().optional(),
      voiceId: z.string().optional(),
      voiceSampleDir: z.string().optional(),
      deleteVoice: z.string().optional().describe('Voice ID to delete'),
    },
    handler: async (args) => {
      const actionMap = { clone: 'clone-voice', list: 'list-voices', delete: 'delete-voice', 'list-avatars': 'list-avatars' };
      return toEnvelope(await runBinary(ctx, actionMap[args.action], args));
    },
  }, tool, z, ctx));

  // ── captions ─────────────────────────────────────────────
  //
  // Hormozi-style word-level caption burn-in onto an EXISTING video.
  // Routes through ./captions.js, which reuses the bundled
  // ffmpeg + whisper-cli + ggml-small.en-q5_1 toolchain that ships
  // inside the Electron installer (.claude/tools/, see release.yml's
  // "Bundle voice tools" step). Strictly local — no upload, no
  // third-party service, no Python.
  //
  // Background: pre-this-tool, the in-app agent had no captions
  // surface. When asked to "add captions to this video," it
  // confabulated "ffmpeg isn't installed" and offered to write
  // Python — embarrassing, given the toolchain ships in the same
  // installer. This tool is the explicit affordance.
  //
  // Cost impact: 'generation' — each call burns a new video file.
  // Marked NOT destructive (no platform mutation, just file IO),
  // longRunning (transcription on a 60s video can take 30-60s on a
  // slow Windows AMD; up to 10min ceiling enforced inside captions.js).
  tools.push(defineTool({
    name: 'captions',
    description: 'Burn Hormozi-style word-level captions onto an existing video file using the bundled ffmpeg + whisper-cli + small.en speech model. Transcribes audio locally (never uploaded), generates a libass subtitle file with bold yellow active-word highlighting, and re-encodes the video at CRF 18 with audio passthrough. Use this when a user wants captions added to a video they already have on disk — never suggest installing third-party tools or writing Python; the toolchain is already shipped with Merlin.',
    destructive: false,
    idempotent: true,
    costImpact: 'generation',
    // captions operates on a raw video file path and dispatches directly
    // to the captions module — never to runBinary. No brand-scoped state
    // is touched, so brandRequired stays false (codex API audit P2 #1).
    brandRequired: false,
    longRunning: true,
    input: {
      action: z.enum(['burn']).describe('Operation. Currently only "burn" is supported.'),
      videoPath: z.string().describe('Absolute path to the source video file (.mp4, .mov, or .webm). Must be < 500MB.'),
      style: z.enum(['hormozi']).optional().describe('Caption style. Defaults to "hormozi" (bold yellow active-word, white context).'),
      outputDir: z.string().optional().describe('Optional absolute path for the output directory. Defaults to <appRoot>/results/captioned_<timestamp>/.'),
    },
    handler: async (args) => {
      if (args.action !== 'burn') {
        return validationEnvelope(`Unknown action "${args.action}". Supported: burn.`);
      }
      let captionsMod;
      try {
        captionsMod = require('./captions');
      } catch (e) {
        return envelope.fail(errors.makeError('INTERNAL_ERROR', {
          message: `captions module failed to load: ${e.message}`,
        }));
      }
      const result = await captionsMod.burnCaptions({
        videoPath: args.videoPath,
        style: args.style,
        outputDir: args.outputDir,
        appRoot: ctx.appRoot,
        appInstall: ctx.appInstall,
      });
      if (result && result.error) {
        // Map captions:<code> to the canonical mcp-error code so the
        // agent's next_action branches are predictable.
        const code = String(result.error);
        const detail = result.errorDetail || '';
        let mcpCode = 'INTERNAL_ERROR';
        let nextAction;
        if (code === 'captions:invalid-input' || code === 'captions:not-found') {
          mcpCode = 'INVALID_INPUT';
          nextAction = 'fix_inputs_and_retry';
        } else if (code === 'captions:too-large') {
          mcpCode = 'INVALID_INPUT';
          nextAction = 'split_video_and_retry';
        } else if (code === 'captions:missing-tools') {
          mcpCode = 'BINARY_UNAVAILABLE';
          nextAction = 'restart_app';
        } else if (code === 'captions:no-speech') {
          mcpCode = 'PRECONDITION_FAILED';
          nextAction = 'verify_video_has_speech';
        } else if (code.endsWith('-timeout')) {
          mcpCode = 'TIMEOUT';
          nextAction = 'retry_or_split';
        }
        const errObj = errors.makeError(mcpCode, {
          message: detail,
        });
        if (nextAction) errObj.next_action = nextAction;
        return envelope.fail(errObj, {
          data: { code, errorDetail: detail },
        });
      }
      return {
        summary: `Captions burned: ${result.wordCount} words in ${(result.durationMs / 1000).toFixed(1)}s`,
        outputPath: result.outputPath,
        wordCount: result.wordCount,
        durationMs: result.durationMs,
      };
    },
  }, tool, z, ctx));

  // ── dashboard ────────────────────────────────────────────
  tools.push(defineTool({
    name: 'dashboard',
    description: 'Analytics and intelligence — cross-platform dashboard, the Truesight full funnel (awareness → visits → add-to-cart → bought, aggregated from every connected source), calendar analysis, collective wisdom, landing page audit, competitor scan.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    // Stays brandRequired:false because the action enum includes 'wisdom'
    // (vertical-keyed, not brand-keyed) and 'landing-audit' (URL-driven,
    // brand-agnostic) — both legitimately brand-less. Per-action
    // enforcement lives in runBinary via BRAND_OPTIONAL_ACTIONS for
    // 'dashboard' / 'calendar' / 'report' / 'competitor-scan'. Same
    // multi-action exemption rationale as meta_ads above (codex API
    // audit P2 #1).
    brandRequired: false,
    input: {
      action: z.enum(['dashboard', 'truesight', 'calendar', 'wisdom', 'wisdom-categorize', 'competitor-breakdown', 'report', 'competitor-scan', 'landing-audit', 'funnel-teardown']).describe('Operation. Use "truesight" for the full marketing funnel (awareness → site visits → add-to-cart → conversions) aggregated across every connected source for the brand. "wisdom" returns collective insights AND this brand\'s own winning patterns (angle/hook/format/asset-type/persona that win for it, with video hook/hold rates). "wisdom-categorize" reads the creative of this brand\'s still-uncategorized live ads and tags each across 8 dimensions (angle/hook/asset-type/visual-format/offer/seasonality/cta/persona) via Gemini (confidence-gated) so both your patterns and the collective learn from ads Merlin did not create — requires a brand. "competitor-breakdown" reads the top-performing ads in the brand\'s niche (via TrendTrack) and returns what competitors are doing — the most common hooks, angles, offers, CTAs, and formats — needs TrendTrack + a Google AI key.'),
      brand: brandSchema.optional(),
      batchCount: z.coerce.number().int().optional().describe('Days of data (truesight: 7/30/90 typical; defaults to 7)'),
      url: z.string().optional().describe('URL (for landing-audit and funnel-teardown — funnel-teardown grades the page against Stefan Georgi RMBC rubric)'),
      // REGRESSION GUARD (2026-07-26, unreachable-engine-actions incident):
      // 'competitor-scan' has been in this enum, and documented in
      // merlin-social/SKILL.md as {"action":"competitor-scan","blogBody":
      // "A,B,C","imageCount":5}, while NEITHER param was declared here.
      // defineTool's strict unknown-key check refuses undeclared fields, so
      // the documented call was rejected outright — and dropping them instead
      // would make the engine fatal with "provide competitor brand names".
      // The odd spellings are the engine's wire tags (Command.BlogBody /
      // Command.ImageCount, reused historically for this action), not a typo:
      // runBinary copies keys verbatim, so they must match main.go exactly.
      // The friendlier surface is meta_research_competitor_ads.
      blogBody: z.string().optional().describe('For competitor-scan: comma-separated competitor brand names (e.g. "Madhappy,Pangaia,Teddy Fresh"). Required for that action.'),
      imageCount: z.number().optional().describe('For competitor-scan: max ads to return per competitor (default 5).'),
    },
    handler: async (args) => {
      const actionMap = { 'competitor-scan': 'competitor-scan', 'landing-audit': 'landing-audit', 'funnel-teardown': 'funnel-teardown' };
      const action = actionMap[args.action] || args.action;
      // truesight fans out to every connected source; wisdom-categorize +
      // competitor-breakdown each run an LLM pass over many ads — all need a
      // longer window than the default 60s.
      const longLLM = args.action === 'wisdom-categorize' || args.action === 'competitor-breakdown';
      const timeout = args.action === 'truesight' ? 120000 : longLLM ? 180000 : 60000;
      return toEnvelope(await runBinary(ctx, action, args, { timeout }));
    },
  }, tool, z, ctx));

  // ── discord ──────────────────────────────────────────────
  tools.push(defineTool({
    name: 'discord',
    description: 'Discord notifications — set up channel, send messages.',
    destructive: true,
    idempotent: true,
    costImpact: 'api',
    brandRequired: false,
    preview: false,
    input: {
      action: z.enum(['setup', 'post']).describe('Operation'),
      slackMessage: z.string().optional().describe('Message text (for post)'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'discord-' + args.action, args)),
  }, tool, z, ctx));

  // ── slack ────────────────────────────────────────────────
  // Wave F-3 (Sim 1, Sarah) — the Monday digest skill needs an
  // explicit `slack-post` surface; previously Slack only had
  // login/exchange so Claude had to tell the user "paste this into
  // Slack manually." Now: chain dashboard → slack({action:'post', ...}).
  tools.push(defineTool({
    name: 'slack',
    description: 'Slack notifications — post a free-form message (e.g., a Monday digest) to the configured webhook. Pair with `dashboard` for end-of-week summaries.',
    destructive: true,
    idempotent: true,
    costImpact: 'api',
    brandRequired: false,
    preview: false,
    input: {
      action: z.enum(['post']).describe('Operation'),
      slackMessage: z.string().describe('The message body. Plain text or Slack mrkdwn (use *bold*, _italic_, single backticks for code).'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'slack-' + args.action, args)),
  }, tool, z, ctx));

  // ── threads ─────────────────────────────────────────────
  tools.push(defineTool({
    name: 'threads',
    description: 'Threads (Meta) — view profile, read posts, check engagement insights.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    input: {
      action: z.enum(['profile', 'posts', 'insights']).describe('Operation'),
      brand: brandSchema,
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'threads-' + args.action, args)),
  }, tool, z, ctx));

  // ── stripe ────────────────────────────────────────────────
  // Stripe read-only revenue + subscription analytics. The OAuth scope
  // is pinned to read_only in BOTH the binary (oauth.go getStripeOAuth)
  // and the Worker BFF (Hard-Won Security Rule 9), and stripe.go is
  // read-only by construction (Hard-Won Security Rule 8 — no POST/PUT/
  // DELETE verbs). This MCP tool is just the LLM-facing surface for
  // those binary actions; it cannot widen the scope or fire writes.
  //
  // REGRESSION GUARD (2026-05-06, codex API audit P1 #3): all binary
  // CLI actions (stripe-revenue / -subscriptions / -cohorts / -analytics
  // / -setup / -preference) shipped without an MCP tool, so the LLM
  // saw zero Stripe surface. Adding this tool unblocks dashboard's
  // RevenueSource preference flow for users who connect Stripe but
  // not Shopify (Hard-Won Security Rule 10).
  tools.push(defineTool({
    name: 'stripe',
    description: 'Stripe revenue & subscription analytics (read-only API surface). Actions: setup (run once after stripe-login to verify access + persist account ID), revenue (gross + net + refund totals over a date window), subscriptions (active count, MRR, ARR, churn %), cohorts (monthly retention curves), analytics (margin + LTV:CAC where available), preference (set the dashboard\'s revenue-source preference when both Shopify AND Stripe are connected — values: "shopify" / "stripe" / "both"; default prefers Shopify for order semantics). The Stripe OAuth scope is pinned to read_only in BOTH the binary and the BFF (Hard-Won Security Rules 8 + 9), so even the "preference" action — which writes the preference to the local merlin-config — never touches Stripe write surface.',
    // REGRESSION GUARD (2026-05-06, Gitar review on PR #224): the
    // 'preference' action mutates a local config field
    // (cfg.RevenueSourcePreference) — it doesn't touch Stripe's write
    // surface (which is locked behind read_only OAuth, see Hard-Won
    // Security Rules 8 + 9). But it IS a state mutation, and the
    // dashboard's RevenueSource picker (Hard-Won Security Rule 10)
    // reads from it on every dashboard pull, so silent flipping
    // changes downstream reporting. Marking destructive:true with
    // preview:false matches the pattern used by every other
    // write-capable tool (klaviyo, postscript, google_merchant) and
    // makes the state mutation visible to MCP-host approval gates.
    // idempotent:true is correct — re-setting the same preference is
    // a no-op (last write wins; same input = same outcome).
    destructive: true,
    idempotent: true,
    preview: false,
    costImpact: 'api',
    brandRequired: false,
    concurrency: { platform: 'stripe' },
    input: {
      action: z.enum(['setup', 'revenue', 'subscriptions', 'cohorts', 'analytics', 'preference']).describe('Operation'),
      brand: brandSchema.optional(),
      batchCount: z.coerce.number().int().optional().describe('Days of data (revenue/subscriptions/cohorts/analytics)'),
      preference: z.enum(['shopify', 'stripe', 'both', '']).optional().describe('Revenue source preference (preference action only). Empty string clears any explicit preference.'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'stripe-' + args.action, args)),
  }, tool, z, ctx));

  // ── google_merchant ───────────────────────────────────────
  // Google Merchant Center — product feed sync + diagnostic insights.
  // Catalog-side mirror of google_ads (which manages campaigns); the
  // Merchant API provides the product database that Google Shopping
  // ads serve from. setup creates the per-brand Merchant account
  // bindings; sync-shopify pushes the Shopify catalog to GMC; insights
  // surfaces disapprovals + warnings that block ads.
  //
  // REGRESSION GUARD (2026-05-06, codex API audit P1 #3): binary CLI
  // actions (merchant-status / -setup / -sync-shopify / -insights)
  // shipped without an MCP tool. Without this, when a Shopify-connected
  // user said "fix my Shopping ads disapprovals" the LLM had no path
  // from chat to merchant-insights.
  tools.push(defineTool({
    name: 'google_merchant',
    description: 'Google Merchant Center — product feed sync + Shopping ad diagnostics. Actions: status (account binding check), setup (one-time per brand), sync-shopify (push Shopify catalog → GMC), insights (product disapprovals, policy warnings, item-level issues blocking Google Shopping ads).',
    destructive: true,
    idempotent: true,
    preview: false,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'google_merchant' },
    input: {
      action: z.enum(['status', 'setup', 'sync-shopify', 'insights']).describe('Operation'),
      brand: brandSchema,
      batchCount: z.coerce.number().int().optional().describe('Days of data (insights)'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'merchant-' + args.action, args)),
  }, tool, z, ctx));

  // ── triplewhale ───────────────────────────────────────────
  // Triple Whale brand-specific analytics (read-only). Two pull paths:
  //   - weekly: dashboard-true metrics via the Data-Out SQL API (the same
  //     warehouse the dashboard tiles read), tile-true Total Sales plus
  //     per-channel ROAS under every attribution model. Preferred for
  //     reporting; supports exact startDate/endDate calendar windows.
  //   - summary: the legacy Summary Page pull (NOT tile-true; drifts up to
  //     ~3% from the tiles). Surfaces the attribution metrics a CMO steers
  //     on that platform ROAS alone can't show: NC-ROAS, NCPA, MER, blended
  //     ROAS, new-customer revenue/orders, plus TW's peer benchmarks.
  //
  // TWO brand-specific credential paths, both Authorization: Bearer:
  //   - OAuth sign-in (the primary path) via mcp__merlin__platform_login
  //     platform "triplewhale" — available once the TW OAuth app is
  //     registered + the TRIPLEWHALE_CLIENT_ID Worker secret is set.
  //   - A personal API key (works today, no app registration): connect →
  //     mint a key at app.triplewhale.com/api-keys; verify → validate +
  //     save it. The Go connector prefers the OAuth token, falls back to
  //     the key. Read-only by construction — triplewhale.go ships no writes.
  tools.push(defineTool({
    name: 'triplewhale',
    description: 'Triple Whale analytics (read-only). Pulls the full topline a CMO steers on: Blended Sales, Ad Spend, Net Profit, Net Margin, ROAS (attributed + blended), MER, NC-ROAS (new-customer ROAS), NCPA (new-customer CPA), new-customer revenue/orders, AOV, plus Triple Whale\'s peer benchmarks (NC-ROAS / NCPA / blended-ROAS). Actions: weekly (PREFERRED for reporting: dashboard-true metrics via the Data-Out SQL warehouse the dashboard tiles read, tile-true Total Sales plus per-channel spend/revenue/ROAS under every attribution model; pass startDate + endDate for an exact calendar week, e.g. Sun-Sat); summary (legacy metric pull, NOT tile-true — batchCount = days, default 30, or startDate + endDate for an exact window); status (connection check, no API call); connect (instructions to mint a personal API key); verify (validate + save a pasted personal API key, requires apiKey). OAuth sign-in is the primary connect path via platform_login platform "triplewhale"; the personal API key is the no-registration fallback. Read-only — no write surface.',
    destructive: false,
    idempotent: true,
    preview: false,
    costImpact: 'api',
    brandRequired: false,
    concurrency: { platform: 'triplewhale' },
    input: {
      action: z.enum(['weekly', 'summary', 'status', 'connect', 'verify']).describe('weekly → dashboard-true (tile-true) pull via the Data-Out SQL warehouse: Total Sales, blended spend, orders, NCPA, NC-ROAS, MER, plus per-channel ROAS under every attribution model. Use this for weekly reporting. summary → legacy Summary Page pull (not tile-true). status → check connection. connect → how to mint a personal API key. verify → validate + save a pasted key (requires apiKey; also pass shopDomain when the brand has no Shopify connected, so the shop scope is saved).'),
      brand: brandSchema.optional(),
      batchCount: z.coerce.number().int().optional().describe('Trailing days of data for summary (default 30) or weekly (default 7). Ignored when startDate + endDate are set. batchCount 1 is valid: a same-day window (used for Sunday same-day subtraction).'),
      startDate: z.string().optional().describe('Exact window start, YYYY-MM-DD (shop timezone, applied by Triple Whale server-side). Both startDate and endDate or neither: one-sided input is rejected. Takes precedence over batchCount. Use for exact calendar weeks, e.g. the Sun-Sat reporting week.'),
      endDate: z.string().optional().describe('Exact window end, YYYY-MM-DD, inclusive. Must not be in the future, and endDate must not be before startDate. Max window 365 days.'),
      apiKey: z.string().optional().describe('Personal API key to validate (required for verify). Minted at app.triplewhale.com/api-keys with the "Summary Page: Read" + "Pixel Attribution: Read" scopes.'),
      shopDomain: z.string().optional().describe('The store\'s .myshopify.com domain (e.g. "apotheke.myshopify.com"). Pass this when the brand has NO Shopify connected so Triple Whale knows which shop to report on. On "verify" it is saved so every future pull (including scheduled ones) stays scoped automatically; on "summary" it scopes that one pull. If Shopify IS connected, omit it (the connected store is used automatically).'),
    },
    handler: async (args) => {
      if (args.action === 'connect') {
        return {
          summary: 'Connect Triple Whale',
          instructions: 'Mint a personal API key at app.triplewhale.com/api-keys (Create Key → select the "Summary Page: Read" and "Pixel Attribution: Read" scopes → save it somewhere safe). Then call mcp__merlin__triplewhale with action "verify" and apiKey set to that key. OAuth sign-in is the primary path and becomes available once the Triple Whale OAuth app is registered — use mcp__merlin__platform_login with platform "triplewhale" then.',
        };
      }
      const actionMap = { weekly: 'triplewhale-weekly', summary: 'triplewhale-summary', status: 'triplewhale-status', verify: 'triplewhale-verify-key' };
      return toEnvelope(await runBinary(ctx, actionMap[args.action], args));
    },
  }, tool, z, ctx));

  // ── rokt ──────────────────────────────────────────────────
  // Rokt network reporting (READ-ONLY). Rokt has NO campaign-management write
  // API (dashboard-only), so this tool can only READ campaign performance — it
  // cannot launch, pause, or change Rokt ads (hence destructive:false,
  // costImpact:'api', no approval card). BYOK: the brand provisions an App ID +
  // App Secret + Account ID in its OWN Rokt One Platform account (my.rokt.com);
  // rokt.go exchanges them for a 1h Bearer token (OAuth2 client_credentials) and
  // reads the Query API. Read-only by construction — rokt.go ships no write verbs
  // (TestRoktSourceHasNoWriteVerbs).
  tools.push(defineTool({
    name: 'rokt',
    description: 'Rokt network reporting (read-only). Pulls campaign performance (impressions, referrals, spend) from the Rokt ad network into the dashboard. Rokt has no campaign-management API, so this CANNOT launch or manage Rokt ads — reporting only. Actions: report (pull performance for a window — batchCount = days, default 30); status (connection check, no API call); connect (how to get Rokt API credentials); verify (validate the saved App ID / App Secret / Account ID). Connect by entering your Rokt App ID, App Secret, and Account ID from my.rokt.com into the Rokt tile.',
    destructive: false,
    idempotent: true,
    preview: false,
    costImpact: 'api',
    brandRequired: false,
    concurrency: { platform: 'rokt' },
    input: {
      action: z.enum(['report', 'status', 'connect', 'verify']).describe('report → pull impressions/referrals/spend for the window. status → check connection (no API call). connect → how to get Rokt API credentials. verify → validate the saved credentials.'),
      brand: brandSchema.optional(),
      batchCount: z.coerce.number().int().optional().describe('Days of data for report (default 30).'),
    },
    handler: async (args) => {
      if (args.action === 'connect') {
        return {
          summary: 'Connect Rokt',
          instructions: 'In your Rokt One Platform account (my.rokt.com): create an integration App to get an App ID + App Secret, and note your Account ID. Then open the Rokt tile in the Connections panel and enter all three. Rokt access requires an active Rokt advertiser account (it is enterprise-onboarded). Note: Rokt has no campaign-management API, so Merlin can report on your Rokt performance but cannot launch or change Rokt campaigns.',
        };
      }
      const actionMap = { report: 'rokt-report', status: 'rokt-status', verify: 'rokt-verify' };
      return toEnvelope(await runBinary(ctx, actionMap[args.action], args));
    },
  }, tool, z, ctx));

  // ── openai_ads ────────────────────────────────────────────
  // OpenAI / ChatGPT Ads — run + manage paid ads on OpenAI's ChatGPT ads
  // platform (api.ads.openai.com). SPENDS REAL MONEY, so destructive:true +
  // costImpact:'spend': the 'push' action routes through the host approval card
  // (SPEND_ACTIONS) with the cents-detector + budget context, and the binary
  // independently gates push with requireApproval + validateDailyBudget +
  // enforceMonthlyCap + recordActiveSpend (openai_ads.go). Read actions
  // (account/campaigns/insights) auto-approve; pause only reduces spend.
  // Connect is BYOK: paste the key from ads.openai.com into the masked OpenAI
  // Ads tile (never in chat — it authorizes spend); 'verify' tests it.
  tools.push(defineTool({
    name: 'openai_ads',
    description: 'OpenAI / ChatGPT Ads — run and manage paid ads on the ChatGPT ads platform. Actions: account (ad-account info), campaigns (list), insights (impressions/clicks/spend/CTR/CPC/CPM — batchCount=days, campaignId/adId to scope), push (LAUNCH a live ad: builds campaign + ad group + uploads the creative + ad; needs adHeadline + adImagePath + a destination (adLink or the brand productUrl) + dailyBudget; SPENDS money — shows an approval card with budget), pause (pause a campaignId or adId), connect (how to paste your Ads API key), verify (test a saved key). Connect by pasting the key from ads.openai.com into the OpenAI Ads tile (masked — it authorizes ad spend). US beta.',
    destructive: true,
    idempotent: false,
    preview: false,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'openai_ads' },
    input: {
      action: z.enum(['account', 'campaigns', 'insights', 'push', 'pause', 'connect', 'verify']).describe('account/campaigns/insights → read. push → launch a live ad (spends, approval card). pause → pause a campaignId/adId. connect → how to paste the API key. verify → test a saved key.'),
      brand: brandSchema,
      apiKey: z.string().optional().describe('OpenAI Ads API key to validate (verify only); from ads.openai.com.'),
      adHeadline: z.string().optional().describe('Ad title (push; truncated to 50 chars).'),
      adBody: z.string().optional().describe('Ad body text (push; truncated to 100 chars).'),
      adImagePath: z.string().optional().describe('Path to the creative image (push).'),
      adLink: z.string().optional().describe('Destination URL (push; falls back to the brand productUrl).'),
      dailyBudget: z.coerce.number().optional().describe('Daily budget in dollars (push). The campaign lifetime budget = dailyBudget × 30, validated against your caps.'),
      campaignId: z.string().optional().describe('Campaign id (insights/pause).'),
      adId: z.string().optional().describe('Ad id (insights/pause).'),
      batchCount: z.coerce.number().int().optional().describe('Days of data for insights (default 30).'),
    },
    handler: async (args) => {
      if (args.action === 'connect') {
        return {
          summary: 'Connect OpenAI Ads',
          instructions: 'Mint an Ads API key at ads.openai.com (Settings → API), then click the OpenAI Ads tile in the Connections panel and paste it into the masked field (never paste it in chat — it authorizes real ad spend). Then call mcp__merlin__openai_ads with action "verify" to confirm, or connection_status to check. US beta, no minimum spend.',
        };
      }
      const actionMap = {
        account: 'openai-ads-account',
        campaigns: 'openai-ads-campaigns',
        insights: 'openai-ads-insights',
        push: 'openai-ads-push',
        pause: 'openai-ads-pause',
        verify: 'openai-ads-verify',
      };
      return toEnvelope(await runBinary(ctx, actionMap[args.action], args));
    },
  }, tool, z, ctx));

  // ── reddit_organic + reddit_organic_post ──────────────────
  // Reddit organic prospecting. Split into TWO tools per Gitar review on
  // PR #224: the read+staging surface (scan, draft) is idempotent — same
  // thread + same draft inputs produce the same draft, retries are safe.
  // The publish surface (post) is INHERENTLY non-idempotent — every call
  // makes a new comment on Reddit. A blanket `idempotent: true` on the
  // combined tool would let an LLM-supplied idempotencyKey cache a
  // failed post and refuse to retry on transient errors (the
  // wrapHandler idempotency cache stores ALL successful results,
  // including is_error envelopes that aren't network failures).
  //
  // Splitting also makes the cost model visible: scan/draft are pure
  // API reads; post mutates the Reddit account's public footprint and
  // is what the 7-layer compliance preflight gates.
  //
  // Wholly distinct from reddit_ads (which buys spend). Organic is
  // gated by the binary's 7-layer compliance preflight (TCPA-style
  // checks: subreddit rules, account-age, karma floor, recent-post
  // dedup, mod-removal cool-down, rate limits, opt-in language). A
  // failed gate REFUSES the post (no auto-fix) so a paying user's
  // Reddit account never gets shadow-banned by Merlin.
  //
  // REGRESSION GUARD (2026-05-06, codex API audit P1 #3): binary CLI
  // actions (reddit-prospect-scan / -draft / -post) shipped without an
  // MCP tool. The legacy reddit_ads tool only exposed paid actions;
  // organic was binary-only.
  // REGRESSION GUARD (2026-05-06, Gitar review on PR #224): split into
  // reddit_organic (read+staging, idempotent) + reddit_organic_post
  // (publish, NOT idempotent). Combining a destructive non-idempotent
  // action with idempotent reads under a single tool created an
  // idempotency-cache poisoning risk on retried posts.
  tools.push(defineTool({
    name: 'reddit_organic',
    description: 'Reddit organic prospecting (reads + staging — see reddit_organic_post for the publish action). Actions: scan (search target subreddits for high-intent questions matching the brand\'s keywords), draft (write a compliant reply for a flagged thread; passes through the 7-layer compliance preflight). Both actions are idempotent — same inputs produce the same output, retries are safe.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'reddit_organic' },
    input: {
      action: z.enum(['scan', 'draft']).describe('Operation'),
      brand: brandSchema,
      subreddit: z.string().optional().describe('Target subreddit (without r/ prefix). Required for scan when limiting scope; optional for draft (inferred from the threadId).'),
      keywords: z.array(z.string()).optional().describe('Keywords to filter scan results. Each keyword is matched against title + selftext. Required for scan.'),
      threadId: z.string().optional().describe('Reddit submission ID (e.g. "t3_abc123") for draft. The 7-layer compliance preflight uses this to look up the parent thread state.'),
      replyBody: z.string().optional().describe('Override the drafted body. The 7-layer compliance preflight still runs; user-edited bodies are not bypass paths.'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'reddit-prospect-' + args.action, args)),
  }, tool, z, ctx));

  // ── reddit_organic_post ───────────────────────────────────
  // Publish a drafted Reddit comment. This is the only action that
  // mutates Reddit's public state, so it lives in its own tool with
  // destructive:true + idempotent:false (matching the actual semantic
  // — every call produces a new public comment) + preview:false (the
  // user already reviewed the draft via the draft action; chaining
  // another preview gate would be UX friction with no upside).
  tools.push(defineTool({
    name: 'reddit_organic_post',
    description: 'Publish a drafted Reddit comment (the publish step of the reddit_organic flow). Each call produces a NEW public comment on Reddit — NOT idempotent, retries create duplicate posts. Runs through the binary\'s subreddit-rules / karma-floor / mod-cooldown gate and REFUSES on failure — there is no auto-fix path. Per-account daily-post caps live in the binary.',
    destructive: true,
    idempotent: false,
    preview: false,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'reddit_organic' },
    input: {
      brand: brandSchema,
      draftId: z.string().describe('Draft ID returned by reddit_organic action="draft" — passed here to publish it.'),
      replyBody: z.string().optional().describe('Override the drafted body. The 7-layer compliance preflight still runs; user-edited bodies are not bypass paths.'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'reddit-prospect-post', args)),
  }, tool, z, ctx));

  // ── trendtrack ────────────────────────────────────────────
  // TrendTrack ecommerce intelligence — Shopify store discovery,
  // ad library, email library, trend signals. Currently exposes only
  // the unmetered system endpoints (status, verify-key) — the broader
  // query surface is documented in trendtrack.go but not yet wired
  // through the MCP layer. This tool establishes the MCP entry point
  // so the broader query actions can be added without renaming.
  //
  // REGRESSION GUARD (2026-05-06, codex API audit P1 #3): binary CLI
  // actions (trendtrack-status, trendtrack-verify-key) shipped without
  // an MCP tool, so the LLM had no path to surface "your TrendTrack
  // key is invalid" in chat.
  tools.push(defineTool({
    name: 'trendtrack',
    description: 'TrendTrack ecommerce intelligence — system / verification endpoints only (status, verify-key). The broader TrendTrack query surface (Shopify store discovery, ad library, email library, trend signals) is implemented in the binary and will be exposed here as the corresponding MCP actions ship.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: false,
    concurrency: { platform: 'trendtrack' },
    input: {
      action: z.enum(['status', 'verify-key']).describe('Operation'),
      brand: brandSchema.optional(),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'trendtrack-' + args.action, args)),
  }, tool, z, ctx));

  // ── reddit_ads ───────────────────────────────────────────
  tools.push(defineTool({
    name: 'reddit_ads',
    description: 'Reddit Ads — manage campaigns, ad groups, ads, and check performance.',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'reddit_ads' },
    preview: false,
    input: {
      action: z.enum(['accounts', 'campaigns', 'adgroups', 'ads', 'insights', 'create-campaign', 'create-ad', 'kill']).describe('Operation'),
      brand: brandSchema,
      campaignId: z.string().optional().describe('Campaign ID'),
      adId: z.string().optional().describe('Ad or ad group ID'),
      campaignName: z.string().optional().describe('Campaign name'),
      dailyBudget: z.number().optional().describe('Daily budget in DOLLARS (not cents). Example: pass 10 for $10/day, 50 for $50/day, 200 for $200/day. NEVER pre-convert to cents — Merlin handles the cents conversion internally when calling the platform\'s API. If the user says "$10 a day", pass 10. If unsure, ask the user.'),
      adHeadline: z.string().optional().describe('Ad headline'),
      adLink: z.string().optional().describe('Destination URL'),
      batchCount: z.coerce.number().int().optional().describe('Days of data (for insights)'),
    },
    handler: async (args) => {
      const budgetError = validateBudget(ctx, args, 'Reddit');
      if (budgetError) return validationEnvelope(budgetError);
      return toEnvelope(await runBinary(ctx, 'reddit-' + args.action, args));
    },
  }, tool, z, ctx));

  // ── linkedin_ads ─────────────────────────────────────────
  tools.push(defineTool({
    name: 'linkedin_ads',
    description: 'LinkedIn Ads — manage campaigns, creatives, budgets, and check performance.',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'linkedin' },
    preview: false,
    input: {
      action: z.enum(['accounts', 'campaigns', 'setup', 'push', 'insights', 'kill', 'duplicate', 'budget']).describe('Operation'),
      brand: brandSchema,
      campaignId: z.string().optional().describe('Campaign ID or URN'),
      adId: z.string().optional().describe('Creative ID or URN'),
      campaignName: z.string().optional().describe('Campaign name'),
      dailyBudget: z.number().optional().describe('Daily budget in DOLLARS (not cents). Example: pass 10 for $10/day, 50 for $50/day, 200 for $200/day. NEVER pre-convert to cents — Merlin handles the cents conversion internally when calling the platform\'s API. If the user says "$10 a day", pass 10. If unsure, ask the user.'),
      adHeadline: z.string().optional().describe('Ad headline'),
      adBody: z.string().optional().describe('Ad body text'),
      adLink: z.string().optional().describe('Destination URL'),
      adImagePath: z.string().optional().describe('Path to an image for a single-image sponsored creative (push). When set, Merlin uploads the image to the sponsoring organization, creates a Direct Sponsored Content post, and builds the creative from it. Requires an organization-backed ad account. Omit for a text/link creative.'),
      batchCount: z.coerce.number().int().optional().describe('Days of data (for insights)'),
    },
    handler: async (args) => {
      const budgetError = validateBudget(ctx, args, 'LinkedIn');
      if (budgetError) return validationEnvelope(budgetError);
      return toEnvelope(await runBinary(ctx, 'linkedin-' + args.action, args));
    },
  }, tool, z, ctx));

  // ── etsy ─────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'etsy',
    description: 'Etsy shop management — view shop details, browse listings, check orders.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'etsy' },
    input: {
      action: z.enum(['shop', 'products', 'orders']).describe('Operation'),
      brand: brandSchema,
      batchCount: z.coerce.number().int().optional().describe('Number of results to return (max 100)'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'etsy-' + args.action, args)),
  }, tool, z, ctx));

  // ── config ───────────────────────────────────────────────
  tools.push(defineTool({
    name: 'config',
    description: 'Configuration — set up API keys, verify connections, check version.',
    destructive: false,
    idempotent: true,
    costImpact: 'none',
    brandRequired: false,
    input: {
      action: z.enum(['api-key-setup', 'verify-key', 'dry-run', 'version']).describe('Operation'),
      provider: z.string().optional().describe('API provider name (for api-key-setup)'),
      apiKey: z.string().optional().describe('API key to verify'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, args.action, args, { timeout: 30000 })),
  }, tool, z, ctx));

  // ── competitor_spy ───────────────────────────────────────
  // Foreplay competitor ad intelligence. Routes EXCLUSIVELY through global
  // discovery endpoints (getBrandsByDomain, getAdsByBrandId, getAdsByPageId,
  // ad/duplicates, ad/{id}, usage). The Spyder family of endpoints is never
  // called — they require the user to manually subscribe to each brand in
  // the Foreplay UI, which defeats the whole "agentic ad research" promise.
  // See foreplay.go header for the rationale + foreplay_test.go for the
  // static-source guard locking in this contract.
  tools.push(defineTool({
    name: 'competitor_spy',
    description: 'Research competitor ads via Foreplay global discovery — NEVER requires pre-subscribing to a brand. Flow: brands-by-domain (competitor.com → brand IDs) → ads-by-brand (all their ads) → download-ad (save media). ads-by-page works on raw Facebook page IDs. ad-duplicates reverse-looks up every brand reusing one creative. usage shows remaining API credits. Does NOT use Foreplay Spyder endpoints — those require manual brand subscription and are intentionally unsupported.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: false,
    concurrency: { platform: 'foreplay' },
    input: {
      action: z.enum([
        'brands-by-domain',
        'ads-by-brand',
        'ads-by-page',
        'ad-duplicates',
        'download-ad',
        'usage',
      ]).describe('brands-by-domain → resolve competitor domain to brand IDs. ads-by-brand → pull ads for one or more brand IDs. ads-by-page → pull ads for a raw Facebook page ID. ad-duplicates → find every brand reusing this creative. download-ad → save the ad\'s video/image to results/competitor-ads/. usage → check remaining API credits.'),
      url: z.string().optional().describe('Competitor root domain for brands-by-domain (e.g. "acme.com", not "www.acme.com/products"). Alternatively pass foreplayDomain.'),
      foreplayDomain: z.string().optional().describe('Same as url — alternative field name for brands-by-domain.'),
      foreplayBrandIds: z.string().optional().describe('CSV of Foreplay brand IDs for ads-by-brand (e.g. "brand_abc,brand_def"). Get IDs from brands-by-domain first.'),
      foreplayPageId: z.string().optional().describe('Numeric Facebook page ID for ads-by-page (e.g. "123456789"). Use when you already know the page ID — skips the domain lookup.'),
      adId: z.string().optional().describe('Foreplay ad_id for ad-duplicates or download-ad. Get it from ads-by-brand or ads-by-page output.'),
      foreplayFormat: z.enum(['video', 'image', 'carousel', 'dco', 'dpa', 'multi_images', 'multi_videos']).optional().describe('Filter ads by creative format.'),
      foreplayOrder: z.enum(['newest', 'oldest', 'longest_running', 'most_relevant']).optional().describe('Sort order for ad results (default: newest).'),
      foreplayLive: z.enum(['true', 'false']).optional().describe('Filter by live status: "true" = only running ads, "false" = only retired. Omit for both.'),
      foreplayCursor: z.string().optional().describe('Opaque pagination cursor from the previous response\'s metadata.cursor. Omit for page 1.'),
      limit: z.number().optional().describe('Max results per page (1-250 for ads, 1-10 for brands). Default: 25 ads, 5 brands.'),
    },
    handler: async (args) => {
      const actionMap = {
        'brands-by-domain': 'foreplay-brands-by-domain',
        'ads-by-brand':     'foreplay-ads-by-brand',
        'ads-by-page':      'foreplay-ads-by-page',
        'ad-duplicates':    'foreplay-ad-duplicates',
        'download-ad':      'foreplay-download-ad',
        'usage':            'foreplay-usage',
      };
      const binaryAction = actionMap[args.action];
      if (!binaryAction) return validationEnvelope(`Unknown competitor_spy action: ${args.action}`);
      return toEnvelope(await runBinary(ctx, binaryAction, args));
    },
  }, tool, z, ctx));

  // ── platform_login ───────────────────────────────────────
  tools.push(defineTool({
    name: 'platform_login',
    description: 'Connect a platform via OAuth — opens browser for authorization. Returns success/failure only, never tokens.',
    destructive: false,
    idempotent: true,
    costImpact: 'none',
    brandRequired: false,
    input: {
      // REGRESSION GUARD (2026-05-02, RSI Session 3 D5.3 fix): pinterest,
      // snapchat, twitter were in the enum AND in `comingSoon` below — i.e.
      // the agent could "successfully" call platform_login for them, get a
      // "coming soon" envelope back, and have no actionable next step. Per
      // CLAUDE.md ("DORMANT CAPABILITY" pattern) the right answer is to drop
      // them from the agent surface entirely until ACTIVE_PLATFORMS includes
      // them; the binary's runPinterestLogin / runSnapchatLogin / runTwitterLogin
      // remain (TODO providers) but are unreachable from the agent. When any
      // graduates to ACTIVE, add it back here AND update the comingSoon list.
      // klaviyo stays in the enum because its API-key tile is the active
      // path — the comingSoon branch redirects the user to the tile.
      platform: z.enum(['meta', 'tiktok', 'google', 'shopify', 'amazon', 'klaviyo', 'slack', 'discord', 'etsy', 'reddit', 'applovin', 'postscript', 'clarity', 'posthog', 'stripe', 'linkedin', 'triplewhale', 'openai_ads', 'threads']).describe('Platform to connect'),
      brand: brandSchema.optional(),
      store: z.string().optional().describe('Shopify store URL or name (for shopify)'),
    },
    handler: async (args) => {
      // Meta App Review PASSED (Live mode, see CLAUDE.md "Meta Ads API").
      // The old branch here returned "App Review pending, paste a manual
      // token from developers.facebook.com/tools/explorer", a dead end
      // that contradicted the tile's real OAuth flow. Meta is in
      // ACTIVE_PLATFORMS (oauth-provider-config.js) and now falls through
      // to the same ctx.runOAuthFlow path as tiktok/google below.
      //
      // Threads has NO standalone OAuth: it inherits the Meta grant
      // (threadsAccessToken rides the Meta token, see the disconnect
      // keyMap comment in main.js). Route the agent to connect Meta.
      if (args.platform === 'threads') {
        return {
          summary: 'Threads rides the Meta connection, no separate login',
          instructions: 'Threads uses the same authorization as Meta: there is no separate Threads OAuth. If Meta is not connected yet, call platform_login with platform "meta" (or ask the user to click the Meta tile in the Connections panel). Once Meta is connected, Threads works automatically. Use connection_status to verify.',
        };
      }
      // REGRESSION GUARD (2026-05-10, v1.22.0 RSI bug A003):
      // Klaviyo is INTENTIONALLY routed differently from pinterest/snapchat/
      // twitter. Klaviyo IS available — but via API-key tile, not OAuth. The
      // pre-fix message ("klaviyo integration is coming soon") confused users
      // because the integration exists, just on a different connection path.
      // Now we route to a dedicated branch that points at the tile.
      if (args.platform === 'klaviyo') {
        return {
          summary: 'Klaviyo connects via API key, not OAuth',
          instructions: 'Open the Connections panel, click the Klaviyo tile, and paste your Private API Key from klaviyo.com → Settings → API Keys. Klaviyo OAuth is not yet supported (TODO provider per CLAUDE.md). After connecting, mcp__merlin__klaviyo will work for the connected brand.',
        };
      }
      // Coming-soon defense-in-depth — pinterest/snapchat/twitter were
      // dropped from the zod enum (D5.3 fix) so the agent can't reach this
      // branch for them anymore. Defense-in-depth: keep the dormant entries
      // here so a future enum addition that forgets to wire the provider
      // lands a friendly message instead of a binary fatal.
      //
      // klaviyo stays in this list as belt-and-braces protection. The
      // early `args.platform === 'klaviyo'` branch above ALWAYS catches
      // klaviyo with the API-key tile copy, so this entry is unreachable
      // today — but if a future refactor accidentally removes that branch,
      // klaviyo falls through to a generic "coming soon" message instead
      // of a binary fatal, preserving the friendly-error contract.
      const comingSoon = ['pinterest', 'snapchat', 'twitter', 'klaviyo'];
      if (comingSoon.includes(args.platform)) {
        return {
          summary: `${args.platform} integration is coming soon`,
          instructions: `${args.platform} is not yet available.`,
        };
      }
      // API-key connectors (no OAuth): direct user to the tile input in the
      // Connections panel. AppLovin MAX and AppDiscovery are two separate keys
      // (publisher vs advertiser); the tile surfaces both inputs.
      if (args.platform === 'applovin') {
        return {
          summary: 'AppLovin connects via API keys (MAX + AppDiscovery)',
          instructions: 'Click the AppLovin tile in the Connections panel and paste your MAX Report Key (publisher) and/or AppDiscovery Report Key (advertiser). Find them in dash.applovin.com → Account → Keys. Then use connection_status to verify.',
        };
      }
      if (args.platform === 'postscript') {
        return {
          summary: 'Postscript connects via API key',
          instructions: 'Click the Postscript tile in the Connections panel and paste your API key from app.postscript.io → Settings → API. Then use connection_status to verify.',
        };
      }
      if (args.platform === 'openai_ads') {
        return {
          summary: 'OpenAI Ads connects via API key',
          instructions: 'Click the OpenAI Ads tile in the Connections panel and paste your Ads API key from ads.openai.com (Settings → API). It authorizes real ad spend, so it is entered in a masked field, never in chat. Then call mcp__merlin__openai_ads with action "verify" to confirm it works, or connection_status to check.',
        };
      }
      // Microsoft Clarity connects via the dedicated `clarity` tool: it
      // owns the connect/verify flow (browser open + brand-scoped token
      // persistence in the Go binary), so platform_login just routes there.
      if (args.platform === 'clarity') {
        return {
          summary: 'Microsoft Clarity connects via the clarity tool',
          instructions: 'Call mcp__merlin__clarity with action "connect" — it opens Clarity so the user can generate a Data Export API token (Settings → Data Export, project admin only). When they paste the token back, call clarity with action "verify" and the apiKey to save it for this brand. Then connection_status will show Clarity as connected.',
        };
      }
      // PostHog connects via the dedicated `posthog` tool — it owns the
      // connect/verify flow (browser open + brand-scoped persistence in
      // the Go binary), so platform_login just routes there.
      if (args.platform === 'posthog') {
        return {
          summary: 'PostHog connects via the posthog tool',
          instructions: 'Call mcp__merlin__posthog with action "connect" — it opens PostHog so the user can mint a Personal API Key (Settings → Personal API Keys, scopes "Query Read" + "Project Read"). When they paste the key back, call posthog with action "verify" and the apiKey to save it for this brand (it auto-detects the US/EU region). Then connection_status will show PostHog as connected.',
        };
      }
      // Triple Whale — OAuth is the primary connect path, but its OAuth app
      // registration is pending (TRIPLEWHALE_CLIENT_ID Worker secret not yet
      // set), so the binary's triplewhale-login refuses with a guide-to-key
      // message. Until then route to the dedicated triplewhale tool's personal
      // API-key flow, which works today. WHEN THE TW OAUTH APP IS REGISTERED:
      // delete this branch (the generic runOAuthFlow path below already handles
      // 'triplewhale' via the legacy binary-login → triplewhale-login route,
      // which picks up the BFF-injected clientId) AND add 'triplewhale' to
      // ACTIVE_PLATFORMS in oauth-provider-config.js to graduate it to
      // fast-open. Mirrors the clarity/posthog dedicated-tool pattern above.
      if (args.platform === 'triplewhale') {
        return {
          summary: 'Triple Whale connects via the triplewhale tool',
          instructions: 'Call mcp__merlin__triplewhale with action "connect" for the steps — mint a personal API key at app.triplewhale.com/api-keys (select the "Summary Page: Read" + "Pixel Attribution: Read" scopes), then call triplewhale with action "verify" and the apiKey to save it. Once connected, mcp__merlin__triplewhale action "summary" pulls NC-ROAS, NCPA, MER, and blended ROAS. (OAuth sign-in is the primary path and turns on once the Triple Whale OAuth app is registered.)',
        };
      }
      try {
        const extra = args.store ? { store: args.store } : undefined;
        const result = await ctx.runOAuthFlow(args.platform, args.brand || '', extra);
        if (result.error) {
          return envelope.fail(errors.makeError('INTERNAL_ERROR', {
            message: `Connection failed: ${redactOutput(result.error, '')}`,
          }));
        }
        // NEVER return tokens. Only success status.
        return { summary: `Connected ${args.platform}`, success: true, platform: args.platform };
      } catch (e) {
        return envelope.fail(errors.makeError('INTERNAL_ERROR', {
          message: `Connection error: ${redactOutput(e.message, '')}`,
        }));
      }
    },
  }, tool, z, ctx));

  // ── brand_scrape ─────────────────────────────────────────
  //
  // Capture a BrandSignal from a live URL using the in-process Electron
  // BrowserWindow. Returns palette, typography, logo candidates, screenshots,
  // JSON-LD schema, copy samples, and CSS tokens — the raw material Claude
  // synthesizes into a brand-guide.json via the merlin-brand-guide skill.
  //
  // Default output OMITS screenshots (1-3MB base64 each) and raw HTML to keep
  // Claude's context budget intact. Callers that need screenshots (e.g. for
  // vision-based disambiguation) must pass includeScreenshots: true.
  tools.push(defineTool({
    name: 'brand_scrape',
    description: 'Scrape a brand website to capture palette, typography, logo candidates, and copy samples. Used once during onboarding; the output feeds brand-guide synthesis. Screenshots are stripped by default.',
    destructive: false,
    idempotent: true,
    costImpact: 'none',
    brandRequired: false,
    input: {
      url: z.string().describe('Brand homepage URL (e.g. https://madchill.com)'),
      includeScreenshots: z.boolean().optional().describe('Include base64 desktop+mobile PNGs (large — only set true when vision analysis is needed)'),
      includeHtml: z.boolean().optional().describe('Include raw HTML of homepage + about page (very large — usually unnecessary)'),
    },
    handler: async ({ url, includeScreenshots, includeHtml }) => {
      if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return validationEnvelope('url must be an http(s) URL');
      }
      let scrapeBrand;
      try {
        ({ scrapeBrand } = require('./brand-scraper'));
      } catch (e) {
        return envelope.fail(errors.makeError('INTERNAL_ERROR', {
          message: `brand-scraper module failed to load: ${e.message}`,
        }));
      }

      // Per-invocation correlation ID — lets the renderer (Cluster-M §3.6)
      // stitch multi-stage progress events for a single scrape into one pill
      // even if another scrape starts before this one finishes.
      const scrapeId = crypto.randomBytes(16).toString('hex');
      const startedAt = Date.now();
      emitScrapeProgress(ctx, {
        tool: 'brand_scrape',
        scrapeId,
        stage: 'start',
        label: 'Reading homepage',
        pct: 0.05,
        url,
      });

      try {
        // REGRESSION GUARD (2026-05-02, RSI Session 4 D7.6 fix): forward
        // intra-scrape stage progress to the renderer pill so a 60s scrape
        // doesn't sit stuck at 5% the entire wait. The pre-fix UX was
        // "Reading homepage" pinned for the full duration even as the
        // scraper internally advanced through primary-load → primary-signal
        // → primary-screenshot → secondary-pages → logo-quantize. Each
        // stage now translates to a renderer-friendly label aligned with
        // SKILL.md's narration vocabulary so the pill text stays in sync
        // with what the agent is naturally reporting in chat.
        const stageLabels = {
          'primary-load': 'Reading homepage',
          'primary-signal': 'Capturing brand signals',
          'primary-screenshot': 'Taking screenshots',
          'secondary-pages': 'Crawling secondary pages',
          'logo-quantize': 'Extracting brand colors',
          'complete': 'Almost done',
        };
        const signal = await scrapeBrand(url, {
          onProgress: (stage, pct) => {
            emitScrapeProgress(ctx, {
              tool: 'brand_scrape',
              scrapeId,
              stage,
              label: stageLabels[stage] || stage,
              pct,
              url,
            });
          },
        });
        if (!includeScreenshots && signal.screenshots) {
          signal.screenshots = {
            desktop: '[elided — pass includeScreenshots:true to include ~1-3MB base64 PNG]',
            mobile: '[elided — pass includeScreenshots:true to include ~1-3MB base64 PNG]',
          };
        }
        if (!includeHtml) {
          if (signal.homepage_html) signal.homepage_html = '[elided — pass includeHtml:true]';
          if (signal.about_html) signal.about_html = '[elided — pass includeHtml:true]';
        }

        // Derive counts the UI + SKILL narration can mirror. Defensive —
        // the signal shape is authored by brand-scraper.js; if any field
        // moves or goes missing we still emit a clean `done` event rather
        // than crashing the handler.
        const primary = (signal && signal.primary) || {};
        const productTitles = Array.isArray(primary.copy && primary.copy.productTitles)
          ? primary.copy.productTitles.length : 0;
        const logoCandidates = Array.isArray(primary.logoCandidates)
          ? primary.logoCandidates.length : 0;
        const logoColors = Array.isArray(signal && signal.logoColors)
          ? signal.logoColors.length : 0;
        const secondaryPages = Array.isArray(signal && signal.secondaryPages)
          ? signal.secondaryPages.length : 0;

        emitScrapeProgress(ctx, {
          tool: 'brand_scrape',
          scrapeId,
          stage: 'done',
          // Matches the "Found 14 products" / "Downloaded logo" vocabulary
          // called out in the narration-exception section of merlin-setup
          // SKILL.md (Cluster-E commit 32a78b2). If this wording ever drifts,
          // update the SKILL narration examples in lockstep.
          label: productTitles > 0
            ? `Found ${productTitles} product${productTitles === 1 ? '' : 's'}`
            : 'Scrape complete',
          pct: 1,
          url,
          detail: {
            products: productTitles,
            logoCandidates,
            logoColors,
            secondaryPages,
            elapsedMs: Date.now() - startedAt,
          },
        });

        // REGRESSION GUARD (2026-05-10, D003): explicit envelope.ok with
        // nextSuggested so the agent knows the canonical next steps after a
        // successful scrape are brand_guide synthesis and brand_activate.
        return envelope.ok({
          data: { summary: `Scraped ${url}`, signal },
          nextSuggested: ['brand_guide', 'brand_activate'],
        });
      } catch (e) {
        // REGRESSION GUARD (2026-04-20): every scrape failure must map to
        // a structured envelope so the onboarding skill can tell the user
        // "scrape took too long, retry or try a simpler URL" instead of
        // leaving the UI frozen. Timeout is the single hang mode that
        // paying users have hit — surface it with TIMEOUT so Claude's
        // next_action is retry_or_split rather than a dead-end error.
        const raw = (e && e.message) || String(e);
        const isTimeout = (e && e.code === 'TIMEOUT') || /timed? ?out|ScrapeTimeoutError/i.test(raw);
        if (isTimeout) {
          // Task 3.2 — second timeout within 10min on the SAME URL bumps
          // the agent into the manual-entry fallback path. First timeout
          // still returns retry_or_split (the existing Rule-13-compliant
          // behavior). `_hasRecentScrapeTimeout` is checked BEFORE we
          // record the new timeout so "first scrape ever for this URL"
          // does not false-fire the fallback. The structured `data`
          // payload the Electron UI uses to render a manual-entry card
          // is documented in merlin-setup SKILL.md — keep the field names
          // in sync with that guide.
          const repeated = _hasRecentScrapeTimeout(url);
          _recordScrapeTimeout(url);

          emitScrapeProgress(ctx, {
            tool: 'brand_scrape',
            scrapeId,
            stage: 'timeout',
            label: repeated
              ? 'Still timing out — switching to manual entry'
              : 'Scrape timed out — you can retry',
            pct: 1,
            url,
            detail: { repeated, elapsedMs: Date.now() - startedAt },
          });

          if (repeated) {
            return envelope.fail(
              errors.makeError('TIMEOUT', {
                message: `We couldn't reach ${url} twice in a row. Skip the scrape and enter your brand basics manually — it takes about 30 seconds.`,
                next_action: 'manual_entry_fallback',
              }),
              {
                data: {
                  // Schema the renderer uses to draw the manual-entry card.
                  // Cluster-M (§3.6 pill) should NOT consume this — this is
                  // for the model / a future renderer card. The pill
                  // listens to ctx.emitProgress(mcp-progress) events; this
                  // payload is for the agent-side prompt flow.
                  manualEntry: {
                    url,
                    reason: 'repeat_scrape_timeout',
                    // Field keys match the shapes merlin-setup SKILL.md
                    // asks for during brand onboarding — keep these in
                    // sync with the SKILL's brand.md scaffolding.
                    fields: [
                      {
                        key: 'brandName',
                        label: 'Brand name',
                        placeholder: 'e.g. Madchill',
                        required: true,
                      },
                      {
                        key: 'vertical',
                        label: 'What kind of business?',
                        type: 'choice',
                        options: [
                          'Ecommerce/DTC',
                          'SaaS/Software',
                          'Agency/Service',
                          'Other',
                        ],
                        required: true,
                      },
                      {
                        key: 'productList',
                        label: 'Products or offerings (one per line)',
                        type: 'multiline',
                        placeholder: 'Classic Hoodie\nEveryday Jogger\n...',
                        required: false,
                      },
                      {
                        key: 'logoPath',
                        label: 'Drag your logo here (optional)',
                        type: 'file',
                        accept: 'image/png,image/jpeg,image/svg+xml',
                        required: false,
                      },
                    ],
                  },
                },
              },
            );
          }

          return envelope.fail(errors.makeError('TIMEOUT', {
            message: `Brand scrape took too long for ${url}. The site may be slow or blocking automated requests. Retry, or try the apex domain (e.g. https://example.com) instead of a subpath.`,
          }));
        }

        emitScrapeProgress(ctx, {
          tool: 'brand_scrape',
          scrapeId,
          stage: 'error',
          label: 'Scrape failed',
          pct: 1,
          url,
          detail: { elapsedMs: Date.now() - startedAt, error: 'internal' },
        });
        return envelope.fail(errors.makeError('INTERNAL_ERROR', {
          message: `Scrape failed: ${redactOutput(raw, '')}`,
        }));
      }
    },
  }, tool, z, ctx));

  // ── bulk_upload ──────────────────────────────────────────
  //
  // File a batch of media files (already on disk — typically dropped or
  // pasted by the user as chat attachments) into the brand's product
  // references/ folders via the Go Jaro-Winkler matcher. Use ONLY when:
  //   1. The user has attached 5+ files in one message AND
  //   2. The intent is clearly "file these with products" (e.g. "for the
  //      POG launch — sort these", "associate these to products").
  //
  // For 1-4 attachments OR ambiguous intent, treat each file as direct
  // content (Read for images, decide downstream). The matcher is a hammer
  // — calling it implicitly on every drop strips the LLM's ability to
  // QA-review or repurpose attachments before filing.
  //
  // Returns the same shape the renderer drag-drop IPC returns:
  // { added, skippedDup, autoAssociated, needsReview, rejected, failedMoves }.
  tools.push(defineTool({
    name: 'bulk_upload',
    description: 'File 5+ media attachments into product references/ folders via the Jaro-Winkler matcher. Use ONLY when the user explicitly asks to "file/sort/associate these to products" with a multi-file batch. For 1-4 attachments OR ambiguous intent, treat files as direct content (Read images, etc.) instead.',
    destructive: true,
    idempotent: true,
    costImpact: 'none',
    brandRequired: true,
    preview: false,
    input: {
      brand: brandSchema.describe('Brand whose inbox / products receive the files'),
      // The renderer-side and IPC backend already enforce the 1-200 cap
      // (BULK_UPLOAD_MAX_FILES in main.js). zod's .min/.max chaining isn't
      // available on the SDK's z mock used in tests, so the runtime length
      // check below in the handler is the authoritative gate.
      files: z.array(z.string()).describe('Absolute file paths (1-200, already on disk). Allowed extensions: png, jpg, jpeg, gif, webp, heic, heif, mp4, mov, webm, m4v, avi.'),
    },
    handler: async ({ brand, files }) => {
      if (typeof ctx.bulkUploadAssets !== 'function') {
        return envelope.fail(errors.makeError('INTERNAL_ERROR', {
          message: 'bulk_upload pipeline not wired in this build',
        }));
      }
      if (!Array.isArray(files) || files.length === 0) {
        return validationEnvelope('files must be a non-empty array of absolute paths');
      }
      if (files.length > 200) {
        return validationEnvelope('Too many files in one call (max 200)');
      }
      // The IPC handler expects { name, path, size } per file. We have only
      // paths here; derive the rest via fs.statSync. Files that don't exist
      // or aren't regular files get reported back as `rejected` by the
      // pipeline's per-file validator (validateInputFile in bulk-upload.js).
      // REGRESSION GUARD (2026-04-29, Gitar PR #143 finding 2): use the
      // promise-based fs API so 200 stat calls don't block the Electron
      // main-process event loop (~100-200ms stall on slow disks would
      // freeze IPC + UI). The handler is already async — there's no
      // reason to use the sync variant.
      const fileObjs = [];
      const preRejected = [];
      for (const p of files) {
        if (typeof p !== 'string' || !p) {
          preRejected.push({ file: '(empty)', reason: 'bad-input' });
          continue;
        }
        let st;
        try { st = await fs.promises.stat(p); }
        catch { preRejected.push({ file: path.basename(p), reason: 'not-found' }); continue; }
        if (!st.isFile()) {
          preRejected.push({ file: path.basename(p), reason: 'not-a-file' });
          continue;
        }
        fileObjs.push({ name: path.basename(p), path: p, size: st.size });
      }
      if (fileObjs.length === 0) {
        return envelope.ok({
          data: {
            summary: `No usable files (${preRejected.length} rejected)`,
            added: [],
            skippedDup: [],
            autoAssociated: [],
            needsReview: [],
            rejected: preRejected,
          },
        });
      }
      const result = await ctx.bulkUploadAssets({ brand, files: fileObjs });
      if (result && result.error) {
        return envelope.fail(errors.makeError('INTERNAL_ERROR', { message: result.error }));
      }
      const added = (result.added || []).length;
      const auto = (result.autoAssociated || []).length;
      const review = (result.needsReview || []).length;
      const skipped = (result.skippedDup || []).length;
      const rejectedAll = (result.rejected || []).concat(preRejected);
      return envelope.ok({
        data: {
          summary: `Uploaded ${added} (${auto} auto-filed, ${review} need review, ${skipped} duplicates, ${rejectedAll.length} rejected)`,
          added: result.added || [],
          skippedDup: result.skippedDup || [],
          autoAssociated: result.autoAssociated || [],
          needsReview: result.needsReview || [],
          rejected: rejectedAll,
          failedMoves: result.failedMoves || [],
        },
      });
    },
  }, tool, z, ctx));

  // ── brand_guide ──────────────────────────────────────────
  //
  // Validate, write, or read the brand-guide.json for a brand.
  tools.push(defineTool({
    name: 'brand_guide',
    description: 'Validate, write, or read a brand-guide.json. Validate runs WCAG contrast math + forbidden-word scan + schema checks without persisting. Write atomically persists a pre-validated guide. Read returns the persisted guide for review / downstream creative generation.',
    destructive: true,
    idempotent: true,
    costImpact: 'none',
    brandRequired: false,
    preview: false,
    input: {
      action: z.enum(['validate', 'write', 'read']).describe('validate=dry-run checks only; write=persist to brand folder; read=return persisted guide'),
      brand: brandSchema.optional().describe('Brand name — required for write and read'),
      brandGuide: z.any().optional().describe('The brand guide JSON object (required for validate and write)'),
    },
    handler: async (args) => {
      const action = `${args.action}-brand-guide`;
      if (action === 'validate-brand-guide' && !args.brandGuide) {
        return validationEnvelope('brandGuide (the JSON object) is required for validate');
      }
      if (action === 'write-brand-guide' && (!args.brand || !args.brandGuide)) {
        return validationEnvelope('brand and brandGuide are both required for write');
      }
      if (action === 'read-brand-guide' && !args.brand) {
        return validationEnvelope('brand is required for read');
      }
      const payload = { action, brand: args.brand };
      if (args.brandGuide !== undefined) {
        if (typeof args.brandGuide === 'string') {
          try {
            payload.brandGuide = JSON.parse(args.brandGuide);
          } catch (e) {
            return validationEnvelope(`brandGuide is not valid JSON: ${e.message}`);
          }
        } else {
          payload.brandGuide = args.brandGuide;
        }
      }
      return toEnvelope(await runBinary(ctx, action, payload, { timeout: 30000 }));
    },
  }, tool, z, ctx));

  // ── brand_activate ───────────────────────────────────────
  //
  // Atomically promote a freshly-scaffolded brand to the active brand. Called
  // by the merlin-setup skill the instant `brand.md` exists, so the rest of
  // the onboarding conversation (scheduled-task creation, the WOW summary)
  // is associated with the new brand thread. The host updates `.merlin-state`
  // and fires a `brand-activated` IPC event that the renderer uses to refresh
  // its dropdown / connections / spells / perf bar — WITHOUT restarting the
  // SDK session (the current turn is the setup turn) and WITHOUT repainting
  // chat (the user is watching the setup conversation; tearing it down to
  // load an empty new-brand thread mid-onboarding would be terrible UX).
  tools.push(defineTool({
    name: 'brand_activate',
    description: 'Register + activate a brand so it appears in the dropdown. Call this FIRST during onboarding — right after the user gives their website URL and BEFORE scraping — passing {brand, displayName, url}. The host creates assets/brands/<brand>/ with a stub brand.md + memory.md and switches to it immediately, so if the scrape or any later step fails the brand is already saved + switchable and setup can resume (no redo). Updates the dropdown selector and refreshes connections / spells / perf bar. Idempotent — calling with the already-active brand is a no-op. On a later plain switch, call with just {brand}.',
    destructive: false,
    idempotent: true,
    costImpact: 'none',
    brandRequired: false,
    input: {
      brand: z.string().regex(BRAND_NAME_PATTERN).describe('Brand folder name under assets/brands/ (lowercase, alphanumeric + hyphen/underscore). Derive from the domain (gymshark.com → "gymshark") and keep it fixed for the life of the brand.'),
      displayName: z.string().optional().describe('Human-readable brand name shown in the dropdown + stub brand.md. Pass on first registration; omit on a plain switch.'),
      url: z.string().optional().describe('Brand website URL. Passing this (or displayName) tells the host to CREATE the brand if it does not exist yet — the dropdown-first registration. Omit on a plain switch to keep the switch-only guard.'),
    },
    handler: async ({ brand, displayName, url }) => {
      if (typeof ctx.activateBrand !== 'function') {
        return envelope.fail(errors.makeError('INTERNAL_ERROR', {
          message: 'host did not wire ctx.activateBrand — brand_activate is unavailable in this build',
        }));
      }
      const result = ctx.activateBrand(brand, { displayName, url });
      if (!result || result.ok !== true) {
        const rawCode = (result && result.code) || 'INTERNAL_ERROR';
        // The host returns VALIDATION for malformed slugs; the canonical code
        // table calls that INVALID_INPUT. BRAND_MISSING and INTERNAL_ERROR
        // pass through unchanged.
        const code = rawCode === 'VALIDATION' ? 'INVALID_INPUT' : rawCode;
        return envelope.fail(errors.makeError(code, {
          message: (result && result.message) || 'brand activation failed',
        }));
      }
      // REGRESSION GUARD (2026-05-10, D003): nextSuggested points the agent
      // at connection_status so the post-activation flow can show what
      // platforms are wired up for the now-active brand.
      return envelope.ok({
        data: {
          summary: result.previousBrand && result.previousBrand !== brand
            ? `Activated brand "${brand}" (was "${result.previousBrand}")`
            : `Activated brand "${brand}"`,
          brand,
          previousBrand: result.previousBrand || '',
        },
        nextSuggested: ['connection_status'],
      });
    },
  }, tool, z, ctx));

  // ── decisions ────────────────────────────────────────────
  tools.push(defineTool({
    name: 'decisions',
    description: 'Read the brand\'s DecisionFact chain (signed kill/scale events). action=queue returns unconsumed decisions that still need a follow-up (e.g. kills awaiting a replacement ad).',
    destructive: false,
    idempotent: true,
    costImpact: 'none',
    brandRequired: true,
    input: {
      action: z.enum(['queue']).describe('queue=list unconsumed DecisionFacts (kills needing replacements)'),
      brand: brandSchema.describe('Brand name'),
      sinceUnix: z.number().optional().describe('Only return decisions with Timestamp >= this Unix seconds value (default: all)'),
    },
    handler: async (args) => {
      const payload = { action: 'decision-queue', brand: args.brand };
      if (args.sinceUnix !== undefined) payload.sinceUnix = args.sinceUnix;
      return toEnvelope(await runBinary(ctx, 'decision-queue', payload));
    },
  }, tool, z, ctx));

  // ── jobs_poll / jobs_list / jobs_cancel ─────────────────────
  //
  // Long-running tools (bulk-push to 500 ads, 30k-product catalog sync,
  // full-site SEO audit) return { jobId } immediately and run the work in
  // the background. The agent polls jobs_poll until state is terminal
  // (done / failed / cancelled), then reads the final envelope from
  // `progress.result`. This is the piece that unlocks Forever-21-scale
  // work inside the 5-minute MCP timeout.
  //
  // ctx.jobStore is the shared JobStore instance wired in mcp-server.js.
  // If missing (e.g., stripped-down test harnesses), the three tools
  // return a clean BRAND_MISSING-style envelope instead of crashing.
  const jobsMissingEnvelope = () =>
    envelope.fail(errors.makeError('INTERNAL_ERROR', {
      message: 'Job store is not initialized on this MCP server.',
      next_action: 'Check that createMerlinMcpServer() wired ctx.jobStore.',
    }));

  tools.push(defineTool({
    name: 'jobs_poll',
    description: 'Poll a background job by jobId. Returns the job state (queued|running|done|failed|cancelled), progress, and the final envelope once terminal. Call this repeatedly for long-running tools until state is terminal.',
    destructive: false,
    idempotent: true,
    costImpact: 'none',
    brandRequired: false,
    input: {
      jobId: z.string().describe('The jobId returned by a long-running tool'),
    },
    handler: async ({ jobId }) => {
      if (!ctx.jobStore) return jobsMissingEnvelope();
      const job = ctx.jobStore.get(jobId);
      if (!job) {
        return envelope.fail(errors.makeError('JOB_NOT_FOUND', {
          message: `Job ${jobId} not found or already pruned.`,
          next_action: 'Verify the jobId, or re-run the originating tool if the job was pruned after 7-day retention.',
        }));
      }
      return envelope.ok({
        data: {
          summary: `Job ${job.jobId} ${job.state}${typeof job.pct === 'number' ? ` (${Math.round(job.pct * 100)}%)` : ''}`,
          jobId: job.jobId,
          tool: job.tool,
          brand: job.brand,
          state: job.state,
          stage: job.stage,
          pct: job.pct,
          etaSec: job.etaSec,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          result: job.result,
          error: job.error,
          terminal: ['done', 'failed', 'cancelled'].includes(job.state),
        },
        progress: {
          jobId: job.jobId,
          stage: job.stage,
          pct: job.pct,
          eta_sec: job.etaSec,
        },
      });
    },
  }, tool, z, ctx));

  tools.push(defineTool({
    name: 'jobs_list',
    description: 'List background jobs, newest first. Filter by brand, tool, or state. Terminal jobs are retained for 7 days.',
    destructive: false,
    idempotent: true,
    costImpact: 'none',
    brandRequired: false,
    input: {
      brand: brandSchema.optional().describe('Filter by brand'),
      tool: z.string().optional().describe('Filter by tool name (e.g. "meta_bulk_push")'),
      state: z.enum(['queued', 'running', 'done', 'failed', 'cancelled']).optional().describe('Filter by state'),
      limit: z.number().optional().describe('Max results (default: 50)'),
    },
    handler: async (args) => {
      if (!ctx.jobStore) return jobsMissingEnvelope();
      const filters = { limit: typeof args.limit === 'number' ? args.limit : 50 };
      if (args.brand) filters.brand = args.brand;
      if (args.tool) filters.tool = args.tool;
      if (args.state) filters.state = args.state;
      const jobs = ctx.jobStore.list(filters).map((j) => ({
        jobId: j.jobId,
        tool: j.tool,
        brand: j.brand,
        state: j.state,
        stage: j.stage,
        pct: j.pct,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
      }));
      return envelope.ok({
        data: {
          summary: `${jobs.length} job(s)`,
          jobs,
          filters,
        },
      });
    },
  }, tool, z, ctx));

  tools.push(defineTool({
    name: 'jobs_cancel',
    description: 'Request cancellation of a running background job. The job will transition to "cancelled" state on the next checkpoint. Already-terminal jobs return unchanged.',
    destructive: true,
    idempotent: true,
    costImpact: 'none',
    brandRequired: false,
    preview: false,
    input: {
      jobId: z.string().describe('The jobId to cancel'),
    },
    handler: async ({ jobId }) => {
      if (!ctx.jobStore) return jobsMissingEnvelope();
      const result = ctx.jobStore.cancel(jobId);
      if (!result.cancelled && result.reason === 'not_found') {
        return envelope.fail(errors.makeError('JOB_NOT_FOUND', {
          message: `Job ${jobId} not found.`,
          next_action: 'Use jobs_list to find the active jobId.',
        }));
      }
      return envelope.ok({
        data: {
          summary: result.cancelled
            ? `Cancellation requested for ${jobId}`
            : `Job ${jobId} already ${result.state || 'terminal'}; no cancellation needed`,
          jobId,
          cancelled: result.cancelled,
          reason: result.reason,
          state: result.state || null,
        },
      });
    },
  }, tool, z, ctx));

  return tools;
}

module.exports = {
  buildTools,
  runBinary,
  toEnvelope,
  validationEnvelope,
  validateBudget,
  isBrandMissing,
  BRAND_OPTIONAL_ACTIONS,
  META_AUDIT_ACTION_MAP,
  metaAuditEngineAction,
  BUDGET_HARD_CEILING,
  // Revoked-grant tile signal: exported for tests (auth-failures wiring).
  platformForAuthSignal,
  noteAuthSignalFromResult,
  // Progress + fallback internals — exported so tests can clear the tracker
  // between runs. `_resetScrapeTimeoutTrackerForTests` MUST NOT be called
  // from production code; it exists solely to keep test isolation clean.
  _resetScrapeTimeoutTrackerForTests,
  SCRAPE_TIMEOUT_TTL_MS,
};
