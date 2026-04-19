---
name: merlin-ecom
description: Use when the user asks about Shopify products, orders, inventory, store analytics, Stripe revenue, MRR, ARR, churn, active subscribers, subscription cohorts, revenue source preference, Google Merchant Center, Google Shopping feed, product disapprovals, or any e-commerce backend question. Handles Shopify product import, order batching, Stripe OAuth (read-only, never write), revenue aggregation with USD normalization, Shopify-vs-Stripe topline disambiguation, and Google Merchant Center product feed sync + disapproval diagnostics for Google Shopping ads.
owner: ryan
---

# E-commerce Backend — Shopify + Stripe

## Shopify (`mcp__merlin__shopify`)

| Action | Key params | Purpose |
|---|---|---|
| `products` | `brand` | List products + inventory counts |
| `orders` | `brand`, `batchCount` (days) | Recent order data for revenue |
| `import` | `brand` | Pull all products + images into `assets/brands/<brand>/` |
| `cohorts` | `brand`, `batchCount` (days) | First-purchase cohorts → LTV, repeat rate |
| `analytics` | `brand`, `batchCount` (days) | 30-day window with AOV, ATC→purchase rate |
| `optimize-inventory` | `brand` | Cross-references Shopify inventory with live ads; pauses ads for OOS products, restores on restock |

**Inventory-aware ad pausing** — `optimize-inventory` walks `ads-live.json`, matches each live ad's `product` field to Shopify by slug, and pauses on 0 inventory. Paused ads are recorded in `.merlin-paused-for-stock.json` so the next run can auto-restore them when the product is restocked. Call this from the `merlin-optimize` scheduled task once per day. Safe to re-run; idempotent. Today only Meta is wired; TikTok/Reddit/LinkedIn stubs live in `inventory_sync.go:pausePlatformAd` — adding a case there wires the next platform.

**Shopify write boundary.** Never modify product titles, descriptions, prices, variants, sizes, inventory, pages, theme, or navigation. Merlin **adds** (blog posts, images) — never edits user content.

## Stripe (`mcp__merlin__stripe`)

OAuth-only, **read-only scope pinned to `read_only`**. Merlin cannot charge, refund, cancel, or modify anything. Enforcement is layered: (1) no write verbs in `stripe.go`, (2) Worker BFF re-verifies scope, (3) Stripe returns 403 on any write with a read-only token.

| Action | Key params | Purpose |
|---|---|---|
| `stripe-login` | `brand` | Opens browser OAuth — no API keys to paste |
| `stripe-setup` | `brand` | Verifies token, caches account ID |
| `stripe-preference` | `brand`, `provider` (`shopify` \| `stripe` \| `both`) | Disambiguates topline when both connected |
| `stripe-revenue` | `brand`, `batchCount` (days) | Gross, refunds, net, AOV, new customers (USD-normalized) |
| `stripe-subscriptions` | `brand` | MRR, ARR, active subs, 30-day churn, top plans |
| `stripe-cohorts` | `brand`, `batchCount` (days) | First-charge-month cohorts with lifetime revenue |
| `stripe-analytics` | `brand`, `batchCount` (days) | Consolidated revenue + subs + cohorts JSON |

**FX:** amounts USD-normalized via Stripe's `/v1/exchange_rates/usd`, cached 1 hour. Historical drift ±1%.

## DTC unit-economics benchmarks

Merlin-ecom surfaces the raw numbers; `merlin-analytics` layers MER and contribution margin on top. The benchmarks below flag health, not composite scores.

| Metric | Formula | Healthy | Unhealthy |
|---|---|---|---|
| **90-day repeat-purchase rate** | repeat customers (90d) / total customers (90d) | ≥25% DTC / ≥40% world-class | <15% — acquisition treadmill |
| **AOV** (average order value) | revenue / orders | trend direction > absolute | declining 3+ consecutive months |
| **ATC → purchase rate** | purchases / adds-to-cart | ≥30% healthy, ≥45% world-class | <20% = checkout friction |
| **Refund rate** | refunded orders / total orders | <5% DTC physical / <2% digital | >8% = product-expectation mismatch |
| **Bounce rate on PDP** | single-page sessions / total PDP sessions | <40% | >60% = ad/PDP mismatch |

## Subscription-economics benchmarks

When `stripe-subscriptions` or a subscription connector is active, surface these benchmarks:

| Metric | Formula | Healthy (B2C) | Healthy (B2B SaaS) | Why |
|---|---|---|---|---|
| **MRR growth** | (new + expansion − churn − contraction) / start MRR | ≥5%/mo early | ≥8%/mo | Topline momentum |
| **Net Revenue Retention (NRR)** | (start + expansion − churn − contraction) / start, 12mo cohort | ≥90% | ≥110% gold standard | The cleanest SaaS health metric |
| **Gross Revenue Retention (GRR)** | (start − churn − contraction) / start | ≥80% | ≥90% | NRR isolated from expansion |
| **Monthly churn** | churned subs / start-of-month subs | <5%/mo | <1%/mo | DTC subs tolerate higher churn; B2B does not |
| **Annual revenue churn** | 1 − (1 − monthly_churn)^12 | <45% B2C | <10% B2B | 5%/mo compounds to 46%/yr |
| **Quick Ratio** | (new + expansion) / (churned + contraction) | ≥2.0 | ≥4.0 | Efficiency of growth vs erosion |
| **CAC payback (subs)** | CAC / (ARPU × gross margin) | ≤12 months | ≤18 months | Cash recycle speed |
| **Expansion revenue share** | expansion MRR / total new MRR | ≥20% | ≥30% | Net-new vs upsell balance |

**Flagging rules:**
- NRR <90% → gross churn is eating growth. Diagnose retention before recommending more acquisition spend.
- Quick ratio <1.5 → subs leak faster than they fill. Stop the leak before pouring more in.
- Monthly churn >7% DTC / >2% B2B → product-retention issue, not a marketing issue. Recommend onboarding / engagement work before ad scale.

## Google Merchant Center (`mcp__merlin__google_ads` — merchant-* actions)

Piggy-backs on the existing Google OAuth connection. One `google-login` grants Google Ads + Search Console + Merchant Center; Merchant Center ID is auto-discovered and persisted as `googleMerchantId`. Agencies with multi-client (MCA) access can switch accounts with `merchant-setup`.

| Action | Key params | Purpose |
|---|---|---|
| `merchant-status` | `brand` | Connection check, approved/disapproved/pending counts, top 5 disapproval reasons |
| `merchant-setup` | `brand` | Lists accessible Merchant Center accounts; picks one when multiple are available |
| `merchant-sync-shopify` | `brand` | Maps active Shopify products → Merchant Center product inputs; upserts via `productInputs:insert`. Skips draft products and items missing title/price/image |
| `merchant-insights` | `brand`, `batchCount` (days, default 30) | Per-product performance (clicks, impressions, CTR) from the Merchant reports API |

**Rate limit:** separate `google_merchant` bucket (60/min, 1.5K/hr, 20K/day) so a catalog sync doesn't starve Google Ads calls on the same account. 500ms inter-call spacing enforced by `NextSlotNano`.

**Disapprovals are the #1 reason Shopping ads stop serving.** When a user asks "why aren't my Shopping ads running" or "why did my Google Ads spend drop," run `merchant-status` first — if `Disapproved` > 0, the item-level issues list names the fix (missing GTIN, image too small, prohibited content, etc.). Google Ads insights won't surface this.

**Shopify-sync caveats:**
- Only `status=active` Shopify products are synced. Drafts + archived are skipped.
- Products missing title, price, or primary image are skipped (Merchant Center rejects them).
- `compareAtPrice` is mapped to `salePrice` so discounts surface in Shopping.
- Availability is derived from `inventory_quantity` (>0 → `in_stock`, otherwise `out_of_stock`).
- Initial approval takes 3-24h. Run `merchant-status` later to see the review outcome.
- Upserts are keyed by `offerId = shopify-{productID}` — re-running the sync is safe and updates existing entries.

**What this does NOT do (yet):**
- Product feed management for non-Shopify stores (WooCommerce, custom carts). Those users can sync manually via the Merchant Center dashboard until we add a second source.
- Local inventory / store listings. Online channel only (`channel: ONLINE`).
- Promotions (sale badges, coupons). Use Google Ads promotions instead.
- Write operations against Google Ads assets generated from Merchant feed — `merlin-ads` owns Google Ads campaign management; this skill only manages the product feed those campaigns read from.

## Revenue source routing

When BOTH Shopify AND Stripe are connected AND Stripe is the Shopify payment processor, orders double-count without intervention. The `RevenueSource` abstraction (`dashboard.go`) gives every connector a uniform `{Name, Kind, Revenue, NewCustomers, MRR, ARR, ActiveSubs, ChurnPct}` shape; `pickRevenueSource` resolves the topline using `cfg.RevenueSourcePreference`.

| Preference | Topline behavior |
|---|---|
| `"shopify"` | Shopify revenue is topline, Stripe hidden from revenue row |
| `"stripe"` | Stripe revenue is topline, Shopify hidden from revenue row |
| `"both"` | Sum both — use only when they represent truly separate streams (e.g. physical DTC on Shopify + SaaS subscription on Stripe Billing) |
| `""` (default) | Prefer Shopify when both connected — safer, avoids double-count |

**Subscription metrics (MRR/ARR/churn) ALWAYS come from Stripe**, regardless of the topline pick. Shopify doesn't model subscriptions; Stripe does.

## Routing hints

- "how much revenue" / "what did I make" / "sales" → `dashboard` (which internally calls both and applies preference). Do NOT call `stripe-revenue` directly for topline questions.
- "MRR" / "ARR" / "churn" / "active subscribers" → `stripe-subscriptions` directly.
- "cohort" / "retention by month" / "LTV" → `stripe-cohorts` (subscription) OR `shopify-cohorts` (DTC).
- "out of stock" / "inventory" / "how much left" → `shopify-products` (inventory field).
- "pause ads for out-of-stock products" / "are we running ads for sold-out stuff" → `optimize-inventory`.

## Setup gotcha

First `stripe-setup` after connecting BOTH Shopify + Stripe prints a disambiguation prompt. Ask the user one question, then run `stripe-preference` with their answer before moving on. Default (no preference) prefers Shopify.

## What this skill does NOT cover

- **Ad platform revenue attribution** → `merlin-ads` + `merlin-analytics` (ROAS, ATC, purchases from pixel data).
- **Email revenue attribution** → `merlin-social` (Klaviyo first-touch / linear / time-decay models).
- **Blog / SEO revenue** → `merlin-seo` (organic sessions, rankings).
- **Revenue charts in the dashboard** → `merlin-analytics` reads `RevenueSource` outputs; this skill produces them.

<!-- VENDOR-CARDS:BEGIN -->
<!-- Generated from tools/vendor-cards/vendor-capabilities.json — do not edit by hand. Run `node tools/vendor-cards/gen-vendor-cards.js` to regenerate. -->

## Vendor Capability Cards

| Vendor | Primary pick-when | Entry action |
|---|---|---|
| **Klaviyo** | post-purchase flow, abandoned-cart flow, browse-abandon — flows beat campaigns on revenue-per-recipient by 3–5× (set-and-forget vs blast) | `klaviyo-login` |
| **Shopify** | revenue topline — shopify-analytics is the canonical source when Shopify is connected (preferred over Stripe for DTC with orders) | `shopify-login` |

### Klaviyo — email + SMS (flows, campaigns, segments, predictive analytics)

**Actions:** `klaviyo-login`, `klaviyo-performance`, `klaviyo-lists`, `klaviyo-campaigns`, `email-audit`

**Pick when:**
- post-purchase flow, abandoned-cart flow, browse-abandon — flows beat campaigns on revenue-per-recipient by 3–5× (set-and-forget vs blast)
- campaign performance audit — klaviyo-performance surfaces top-revenue campaigns + unsubscribe-rate outliers
- list hygiene / segment health — klaviyo-lists shows active vs suppressed counts; suppressed >20% triggers deliverability review
- email audit — email-audit grades a template against mobile-fit, image-weight, CTA prominence, dark-mode rendering

**Skip when:**
- transactional email (order confirmations, shipping) — route through Shopify's native notifications, not Klaviyo campaigns
- cold outbound to purchased lists — Klaviyo bans this and will deplatform; use Instantly/Apollo on a separate domain if cold outbound is required

**Killer features:**
- **Flows > Campaigns** — automated flows (welcome / abandoned cart / post-purchase / win-back) produce 60–80% of Klaviyo revenue at <5% of the send volume — always audit flow coverage before writing new campaigns
- **Predictive analytics** — Klaviyo models predicted CLV and churn risk per profile — segment on 'high predicted CLV + low recent engagement' to recover at-risk VIPs
- **SMS channel** — same Klaviyo account, 2× the revenue-per-message of email on abandoned cart (TCPA consent required)
- **Shopify product block** — native Shopify integration auto-hydrates product images + compare-at prices in email — never AI-generate product shots, always use the block

**Constraints:** klaviyoApiKey required; 600px email width standard; inline styles only (Gmail strips <style>); test in dark mode before send
**Cost:** Klaviyo platform pricing (profile-count tier); API itself is free within rate limits (~700/min steady-state)
**Output:** results/klaviyo-performance_YYYYMMDD.json + results/email-audit_YYYYMMDD.html
**Docs:** <https://developers.klaviyo.com/en/reference/api_overview>
**Last verified:** 2026-04-19
### Shopify — catalog, orders, revenue, cohorts (the canonical ecom data source)

**Actions:** `shopify-login`, `shopify-products`, `shopify-orders`, `shopify-import`, `shopify-analytics`, `shopify-cohorts`

**Pick when:**
- revenue topline — shopify-analytics is the canonical source when Shopify is connected (preferred over Stripe for DTC with orders)
- inventory / SKU enrichment — shopify-products pulls the full catalog with images, variants, compare-at prices; feeds both Meta catalog and Google Merchant
- cohort analysis — shopify-cohorts splits first-purchase cohorts by month for LTV and repeat-rate math
- order-level attribution — shopify-orders includes UTM + referrer for cross-platform MER reconciliation
- one-time catalog import into Meta/Google Merchant — shopify-import drives both meta-catalog and merchant-sync-shopify

**Skip when:**
- subscription-only MRR/ARR business with no one-time orders — Stripe is the authoritative source; set revenueSourcePreference='stripe'
- bulk write operations at >1K products — use Shopify's native GraphQL bulkOperationRunMutation, don't fan out per-product (we already batch via ExecuteBatch)

**Killer features:**
- **GraphQL Admin API** — bulk queries + mutations are 10–100× cheaper than REST on large catalogs; the generator uses bulkOperationRunQuery for any fetch >250 items
- **shopify-cohorts** — native cohort retention math — first-order month × repeat-purchase rate, zero-dep; most brands pay $200+/mo for this in a separate tool
- **Unified catalog export** — one shopify-products call feeds Meta catalog, Google Merchant, Klaviyo product blocks — no duplicate scraping
- **Scope-aware reconnect** — if Shopify scope upgrades (e.g., write_content for blog-post) are required, the UI surfaces a reconnect prompt instead of raw 403

**Constraints:** shopifyStore + shopifyAccessToken required; scope additions trigger a ~6-week re-review — audit shopify.app.toml before requesting new scopes; admin API is read-only unless app manifest grants write_*
**Cost:** Shopify API is free up to reasonable thresholds; rate-limited per-shop (40 request bucket, leaky)
**Output:** results/shopify-analytics_YYYYMMDD.json / shopify-cohorts_YYYYMMDD.json
**Docs:** <https://shopify.dev/docs/api/admin-graphql>
**Last verified:** 2026-04-19

<!-- VENDOR-CARDS:END -->
