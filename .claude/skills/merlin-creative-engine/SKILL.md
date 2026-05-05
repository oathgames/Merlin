---
name: merlin-creative-engine
description: Use when the user wants BREADTH of creatives in one shot — "fan out 30 ads", "give me 50 hooks", "spin up a creative pass for [brand]", "20 variants across demos", "creative pass", "batch ad ideas", "test a bunch of angles", "I need 40 retargeting variants". Autonomously generates N (5–60) distinct creatives at uber-premium quality, randomized across creative-angle × demo × awareness × ad-type-module × aspect × emotional-register, each anchored to real product references via brand-manifest, audited at brief-time with EvaluateBrief + Copy Quality Gate, then rendered in parallel via mcp__merlin__content / mcp__merlin__video. Chat output is MINIMAL — one status line up front, then the gallery of generated creatives. All planning, matrix detail, and per-variant briefs are computed silently and attached to image metadata for click-through inspection. Cross-references merlin-content for the 7 locks, hook archetypes, 10 creative angles, AdBrief struct, EvaluateBrief rubric, Copy Quality Gate; cross-references merlin-brand-guide for brand-manifest + brand.md ground truth.
owner: ryan
bytes_justification: ~22KB — autonomous-generation orchestration layer, well under Tier C 50KB cap. Does NOT duplicate the 7 locks, hook archetypes, creative angles, AdBrief, EvaluateBrief, Copy Quality Gate, or vendor cards (those live in merlin-content). Unique here: the 8-axis randomization matrix with at-least-once sampling, the silent-orchestration output contract that hides planning detail until the user explicitly asks, the parallel-render fan-out that calls mcp__merlin__content per variant with imageCount + varyDimension for Andromeda-friendly axis rotation, and the brand-manifest enforcement that makes mass-gen safe (every brief carries productRefPath + compositeMode:true so banana-pro-edit composites the real product photo instead of hallucinating it). Cross-refs the canon rather than copying it.
---

# Creative Engine — Autonomous Mass Creative Generation

**Purpose**: One invocation → N distinct creatives, generated at uber-premium quality, in one response. The user picks the count, the engine handles everything else: brand-manifest load, matrix planning, brief drafting, EvaluateBrief audit, Copy Quality Gate, parallel render via fal.ai banana-pro-edit (image) / seedance-2 (video) / heygen-agent (talking-head), gallery emit.

**Chat output contract** — *this is the key principle*:

```
Fanning out 12 APOTHEKE variants — generating images...

[gallery of 12 creatives appears when ready]
```

That's it. No BRAND MODEL preamble, no matrix integrity declaration, no per-variant text blocks, no run-summary footer. The user sees a ONE-LINE status, then the creatives.

The skill's planning, matrix sampling, brief drafting, EvaluateBrief scoring, Copy Quality Gate audit, and run-end diversity sweep all happen INTERNALLY. None of that text reaches the chat unless the user explicitly asks ("show me the brief for variant 7" / "why did you pick those angles?" / "what's the matrix coverage?").

Per-variant brief detail is attached to the IMAGE METADATA emitted by the binary's image pipeline — the user clicks into a creative card and sees the angle, hook archetype, ad-type module, brief notes, and the exact `mcp__merlin__content` call that produced it. Available on demand, never dumped on render.

## Pick this skill when

- User wants **BREADTH**: "give me 30 ad ideas", "fan out 50 hooks", "spin up a creative pass for POG"
- User wants **RANDOMIZATION** across angles/demos/formats: "test a bunch of angles", "creative variations across all our demos"
- User wants a **BATCH of distinct creatives**, not a single polished asset
- User says a count ≥5 in the same breath as "ads", "hooks", "creatives", "variants", "concepts"

## Don't pick this skill when

- User wants ONE asset right now → `merlin-content` directly with the 7-lock template
- User wants to render variants of an EXISTING brief → `merlin-content` with `imageCount` + `varyDimension` (Andromeda axis rotation around a single concept, not orthogonal angle fan-out)
- User wants to scale/promote/kill an EXISTING winner → `merlin-ads` Promotion Gate
- User wants to score / rewrite EXISTING copy → `merlin-content` Copy Quality Gate inline

## What this skill cross-references (do NOT duplicate)

The creative foundations live in `merlin-content`. This skill orchestrates them; it does NOT redefine them. Pull from `merlin-content` for:

- **The 7 locks** — Shell · Subject · Beat blocking · Evolution · Camera grammar · Audio map · Negative anchor list
- **The 7 ad-type modules** — UGC, Hero, Talking-Head, SaaS, Gameplay, Split-Screen, Transformation
- **The 10 canonical creative angles** — `hidden_cost`, `failed_solution`, `social_proof_pivot`, `mechanism`, `enemy`, `identity_shift`, `urgency_of_now`, `comparison_flip`, `objection_first`, `insider`
- **The 10 hook archetypes** — `curiosity-gap`, `pattern-interrupt`, `problem-agitation`, `POV`, `social-proof-frontload`, `skit`, `before-after`, `direct-address`, `voiceover-demo`, `testimonial-open`
- **AdBrief struct + 4 camouflage fields** — `openingScenario`, `conflictBeat`, `interruptBeats[]`, `platformNative`
- **EvaluateBrief rubric** — Core 8pt + Polish 8pt; band A/B/C/D/F
- **Copy Quality Gate** — 7-expert panel + AI detector (≥40% = block) + banned vocab list + humanizer patterns
- **Vendor capability cards** — fal.ai, HeyGen, ElevenLabs (defaults: image = `banana-pro-edit`, video = `seedance-2`, talking-head = `heygen-agent`)
- **Realism gradient + 6 technical anchors** for video

This skill cites those by name. It does not restate them.

---

## Phase 0 — Brand model load (silent)

Same gate as `merlin-content`'s pre-tool checklist, applied internally before any matrix sampling:

1. **Brand resolved** — `[ACTIVE_BRAND]` from message tag.
2. **Product(s) named** — single product OR explicit "across all products in the catalog".
3. **`brand-manifest.json` read** — `assets/brands/<brand>/brand-manifest.json`. Pull `products[].assets.*` and `generic_assets.*` (canonical asset paths) + `visual_direction.do_use` / `do_not_use` (prompt anchors / negatives). Auto-scaffolded by the host on `brand_activate` since v1.21.23 — fresh brands have a manifest the moment products + logo are imported. **Refusal prefix to recognize** when calling `mcp__merlin__content`: `mcp__merlin__content: brand_manifest_violation:` — surface a one-line user-facing error if hit.
4. **`brand.md` read** — `assets/brands/<brand>/brand.md` for hex colors, vertical's `offeringNoun`, voice/persona, `forbidden_angles` (HARD veto, never sample), `preferred_angles` (soft bias).
5. **References inventoried** — for each product in scope, glob `assets/brands/<brand>/products/<product>/references/`. Skip products with zero references (silent — the run still ships, those products just don't appear).

**If brand or product is missing → AskUserQuestion** with a 2-option chip ("which brand?" / "all products or one?"). Do NOT generate a generic fallback against an unloaded brand. This is the ONLY user-facing pause.

If everything resolves, no chat output yet. Move to Phase 1.

---

## Phase 1 — Build the randomization matrix (silent)

Variety is engineered at sample-time, not filtered post-hoc. Sample N cells from an 8-axis space:

| # | Axis | Cardinality | Source |
|---|------|-------------|--------|
| 1 | Demo | 4–6 | brand.md avatar roster |
| 2 | Awareness stage | 4 | Schwartz, gated by `--awareness=` |
| 3 | Creative angle | 10 | `merlin-content` canon |
| 4 | Ad-type module | 7 | `merlin-content` canon |
| 5 | Hook archetype | 10 | `merlin-content` canon |
| 6 | Aspect ratio | 3 | `9:16` · `1:1` · `4:5` |
| 7 | Emotional register | 8 | per brand.md persona |
| 8 | varyDimension | 5 | `auto` · `scenario` · `lighting` · `subject` · `mood` (passed to mcp__merlin__content for Andromeda axis rotation when imageCount > 1) |

### Hard sampling rules

- **No repeated `(demo, creative angle, ad-type module)` triple** in the same run — that 3-tuple is what most determines audience read
- **`forbidden_angles` from brand.md = hard veto**; never sample
- **At-least-once-each on creative angles** before any reuse (forces breadth across the 10)
- **At-least-once-each on ad-type modules** before any reuse (forces breadth across the 7)
- **Awareness distribution** matches `--awareness=`; default `cold` = 80% problem-aware / 20% unaware; `all` = 60/30/10 cold/warm/hot
- **Demo distribution** honors brand-manifest avatar weights; if absent, even split across roster
- **Aspect distribution** balanced across `--ratio=` set; weight 9:16 toward UGC + Talking-Head, 1:1 toward Hero, 4:5 toward Lifestyle/Talking-Head

### Soft biases

- Match emotional register to demo voice (per brand.md persona)
- Match ad-type module to format intent (UGC → 9:16; Hero → 1:1 + 4:5; Talking-Head → 4:5 + 9:16; SaaS → 16:9 or 1:1)
- Match `varyDimension` to angle cluster (mechanism/insider angles → `subject`; identity_shift/social_proof_pivot → `mood`; hidden_cost/failed_solution → `scenario`)
- Honor `preferred_angles` from brand.md (sample these first to satisfy at-least-once)

### Matrix integrity check (silent)

Before drafting any brief, generate the matrix as an internal table — N rows × 8 axis values — and inspect for collapse:

- ≤2 distinct values on any axis across the run = re-sample that axis
- Three or more `(demo, awareness)` pairs collapsed onto the same angle = re-sample
- Brand-manifest's `visual_direction.do_not_use` reflected as a banned aesthetic in every brief's negative-anchor list

This is reasoning, not output. Nothing reaches the chat.

---

## Arguments

`$ARGUMENTS` parsed for:

| Token | Default | Meaning |
|-------|---------|---------|
| First numeric (5–60) | `30` | Variant count |
| `--medium=image\|video\|mixed` | `mixed` | Default mixed = 60% image / 40% video |
| `--demo=<csv>` | from brand.md | Avatar slugs to fan across; even split if absent |
| `--awareness=cold\|warm\|hot\|all` | `cold` | Schwartz funnel slot |
| `--angle=<csv>` | matrix-sampled | Restrict to specific creative angles |
| `--format=<csv>` | matrix-sampled | Restrict to specific ad-type modules |
| `--ratio=9:16,1:1,4:5` | all | Aspects to mix |
| `--products=<csv>` | all | Restrict to specific product slugs |
| `--theme="..."` | none | Free-form thematic frame (e.g. `"3pm cliff"`) |
| `--platform=meta\|tiktok\|reel\|feed\|stories` | inferred | Sets `platformNative` default |
| `--show-briefs` | off | Override the silent contract — emit per-variant text blocks alongside the gallery (debug / brief-export use case) |

**Examples:**
- `merlin-creative-engine 30` → 30 mixed-medium variants, all demos, cold funnel
- `merlin-creative-engine 50 --medium=image --awareness=cold` → 50 cold-prospecting static ads
- `merlin-creative-engine 12 --medium=image --demo=urban-30s-woman --theme="apartment-becomes-yours"` → APOTHEKE-style focused fan-out
- `merlin-creative-engine 40 --awareness=warm,hot --demo=students` → 40 student-segment retargeting variants

---

## Phase 2 — Compose briefs + render in parallel (silent + autonomous)

**This is where the old skill emitted text blocks. The new skill renders directly.**

For each matrix row, compose the brief internally using `merlin-content`'s 7-lock template + chosen ad-type module + AdBrief 4 camouflage fields. Then immediately invoke the appropriate generation tool with the brief packed into the prompt.

### Per-variant invocation (one call per row)

**Image variants** — `mcp__merlin__content`:

```js
mcp__merlin__content({
  action: "image",
  brand: "<brand>",
  productSlug: "<product>",                                  // matrix row's product
  productRefPath: "products/<product>/references/<file>",    // FROM brand-manifest canonical assets — REQUIRED
  compositeMode: true,                                        // REQUIRED — banana-pro-edit composites the real product photo
  imagePrompt: "<full brief packed as one string>",
  imageFormat: "<portrait | square | landscape>",            // matrix row's aspect
  imageModel: "banana-pro-edit",                              // hard default; never substitute
  imageCount: <1-3>,                                          // 1 = single hero output; 2-3 = Andromeda axis rotation around the same brief
  varyDimension: "<auto | scenario | lighting | subject | mood>",  // matrix row's axis-8 value
  creativeAngle: "<one of 10 from merlin-content>",          // for telemetry binding
  hookArchetype: "<one of 10 from merlin-content>",          // for telemetry binding
  adTypeModule: "<one of 7 from merlin-content>",            // for telemetry binding
  schwartzLevel: "<unaware|problem-aware|solution-aware|product-aware|most-aware>",
  emotionalRegister: "<...>",
  variantOf: "<run-id>",                                      // optional — group all N variants under one run id for archive filtering
  skipSlack: true
})
```

**Video variants** (non-talking-head) — `mcp__merlin__video`:

```js
mcp__merlin__video({
  action: "generate",
  mode: "<ugc | product-showcase>",
  brand: "<brand>",
  productHook: "<full brief packed as one string>",
  duration: <5-15>,
  referencesDir: "assets/brands/<brand>/products/<product>/references/"
  // falModel default: seedance-2; never substitute
})
```

**Talking-head variants** (REQUIRED for any face-in-frame) — `mcp__merlin__video`:

```js
mcp__merlin__video({
  action: "heygen-agent",                                     // NEVER fal/seedance — face morphing
  prompt: "<full brief packed as one string>",
  orientation: "<portrait | landscape | square>"
})
```

### Parallel fan-out

Per CLAUDE.md's Parallelism Standard: BATCH > PARALLEL > SERIAL. Use parallel tool calls — do NOT sequence variants. The fal.ai concurrency cap (3) and HeyGen (2) are enforced at the binary's preflight layer, so you can fire all N tool calls in one turn and they'll back-pressure cleanly. The chat-status spinner shows progress; no per-variant chat noise.

**Each variant is one tool call.** Per-variant `imageCount: 1` is the default (one hero output per brief). Set `imageCount: 2-3` only when the brief itself is strong enough that Andromeda axis rotation around it adds variety beyond what the matrix already produces — that's a brief-quality judgment call, not a default.

### Audit at compose time (silent, blocking)

The audit happens INSIDE the variant loop, BEFORE the tool call fires. A failed audit = re-draft or re-sample before invoking; the engine ships ZERO known-fail variants.

#### HARD blocks (re-draft or replace; never call the tool)

- EvaluateBrief band F → re-draft from a different angle
- Copy Quality Gate average <70 OR AI detector ≥40% → re-draft
- Banned vocab ≥3 hits (per merlin-content banned list) → re-draft
- Disease claim or invented expert (FDA/FTC bright lines) → re-draft
- Missing `productRefPath` (brand-manifest canonical asset) when product is in frame → fix path
- `visual_direction.do_not_use` breach (e.g. dollar-store aesthetic on premium-playful brand) → re-draft
- `forbidden_angles` selected (matrix sampling bug) → re-sample that row
- Talking-face routed to fal/seedance instead of HeyGen → re-route to heygen-agent
- Pixel-perfect logo / ≥8-word legible copy in fal-rendered frame → composite real assets via banana-pro-edit (never raw fal text)

#### SOFT flags (note in image metadata, don't block)

- EvaluateBrief band C/D — record band in metadata, ship the variant
- Three-layer proof stack <2/3 layers (personal · social · authority)
- Aspect mismatched with module
- 1–2 banned-vocab hits

---

## Phase 3 — Render gallery (chat output)

The binary's image pipeline emits an `emitArtifactBundle` block at the end of each `mcp__merlin__content` call (see `autocmo-core/artifact_emit.go`). The renderer's `__transformChatGalleries` hook picks those up and renders the cards. Multiple parallel calls = multiple bundles = multiple gallery cards in the chat — no work needed in this skill.

**The ONLY chat output from this skill** (in order):

1. **Status line** (one):
   ```
   Fanning out 12 APOTHEKE variants — generating images...
   ```
   Format: `Fanning out <N> <brand> variants — generating <medium>...`. Drop the brand if it's irrelevant (e.g. a multi-brand run). Drop "<medium>" if mixed.

2. **The gallery** (rendered automatically by the artifact emit). One card per variant. The user clicks a card to open the full-screen viewer with brief metadata.

3. **Optional: a one-line summary footer** ONLY if `--show-briefs` is set OR the run had a >20% MEDIUM/LOW confidence rate worth flagging:
   ```
   12 of 12 generated · 10 angles touched · 5 mechanisms rotated · 100% HIGH confidence
   ```
   Otherwise skip — silence is the default.

**Do NOT emit** (unless `--show-briefs`):
- BRAND MODEL summary
- Hard rules / matrix integrity declaration
- Per-variant `VARIANT 03 of 30` blocks
- The full run-summary footer with ASCII bars
- The "next-step actions" enumeration

The user sees creatives. Everything else is noise relative to the actual deliverable.

---

## Phase 4 — Per-variant brief in image metadata

The binary's `ArtifactItem` struct carries optional brief metadata that the renderer surfaces when the user clicks into a card. When invoking `mcp__merlin__content`, populate (where the schema supports it):

- `creativeAngle` — for telemetry binding to wisdom-api
- `hookArchetype` — same
- `adTypeModule` — same
- `schwartzLevel` — same
- `emotionalRegister` — same
- `variantOf` — group all N under a run-id

The renderer can render a small "ⓘ" badge on each card; click reveals the brief. Implementation note: if the schema doesn't yet carry a `briefNotes` field, the chat-bubble metadata pane is the fallback (already wired). The user can always ask "show me the brief for variant 7" and Claude reconstructs from the matrix row + the rendered image's filename.

---

## Phase 5 — Diversity audit (silent unless flagging)

After all N tool calls return successfully, sweep:

- **Angle coverage** — distinct creative angles. Target ≥7 of 10 at N=30; ≥9 of 10 at N=50.
- **Module coverage** — distinct ad-type modules. Target ≥5 of 7 at N=30.
- **Awareness coverage** — distinct stages used. Target ≥3 of 4 when `--awareness=all`.
- **Mechanism rotation** — count problem-side mechanisms agitated. Target ≥4 distinct.
- **Confidence distribution** — target ≥80% HIGH-confidence briefs.
- **Render success rate** — target 100%; surface failures in the optional footer.

If any axis collapsed, the matrix-integrity check in Phase 1 should have caught it — emit a one-line WARN in chat ("⚠️ angle coverage 6/10 — consider re-running with `--angle=hidden_cost,objection_first`") and surface the run-id so the user can re-run.

If everything's clean, **stay silent**. The user's already looking at 12 creatives.

---

## Hard rules (operational summary)

1. **Phase 0 brand-model load is silent.** No BRAND MODEL paragraph emitted to chat unless `--show-briefs`.
2. **Output to chat = one status line + the gallery.** Per-variant briefs and matrix detail are computed but not echoed.
3. **`productRefPath` (from brand-manifest canonical assets) on every product-bearing call.** brand-manifest violation prefix is `mcp__merlin__content: brand_manifest_violation:` — fix at compose-time.
4. **`compositeMode: true` mandatory** when product is in frame — banana-pro-edit composites the real product photo, never hallucinates.
5. **Default models: `banana-pro-edit` (image), `seedance-2` (video), `heygen-agent` (talking-head).** Never substitute silently.
6. **`imageCount: 1` per variant by default.** Set 2-3 only when Andromeda axis rotation adds value beyond matrix breadth.
7. **EvaluateBrief band ≥B at compose-time.** Bands C/D get one revision pass; F re-drafts from scratch.
8. **Copy Quality Gate AI-detector <40% AND banned-vocab <3 at compose-time.** Hard blocks.
9. **`forbidden_angles` from brand.md is a hard veto.** Never sample.
10. **Parallel fan-out per CLAUDE.md Parallelism Standard.** All N tool calls in one turn — the binary's rate-limit preflight back-pressures.
11. **Diversity audit runs after fan-out.** Silent on pass; one-line WARN on collapse.
12. **`--show-briefs` is the escape hatch.** Power users who want the verbose output get it on demand.

---

## Cross-references

- **Foundations** → `merlin-content` (7 locks · ad-type modules · 10 angles · 10 hooks · AdBrief · EvaluateBrief · Copy Quality Gate · vendor cards · realism gradient · 6 technical anchors)
- **Brand model** → `merlin-brand-guide` + `assets/brands/<brand>/brand-manifest.json` + `assets/brands/<brand>/brand.md` (manifest auto-scaffolded by host on brand_activate since v1.21.23)
- **Per-variant Andromeda expansion** → `merlin-content` `imageCount` + `varyDimension`
- **Promotion Gate (post-launch winner detection)** → `merlin-ads`
- **Wisdom feedback loop (top performers' angle/module/hook → memory.md ## What Works)** → `merlin-analytics`
- **Asset organization (inbox routing)** → `mcp__merlin__bulk_upload`

---

## What changed from the prior version

The original skill emitted a verbose text-brief block per variant, requiring the user to scroll a mile of plan before seeing any creative. The 2026-05-04 user feedback was unambiguous: *"please do not show the full details, the user will only need to see the creatives. All of the copy/details can be hidden until the images are shown. The priority is to make it super simple so claude/merlin handle ALL of the andromeda friendly mass creative generation (uber premium quality)."*

This rewrite preserves every quality gate (matrix sampling rules, EvaluateBrief audit, Copy Quality Gate, forbidden_angles veto, brand-manifest enforcement, model defaults) but inverts the output contract: chat sees a one-line status and the final gallery; everything else is computed silently. Power users can still get the verbose output via `--show-briefs`.
