---
name: merlin-analytics
description: Use when the user asks about performance, how their ads/store/business are doing, ROAS, MER, CAC, LTV, contribution margin, payback period, CPA, ROI, spend, aggregate revenue, dashboard, weekly numbers, wisdom insights, landing page audits, incrementality/holdout testing, or conversion optimization. Covers the cross-platform dashboard (MER + contribution margin + LTV:CAC as the real north stars, platform ROAS reported directionally with attribution window), incrementality framework (geo holdouts, channel-level lift expectations), the wisdom engine (anonymized collective insights), the marketing calendar (launch cadence + seasonal gaps), the 9-dimension landing page Conversion Rubric with current Core Web Vitals (LCP/INP/CLS), and the GA4 read + write surface (programmatic measurement-plan setup — key events, custom dimensions/metrics, audiences, property settings, idempotent shopify-events attach). Pulls exact numbers from `mcp__merlin__dashboard` — never estimates or derives metrics.
owner: ryan
bytes_justification: GA4 read+write (2026-05-01) added 13-action surface + write-side approval-card flows alongside the existing dashboard / wisdom / calendar / Conversion Rubric / incrementality blocks. Splitting GA4 into its own SKILL would fragment the analytics-vs-attribution narrative the dashboard relies on.
---

# Analytics & Performance

## North-star metrics (report these, not platform ROAS alone)

Post-iOS 14.5, platform-reported ROAS over-credits paid channels by 20–60% depending on vertical. Every senior DTC operator (Common Thread Collective, Chase Dimond, Taylor Holiday, Pilothouse) has published on this. Merlin reports the real metrics:

| Metric | Formula | Healthy | Why |
|---|---|---|---|
| **MER** (Marketing Efficiency Ratio) | total revenue / total ad spend | ≥3.0 scaling / ≥4.0 sustainable | Blended truth; doesn't care which platform claimed the conversion |
| **Contribution margin** | revenue − COGS − ad spend − fulfillment − processing fees | ≥20% of revenue | Only metric that says if the business actually makes money |
| **LTV:CAC** | 12-month customer value / fully-loaded CAC | 3:1 healthy, 4–5:1 world-class | Unit economics bar. <2:1 = buying a business that loses money |
| **CAC payback period** | CAC / (AOV × margin × repeat_rate) | ≤3 months DTC, ≤12 months subscription | How fast cash recycles; drives growth ceiling |
| **nCAC** (new-customer CAC) | ad spend / new customers | benchmark vs blended CAC | Separates acquisition from returning-customer efficiency |
| **Platform ROAS** | revenue / ad spend per platform | Directional only | Report **with attribution window** (e.g. "Meta 2.4× 7dc/1dv"). Never as truth on its own. |

**Reporting rule:** every dashboard response leads with **MER** and **contribution margin**. Platform ROAS appears below, always with its attribution window stated. If a user asks "how are the ads doing" and the answer is only platform ROAS, the answer is incomplete.

**Margin inputs:** pull `cfg.productMargin`, `cfg.cogsPercent`, `cfg.fulfillmentPerOrder`, `cfg.paymentProcessorPct` (default 2.9% + $0.30). If any are unset, flag as "estimated" in output and prompt the user to set them (see `merlin-setup`).

## Dashboard (`mcp__merlin__dashboard`)

| Action | Key params | Returns |
|---|---|---|
| `dashboard` | `brand`, `batchCount` (days) | MER + revenue + total spend + per-platform ROAS table + WoW deltas + recent decisions + reallocation suggestions. **For LTV:CAC + payback, chain `stripe-cohorts` separately** (not in `dashboard` today). |
| `stripe-cohorts` | `brand`, `months` | Per-cohort customer count + revenue + average revenue per customer. **Older cohorts naturally show higher AvgRevenue solely because they had more time to bill** — interpret AvgRevenue/months_elapsed (rev-per-customer-per-month) for fair cross-cohort comparison. |
| `wisdom` | `brand` | Collective anonymized insights (hook CTR, format win-rate, timing patterns by vertical) |
| `calendar` | `brand` | Launch history, average cadence, seasonal signals, upcoming gaps |

**Topline revenue routing** — `dashboard` internally resolves `RevenueSource` across every connector (see `merlin-ecom` for the preference rules). Never compute revenue by summing Shopify + Stripe yourself — the abstraction handles double-count protection.

**Goal pacing** — if `assets/brands/<brand>/goal.md` exists, `dashboard` attaches a `goal` block with `status` (ahead / on-track / behind / at-risk), `targetRevenue`, `actualRevenue`, `requiredPerDay`, and a one-line `message` comparing expected vs. actual against the monthly/weekly/quarterly window. Surface this prominently in digests ("Pacing: behind — $20k of $50k target at 50% of month elapsed, need $1,667/day to finish"). When no goal is set, the block is omitted. Goals are captured at onboarding (see `merlin-setup`) or via `{"action": "goal-set", ...}`.

## Performance table rules

Render only fields that exist in the JSON output. For `meta-insights`, the `campaign_summary` block has **exactly**:

`campaign_name`, `category`, `spend`, `revenue`, `roas`, `purchases`, `impressions`, `clicks`, `ctr`, `cost_per_purchase`, `ad_count`

Never invent columns like Status, Reach, Results, or Budget. Use pre-computed summaries verbatim — don't re-sum the `ads` array. One label per metric (`Cost/Purchase` OR `CPP`, not both). **Max 6 columns.** Campaign names are authoritative — never flatten "Merlin - Testing" to "merlin."

## Data integrity rules

- **Every number comes from an action.** Never estimate, calculate, or fabricate metrics.
- **Quote exact values from action output.** No rounding, no paraphrasing.
- **No mental math on money.** Use `dashboard` for aggregates. Never sum spend, derive ROAS trends, or calculate budget remaining yourself.
- **If a number isn't in an action's output, say "let me check" and run the action.**

## Wisdom

`mcp__merlin__dashboard({action: "wisdom"})` reads `.merlin-wisdom.json` — anonymized collective data aggregated server-side from all Merlin users.

**Cite wisdom when recommending.** When suggesting a hook style, format, or timing, quote the stat with sample size: *"UGC averages 2.8% CTR (wisdom, N=45)"*. Never invent collective stats.

**Prefer wisdom-validated choices** for the user's vertical:
- Hook styles with higher avg CTR.
- Formats with better win rate.
- Timing patterns that work across similar brands.

## Calendar

`mcp__merlin__dashboard({action: "calendar"})` returns launch predictions and seasonal gaps. Use for:
- **Content planning** — if a product launch or seasonal event is within 7 days, prioritize that product for creative generation (override normal rotation).
- **Quiet stretches** — no launches for 14+ days → generate evergreen content for best-performing product.

## Briefing

Every optimization run writes `assets/brands/<brand>/briefing.json` AND root `.merlin-briefing.json`:

```json
{
  "date": "YYYY-MM-DD",
  "ads": {"killed": N, "scaled": N, "created": N, "active": N},
  "content": {"blogs": N, "images": N},
  "revenue": {"total": "$X", "trend": "+Y%"},
  "bestHookStyle": "ugc",
  "bestFormat": "9:16",
  "avgROAS": X.X,
  "recommendation": "One-sentence strategic suggestion based on today's data"
}
```

Derive `bestHookStyle` / `bestFormat` from memory.md `## What Works` (most frequent recent winner). Derive `avgROAS` from today's dashboard output.

## Conversion Rubric (Landing Pages)

When running `landing-audit` or auditing any conversion page, score 9 dimensions 0–100, weighted:

| Dimension | Weight | Check |
|---|---|---|
| Value proposition clarity | 15% | What, for whom, why different — 1 sentence above the fold, not buried in a paragraph |
| Headline × visual match | 10% | Headline and hero image/video tell the same story in <5s |
| CTA clarity | 20% | One primary CTA above the fold, high contrast, action verb, consistent across page. Secondary CTA never competes visually |
| Social proof | 12% | Real names / logos / numbers / verified reviews — not "trusted by thousands" |
| Trust signals | 8% | Guarantees, refund policy, security badges, real contact info, shipping/returns clarity |
| Urgency / scarcity | 5% | Specific and true ("28 left," "ends Friday 11:59 ET") — never fabricated |
| Form / checkout friction | 10% | Field count ≤ what's strictly required; guest checkout available; Shop Pay / Apple Pay / PayPal offered |
| Mobile experience | 15% | Tap targets ≥44px, no horizontal scroll, readable without zoom, hero visible without scroll. 60–70% of DTC traffic is mobile — under-weighting this tanks the audit |
| Page speed (Core Web Vitals) | 5% | **LCP <2.5s, INP <200ms, CLS <0.1** (INP replaced FID in March 2024). Hero image <200KB, lazy-load below fold |

**Overall grade:** A (90+) / B (80–89) / C (70–79) / D (60–69) / F (<60). Grade below B → fix before adding traffic. **Never recommend scaling ad spend into a C/D/F page.** A 3× ROAS creative driving to a C page loses half its ROAS at the page — fix the page first, then scale ads.

**Automatic enforcement.** The grade is cached to `.merlin-landing-audits.json` by `landing-audit`. `meta-budget` and `meta-duplicate` (scale-up paths) call `enforceLandingGrade` before changing spend — scores below 80 are refused unless the caller passes `force=true`. Unaudited URLs pass silently, so this is not a surprise block on new pages. The bands above are the exact cutoffs the binary enforces — don't paraphrase them elsewhere.

## Incrementality (the check senior operators run and juniors skip)

Platform-attributed ROAS over-reports because ad platforms count conversions that would have happened anyway (brand search, direct, existing email list). The only way to know paid media's true lift is to test it.

**Geo holdout (simplest, cheapest):** pause all paid spend in 1–2 comparable DMAs for 2–4 weeks. Compare revenue trajectory vs control DMAs (population-normalized). The delta is **true incremental revenue**. Incremental MER = incremental revenue / ad spend in test DMAs.

**Expected incrementality by channel** (observed across published DTC case studies — use as sanity check, not truth):
- **Brand Search / retargeting:** often <20% incremental (most would have converted anyway)
- **Prospecting on Meta/TikTok:** 50–80% incremental when campaigns are healthy
- **PMax:** highly variable — run geo holdout to be sure (PMax cannibalizes brand unless excluded; see `merlin-ads`)
- **Affiliate / influencer with discount codes:** check code reuse rates — often gamed by existing customers

**When Merlin should flag incrementality concerns:**
- Blended MER ≥4× but LTV:CAC <2:1 → platform ROAS is lying somewhere; recommend a 2-week geo holdout.
- A campaign's platform ROAS is 2× higher than the blended MER → that campaign is likely over-claiming; candidate for scale-down, not scale-up.
- Retargeting ROAS >10× → almost certainly non-incremental. Test by pausing retargeting for 2 weeks and watching total revenue.

**Tooling context:** brands above ~$2M/yr should graduate to a dedicated incrementality / MMM platform (Haus, Northbeam, Prescient AI, Measured, Rockerbox). Merlin surfaces the need; the user picks the tool.

## Creative velocity check

On `dashboard` runs, check weekly creative count vs. target: **1–3 new creatives per $10K/week spend**. Surface shortfall in the briefing. Velocity is the single biggest predictor of sustained ad account health (Motion's published data).

## Owned-channel target

On `dashboard`, check email + SMS contribution to revenue.

- **Under 25%** → owned channels are under-invested. Recommend flows in order: welcome → browse abandon → cart abandon → post-purchase → win-back (full rubric in `merlin-social`). Klaviyo's own published benchmark for mature DTC is 25–30% of revenue from email + SMS combined.
- **SMS specifically should contribute 10–20%** for DTC brands with SMS live (Postscript / Attentive / Klaviyo SMS data). Zero SMS = significant gap; recommend enabling.
- **Over 40%** → owned is doing too much work because paid is underperforming. Look at paid acquisition health, not as a compliment to email.

## Google Analytics 4 (`mcp__merlin__google_analytics`) — read-only inspection

GA4 is the source of truth for site behavior, organic traffic acquisition, and multi-touch attribution. Shopify is the source of truth for revenue; GA4 attribution is *additive context* (e.g. "this purchase originally came from Organic Search 28 days before the last-click attribution").

| Action | Use case |
|---|---|
| `discover` | First connect — finds GA4 properties, picks the brand-match, saves property + measurement ids to vault. |
| `traffic` | Sessions / users / engagement / page views by date or channel group (`level: "channel"`). |
| `conversions` | Every key event with eventCount + revenue. |
| `attribution` | First-touch vs last-touch by channel group — diagnose why Shopify revenue and Meta-attributed revenue diverge. |
| `landing-pages` | Per-URL sessions/engagement; auto-merges into seo-signals.json so SEO clusters can score against real engagement. |
| `audit-property` | Health audit — key events configured, data streams live, enhanced measurement on, industry category set. |

### Write — measurement plan setup

GA4 has no programmable API for funnel explorations — those live in the Explorations workspace UI. What IS programmable, and what makes funnels POSSIBLE, is the underlying measurement plan: key events (conversions), custom dimensions, custom metrics, audiences, property settings. Setting these up via API lets brands skip the manual click-through-30-screens setup that GA4 otherwise requires.

| Action | Use case |
|---|---|
| `create-key-event` | Mark an event as a conversion. Required `analyticsEventName`. Counting method defaults to ONCE_PER_EVENT. |
| `archive-key-event` | Un-mark an event as a conversion. Required `analyticsKeyEventName`. |
| `create-custom-dimension` | Add a custom dimension scoped to event/user/item — e.g. "checkout_method", "loyalty_tier". |
| `create-custom-metric` | Add a custom metric (numeric) — e.g. "items_in_cart". GA4 custom metrics are EVENT-only. |
| `create-audience` | Define an audience cohort for funnel/comparison analysis — pass full Audience body via `analyticsAudience`. |
| `update-property-settings` | Set `industryCategory` / `timeZone` / `currencyCode` / `displayName` via `patchBody`. |
| `attach-shopify-events` | One-click measurement plan: marks the standard ecommerce events (purchase, add_to_cart, begin_checkout, view_item, view_item_list, search, sign_up, generate_lead) as key events, idempotent. **Run this once per brand right after `discover`.** |

Every write action requires an approval card (`cmd.Approved` must be true); the renderer surfaces a confirmation before any mutation. Manual override in tests only.

When BOTH Shopify and GA4 report revenue: Shopify wins per Hard-Won Security Rule 10 (`pickRevenueSource`). GA4 attribution is shown as a diagnostic side panel, never as the topline number.

## Routing hints

- "numbers" / "how we doing" / "performance" / "dashboard" → `dashboard({action: "dashboard"})`
- "why aren't ads converting" / "audit my page" / "landing page" → apply Conversion Rubric, run `landing-audit` if available
- "what should I do next" → `dashboard` + read `memory.md`, propose top action
- "marketing calendar" / "launch schedule" / "content gaps" → `dashboard({action: "calendar"})`
- "set a goal" / "target $50k this month" / "what's my goal" → `{"action": "goal-set"}` / `{"action": "goal-get"}`
- "am I on track" / "pacing" / "will I hit my target" → `dashboard` (goal block is included automatically)
- "how is organic traffic" / "ga4 sessions" / "search traffic" → `google_analytics({action: "traffic"})`
- "what's converting" / "key events" / "ga4 conversions" → `google_analytics({action: "conversions"})`
- "first-touch vs last-touch" / "channel attribution" / "where does revenue actually come from" → `google_analytics({action: "attribution"})`
- "what landing pages convert" / "per-url engagement" → `google_analytics({action: "landing-pages"})`
- "is my ga4 set up" / "audit my ga4 property" / "ga4 health" → `google_analytics({action: "audit-property"})`
- "find my ga4 property" / "discover analytics" → `google_analytics({action: "discover"})`
- "set up my GA4 conversions" / "wire up GA4 for shopify" / "set up the standard ecommerce events" → `google_analytics({action: "attach-shopify-events"})` after `discover`
- "mark X as a conversion" / "set up purchase tracking in ga4" → `google_analytics({action: "create-key-event", analyticsEventName: "purchase"})`
- "add a custom dimension" → `google_analytics({action: "create-custom-dimension", analyticsParameterName: "...", analyticsDisplayName: "..."})`
- "create a ga4 audience" / "cohort for funnel analysis" → `google_analytics({action: "create-audience", analyticsAudience: {...}})`
- "fix my ga4 timezone" / "set ga4 currency" → `google_analytics({action: "update-property-settings", patchBody: {...}})`

## Cross-references

- Revenue source resolution → `merlin-ecom`
- Ad-specific performance + kill/scale decisions → `merlin-ads` (Promotion Gate)
- Email revenue attribution models → `merlin-social`
- SEO performance → `merlin-seo`
