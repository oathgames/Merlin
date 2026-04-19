---
name: merlin-content
description: Use when the user wants to make, generate, create, shoot, write, or brief an ad, image, video, voiceover, blog body, email body, landing headline, social post, or any creative asset. Covers the 7-lock Universal Creative Brief, ad-type modules (UGC, Hero, Talking-Head, SaaS, Gameplay, Split-Screen, Transformation), the negative anchor library, continuity locks, realism gradient, the 6 technical anchors for video, the prompt template, offer construction (Hormozi Value Equation + Schwartz 5 awareness levels + PAS/AIDA/PASTOR/RMBC frameworks), creative performance metrics (hook rate, hold rate, thumbstop ratio, beat structure), the Copy Quality Gate (7-expert panel + AI detector weighted 1.5× + banned-vocab list), the Content Scoring viral formula, and HeyGen one-shot Video Agent routing.
owner: ryan
bytes_justification: 26KB — the creative brief (7 locks × 7 ad-type modules × negative-anchor library × realism gradient × video technical anchors), offer construction (Value Equation + Schwartz awareness levels + 5 DR frameworks), creative performance metrics (hook/hold/thumbstop with beat structure), copy quality gate, and content scoring form one linked reasoning chain. Splitting by asset type would duplicate the shared brief/scoring sections and break cross-references (e.g. UGC brief references the realism gradient which references continuity locks; offer construction references hook archetypes which reference Copy Quality Gate). Hard-capped at 32KB.
---

# Content Production — Images, Video, Copy

**Customers buy what they see in the ad. If the ad doesn't match the product, it's deceptive — non-negotiable.**

## Image Prompts (`mcp__merlin__content({action: "image"})`)

Before writing ANY image prompt:
1. **Read every reference photo** in `assets/brands/<brand>/products/<product>/references/` (use the Read tool).
2. **Describe ONLY what you see** — not what `brand.md` says, not what you imagine.
3. The app validates your description against reference images and rejects mismatches.

Pass the raw product description to the image action; the app's prompt pipeline layers camera settings, scene anchoring, and negative constraints automatically. Available models: `banana-pro-edit` (default), `banana-pro`, `banana-edit`, `imagen-ultra`, `ideogram`, `flux`. Omit `imageModel` unless the user explicitly requests one.

**Model substitution is a hard failure.** Seedance ≠ Kling, Veo ≠ anything else, image-to-video ≠ text-to-video, edit ≠ base. If the requested model fails/rate-limits/isn't mapped — STOP, surface the binary error, ask. Silent retries on a different model is a bug.

**Fal known aliases (pass as-is, NEVER WebFetch to verify):** `banana`, `banana-edit`, `banana-pro`, `banana-pro-edit`, `flux`, `ideogram`, `recraft`, `seedream`, `imagen`, `imagen-ultra`, `seedance-2`, `veo-3`, `kling`. Full `fal-ai/vendor/model` slugs also accepted. Only WebFetch if a name is neither an alias nor a full slug.

## Universal Creative Brief — the 7 locks (required for every image/video prompt)

Every S-tier prompt is a constraint pyramid — top-down specificity beats top-down creativity. Any prompt that ships without all 7 gets rejected at QA. Output order matters — models weight the opening heavier than the middle.

1. **Shell lock** — one opener line declaring: generation mode (`Pure text generation` vs `Image-to-video from reference`), aspect/format (`Vertical 9:16`, `Square 1:1`, `Landscape 16:9`), duration (`15-second seamless`), stylistic family (`handheld phone-camera UGC vlog`, `hero product cinematic`, `screen-recording SaaS demo`). No ambiguity. This line alone filters 80% of model drift.
2. **Subject lock** — who/what appears, with specific physical/SKU anchors, followed by the literal phrase **"same [subject] throughout — only [allowed variable] changes"**. People: age range + skin tone + hair + build. Products: SKU name + color + material + packaging. Prevents face morphing and product swapping across beats.
3. **Beat blocking** — timestamped sections (`0–4s`, `5–9s`, `10–14s`, `15s`). Each beat specifies all of: setting, lighting, wardrobe/packaging state, camera framing, camera motion, subject action, subject emotion, voiceover (with emotion tag), ambient audio. Skip none.
4. **Evolution spec** (transformation ads only) — explicit `Stage 1 / Stage 2 / Stage 3` paragraph stating what visibly changes and by how much. Concrete visible deltas ("redness faint → reduced → gone"), not abstractions.
5. **Camera grammar** — per-beat angle + motion + lens feel. UGC: "handheld selfie, slightly shaky, phone-camera lens." Hero: "locked tripod, slow dolly-in, 50mm-equivalent." SaaS: "static screen capture, cursor motion only."
6. **Audio map** — per-beat ambient layer (`tap dripping faintly`, `fabric rustle`, `keyboard clicks`), plus explicit music directive: `No background music` OR `soft lo-fi bed at -18dB`. Silence about music produces stock-library slop.
7. **Negative anchor list** — final block titled `No:` listing exact failure modes (see Negative Anchor Library). Model compliance with a list is dramatically higher than with prose prohibitions.

**Style summary line** — after the 7 locks, add one comma-delimited adjective stack (`vertical 9:16, raw handheld vlog, natural light only, phone-camera feel, real skin texture, warm tones, 4K`). This is the model's "final pass" reference.

**Freeze-frame close-out** — for video, last 1s MUST be an explicit final-frame spec: what's in frame, lighting, focus, subject expression. Prevents trailing off into blur.

## Camouflage-Ad Fields — the Andromeda native-feed layer

Meta's Andromeda system rewards ads that feel native to the feed, not studio pitches. The AdBrief struct exposes four structural fields (on top of the 7 locks) that every image/video brief should populate when the goal is paid social distribution. A brief missing all four scores ~30 rubric points lower than one with all four set, and the binary auto-adds anti-studio negatives when any are present.

1. **`openingScenario`** — the real moment your avatar lives in (kitchen at 7am, gym locker room, back seat of an Uber). Not "beautiful woman with product" — a scene the viewer recognizes. Seeds the first 2 seconds.
2. **`conflictBeat`** — `{timestamp, description, kind: "conflict"}`. Timestamp MUST be ≤ 5.0 or the rubric fails the core `conflict_timing` check. Description must frame the problem as felt experience ("she sighs at the 2pm mirror check"), NEVER product-first ("buy now", "$30 off", "introducing…" fail the `conflict_felt` heuristic).
3. **`interruptBeats[]`** — 3–6 mid-ad spikes spaced ≥ 1.5s apart. Each is a scene change, tone flip, or reveal (not a repeated product shot). Fewer than 3 collapses retention past 50%; more than 6 reads as chaotic. Kind field: `"twist"`, `"reveal"`, `"interrupt"`, `"resolve"`.
4. **`platformNative`** — `"reel"` (polished handheld), `"tiktok"` (raw, text-on-screen, trend cadence), `"feed"` (1:1 or 4:5 cleaner), `"stories"` (9:16 quick-read). The binary injects platform-specific styling cues; blank drifts toward studio polish.

## Video prompt assembly (same AdBrief, timeline-first)

The video pipeline uses the same AdBrief struct — fill the 4 camouflage fields exactly as you would for an image brief. Under the hood the binary calls `buildVideoPromptFromBrief()` which renders a timeline-first prompt (Shell lock → Product → Subject → beat timeline → scene cues → 6 technical anchors → freeze-frame close-out → negatives). Key differences from image:

- **Beat timeline** is explicit: `0.0s [opening] → <conflictBeat> → <interruptBeats sorted> → <duration>s [close]`. The close beat is implicit — appears only when at least one real beat is populated.
- **Camera**: if you leave `camera` blank AND any camouflage field is set, the assembler injects handheld micro-motion (native-feed default). Explicit `camera` always wins.
- **Duration** comes from `duration` (default 5s for fal). Plumbs into the Shell lock opener and the freeze-frame close-out timestamp.
- **Priority**: explicit `productHook` still overrides the assembler — use it when you want raw prompt control. Default (no hook) uses AdBrief if set, else the legacy cinematic baseline.

Same `rubric.json` and `prompt.txt` persist to the run folder so video and image runs are uniformly analyzable by the wisdom engine.

## Creative Rubric (pre-generation gate)

Every AdBrief passed to the image OR video pipeline is scored by `EvaluateBrief()` before a single fal credit is burned. Output is saved to `rubric.json` alongside `prompt.txt` in each run folder. Bands:

- **A (≥90%)** — ship it; consider saving as a template.
- **B (80–89%)** — pass; one polish field missing.
- **C (70–79%)** — pass; multiple polish fields missing or one core weak.
- **D (50–69%)** — warn; generates but flag in retrospective.
- **F (<50%)** — fail; brief is broken, regenerate before running.

**Core checks (weight 2 each, 8pts total):** `product_clarity`, `opening_scenario`, `conflict_timing` (≤5s), `interrupt_count` (3–6).
**Polish checks (weight 1 each, 8pts total):** `conflict_felt`, `interrupt_spacing` (≥1.5s gap), `platform_native`, `has_cta`, `environment_set`, `subject_set`, `mood_set`, `negatives_nontrivial`.

When a brief scores below pass, the `suggestions[]` array returns up to 3 actionable fixes ordered by weight. Use those verbatim when regenerating — don't paraphrase.

## Batch Variety (Andromeda-friendly diversity)

When `imageCount > 1`, the binary rotates ONE axis per image in the batch so we never ship N identical scenes. The `varyDimension` command field controls the axis:

- `""` (default) or `"auto"` — picks axis from populated AdBrief fields (scenario > mood > lighting > subject).
- `"scenario"` — rotates opening moment (morning routine / on-the-go / relaxed evening / social proof).
- `"lighting"` — rotates register (golden hour / overcast / indoor lamp / direct sun).
- `"subject"` — rotates framing (wide / medium / close / over-the-shoulder).
- `"mood"` — rotates emotional register (calm / energetic / surprised / satisfied).
- `"none"` — explicit opt-out (rare; use when you want 4 near-identical variants, e.g. A/B testing a single variable).

Rotation is deterministic (idx-1 mod axisLen), wraps past 4 images, and is applied as a prompt suffix — zero extra API calls. Portrait + square of the same image index share the same variant so "image 1" is the same scene in both crops.

## Ad-Type Modules (pick ONE; compose with the 7 locks)

Each module = realism register + camera family + audio family + canonical negative anchors. Merlin picks the module from `product.md` + user intent, then fills in the 7 locks.

**UGC / Authenticity** (skincare, supplements, apparel, DTC staples)
- Realism register: **raw, unfiltered, real skin texture**. Tokens per beat: `pores visible`, `no filter`, `real skin texture`, `phone-camera feel`.
- Camera: handheld, selfie angle, slight shake, FaceTime tilt, 1–2 ft subject distance.
- Audio: ambient-only or quiet room tone, voiceover `naturally, casually, not scripted-sounding`, emotion tag before every line (`tired, honest`, `surprised, quieter`, `warm, confident`).
- Wardrobe progression: same person, outfit shifts across beats to imply time.
- Banned: studio lighting, ring lights, color grading, bokeh, glam makeup, posed smiles, cinematic moves.

**Hero Product / Cinematic** (luxury, tech, packaged goods, premium beverages)
- Realism register: **controlled, heightened, tactile**. Product reads like reference photo at 2× gloss.
- Camera: locked tripod or motion-controlled slider, slow dolly-in, macro pulls on texture, 50/85mm feel.
- Audio: designed soundscape — soft foley for material, optional cinematic bed at -20dB, no voiceover unless premium narrator.
- Lighting: three-point or single-key with negative fill, specular highlights on product edges.
- Banned: handheld shake, phone-camera aesthetic, lens flare presets, vlog language.

**Talking-Head / Testimonial** (SaaS, course, service, B2B)
- Realism register: **face-forward, eye-contact, natural speech pacing**. Route to HeyGen (`heygen` or `heygen-agent`) when avatar required — **never try to generate talking faces via Veo/Seedance** (face morphing + lip desync).
- Camera: medium-close, eye-level, static or very slow dolly.
- Audio: primary voice at -6dB, room-tone floor, no music unless branded bed.
- Script: EXACT dialogue spoken (40–50 words, 3s hook). Emotion tag before each line.
- Banned: jump cuts mid-sentence, cinematic color grade, background activity competing with face.

**SaaS / UI Demo** (product walkthroughs, feature launches, app stores)
- Realism register: **crisp screen capture, cursor grammar, UI reveals**. Screen IS the subject.
- Camera: static canvas OR zoom-to-region OR picture-in-picture with presenter in corner.
- Audio: voiceover-led, optional keyboard clicks at -24dB, light motion-graphics stingers at scene changes.
- Beats: problem frame → open product → perform action → show result → CTA. 3–4s each.
- Banned: fake UI mocks (always use real screenshots user supplies), auto-generated logos, imagined button labels.

**Gameplay / Reaction** (games, interactive apps, entertainment)
- Realism register: **split-attention — real gameplay + real reaction face**. Split-screen or PiP.
- Camera: gameplay = in-engine capture (static), reaction = webcam-handheld with visible excitement.
- Audio: game audio + authentic reaction voiceover (gasps, "no way," "wait"), music ONLY if diegetic.
- Banned: staged reactions, fake gameplay mockups, generic game music overlay.

**Split-Screen / Before-After** (fitness, skincare, finance glow-ups, tool comparisons)
- Realism register: **visually matched compositions** — same angle, same framing, same lighting across both sides. The contrast is the entire creative.
- Camera: locked framing on both panels, zero motion mismatch.
- Audio: voiceover narrating the delta, ambient matched or absent.
- Banned: filters that fake the "after," different crops between panels, music telegraphing the reveal.

**Transformation Story** (UGC or hero, multi-day or multi-beat journey)
- Must include Evolution spec (lock #4). State 3 visible deltas in one paragraph before beats.
- Use wardrobe/setting change to cue time — never rely on text overlays unless approved.
- Close on the payoff beat, not a summary.

## Negative Anchor Library (paste verbatim per module)

- **UGC:** `studio lighting, ring lights, text overlays, cinematic camera moves, artificial bokeh, color grading filters, heavy post-processing, glam makeup, posed smiles, stock music`
- **Hero Product:** `handheld shake, phone-camera look, vlog aesthetic, casual framing, text overlays, lens-flare presets, dirty/cluttered backgrounds`
- **Talking-Head:** `jump cuts mid-sentence, background motion competing with face, cinematic color grade, uncanny avatar artifacts, hand morphing`
- **SaaS / UI Demo:** `fabricated UI elements, imagined button labels, generic stock logos, fake data that looks real, motion blur on text`
- **Gameplay / Reaction:** `staged reactions, fake gameplay footage, generic music overlay, cuts that hide gameplay moments`
- **Split-Screen:** `different crops between panels, filters on one side only, mismatched lighting, music telegraphing the reveal`
- **Universal (always append):** `distorted hands, morphing faces, inconsistent product color, floating limbs, extra fingers, text artifacts`

## Continuity Locks (multi-beat, multi-shot, batch)

When a prompt spans multiple beats OR a batch generates 3+ variations:

1. **Subject identity anchor** — single sentence describing person/product appears in shell AND top of every beat. Copy-paste, don't paraphrase.
2. **Wardrobe/packaging delta rule** — state exactly what's ALLOWED to change (outfit, setting, lighting) and what MUST stay fixed (face, skin tone, SKU, label). Models interpret silence as permission.
3. **Lighting arc** — beats span time-of-day (morning → day → golden hour) → spec each lighting explicitly. Never let the model interpolate.
4. **Reference image leash** (image-to-video / edit modes) — name the reference file and say `maintain exact product identity from reference: color, proportions, label copy, material finish`.

## Realism Gradient — pick ONE register per creative

| Register | Use for | Key tokens |
|---|---|---|
| **Raw UGC** | DTC staples, social-proof, relatable verticals | `handheld, phone-camera, real skin texture, no filter, natural light only` |
| **Polished UGC** | Premium DTC, wellness, apparel at mid-price | `natural light, slight stabilization, clean but not glossy, real textures` |
| **Hero Product** | Luxury, tech, premium packaged | `locked camera, controlled key light, macro texture, specular highlights` |
| **Cinematic Narrative** | Brand films, 30-60s anthems | `motion-controlled moves, designed lighting, shallow DOF intentional, color-graded` |
| **Screen-Native** | SaaS, apps, digital products | `UI-first, cursor grammar, graphic stingers, voiceover-led` |

**Never mix registers inside a single creative.** Raw UGC with cinematic dolly moves reads as fake and tanks CTR. Pick one, commit.

## Video Prompts — 6 Required Anchors (anti-artifact technical floor)

These apply UNDERNEATH the 7 locks and 1 module — they protect against model failure modes regardless of creative type. Every `productHook` or video description MUST include all 6:

1. **Camera motion** — exact: "slow smooth dolly-in," "static tripod," "gentle pan right." Never unspecified.
2. **Facial consistency** — "consistent facial features" + specific expression ("shy smile," "confident gaze"). Prevents face morphing.
3. **Hand anatomy** — "anatomically correct hands with fluid, stable movement" + specific gesture. Hands = #1 failure mode.
4. **Texture lock** — "fixed [fabric/material] textures, stable rendering." Name the specific material.
5. **Hair physics** — "gentle hair movement" or "minimal hair movement." Default = wild/unrealistic.
6. **Lighting + finish** — "warm golden hour lighting" (or specific) + "high-definition details, clean professional finish."

## Prompt Template (copy-fill for every video brief)

```
[Shell lock] {mode}. {aspect}. {duration}. {style family}.

[Subject lock] {specific physical/SKU description}. Same {subject} throughout — only {allowed variable} changes.

[Evolution spec — transformation only] Stage 1: {state}. Stage 2: {state}. Stage 3: {state}.

[Beat 1, 0–Xs — LABEL]
Setting: {where}. Lighting: {source + quality}. Wardrobe/packaging: {specifics}.
Camera: {angle + motion + lens feel}.
Action: {what subject does}.
Emotion: {facial/body state}.
Voiceover — {Speaker} ({emotion tag}): "{exact line}"
Audio: {ambient layer}.

[Beat 2, X–Ys — LABEL] (same structure)

[Beat N, closing — LABEL + freeze frame] (same structure)
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

Write prompts in this EXACT order — locks first, creative flourish after.

## Video Actions (`mcp__merlin__video`)

| Action | Key params | When |
|---|---|---|
| `generate` | `mode` (product-showcase / talking-head / ugc), `script`, `productHook`, `duration`, `voiceStyle`, `referencesDir` | Full pipeline with QA, multi-format exports |
| `heygen-agent` | `prompt` (1–10,000 chars), optional `avatarId`/`voiceId`/`styleId`/`orientation`/`incognitoMode`/`callbackUrl` | User gives a natural-language idea; agent picks avatar/voice/style |

**How to pick between video paths:**
- **`heygen-agent`** — one-shot prompt → video. Agent picks everything. Fastest, lowest control.
- **`heygen`** (mode on `generate`) — Avatar IV with specific script + talking-head photo. More control.
- **`fal` / `veo` / `seedance`** — non-avatar video (product showcase, kinetic, generative). Use image-to-video with locked reference frame for transformations >15s.

HeyGen output → `results/video/YYYY-MM/<brand>/ad_<runID>/video.mp4`. Requires `heygenApiKey`.

## Voice (`mcp__merlin__voice`)

`clone` (`voiceSampleDir`, `voiceName`) · `list` · `delete` (`voiceId`) · `list-avatars` (HeyGen).

## Offer Construction (copy can't save a weak offer)

Before writing a single line of copy, score the **offer**. Copy amplifies offers; it doesn't rescue them.

### Hormozi Value Equation (score 0–100 per factor)

`Value = (Dream Outcome × Perceived Likelihood of Success) / (Time Delay × Effort & Sacrifice)`

- **Dream outcome** — what they actually want (not what the product does). "Clear skin" not "20% niacinamide serum."
- **Perceived likelihood** — proof the outcome is real: testimonials with outcomes, before/afters, data, guarantees.
- **Time delay** — how fast they feel it. Faster = higher perceived value. Name the timeline.
- **Effort & sacrifice** — how much they must do / give up. Lower = higher perceived value.

Strong offers lift the numerator AND shrink the denominator simultaneously. Stack: core product + risk reversal (money-back, try-before-you-buy) + real urgency + bonuses that complement, not dilute.

### Eugene Schwartz — 5 Levels of Awareness (match copy to reader state)

| Level | Reader knows | Copy leads with |
|---|---|---|
| **Unaware** | Has a problem but can't articulate it | Story / pattern interrupt; name the feeling |
| **Problem-aware** | Names the problem, not solutions | Agitate problem, introduce category |
| **Solution-aware** | Knows solutions exist, hasn't chosen | Comparisons, "why [your mechanism] wins" |
| **Product-aware** | Knows your product, hasn't bought | Risk reversal, proof, specifics |
| **Most-aware** | Knows and wants it | Offer, deadline, discount, CTA |

**Cold Meta/TikTok traffic is Unaware / Problem-aware. Retargeting is Solution / Product-aware. Email list is Product / Most-aware.** Copy that leads with features to cold traffic fails because the reader has no frame. Copy that re-explains the problem to a warm list bores them.

### Frameworks (pick one per piece — don't mix)

- **PAS** (Problem-Agitate-Solve) — cold social, short-form video scripts, subject lines.
- **AIDA** (Attention-Interest-Desire-Action) — long-form landing pages, cold email.
- **PASTOR** (Problem-Amplify-Story-Transformation-Offer-Response) — sales pages, webinars.
- **4-P's** (Picture-Promise-Proof-Push) — email campaigns, paid social long copy.
- **Stefan Georgi RMBC** (Research-Mechanism-Brief-Copy) — VSLs, advertorials, long-form DR.

## Creative Performance Metrics (the real scoreboard)

Subjective quality scoring is directional. The actual measure is what the platform reports post-launch:

| Metric | Formula | Healthy (DTC video) | Unhealthy |
|---|---|---|---|
| **Hook rate** (3-second view rate) | 3s views / impressions | ≥30% | <20% = first frame isn't stopping scrolls |
| **Hold rate** | 15s views / 3s views | ≥50% | <30% = hook is baity; body doesn't deliver |
| **Thumbstop ratio** | 3s views / impressions, compared across creatives | top 20% vs account avg | flag bottom 20% for replacement |
| **CTR (link)** | link clicks / impressions | ≥1.5% Meta feed / ≥1.0% TikTok | <1.0% Meta feed = weak CTA or offer |
| **Cost per thumb-stop** | spend / 3s views | <$0.02 | >$0.05 = bad creative at any CPM |

**Beat structure for video hooks** (0–3s → 3–15s → 15–25s → final 2s):
- **0–3s — hook.** Stop the scroll. Pattern interrupt, question, dramatic visual, or bold claim. No brand logos, no slow pans.
- **3–15s — retention.** Deliver on the hook. Name the problem, show the mechanism, build tension. Hold rate is won or lost here.
- **15–25s — proof / offer.** Testimonial, before/after, demo, specific result with numbers.
- **Final 2s — CTA.** Single specific action. "Tap to shop" not "Learn more."

**Feedback loop:** after each optimize run, write top performers' hook archetype, module, and retention curve to `memory.md ## What Works`. Every brief pulls from that section — creative testing compounds only if winners are encoded back into the brief generator.

## Copy Quality Gate

Before shipping any written output — ad copy, email body, blog post, landing headline, social post, thread — score it 0–100 against a 7-expert panel. Target ≥90. Max 3 revision rounds, then ship best version with candid notes on remaining gaps.

**The 7 experts** (score each 0–100, then average):
1. Direct-response copywriter — does it sell? Is the offer clear? (reference Value Equation above)
2. Brand voice guardian — does it sound like this brand?
3. Conversion analyst — is the CTA single, specific, frictionless?
4. SEO strategist — keyword + intent match (skip for ad copy).
5. Skeptical founder — would the CEO approve this going out?
6. Audience persona match — does the target reader recognize themselves? Is the awareness level matched (Schwartz)?
7. **AI-writing detector — weighted 1.5×.** **AI-confidence ≥40% = automatic ship blocker** regardless of other scores. If a dedicated detector isn't available, apply the heuristic checklist below — any ≥3 banned-vocab hits or ≥2 humanizer patterns = blocking.

**Banned vocabulary** (−5 per instance, reject if ≥3 present): delve, tapestry, leverage, seamless, transformative, ecosystem, synergy, elevate, unlock, empower, journey (figurative), navigate (figurative), realm, landscape (figurative), harness, foster (figurative), testament, pivotal, paramount, crucial, bespoke (unless literally tailored), robust, comprehensive, holistic, meticulously, in today's fast-paced world, at the end of the day.

**Top humanizer patterns to reject:**
1. **Negation-definition**: "This isn't just X. It's Y." → rewrite as direct claim.
2. **Significance inflation**: "It's important to note that…" / "It's worth mentioning…" → cut.
3. **Tricolon clichés**: "faster, cheaper, better" → replace with one specific number.
4. **Em-dash decoration** when a comma or period would work.
5. **Hedged conclusions**: "ultimately," "in essence," "at the end of the day."
6. **Generic openers**: "In the ever-evolving world of…" → delete entire opener.

**Discipline:** scores must be honest. No padding to hit 90. Show every round's score in output — iteration transparency is the value, not a clean final number. After 3 rounds, ship best with one-line note on what still isn't perfect.

## Content Scoring (viral score)

For every generated blog, X/LinkedIn thread, short-form video script, social post, or newsletter section:

**Viral score = (Novelty × 0.4) + (Controversy × 0.3) + (Utility × 0.3)**, each factor 0–100.

- **Novelty** — is the angle fresh, or recycled take #47? Score harshly — most content is derivative.
- **Controversy** — is there a position someone could reasonably disagree with? Neutral = 0.
- **Utility** — can the reader do something concretely different tomorrow? Specifics raise the score.

**Thresholds:** ≥80 → publish priority · 60–79 → calendar filler · 40–59 → use sparingly · <40 → cut.

**Atomization** — every long-form source (blog, podcast, case study, call transcript, customer interview) produces 15–20 downstream assets: 3–5 short-form clips with hooks + timestamps · 2–3 X/LinkedIn threads (5–10 posts each, ≤280 chars per X post) · 1 LinkedIn article (800–1,200 words, story-driven) · 1 newsletter section with TL;DR + pull quotes · 3–5 quote cards (≤20 words each) · 1 SEO blog outline · 1 Shorts/TikTok script with hooks + B-roll cues.

**Dedup rule:** reject any asset with >70% semantic overlap vs. another asset in the same batch or vs. anything published in the last 30 days. Check `results/` and memory's Run Log before generating.

## Production Truth

- fal.ai cannot produce pixel-perfect logos or text — only use for lifestyle/hero imagery.
- Always use real logos (downloaded to `logo/logo.png`), real product photos (Shopify CDN), real brand colors (exact hex from `brand.md`).
- Brand colors come from website CSS custom properties (`--color-button`, `--color-foreground`, etc.) extracted at onboarding.
- Character consistency beyond ~8s is fragile in text-to-video — for transformations >15s, prefer image-to-video with a locked reference frame, or split into multiple clips stitched in post.
- HeyGen is the ONLY reliable path for spoken talking-head with lip-sync. Veo/Seedance for spoken human faces = face morphing + lip desync.
- Batch variation rule: when generating N variations, vary ONE dimension at a time (hook OR format OR setting) — never all three. Single-variable testing reads cleanly in the Promotion Gate.

## Hook archetypes

Every creative uses one: **curiosity-gap, pattern-interrupt, problem-agitation, POV, social-proof-frontload, skit, before-after, direct-address, voiceover-demo, testimonial-open.** Tag in `metadata.json`. QA rejects hooks <6/10 on attention pull.

## Content Action Reference (`mcp__merlin__content`)

| Action | Key params |
|---|---|
| `image` | `imagePrompt`, `imageFormat` (`both` / portrait / square), `referencesDir`, `skipSlack` (default true) |
| `batch` | `batchCount`, `mode`, `script`, `skipSlack` |
| `archive` | `archiveDays` |
| `blog-post` | `blogTitle`, `blogBody`, `blogTags`, `blogImage` (see `merlin-seo`) |
| `blog-list` | (none) |
| `competitor-scan` | `blogBody` (comma list of competitor names), `imageCount` (see `merlin-social`) |

## Images / Video Display

Include full file path on its own line (e.g. `results/img_20260403/image_1.jpg`). No backticks, no code blocks. App auto-renders `.jpg/.png/.webp/.mp4` inline.

## Routing hints

- "make / generate / create / shoot a video" → `video({action: "generate"})` or `heygen-agent`
- "make / generate an image / ad / photo" → `content({action: "image"})`
- "quick HeyGen video" / "one-shot video from a prompt" → `heygen-agent`
- "clone my voice" → `voice({action: "clone"})`
- "score this copy" / "is this AI-sounding" / "rewrite this" → Copy Quality Gate inline
- "viral score" / "will this land" → Content Scoring
- "batch 3 variations" → `content({action: "batch"})`

## Cross-references

- Promotion Gate (stat-test winners before scaling) → `merlin-ads`
- Blog publishing pipeline → `merlin-seo`
- Competitor ad scan (Meta Ad Library hook extraction) → `merlin-social`
- Dashboard / wisdom citations → `merlin-analytics`

<!-- VENDOR-CARDS:BEGIN -->
<!-- Generated from tools/vendor-cards/vendor-capabilities.json — do not edit by hand. Run `node tools/vendor-cards/gen-vendor-cards.js` to regenerate. -->

## Vendor Capability Cards

| Vendor | Primary pick-when | Entry action |
|---|---|---|
| **ElevenLabs** | voiceover track for a non-HeyGen video (Seedance/Veo product ad with narration) | `clone-voice` |
| **fal.ai** | hero / lifestyle / editorial product imagery — use banana-pro-edit (default) with reference photos for SKU-accurate output | `image` |
| **HeyGen** | spoken founder / testimonial / UGC-presenter video where a face must lip-sync a script | `heygen-agent` |

### ElevenLabs — voiceover, voice cloning, streaming TTS

**Actions:** `clone-voice`, `list-voices`, `delete-voice`

**Pick when:**
- voiceover track for a non-HeyGen video (Seedance/Veo product ad with narration)
- brand voice cloning — 3 min of clean audio → reusable voice across every future ad
- streaming TTS for in-app narration (first-word latency ~400–700ms vs 2–3s for batch)
- multilingual voice — one cloned voice speaks 32+ languages with preserved timbre

**Skip when:**
- talking-head video — HeyGen bundles voice + lip-sync in one render; don't stitch ElevenLabs onto a separate HeyGen avatar render
- user wants platform default TTS (system voice) — don't over-engineer for a 5-word sting

**Killer features:**
- **Instant Voice Clone (IVC)** — 60s sample → usable clone; acceptable for drafts, not production ads
- **Professional Voice Clone (PVC)** — 3+ min clean sample → production-grade clone; the only tier to use for paid-media voiceovers
- **Multilingual v2** — same cloned voice → 32 languages with native accent and prosody; pairs with HeyGen Hyperframes localization
- **Stream TTS API** — websocket-delivered audio; powers Merlin's in-app narration — critical for first-word latency UX

**Constraints:** elevenLabsApiKey required; PVC needs ~3min clean source (no background noise, no music); clones stored server-side — use voice.delete to remove
**Cost:** ~$0.30/1K chars on Creator tier; streaming priced the same as batch
**Output:** voiceover.mp3 inside the ad result folder
**Docs:** <https://elevenlabs.io/docs/api-reference/introduction>
**Last verified:** 2026-04-19
### fal.ai — image + non-avatar video generation (multi-model gateway)

**Actions:** `image`

**Pick when:**
- hero / lifestyle / editorial product imagery — use banana-pro-edit (default) with reference photos for SKU-accurate output
- product-showcase or kinetic video without a talking human — seedance-2 (image-to-video, fast, consistent) is the default
- cinematic long-form ad (8–15s) with camera motion and physics realism — veo-3 with locked reference frame
- stylized / anime / motion-graphic aesthetic — kling (motion) or ideogram (typography-heavy)
- brand-graphic or infographic with precise text — recraft or ideogram (banana/flux/seedance cannot render clean text)

**Skip when:**
- spoken talking-head with lip-sync — route to HeyGen, never try Veo/Seedance on faces that speak
- pixel-perfect logo or legible ≥8-word copy — no fal model does this reliably; composite real assets instead
- user explicitly requests a model not in the alias list — do NOT silently substitute; surface the error and ask

**Killer features:**
- **banana-pro-edit** — reference-image-conditioned edits — the default because it locks SKU, color, packaging from the brand's reference photos
- **seedance-2 (I2V)** — image-to-video that preserves the reference frame — use this when the first frame must match an existing hero shot exactly
- **veo-3** — Google's cinematic model; best for physically-grounded camera motion, hair/fabric dynamics, 8s+ continuity
- **kling** — stylized motion + expressive character animation; good for meme-format and anime-adjacent UGC pastiche
- **ideogram / recraft** — the only reliable path to readable long-form text and vector-style brand graphics
- **Model aliases** — pass short names (banana-pro-edit, seedance-2, veo-3) — NEVER WebFetch to verify; the router resolves them server-side

**Constraints:** falApiKey required; image default = banana-pro-edit; video default = seedance-2; full fal-ai/vendor/model slugs accepted; model substitution is a hard failure (surface error, don't silently retry on another model)
**Cost:** image: ~$0.02–0.08/render; video: ~$0.10–0.40/sec depending on model; banana-pro-edit cheapest, veo-3 most expensive
**Output:** results/img_YYYYMMDD_HHMMSS/ or results/ad_YYYYMMDD_HHMMSS/
**Docs:** <https://fal.ai/models>
**Last verified:** 2026-04-19
### HeyGen — talking-head avatar video with native lip-sync

**Actions:** `heygen-agent`, `list-avatars`

**Pick when:**
- spoken founder / testimonial / UGC-presenter video where a face must lip-sync a script
- SaaS product explainer cutting between talking-head and screen-record — route to Hyperframes, not single-shot Avatar IV
- multi-language localization of one script across 175+ languages with native lip-sync (fal/veo cannot do this)
- any video where the viewer needs to trust a human on camera (founder intro, expert testimonial, educator)

**Skip when:**
- product-only, silent b-roll, or kinetic-type → use fal seedance-2 or veo-3
- >60s single-shot monologue (avatars drift after ~45s) → split into a Hyperframes multi-beat sequence
- stylized / animated / non-photoreal aesthetic → fal kling or recraft
- source photo is profile, 3/4 angle, or occluded — HeyGen rejects, use Avatar IV-trained custom avatar instead

**Killer features:**
- **Avatar IV** — photo + script → talking avatar; fastest path from text brief to finished talking-head
- **Hyperframes** — multi-shot sequence with consistent avatar across scene cuts — the correct pick for SaaS demos that weave talking-head with screen-record, and for any 30–90s narrative with >1 beat
- **Instant Avatar (custom)** — 3min of training footage → personal avatar the user owns; reuse across every future video, no re-render of likeness
- **Voice clone + 175 languages** — one script auto-localizes with native lip-sync per language — the cheapest way to launch international ad variants
- **Incognito Mode** — watermark removed on paid tier — required for any ad shipped to paid media

**Constraints:** heygenApiKey required; prompt ≤10k chars; source photo must be front-facing; render 2–4 min; callbackUrl optional for async
**Cost:** ~$0.30/min rendered; 2–4 min real-time per 60s clip
**Output:** results/video/YYYY-MM/<brand>/ad_<runID>/video.mp4
**Docs:** <https://docs.heygen.com/reference/overview>
**Last verified:** 2026-04-19

<!-- VENDOR-CARDS:END -->
