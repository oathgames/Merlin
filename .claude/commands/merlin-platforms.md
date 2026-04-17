## Discord

When the user says "connect Discord", "set up Discord", or anything Discord-related:

### Connect Discord
```
mcp__merlin__platform_login({platform: "discord"})
```
Opens browser to Discord's bot authorization page. User selects which server to add Merlin to. Bot auto-discovers text channels.

### Change Channel
```
mcp__merlin__discord({action: "setup"})
```

### Send a Message
```
mcp__merlin__discord({action: "post", slackMessage: "Your message here"})
```

### Automatic Discord Notifications
When Discord is connected, Merlin automatically posts when:
- Ads are published (Meta, TikTok, Google, Amazon)
- Ads are paused or scaled
- New creatives are generated

---

## Email Marketing

When the user says "audit my email", "check email flows", "email performance":

### Email Audit
```
mcp__merlin__email({action: "audit", brand: "X"})
```

Returns: existing flows, lists, campaigns, missing essential flows, recommendations.

### Email Revenue Attribution
```
mcp__merlin__email({action: "revenue", brand: "X"})
```

If Klaviyo isn't connected, tell the user to click the Klaviyo tile (coming soon) or paste their API key.

**Attribution model picker** — always state which model you're reporting:
- **First-touch** — 100% credit to the first email that touched the buyer. Use when answering "which channel brought them in."
- **Linear** — equal credit across every touch. Use for nurture-heavy journeys where every touch mattered.
- **Time-decay** — half-life 7 days, recent touches weighted higher. Default for per-flow ROI — most accurate for individual flow performance.

Never mix models in the same report. If the user asks "is welcome series working," use time-decay. If they ask "is email worth investing in," use first-touch.

### Cold Outbound Benchmarks

When auditing or recommending cold email, anchor on these targets:
- **40%+ open rate** — below this, subject line or sender reputation is broken
- **3%+ reply rate** — below this, body copy or CTA is off
- **1%+ positive reply rate** — below this, ICP or offer is wrong

Warm list (existing subscribers): 35% open / 2% click / <0.5% unsubscribe. Diagnose in that order — opens point to top of envelope, clicks point to body, unsubs point to list hygiene or send frequency.

### Essential DTC Email Flows
These 6 flows are the foundation:

1. **Welcome Series** (3 emails over 5 days): Welcome + brand story → bestsellers showcase → social proof + first-purchase discount
2. **Abandoned Cart** (3 emails): Reminder (1hr) → social proof (24hr) → urgency/discount (48hr)
3. **Browse Abandonment** (2 emails): "Still looking?" (4hr) → related products (24hr)
4. **Post-Purchase** (3 emails): Thank you + order details → how to use/style → review request (14 days)
5. **Win-back** (3 emails): "We miss you" (60 days) → bestsellers update (75 days) → final discount (90 days)
6. **Sunset** (2 emails): "Still interested?" (90 days no opens) → final chance before suppression (120 days)

## Google Ads

### Connect Google Ads
```
mcp__merlin__platform_login({platform: "google", brand: "X"})
```
Opens Google OAuth in browser. User authorizes. Token + customer ID saved automatically.

### Campaign Setup
```
mcp__merlin__google_ads({action: "setup", brand: "X"})
```
Creates "Merlin - Testing" ($5/day) and "Merlin - Scaling" ($20/day) Performance Max campaigns.

### Publish Ads
```
mcp__merlin__google_ads({action: "push", brand: "X", adImagePath: "results/image.png", adHeadline: "Shop Now|Free Shipping", adBody: "Premium quality", adLink: "https://example.com", dailyBudget: 5})
```

### Performance Review
```
mcp__merlin__google_ads({action: "insights", brand: "X"})
```

### Kill / Scale
```
mcp__merlin__google_ads({action: "kill", brand: "X", campaignId: "12345"})
mcp__merlin__google_ads({action: "duplicate", brand: "X", campaignId: "12345"})
```

## Amazon (Ads + Seller)

### Connect Amazon
```
mcp__merlin__platform_login({platform: "amazon", brand: "X"})
```

### Campaign Setup
```
mcp__merlin__amazon_ads({action: "setup", brand: "X"})
```

### Publish Ads
```
mcp__merlin__amazon_ads({action: "push", brand: "X", campaignId: "...", adGroupName: "SP - Product", keywords: ["keyword1"], defaultBid: 0.75})
```

### Performance / Kill
```
mcp__merlin__amazon_ads({action: "insights", brand: "X"})
mcp__merlin__amazon_ads({action: "kill", brand: "X", campaignId: "..."})
```

### Products & Orders
```
mcp__merlin__amazon_ads({action: "products", brand: "X"})
mcp__merlin__amazon_ads({action: "orders", brand: "X", batchCount: 7})
```

## Marketing Calendar

When the user asks about "marketing calendar", "launch schedule", or content planning:
```
mcp__merlin__dashboard({action: "calendar", brand: "X"})
```
Returns: launch history, average cadence, seasonal signals, and gaps.

---

## HeyGen Video Agent (one-shot prompt → video)

When the user says "make a video from a prompt", "generate a video about X", "quick HeyGen video", or any one-shot video request that doesn't need a custom script/avatar flow:

### Generate
```
mcp__merlin__video({action: "heygen-agent", prompt: "30s demo of our skincare line, warm tones, upbeat"})
```

HeyGen's Video Agent API (`POST /v3/video-agents`) auto-selects avatar, voice, and style from a natural-language prompt. No manual script, no timeline. Output lands in `results/video/YYYY-MM/<brand>/ad_<runID>/video.mp4` (same layout as fal/veo/heygen).

### Optional overrides (all optional — omit to let HeyGen auto-select)
- `avatarId` — specific HeyGen avatar ID (use `list-avatars` to browse)
- `voiceId` — specific voice ID
- `styleId` — visual template from HeyGen's style catalog
- `orientation` — `"portrait"` or `"landscape"` (auto-derived from `format` if blank: `9:16` → portrait, `16:9`/`1:1` → landscape)
- `incognitoMode` — `true` to disable HeyGen session memory
- `callbackUrl` — webhook URL; when set, Merlin returns immediately after submission and HeyGen POSTs the finished video to this URL

### Requires
- `heygenApiKey` in config (same key as the existing `heygen` video action)
- Prompt length 1–10,000 characters

### How to pick between actions
- **`heygen-agent`** — user gives a natural-language idea; agent picks everything. Fastest path.
- **`heygen`** (existing) — user wants Avatar IV with a specific script + talking-head photo. More control, more config.
- **`fal` / `veo`** — non-avatar video (product showcase, kinetic, generative).

---

## Promotion Gate

Apply whenever Merlin would call something a "winner" or "loser" and act on it — moving ads from Testing → Scaling, killing creative, declaring an email subject winner, picking a landing page variant.

**Rule**: promote only if `p < 0.05` AND `lift ≥ 15%`. Both conditions. Either alone is noise.

**Test**: Mann-Whitney U (non-parametric, works with small samples, no normality assumption). Bootstrap confidence interval for the lift with 1,000 resamples.

**Minimum samples per variant**:
- High-volume (Meta/Google main campaigns): **10 conversions** per variant
- Low-volume (email, retargeting, niche audiences): **30 conversions** per variant

Below threshold → verdict is "keep running, insufficient data" — never "loser."

**Trending band**: `p < 0.10` with ≥15% lift = watch, don't kill. Early read without false positives.

Merlin's internal verdicts (KILL / WINNER / MASSIVE WINNER) already bake in spend/CPA heuristics. The promotion gate is the statistical ceiling — if a verdict says WINNER but the gate hasn't cleared, report both: "flagged as winner by spend thresholds, but not yet statistically significant (p=0.14) — keep running before scaling."

## Copy Quality Gate

Before shipping any written output — ad copy, email body, blog post, landing headline, social post, thread — score it 0–100 against a 7-expert panel. Target ≥90. Max 3 revision rounds, then ship the best version with candid notes on remaining gaps.

**The 7 experts** (score each 0-100, then average):
1. Direct-response copywriter — does it sell?
2. Brand voice guardian — does it sound like this brand?
3. Conversion analyst — is the CTA single, specific, frictionless?
4. SEO strategist — keyword + intent match (skip for ad copy)
5. Skeptical founder — would the CEO approve this going out?
6. Audience persona match — does the target reader recognize themselves?
7. **AI-writing detector — weighted 1.5×.** AI-sounding copy is an automatic ship blocker regardless of other scores.

**Banned vocabulary** (−5 per instance, reject if ≥3 present): delve, tapestry, leverage, seamless, transformative, ecosystem, synergy, elevate, unlock, empower, journey (figurative), navigate (figurative), realm, landscape (figurative), harness, foster (figurative), testament, pivotal, paramount, crucial, bespoke (unless literally tailored), robust, comprehensive, holistic, meticulously, in today's fast-paced world, at the end of the day.

**Top humanizer patterns to reject**:
1. **Negation-definition**: "This isn't just X. It's Y." → rewrite as direct claim.
2. **Significance inflation**: "It's important to note that…" / "It's worth mentioning…" → cut.
3. **Tricolon clichés**: "faster, cheaper, better" → replace with one specific number.
4. **Em-dash decoration** when a comma or period would work.
5. **Hedged conclusions**: "ultimately," "in essence," "at the end of the day."
6. **Generic openers**: "In the ever-evolving world of…" → delete entire opener.

**Discipline**: scores must be honest. No padding to hit 90. Show every round's score in the output — iteration transparency is the value, not a clean final number. After 3 rounds, ship best version with a one-line note on what still isn't perfect.

## Conversion Rubric (Landing Pages)

When running `landing-audit` or auditing any conversion page, score 8 dimensions 0–100, weighted:

| Dimension | Weight | Check |
|---|---|---|
| Headline clarity | 15% | Stranger describes what it does in 5 seconds |
| CTA visibility | 15% | Above-fold, high contrast, action verb, one primary CTA |
| Social proof | 15% | Real names/logos/numbers — not "trusted by thousands" |
| Urgency | 10% | Specific scarcity ("28 left," "ends Friday") — not "limited time" |
| Trust signals | 10% | Guarantees, security badges, refund policy, real contact info |
| Form friction | 15% | Field count ≤ what's strictly required to fulfill |
| Mobile responsive | 10% | Tap targets ≥44px, no horizontal scroll, readable without zoom |
| Page speed | 10% | LCP <2.5s, CLS <0.1, hero image <200KB |

**Overall grade**: A (90+) / B (75–89) / C (60–74) / D (<60). Grade below B → fix before adding traffic. Never recommend scaling ad spend into a C/D page.

## SEO Rubric

When running `seo-audit`, `seo-keywords`, or `seo-gaps`, score keywords on two 0-10 axes, then prioritize by **Impact × Confidence**.

**Impact** factors: search volume, commercial CPC, buyer-intent level, trend velocity (YoY).
**Confidence** factors: keyword difficulty, current ranking position, domain authority match, content-gap size.

**Funnel classification** — tag every keyword:
- **BOFU** — buying signals: "agency," "services," "pricing," "best X," "X vs Y," "alternative to," "hire," "buy," "review," "near me"
- **MOFU** — research signals: "how to," "guide to," "X strategy," "X template," "X checklist," "case study"
- **TOFU** — awareness: "what is," "why does," pure informational, no buying signal

**Striking-distance band**: positions **4–20** in Google Search Console. These are the fastest wins — rank already exists, content already exists, small optimization often moves them into top 3. Prioritize over net-new keywords unless Impact×Confidence is materially higher.

**Cadence**:
- Full SEO brief — weekly
- Striking-distance check — daily (or before every content push)
- Trend scout — 2×/week
- Competitor gap analysis — monthly

## Content Scoring

For every generated blog, X/LinkedIn thread, short-form video script, social post, or newsletter section:

**Viral score = (Novelty × 0.4) + (Controversy × 0.3) + (Utility × 0.3)**, each factor 0–100.

- **Novelty** — is the angle fresh, or recycled take #47? Score harshly — most content is derivative.
- **Controversy** — is there a position someone could reasonably disagree with? Neutral = 0.
- **Utility** — can the reader do something concretely different tomorrow? Specifics raise the score.

**Thresholds**:
- ≥80 — publish with priority slot
- 60–79 — calendar filler, use when you need volume
- 40–59 — use sparingly, last option
- <40 — cut, don't ship

**Atomization** — every long-form source (blog, podcast, case study, call transcript, customer interview) produces 15–20 downstream assets:
- 3–5 short-form video clips with hooks + timestamps
- 2–3 X/LinkedIn threads (5–10 posts each, ≤280 chars per X post)
- 1 LinkedIn article (800–1,200 words, story-driven)
- 1 newsletter section with TL;DR + pull quotes
- 3–5 quote cards (≤20 words each, multi-platform sizes)
- 1 SEO blog outline with keyword research (apply SEO Rubric above)
- 1 Shorts/TikTok script with hooks + B-roll cues

**Dedup rule**: reject any asset with >70% semantic overlap vs. another asset in the same batch or vs. anything the brand published in the last 30 days. Check `results/` and memory's Run Log before generating.

---

## Content Quality (image + video prompts)

**Customers buy what they see in the ad. If the ad doesn't match the product, it's deceptive — non-negotiable.**

### Image Prompts

Before writing ANY image prompt:
1. **Read every reference photo** in the product's `references/` folder (use the Read tool).
2. **Describe ONLY what you see** — not what `brand.md` says, not what you imagine.
3. The app validates your description against reference images and rejects mismatches.

Pass the raw product description to the image action; the app's prompt pipeline layers camera settings, scene anchoring, and negative constraints automatically. Available models: `banana-pro-edit` (default), `banana-pro`, `banana-edit`, `imagen-ultra`, `ideogram`, `flux`. Omit `imageModel` unless the user explicitly requests one.

---

### Universal Creative Brief — the 7 locks (required for every image/video prompt)

Every S-tier prompt is a constraint pyramid — top-down specificity beats top-down creativity. Any prompt that ships without all 7 gets rejected at QA. Output order matters; write them in this order so the model reads constraints before content.

1. **Shell lock** — one opener line declaring: generation mode (`Pure text generation` vs `Image-to-video from reference`), aspect/format (`Vertical 9:16`, `Square 1:1`, `Landscape 16:9`), duration (`15-second seamless`), stylistic family (`handheld phone-camera UGC vlog`, `hero product cinematic`, `screen-recording SaaS demo`). No ambiguity. This line alone filters 80% of model drift.
2. **Subject lock** — who or what appears, with specific physical/SKU anchors, followed by the literal phrase **"same [subject] throughout — only [allowed variable] changes"**. For people: age range + skin tone + hair + build. For products: SKU name + color + material + packaging. Prevents face morphing and product swapping across beats.
3. **Beat blocking** — timestamped sections (`0–4s`, `5–9s`, `10–14s`, `15s`). Each beat specifies all of: setting, lighting, wardrobe/packaging state, camera framing, camera motion, subject action, subject emotion, voiceover (with emotion tag), ambient audio. Skip none. A beat missing lighting becomes a beat with random lighting.
4. **Evolution spec** (transformation ads only) — explicit `Stage 1 / Stage 2 / Stage 3` progression paragraph stating what visibly changes and by how much. Without this, day-to-day shots look identical. Use concrete visible deltas ("redness faint → reduced → gone"), not abstractions ("better").
5. **Camera grammar** — per-beat angle + motion + lens feel. UGC: "handheld selfie, slightly shaky, phone-camera lens." Hero: "locked tripod, slow dolly-in, 50mm-equivalent." SaaS: "static screen capture, cursor motion only." Never leave motion unspecified — the default is "chaotic."
6. **Audio map** — per-beat ambient layer (`tap dripping faintly`, `fabric rustle`, `keyboard clicks`, `stadium roar`), plus an explicit music directive: `No background music` OR `soft lo-fi bed at -18dB`. Silence about music produces stock-library slop.
7. **Negative anchor list** — final block titled `No:` listing the exact failure modes for this ad type (see Negative Anchor Library below). Model compliance with a list is dramatically higher than with prose prohibitions.

**Style summary line** — after the 7 locks, add one comma-delimited adjective stack (`vertical 9:16, raw handheld vlog, natural light only, phone-camera feel, real skin texture, warm tones, 4K`). This line is the model's "final pass" reference.

**Freeze-frame close-out** — for video, the last 1s MUST be an explicit final-frame spec: what's in frame, lighting, focus, subject expression. Prevents models from trailing off into blur.

---

### Ad-Type Modules (pick one; compose with the 7 locks)

Each module is a preset — it names the realism register, camera family, audio family, and canonical negative anchors. Merlin picks the module from `product.md` + user intent, then fills in the 7 locks.

**UGC / Authenticity** (skincare, supplements, apparel, DTC staples)
- Realism register: **raw, unfiltered, real skin texture**. Authenticity tokens repeated every beat: `pores visible`, `no filter`, `real skin texture`, `phone-camera feel`.
- Camera: handheld, selfie angle, slight shake, FaceTime tilt, 1–2 ft subject distance.
- Audio: ambient-only or quiet room tone, voiceover delivered `naturally, casually, not scripted-sounding`, emotion tag required before every line (`tired, honest`, `surprised, quieter`, `warm, confident`).
- Wardrobe progression: same person, outfit shifts across beats to imply time (morning tank → hoodie → sunlit top).
- Banned: studio lighting, ring lights, color grading, bokeh, glam makeup, posed smiles, cinematic camera moves.

**Hero Product / Cinematic** (luxury, tech, packaged goods, premium beverages)
- Realism register: **controlled, heightened, tactile**. Product must read like the reference photo at 2× gloss.
- Camera: locked tripod or motion-controlled slider, slow dolly-in, macro pulls on texture/material, 50mm or 85mm feel.
- Audio: designed soundscape — soft foley for material (glass clink, fabric rub), optional cinematic bed at -20dB, no voiceover unless premium narrator specified.
- Lighting: three-point or single-key with negative fill, specular highlights on product edges.
- Banned: handheld shake, phone-camera aesthetic, lens flare presets, "vlog" language.

**Talking-Head / Testimonial** (SaaS, course, service, B2B)
- Realism register: **face-forward, eye-contact, natural speech pacing**. Route to HeyGen (`heygen` or `heygen-agent`) when avatar is required — never try to generate talking faces via Veo/Seedance.
- Camera: medium-close, eye-level, static or very slow dolly.
- Audio: primary voice at -6dB, room-tone floor, no music unless branded bed specified.
- Script: EXACT dialogue spoken (40–50 words, 3-second hook). Emotion tag before each line.
- Banned: jump cuts mid-sentence, cinematic color grade, background activity competing with face.

**SaaS / UI Demo** (product walkthroughs, feature launches, app stores)
- Realism register: **crisp screen capture, cursor grammar, UI reveals**. Treat the screen as the subject.
- Camera: static canvas OR zoom-to-region OR picture-in-picture with presenter in corner.
- Audio: voiceover-led, optional keyboard clicks at -24dB, light motion-graphics stingers at scene changes.
- Beats: problem frame → open product → perform key action → show result → CTA. Each beat 3–4s.
- Banned: fake/generic UI mocks (always use real screenshots the user supplies), auto-generated logos, imagined button labels.

**Gameplay / Reaction** (games, interactive apps, entertainment)
- Realism register: **split-attention — real gameplay + real reaction face**. Typically split-screen or PiP.
- Camera: gameplay is in-engine capture (static), reaction is webcam-handheld with visible excitement.
- Audio: game audio + authentic reaction voiceover (gasps, "no way," "wait"), music ONLY if part of the game's diegetic audio.
- Banned: staged reactions, fake gameplay mockups, generic game music overlay.

**Split-Screen / Before-After** (fitness, skincare, finance glow-ups, tool comparisons)
- Realism register: **visually matched compositions** — same angle, same framing, same lighting across both sides. The contrast is the entire creative — don't let camera drift hide it.
- Camera: locked framing on both panels, zero motion mismatch.
- Audio: voiceover narrating the delta, ambient matched or absent.
- Banned: filters that fake the "after," different crops between panels, music that telegraphs the reveal before the viewer sees it.

**Transformation Story** (UGC or hero) — multi-day or multi-beat journey
- Must include the **Evolution spec** lock (#4). State the 3 visible deltas in one paragraph before beats begin.
- Use wardrobe/setting change to cue time passage — never rely on text overlays unless explicitly approved.
- Close on the payoff beat, not a summary.

---

### Negative Anchor Library (the `No:` list — paste verbatim per module)

- **UGC / Authenticity:** `studio lighting, ring lights, text overlays, cinematic camera moves, artificial bokeh, color grading filters, heavy post-processing, glam makeup, posed smiles, stock music`
- **Hero Product:** `handheld shake, phone-camera look, vlog aesthetic, casual framing, text overlays, lens-flare presets, dirty/cluttered backgrounds`
- **Talking-Head:** `jump cuts mid-sentence, background motion competing with face, cinematic color grade, uncanny avatar artifacts, hand morphing`
- **SaaS / UI Demo:** `fabricated UI elements, imagined button labels, generic stock logos, fake data that looks real, motion blur on text`
- **Gameplay / Reaction:** `staged reactions, fake gameplay footage, generic music overlay, cuts that hide gameplay moments`
- **Split-Screen:** `different crops between panels, filters on one side only, mismatched lighting, music telegraphing the reveal`
- **Universal (always append):** `distorted hands, morphing faces, inconsistent product color, floating limbs, extra fingers, text artifacts`

---

### Continuity Locks (multi-beat, multi-shot, batch)

When a prompt spans multiple beats OR a batch generates 3+ variations:

1. **Subject identity anchor** — a single sentence describing the person/product appears in the shell AND is repeated at the top of every beat. Copy-paste, don't paraphrase.
2. **Wardrobe/packaging delta rule** — state exactly what is ALLOWED to change (outfit, setting, lighting) and what MUST stay fixed (face, skin tone, SKU, label). Models interpret silence as permission.
3. **Lighting arc** — if beats span time-of-day (morning → day → golden hour), spec each lighting explicitly. Never let the model interpolate.
4. **Reference image leash** (image-to-video / edit modes) — name the reference file and say `maintain exact product identity from reference: color, proportions, label copy, material finish`.

---

### Realism Gradient — pick ONE register per creative

| Register | Use for | Key tokens |
|---|---|---|
| **Raw UGC** | DTC staples, social-proof, relatable verticals | `handheld, phone-camera, real skin texture, no filter, natural light only` |
| **Polished UGC** | Premium DTC, wellness, apparel at mid-price | `natural light, slight stabilization, clean but not glossy, real textures` |
| **Hero Product** | Luxury, tech, premium packaged | `locked camera, controlled key light, macro texture, specular highlights` |
| **Cinematic Narrative** | Brand films, 30-60s anthems | `motion-controlled moves, designed lighting, shallow DOF intentional, color-graded` |
| **Screen-Native** | SaaS, apps, digital products | `UI-first, cursor grammar, graphic stingers, voiceover-led` |

**Never mix registers inside a single creative.** A Raw UGC with cinematic dolly moves reads as fake and tanks CTR. Pick one, commit.

---

### Video Prompts — 6 Required Anchors (anti-artifact technical floor)

These apply UNDERNEATH the 7 locks and 1 module — they protect against model failure modes regardless of creative type. Every `productHook` or video description MUST include all 6:

1. **Camera motion** — exact: "slow smooth dolly-in," "static tripod," "gentle pan right." Never leave unspecified.
2. **Facial consistency** — "consistent facial features" + specific expression ("shy smile," "confident gaze"). Prevents face morphing.
3. **Hand anatomy** — "anatomically correct hands with fluid, stable movement" + specific gesture if needed. Hands are the #1 failure mode.
4. **Texture lock** — "fixed [fabric/material] textures, stable rendering." Name the specific material (embroidery, knit, denim, glass, leather).
5. **Hair physics** — "gentle hair movement" or "minimal hair movement." Default = wild/unrealistic, always specify.
6. **Lighting + finish** — "warm golden hour lighting" (or specific) + "high-definition details, clean professional finish."

---

### Prompt Template (copy-fill for every video brief)

```
[Shell lock] {mode}. {aspect}. {duration}. {style family}.

[Subject lock] {specific physical/SKU description}. Same {subject} throughout — only {allowed variable} changes.

[Evolution spec — transformation only] Stage 1: {visible state}. Stage 2: {visible state}. Stage 3: {visible state}.

[Beat 1, 0–Xs — LABEL]
Setting: {where}. Lighting: {source + quality}. Wardrobe/packaging: {specifics}.
Camera: {angle + motion + lens feel}.
Action: {what subject does}.
Emotion: {facial/body state}.
Voiceover — {Speaker} ({emotion tag}): "{exact line}"
Audio: {ambient layer}.

[Beat 2, X–Ys — LABEL]
(same structure)

[Beat N, closing — LABEL + freeze frame]
(same structure)
Final frame: {subject + framing + light + focus}.

[6 technical anchors]
Camera motion: {...}. Facial consistency: consistent features, {expression}. Hands: anatomically correct, {gesture}. Texture: fixed {material}. Hair: {motion spec}. Lighting + finish: {...}.

[Continuity locks]
Character: {anchor sentence}. Allowed to change: {list}. Fixed: {list}.

[Style summary]
{comma-delimited adjective stack}.

[Audio directive]
Music: {none | spec}. Voiceover: {delivery direction}.

[No:]
{negative anchors from module library + universal set}
```

Merlin SHOULD write prompts in this exact order. Models (Veo, Seedance, Kling, HeyGen) weight the opening of the prompt heavier than the middle — put locks first, creative flourish after.

---

### Production Truth

- fal.ai cannot produce pixel-perfect logos or text — only use for lifestyle/hero imagery.
- Always use real logos (downloaded during onboarding to `logo/logo.png`), real product photos (Shopify CDN), real brand colors (exact hex from `brand.md`).
- Brand colors come from website CSS custom properties (`--color-button`, `--color-foreground`, etc.) extracted at onboarding.
- Character consistency beyond ~8 seconds is fragile in text-to-video models — for transformation stories >15s, prefer image-to-video with a locked reference frame, or split into multiple clips stitched in post.
- HeyGen is the ONLY reliable path for spoken talking-head with lip-sync. Veo/Seedance for spoken human faces = face morphing + lip desync. Route accordingly.
- Batch variation rule: when generating N variations, vary ONE dimension at a time (hook OR format OR setting) — never all three. Single-variable testing reads cleanly in the Promotion Gate.

---

## Competitor Intelligence

### Discovery (onboarding + weekly digest)

**Step 1 — Infer from the brand.** Read `brand.md` and product catalog → identify niche → use WebSearch:
- `"<niche> brand" site:shopify.com`
- `"<category>" -[brand name]`
- Related brands on Instagram/TikTok in the same niche

Find 5-8 competitors. For each: name, URL, product overlap, price range (cheaper / same / premium).

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
1. Read each ad's copy — extract hooks, CTAs, offers
2. WebFetch snapshot URLs to describe the visual creative
3. Compare to our recent ads
4. Log insights to `memory.md` under `## Competitor Signals`

No Meta token → fall back to WebSearch for competitor news.

**Note:** Ad Library returns only ads that ran in UK/EU. Purely domestic US brands won't appear. Rate limit: 200 calls/hour.

### What to look for

- **Hook patterns**: "POV:", "Wait till you see...", "This changed everything"
- **Format trends**: video vs static, UGC vs polished, length
- **Script style**: conversational or scripted (read transcriptions)
- **Offer patterns**: free shipping, % off, BOGO, bundles
- **Running duration**: ads running 30+ days are proven winners — study these closely
- **New products**: anything we haven't seen before

### How this feeds back

- Heavy competitor video testimonials → try talking-head mode
- Competitors running sales → consider value-focused angle instead of discounting
- Trending hook style → adapt for our brand voice
- Long-running competitor ads → reference their structure in our scripts
- Save winning patterns to memory.md for future script generation

---

## SEO Blog Generation

When the user says "write a blog post" or the daily scheduled task triggers:

1. **Pick a topic** from the brand's products, recent ad winners (memory.md), or seasonal angles.
2. **Write 600-1,000 words** in brand voice (`brand.md`):
   - Title with primary keyword (<60 chars)
   - Casual, readable tone
   - Soft CTA linking to the product
   - The app validates word count, keyword density, headings, meta length, internal linking before publishing.
3. **Internal linking (mandatory):**
   - Featured product: `<a href="/products/{handle}">{Product Name}</a>`
   - 1-2 related products mentioned naturally
   - 1-2 previous posts (check via `blog-list` or memory.md)
   - Descriptive anchor text with keywords, NOT "click here"
4. **Meta description (mandatory):** 150-160 chars targeting primary keyword + value prop. Pass as `summary_html` (Shopify uses as excerpt + meta). The app injects Article schema (JSON-LD) automatically.
5. **Generate featured image** via image pipeline (product-showcase style).
6. **Publish:**
   ```json
   {"action": "blog-post", "blogTitle": "...", "blogBody": "<h2>...</h2>",
    "blogTags": "...", "blogImage": "path/to/featured.jpg"}
   ```
7. **Update `memory.md`** with: title, topic, date, URL, primary keyword.

**Topic rotation:** product spotlight (deep dive + related links) · lifestyle/culture (link 2-3 products) · how-to-style (3-4 product links) · behind-the-brand (flagship products).

If Shopify is not configured → save as `.html` in `results/` for manual posting.

Apply SEO Rubric (above) to keyword selection. Apply Copy Quality Gate (above) to body copy before publishing.

---

## Action Reference

Compact reference for every platform action. Tools take `{action, brand, ...}`.

### Meta Ads (`meta_ads`)

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

### TikTok Ads (`tiktok_ads`)

`push` (`adVideoPath`, `adHeadline`, `adBody`, `dailyBudget`) · `insights` · `kill` (`adId`) · `duplicate` (`adId`, `campaignId`) · `setup` · `lookalike` (`adId`)

### Reddit Ads (`reddit_ads`)

`campaigns` · `ads` · `insights` · `create` · `pause`

### Shopify (`shopify`)

`products` · `orders` (`batchCount` = days) · `import` (pulls products into brand folder)

### Klaviyo (`klaviyo`)

`performance` · `lists` · `campaigns`

### SEO (`seo`)

`audit` · `keywords` · `rankings` · `gaps` · `fix-alt` (`adId` = product ID, `campaignId` = image ID, `blogTitle` = alt text)

### Content (`content`)

`image` (`imagePrompt`, `imageFormat`, `referencesDir`, `skipSlack`) · `batch` (`batchCount`, `mode`, `script`) · `archive` (`archiveDays`) · `blog-post` (`blogTitle`, `blogBody`, `blogTags`, `blogImage`) · `blog-list` · `competitor-scan` (`blogBody` = comma list, `imageCount`)

### Video (`video`)

`generate` (`mode`, `script`, `productHook`, `duration`, `voiceStyle`, `referencesDir`) · `heygen-agent` (`prompt`, optional `avatarId`/`voiceId`/`styleId`/`orientation`/`incognitoMode`/`callbackUrl`)

### Voice (`voice`)

`clone` (`voiceSampleDir`, `voiceName`) · `list` · `delete` (`voiceId`) · `list-avatars` (HeyGen)

### Dashboard (`dashboard`)

`dashboard` (`batchCount` = days, unified MER/ROAS) · `wisdom` (collective insights) · `calendar` (launch cadence)

### Scheduled tasks (use `mcp__scheduled-tasks__*` only)

`list_scheduled_tasks` · `update_scheduled_task` (`enabled: true|false`) · `create_scheduled_task` (use `merlin-` prefix for taskId)
