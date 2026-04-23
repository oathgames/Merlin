---
name: merlin-setup
description: Use when no brand exists in assets/brands/ (first-run), the user says set up / onboard / add a new brand, the user wants to connect a platform (Meta, TikTok, Google, Shopify, Stripe, Klaviyo, Amazon, Discord, Slack, Etsy, Reddit, LinkedIn, Threads), or the user asks about scheduled tasks (merlin-daily, merlin-optimize, merlin-digest, merlin-memory). Covers website scrape, vertical detection, brand.md / memory.md scaffolding, WOW-moment product import, background competitor discovery, daily / optimize / digest / memory task creation, OAuth flows, Stripe read-only scope preference, and the "never ask for manual tokens" rule.
owner: ryan
bytes_justification: 38KB — setup is loaded only on first run per brand (rare), carries multi-step scheduled-task prompts that must stay verbatim, and halving it would force a second skill file and double-load on onboarding. Keep as one monolithic file.
---

# First-Run + Connection Setup

## Setup Flow

DO NOT print any ASCII art, banners, feature lists, or folder structure diagrams.
DO NOT narrate each setup step. The app has a native progress bar — do the work silently and show results (images, final summary). No play-by-play.

**Narration exception for long tools (>5s expected duration):** the silent-preflight rule above applies to fast tools. For any tool expected to take more than ~5 seconds — currently `brand_scrape` (up to 90s), the vertical detection pass inside the scrape, and any product-import step (`/products.json` fetch + image downloads) — the model MAY emit ONE short in-progress status line when the tool starts, plus one short status line for each interim progress event the tool emits (e.g. "Read homepage", "Found 14 products", "Downloaded logo"). Keep each line to a single sentence, no headers, no bullet lists. These tools emit structured progress events (see `mcp-tools.js` progress emit pattern); mirror the event's own short label rather than inventing prose. Fast tools (`connection_status`, `config`, `goal-set`, `platform_login` pre-auth, etc.) stay fully silent — this exception narrows to the long scrape/import path only.

**The goal: WOW the user in 30 seconds.** Show their own content back to them — logo, products, images — in real time.

### A) Brand + Product setup

1. Ask: **"What's your brand's website?"** — the opening question. The brand/product scrape, colors, logos, and memory scaffolding all run automatically from there. Two lightweight questions come later in the flow (a revenue goal, and autopilot consent); everything else is silent.

**VERTICAL AWARENESS** (after detecting vertical):
- **Ecommerce/DTC**: suggest Shopify connection, product import, ad creation.
- **SaaS/Software**: skip Shopify entirely. Focus on ad platforms (Meta/Google/TikTok), landing audits, blog/SEO, social. Products = features or plans.
- **Agency/Service**: skip Shopify. Focus on lead-gen ads, landing pages, email.
- NEVER suggest "import from Shopify" for non-ecommerce brands — it confuses users.

**VERTICAL CONFIRMATION (MANDATORY — do not skip).** Immediately after `brand_scrape` returns a detected vertical, and BEFORE any vertical-specific branching (Shopify connect prompt, product import, automation questions), use `AskUserQuestion` to confirm the detected vertical with the user. Schema:
- Question: *"I read your site as **[detected vertical]** — is that right?"*
- Options: exactly 4 chips, in this order:
  1. The detected vertical (the default answer, phrased as an affirmative e.g. *"Yes — Ecommerce/DTC"*).
  2. Three likely alternates chosen from the vertical taxonomy based on the brand signal — e.g. if scrape detected Ecommerce/DTC, alternates are `SaaS/Software`, `Agency/Service`, `Something else` (let me describe). If scrape detected SaaS, alternates are `Ecommerce/DTC`, `Agency/Service`, `Something else`. Keep the chip list to exactly 4 total (per clarify-intent SKILL rules on chip count).
- Descriptions: one short line per chip, plain English (e.g. *"Physical products, Shopify-style"*, *"Subscription software / app"*, *"Agency, consulting, or local service"*, *"Let me describe it"*).
- If the user picks the detected vertical: proceed with that vertical's flow.
- If the user picks an alternate: persist the user-confirmed vertical (overriding the scrape detection) and branch to that vertical's flow.
- If the user picks `Something else`: ask ONE free-text follow-up, then persist whatever vertical label the user gave.
- Persist the **confirmed** vertical to `brand.md`'s `vertical:` field — this is the authoritative value used by all downstream routing. Do NOT write the pre-confirmation detected value.
- Cross-cluster: the onboarding state file (Cluster-L §3.10) should flip `vertical_confirmed: true` after this question resolves so the question is not re-asked on a resumed session.

2. **Do all of this silently — no step narration, just show results:**

   **Brand + Colors + Voice:**
   - Fetch the website, extract brand name, download logo.
   - READ the logo so it displays inline in chat.
   - Extract brand colors from CSS, detect voice tone, identify target audience.
   - Write `brand.md` with: brand name, URL, vertical, brand colors (exact hex), voice tone, audience demographics, CTA style, tagline.
   - Write `memory.md` in the same brand folder with this template:
     ```
     # [Brand Name] — Memory

     ## Run Log
     <!-- Format: YYYY-MM-DD | product | mode | model | pass/fail | takeaway -->

     ## What Works

     ## What Fails

     ## Monthly Spend

     ## MER Trend

     ## Competitor Signals

     ## Errors
     ```

   **Products — THE WOW MOMENT:**
   - Fetch `<website>/products.json` — if this works, it's a Shopify store. Save the `.myshopify.com` domain to config immediately:
     - Check response headers or follow redirects to find `X-ShopId` or `.myshopify.com` redirect.
     - Run: `curl -sI <website> | grep -i 'myshopify\|x-shopid\|shopify'` to detect.
     - If found, note the Shopify store name for the connect step later. Enables instant Shopify OAuth (no resolution step).
   - For each of the first 10 products:
     - Create product folder + download first image.
     - **READ the downloaded image so it appears inline.**
     - Show: `**[Product Name]** — $[price]` with image visible.
   - Download remaining images (up to 5 per product) in the background.
   - Launch a **background Agent** to generate `product.md` for each product silently.

   **IMPORTANT:** Use Read on each downloaded image so it renders inline. Path: `assets/brands/<brand>/products/<product>/references/1.jpg` — Read immediately after download.

   If `/products.json` doesn't work:
   - Try scraping product pages directly.
   - If that fails: "I couldn't auto-pull products from your site. Drop some product photos in and I'll take it from there."

   **Competitors (background):** launch a background agent to find 5–8 via WebSearch. Write `assets/brands/<brand>/competitors.md`.

   **Goal capture (one question, conversational):** before creating scheduled tasks, ask ONCE:
   *"What's your revenue target for [brand] this month? (e.g., $50k, $100k — or say 'skip' if not sure yet.)"*
   - If the user gives a number: run `{"action": "goal-set", "brand": "<brand>", "goal": {"targetRevenue": <n>, "window": "monthly", "context": "<any color the user gave>"}}`. Writes `assets/brands/<brand>/goal.md` (YAML frontmatter + free-form context body). The dashboard will surface ahead/on-track/behind/at-risk pacing against this target automatically.
   - If the user says skip / "no idea" / "later": move on silently. `goal.md` stays absent, dashboard skips the pacing section. The user can set it later with the same action.
   - The goal file is user-editable markdown — they can open it in any editor and add priorities / constraints / context prose. Reading is via `{"action": "goal-get", "brand": "<brand>"}`.

   **Automation (CONSENT REQUIRED — ask the user before creating scheduled tasks):**

   **Product-count gate (MANDATORY — do not ask autopilot consent without products).** Before showing the autopilot consent question, check `productCount` — the number of products successfully imported from the scrape / `/products.json` / photo drop. Branch:
   - **`productCount >= 1`** → proceed with the autopilot consent question below.
   - **`productCount === 0`** → **skip the autopilot question entirely.** Creating daily-creative / ad-optimize spells before any product exists produces empty, embarrassing output on the first run. Instead, surface one single-line prompt:

     *"Drop product photos or a product URL to enable daily creatives."*

     Set the onboarding-state flag `pending_products_for_autopilot: true` on the onboarding checkpoint file (Cluster-L §3.10 owns the persistence — write through whatever helper that cluster exposes). On a future launch, after at least one product exists, the onboarding flow reads this flag and re-asks the autopilot consent question at that point. Skip sections B and the autopilot-branch summary; jump to the `autopilot-off` / "no products yet" final-summary variant that tells the user how to drop products and invites them to the Spellbook later.

   Scheduled tasks will generate creatives, kill/scale ads, and adjust budgets without per-action confirmation — so they require explicit opt-in. Do NOT call `mcp__scheduled-tasks__create_scheduled_task` before the user answers the question below. Use `AskUserQuestion` with ONE question first:

   **Question:** *"Turn on autopilot for [Brand]? Merlin can generate daily creatives, optimize your ads, send weekly digests, and keep your memory tidy. You can toggle any of these off later in the Spellbook (the ✦ tab in the sidebar)."*

   **Options (exactly these three, in this order):**
   - `Yes — turn on all 4 (recommended)` · description: `Daily creatives 9 AM · Ad optimization 10 AM · Weekly digest Monday · Memory compaction Sunday`
   - `Let me pick` · description: `Ask me about each one`
   - `Not now` · description: `I'll enable them later in the Spellbook`

   **Branch on the answer:**
   - `Yes — turn on all 4 (recommended)` → create all four tasks from section B without further questions.
   - `Let me pick` → ask follow-up `AskUserQuestion` questions, each with `Yes` / `No` options. Create only the tasks the user said `Yes` to. Ask in this order:
     1. *"Daily creatives — generate fresh ad concepts every weekday at 9 AM?"*
     2. *"Ad optimization — kill losers and scale winners every weekday at 10 AM?"* (skip this one entirely if neither Meta nor TikTok is configured)
     3. *"Weekly digest — post a performance summary every Monday at 9 AM?"*
     4. *"Memory compaction — tidy up memory.md every Sunday at 11 PM?"*
   - `Not now` → create nothing in section B. Use the `autopilot-off` final-summary variant below.

   Regardless of answer, the final summary must tell the user that every spell lives in the ✦ Spellbook and can be toggled on/off there.

   **Final summary (the ONLY setup message after products):**

   If the user enabled at least one spell:
   ```
   [Brand] is loaded — [X] products, [Y] reference photos. Autopilot is on: [names of enabled spells]. Toggle any of them in the ✦ Spellbook.

   Want to supercharge your results? Drop any of these into your brand folder:

   Your best-performing ads -> assets/brands/[brand]/quality-benchmark/
   A voice sample (.mp3/.wav) -> assets/brands/[brand]/voices/
   Creator photos/videos -> assets/brands/[brand]/avatars/

   What would you like to create first?
   ```

   If the user chose `Not now`:
   ```
   [Brand] is loaded — [X] products, [Y] reference photos.

   Autopilot is off. Open the ✦ tab in the sidebar when you're ready — every spell is one toggle away.

   Want to supercharge your results? Drop any of these into your brand folder:

   Your best-performing ads -> assets/brands/[brand]/quality-benchmark/
   A voice sample (.mp3/.wav) -> assets/brands/[brand]/voices/
   Creator photos/videos -> assets/brands/[brand]/avatars/

   What would you like to create first?
   ```

   **Rules for the summary:** show ONCE per brand, first setup only · use the actual brand name + folder path · skip lines for folders already populated · always end with "What would you like to create first?" · the autopilot line reflects the user's actual consent answer — never fabricate "autopilot is on" when nothing was created.

### B) Schedule daily generation (consent-gated — see section A)

Create ONLY the tasks the user approved via the consent question in section A. If the user chose `Not now`, skip this entire section — do not call `mcp__scheduled-tasks__create_scheduled_task` at all. For each task the user approved, use `mcp__scheduled-tasks__create_scheduled_task`; all `taskId`s must use the `merlin-` prefix.

#### Task 1 — `merlin-daily` (daily content)

- **cronExpression:** `0 9 * * 1-5` (9 AM weekdays)
- **description:** `Generate daily content for all brands`
- **prompt:**
  ```
  == SETUP ==
  Check connection status via mcp__merlin__connection_status.
  Use MCP tools for all platform actions.

  == ERROR HANDLING (applies to ALL steps) ==
  If the app returns an error or non-zero exit code:
    - Log the error to assets/brands/<brand>/memory.md under "## Errors"
    - Post to Slack + Discord if configured: "✦ Merlin error: {error message}"
    - Skip that step and continue to the next
    - Do NOT retry failed API calls — they will be retried next cycle
  If a token/API key error occurs (401, 403, "unauthorized", "expired"):
    - Log: "⚠ TOKEN EXPIRED: {platform}" to assets/brands/<brand>/memory.md
    - Post to Slack: "✦ ⚠ {platform} token expired — re-authenticate to resume"
    - Skip ALL steps for that platform until the next session

  == MEMORY ROTATION ==
  The merlin-memory spell handles weekly compaction. During daily runs, just append.
  Only intervene if memory.md is over 300 lines (emergency): delete oldest Run Log entries until under 200.

  == MULTI-BRAND ==
  Scan assets/brands/ for all brand folders (skip "example").
  For EACH brand that has products:

  0. CONSUME DECISION QUEUE (replace killed ads before rotation).
     Call mcp__merlin__decisions({action:"queue", brand:"<brand>"}) — returns unconsumed
     DecisionFacts where NextAction.Type == "generate" (i.e. kills that haven't been replaced yet).
     For each queued entry:
       → Generate a replacement ad for NextAction.Product using a hook OTHER than
         NextAction.HookToAvoid (read memory.md "## What Works" to pick the next best hook).
       → Pass factRefs:[<queue entry ID>] on the generation call so the binary emits a
         consume DecisionFact linking the replacement back to the kill.
     If the queue is empty, proceed to step 1 (normal rotation).
     Cap: at most 3 replacements per brand per daily run to stay inside budget.

  1. Read brand.md + assets/brands/<brand>/memory.md. Pick a product not used in the last 7 days (check Run Log).
     If all products were used recently, pick the one with the longest gap.

  2. Generate a product-showcase image (both formats).
     If quality gate fails after 3 retries, log failure and move on.
     Post to Slack if configured.

  3. If shopifyStore + shopifyAccessToken are configured:
     - Write a 600-1000 word SEO blog post about the product
     - Use the brand voice from brand.md
     - Check CONFIG.blogPublishMode:
       - If "draft": publish as draft via {"action": "blog-post", ..., "draft": true}
       - If "published" or missing: publish live
     - Log the blog title + URL + publish status in assets/brands/<brand>/memory.md

  4. SEO fix queue — if assets/brands/<brand>/seo.md exists:
     - Fix 2-3 images with EMPTY alt text (seo-fix-alt action)
     - Mark each fixed item as [x] in seo.md
     - NEVER touch: product titles, descriptions, prices, pages, theme
     - NEVER overwrite existing alt text

  5. Calendar-driven content (if Shopify connected):
     - Run {"action":"calendar"} to get launch predictions + upcoming gaps
     - If a product launch or seasonal event is within 7 days:
       → Prioritize that product for today's creative generation (override rotation)
       → Draft a blog post timed to the event
       → Log: "Calendar: {event} in {N} days — prepped {product} content"
     - If no launches for 14+ days: generate evergreen content for best-performing product

  6. Review solicitation (if Shopify + Klaviyo configured):
     - Run {"action":"shopify-orders","batchCount":7} to find orders fulfilled 5-7 days ago
     - For each fulfilled order (max 3/day to avoid spam):
       → Create a Klaviyo campaign draft: product photo + "How are you liking your {product}?" + review link
       → Publish as draft — user or merlin-optimize can approve
       → Log: "Review request drafted for {product} (order {id})"
  ```
- After creation tell user: *"Daily content is set! I'll generate fresh ads and blog drafts every weekday at 9 AM."*

#### Task 2 — `merlin-optimize` (only if Meta OR TikTok configured)

- **cronExpression:** `0 10 * * 1-5` (10 AM weekdays, 1h after generation)
- **description:** `Agency-tier ad optimization: kill losers, scale winners, manage budget`
- **prompt:**
  ```
  == SETUP ==
  Check connection status via mcp__merlin__connection_status.
  Use MCP tools for all platform actions.
  DAILY_BUDGET = CONFIG.dailyAdBudget (default $20 if not set)

  Derive all thresholds from DAILY_BUDGET — never hardcode:
    MONTHLY_CAP = DAILY_BUDGET × 30
    TESTING_BUDGET = DAILY_BUDGET × 0.60 (60% for testing new creatives)
    SCALING_BUDGET = DAILY_BUDGET × 0.30 (30% for proven winners)
    RETARGETING_BUDGET = DAILY_BUDGET × 0.10 (10% for retargeting warm audiences)
    PER_AD_TEST_BUDGET = max($5, TESTING_BUDGET ÷ active_test_count)

  == TOKEN VALIDATION ==
  Before any platform action, verify tokens work:
  For each configured platform (Meta, TikTok, Google, Amazon):
    - Try a lightweight read call (e.g., meta-insights with batchCount:1)
    - If 401/403: Log "⚠ TOKEN EXPIRED: {platform}" to activity.jsonl
    - Skip ALL actions for that platform in this run
    - Do NOT retry — user must re-authenticate

  == ERROR HANDLING ==
  Same rules as merlin-daily task: log errors, alert on token expiry, skip and continue.

  == STEP 1: BUDGET PACING CHECK ==
  Read assets/brands/<brand>/memory.md "## Monthly Spend" section.
  Calculate: days_elapsed = days since 1st of month, days_remaining = days until end of month
  Expected pace = MONTHLY_CAP × (days_elapsed / days_in_month)
  Actual spend = sum of all spend entries this month

  If actual > expected × 1.2: OVERPACING — reduce today's actions (skip new ad creation, only optimize existing)
  If actual < expected × 0.5: UNDERPACING — increase today's actions (create extra test ads if budget allows)
  Log: "Budget pacing: $X spent / $Y expected ($Z cap). Status: ON_PACE / OVERPACING / UNDERPACING"

  If actual >= MONTHLY_CAP: STOP all ad operations. Post to Slack + Discord: "✦ Monthly budget cap reached."

  == STEP 1b: LOAD RECENT HISTORY ==
  Read the last 30 lines of assets/brands/<brand>/activity.jsonl to understand recent actions.
  Avoid duplicating work (don't kill an ad just created yesterday,
  don't queue a replacement for a product that already got one today).
  Read assets/brands/<brand>/ads-live.json for current live ad state.

  == STEP 2: PULL PERFORMANCE (all platforms) ==
  For each configured platform (Meta, TikTok, Google):
    Run insights action. Collect for every ad:
    - ad_id, ad_name, status, spend, impressions, clicks, CTR, CPC, purchases, revenue, ROAS
    - days_running
    - ctr_trend (today's CTR vs first 48h average)

  == STEP 3: TRIAGE EVERY AD (agency decision framework) ==
  For EACH active ad, apply these rules IN ORDER:

  SAFETY RULE — AGGREGATE KILL CAP:
    Count total active ads before triage. In a single optimization run,
    NEVER kill more than 50% of active ads. If triage rules would kill
    more than 50%, only kill the worst performers up to the 50% cap.
    Log: "Kill cap reached: {killed}/{total} ads (50% limit). Spared {N} borderline ads."

  SAFETY RULE — DUPLICATE PREVENTION:
    Before creating any new test ad, check ads-live.json for the same brand.
    If an ad already exists for the same product with the same hook style,
    do NOT create a duplicate.

  WRITE-BACK RULE — After EVERY kill, scale, or publish:
    Update ads-live.json immediately. Set status to "paused" for kills, "live" for scales/publishes.
    Update ROAS and budget fields from the latest insights data.

  DECISION FACT EMISSION — every kill/scale MUST pass trigger + product (+ hookToAvoid on kills):
    Kill calls: mcp__merlin__meta_ads({action:"kill", adId, trigger:"<reason>",
      hookToAvoid:"<hook style>", product:"<product>", factRefs:["<insight-fact-id>"]}).
      Same shape for tiktok_ads. trigger values: "dead_on_arrival" | "low_performer" | "fatigue".
    Scale calls: mcp__merlin__meta_ads({action:"duplicate", adId, trigger:"<reason>",
      product:"<product>", factRefs:["<insight-fact-id>"]}). trigger: "winner" | "massive_winner".
    The binary signs a DecisionFact and appends it to activity.jsonl with type="decision".
    The merlin-daily task reads the unconsumed kill queue and generates replacements that cite
    the kill's DecisionFact ID in FactRefs. DO NOT write kill reasons, fatigue notes, or
    hook-to-avoid prose into memory.md — the signed DecisionFact is the authoritative record.

  RULE 1 — DEAD ON ARRIVAL (kill fast, save money):
    If spent >= 2× PER_AD_TEST_BUDGET AND purchases == 0 AND CTR < 1.0%:
    → KILL immediately. Don't waste another dollar.
    → Emit DecisionFact (see DECISION FACT EMISSION below) with trigger="dead_on_arrival",
      product=<ad product>, hookToAvoid=<hook style>. Do NOT write the reason as prose to memory.md.

  RULE 2 — LOW PERFORMER:
    If spent >= PER_AD_TEST_BUDGET AND ROAS < 0.5 AND days_running >= 2:
    → KILL. Fair shot, underperformed.
    → Emit DecisionFact with trigger="low_performer", product=<ad product>, hookToAvoid=<hook>.

  RULE 3 — CREATIVE FATIGUE:
    If days_running >= 5 AND ctr_trend declining 30%+ from peak:
    → KILL. Emit DecisionFact with trigger="fatigue", product=<ad product>, hookToAvoid=<hook>.
    → The binary persists the signed fact; merlin-daily's decision-queue step reads it and
      generates a replacement with a DIFFERENT hook. Do NOT hand-queue or write fatigue prose
      to memory.md — the DecisionFact IS the queue entry.

  RULE 4 — PROMISING:
    If days_running < 3 AND CTR >= 1.0%: HOLD.

  RULE 5 — WINNER:
    If ROAS >= 1.5 AND days_running >= 2 AND spend >= PER_AD_TEST_BUDGET:
    → SCALE. Duplicate to Scaling campaign with budget = SCALING_BUDGET ÷ active_winners.
    → Emit DecisionFact with trigger="winner", product=<ad product> on the duplicate call.
    → Distilled pattern to memory "## What Works" MAY cite the DecisionFact ID in square brackets
      (e.g. "UGC unboxing wins for calm-gummies [dec-a1b2c3d4]"). Never paste raw metrics.

  RULE 6 — MASSIVE WINNER:
    If ROAS >= 3.0 AND spend >= DAILY_BUDGET AND purchases >= 5:
    → SCALE + create LOOKALIKE from purchasers. ONCE per ad (check memory.md for "lookalike:{ad_id}").
    → Emit DecisionFact with trigger="massive_winner", product=<ad product> on the duplicate call.

  RULE 7 — RETARGET:
    If any WINNER exists AND retargeting has no active ads:
    → Create retargeting ad with winner's creative, pixel audience. Budget = RETARGETING_BUDGET.
    → Emphasize urgency/social proof, not awareness.

  == STEP 4: CREATIVE PIPELINE (replace killed ads) ==
  For each killed ad, if TESTING_BUDGET has room:
  → Queue new test ad with different hook / format / angle.
  → Read memory.md "## What Works"/"## What Fails" to avoid repeats.
  → merlin-daily will generate tomorrow.

  == STEP 5: CROSS-PLATFORM INTELLIGENCE ==
  If multiple platforms active, compare ROAS per product per platform.
  Shift 20% from underperformer to winner within DAILY_BUDGET cap.

  == STEP 5b: PREDICTIVE BUDGET REALLOCATION ==
  Week-over-week ROAS drops ≥30% → reduce loser 30%, increase winner same.
  Never below $5/day, never above DAILY_BUDGET total.

  == STEP 5c: INVENTORY-AWARE AD PAUSING ==
  If Shopify connected: run {"action":"optimize-inventory","brand":"<brand>"}.
  Walks ads-live.json, matches each live ad to a Shopify product by slug, pauses on 0 inventory,
  and restores previously-paused ads when the product is restocked. Idempotent — state is persisted
  to .merlin-paused-for-stock.json, so the next run picks up where this one left off.
  Result counts (paused / restored / skipped / errors) are logged to activity.jsonl automatically.

  == STEP 5d: WINNER FORMULA DETECTION ==
  After 4+ tests, identify (hook + format + audience + time-of-day) that outperforms 2×+.
  Log to memory "## What Works": "WINNING FORMULA: ..."

  == STEP 5e: FATIGUE CURVE PREDICTION ==
  For ads 3+ days old: if CTR dropped 20%+ from peak, predict fatigue day.
  If within 3 days: queue replacement now.

  == STEP 5f: CROSS-PLATFORM ARBITRAGE ==
  ROAS drop 30%+ on one platform while another rose 30%+ → check wisdom for vertical trend.

  == STEP 5g: COMPETITOR ACTIVITY SURGE ==
  If Meta + competitors.md: competitor-scan top 3 (max 3/day). If any launched 3×+ normal volume in 72h, flag.

  == STEP 6: DAILY DASHBOARD SNAPSHOT ==
  mcp__merlin__dashboard({action: "dashboard", brand: "X", batchCount: 1}) → results/dashboard_YYYY-MM-DD.json.
  Monthly (1st only): mcp__merlin__shopify({action: "cohorts", brand: "X", batchCount: 180}).

  == STEP 6b: CHURN-TRIGGERED WIN-BACK ==
  Monthly (1st week): if any 90-day cohort repeat rate < 15%:
    → email-audit: does win-back flow exist? If no → flag. If yes but churn rising → recommend refresh.

  == STEP 7: SAVE MEMORY (do this FIRST before posting) ==
  MEMORY HARMONY — memory.md holds DISTILLED patterns only, never raw metrics
  or per-ad receipts (those live in activity.jsonl + briefing.json). Every
  new "## What Works" / "## What Fails" entry MUST cite the DecisionFact ID(s)
  that support it in square brackets, e.g.
  "UGC unboxing wins for calm-gummies [dec-a1b2c3d4]".

  Update assets/brands/<brand>/memory.md:
    - "## Monthly Spend": today's spend by platform (rollup total only — not per-ad)
    - "## Run Log": one line — date, kill count, scale count, pacing status
    - "## What Works" / "## What Fails": new DISTILLED patterns with [dec-…] citations
    - "## MER Trend": today's MER from dashboard (trend line, not raw numbers)

  Write per-brand briefing.json AND root .merlin-briefing.json:
    {"date":"YYYY-MM-DD","ads":{"killed":N,"scaled":N,"created":N,"active":N},"content":{"blogs":N,"images":N},"revenue":{"total":"$X","trend":"+Y%"},"bestHookStyle":"ugc","bestFormat":"9:16","avgROAS":X.X,"recommendation":"..."}

  == STEP 8: POST + LOG ==
  Post to Slack + Discord:
    "✦ Daily Optimization — {brand}
    MER: {X}x | Revenue: ${rev} | Spend: ${spent_today}
    Budget: ${spent_today} / ${DAILY_BUDGET} daily | ${month_total} / ${MONTHLY_CAP} monthly
    Killed: {N} (reasons: {brief})
    Scaled: {N} (best: {top_ad_name} at {ROAS}x)
    Replacements queued: {N}
    Pacing: {ON_PACE / OVERPACING / UNDERPACING}"

  If no actions taken: "✓ All ads performing normally — no changes needed"
  ```

#### Task 3 — `merlin-digest` (weekly digest, always)

- **cronExpression:** `0 9 * * 1` (Monday 9 AM)
- **description:** `Weekly performance digest across all brands and platforms`
- **prompt:**
  ```
  == ERROR HANDLING ==
  Same rules as other tasks: log errors, skip failed steps, continue.

  == MULTI-BRAND ==
  Scan assets/brands/ for all brand folders (skip "example"). Report on ALL brands.

  == ADS (if Meta or TikTok configured) ==
  1. Meta-insights, collect all campaign data
  2. TikTok-insights, collect all campaign data
  3. Errors → note in digest and continue

  == SEO (per brand, if Shopify configured) ==
  4. {"action": "blog-list"} → this week's posts
  5. Read seo.md — completed [x] vs remaining [ ]
  6. Read memory.md for blog URLs this week

  == COMPETITOR INTEL (per brand, if competitors.md) ==
  7. Read competitors.md
  8. If metaAccessToken: competitor-scan
  9. WebSearch for competitor news

  == COMPILE DIGEST ==
  ✦  Merlin Weekly Digest — [Date Range]
  ─────────────────────────────────────────────────
  BUDGET: Monthly spend $XX / $YY cap (ZZ%). Remaining: $XX.
  ADS:
    META: Spend $XX | ATC XX | ROAS X.Xx | Best: [ad] | Worst: [ad]
    TIKTOK: Spend $XX | ATC XX | Active: X testing, X scaling
    Actions: X killed, X scaled, X retargeted
  SEO: X posts published (Y draft). X alt fixes. Queue: X.
  COMPETITORS: [notable findings]
  CONTENT: Images X | Videos X

  == COMPETITOR RESPONSE ==
  Competitor 3×+ surge → "⚠ {competitor} launched {N} ads. Hooks: {top hooks}. Counter-creative?"
  Sale/offer → "COMPETITIVE PRESSURE — consider matching."
  Save trending hooks to memory "## Competitor Hooks".

  == PRICING INSIGHTS (if Shopify) ==
  shopify-analytics 30d. Cross AOV with ad ROAS:
    High ROAS + Low AOV → underpriced (room to raise)
    Low ROAS + High AOV → overpriced (test lower or bundle)
    High ROAS + High AOV → sweet spot
  Per-product: ATC-to-purchase < 50% avg → possible price friction.

  == CUSTOMER HEALTH (1st week only, if Shopify) ==
  shopify-cohorts 180d: repeat rate trend, LTV by cohort.
    <20% repeat → "⚠ Low repeat — win-back + post-purchase critical"
    LTV up → "Strategy is building loyalty"

  10. Post to Slack + Discord
  11. Update memory.md with weekly summary
  ```

#### Task 4 — `merlin-memory` (memory hygiene, always)

- **cronExpression:** `0 23 * * 0` (Sunday 11 PM, off-peak)
- **description:** `Keep brand memory files clean and within token budget`
- **prompt:**
  ```
  Scan assets/brands/ for all brand folders (skip "example").
  For EACH brand, read memory.md and enforce caps:

  SECTION CAPS (count entries, delete oldest beyond cap):
    "## Run Log": keep last 50
    "## What Works": keep last 20
    "## What Fails": keep last 20
    "## Monthly Spend": keep last 6 months
    "## Errors": keep last 20
    "## MER Trend": keep last 30
    "## Competitor Signals": keep last 10
    "## Customer Health": keep last 6
    "## Competitor Hooks": keep last 10

  TARGET: memory.md under 200 lines total.
  If still over 200 after caps, reduce each section proportionally.

  Do NOT summarize old entries — delete them. Recent data has signal.
  Log: "Memory cleanup: {brand} — {before} lines → {after} lines"

  ## Memory Harmony Rule

  memory.md holds PATTERNS, PREFERENCES, BRAND VOICE, and NARRATIVE — never
  raw metrics or per-ad receipts. Raw metrics live in activity.jsonl (as
  signed facts) and briefing.json (as daily snapshots); memory.md is where
  the DISTILLED lesson lives.

  Allowed in memory.md:
    - "UGC unboxing outperforms studio shots for calm-gummies [dec-a1b2c3d4]"
    - "Customers respond to 'science-backed' language; avoid 'miracle'"
    - "Monday launches underperform — ship Tuesday–Thursday"
    - "Lookalike seeds from purchasers outperform interest targeting 2×"

  NOT allowed in memory.md (these belong in activity.jsonl / briefing.json):
    - "Ad abc123 spent $47, 0 purchases, 0.3% CTR — killed on 2026-04-17"
    - "Hook 'Tired of X?' killed after 2 days for dead_on_arrival"
    - "ROAS yesterday: 2.3x, today: 1.8x, trending -22%"
    - Per-run dashboard snapshots (dashboard_YYYY-MM-DD.json owns these)

  CITATION RULE: every distilled pattern MUST cite the DecisionFact ID(s)
  that support it, in square brackets. One pattern, one-or-more IDs. The
  citation makes the pattern auditable — a future run can verify the
  signed fact still exists before trusting the pattern. Patterns without
  citations are treated as stale and eligible for cleanup.

  During weekly compaction, if a pattern cites a DecisionFact ID that no
  longer exists in activity.jsonl (e.g. the file rolled over), retain the
  pattern but strip the broken citation — the lesson survives even when
  the receipt ages out.
  ```

### C) Platform connections (don't ask during setup — connect on demand)

When the user later asks to publish ads / connect Shopify / etc., use one-click OAuth:

- Meta: `platform_login({platform: "meta", brand})` **— EXCEPT Meta is currently in App Review, so OAuth unavailable.** Tell users to click the Meta tile in Connections and paste their token from `developers.facebook.com/tools/explorer`. Do NOT use `platform_login` for Meta.
- TikTok / Shopify / Google / Amazon / Etsy / Reddit / Discord / Slack / Stripe: `platform_login({platform: "X", brand})` — browser OAuth, one click, token exchanged via Worker BFF.

**CRITICAL: OAuth timeout.** The app waits up to 5 minutes for in-browser authorization. Any Bash call running an OAuth action MUST set `timeout: 300000`. Default 120s kills before the user finishes.

**When connecting any ad platform**, ask ONE question: *"How much do you want to spend per day on ads? (e.g., $20, $50, $100)"*

Merlin infers everything from `dailyAdBudget`:
- Monthly cap = daily × 30
- Testing = 60% (split across test ads)
- Scaling = 30% (winners only)
- Retargeting = 10%
- Per-ad test = Testing ÷ active test count (min $5)
- Kill threshold = 2× per-ad with 0 purchases → kill
- Scale threshold = ROAS > 1.5× after 48h → promote
- Fatigue threshold = CTR drops 30%+ from peak over 3 days → kill + replace

Default: **$20/day** if the user doesn't answer (enough for 3–4 ads at $5 each).

Always say: *"You can change this anytime — just say 'change my daily budget to $X'."*

**NEVER ask for tokens, IDs, or keys manually. NEVER fall back to "go to Business Settings → System Users → Generate Token." If OAuth fails, tell the user to try again — do NOT switch to manual token instructions. If OAuth isn't available for a platform yet, say so clearly.**

### E) Shopify connection

One-click OAuth via `platform_login({platform: "shopify", brand})`:
- App auto-resolves store name from brand website.
- Opens Shopify OAuth approval.
- User clicks "Install" — one click.
- Token exchanged automatically.

**NEVER ask users to create custom apps, copy tokens, or navigate Shopify admin settings.**

After connecting:
1. **Auto-import products:** `{"action": "shopify-import"}`.
2. **Pull order metrics:** `{"action": "shopify-orders", "batchCount": 7}`.
3. Launch a background SEO audit (see below).

### F) Stripe connection (optional — revenue reporting)

Offer when the brand is SaaS / subscription / non-Shopify commerce, or when the user mentions MRR / churn / ARR / subscriptions.

Stripe is **read-only** — scope pinned to `read_only`, enforced at 3 layers (source scan, Worker BFF scope check, Stripe's own 403 on writes). Merlin can see revenue, subscriptions, cohorts — but cannot charge, refund, cancel, modify.

One-click OAuth: `platform_login({platform: "stripe", brand})` → `https://connect.stripe.com/oauth/authorize?scope=read_only&...` → user clicks "Connect" → token exchanged via Worker BFF (client secret never touches user's machine).

After connecting:
1. **Verify account:** `{"action": "stripe-setup"}` → confirm connection, cache account ID.
2. **Pull revenue:** `{"action": "stripe-revenue", "batchCount": 30}` — gross, refunds, net, AOV, new customers, USD-normalized via Stripe's FX.
3. **Pull subscription metrics:** `{"action": "stripe-subscriptions"}` — MRR, ARR, active subs, 30-day churn, top plans. Returns nil for transactional-only merchants.

**Revenue source disambiguation (CRITICAL):** if BOTH Shopify AND Stripe connected AND Stripe processes Shopify → double-count. First `stripe-setup` after connecting both prints a prompt. Ask user, then run:
```
{"action": "stripe-preference", "provider": "shopify"}   # Shopify topline, Stripe hidden
{"action": "stripe-preference", "provider": "stripe"}    # Stripe topline, Shopify hidden
{"action": "stripe-preference", "provider": "both"}      # Separate streams, sum them
```
Default (no preference) prefers Shopify — safer, avoids double-count.

## Background SEO Audit

### NON-NEGOTIABLE: What Merlin NEVER touches

```
NEVER modify:
  - Product titles, descriptions, prices, variants, sizes, inventory
  - Collection pages or descriptions
  - Theme files, Liquid templates, CSS, JS
  - Navigation menus or page structure
  - Homepage content
  - Anything the store owner may have written or customized

The store owner set these intentionally. Do NOT "improve" them.
```

### What Merlin CAN do (additive-only, non-breaking)

```
ALLOWED:
  - Publish NEW blog posts (new content, never edits)
  - Add image alt text WHERE CURRENTLY EMPTY (never overwrite existing)
  - Report sitemap/robots.txt issues (report only, never modify)
  - Identify content gap opportunities (blog topics, not product changes)
  - Report Google indexing/presence findings (informational)
```

Audit by fetching: homepage (title/meta/H1, report only) · `/products.json` (flag empty alt text — fixable, count products) · `/blogs/news` (exists? post count? recency) · `/sitemap.xml` (exists + accessible, report only) · `/robots.txt` (check for accidental blocks, report only).

Write findings to `assets/brands/<brand>/seo.md`:

```markdown
# SEO Audit — <Brand Name>
Audited: YYYY-MM-DD | Store: <url>

```

### After each scheduled task completes

Check if `assets/brands/brands-index.json` exists. If not, regenerate by scanning `assets/brands/` (excluding `example`) and writing the index with each brand's name, vertical, status, productCount. Lightweight — only write if missing.

## Folder Structure

```
assets/brands/
└── <brand>/                    ← brand folder (e.g., "madchill")
    ├── brand.md                ← voice, audience, CTA style, brand colors
    ├── memory.md               ← what works/fails, run log, MER trend
    ├── briefing.json           ← latest ROAS, best hook/format, active ads
    ├── competitors.md          ← auto-discovered competitors
    ├── seo.md                  ← SEO audit (if Shopify connected)
    ├── quality-benchmark/      ← S-tier ad examples (user drops these)
    ├── voices/                 ← voice samples (.mp3/.wav)
    ├── avatars/                ← creator faces/videos
    └── products/
        └── <product>/          ← e.g., "full-zip"
            ├── references/     ← product photos (auto-pulled)
            └── product.md      ← auto-generated
```

## Detection Logic

1. **List brands** — scan `assets/brands/` for subdirs with `brand.md`.
2. **List products** — scan `assets/brands/<brand>/products/` for subdirs with `references/`.
3. **Route from user input:**
   - `/merlin cream-set video` → find which brand contains `cream-set`, use it.
   - `/merlin madchill pink-set images` → explicit brand + product.
   - `/merlin make a video` → if only one brand+product, use it. Ambiguous → ask.
4. **No brand exists** → run Setup Flow above.

## Auto-generate `product.md`

When a product folder has `references/` but no `product.md`:
1. Read all images in `<brand>/<product>/references/`.
2. Write:
```markdown
# [Product Name]   (from folder name, Title Case)
- **Type**: [hoodie, joggers, set, etc. — from photos]
- **Colors**: [what you see]
- **Key details**: [stitching, fabric, fit, logo placement — what you see]
- **Vibe**: [casual, premium, sporty, etc.]
```

## Auto-generate `brand.md`

On first run with a new brand, ask for the website URL and scrape. Detect channel signals:
- **Store locator / "Find a store" page** → `channels:retail,online`
- **Single location** → `channels:retail,online` + `locations:1`
- **No physical store signals** → `channels:online`

If unsure, ask: *"Do you have a physical store or is this online-only?"* (affects ad targeting).

## Routing hints

- "set up / onboard / add brand X" / no brands exist → run Setup Flow (section A)
- "connect Meta / TikTok / Google / Shopify / Stripe / Klaviyo / Amazon / Discord / Slack / Etsy / Reddit / LinkedIn / Threads" → `platform_login` (section C, exception for Meta)
- "change daily budget to $X" → config write via `mcp__merlin__config`
- "what scheduled tasks are running" → `mcp__scheduled-tasks__list_scheduled_tasks`
- "turn off daily / optimize / digest" → `mcp__scheduled-tasks__update_scheduled_task({taskId, enabled: false})`
