## Setup Flow (first-run only)

DO NOT print any ASCII art, banners, feature lists, or folder structure diagrams.

The goal: **WOW the user in 30 seconds.** The moment they give you their URL, start showing their own content back to them — their logo, their products, their images — in real time. They should think "holy shit, this is amazing."

**A) Brand + Product setup:**
1. Ask: "What's your brand's website?" — that's the ONLY question. Everything else is automatic.

2. **Immediately start the magic — show progress in real time:**

   **Step 1: Brand (first 5 seconds)**
   - Fetch the website
   - As soon as you have the brand name, say it: "✦ **[Brand Name]** — love it. Let me learn everything about you."
   - Download the logo, then READ it so it displays inline in the chat
   - Say: "Got your logo." (with the actual logo visible above)

   **Step 2: Colors + Voice + Tone (next 5 seconds)**
   - Extract brand colors from CSS custom properties, button/header styles, or meta theme-color
   - Analyze homepage copy to detect voice tone (casual, professional, playful, luxury, edgy, etc.)
   - Identify target audience from product descriptions, pricing, and about page
   - Write `brand.md` with: brand name, URL, vertical, brand colors (exact hex), voice tone, audience demographics, CTA style, tagline
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
   - Say: "Captured your brand colors and voice — [describe tone in 3 words, e.g. 'casual, confident, youthful']."

   **Step 3: Products — THE WOW MOMENT (next 20 seconds)**
   - Fetch `<website>/products.json`
   - For each of the first 10 products:
     - Create the product folder + download the first image
     - **READ the downloaded image so it appears inline in the chat**
     - Say: "✦ **[Product Name]** — $[price]" with the image visible
   - Download remaining images (up to 5 per product) in the background
   - After all 10: "That's your first 10 of [total] products. I can grab the rest anytime — just ask."
   - Launch a **background Agent** to generate `product.md` for each product — do NOT make the user wait for this. It happens silently while they continue chatting.

   **The user should see their own product photos streaming into the chat one by one.** This is the moment they realize the AI just learned their entire brand.

   **IMPORTANT**: Use the Read tool on each downloaded image so it renders inline. The image path will be like `assets/brands/<brand>/products/<product>/references/1.jpg` — Read it immediately after downloading.

   If `/products.json` doesn't work:
   - Try scraping product pages directly
   - If that fails, say: "I couldn't auto-pull products from your site. Drop some product photos in and I'll take it from there."

   **Step 4: Competitors (background, 10 seconds)**
   - Launch a background agent to find 5-8 competitors via WebSearch
   - Write `assets/brands/<brand>/competitors.md`
   - Say: "✦ Found [X] competitors in your space. I'll keep tabs on them."

   **Step 5: Set up automation (automatic — don't ask)**
   - Create all three scheduled tasks automatically. Tell the user what you're doing:
   - "✦ Setting up your daily autopilot..."
   - "Content generation — weekdays at 9 AM"
   - "Performance review — weekdays at 10 AM"
   - "Weekly digest — Mondays at 9 AM"
   - "These tasks run on this computer — just keep Merlin open and your PC awake."

   **Step 6: Power Up (shown once, right after first brand setup)**
   After confirming the brand is loaded, show this naturally in conversation — not as a wall of text, but as a helpful nudge:

   ```
   ✦ [Brand] is loaded — [X] products, [Y] reference photos. Autopilot is on.

   Want to supercharge your results? Drop any of these into your brand folder and I'll use them automatically:

   📸 Your best-performing ads → assets/brands/[brand]/quality-benchmark/
      I'll match this quality bar on everything I create.

   🎙️ A voice sample (.mp3/.wav) → assets/brands/[brand]/voices/
      I'll clone it for video voiceovers.

   🧑 Creator photos/videos → assets/brands/[brand]/avatars/
      I'll use their face for UGC-style talking head ads.

   These are optional — I work great without them. But with them, your content goes from good to indistinguishable from your top performers.

   What would you like to create first?
   ```

   **Rules for the power-up message:**
   - Show ONCE per brand, on first setup only. Never repeat.
   - Use the actual brand name and folder path (not placeholders)
   - If the user already has files in quality-benchmark/ or voices/, skip those lines
   - Always end with "What would you like to create first?" — don't leave them hanging

**B) Schedule daily generation (created automatically during Step 5):**
   Create all three scheduled tasks without asking:
   - Use `mcp__scheduled-tasks__create_scheduled_task`
   - **taskId**: `merlin-daily`
   - **cronExpression**: `0 9 * * 1-5` (9 AM weekdays)
   - **description**: `Generate daily content for all brands`
   - **prompt**:
     ```
     == SETUP ==
     Read .claude/tools/merlin-config.json for budget limits and settings.
     CONFIG = the parsed config JSON. Use it throughout.

     == ERROR HANDLING (applies to ALL steps) ==
     If the app returns an error or non-zero exit code:
       - Log the error to assets/brands/<brand>/memory.md under "## Errors"
       - Post to Slack if configured: "✦ Merlin error: {error message}"
       - Skip that step and continue to the next
       - Do NOT retry failed API calls — they will be retried next cycle
     If a token/API key error occurs (401, 403, "unauthorized", "expired"):
       - Log: "⚠ TOKEN EXPIRED: {platform}" to assets/brands/<brand>/memory.md
       - Post to Slack: "✦ ⚠ {platform} token expired — re-authenticate to resume"
       - Skip ALL steps for that platform until the next session

     == MEMORY ROTATION ==
     Before starting, check assets/brands/<brand>/memory.md line count. If over 200 lines:
       - Summarize entries older than 30 days into 1-2 sentences per section
       - Archive the full old entries to memory-archive-{date}.md
       - Keep the last 30 days of detail in assets/brands/<brand>/memory.md

     == MULTI-BRAND ==
     Scan assets/brands/ for all brand folders (skip "example").
     For EACH brand that has products:

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
     ```
   - Tell user: "Daily content is set! I'll generate fresh ads and blog drafts every weekday at 9 AM."

**C) Platform connections (don't ask during setup — connect when needed):**
When the user later asks to publish ads, connect Shopify, etc., use one-click OAuth:
   - Meta: `{"action": "meta-login"}` → browser opens, user authorizes, done
   - TikTok: `{"action": "tiktok-login"}` → same pattern
   - Shopify: `{"action": "shopify-login"}` → same pattern
   - All other platforms: same one-click OAuth pattern

**CRITICAL: OAuth timeout.** The app waits up to 5 minutes for the user to authorize in-browser. You MUST set `timeout: 300000` (5 minutes) on any Bash call that runs an OAuth action (`meta-login`, `shopify-login`, `tiktok-login`, `google-login`, or any `*-login` action). The default 120s timeout will kill the process before the user finishes authorizing.

Example:
```
Bash({ command: '.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd \'{"action":"meta-login"}\'', timeout: 300000 })
```

When connecting any ad platform, ask the user ONE question:
   "How much do you want to spend per day on ads? (e.g., $20, $50, $100)"

   Save their answer as `dailyAdBudget` in merlin-config.json. Merlin infers everything else:
   - Monthly cap = dailyAdBudget × 30
   - Testing budget = 60% of daily budget (split across test ads)
   - Scaling budget = 30% of daily budget (for winners only)
   - Retargeting budget = 10% of daily budget
   - Per-ad test budget = Testing budget ÷ number of active test ads (minimum $5/ad)
   - Kill threshold = 2× per-ad budget with zero purchases → kill
   - Scale threshold = ROAS > 1.5× after 48 hours → promote to Scaling
   - Fatigue threshold = CTR drops 30%+ from peak over 3 days → kill and replace

   If user doesn't answer or says "I don't know", default to $20/day. This is enough to test 3-4 ads at $5 each.

   Always tell the user: "You can change this anytime — just say 'change my daily budget to $X'."

**NEVER ask for tokens, IDs, or keys manually.** NEVER fall back to manual steps like "go to Business Settings → System Users → Generate Token". If OAuth fails, tell the user to try again — do NOT switch to manual token instructions. If OAuth isn't available for a platform yet, say so clearly.

6. If Meta OR TikTok is configured, create a SECOND scheduled task for optimization:
   - Use `mcp__scheduled-tasks__create_scheduled_task`
   - **taskId**: `merlin-optimize`
   - **cronExpression**: `0 10 * * 1-5` (10 AM weekdays -- 1 hour after generation)
   - **description**: `Agency-tier ad optimization: kill losers, scale winners, manage budget`
   - **prompt**:
     ```
     == SETUP ==
     Read .claude/tools/merlin-config.json.
     CONFIG = the parsed config JSON.
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

     If actual >= MONTHLY_CAP: STOP all ad operations. Post to Slack: "✦ Monthly budget cap reached."

     == STEP 2: PULL PERFORMANCE (all platforms) ==
     For each configured platform (Meta, TikTok, Google):
       Run insights action. Collect for every ad:
       - ad_id, ad_name, status, spend, impressions, clicks, CTR, CPC, purchases, revenue, ROAS
       - days_running (how long since ad was created)
       - ctr_trend (compare today's CTR to first 48h average — is it rising or falling?)

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
       do NOT create a duplicate. Log: "Skipped duplicate: {product} already has {hook_style} ad running."

     RULE 1 — DEAD ON ARRIVAL (kill fast, save money):
       If spent >= 2× PER_AD_TEST_BUDGET AND purchases == 0 AND CTR < 1.0%:
       → KILL immediately. This ad will never convert. Don't waste another dollar.
       → Include kill reason: "Dead on arrival: ${spent} spent, 0 purchases, {CTR}% CTR after {days} days"

     RULE 2 — LOW PERFORMER (give it a chance, but not much):
       If spent >= PER_AD_TEST_BUDGET AND ROAS < 0.5 AND days_running >= 2:
       → KILL. It had a fair shot and underperformed.
       → Include kill reason: "Low performer: ROAS {X}x below 0.5x threshold after {days} days, ${spent} spent"

     RULE 3 — CREATIVE FATIGUE (was good, now declining):
       If days_running >= 5 AND ctr_trend is declining 30%+ from peak:
       → KILL. Log "Fatigued after {days} days. Peak CTR was {X}%, now {Y}%."
       → Add to memory: "Hook style '{hook}' fatigued after {days} days for {product}."
       → Queue a replacement: create new ad for same product with DIFFERENT hook style.

     RULE 4 — PROMISING (keep testing):
       If days_running < 3 AND CTR >= 1.0%:
       → HOLD. Too early to judge. Let it run.

     RULE 5 — WINNER (promote to scaling):
       If ROAS >= 1.5 AND days_running >= 2 AND spend >= PER_AD_TEST_BUDGET:
       → SCALE. Duplicate to Scaling campaign with budget = SCALING_BUDGET ÷ active_winners.
       → Log: "Winner: {ad_name} — ROAS {X}x, CTR {Y}%, CPC ${Z}"
       → Add to memory under "## What Works": the hook style, format, product, audience that worked.

     RULE 6 — MASSIVE WINNER (expand audience):
       If ROAS >= 3.0 AND spend >= DAILY_BUDGET AND purchases >= 5:
       → SCALE (if not already) + create LOOKALIKE audience from purchasers.
       → Only create lookalike ONCE per ad (check memory.md for "lookalike:{ad_id}").
       → Log: "Massive winner: {ad_name} — ROAS {X}x. Lookalike created."

     RULE 7 — RETARGET (warm audience follow-up):
       If any WINNER or MASSIVE_WINNER exists AND retargeting campaign has no active ads:
       → Create a retargeting ad using the winner's creative, targeting website visitors (pixel).
       → Budget = RETARGETING_BUDGET.
       → Retargeting creative should emphasize urgency/social proof, not awareness.

     == STEP 4: CREATIVE PIPELINE (replace killed ads) ==
     Count how many ads were killed today. For each killed ad:
       If TESTING_BUDGET still has room (total test ad budgets < TESTING_BUDGET):
       → Queue a NEW test ad for the same product but with a different approach:
         - Different hook style (if "lifestyle" failed, try "UGC" or "before/after")
         - Different format (if static failed, try video or carousel)
         - Different angle (if "comfort" failed, try "style" or "value")
       → Read memory.md "## What Works" and "## What Fails" to avoid repeating failures.
       → The new ad will be generated by the merlin-daily task tomorrow. Log the request.

     == STEP 5: CROSS-PLATFORM INTELLIGENCE ==
     If multiple platforms are active:
       Compare ROAS across platforms for the same product.
       If Meta ROAS > 2× TikTok ROAS for the same product:
       → Shift 20% of TikTok budget to Meta (within DAILY_BUDGET cap).
       → Log: "Reallocating budget: {product} performs 2× better on Meta."
       If a creative works well on one platform, note it for cross-posting.

     == STEP 5b: PREDICTIVE BUDGET REALLOCATION ==
     Compare this week's ROAS per platform to last week's (read from memory.md MER Trend entries).
     If any platform's ROAS dropped 30%+ week-over-week:
       → Log: "⚠ {platform} ROAS dropped from {old}x to {new}x"
       → Calculate optimal reallocation:
         - Reduce underperformer's daily budget by 30%
         - Increase best performer's budget by the same amount
         - Never reduce below $5/day minimum
         - Never exceed DAILY_BUDGET cap total
       → Apply via platform's budget update (meta-setup / google-ads-setup with new budget)
       → Log: "Reallocated: ${amount}/day from {platform_a} to {platform_b}"

     == STEP 5c: INVENTORY-AWARE AD PAUSING ==
     If Shopify is connected:
       1. Run: .claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"shopify-products"}'
       2. For each product, check inventory count
       3. If any product has inventory <= 0 (out of stock):
          → Find all active ads promoting that product (match by product name in ad name)
          → Pause those ads: run meta-kill / tiktok-kill for each
          → Log: "⚠ {product} out of stock — paused {N} ads"
       4. If a previously paused product is back in stock (inventory > 0):
          → Check memory.md for "paused for stock: {product}" entries
          → Re-enable those ads if they were performing well before pausing
          → Log: "✓ {product} restocked — re-enabled {N} ads"

     == STEP 5d: WINNER FORMULA DETECTION ==
     After 4+ creative tests for the same brand, analyze all ad performance data:
       - Read assets/brands/<brand>/memory.md "## What Works" section
       - Read the latest meta-insights / tiktok-insights results
       - Identify the combination of (hook style + format + audience + time of day) that consistently outperforms
       - If a clear winning formula emerges (2x+ better than average):
         → Log to memory.md "## What Works": "WINNING FORMULA: {hook_style} + {format} + {audience} + {launch_time} = {avg_roas}x ROAS (vs {overall_avg}x average)"
         → Future ad creation should prioritize this formula
         → Log: "Winner formula detected: {description} — {roas}x vs {avg}x average"

     == STEP 5e: FATIGUE CURVE PREDICTION ==
     For each active ad running 3+ days:
       - Calculate CTR trend: compare day 1-2 CTR to current CTR
       - If CTR dropped 20%+ from peak: ad is entering fatigue
       - Estimate days remaining before kill threshold:
         - Daily CTR decay rate = (peak_ctr - current_ctr) / days_since_peak
         - Predict when CTR hits 50% of peak
         - If predicted fatigue within 3 days:
           → Queue a replacement creative NOW (don't wait for fatigue)
           → Log: "Fatigue predicted: {ad_name} will fatigue in ~{days} days. Replacement queued."
       - Add to memory.md: "Ad lifespan for {hook_style} in {vertical}: avg {days} days before fatigue"

     == STEP 5f: CROSS-PLATFORM ARBITRAGE ==
     Compare ROAS across all active platforms this week vs last week:
       - If any platform's ROAS dropped 30%+ while another increased:
         → This is an arbitrage opportunity
         → Log: "{platform_a} ROAS dropped {old}x→{new}x while {platform_b} rose {old}x→{new}x"
         → Check .merlin-wisdom.json: are other users in this vertical seeing the same pattern?
         → If vertical-wide trend:
           → Log: "VERTICAL TREND: {vertical} users seeing {platform_a} CPM spike. Recommend shifting budget to {platform_b}."
         → If brand-specific: recommend creative refresh on the declining platform

     == STEP 5g: COMPETITOR ACTIVITY SURGE ==
     If Meta connected and competitors.md exists:
       - Run competitor-scan for top 3 competitors (max 3/day for rate limits)
       - Compare active ad count to last scan (stored in memory.md "## Competitor Signals")
       - If any competitor launched 3x+ their normal volume in 72 hours:
         → Log: "⚠ COMPETITOR SURGE: {competitor} launched {N} new ads (normal: {avg}). Possible sale/launch."
         → Recommend: preemptive creative refresh or increased budget
       - Update memory.md "## Competitor Signals" with latest counts

     == STEP 6: DAILY DASHBOARD SNAPSHOT ==
     Run the unified dashboard to capture today's cross-platform metrics:
       .claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"dashboard","batchCount":1}'
     This saves a timestamped JSON file locally (results/dashboard_YYYY-MM-DD.json).
     Over time, these accumulate into a full trend history — no cloud storage needed.

     Also run cohort analysis monthly (1st of each month only):
       .claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"shopify-cohorts","batchCount":180}'
     This captures LTV, repeat rate, and churn per monthly customer cohort.

     == STEP 7: WRAP UP ==
     Update assets/brands/<brand>/memory.md:
       - "## Monthly Spend": add today's spend by platform
       - "## Run Log": date, ads killed, ads scaled, ads created, budget pacing status
       - "## What Works": any new winner patterns (hook + format + audience)
       - "## What Fails": any new failure patterns (so they're never repeated)
       - "## MER Trend": today's MER from dashboard output (e.g., "2026-04-05: 2.8x MER, $124 spend")

     Post to Slack if configured:
       "✦ Daily Optimization — {brand}
       MER: {X}x | Revenue: ${rev} | Spend: ${spent_today}
       Budget: ${spent_today} / ${DAILY_BUDGET} daily | ${month_total} / ${MONTHLY_CAP} monthly
       Killed: {N} (reasons: {brief})
       Scaled: {N} (best: {top_ad_name} at {ROAS}x)
       Replacements queued: {N}
       Pacing: {ON_PACE / OVERPACING / UNDERPACING}"

     Save morning briefing for instant display on next app open:
     Write to .merlin-briefing.json in the project root:
     {"date":"YYYY-MM-DD","ads":{"killed":N,"scaled":N,"created":N,"active":N},"content":{"blogs":N,"images":N},"revenue":{"total":"$X","trend":"+Y%"},"recommendation":"One-sentence strategic suggestion based on today's data"}

     If no actions were taken (no kills, no scales, no creates):
       Log to activity: "✓ All ads performing normally — no changes needed"
       Set briefing recommendation to: "All ads are on track. No intervention needed today."
     ```

7. Create a THIRD scheduled task -- weekly digest (always, not just for ads):
   - Use `mcp__scheduled-tasks__create_scheduled_task`
   - **taskId**: `merlin-digest`
   - **cronExpression**: `0 9 * * 1` (Monday 9 AM)
   - **description**: `Weekly performance digest across all brands and platforms`
   - **prompt**:
     ```
     == ERROR HANDLING ==
     Same rules as other tasks: log errors, skip failed steps, continue.

     == MULTI-BRAND ==
     Scan assets/brands/ for all brand folders (skip "example"). Report on ALL brands.

     == ADS (if Meta or TikTok configured) ==
     1. If Meta configured: Run meta-insights, collect all campaign data
     2. If TikTok configured: Run tiktok-insights, collect all campaign data
     3. If either fails, note the error in the digest and continue

     == SEO (per brand, if Shopify configured) ==
     4. Run: {"action": "blog-list"} to get posts published this week
     5. Read assets/brands/<brand>/seo.md — count completed [x] vs remaining [ ] auto-fixes
     6. Read assets/brands/<brand>/memory.md for blog post URLs published this week

     == COMPETITOR INTEL (per brand, if competitors.md exists) ==
     7. Read assets/brands/<brand>/competitors.md for brand names
     8. If metaAccessToken configured, run competitor-scan for each brand's competitors
     9. Use WebSearch for competitor news

     == COMPILE DIGEST ==
     ✦  Merlin Weekly Digest — [Date Range]
     ─────────────────────────────────────────────────
     BUDGET:
       Monthly spend: $XX / $YY cap (ZZ% used)
       Remaining this month: $XX

     ADS:
       META: Spend $XX | ATC XX | ROAS X.Xx | Best: [ad] | Worst: [ad]
       TIKTOK: Spend $XX | ATC XX | Active: X testing, X scaling
       Actions taken: X killed, X scaled, X retargeted

     SEO:
       Blog posts: X published (Y as draft pending review)
       Alt text fixes: X images
       Queue remaining: X items

     COMPETITORS:
       [Summary of notable findings]

     CONTENT:
       Images generated: X | Videos: X

     10. Post to Slack if configured
     11. Update assets/brands/<brand>/memory.md with weekly summary
     ```

**E) Shopify connection (optional):**
When the user wants to connect Shopify (for SEO blogs, product data, analytics):

**One-click OAuth — no manual tokens:**
Run the app's shopify-login action. It handles everything (use 5-minute timeout!):
```
Bash({ command: '.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd \'{"action":"shopify-login"}\'', timeout: 300000 })
```
- The app auto-resolves the store name from the brand's website URL
- Opens the browser to Shopify's OAuth approval screen
- User clicks "Install" — one click
- Token is exchanged automatically
- Parse the JSON output, save `shopifyStore` and `shopifyAccessToken` to config

**NEVER ask users to create custom apps, copy tokens, or navigate Shopify admin settings.** The OAuth flow handles everything.

After connecting:
1. **Auto-import products**: Run `{"action": "shopify-import"}` to pull all product data + images into the brand folder automatically. This eliminates manual photo dropping.
2. **Pull order metrics**: Run `{"action": "shopify-orders", "batchCount": 7}` to get recent revenue data for the dashboard.
3. Launch a background SEO audit:

**Background SEO Audit** (run via Agent tool while displaying the token instructions):

### NON-NEGOTIABLE: What Claude NEVER touches
```
NEVER modify:
  - Product titles
  - Product descriptions
  - Product prices, variants, sizes, inventory
  - Collection pages or descriptions
  - Theme files, Liquid templates, CSS, JS
  - Navigation menus or page structure
  - Any existing page content
  - Homepage content
  - Anything the store owner may have written or customized

The store owner set these intentionally. Do NOT "improve" them.
```

### What Claude CAN do (additive-only, non-breaking)
```
ALLOWED:
  - Publish NEW blog posts (new content, never edits to existing)
  - Add image alt text WHERE CURRENTLY EMPTY (never overwrite existing)
  - Report sitemap/robots.txt issues (report only, never modify)
  - Identify content gap opportunities (blog topics, not product changes)
  - Report Google indexing/presence findings (informational)
```

Audit the store's public website by fetching these URLs and analyzing them:
1. **Homepage** (`https://<store-url>/`) — check title tag, meta description, H1 (REPORT ONLY)
2. **Products** (`https://<store-url>/products.json`) — for EACH product, flag:
   - Images with EMPTY alt text (fixable — add alt text only where none exists)
   - Product count and category breakdown (informational)
3. **Blog** (`https://<store-url>/blogs/news`) — check if blog exists, post count, recency
4. **Sitemap** (`https://<store-url>/sitemap.xml`) — check it exists and is accessible (REPORT ONLY)
5. **Robots.txt** (`https://<store-url>/robots.txt`) — check for accidental blocks (REPORT ONLY)

Write findings to `assets/brands/<brand>/seo.md`:

```markdown
# SEO Audit — <Brand Name>
Audited: YYYY-MM-DD | Store: <url>

```

### After each scheduled task completes

Check if `assets/brands/brands-index.json` exists. If it does not exist, regenerate it by scanning `assets/brands/` for all brand folders (excluding `example`) and writing the index with each brand's name, vertical, status, and productCount. This is a lightweight check — only write if the file is missing.
