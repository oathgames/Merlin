---
name: merlin-social
description: Use when the user wants Discord notifications, Slack posts, email marketing (Klaviyo audit, campaign creation, cold outbound, flows, deliverability, RFM segmentation), SMS marketing (Postscript/Attentive/Klaviyo SMS, TCPA compliance, A2P 10DLC, flows, campaign cadence), Reddit organic prospecting/drafting/posting, Threads posts, competitor ad intelligence via Meta Ad Library, or any non-paid social/community channel. Covers the 6 essential DTC email flows with revenue-mix benchmarks, post-Apple-MPP engagement benchmarks (click rate as real signal), RFM segmentation, deliverability basics (SPF/DKIM/DMARC, Google/Yahoo 2024 requirements), subject + preheader rules, SMS compliance (TCPA quiet hours, 10DLC, STOP keywords) + essential SMS flows + campaign cadence, first-touch/linear/time-decay attribution models, Reddit's 7-layer compliance preflight, and the weekly competitor ad scan with hook extraction.
owner: ryan
bytes_justification: 19KB — owned channels (email + SMS + Reddit organic + competitor intel) share attribution models, compliance requirements, and deliverability/cadence reasoning. Splitting email and SMS into separate skills would duplicate the RFM segmentation, attribution, and benchmark tables; SMS flows mirror email flows by design so they belong side-by-side. The Klaviyo template-bulk-upload routing block lives here (not in merlin-content) because it's about pushing prepared HTMLs into the email backend, not authoring creative — pairing it with email flows + RFM benchmarks keeps the agent on a single mental model. Hard-capped at 25KB.
---

# Owned & Earned Channels

## Discord (`mcp__merlin__discord`)

| Action | Key params |
|---|---|
| `setup` | (changes channel) |
| `post` | `slackMessage` (reused field name) |

**Connect:** `platform_login({platform: "discord"})` — opens Discord's bot authorization, user picks server, bot auto-discovers text channels.

**Auto-posts:** When Discord is connected, Merlin posts automatically when ads are published, paused, scaled, or new creatives generated. No manual trigger needed for these.

## Email Marketing (`mcp__merlin__email`)

| Action | Key params |
|---|---|
| `audit` | `brand` — existing flows, lists, campaigns, missing essentials, recommendations |
| `revenue` | `brand` — attribution-based revenue per flow |

If Klaviyo isn't connected, tell the user to click the Klaviyo tile or paste an API key.

### Attribution models — always state which one

| Model | Use for |
|---|---|
| **First-touch** | "Which channel brought them in" — 100% credit to the first email that touched the buyer |
| **Linear** | Nurture-heavy journeys where every touch mattered — equal credit across every touch |
| **Time-decay** | **Default for per-flow ROI** — half-life 7 days, recent touches weighted higher |

Never mix models in the same report. "Is welcome series working?" → time-decay. "Is email worth investing in?" → first-touch.

### Essential DTC email flows (+ revenue mix benchmarks)

Healthy flow revenue mix (% of total email revenue, Klaviyo aggregated DTC data):

| # | Flow | Structure | Share of flow rev |
|---|---|---|---|
| 1 | **Welcome Series** | 3 emails / 5 days: welcome + brand story → bestsellers → social proof + first-purchase offer | 5–10% |
| 2 | **Abandoned Cart** | 3 emails: reminder (1hr) → social proof (24hr) → urgency/discount (48hr) | 15–25% ← largest flow |
| 3 | **Browse Abandonment** | 2 emails: "Still looking?" (4hr) → related products (24hr) | 3–5% |
| 4 | **Post-Purchase** | 3 emails: thank you → how to use → review request (14d) | 5–10% |
| 5 | **Win-back** | 3 emails: "We miss you" (60d) → bestsellers (75d) → final discount (90d) | 3–5% |
| 6 | **Sunset** | 2 emails: "Still interested?" (90d no opens) → final chance (120d) | <1% — purpose is deliverability, not revenue |

Campaigns (one-to-many sends) should contribute 40–55% of email revenue; flows 45–55%. Over-reliance on campaigns means automated money is being left on the table.

### Engagement benchmarks (post-Apple MPP — click rate is the real signal)

**Warm list:** 25–35% open / 2–3% click / <0.3% unsubscribe. Since Apple Mail Privacy Protection, opens auto-inflate — **use click rate as the real engagement signal.**

**Cold outbound (B2B):** 50%+ open / 3%+ reply / 1%+ positive reply. Diagnostic order: opens → subject + sender + preheader; replies → body + CTA; positive replies → ICP + offer.

**Diagnostic order (warm list):** opens → envelope (subject + sender + preheader); clicks → body + CTA; unsubs → list hygiene or send frequency.

### List segmentation — RFM (Recency, Frequency, Monetary)

Segment before every send. Blasting every campaign to the full list is the fastest way to tank deliverability.

- **Engaged-30** — opened OR clicked in last 30 days → primary campaign segment
- **Engaged-90** — engaged in last 90 days → secondary segment, lower frequency
- **VIP** — top 10% lifetime spend → exclusive previews, early access, higher frequency OK
- **At-risk** — engaged 91–180 days ago → move to win-back flow
- **Dormant / Sunset** — no engagement 180+ days → suppress from campaigns, sunset flow only
- **Recent purchasers (90 days)** — suppress from new-customer acquisition offers (avoid promo resentment)

### Send cadence

- **Newly subscribed (0–14 days):** welcome flow only; no campaigns.
- **Engaged list:** 2–4 campaigns per week; drop to 1 during poor engagement windows.
- **Re-engagement:** 1 campaign every 2 weeks until they engage or hit sunset threshold.
- **Never send twice in 24h** without a compelling reason.

### Deliverability (non-negotiable basics)

- **Authentication:** SPF, DKIM, and **DMARC with `p=quarantine` minimum** (Google/Yahoo require DMARC since Feb 2024 for bulk senders). Verify via MXToolbox / Google Postmaster Tools monthly.
- **Dedicated sending subdomain:** send from `mail.brand.com`, not `brand.com` — protects the root if reputation dips.
- **Warm-up new IPs/domains:** first 30 days, send only to Engaged-30, ramp volume 25% daily.
- **List hygiene:** remove hard bounces immediately; remove 3× soft bounces; never buy lists.
- **Complaint rate target:** <0.1%. At 0.3% Gmail throttles; at 0.5% you're flagged.
- **Google Postmaster Tools:** register and monitor weekly — Gmail is ~45% of US inbox.

### Subject line + preheader (free real estate)

- **Subject line:** 30–50 chars (mobile-first). Question / specific number / curiosity gap beats clever pun. A/B test at least one element per send if list >10k.
- **Preheader:** 40–100 chars; never auto-pulled from body. Complements the subject, doesn't repeat it.
- **Sender name:** first-name-from-brand ("Ryan at Merlin") beats corporate ("Merlin Team") on warm lists. Keep consistent.

### Email template rules

- 600px wide (Klaviyo standard). Table-based HTML with inline styles.
- Use the real logo PNG (`logo/logo.png`), never AI-generated text.
- Use real product photos from Shopify CDN, never AI-generated product shots.
- Brand colors are exact hex codes from `brand.md` → Brand Colors section.
- **Dark-mode preview** — test in both light and dark Gmail; transparent-background logos fail on dark backgrounds.
- **Plain-text alternative** — every HTML email needs a plain-text MIME part; missing one drops inbox placement.

## SMS Marketing

SMS drives 10–20% of revenue for DTC brands with SMS live (Postscript / Attentive / Klaviyo SMS published data). Zero SMS is a real revenue gap. Connect via Klaviyo SMS (if Klaviyo is the ESP) or recommend Postscript / Attentive as specialty platforms.

### Compliance (TCPA US + CTIA carriers) — blocking requirements

- **Express written consent** before the first message. Collect via: checkout checkbox (separate from email opt-in, NEVER pre-checked), SMS keyword opt-in (`TEXT SHOP TO 12345`), pop-up with TCPA disclosure.
- **Disclosure text at opt-in** must include: brand name, "consent not required for purchase," message frequency ("4 msgs/mo"), "Msg & data rates may apply," "Reply STOP to unsubscribe / HELP for help," link to terms + privacy.
- **STOP / UNSUBSCRIBE / CANCEL / END / QUIT / OPT OUT** must all work — handled automatically by Postscript/Attentive/Klaviyo. Honor within 24h.
- **Quiet hours:** send only 8am–9pm in the recipient's local timezone. Schedules must be TZ-aware.
- **A2P 10DLC registration** required since 2023 for US SMS. Unregistered brands get throttled or blocked. Handled by the SMS platform but must be completed during setup.
- **Toll-free numbers** require verification and have stricter content rules; short codes (5–6 digits) have highest throughput, highest cost.

### Essential SMS flows (mirror email, not duplicate)

| # | Flow | Structure | Share of SMS flow rev |
|---|---|---|---|
| 1 | **Welcome** | 2 msgs / 3 days: welcome + offer → reminder if unused | 10–15% |
| 2 | **Abandoned Cart** | 2 msgs: 30min reminder → 24hr urgency | 30–40% ← largest |
| 3 | **Browse Abandonment** | 1 msg: 2hr "Still looking?" | 5–10% |
| 4 | **Post-Purchase** | 2 msgs: shipping update → review request 14d | 5–10% |
| 5 | **Back-in-stock** | 1 msg on restock | 5–10% |
| 6 | **Win-back** | 1 msg at 60d + 1 at 90d | 3–5% |

### SMS campaigns

- **Frequency:** 4–8 campaigns per month max. SMS is high-intimacy; over-sending nukes the list.
- **Length:** stay under 160 chars (1 segment) when possible — each segment costs. Hook, first name, 1 link, 1 CTA.
- **MMS** (with image) lifts CTR 25–50% but costs 3–4× per segment. Reserve for launches and hero campaigns.
- **Link handling:** always use the platform's branded short-link (`short.brandname.co`) — bit.ly is flagged as carrier spam.
- **Send timing:** 10am–12pm and 3pm–6pm local TZ perform best for DTC. Avoid Mondays (inbox pile-up) and Friday evenings.
- **Personalization:** first name + product name + order detail. Generic SMS ("Shop now!") underperforms personalized 2–3×.

### SMS-specific metrics

- **CTR** healthy: 5–15% (vs email's 1–3%) — SMS intent is much higher.
- **Unsubscribe per send:** <2% healthy; >3% = message is off (segment, offer, or frequency).
- **Revenue per recipient:** $0.50–$2.00 per send for DTC.
- **Click-to-conversion** should beat email — if it doesn't, the landing page isn't mobile-ready (see `merlin-analytics`).

## Klaviyo (`mcp__merlin__klaviyo`)

`performance` · `lists` · `campaigns` · `templates-list` · `template-get` · `template-create` · `template-update` · `template-delete` · `templates-bulk-upload`

**Review solicitation pattern** (daily scheduled task): find fulfilled orders 5–7 days old (via `shopify-orders`), draft a Klaviyo campaign per order (max 3/day to avoid spam): product photo + "How are you liking your {product}?" + review link. Publish as draft — user or `merlin-optimize` approves.

### Template bulk upload

When the user says any of: *"upload my email templates"*, *"import these HTMLs to Klaviyo"*, *"bulk upload my welcome flow"*, *"push these emails to Klaviyo"*, *"I have N email HTMLs to upload"* → call `klaviyo({action: "templates-bulk-upload", brand: "<brand>", dir: "<path>", nameTemplate: "<brand> / <flow> / {basename}", applyTokens: true})`.

**Always confirm the directory and the count** before running. The directory MUST be inside `assets/brands/<brand>/` — paths outside are rejected by the binary. `nameTemplate` substitutes `{basename}` with each file's stem; if omitted, the bare basename is used. `applyTokens` defaults to `true` and translates generic placeholders (`{{UNSUB_URL}}` → `{{ unsubscribe }}`, `{{ FIRST_NAME }}` → `{{ first_name|default:'there' }}`, `{{ EMAIL }}` → `{{ person.email }}`, `{{COMPANY_NAME}}` / `{{COMPANY_ADDRESS}}` from `brand.md`); set `applyTokens: false` if the HTML was already authored against Klaviyo's Django syntax.

The response is a structured envelope `{total, succeeded, failed, perFile: [{filename, name, templateId | error}]}`. Report exact counts to the user — *"uploaded 49 of 51, failed: welcome-3.html (422), abandoned-7.html (422)"* — never paraphrase. Do NOT confabulate template IDs that the binary did not return.

**Flow construction is UI-only.** After a successful bulk upload, surface this manual step verbatim:

> "Your N templates uploaded. Klaviyo Flows themselves still need to be wired in Klaviyo's UI — flow construction (trigger, branches, time delays, message slot wiring) isn't in the public API. Open Klaviyo → Flows → New Flow → pick the trigger → Use Existing Templates and select from the names you just uploaded."

Do NOT tell the user "I created your flows" — the API does not expose flow construction as of revision 2024-10-15. Flow read + status toggle is supported (already in `klaviyoActivateFlow`); flow create + branch wiring is not.

## Reddit Organic

Organic-growth pipeline for finding pain-point threads, clustering them, drafting quality-gated replies, and (optionally) posting under heavy compliance preflight. Same OAuth + `redditAccessToken` as Reddit Ads.

| Action | Purpose | Key params |
|---|---|---|
| `reddit-prospect-scan` | Search Reddit for relevant threads | `brand`, `keywords`, `subreddits` (comma list or blank = sitewide), `scanLimit` |
| `reddit-prospect-draft` | Cluster pain points + draft quality-gated replies | `brand`, `keywords`, `subreddits`, `draftLimit`, `draftDryRun` |
| `reddit-prospect-post` | Submit ONE approved reply | `brand`, `threadId`, `subreddit`, `draftBody`, `approved: true` |
| `reddit-shadowban-check` | Authed /me vs unauth /user probe | `brand` |

### Quality gate (`reddit-prospect-draft`)

Every draft passes through:
1. **Structural gate** — 40–300 words, no banned self-promo phrases, no shouting, no URLs unless sub allows, must reference at least one thread-content token.
2. **Optional AI gate** — Gemini scores authenticity/helpfulness/thread-fit/compliance/overall; fails closed on network error.

Drafts below threshold are dropped, not surfaced.

### Compliance preflight (`reddit-prospect-post`, auto mode)

7 layers before `/api/comment`:
1. Account ≥30 days old
2. Combined karma ≥100
3. Max 5 posts / 24h
4. ≥120 min between posts to same subreddit
5. ≥300s between any two posts
6. Body not posted in last 72h (SHA-256 of normalized body)
7. No cached shadowban

Any block writes a `reddit_posts_<ts>.json` envelope with a friendly reason.

### `redditPostMode` config

| Value | Behavior |
|---|---|
| `"auto"` (default) | Full preflight → `/api/comment`. Gated on account age/karma/shadowban. |
| `"draft-only"` | Skip preflight + write. Reply saved to `results/reddit_draft_<ts>.txt` for manual paste. Zero shadowban risk, zero API writes. The legitimate path for fresh accounts / warm-up / shadowban recovery. |

When `auto` blocks on account-age / karma / shadowban, Merlin **saves the draft to disk anyway** as a fallback and surfaces `suggestion` hinting to switch to `draft-only`. When `auto` blocks on cadence or dedup (real spam signals), the draft is NOT saved — user waits or rewrites.

### Approval model

Every `reddit-prospect-post` surfaces an Electron approval card with sub + reply preview (200 chars). `approved: true` in the cmd envelope is defense-in-depth — the binary refuses to proceed without it.

## Threads (`mcp__merlin__threads`)

Connect via `platform_login({platform: "threads"})`. Post via threads action. Rate-limited separately from Meta Ads.

## Competitor Intelligence

### Discovery (onboarding + weekly digest)

**Step 1 — Infer from brand.** Read `brand.md` + product catalog → niche → WebSearch:
- `"<niche> brand" site:shopify.com`
- `"<category>" -[brand name]`
- Related brands on Instagram/TikTok in same niche

Find 5–8 competitors. For each: name, URL, product overlap, price range (cheaper / same / premium).

**Step 2 — Save to `assets/brands/<brand>/competitors.md`:**

```markdown
# Competitors — <Brand Name>
Discovered: YYYY-MM-DD

## Direct (same niche + price)
- **<Brand>** — <url> — <category>, $X-$Y

## Adjacent (overlapping audience)
- **<Brand>** — <url> — <category>, $X-$Y

## Aspirational (where the brand could grow toward)
- **<Brand>** — <url> — <category>, $X-$Y
```

**Step 3 — Weekly Ad Scan** (if `metaAccessToken` configured):

```json
{"action": "competitor-scan", "blogBody": "Madhappy,Pangaia,Teddy Fresh", "imageCount": 5}
```

Queries Meta Ad Library (UK/EU transparency — most US DTC brands run there too). Returns: `ad_creative_bodies`, `ad_creative_link_titles`, CTA captions, snapshot URL, publisher platforms.

Then:
1. Read each ad's copy → extract hooks, CTAs, offers.
2. WebFetch snapshot URLs to describe the visual creative.
3. Compare to recent ads.
4. Log insights to `memory.md` under `## Competitor Signals`.

**No Meta token** → fall back to WebSearch for competitor news.

**Limit:** Ad Library returns only ads that ran in UK/EU. Purely domestic US brands won't appear. Rate limit: 200 calls/hour.

### What to look for

- **Hook patterns**: "POV:", "Wait till you see...", "This changed everything"
- **Format trends**: video vs static, UGC vs polished, length
- **Script style**: conversational or scripted (read transcriptions)
- **Offer patterns**: free shipping, % off, BOGO, bundles
- **Running duration**: ads running 30+ days are proven winners — study these closely
- **New products**: anything we haven't seen before

### How this feeds back

- Heavy competitor video testimonials → try talking-head mode (route to `merlin-content`)
- Competitors running sales → consider value-focused angle instead of discounting
- Trending hook style → adapt for our brand voice
- Long-running competitor ads → reference their structure in our scripts
- Save winning patterns to `memory.md ## Competitor Signals`

## Slack

### Slack File Upload — 3-step (the ONLY method that works)

1. `GET https://slack.com/api/files.getUploadURLExternal?filename=X&length=Y` (query params, NOT JSON body)
2. `POST` raw file bytes to returned `upload_url`
3. `POST https://slack.com/api/files.completeUploadExternal` with JSON: `{files: [{id, title}], channel_id, initial_comment}`

`files.upload` and `files.uploadV2` are deprecated and will fail.

### Bot scopes

`channels:read`, `channels:join`, `files:read`, `files:write`, `chat:write`. `files:write` alone will upload but silently fail to share to channels.

### Posting rules

Post to both Slack + Discord if both configured. Activity notifications (ad published, killed, scaled) are automatic.

## Routing hints

- "connect discord" / "set up discord" / "discord channel" → `platform_login({platform: "discord"})`
- "email flows" / "klaviyo" / "welcome series" / "abandoned cart" → `email({action: "audit"})`
- "upload my email templates" / "import these HTMLs to klaviyo" / "bulk upload emails" → `klaviyo({action: "templates-bulk-upload", brand, dir, nameTemplate})` (confirm dir + count first; surface the "Flows are UI-only" note after success)
- "scan competitors" / "what are competitors running" → `competitor-scan` + Ad Library process
- "reply on reddit" / "post to reddit organically" → Reddit organic pipeline
- "post to slack" / "share to team" → Slack 3-step upload or `chat.postMessage`
