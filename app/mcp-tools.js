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
  'slack-login', 'slack-exchange',
  // OAuth login flows — user may connect globally or per-brand; the binary
  // writes to the correct scope based on whether brand was passed.
  'meta-login', 'tiktok-login', 'google-login', 'amazon-login',
  'shopify-login', 'klaviyo-login', 'etsy-login', 'reddit-login',
  'linkedin-login', 'pinterest-login', 'snapchat-login', 'twitter-login',
  // AppLovin + Postscript are API-key connectors (no OAuth). The *-login
  // actions in the binary just verify the key and persist it — no brand
  // context needed for the global-scoped case.
  'applovin-max-login', 'applovin-ad-login', 'postscript-login',
  // Landing page audit takes a raw URL, no brand context needed
  'landing-audit',
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

  // Build merged config with vault-resolved tokens
  const brandName = args.brand || '';
  const cfg = brandName ? ctx.readBrandConfig(brandName) : ctx.readConfig();

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
      },
      (err, stdout, stderr) => {
        // Track for cleanup on app exit
        if (ctx.activeChildProcesses) ctx.activeChildProcesses.delete(child);

        if (err && !stdout) {
          // Binary failed with no output — redact the error message too
          const errMsg = redactOutput('', stderr || err.message);
          return resolve({ text: errMsg || 'Action failed. Try again.', error: true });
        }

        // Redact BOTH stdout and stderr
        const sanitized = redactOutput(stdout || '', stderr || '');
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
 * @param {object} [opts] - { data: extra data to attach on success }
 */
function toEnvelope(result, opts = {}) {
  if (result && result.error) {
    const classified = errors.classifyOrFallback(result.text, result.text || 'Action failed');
    return envelope.fail(classified, opts.meta ? { meta: opts.meta } : undefined);
  }
  const text = (result && result.text) || '';
  return envelope.ok({
    data: Object.assign(
      { summary: firstLine(text), text },
      opts.data || {},
    ),
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
        for (const c of connections) status[c.platform] = c.status;
        return { summary: `Checked ${Object.keys(status).length} platforms`, connections: status };
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
    brandRequired: false,
    concurrency: { platform: 'meta' },
    preview: false,
    input: {
      action: z.enum(['push', 'insights', 'kill', 'activate', 'duplicate', 'setup', 'discover', 'warmup', 'retarget', 'lookalike', 'setup-retargeting', 'adlib', 'catalog', 'budget', 'bulk-push', 'lockdown', 'import']).describe('The operation to perform'),
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
      batchCount: z.number().optional().describe('Days of data (-1=today, 7=last week, 30=last month)'),
      sortBy: z.string().optional().describe('Sort results by: spend, roas, ctr, clicks, impressions, cpc, purchases'),
      sortOrder: z.string().optional().describe('Sort order: desc (default) or asc'),
      limit: z.number().optional().describe('Max results to return (e.g. 5 for top 5)'),
      // Bulk & advanced features
      ads: z.array(z.object({ imagePath: z.string().optional(), videoPath: z.string().optional(), headline: z.string().optional(), body: z.string().optional(), link: z.string().optional(), dailyBudget: z.number().optional(), hookStyle: z.string().optional(), postId: z.string().optional() })).optional().describe('Array of ads for bulk-push (up to 50)'),
      adFormat: z.enum(['single', 'carousel', 'collection']).optional().describe('Ad format (default: single)'),
      carouselCards: z.array(z.object({ imagePath: z.string().optional(), videoPath: z.string().optional(), headline: z.string().optional(), description: z.string().optional(), link: z.string().optional() })).optional().describe('Carousel card data (2-10 cards)'),
      postId: z.string().optional().describe('Existing post ID to reuse as ad creative (preserves social proof)'),
      languages: z.array(z.string()).optional().describe('ISO 639-1 codes for multi-language variants (e.g. ["es","fr","de"])'),
      status: z.string().optional().describe('Filter by status: active, paused, all (for import)'),
    },
    handler: async (args) => {
      // Cents-detection guard (defense-in-depth; binary has its own cap).
      const budgetError = validateBudget(ctx, args, 'Meta');
      if (budgetError) return validationEnvelope(budgetError);

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

  // ── tiktok_ads ───────────────────────────────────────────
  tools.push(defineTool({
    name: 'tiktok_ads',
    description: 'Manage TikTok ad campaigns — create ads, check performance, pause/scale ads.',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: false,
    concurrency: { platform: 'tiktok' },
    preview: false,
    input: {
      action: z.enum(['push', 'insights', 'kill', 'duplicate', 'setup', 'lookalike']).describe('The operation to perform'),
      brand: brandSchema.optional(),
      adId: z.string().optional(),
      campaignId: z.string().optional(),
      dailyBudget: z.number().optional(),
      adImagePath: z.string().optional(),
      adVideoPath: z.string().optional(),
      adHeadline: z.string().optional(),
      adBody: z.string().optional(),
      adLink: z.string().optional(),
      batchCount: z.number().optional().describe('Days of data (-1=today, 7=last week, 30=last month)'),
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
    brandRequired: false,
    concurrency: { platform: 'google' },
    preview: false,
    input: {
      action: z.enum(['push', 'insights', 'kill', 'duplicate', 'setup', 'status']).describe('Operation'),
      brand: brandSchema.optional(),
      adId: z.string().optional(),
      campaignId: z.string().optional(),
      adImagePath: z.string().optional(),
      adHeadline: z.string().optional(),
      adBody: z.string().optional(),
      adLink: z.string().optional().describe('Final URL'),
      dailyBudget: z.number().optional(),
      batchCount: z.number().optional().describe('Days of data (-1=today, 7=last week, 30=last month)'),
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
    brandRequired: false,
    concurrency: { platform: 'amazon' },
    preview: false,
    input: {
      action: z.enum(['push', 'insights', 'kill', 'setup', 'status', 'products', 'orders']).describe('Operation'),
      brand: brandSchema.optional(),
      adId: z.string().optional(),
      campaignId: z.string().optional(),
      dailyBudget: z.number().optional(),
      batchCount: z.number().optional().describe('Days of data'),
    },
    handler: async (args) => {
      const budgetError = validateBudget(ctx, args, 'Amazon');
      if (budgetError) return validationEnvelope(budgetError);
      const prefix = ['products', 'orders'].includes(args.action) ? 'amazon-' : 'amazon-ads-';
      return toEnvelope(await runBinary(ctx, prefix + args.action, args));
    },
  }, tool, z, ctx));

  // ── shopify ──────────────────────────────────────────────
  tools.push(defineTool({
    name: 'shopify',
    description: 'Shopify store data — products, orders, analytics, customer cohorts, import.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: false,
    concurrency: { platform: 'shopify' },
    input: {
      action: z.enum(['products', 'orders', 'import', 'analytics', 'cohorts']).describe('Operation'),
      brand: brandSchema.optional(),
      batchCount: z.number().optional().describe('Days of data (for analytics/orders)'),
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
  tools.push(defineTool({
    name: 'klaviyo',
    description: 'Klaviyo email marketing — performance, lists, campaigns + email template CRUD (list/get/create/update/delete) + bulk template upload from a folder of HTML files (with optional generic-placeholder → Klaviyo Django tag translation). Note: Klaviyo Flows themselves are UI-only — the public API does not expose flow construction.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: false,
    concurrency: { platform: 'klaviyo' },
    input: {
      action: z.enum([
        'performance', 'lists', 'campaigns',
        'templates-list', 'template-get', 'template-create',
        'template-update', 'template-delete', 'templates-bulk-upload',
      ]).describe('Operation'),
      brand: brandSchema.optional(),
      batchCount: z.number().optional().describe('Days of data (performance/campaigns)'),
      // Template fields (used by template-* + bulk-upload actions)
      templateId: z.string().optional().describe('Klaviyo template ID (get/update/delete)'),
      templateName: z.string().optional().describe('Display name for the template (create/update)'),
      htmlContent: z.string().optional().describe('Raw email HTML body (create/update). Max 5 MB.'),
      dir: z.string().optional().describe('Directory of .html files for bulk-upload (must be inside assets/brands/<brand>/)'),
      nameTemplate: z.string().optional().describe('Format string for bulk-upload, e.g. "POG / 01-welcome / {basename}". {basename} = filename without extension.'),
      applyTokens: z.boolean().optional().describe('Translate generic placeholders ({{UNSUB_URL}}, {{ FIRST_NAME }}, {{COMPANY_NAME}}, …) into Klaviyo Django tags. Default true for bulk-upload, false for single template-create/update.'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'klaviyo-' + args.action, args)),
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
      batchCount: z.number().optional().describe('Days of data (default 7, max 365)'),
      limit: z.number().optional().describe('Max rows returned'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'applovin-' + args.action, args)),
  }, tool, z, ctx));

  // ── postscript ───────────────────────────────────────────
  // Postscript SMS. send-campaign and send-message go through preflightTCPA
  // (quiet hours, consent, 10DLC) before hitting the wire. List endpoints are
  // read-only reporting. Login is an API-key verify flow.
  tools.push(defineTool({
    name: 'postscript',
    description: 'Postscript SMS — subscribers, campaigns, keywords, automations (list + send with TCPA preflight).',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: false,
    concurrency: { platform: 'postscript' },
    input: {
      action: z.enum(['status', 'subscribers', 'campaigns', 'keywords', 'automations']).describe('Operation'),
      brand: brandSchema.optional(),
      limit: z.number().optional().describe('Max rows returned'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'postscript-' + args.action, args)),
  }, tool, z, ctx));

  // ── email ────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'email',
    description: 'Email marketing — audit email program, check revenue attribution.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: false,
    input: {
      action: z.enum(['audit', 'revenue']).describe('Operation'),
      brand: brandSchema.optional(),
      batchCount: z.number().optional().describe('Days of data'),
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
    brandRequired: false,
    input: {
      action: z.enum(['audit', 'keywords', 'rankings', 'fix-alt', 'track', 'gaps', 'update-rank']).describe('Operation'),
      brand: brandSchema.optional(),
      url: z.string().optional().describe('Target URL (for audit)'),
    },
    handler: async (args) => {
      const actionMap = { 'fix-alt': 'seo-fix-alt', 'update-rank': 'seo-update-rank' };
      const action = actionMap[args.action] || 'seo-' + args.action;
      return toEnvelope(await runBinary(ctx, action, args));
    },
  }, tool, z, ctx));

  // ── content ──────────────────────────────────────────────
  tools.push(defineTool({
    name: 'content',
    description: 'Create ad images, blog posts, social posts, and batch variations.',
    destructive: true,
    idempotent: true,
    costImpact: 'generation',
    brandRequired: false,
    concurrency: { platform: 'fal' },
    preview: false,
    input: {
      action: z.enum(['image', 'batch', 'blog-post', 'blog-list', 'social-post']).describe('Operation'),
      brand: brandSchema.optional(),
      product: z.string().optional(),
      imagePrompt: z.string().optional().describe('Freeform image prompt'),
      imageCount: z.number().optional().describe('Number of images (1-4)'),
      imageFormat: z.string().optional().describe('"portrait", "square", or "both"'),
      imageModel: z.string().optional().describe('Full fal.ai model slug (preferred) or legacy alias. ALWAYS pass the full slug when possible — the binary accepts any "fal-ai/..." path directly, so new models work without app updates. Examples: "fal-ai/nano-banana-pro", "fal-ai/nano-banana-pro/edit", "fal-ai/bytedance/seedream/v4.5/text-to-image", "fal-ai/flux-pro/v1.1", "fal-ai/ideogram/v3", "fal-ai/imagen4/preview/ultra". Use the "/edit" variant when reference images exist. If the user asks for a model you don\'t know the exact slug for, fetch https://fal.ai/models to find it. Legacy aliases ("flux", "ideogram", "recraft", "seedream", "imagen", "imagen-ultra", "banana", "banana-edit", "banana-pro", "banana-pro-edit") still work but may resolve to outdated slugs.'),
      adBrief: z.any().optional().describe('Structured ad brief object. In addition to the 7-lock fields, populate the 4 camouflage-ad fields when the goal is paid social distribution: openingScenario (relatable moment the avatar lives — kitchen 7am, Uber back seat), conflictBeat {timestamp ≤ 5.0, description as felt experience not product spec, kind: "conflict"}, interruptBeats[] (3–6 spikes spaced ≥1.5s apart with kind: "twist"/"reveal"/"interrupt"/"resolve"), platformNative ("reel"/"tiktok"/"feed"/"stories"). Missing fields cost rubric points; the binary writes rubric.json to the run folder.'),
      varyDimension: z.string().optional().describe('Batch variety axis when imageCount>1. "" or "auto" = pick from populated brief fields (default when imageCount>1). "scenario" | "lighting" | "subject" | "mood" = explicit axis. "none" = disable rotation (rare; for A/B testing a single variable).'),
      compositeMode: z.boolean().optional().describe('Use real product photo + AI scene'),
      productRefPath: z.string().optional().describe('Path to product reference photo'),
      referenceImages: z.array(z.string()).optional(),
      referencesDir: z.string().optional(),
      templatePath: z.string().optional(),
      batchCount: z.number().optional().describe('Number of variations (for batch)'),
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
    brandRequired: false,
    longRunning: true,
    concurrency: { platform: 'fal' },
    preview: false,
    input: {
      brand: brandSchema.optional(),
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
    concurrency: { platform: 'elevenlabs' },
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
    description: 'Analytics and intelligence — cross-platform dashboard, calendar analysis, collective wisdom, landing page audit, competitor scan.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: false,
    input: {
      action: z.enum(['dashboard', 'calendar', 'wisdom', 'report', 'competitor-scan', 'landing-audit']).describe('Operation'),
      brand: brandSchema.optional(),
      batchCount: z.number().optional().describe('Days of data'),
      url: z.string().optional().describe('URL (for landing-audit)'),
    },
    handler: async (args) => {
      const actionMap = { 'competitor-scan': 'competitor-scan', 'landing-audit': 'landing-audit' };
      const action = actionMap[args.action] || args.action;
      return toEnvelope(await runBinary(ctx, action, args, { timeout: 60000 }));
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

  // ── threads ─────────────────────────────────────────────
  tools.push(defineTool({
    name: 'threads',
    description: 'Threads (Meta) — view profile, read posts, check engagement insights.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: false,
    input: {
      action: z.enum(['profile', 'posts', 'insights']).describe('Operation'),
      brand: brandSchema.optional(),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'threads-' + args.action, args)),
  }, tool, z, ctx));

  // ── reddit_ads ───────────────────────────────────────────
  tools.push(defineTool({
    name: 'reddit_ads',
    description: 'Reddit Ads — manage campaigns, ad groups, ads, and check performance.',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: false,
    concurrency: { platform: 'reddit_ads' },
    preview: false,
    input: {
      action: z.enum(['accounts', 'campaigns', 'adgroups', 'ads', 'insights', 'create-campaign', 'create-ad', 'kill']).describe('Operation'),
      brand: brandSchema.optional(),
      campaignId: z.string().optional().describe('Campaign ID'),
      adId: z.string().optional().describe('Ad or ad group ID'),
      campaignName: z.string().optional().describe('Campaign name'),
      dailyBudget: z.number().optional().describe('Daily budget in DOLLARS (not cents). Example: pass 10 for $10/day, 50 for $50/day, 200 for $200/day. NEVER pre-convert to cents — Merlin handles the cents conversion internally when calling the platform\'s API. If the user says "$10 a day", pass 10. If unsure, ask the user.'),
      adHeadline: z.string().optional().describe('Ad headline'),
      adLink: z.string().optional().describe('Destination URL'),
      batchCount: z.number().optional().describe('Days of data (for insights)'),
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
    brandRequired: false,
    concurrency: { platform: 'linkedin' },
    preview: false,
    input: {
      action: z.enum(['accounts', 'campaigns', 'setup', 'push', 'insights', 'kill', 'duplicate', 'budget']).describe('Operation'),
      brand: brandSchema.optional(),
      campaignId: z.string().optional().describe('Campaign ID or URN'),
      adId: z.string().optional().describe('Creative ID or URN'),
      campaignName: z.string().optional().describe('Campaign name'),
      dailyBudget: z.number().optional().describe('Daily budget in DOLLARS (not cents). Example: pass 10 for $10/day, 50 for $50/day, 200 for $200/day. NEVER pre-convert to cents — Merlin handles the cents conversion internally when calling the platform\'s API. If the user says "$10 a day", pass 10. If unsure, ask the user.'),
      adHeadline: z.string().optional().describe('Ad headline'),
      adBody: z.string().optional().describe('Ad body text'),
      adLink: z.string().optional().describe('Destination URL'),
      batchCount: z.number().optional().describe('Days of data (for insights)'),
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
    brandRequired: false,
    concurrency: { platform: 'etsy' },
    input: {
      action: z.enum(['shop', 'products', 'orders']).describe('Operation'),
      brand: brandSchema.optional(),
      batchCount: z.number().optional().describe('Number of results to return (max 100)'),
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
      platform: z.enum(['meta', 'tiktok', 'google', 'shopify', 'amazon', 'klaviyo', 'slack', 'discord', 'etsy', 'reddit', 'applovin', 'postscript']).describe('Platform to connect'),
      brand: brandSchema.optional(),
      store: z.string().optional().describe('Shopify store URL or name (for shopify)'),
    },
    handler: async (args) => {
      // Meta: App Review pending — OAuth not available. User connects via
      // manual token entry in the UI (Meta tile in Connections panel).
      if (args.platform === 'meta') {
        return {
          summary: 'Meta is connected via manual token entry (App Review pending)',
          instructions: 'Ask the user to click the Meta tile in the Connections panel and paste their token from developers.facebook.com/tools/explorer. Then use connection_status to verify.',
        };
      }
      const comingSoon = ['klaviyo'];
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
        const signal = await scrapeBrand(url);
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

        return { summary: `Scraped ${url}`, signal };
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
    description: 'Promote a brand to active immediately after writing assets/brands/<brand>/brand.md. Updates the dropdown selector and refreshes connections / spells / perf bar. Idempotent — calling with the already-active brand is a no-op. Call ONCE per onboarding, after brand.md is written and before scheduled-task creation.',
    destructive: false,
    idempotent: true,
    costImpact: 'none',
    brandRequired: false,
    input: {
      brand: z.string().regex(BRAND_NAME_PATTERN).describe('Brand folder name under assets/brands/ (lowercase, alphanumeric + hyphen/underscore)'),
    },
    handler: async ({ brand }) => {
      if (typeof ctx.activateBrand !== 'function') {
        return envelope.fail(errors.makeError('INTERNAL_ERROR', {
          message: 'host did not wire ctx.activateBrand — brand_activate is unavailable in this build',
        }));
      }
      const result = ctx.activateBrand(brand);
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
      return {
        summary: result.previousBrand && result.previousBrand !== brand
          ? `Activated brand "${brand}" (was "${result.previousBrand}")`
          : `Activated brand "${brand}"`,
        brand,
        previousBrand: result.previousBrand || '',
      };
    },
  }, tool, z, ctx));

  // ── decisions ────────────────────────────────────────────
  tools.push(defineTool({
    name: 'decisions',
    description: 'Read the brand\'s DecisionFact chain (signed kill/scale events). action=queue returns unconsumed decisions that still need a follow-up (e.g. kills awaiting a replacement ad).',
    destructive: false,
    idempotent: true,
    costImpact: 'none',
    brandRequired: false,
    input: {
      action: z.enum(['queue']).describe('queue=list unconsumed DecisionFacts (kills needing replacements)'),
      brand: brandSchema.optional().describe('Brand name'),
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
  BUDGET_HARD_CEILING,
  // Progress + fallback internals — exported so tests can clear the tracker
  // between runs. `_resetScrapeTimeoutTrackerForTests` MUST NOT be called
  // from production code; it exists solely to keep test isolation clean.
  _resetScrapeTimeoutTrackerForTests,
  SCRAPE_TIMEOUT_TTL_MS,
};
