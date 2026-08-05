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

// REGRESSION GUARD (2026-05-10, D003): opts.nextSuggested + opts.errorNextAction
// thread breadcrumbs into the universal envelope so the agent has a concrete
// follow-up after the tool fires (success) or fails (e.g. budget-cap rejection).
function toEnvelope(result, opts = {}) {
  if (result && result.error) {
    const err = errors.classifyOrFallback(result.text || result.error || '');
    if (opts.errorNextAction && !err.next_action) {
      err.next_action = opts.errorNextAction;
    }
    return envelope.fail(err);
  }
  const text = (result && result.text) || '';
  const data = Object.assign({ summary: firstLine(text) || 'Done.', text }, opts.data || {});
  return envelope.ok({ data, nextSuggested: opts.nextSuggested });
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
      return toEnvelope(result, {
        nextSuggested: ['meta_audit', 'meta_review_performance'],
      });
    },
  }, tool, z, ctx));

  // ── meta_review_performance ───────────────────────────────────────
  tools.push(defineTool({
    name: 'meta_review_performance',
    description: 'Read Meta ad performance at campaign, ad-set, AND ad granularity — spend, CTR, ROAS, CPC, purchases. One pull returns pre-aggregated campaign_summary + adset_summary rollups plus the raw ad-level array, so you can quote any tier without summing rows yourself. Use adset_summary for budget decisions (ad set is the meaningful-volume unit). For trend-shaped questions ("daily ROAS this week", "how does today compare to the weekly average") pass granularity:"daily" — the response then also carries daily_series, an account-level per-day array (date, spend, impressions, clicks, ctr, purchases, purchase_value, roas), so one call answers the trend without N pulls and manual diffs. Read-only; does not change campaigns.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    input: {
      brand: brandSchema.describe('Brand name'),
      batchCount: z.coerce.number().int().optional().describe('Days of data (-1=today, 7=last week, 30=last month)'),
      granularity: z.enum(['summary', 'daily']).optional().describe('daily = also return daily_series, one account-level row per day in the window (Meta time_increment=1). Default: summary only.'),
      sortBy: z.string().optional().describe('Sort by: spend, roas, ctr, clicks, impressions, cpc, purchases'),
      sortOrder: z.enum(['asc', 'desc']).optional().describe('Sort order (default: desc)'),
      limit: z.number().optional().describe('Max results (e.g. 5 for top 5)'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'meta-insights', args)),
  }, tool, z, ctx));

  // ── meta_tofu (top-of-funnel analyzer) ─────────────────────────────
  tools.push(defineTool({
    name: 'meta_tofu',
    description: 'Rank Meta ads by how much TOP-OF-FUNNEL (new-customer acquisition) work they do, by joining two per-ad signals: CPMr (= spend/reach*1000, the cost to reach 1,000 DISTINCT people, a pure-Meta fresh-reach metric) and NVP (new-customer percentage = new-customer orders / all attributed orders, from Triple Whale pixel attribution, joined on the native ad_id). Each ad row returns spend, reach, frequency, cpm, cpmr, and — when Triple Whale is connected — nvp, newCustomerOrders, ncCac (spend/new customers), ncPer1kReach, plus a transparent 0-100 tofuScore blending new-customer VOLUME (0.45), NEWNESS share (0.35), and fresh-reach EFFICIENCY (0.20). Sorted by tofuScore desc; pass sortBy for cpmr/nvp/nccac/ncOrders/reach/frequency/ncPer1kReach. If Triple Whale is unreachable it returns the CPMr/frequency ranking alone and sets newCustomerDataAvailable:false. Read-only; changes nothing. Meta ad_id === Triple Whale ad_id, so the newness join is exact. Use to answer "which creatives are prospecting engines vs coasting on returning buyers".',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    input: {
      brand: brandSchema.describe('Brand name'),
      batchCount: z.coerce.number().int().optional().describe('Trailing days ending yesterday (default 7). Ignored when startDate+endDate are given.'),
      startDate: z.string().optional().describe('Exact window start YYYY-MM-DD (pass with endDate). Both halves — Meta CPMr and TW NVP — use this identical window.'),
      endDate: z.string().optional().describe('Exact window end YYYY-MM-DD (inclusive; pass with startDate).'),
      attributionModel: z.string().optional().describe('Triple Whale attribution model for NVP: "triple" (default), "last-touch", "first-touch", "linear", "linear paid", or a verbatim TW model name.'),
      attributionWindow: z.enum(['7_days', '14_days', '28_days', 'lifetime']).optional().describe('Pixel attribution window for NVP (default 7_days). Bounded windows avoid lifetime over-crediting.'),
      sortBy: z.string().optional().describe('tofuScore (default) | cpmr | nvp | nccac | ncOrders | reach | frequency | ncPer1kReach'),
      sortOrder: z.enum(['asc', 'desc']).optional().describe('Sort order (default: desc)'),
      limit: z.number().optional().describe('Max ads to return (e.g. 10 for the top 10).'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'meta-tofu', args)),
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
      return toEnvelope(await runBinary(ctx, 'meta-push', args), {
        nextSuggested: ['meta_review_performance'],
        errorNextAction: 'Check budget context via dashboard',
      });
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
    // REGRESSION GUARD (2026-07-25, unreachable-engine-params incident):
    // this tool routes to the SAME 'meta-bulk-push' engine action as the
    // legacy meta_ads multiplexer, so every Command/BulkAd field the engine
    // reads on that path has to be declared HERE too, because zod strips unknown
    // keys, and this is the surface new agent code is steered to. Keep the
    // key set in sync with meta_ads in mcp-tools.js; both are locked by
    // app/mcp-meta-param-reachability.test.js.
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
        name: z.string().optional(),
      })).describe('Array of ads (up to 50). Each ad accepts an optional `name`, the explicit ad name in Ads Manager. Omit it and the ad is auto-named, which makes a batch reusing several distinct posts impossible to tell apart in reporting.'),
      campaignId: z.string().optional().describe('Target campaign ID. When set, all ads land in this exact campaign. Wins over campaignName.'),
      campaignName: z.string().optional().describe('Target campaign name, looked up via metaFindCampaign. Fails if not found rather than auto-creating, so the user knows their pick wasn\'t honored. Pass createCampaignIfMissing:true to create it instead. Use campaignId for stricter routing.'),
      createCampaignIfMissing: z.boolean().optional().describe('When campaignName names a campaign that does not exist, create it (objective from the brand config; ABO unless campaignBudgetMode says otherwise) instead of failing. Off by default so a typo\'d campaignName errors instead of minting a junk campaign. New campaigns are always created PAUSED.'),
      // Rule 23 reachability: both fields are copied through runBinary into
      // the --cmd JSON and read by Command.CampaignBudgetMode /
      // Command.CampaignDailyBudget (see metaCreateCampaign in meta.go).
      campaignBudgetMode: z.string().optional().describe('Budget mode for a campaign created by createCampaignIfMissing. \'cbo\' puts the daily budget on the CAMPAIGN - Meta then DISCARDS ad-set budgets, so do NOT also pass dailyBudget (the engine hard-errors on that combination). Omitted or anything else means ABO, with the budget on the ad set.'),
      campaignDailyBudget: z.number().optional().describe('Campaign-level daily budget in DOLLARS. Read only under campaignBudgetMode \'cbo\', where it is the real spend governor and is validated against maxDailyAdBudget - an over-cap value is refused, never silently clamped.'),
      sharedAdSet: z.boolean().optional().describe('Put EVERY ad in ONE ad set carrying the full dailyBudget, instead of the default one-ad-set-per-ad (ABO) split. Use for cold creative testing where Meta should concentrate budget on the best creatives rather than force an equal per-ad share.'),
      adSetName: z.string().optional().describe('Shared-ad-set mode only: explicit name for the ad set that gets created. Empty = auto-named.'),
      languages: z.array(z.string()).optional().describe('ISO 639-1 codes for multi-language variants (e.g. ["es","fr","de"])'),
    },
    handler: async (args) => {
      const budgetErr = guardBudget(args);
      if (budgetErr) return budgetErr;
      if (!Array.isArray(args.ads) || args.ads.length === 0) {
        return validationEnvelope('meta_launch_test_batch requires a non-empty `ads` array.');
      }
      return toEnvelope(await runBinary(ctx, 'meta-bulk-push', args), {
        nextSuggested: ['meta_review_performance'],
        errorNextAction: 'Check budget context via dashboard',
      });
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
      return toEnvelope(await runBinary(ctx, 'meta-duplicate', args), {
        errorNextAction: 'Check budget context via dashboard',
      });
    },
  }, tool, z, ctx));

  // ── meta_set_advantage_audience ───────────────────────────────────
  //
  // REGRESSION GUARD (2026-08-03, Rule 23): the engine action
  // meta-set-advantage-audience shipped in merlin-core #327 with NO MCP route.
  // The capability existed, nothing could call it, and nothing failed — caught
  // only by the reachability test during the v1.36.0 release run. Exposed here
  // rather than exempted, because it is genuinely useful on its own.
  //
  // Toggles Meta's Advantage+ audience expansion on an ad set. It does not
  // create spend, but it does change who a live ad set delivers to, so it is
  // destructive and carded rather than auto-approved.
  tools.push(defineTool({
    name: 'meta_set_advantage_audience',
    description: 'Turn Meta Advantage+ audience expansion on or off for an ad set. Expansion lets Meta deliver beyond your defined targeting when it predicts better results, so switching it changes who sees a live ad set. Use when the user says "turn on advantage audience", "enable audience expansion", "stop Meta broadening my targeting", or "lock this ad set to my audience".',
    destructive: true,
    idempotent: true,
    costImpact: 'none',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: true,
    blastRadius: (args) => ({
      required: true,
      reason: `Change Advantage+ audience expansion to "${(args && args.status) || 'unset'}" on ad set ${(args && args.adId) || '(unspecified)'} — this changes who a live ad set delivers to`,
      action: 'set-advantage-audience',
    }),
    input: {
      brand: brandSchema.describe('Brand name'),
      adId: z.string().describe('The ad set ID to change.'),
      status: z.enum(['on', 'off']).describe('"on" lets Meta expand beyond your targeting; "off" holds delivery to the audience you defined.'),
    },
    handler: async (args) => toEnvelope(await runBinary(ctx, 'meta-set-advantage-audience', args)),
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

  // ── meta_batch_pause / meta_batch_activate ────────────────────────
  // One engine action (meta-batch-status) behind TWO tools on purpose: pausing
  // in bulk is the emergency brake and must stay frictionless, while activating
  // in bulk fires spend and must route through the approval card (Rule 19).
  // Both collapse N objects into ONE batched Graph call and return a per-object
  // result, so a partial failure is visible instead of silently truncated.
  const batchStatusInput = {
    brand: brandSchema.describe('Brand name'),
    // Bounds (non-empty, max 50) are enforced engine-side in
    // runMetaBatchStatus; not declared here because the zod surface these tools
    // are built against does not implement array .min()/.max().
    batchStatusIds: z.array(z.string()).describe('Campaign / ad set / ad ids to flip (1-50 — Meta batch cap)'),
  };
  tools.push(defineTool({
    name: 'meta_batch_pause',
    description: 'Pause MANY Meta campaigns, ad sets, or ads at once in a single batched call. Use to stop a whole campaign\'s worth of objects quickly. Returns per-object success/failure.',
    destructive: true,
    idempotent: true,
    costImpact: 'none',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    // Deliberate opt-out of the blast-radius gate, not an oversight: this is
    // the stop-spend direction, so the failure mode a preview token guards
    // against (an unintended large action) does not exist here — the
    // unintended action would be NOT pausing. It matches the "never block the
    // brake" posture that keeps kill/activate out of the pixel and page
    // reference gates (Rules 20/22), and the host-side routing agrees:
    // meta_batch_pause maps to 'audit' (READ_ONLY → auto-approve) in
    // mcp-approval-policy.js, while its spend-firing sibling
    // meta_batch_activate takes preview: true + blastRadius per Rule 19.
    preview: false,
    input: batchStatusInput,
    handler: async (args) => toEnvelope(
      await runBinary(ctx, 'meta-batch-status', { ...args, batchStatus: 'PAUSED' })),
  }, tool, z, ctx));
  tools.push(defineTool({
    name: 'meta_batch_activate',
    description: 'Activate MANY Meta campaigns, ad sets, or ads at once in a single batched call. THIS STARTS SPEND on every object listed. Returns per-object success/failure.',
    destructive: true,
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: true,
    blastRadius: (args) => ({
      required: true,
      scope: 'batch',
      reason: `Activating ${(args.batchStatusIds || []).length} object(s) starts spend on all of them at once. Confirm first.`,
    }),
    input: batchStatusInput,
    handler: async (args) => toEnvelope(
      await runBinary(ctx, 'meta-batch-status', { ...args, batchStatus: 'ACTIVE' })),
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

  // ── meta_edit_audiences ───────────────────────────────────────────
  // Rewrites ONLY the custom-audience inclusion/exclusion lists on an existing
  // ad set; every other targeting key (geo, age, placements, expansion) is
  // preserved. The everyday use is exclusion hygiene on a tiered retargeting
  // ladder: each cooler tier must exclude the hotter ones so the same person
  // is not bid on twice.
  tools.push(defineTool({
    name: 'meta_edit_audiences',
    description: 'Change which custom audiences an existing Meta AD SET includes or excludes, leaving the rest of its targeting untouched. REPLACE semantics: pass the full desired list. Omit a list to leave that side alone. Use for retargeting exclusion cascades (e.g. make a 90-day visitor tier exclude the 15/30-day cart tiers and past purchasers).',
    destructive: true,
    idempotent: true,
    costImpact: 'none',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: true,
    blastRadius: (args) => {
      // Clearing exclusions is the genuinely dangerous edit: it re-exposes
      // purchasers and hotter tiers to an ad set that was deliberately
      // excluding them. Adding exclusions only ever narrows delivery.
      const clearing = Array.isArray(args.excludeAudienceIds) && args.excludeAudienceIds.length === 0;
      return clearing
        ? { required: true, scope: 'adset', reason: `Clearing ALL audience exclusions on ad set ${args.adId} re-exposes past purchasers and hotter retargeting tiers. Confirm first.` }
        : { required: false, reason: null };
    },
    input: {
      brand: brandSchema.describe('Brand name'),
      adId: z.string().describe('Target AD SET id (not an ad id)'),
      includeAudienceIds: z.array(z.string()).optional().describe('Full desired list of custom audience IDs to INCLUDE. Omit to leave inclusions unchanged; pass [] to clear.'),
      excludeAudienceIds: z.array(z.string()).optional().describe('Full desired list of custom audience IDs to EXCLUDE. Omit to leave exclusions unchanged; pass [] to clear.'),
    },
    handler: async (args) => {
      if (!args.includeAudienceIds && !args.excludeAudienceIds) {
        return validationEnvelope('Provide includeAudienceIds and/or excludeAudienceIds (replace semantics — give the full desired list).');
      }
      return toEnvelope(await runBinary(ctx, 'meta-edit-audiences', args));
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
    description: 'Build a Meta lookalike audience. PREFERRED seed is sourceAudienceId: an existing custom audience in the ad account (an uploaded customer list, a persona segment synced by a third-party tool, any saved cohort). The legacy adId seed does NOT model that ad — it mints a fresh 30-day pixel-purchasers audience and models that instead, and it requires a pixel. Does not launch ads; the lookalike is left ready for meta_launch_test_ad/batch to target.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    input: {
      brand: brandSchema.describe('Brand name'),
      // Rule 23 reachability: every field here must be copied through
      // runBinary into the --cmd JSON and read by the Go Command struct.
      // sourceAudienceId -> Command.SourceAudienceID (meta.go
      // metaCreateLookalikeFromAudience). Declared but unrouted params are
      // the exact defect Rule 23 exists to prevent.
      sourceAudienceId: z.string().optional().describe('PREFERRED seed: id of an existing custom audience to model (uploaded customer list, synced persona segment, saved cohort). No pixel required.'),
      lookalikeRatio: z.number().optional().describe('Lookalike size as a RATIO, not a percent: 0.01 = 1% (default), 0.2 = 20% (Meta maximum).'),
      lookalikeCountry: z.string().optional().describe('Two-letter country code for the lookalike, e.g. "US". Defaults to the brand primary target country.'),
      audienceName: z.string().optional().describe('Name for the created lookalike. Defaults to "LLA <pct>% <seed name> - <country>".'),
      adId: z.string().optional().describe('LEGACY seed: a winner ad. Mints a fresh 30-day pixel-purchasers audience as the seed (it does NOT model the ad itself) and requires metaPixelId. Prefer sourceAudienceId.'),
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

  // ── meta_rename_ads ───────────────────────────────────────────────
  //
  // Batch-rename ads. A WRITE (POST /{adId} name) but a fully reversible one
  // that moves no money: renaming back restores the prior state exactly, and
  // no delivery setting changes. So: destructive true (it mutates account
  // state), idempotent true (same adId + same name twice = same end state),
  // costImpact 'none', and routed to the read-only approval tier in
  // mcp-approval-policy.js rather than the spend card.
  //
  // Why it matters: a batch launched without per-ad names lands in Ads
  // Manager as N rows sharing one auto-generated name, which makes reporting
  // unreadable. Before this tool the only fix was renaming by hand.
  tools.push(defineTool({
    name: 'meta_rename_ads',
    description: 'Rename up to 50 Meta ads in one batch call. Use to fix ads that launched with auto-generated names so a batch reusing several distinct posts is readable in Ads Manager reporting. Fully reversible — renaming changes no delivery setting and spends nothing.',
    destructive: true,
    idempotent: true,
    costImpact: 'none',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: false,
    input: {
      brand: brandSchema.describe('Brand name'),
      renameAds: z.array(z.object({
        adId: z.string().describe('Ad ID to rename'),
        name: z.string().describe('New ad name'),
      })).describe('Up to 50 {adId, name} pairs. Meta caps a batch request at 50 sub-requests; a longer list is refused rather than silently truncated. Each rename reports its own success/failure.'),
    },
    handler: async (args) => {
      if (!Array.isArray(args.renameAds) || args.renameAds.length === 0) {
        return validationEnvelope('meta_rename_ads requires a non-empty `renameAds` array of {adId, name}.');
      }
      if (args.renameAds.length > 50) {
        return validationEnvelope(`meta_rename_ads accepts at most 50 renames per call (got ${args.renameAds.length}) — Meta's /?batch cap. Split into several calls.`);
      }
      const bad = args.renameAds.findIndex((r) => !r || !String(r.adId || '').trim() || !String(r.name || '').trim());
      if (bad >= 0) {
        return validationEnvelope(`renameAds[${bad}] is missing adId or name — both are required on every entry.`);
      }
      return toEnvelope(await runBinary(ctx, 'meta-rename-ads', args), {
        nextSuggested: ['meta_audit'],
      });
    },
  }, tool, z, ctx));

  // ── meta_edit_ad_link ─────────────────────────────────────────────
  //
  // Repoint a LIVE ad at a new destination URL. Creative link fields are
  // immutable, so the engine clones the creative with every URL rewritten and
  // swaps the ad onto the clone (see autocmo-core/meta_edit_link.go).
  //
  // costImpact is 'spend' even though this creates no new spend: the ad is
  // ALREADY spending, and this changes where those dollars land. A wrong URL
  // here burns the same real money a bad launch does, so it takes the same
  // always-cards path (INTENT_TOOL_TO_ACTION → 'duplicate'). Under-declaring
  // it as 'api' would auto-approve a live-traffic redirect.
  tools.push(defineTool({
    name: 'meta_edit_ad_link',
    description: 'Change a LIVE Meta ad\'s destination URL. The engine clones the ad\'s creative with every link rewritten (media, copy and enhancement settings preserved) and repoints the ad at the clone, because Meta creative link fields are immutable. Use when an ad is running to a broken, wrong, or retired landing page. Spend does not stop, it redirects — so this is confirmed like a spend action.',
    destructive: true,
    // Same ad + same URL applied twice converges on the same end state (the
    // second run clones a creative whose links already match), so a retry is
    // safe. It does leave an extra unused creative behind, which costs nothing.
    idempotent: true,
    costImpact: 'spend',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: false,
    input: {
      brand: brandSchema.describe('Brand name'),
      adId: z.string().describe('The ad whose destination URL to change'),
      adLink: z.string().describe('New destination URL. Must be absolute http(s) — a bare path or domain is refused.'),
    },
    handler: async (args) => {
      const link = String(args.adLink || '').trim();
      if (!/^https?:\/\//i.test(link)) {
        return validationEnvelope(`adLink must be an absolute http(s) URL — got ${JSON.stringify(args.adLink || '')}.`);
      }
      return toEnvelope(await runBinary(ctx, 'meta-edit-link', args), {
        nextSuggested: ['meta_review_performance'],
      });
    },
  }, tool, z, ctx));

  // ── meta_create_custom_audience ───────────────────────────────────
  //
  // Mint one arbitrary pixel WEBSITE custom audience. meta_prepare_retargeting
  // creates the fixed Site-Visitors / Cart / ViewContent trio; this covers the
  // case that trio can't express — most commonly a "Purchasers 30d" audience
  // built purely to EXCLUDE recent buyers from cold prospecting.
  //
  // idempotent: FALSE, honestly. The engine does a bare create, so a retry
  // mints a SECOND audience with the same name. Declaring it idempotent would
  // be a lie the framework's idempotency cache then trusts (see the
  // REGRESSION GUARD in mcp-define-tool.js). Routed to the 'setup' tier so the
  // user confirms before ad-account state is added.
  tools.push(defineTool({
    name: 'meta_create_custom_audience',
    description: 'Create one pixel-based WEBSITE custom audience on the Meta ad account from an event plus a retention window — e.g. a "Purchasers 30d" audience to EXCLUDE recent buyers from cold prospecting. Requires a pixel to be connected. NOT idempotent: calling twice creates two audiences with the same name, so check the existing list (meta_audit action:"list-audiences") first.',
    destructive: true,
    idempotent: false,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: false,
    input: {
      brand: brandSchema.describe('Brand name'),
      audienceName: z.string().describe('Audience name as it will appear in Ads Manager (e.g. "Purchasers 30d")'),
      audienceEvent: z.string().optional().describe('Pixel event the audience is built from (e.g. Purchase, AddToCart, ViewContent). Default: Purchase.'),
      audienceRetentionDays: z.number().optional().describe('Retention window in days, 1-180. Meta caps pixel/website custom audiences at 180 days, so a longer window (e.g. "Purchasers 365") is refused rather than sent. Default: 30.'),
    },
    handler: async (args) => {
      const name = String(args.audienceName || '').trim();
      if (!name) return validationEnvelope('audienceName required — the name the audience gets in Ads Manager.');
      // Default here rather than relying on the engine: the engine treats 0 as
      // out-of-range and fatals, and "I didn't specify a window" should mean a
      // sane 30 days, not an error.
      const days = args.audienceRetentionDays === undefined || args.audienceRetentionDays === null
        ? 30
        : Number(args.audienceRetentionDays);
      if (!Number.isFinite(days) || days < 1 || days > 180) {
        return validationEnvelope(`audienceRetentionDays must be 1-180 (Meta's cap for pixel/website custom audiences); got ${JSON.stringify(args.audienceRetentionDays)}.`);
      }
      return toEnvelope(await runBinary(ctx, 'meta-create-audience', Object.assign({}, args, { audienceRetentionDays: days })), {
        nextSuggested: ['meta_audit'],
      });
    },
  }, tool, z, ctx));

  // ── meta_upload_customer_list ─────────────────────────────────────
  //
  // The OWNED-DATA counterpart to the pixel and engagement audience tools:
  // build an audience from a CSV of known customers. This is the highest-value
  // lookalike seed a brand has, because it is real purchase behaviour rather
  // than an inferred signal, and until now the only way to get one in was to
  // hand-upload in Ads Manager.
  //
  // PII: values are SHA-256 hashed in the engine immediately before transmission
  // and never logged, printed, or persisted. The tool takes a file PATH, never
  // customer data inline, so records never pass through the model context.
  //
  // idempotent: FALSE, like its sibling audience tools. A retry without
  // sourceAudienceId mints a second audience with the same name.
  tools.push(defineTool({
    name: 'meta_upload_customer_list',
    description: 'Upload a CSV of known customers as a Meta customer-list custom audience, which can then seed a lookalike via meta_build_lookalike. Accepts a canonical CSV (email, phone, fn, ln, ct, st, zip, country) or a raw Shopify customer export, and normalises both. Rows with neither email nor phone are dropped because they match poorly and dilute the seed. Values are SHA-256 hashed before transmission and never logged. Pass sourceAudienceId to append to an existing audience instead of creating a new one. NOT idempotent: calling twice without sourceAudienceId creates two audiences.',
    destructive: true,
    idempotent: false,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: false,
    input: {
      brand: brandSchema.describe('Brand name'),
      inputPath: z.string().describe('Absolute path to the customer CSV on disk. The file is read by the engine; customer records are never passed inline.'),
      audienceName: z.string().describe('Audience name as it will appear in Ads Manager (e.g. "Customers over $100")'),
      audienceDescription: z.string().optional().describe('Optional description recording what the list is and where it came from. Useful when several seeds coexist.'),
      sourceAudienceId: z.string().optional().describe('Append to this existing customer-list audience instead of creating a new one.'),
    },
    handler: async (args) => {
      const path = String(args.inputPath || '').trim();
      if (!path) return validationEnvelope('inputPath required — the customer CSV to upload.');
      const name = String(args.audienceName || '').trim();
      if (!name && !String(args.sourceAudienceId || '').trim()) {
        return validationEnvelope('audienceName required when creating a new audience.');
      }
      return toEnvelope(await runBinary(ctx, 'meta-upload-customer-list', args), {
        nextSuggested: ['meta_build_lookalike', 'meta_audit'],
      });
    },
  }, tool, z, ctx));

  // ── meta_create_engagement_audience ───────────────────────────────
  //
  // The SOCIAL counterpart to meta_create_custom_audience. That one builds
  // from the pixel (people who touched the website); this builds from the
  // Facebook Page or Instagram business profile (people who touched the
  // brand's social presence).
  //
  // Two reasons this is its own tool rather than a flag:
  //   - Engagement audiences BACKFILL from activity that already happened, so
  //     one call can produce a usable pool instantly with no spend and no wait.
  //   - They allow 365 days of retention; pixel audiences are capped at 180.
  //
  // Reach for this when a brand's warm audience is too small to retarget and
  // the cause is thin web traffic rather than broken tracking — a small or
  // local brand with an organic social following is the canonical case.
  //
  // idempotent: FALSE, same as its pixel sibling — the engine does a bare
  // create, so a retry mints a second audience with the same name.
  tools.push(defineTool({
    name: 'meta_create_engagement_audience',
    description: 'Create a Facebook Page or Instagram engagement custom audience — people who visited the profile, engaged with a post or ad, saved, messaged, or clicked the CTA. Unlike pixel audiences these BACKFILL from activity that already happened (so a new audience is populated immediately, with no spend) and allow up to 365 days of retention versus the pixel cap of 180. Use when a brand has too little web traffic to build a usable retargeting pool but does have an organic social following. NOT idempotent: calling twice creates two audiences with the same name, so check meta_audit action:"list-audiences" first.',
    destructive: true,
    idempotent: false,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    preview: false,
    input: {
      brand: brandSchema.describe('Brand name'),
      audienceName: z.string().describe('Audience name as it will appear in Ads Manager (e.g. "IG Engagers 365d")'),
      audienceSource: z.enum(['ig', 'page']).describe('Which social surface to build from: "ig" (Instagram business profile, needs metaInstagramUserId) or "page" (Facebook Page, needs metaPageId).'),
      audienceEvent: z.string().optional().describe('Which interaction to include. Both sources: all (widest, default), visit, engaged, messaged, cta. Instagram also: saved. Page also: liked, saved.'),
      audienceRetentionDays: z.number().optional().describe('Retention window in days, 1-365. Default: 365, because the widest window is almost always the point of building one of these.'),
    },
    handler: async (args) => {
      const name = String(args.audienceName || '').trim();
      if (!name) return validationEnvelope('audienceName required — the name the audience gets in Ads Manager.');
      // Default to the full year rather than the engine's per-call value: a
      // caller who omits the window wants the biggest pool this action can
      // make, which is the whole reason to prefer it over the pixel tool.
      const days = args.audienceRetentionDays === undefined || args.audienceRetentionDays === null
        ? 365
        : Number(args.audienceRetentionDays);
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        return validationEnvelope(`audienceRetentionDays must be 1-365 (Meta's cap for engagement audiences); got ${JSON.stringify(args.audienceRetentionDays)}.`);
      }
      return toEnvelope(await runBinary(ctx, 'meta-create-engagement-audience', Object.assign({}, args, { audienceRetentionDays: days })), {
        nextSuggested: ['meta_audit'],
      });
    },
  }, tool, z, ctx));

  // ── meta_research_competitor_ads ──────────────────────────────────
  //
  // Wraps the Meta Ad Library — read-only, no spend.
  //
  // REGRESSION GUARD (2026-07-26, dead-engine-route incident): this tool
  // shipped routing to 'meta-adlib', an action that has NEVER existed in
  // autocmo-core/main.go's dispatcher — every call returned "unknown action".
  // The live action is 'competitor-scan' (meta_adlib.go:runCompetitorScan).
  // It was flagged as a known gap in app/mcp-action-go-parity.test.js on
  // 2026-05-10 (`exemptions: ['adlib']`) and then sat broken.
  //
  // The engine reads competitor names from cmd.BlogBody as a COMMA-SEPARATED
  // string and ads-per-brand from cmd.ImageCount — historical tag reuse, not a
  // typo. Those spellings are the wire, so the friendly params are translated
  // here (same pattern as the seo tool's keywords → blogBody mapping, added
  // after the 2026-07-21 APOTHEKE incident). Declaring `competitor` and
  // forwarding it verbatim is exactly the failure that made this unreachable:
  // the engine never reads a field by that name.
  tools.push(defineTool({
    name: 'meta_research_competitor_ads',
    description: 'Search the Meta Ad Library for competitors\' currently-running ads. Read-only, no spend. Returns creative + copy samples grouped by Page. Pass one or more competitor brand names.',
    destructive: false,
    idempotent: true,
    costImpact: 'api',
    brandRequired: true,
    concurrency: { platform: 'meta' },
    input: {
      brand: brandSchema.describe('Brand name (context only — the query targets competitors)'),
      competitors: z.array(z.string()).optional().describe('Competitor brand / Page names, e.g. ["Madhappy","Pangaia"]. Either this or searchTerms is required.'),
      searchTerms: z.string().optional().describe('Freeform Ad Library search, comma-separated for several (e.g. "protein powder, creatine"). Used when competitors is omitted.'),
      limit: z.number().optional().describe('Max ads per competitor (default: 5).'),
    },
    handler: async (args) => {
      const names = Array.isArray(args.competitors)
        ? args.competitors.map((s) => String(s || '').trim()).filter(Boolean)
        : String(args.searchTerms || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (names.length === 0) {
        return validationEnvelope('Provide competitors (array of brand names) or searchTerms — the Ad Library query needs at least one name.');
      }
      // Translate to the engine's wire spelling. Only the mapped keys are
      // forwarded: passing `competitors`/`searchTerms` through would be
      // dropped by the binary and `limit` is not what it reads either.
      const binArgs = {
        brand: args.brand,
        blogBody: names.join(','),
      };
      if (typeof args.limit === 'number' && args.limit > 0) binArgs.imageCount = args.limit;
      return toEnvelope(await runBinary(ctx, 'competitor-scan', binArgs));
    },
  }, tool, z, ctx));

  return tools;
}

module.exports = { buildMetaIntentTools };
