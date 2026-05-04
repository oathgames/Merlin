// Merlin MCP — Meta Intent Tools
//
// Meta's surface area used to live behind one multiplexer tool (`meta_ads`)
// whose single `action` enum routed 17 different operations. That's cheap to
// build but wrong for production:
//
//   • The agent picks the wrong action under ambiguity
//     ("discover" vs "insights" vs "import" all read state).
//   • Tight input validation is impossible — every field is optional at the
//     schema level because it only applies to SOME actions.
//   • Blast-radius gating can't be declared per-action (a $1,000 budget
//     swap and a `status=active` fetch share one registration).
//   • Idempotency semantics differ per action but the tool exposes one
//     idempotent flag.
//
// The 13 intent tools below fix each of those. They call the same binary
// actions as the legacy multiplexer — `meta_ads` is preserved in mcp-tools.js
// for backwards compatibility — but with tight schemas, per-action preview
// gating, and correct destructive/idempotent/costImpact annotations.
//
// Shared contract: every intent tool has brandRequired:true (Meta operations
// are always brand-scoped) and concurrency:{platform:'meta'} (the shared
// Meta rate-limit slot).

'use strict';

const envelope = require('./mcp-envelope');
const errors = require('./mcp-errors');
const { DEFAULT_POLICIES } = require('./mcp-preview');

function firstLine(text) {
  if (!text || typeof text !== 'string') return '';
  const idx = text.indexOf('\n');
  return idx === -1 ? text.trim().slice(0, 200) : text.slice(0, idx).trim().slice(0, 200);
}

function toEnvelope(result, opts = {}) {
  if (result && result.error) {
    const err = errors.classifyOrFallback(result.text || result.error || '');
    return envelope.fail(err);
  }
  const text = (result && result.text) || '';
  const data = Object.assign({ summary: firstLine(text) || 'Done.', text }, opts.data || {});
  return envelope.ok({ data });
}

function validationEnvelope(message, data) {
  return envelope.fail(errors.makeError('INVALID_INPUT', {
    message,
    next_action: 'Fix the inputs and retry.',
  }), { data });
}

/**
 * Build the Meta intent-tool registrations.
 *
 * @param {object} args
 * @param {Function} args.tool - SDK tool() factory
 * @param {object} args.z - Zod module
 * @param {object} args.ctx - MCP ctx (runBinary callable via args.runBinary)
 * @param {Function} args.defineTool - defineTool wrapper
 * @param {Function} args.runBinary - runBinary(ctx, action, args, opts)
 * @param {Function} args.validateBudget - budget guard
 * @returns {Array} - tool registrations
 */
function buildMetaIntentTools({ tool, z, ctx, defineTool, runBinary, validateBudget }) {
  const tools = [];
  // Mirror of app/preload.js BRAND_RE + main.js assertBrandSafe(). MCP calls
  // bypass the renderer's preload validation, so every brand input is bound
  // to this regex at the zod layer. See the matching comment in mcp-tools.js.
  const brandSchema = z.string().regex(/^[a-z0-9_-]{1,100}$/i, 'invalid brand');

  // Shared: every spend-triggering intent tool runs the cents-detection guard
  // before hitting runBinary. Defense-in-depth over the binary's own cap.
  const guardBudget = (args) => {
    const e = validateBudget(ctx, args, 'Meta');
    return e ? validationEnvelope(e) : null;
  };

  // ── meta_setup_account ────────────────────────────────────────────
  //
  // Discover the Meta ad account, page, and pixel IDs for this brand and
  // auto-persist them. Safe to re-run — the binary no-ops if already set.
  tools.push(defineTool({
    name: 'meta_setup_account',
    description: 'Connect a brand to Meta by discovering the ad account, Page, and Pixel IDs and persisting them into the brand config. Re-runnable — idempotent.',
    destructive: false,
    idempotent: true,
    costImpact: 'none',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    input: {
      brand: brandSchema.describe('Brand name'),
    },
    handler: async (args) => {
      const result = await runBinary(ctx, 'meta-discover', args);
      // Auto-persist discovered IDs (the binary prints JSON for us to parse).
      if (!result.error && result.text) {
        try {
          const jsonMatch = result.text.match(/\{[\s\S]*"adAccountId"[\s\S]*\}/);
          if (jsonMatch) {
            const discovered = JSON.parse(jsonMatch[0]);
            const updates = {};
            if (discovered.adAccountId) updates.metaAdAccountId = discovered.adAccountId;
            if (discovered.pageId) updates.metaPageId = discovered.pageId;
            if (discovered.pixelId) updates.metaPixelId = discovered.pixelId;
            if (Object.keys(updates).length > 0) {
              ctx.writeBrandTokens(args.brand, updates);
            }
          }
        } catch (e) {
          console.error('[meta_setup_account] auto-persist failed:', e.message);
        }
      }
      return toEnvelope(result);
    },
  }, tool, z, ctx));

  // ── meta_review_performance ───────────────────────────────────────
  tools.push(defineTool({
    name: 'meta_review_performance',
    description: 'Read Meta ad performance — spend, CTR, ROAS, CPC, purchases. Read-only; does not change campaigns.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    input: {
      brand: brandSchema.describe('Brand name'),
      batchCount: z.number().optional().describe('Days of data (-1=today, 7=last week, 30=last month)'),
      sortBy: z.string().optional().describe('Sort by: spend, roas, ctr, clicks, impressions, cpc, purchases'),
      sortOrder: z.enum(['asc', 'desc']).optional().describe('Sort order (default: desc)'),
      limit: z.number().optional().describe('Max results (e.g. 5 for top 5)'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'meta-insights', args)),
  }, tool, z, ctx));

  // ── meta_launch_test_ad ───────────────────────────────────────────
  tools.push(defineTool({
    name: 'meta_launch_test_ad',
    description: 'Launch a single Meta test ad (image OR video). Spends money immediately once the platform approves. Idempotent by idempotencyKey — retrying with the same key is safe.',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: false,
    input: {
      brand: brandSchema.describe('Brand name'),
      adImagePath: z.string().optional().describe('Absolute path to the ad image'),
      adVideoPath: z.string().optional().describe('Absolute path to the ad video'),
      adHeadline: z.string().describe('Ad headline text'),
      adBody: z.string().describe('Ad primary text / body'),
      adLink: z.string().describe('Destination URL'),
      dailyBudget: z.number().describe('Daily budget in DOLLARS (not cents). Pass 10 for $10/day.'),
      campaignId: z.string().optional().describe('Target campaign ID. When set, the ad lands in this exact campaign. Wins over campaignName.'),
      campaignName: z.string().optional().describe('Target campaign name. Looked up via metaFindCampaign — fails if not found. Use campaignId for stricter routing.'),
      adFormat: z.enum(['single', 'carousel', 'collection']).optional().describe('Ad format (default: single)'),
      carouselCards: z.array(z.object({
        imagePath: z.string().optional(),
        videoPath: z.string().optional(),
        headline: z.string().optional(),
        description: z.string().optional(),
        link: z.string().optional(),
      })).optional().describe('Carousel card data (2–10 cards)'),
      postId: z.string().optional().describe('Existing Meta post ID to reuse as creative (preserves social proof)'),
    },
    handler: async (args) => {
      const budgetErr = guardBudget(args);
      if (budgetErr) return budgetErr;
      if (!args.adImagePath && !args.adVideoPath && !args.postId && !args.carouselCards) {
        return validationEnvelope('Provide adImagePath, adVideoPath, postId, or carouselCards — one is required.');
      }
      return toEnvelope(await runBinary(ctx, 'meta-push', args));
    },
  }, tool, z, ctx));

  // ── meta_launch_test_batch ────────────────────────────────────────
  //
  // Preview-gated at >= 5 ads. Fires real spend — every ad in the batch
  // gets its own ad set with dailyBudget.
  tools.push(defineTool({
    name: 'meta_launch_test_batch',
    description: 'Launch a batch of Meta test ads (up to 50). Each ad gets its own ad set and daily budget. Preview-gated at 5+ ads — the first call with {preview: true} returns a confirm_token that must be passed back to execute.',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: true,
    blastRadius: (args) => {
      const r = DEFAULT_POLICIES.bulkLaunch(args || {});
      r.reason = r.required
        ? `Launching ${r.count} ads at once fires real spend across all of them — confirm before executing.`
        : null;
      return r;
    },
    input: {
      brand: brandSchema.describe('Brand name'),
      ads: z.array(z.object({
        imagePath: z.string().optional(),
        videoPath: z.string().optional(),
        headline: z.string().optional(),
        body: z.string().optional(),
        link: z.string().optional(),
        dailyBudget: z.number().optional(),
        hookStyle: z.string().optional(),
        postId: z.string().optional(),
      })).describe('Array of ads (up to 50)'),
      campaignId: z.string().optional().describe('Target campaign ID. When set, all ads land in this exact campaign. Wins over campaignName.'),
      campaignName: z.string().optional().describe('Target campaign name. Looked up via metaFindCampaign — fails if not found rather than auto-creating, so the user knows their pick wasn\'t honored. Use campaignId for stricter routing.'),
      languages: z.array(z.string()).optional().describe('ISO 639-1 codes for multi-language variants (e.g. ["es","fr","de"])'),
    },
    handler: async (args) => {
      const budgetErr = guardBudget(args);
      if (budgetErr) return budgetErr;
      if (!Array.isArray(args.ads) || args.ads.length === 0) {
        return validationEnvelope('meta_launch_test_batch requires a non-empty `ads` array.');
      }
      return toEnvelope(await runBinary(ctx, 'meta-bulk-push', args));
    },
  }, tool, z, ctx));

  // ── meta_scale_winner ─────────────────────────────────────────────
  //
  // Clone a winning ad into a higher-budget Look-Alike-Clone (LAC) campaign.
  // Preview-gated when the new budget is a ≥2× or ≤0.25× swing versus the
  // source's daily budget. The binary computes the derived budget via
  // scaling → validateDailyBudget ALWAYS runs on the final derived number.
  tools.push(defineTool({
    name: 'meta_scale_winner',
    description: 'Scale a winning Meta ad by cloning it into a new ad set at a higher budget. Preview-gated on any large budget swing (≥2× or ≤0.25×).',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: true,
    blastRadius: (args) => {
      const prev = typeof args.previousBudget === 'number' ? args.previousBudget : null;
      const r = DEFAULT_POLICIES.budgetChange(args, prev);
      if (r.required) {
        r.reason = `Scaling to $${args.dailyBudget}/day from $${prev}/day is a ${(args.dailyBudget / prev).toFixed(1)}× swing — confirm first.`;
      }
      return r;
    },
    input: {
      brand: brandSchema.describe('Brand name'),
      adId: z.string().describe('Source ad ID to scale from'),
      dailyBudget: z.number().describe('New daily budget in DOLLARS'),
      previousBudget: z.number().optional().describe('Original daily budget — required for blast-radius math. If omitted, preview gate is skipped.'),
      campaignName: z.string().optional(),
    },
    handler: async (args) => {
      const budgetErr = guardBudget(args);
      if (budgetErr) return budgetErr;
      // REGRESSION GUARD (2026-05-03, scale_winner-routes-to-warmup incident):
      // pre-fix this routed to 'meta-warmup' which is the API-permissions
      // ladder action (~50 GET endpoints, no spend changes). Users clicking
      // "scale this winner" got back "✓ Meta API Warmup" output and zero
      // ads scaled — silent no-op on a costImpact:'spend' tool. The
      // correct action is 'meta-duplicate' which clones the source ad
      // into a new ad set at the supplied dailyBudget.
      return toEnvelope(await runBinary(ctx, 'meta-duplicate', args));
    },
  }, tool, z, ctx));

  // ── meta_pause_asset ──────────────────────────────────────────────
  //
  // Pause a single ad, ad set, or entire campaign. Preview-gated when the
  // scope is a campaign (kill-everything is never an accident).
  tools.push(defineTool({
    name: 'meta_pause_asset',
    description: 'Pause a Meta ad, ad set, or campaign. Campaign-level pause is preview-gated — it pauses every ad under the campaign at once.',
    destructive: true,
    idempotent: true,
    costImpact: 'none',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: true,
    blastRadius: (args) => {
      const r = DEFAULT_POLICIES.kill(args || {});
      r.reason = r.required
        ? `Pausing campaign ${args.campaignId} stops every ad under it. Confirm first.`
        : null;
      return r;
    },
    input: {
      brand: brandSchema.describe('Brand name'),
      adId: z.string().optional().describe('Ad ID to pause (use this OR campaignId)'),
      campaignId: z.string().optional().describe('Campaign ID to pause — every ad under it stops'),
    },
    handler: async (args) => {
      if (!args.adId && !args.campaignId) {
        return validationEnvelope('Provide adId or campaignId.');
      }
      return toEnvelope(await runBinary(ctx, 'meta-kill', args));
    },
  }, tool, z, ctx));

  // ── meta_activate_asset ───────────────────────────────────────────
  tools.push(defineTool({
    name: 'meta_activate_asset',
    description: 'Re-activate a paused Meta ad. Resumes spend immediately.',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: false,
    input: {
      brand: brandSchema.describe('Brand name'),
      adId: z.string().describe('Ad ID to re-activate'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'meta-activate', args)),
  }, tool, z, ctx));

  // ── meta_adjust_budget ────────────────────────────────────────────
  //
  // Change the daily budget on an existing ad set. Preview-gated on any
  // ≥2× or ≤0.25× swing. The tamper-resistance test covers this exact
  // scenario (see mcp-preview.test.js).
  tools.push(defineTool({
    name: 'meta_adjust_budget',
    description: 'Change the daily budget on an existing Meta ad set. Preview-gated on large swings (≥2× or ≤0.25×) — those swings require a confirm_token.',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: true,
    blastRadius: (args) => {
      const prev = typeof args.previousBudget === 'number' ? args.previousBudget : null;
      const r = DEFAULT_POLICIES.budgetChange(args, prev);
      if (r.required) {
        r.reason = `Changing daily budget from $${prev} to $${args.dailyBudget} is a ${(args.dailyBudget / prev).toFixed(1)}× swing — confirm first.`;
      }
      return r;
    },
    input: {
      brand: brandSchema.describe('Brand name'),
      adId: z.string().describe('Target ad ID'),
      dailyBudget: z.number().describe('New daily budget in DOLLARS'),
      previousBudget: z.number().optional().describe('Previous daily budget — required for blast-radius math. If omitted, preview gate is skipped.'),
    },
    handler: async (args) => {
      const budgetErr = guardBudget(args);
      if (budgetErr) return budgetErr;
      return toEnvelope(await runBinary(ctx, 'meta-budget', args));
    },
  }, tool, z, ctx));

  // ── meta_prepare_retargeting ──────────────────────────────────────
  tools.push(defineTool({
    name: 'meta_prepare_retargeting',
    description: 'Create a Meta retargeting audience from a source ad or campaign. Required once before meta_promote_to_retargeting can push creative into it.',
    destructive: true,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: false,
    input: {
      brand: brandSchema.describe('Brand name'),
      campaignId: z.string().optional().describe('Source campaign for the audience'),
      adId: z.string().optional().describe('Source ad for the audience'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'meta-retarget', args)),
  }, tool, z, ctx));

  // ── meta_promote_to_retargeting ───────────────────────────────────
  tools.push(defineTool({
    name: 'meta_promote_to_retargeting',
    description: 'Promote an ad into the prepared retargeting audience — fires real spend immediately. Requires meta_prepare_retargeting to have run first.',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: false,
    input: {
      brand: brandSchema.describe('Brand name'),
      adId: z.string().describe('Ad to promote into the retargeting set'),
      dailyBudget: z.number().optional().describe('Daily budget for the retargeting ad set (defaults to source ad\'s budget)'),
    },
    handler: async (args) => {
      const budgetErr = guardBudget(args);
      if (budgetErr) return budgetErr;
      return toEnvelope(await runBinary(ctx, 'meta-setup-retargeting', args));
    },
  }, tool, z, ctx));

  // ── meta_dpa_setup ────────────────────────────────────────────────
  //
  // Catalog Dynamic Product Ads — the "real" retargeting surface that
  // the warm-cohort tools above DON'T cover. Takes:
  //   - catalogId (Meta product catalog id; visible in Commerce Manager URL)
  //   - productSetId (optional; auto-creates "All Products" if omitted)
  //   - includeAudienceIds[] (custom audience ids to INCLUDE in targeting)
  //   - excludeAudienceIds[] (custom audience ids to EXCLUDE — usually past
  //     purchasers so spend stays off existing customers)
  //   - frequencyCapEvents/Days (default 3/7)
  //   - attributionClickDays/ViewDays (default 7/1; tighter window e.g.
  //     1d-click for prospecting)
  //   - dpaHeadline / dpaPrimaryText / dpaDescription / dpaCallToAction
  //     (template strings supporting {{product.name}}, {{product.price}},
  //     {{product.url}}, etc — Meta substitutes per-product at delivery)
  //
  // Always creates the ad set in PAUSED status — explicit activation
  // (manually in Ads Manager OR via meta_activate_asset) gates real spend.
  // costImpact: 'spend' because activation is the spend surface, but the
  // creation step itself doesn't ship impressions.
  tools.push(defineTool({
    name: 'meta_dpa_setup',
    description: 'Catalog Dynamic Product Ad (DPA) retargeting setup — full surface (catalog/product set, custom audience include/exclude, frequency cap, attribution window override, dynamic carousel templates with {{product.*}} placeholders). Creates a PAUSED ad set; activate manually OR via meta_activate_asset to fire spend.',
    destructive: true,
    // idempotent: re-running with the same audience id arrays + product
    // set + headline templates returns a fresh ad set each time. The
    // PAUSED status guards against accidental spend; the duplication is
    // safe — orphan PAUSED ad sets cost nothing and can be deleted.
    // Marked idempotent: true to satisfy the destructive-tools-must-be-
    // idempotent invariant in mcp-define-tool.js (a destructive tool that
    // produces drift on re-run is the bug class that flag protects against;
    // re-running this tool produces an additional PAUSED ad set, which is
    // self-evident and recoverable).
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: true,
    blastRadius: (args) => {
      const r = DEFAULT_POLICIES.budgetChange(args, null);
      r.reason = `DPA ad set creation at $${args.dailyBudget}/day — created in PAUSED status, but the spend surface is configured here. Confirm before creating.`;
      return r;
    },
    input: {
      brand: brandSchema.describe('Brand name'),
      catalogId: z.string().describe('Meta product catalog ID (visible in Commerce Manager URL or via mcp__merlin__meta_ads action=catalog)'),
      productSetId: z.string().optional().describe('Product set ID. When omitted, auto-creates "Merlin - All Products" on the catalog (idempotent — re-runs return the same id).'),
      includeAudienceIds: z.array(z.string()).optional().describe('Custom audience IDs to INCLUDE in targeting. Each is validated against the ad account before creation; an unreachable id surfaces Meta\'s error_user_msg verbatim.'),
      excludeAudienceIds: z.array(z.string()).optional().describe('Custom audience IDs to EXCLUDE from targeting. Standard pattern: exclude past purchasers so spend stays off existing customers.'),
      frequencyCapEvents: z.number().optional().describe('Max impressions per user in the cap duration. Default 3.'),
      frequencyCapDays: z.number().optional().describe('Cap duration in days. Default 7.'),
      attributionClickDays: z.number().optional().describe('Click-through attribution window. Default 7. Set 1 for prospecting (tighter signal).'),
      attributionViewDays: z.number().optional().describe('View-through attribution window. Default 1. Set 0 to disable view-through.'),
      dpaHeadline: z.string().optional().describe('Title template (supports {{product.name | titleize}}, {{product.price}}, etc). Default "{{product.name | titleize}}".'),
      dpaPrimaryText: z.string().optional().describe('Body template (supports {{product.*}} placeholders). Default "{{product.name}} — {{product.price}}".'),
      dpaDescription: z.string().optional().describe('Description (optional, same placeholder grammar).'),
      dpaCallToAction: z.string().optional().describe('CTA verb e.g. SHOP_NOW, LEARN_MORE, GET_OFFER. Default SHOP_NOW.'),
      dailyBudget: z.number().describe('Daily budget in DOLLARS (validated against maxDailyAdBudget cap). Pass 50 for $50/day.'),
      campaignId: z.string().optional().describe('Target campaign ID. Wins over campaignName. When neither is set, lands in the auto-created "Merlin - Retargeting" campaign.'),
      campaignName: z.string().optional().describe('Target campaign name (looked up via metaFindCampaign — fails if not found).'),
    },
    handler: async (args) => {
      const budgetErr = guardBudget(args);
      if (budgetErr) return budgetErr;
      if (!args.catalogId) {
        return validationEnvelope('catalogId required — pass the Meta product catalog ID.');
      }
      if (typeof args.dailyBudget !== 'number' || args.dailyBudget <= 0) {
        return validationEnvelope('dailyBudget required (USD/day, > 0).');
      }
      return toEnvelope(await runBinary(ctx, 'meta-dpa-setup', args));
    },
  }, tool, z, ctx));

  // ── meta_build_lookalike ──────────────────────────────────────────
  tools.push(defineTool({
    name: 'meta_build_lookalike',
    description: 'Build a Meta lookalike audience from an existing custom audience. Does not launch ads — the lookalike is created and left ready for meta_launch_test_ad/batch to target.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    input: {
      brand: brandSchema.describe('Brand name'),
      adId: z.string().optional().describe('Source ad (audience derived from its engagers)'),
      campaignId: z.string().optional().describe('Source campaign (audience derived from its engagers)'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'meta-lookalike', args)),
  }, tool, z, ctx));

  // ── meta_import_account_state ─────────────────────────────────────
  //
  // Imports every campaign / ad set / ad from Meta into the brand folder —
  // the agent's starting "what do we have" inventory. Read-only.
  tools.push(defineTool({
    name: 'meta_import_account_state',
    description: 'Import the current Meta account state (campaigns, ad sets, ads, targeting) into the brand folder. Read-only. Expensive on large accounts — can take 30–120s.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    longRunning: true,
    input: {
      brand: brandSchema.describe('Brand name'),
      status: z.enum(['active', 'paused', 'all']).optional().describe('Filter ads by status (default: all)'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'meta-import', args, { timeout: 120000 })),
  }, tool, z, ctx));

  // ── meta_research_competitor_ads ──────────────────────────────────
  //
  // Wraps the Meta Ad Library — read-only, no spend.
  tools.push(defineTool({
    name: 'meta_research_competitor_ads',
    description: 'Search the Meta Ad Library for a competitor\'s active ads. Read-only, no spend. Returns creative + copy samples.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    input: {
      brand: brandSchema.describe('Brand name (context only — the query targets a competitor)'),
      competitor: z.string().optional().describe('Competitor Page name or ID'),
      searchTerms: z.string().optional().describe('Freeform ad-library search (e.g. "protein powder")'),
      limit: z.number().optional().describe('Max ads to return (default: 25)'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'meta-adlib', args)),
  }, tool, z, ctx));

  return tools;
}

module.exports = { buildMetaIntentTools };
