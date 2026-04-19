---
name: merlin-ads
description: Use when the user wants to push, publish, pause, kill, scale, duplicate, activate, lookalike, retarget, or set up paid ads on Meta, TikTok, Google Ads, Amazon, Reddit, LinkedIn, or Etsy. Also covers ad performance decisions (margin-derived target ROAS, Promotion Gate with Mann-Whitney U, kill thresholds, CBO vs ABO scale rules, frequency-based fatigue detection), budget caps, the daily Meta autonomous loop (merlin-daily → merlin-optimize → merlin-digest), ad intelligence rules (70/15/10 split, hook archetypes, format diversity, learning phase gate, attribution windows), and platform-specific playbooks (Meta ASC/CBO, TikTok Spark Ads, Google Ads brand/non-brand split + PMax hygiene).
owner: ryan
bytes_justification: 16KB — this skill is the strategic core of Merlin's paid media brain. It covers five ad platforms (Meta/TikTok/Google/Amazon/Reddit) plus margin-derived target ROAS, a statistical Promotion Gate, fatigue/frequency rules, CBO vs ABO scale logic, and platform-specific playbooks (Google brand-vs-non-brand, TikTok Spark Ads, etc.). Splitting by platform would duplicate the shared triage/Promotion Gate/margin sections and hide cross-platform reasoning (e.g. moving a Meta winner into TikTok Spark). Hard-capped at 20KB.
---

# Paid Advertising — All Platforms

## Universal rules (override Claude judgment on financial decisions)

- **Don't kill early.** Never pause/kill an ad in its first 72 hours unless CPM is 3× vertical average. Learning phase needs data.
- **Scale by structure, not a blanket 20% rule.**
  - **CBO / Advantage+** (algorithm-driven delivery): scale daily budget 20–50% when ROAS clears target by 25%+, or duplicate the ad set into a second CBO. Top DTC playbooks (Motion, Structured, Pilothouse) routinely double CBO budgets day-over-day on proven winners — the old "≤20%" rule applied to manual ABO and is outdated for CBO.
  - **ABO / manual bid control:** stay ≤20% daily, ≥72h between increases. This is where Meta re-enters learning on budget jumps.
  - **Revert rule (both):** ROAS drops >15% OR CPA rises >25% within 72h of a budget increase → revert to previous budget, don't average down.
- **Learning phase gate (Meta).** Before launching, check `(daily_budget / target_CPA) × 7 ≥ 50`. If not met: *"This campaign can't exit Meta's learning phase at this budget. Increase to $X/day or lower your target CPA."*
- **Budget split (new Meta setups).** 70% Advantage+ Shopping (ASC), 15% Retargeting, 10–15% Testing. **Don't A/B test creative inside ASC** — test in standard, move winners to ASC.
- **Format diversity over volume.** When a creative hits `TARGET_ROAS`, generate 5 new creatives in 5 different *formats* (UGC, product demo, lifestyle static, split-screen, meme) — not 5 variations of the same format.
- **Hook archetypes.** Every creative uses one: curiosity-gap, pattern-interrupt, problem-agitation, POV, social-proof-frontload, skit, before-after, direct-address, voiceover-demo, testimonial-open. Tag in `metadata.json`. QA rejects hooks <6/10 on attention pull.
- **Don't over-segment.** Brands under $1M/mo: one campaign with broad targeting and 10–15 creatives beats ten campaigns at $50/day each. The creative IS the targeting.
- **Don't test in ASC.** ASC optimizes delivery, not creative comparison. Always test in standard campaigns.
- **Budget caps.** `maxDailyAdBudget` is enforced per-push by `validateDailyBudget`. `maxMonthlyAdSpend` is enforced at scale-time (`meta-budget`, `meta-duplicate` with a positive `dailyBudget`) by `enforceMonthlyCap` — it rejects when `dailyBudget × daysInMonth > cap` unless the caller passes `force=true`. Prorated by actual days in the current month (Feb = 28, Mar = 31).
- **Landing-page grade gate.** `meta-budget` and `meta-duplicate` run `enforceLandingGrade` before changing spend. If `landing-audit` has cached a score below 80 (grade C or worse) for the destination URL, the call is refused. Unaudited URLs pass silently — the gate only blocks KNOWN-bad pages. Override with `force=true`. Run `landing-audit` first to unblock properly — see `merlin-analytics` for the rubric.
- **`force=true` override.** Every safety gate (monthly cap, landing grade) accepts `force: true` on the command to bypass. The override is logged as a `warn` activity entry so the decision is auditable. Prefer fixing the underlying issue (lower budget, improve landing page) over forcing.
- **Attribution window must be stated.** Meta ROAS defaults to 7-day click + 1-day view. Always report the window alongside the number. For cross-platform truth, use MER (see `merlin-analytics`) — platform ROAS over-credits post-iOS 14.5.

## Target ROAS is margin-derived, not hardcoded

Break-even ROAS = `1 / gross_margin`. A "winner" must clear **break-even × 1.5** to fund OpEx, returns, and growth. Resolution order:

1. If `cfg.targetROAS` is set → use it verbatim.
2. Else if `cfg.productMargin` is set (0.0–1.0) → `TARGET_ROAS = 1 / (margin × 0.67)` (≈33% post-ad contribution).
3. Else → conservative default `TARGET_ROAS = 2.5` (assumes ~60% margin, typical DTC floor).

**Never call something a "winner" at ROAS 1.5** unless gross margin is ≥80% (most SaaS, some high-margin beauty). Triage rules below reference `TARGET_ROAS` — never a literal number. A brand operator hitting 1.5× ROAS on a 40%-margin product is losing money on every sale.

## Promotion Gate (stat-test before declaring winners)

Apply whenever Merlin would call something a "winner" or "loser" and act on it — moving ads from Testing → Scaling, killing creative, declaring an email subject winner, picking a landing page variant.

**Rule:** promote only if `p < 0.05` AND `lift ≥ 15%`. Both conditions. Either alone is noise.

**Test:** Mann-Whitney U (non-parametric, works with small samples, no normality assumption). Bootstrap confidence interval for the lift with 1,000 resamples. Mann-Whitney is the conservative frequentist floor — if the app later exposes Bayesian A/B (expected loss, HDI, per Optimizely / GrowthBook / Statsig), route through that instead; same lift threshold applies.

**Minimum samples per variant (hard floor for declaring a winner):**
- **High-volume** (Meta/Google main campaigns): **30 conversions per variant**. At n=10, lift detection is ~20% underpowered — acceptable only for directional read (`trending band` below), never for budget reallocation.
- **Low-volume** (email, retargeting, niche audiences): **50 conversions per variant**, or extend the test window to 14 days.

Below threshold → verdict is "keep running, insufficient data" — never "loser."

**Trending band:** `p < 0.10` with ≥15% lift AND n ≥ 10 = watch, don't kill. Early read without false positives; report with a "directional" caveat.

Merlin's internal verdicts (KILL / WINNER / MASSIVE WINNER) already bake in spend/CPA heuristics. The promotion gate is the statistical ceiling — if a verdict says WINNER but the gate hasn't cleared, report both: *"flagged as winner by spend thresholds, but not yet statistically significant (p=0.14) — keep running before scaling."*

**Challengers to a confirmed winner → `merlin-tournament`.** Critic → blind author → 3-judge Borda with k=2 stop. Don't ask for "10 variations" here — that drifts. Winner returns to `meta-push`.

## Meta Ads Autonomous Loop

When Meta is configured:

```
Daily 9 AM (merlin-daily): generate content
  → 3 variations (batch) → Visual QA all 3 → push into ONE ad set in "Auto CMO - Testing"
  → Meta optimizes across the 3 creatives automatically

Daily 10 AM (merlin-optimize): review yesterday
  → Pull CTR/CPC/ATC/Purchases per ad → app evaluates against thresholds
  → Verdicts: KILL / WINNER / MASSIVE WINNER → act on these (apply Promotion Gate before scale)

Monday 9 AM (merlin-digest): weekly summary
  → Total spend/ATC/purchases/ROAS, best/worst, posted to Slack
```

**Two campaigns auto-created:**
- **Auto CMO - Testing** (ABO) — each ad gets its own budget. Isolated testing.
- **Auto CMO - Scaling** (CBO) — winners moved here. Meta optimizes across all winners.

### "Push to Meta" after approval

1. Check `maxDailyAdBudget` and `maxMonthlyAdSpend` in config.
2. Check `memory.md ## Monthly Spend` — at/over cap → warn and ask to confirm.
3. Upload image, create ad set + creative + ad in Testing campaign with `dailyBudget` capped at `maxDailyAdBudget`.
4. Report ad ID, link, daily budget.

### "Check Meta performance"

1. Pull yesterday's insights → table: spend, impressions, clicks, CTR, CPC.
2. Flag losers (KILL) and winners (SCALE per Promotion Gate).
3. Ask: *"Kill the losers and scale the winners?"*

### Meta platform gotchas

Full technical reference lives in CLAUDE.md → `### Meta Ads API`. Summary:
- **Live mode required** for ad creative creation (subcode `1885183` = dev mode; no workaround).
- `is_adset_budget_sharing_enabled` required on all campaigns v22.0+; CBO needs `is_campaign_budget_optimization: true` + campaign-level `daily_budget`.
- **Meta OAuth unavailable** while app is in review — Connections tile asks user to paste a token from `developers.facebook.com/tools/explorer`. Do NOT use `platform_login` for Meta.

## Triage rules (merlin-optimize)

Apply in order per ad. Budgets derive from `cfg.dailyAdBudget` (default $20); ROAS thresholds derive from `TARGET_ROAS` (see margin-derived section above, default 2.5):
- `TESTING_BUDGET = DAILY_BUDGET × 0.60`
- `SCALING_BUDGET = DAILY_BUDGET × 0.30`
- `RETARGETING_BUDGET = DAILY_BUDGET × 0.10`
- `PER_AD_TEST_BUDGET = max($5, TESTING_BUDGET / active_test_count)`
- `BREAKEVEN_ROAS = 1 / gross_margin` (falls back to 1.67 at 60% margin if unset)

| Rule | Condition | Action |
|---|---|---|
| 1 — Dead on arrival | spent ≥ 2× PER_AD_TEST_BUDGET AND purchases == 0 AND CTR < 1.0% | KILL |
| 2 — Below break-even | spent ≥ PER_AD_TEST_BUDGET AND ROAS < BREAKEVEN_ROAS × 0.6 AND days_running ≥ 2 | KILL |
| 3 — Creative fatigue | days_running ≥ 5 AND (CTR declining 30%+ from peak OR frequency > 2.5 prospecting / > 4.0 retargeting) | KILL + queue replacement with DIFFERENT hook |
| 4 — Promising | days_running < 3 AND CTR ≥ 1.0% | HOLD |
| 5 — Winner | ROAS ≥ TARGET_ROAS AND days_running ≥ 2 AND spend ≥ PER_AD_TEST_BUDGET | SCALE (apply Promotion Gate before) |
| 6 — Massive winner | ROAS ≥ TARGET_ROAS × 2 AND spend ≥ DAILY_BUDGET AND purchases ≥ 5 | SCALE + LOOKALIKE (once per ad) |
| 7 — Retarget | Any WINNER exists AND retargeting has no active ads | Create retargeting ad with winner's creative |

**Frequency cap (rule 3):** Meta's own data shows CPA rises materially past frequency 2.5 on cold prospecting. Retargeting tolerates higher frequency (up to ~4) because intent is already present, but past that, fatigue dominates.

**Safety rules:**
- **Aggregate kill cap:** never kill more than 50% of active ads in a single run.
- **Duplicate prevention:** before creating test ad, check `ads-live.json` — skip if same product + same hook already running.
- **Write-back:** update `ads-live.json` after every kill/scale/publish. Authoritative source of truth.

## Action Reference

### Meta Ads (`mcp__merlin__meta_ads`)

| Action | Key params |
|---|---|
| `push` | `adImagePath`, `adHeadline`, `adBody`, `dailyBudget` |
| `insights` | (none — pulls all active) |
| `kill` | `adId` |
| `activate` | `adId` or `campaignId` (status flip, NOT content creation) |
| `duplicate` | `adId`, `campaignId` (target campaign for scaling) |
| `setup` | (creates Testing + Scaling campaigns) |
| `lookalike` | `adId` (winner) |
| `retarget` | `adId` (winner) |
| `setup-retargeting` | (creates retargeting audiences) |
| `catalog` | (lists Facebook product catalog) |

### TikTok Ads (`mcp__merlin__tiktok_ads`)

`push` (`adVideoPath`, `adHeadline`, `adBody`, `dailyBudget`) · `insights` · `kill` (`adId`) · `duplicate` (`adId`, `campaignId`) · `setup` · `lookalike` (`adId`)

**TikTok-specific playbook:**
- **Spark Ads** (boost organic posts with auth_code from the creator): these carry native engagement signal and typically beat cold creatives by 30–50% on CTR and CVR. Prefer Spark over standard dark posts whenever a creator partnership or organic post is available.
- **Creator content over studio content.** TikTok's algorithm penalizes "TV ad" aesthetic. Native creator-style UGC (handheld, selfie angle, on-screen captions) outperforms polished production by wide margins. Route production through `merlin-content` → Raw UGC register, never Hero Product.
- **Hook in 2 seconds.** TikTok hook window is tighter than Meta. First-frame retention and 3-second view rate are the primary early signals — watch these before CTR.
- **TTCM (TikTok Creator Marketplace)** is the official channel for finding creators for Spark Ads. Reference in onboarding when user asks about "finding creators for TikTok."
- **Smart+ (TikTok's Advantage+ equivalent):** the consolidated campaign type. Use for scaling winners; test creative in standard campaigns first (same logic as Meta ASC).

### Google Ads (`mcp__merlin__google_ads`)

| Action | Key params |
|---|---|
| `setup` | `brand` (creates "Merlin - Testing" $5/day + "Merlin - Scaling" $20/day Performance Max) |
| `push` | `adImagePath`, `adHeadline` (pipe-delimited), `adBody`, `adLink`, `dailyBudget` |
| `insights` | `brand` |
| `kill` | `campaignId` |
| `duplicate` | `campaignId` |

**Connect:** `platform_login({platform: "google", brand})` — OAuth, token + customer ID saved automatically.

**Google Ads playbook (critical — PMax alone is not a strategy):**
- **Always split brand vs non-brand.** PMax cannibalizes brand searches and inflates its own ROAS with traffic that would have converted organically. Run a separate **Brand Search campaign** with exact-match on `[brand name]` + common misspellings, and **exclude branded terms from PMax** via account-level negative keywords. This is the single biggest correction for most DTC Google accounts.
- **Negative keyword hygiene.** PMax and Search campaigns need negative lists: free/cheap/jobs/DIY/used/tutorial/download (unless brand sells these). Pull the search-terms report weekly and add non-intent queries to negatives. Ignoring this wastes 15–30% of spend on mid-funnel traffic.
- **Search alongside PMax for high-intent queries.** PMax bids on all surfaces automatically but its reporting is opaque. Run **standard Search campaigns** for top 10 BOFU keywords (see `merlin-seo` funnel tags) with manual CPC or Target CPA — this gives you a control group and a reporting surface PMax doesn't provide.
- **Shopping feed is the creative.** For PMax, product title / primary image / price / GTIN drive >70% of performance. A weak feed caps PMax regardless of budget. Audit the Shopify → Google Merchant feed before scaling: unique titles (brand + product + key attribute), clean backgrounds, GTINs populated, no policy disapprovals.
- **Conversion imports.** Ensure Shopify purchases import to Google Ads via GA4 or direct conversion action — without this, Smart Bidding is blind. Tag `Purchase` as primary conversion; de-prioritize `Add to Cart` and `Begin Checkout` (use as observational, not optimization goals).
- **Target CPA / Target ROAS:** start PMax on "Maximize Conversion Value" (no target) for the first 2 weeks of data collection, then set `Target ROAS = TARGET_ROAS × 0.9` once there are ≥30 conversions. Targets set too early starve learning.

### Amazon Ads (`mcp__merlin__amazon_ads`)

| Action | Key params |
|---|---|
| `setup` | `brand` |
| `push` | `campaignId`, `adGroupName`, `keywords` (array), `defaultBid` |
| `insights` | `brand` |
| `kill` | `campaignId` |
| `products` | `brand` (Seller catalog) |
| `orders` | `brand`, `batchCount` (days) |

**Connect:** `platform_login({platform: "amazon", brand})`.

### Reddit Ads (`mcp__merlin__reddit_ads`)

`campaigns` · `ads` · `insights` · `create` · `pause`

(Organic Reddit prospecting/drafting/posting is in `merlin-social`, not here.)

### Etsy (`mcp__merlin__etsy`)

Connector OAuth via `platform_login({platform: "etsy"})`. Same listing/insights pattern as above.

### LinkedIn (`mcp__merlin__linkedin`)

Connect + campaign ops. **Budget validation runs on the final scaled value** — if the code scales budget (e.g. 3× for LinkedIn scaling), `validateDailyBudget(cfg, scaledBudget, "linkedin")` must run on the scaled number. This is a regression guard — see `linkedin.go`.

### Competitor ad research (`mcp__merlin__competitor_spy`) — Foreplay global discovery

Foreplay indexes 100M+ Meta/TikTok/LinkedIn ads worldwide. **Covers the US and all other regions** — fills the gap where Meta Ads Library previews are EU-only. **Always use the global-discovery flow, never Spyder.** Spyder requires pre-subscribing to each brand in the Foreplay UI; it is deliberately unsupported here.

**Canonical discovery flow:**
1. User names a competitor (domain, brand, or page) → `competitor_spy({action: "brands-by-domain", url: "competitor.com"})` to resolve brand IDs.
2. Pick the right brand ID → `competitor_spy({action: "ads-by-brand", foreplayBrandIds: "id1,id2"})` to pull their ads. Filter with `foreplayFormat` (video/image/carousel), `foreplayLive: "true"` for currently-running only, `foreplayOrder: "longest_running"` for proven winners.
3. Paginate via `foreplayCursor` (opaque — pass the previous response's `metadata.cursor` back).
4. User wants the actual media → `competitor_spy({action: "download-ad", adId: "..."})` saves the video/image to `results/competitor-ads/<ad_id>.<ext>`.
5. Reverse-lookup reuse → `competitor_spy({action: "ad-duplicates", adId: "..."})` shows every brand running the same creative (useful for spotting agency-built templates).
6. `competitor_spy({action: "usage"})` shows remaining API credits (0.01 credits per ad returned).

**Shortcut:** if the user already has a Facebook page ID, skip step 1 and call `competitor_spy({action: "ads-by-page", foreplayPageId: "..."})` directly.

**Research → Create pipeline:** before generating creatives for a new vertical, pull the top 20 longest-running ads from 3–5 competitors, feed the headlines + hooks + landing URLs into the creative brief for `merlin-content`. This grounds new creative in what's actually working in the vertical right now, not what was working 6 months ago.

**Cost:** BYOK — user's `foreplayApiKey` in merlin-config.json. Show credit usage before running large pulls (`limit > 50`).

## Rate limits

**Every outbound call to a rate-limited platform routes through `PreflightCheck` + `RecordSuccess`/`RecordRateLimitHit`.** A direct HTTP call to `graph.facebook.com`, `business-api.tiktok.com`, `googleads.googleapis.com`, `api.klaviyo.com`, `ads-api.reddit.com`, `openapi.etsy.com`, or an Amazon Ads host is blocked by the user-side hook. Always route through `mcp__merlin__*` tools.

## Routing hints

- "push" / "publish" / "launch" + platform name → platform's `push` action
- "kill" / "pause" / "stop" → platform's `kill`
- "scale" / "duplicate winner" → platform's `duplicate` or `lookalike`
- "catalog" / "products on facebook" → `meta_ads({action: "catalog"})`
- "insights" / "performance" on a specific platform → platform's `insights` (prefer `dashboard` for aggregate — see `merlin-analytics`)
- "set up" + platform → platform's `setup` action after OAuth
- "spy on" / "what ads is X running" / "competitor ads" / "download their ad" / "swipe file" → `competitor_spy` with the global-discovery flow (brands-by-domain → ads-by-brand → download-ad). NEVER suggest subscribing to brands in Foreplay Spyder — the agent does not use Spyder.
- "check my ad credits" / "how much Foreplay quota left" → `competitor_spy({action: "usage"})`

## What this skill does NOT cover

- **Ad creative generation** (images, videos, scripts) → `merlin-content`
- **Cross-platform aggregate performance** → `merlin-analytics`
- **Organic Reddit** / email / Discord → `merlin-social`
- **Shopify / Stripe revenue** → `merlin-ecom`

<!-- VENDOR-CARDS:BEGIN -->
<!-- Generated from tools/vendor-cards/vendor-capabilities.json — do not edit by hand. Run `node tools/vendor-cards/gen-vendor-cards.js` to regenerate. -->

## Vendor Capability Cards

| Vendor | Primary pick-when | Entry action |
|---|---|---|
| **Google Ads + Merchant Center** | brand-search defense — bid your own brand terms before a competitor does; cheapest non-zero ROAS channel in the stack | `google-login` |
| **Meta (Facebook + Instagram Ads)** | broad-reach DTC acquisition — Advantage+ Shopping (ASC) is the default for brands <$1M/mo | `meta-login` |
| **TikTok Ads** | UGC-style video ad targeting 18–34 demo — TikTok outperforms Meta on creator-authentic creative | `tiktok-login` |

### Google Ads + Merchant Center — Search, Shopping, PMax, Demand Gen — and the Merchant feed that blocks Shopping from serving

**Actions:** `google-login`

**Pick when:**
- brand-search defense — bid your own brand terms before a competitor does; cheapest non-zero ROAS channel in the stack
- non-brand Search + PMax split — run as separate campaigns, NOT one PMax with brand included (Google over-credits brand to PMax)
- Shopping ads — always verify Merchant Center status first (merchant-status action); disapproved products silently stop serving
- Demand Gen (YouTube + Discover + Gmail) — the correct 2024 replacement for discontinued Universal App Campaigns and Display
- Performance Max for Shopping — pair with Shopify feed + merchant-sync-shopify for full SKU coverage

**Skip when:**
- one-PMax-for-everything — Google's algorithm starves Search for PMax; always split brand Search + non-brand Search + PMax
- Merchant Center unconfigured — Shopping returns zero impressions silently; run merchant-setup first
- small-budget accounts (<$30/day) — PMax needs ~$50/day to exit learning; use standard Search on low spend

**Killer features:**
- **Performance Max** — multi-surface (Search + Shopping + YouTube + Discover + Gmail + Display) auto-optimized campaign — the correct ceiling-breaker for DTC once brand Search is saturated
- **Merchant Center integration** — one google-login now grants Ads + Search Console + Merchant scope in a single consent; merchant-status surfaces disapproval reasons that the Ads UI hides
- **merchant-sync-shopify** — maps active Shopify products → Merchant inputs via unified productInputs:insert; skips drafts; idempotent on re-run
- **Demand Gen** — replaced Discovery Ads in 2024; the right surface for mid-funnel video + carousel creatives on YouTube Shorts / Discover
- **Search Console scope** — bundled into the same google-login — powers the SEO skill without a second consent flow

**Constraints:** googleAccessToken + googleAdsCustomerId required; googleMerchantId auto-discovered on login; google_merchant has its own rate-limit bucket (60/min, 1.5K/hr, 20K/day); 401 auto-refresh shared across Ads/SC/Merchant
**Cost:** platform spend only; Search CPCs highly vertical-dependent ($0.30–$50+); Shopping cheaper at ~$0.20–$2 blended
**Output:** results/google-ads_YYYYMMDD.json + merchant-status JSON
**Docs:** <https://developers.google.com/google-ads/api/docs/start>
**Last verified:** 2026-04-19
### Meta (Facebook + Instagram Ads) — paid social on Facebook and Instagram (ASC, CBO, retargeting, catalog, lookalikes)

**Actions:** `meta-login`, `meta-push`, `meta-bulk-push`, `meta-insights`, `meta-kill`, `meta-activate`, `meta-budget`, `meta-duplicate`, `meta-setup`, `meta-warmup`, `meta-discover`, `meta-catalog`, `meta-retarget`, `meta-lookalike`, `meta-lockdown`, `meta-import`, `meta-setup-retargeting`

**Pick when:**
- broad-reach DTC acquisition — Advantage+ Shopping (ASC) is the default for brands <$1M/mo
- warm-audience retargeting — meta-setup-retargeting wires pixel events + creates the retarget ad set
- catalog / DPA (Dynamic Product Ads) — meta-catalog verifies the Shopify feed; DPA always beats static creative on retargeting
- lookalike expansion off a high-LTV seed — meta-lookalike builds 1/3/5% audiences from purchaser lists
- bulk push of a winning creative across N ad sets — meta-bulk-push with ExecuteBatch avoids rate-limit fan-out

**Skip when:**
- A/B testing creative inside ASC — ASC optimizes delivery, not creative comparison; always test in standard campaigns, move winners to ASC
- learning-phase ineligible setups (daily_budget × 7 / target_CPA < 50) — surface the gate error instead of launching
- app must be in Development mode — creative creation returns subcode 1885183; only campaign/ad-set/image-upload work in dev

**Killer features:**
- **Advantage+ Shopping (ASC)** — Meta's AI-driven shopping campaign — the 70% default slot for DTC; don't A/B inside it, feed it winners
- **CBO (Campaign Budget Optimization)** — scale 20–50% daily on proven winners (not the old ≤20% rule); Meta re-enters learning on budget jumps >50%
- **Dynamic Product Ads** — product catalog + pixel events → personalized retargeting at the SKU level; +30–60% ROAS over static retargeting
- **Lookalike audiences** — 1% lookalike off 1K+ purchasers is the single highest-LTV cold audience most DTC brands have
- **Advantage+ Audience** — Meta's 2024 auto-targeting — outperforms manual interest targeting in 7/10 tests; default ON for new setups
- **Spark-compatible organic posts** — any organic IG/FB post can be promoted as an ad via post_id — UGC pulled from creator whitelists this way

**Constraints:** metaAccessToken + metaAdAccountId + metaPageId + metaPixelId required; app must be Live for creative creation; every push runs validateDailyBudget + enforceMonthlyCap + enforceLandingGrade; rate-limited (preflight mandatory)
**Cost:** platform spend only; no per-call fee; budget gates block pushes exceeding maxDailyAdBudget / maxMonthlyAdSpend unless force=true
**Output:** results/meta-push_YYYYMMDD.json with campaign/adset/ad IDs and the attribution window used
**Docs:** <https://developers.facebook.com/docs/marketing-apis/>
**Last verified:** 2026-04-19
### TikTok Ads — paid TikTok + TikTok Shop (Spark Ads, Smart+, VSA, lookalikes)

**Actions:** `tiktok-login`, `tiktok-push`, `tiktok-insights`, `tiktok-setup`, `tiktok-kill`, `tiktok-duplicate`, `tiktok-lookalike`

**Pick when:**
- UGC-style video ad targeting 18–34 demo — TikTok outperforms Meta on creator-authentic creative
- TikTok Shop product push — Video Shopping Ads attach SKUs directly to organic-feeling creator posts
- Spark Ads — promote a real creator's organic post as an ad (keeps creator comments + handle, 2–3× engagement vs branded post)
- Smart+ Campaigns — TikTok's equivalent of Meta ASC; the 2024-default for DTC without a creative testing process

**Skip when:**
- static image ads — TikTok allows them but performance lags video by 5–10× on CTR; regenerate as video first
- >45s creative — TikTok algorithm favors 9–21s; longer assets get throttled after the hook
- B2B / enterprise audience — LinkedIn is the correct surface for software sold above $500 ACV

**Killer features:**
- **Spark Ads** — turn an organic creator post into an ad with the creator's consent — preserves comments, handle, and organic aesthetic; the single highest-performing TikTok ad type
- **Smart+ Campaigns** — auto-targeting + auto-bidding + creative rotation; use for cold acquisition, don't over-segment manually
- **Video Shopping Ads (TikTok Shop)** — SKU attach with in-app checkout — the only way to get TikTok-native conversion attribution
- **Interactive Add-Ons** — stickers, voting, super-like — +20–40% engagement on UGC hooks at zero extra CPM
- **Creative Challenge** — TikTok-run creator brief pool; pay per approved asset (~$50–300/creative) vs sourcing UGC yourself

**Constraints:** tiktokAccessToken + tiktokAdvertiserId + tiktokPixelId required; pixel events must fire 7 days before Smart+ launch (learning period); rate-limited via preflight
**Cost:** platform spend only; Creative Challenge assets ~$50–300/approved creative
**Output:** results/tiktok-push_YYYYMMDD.json
**Docs:** <https://business-api.tiktok.com/portal/docs>
**Last verified:** 2026-04-19

<!-- VENDOR-CARDS:END -->
