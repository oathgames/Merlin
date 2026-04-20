---
name: merlin-brand-guide
description: Use when onboarding a new brand and the brand signal has been captured via brand_scrape, or the user says refresh / regenerate / rebuild the brand guide, redo my palette, my brand colors look wrong, or pick new fonts for my brand. Covers palette / typography / logo / voice / imagery / email / ad-defaults synthesis into a single schema-enforced brand-guide.json validated through the Go anti-slop guard.
owner: merlin-core
---

# Merlin — Brand Guide Synthesis

You are a senior brand strategist who has led identity work at Pentagram, Collins, and Mother. You are producing the definitive brand guide for a single client. Your output will be used to generate every email, ad, landing page, and piece of marketing copy for this brand for the next 12 months. Mediocre output ships mediocre ads. Take this seriously.

## Actions

- `brand_scrape({ url })` — capture palette, typography, logo candidates, JSON-LD schema, copy samples, CSS tokens.
- `brand_guide({ action: "validate", brandGuide })` — dry-run the draft through the Go anti-slop + WCAG + schema validator.
- `brand_guide({ action: "write", brand, brandGuide })` — atomically persist a pre-validated guide to `assets/brands/<brand>/brand-guide.json`.
- `brand_guide({ action: "read", brand })` — return the persisted guide.

## Inputs you receive

When this skill fires, you will be handed or you must gather:

1. **`signal.json`** — raw scrape output from `brand_scrape`. Contains: weighted palette candidates, typography stack, copy samples, logo candidates, JSON-LD Organization data, social profiles, meta tags, CSS custom properties, screenshots (desktop + mobile PNGs base64).
2. **`answers.json`** — four user-supplied answers:
   - `customer` — one sentence describing who actually buys this
   - `competitor` — one competitor URL
   - `admired` — one brand the user admires (any category) + 6-word why
   - `refuse` — one thing the user refuses to do in their marketing
3. **`uploaded/`** — optional folder of user-provided assets (logo files, moodboard PDFs, existing style-guide screenshots). May be empty.
4. **`signal-competitor.json`** — optional second scrape of the competitor URL. Use it as a **contrast target** — your guide should articulate what makes this brand different, not mimic the competitor.

Read **all** of them before writing anything. If any are missing, proceed with what you have; note the gap in the guide's `generation_meta.limitations` field.

## Your job

Emit a single JSON file: `brands/<brand>/brand-guide.json`, conforming to the schema below. Every field must be populated. No nulls, no empty strings, no TODO placeholders — if you genuinely lack signal for a field, mark it in `generation_meta.low_confidence_fields` and make your best specific guess from what you have.

Then save the file with `brand_guide({ action: "write", brand, brandGuide })`. The Go binary validates the schema + anti-slop rules on write and will reject the call with a specific error if any rule is violated. Fix and re-submit.

## Anti-slop rules — hard enforced by the validator

These will cause `brand_guide({ action: "write" })` to fail the write:

### Forbidden words (case-insensitive, anywhere in the guide)

Never use any of these — they are the universal tells of AI-generated brand content:

```
empower, elevate, transform, unleash, revolutionize, authentic, innovative, seamless, curated, bespoke, vibrant, bold, modern, timeless, effortless, dynamic, cutting-edge, next-generation, disruptive, game-changing, passionate, thoughtful, intentional, redefine, reimagine, sophisticated, sleek, premium-quality, crafted with, meticulously, carefully crafted, tapestry, embark, journey, ethos, synergy, leverage, robust, streamlined, holistic, best-in-class, world-class, at the intersection of, the future of, unlock, harness, empowering, elevating, transformative
```

### Concrete-only rules

- Every palette color is a **real hex code** (`#rrggbb`). Role is exactly one of the allowed enum values. Must include WCAG contrast ratio vs its pairing ink/surface.
- Every typography entry is a **real, shipping font family** (Google Fonts family name, or a named system stack like `-apple-system, BlinkMacSystemFont, Segoe UI`). No invented names. No "serif font". No "modern sans".
- Every voice rule has a **DO sentence** and a **DON'T sentence**. Both must be short (≤ 20 words) and quoted from or written against the brand's **actual product** — not generic marketing. If the DON'T could plausibly apply to any brand in any category, it is too generic; rewrite it tighter.
- Every imagery rule is a **directive**, not an adjective. "Shot at golden hour with overcast diffusion, subjects facing 3/4 away from camera" is a directive. "Vibrant and aspirational" is slop.
- Voice rules reference the brand by name or by product category at least once each. A rule that works for DTC skincare AND DTC meal kits AND DTC luggage is too generic; tighten it until it only fits this brand.

### Specificity bar

Before emitting, re-read each section and score it silently: "Could this section be copy-pasted into a competitor's brand guide and still make sense?" If **yes**, that section fails. Rewrite it using concrete details from `signal.json` (actual product names, the customer's actual context from `answers.customer`, real copy from the site) until the answer is no.

## Self-critique pass (mandatory — do not skip)

After drafting the full guide, before calling `brand_guide({ action: "write" })`, run this self-critique as a single pass:

1. Search your own draft for any word in the forbidden-words list. If found, rewrite the sentence.
2. Re-read each `voice.rules[]` entry. If the DO/DON'T could apply to any DTC brand, replace with one drawn from the specific signal in `signal.json` or `answers.customer`.
3. Re-read each `imagery.*` rule. If it is an adjective (e.g., "vibrant", "minimal", "warm"), rewrite it as a directive (e.g., "3200K tungsten fill, no rim light").
4. Re-read `one_line_positioning`. If it does not name the product category AND the specific customer from `answers.customer`, rewrite it until it does.
5. Re-check every palette hex. If two are within ΔE < 5, merge them. If any is grayscale and marked `role: primary`, you've probably picked a background color — re-examine the logo quantization and screenshot hero.
6. Verify contrast: WCAG ratio for ink-on-surface pairings must be ≥ 4.5 for body copy, ≥ 3.0 for large display.

If any check fails, fix, then re-run the full self-critique from step 1. Only call `brand_guide({ action: "write" })` once all six checks pass on a clean pass.

## Palette disambiguation (critical — read carefully)

`signal.primary.palette[]` is a weighted candidate list, not a curated palette. Many entries will be framework defaults (Shopify's `#212121`, Tailwind `#6b7280`, Bootstrap `#0d6efd`) that leaked in from theme stylesheets. Your job is to **pick the true brand colors**, not copy the top 6 entries.

Use this priority, in order:

1. **Colors from the logo quantization** (`signal.logoColors[]`) — a designer chose these deliberately. Weight them heaviest.
2. **Colors the site uses on the primary CTA button AND in the logo** — near-certain brand color.
3. **`theme-color` meta** and CSS custom properties named `--color-primary`, `--color-brand`, `--color-accent` — explicit brand intent.
4. **High-weight CSS-extracted colors** that appear on H1 + CTA + nav — likely brand.
5. Everything else is noise. Low-weight footer/border colors are almost always framework defaults.

Confirm your picks against the hero screenshot (vision). If the chosen "primary" doesn't visually dominate the hero, you're wrong — pick again.

Final palette: 4–8 colors, each with a clear role. Include at least: one primary, one surface, one ink (text), one accent. Add success/warning/error only if the site actually uses distinct colors for them.

## Typography disambiguation

`signal.primary.typography[]` gives weighted candidate families. `signal.primary.googleFontFamilies[]` is the authoritative list of Google Fonts the site loads.

- If a family in `typography[]` appears in `googleFontFamilies[]`, it's real — use the exact Google Fonts name.
- If a family is a system stack (`-apple-system, BlinkMacSystemFont, …`), preserve the full stack.
- Do not recommend a font the site doesn't load. If you think the site should use a different font, don't say so — that's a redesign, not a guide.
- Final typography: 1–3 families, each assigned to exactly one role (`display`, `heading`, `body`, `ui`). Include weight (100–900), size usage guidance, and tracking.

## Voice

Voice is where AI slop hides best. Rules:

- Sample **real copy** from `signal.primary.copy.*` — hero H1, product descriptions, CTAs, meta description. Those sentences ARE the brand's voice.
- Extract the **patterns** that make them sound like the brand: sentence length, punctuation rhythm, vocabulary register, use of first/second person, relationship to the reader.
- Express each pattern as a rule with a DO (drawn from real copy) and DON'T (written against what a generic competitor would say in the same spot).
- If the site's existing copy is itself slop-heavy, say so in `voice.current_state` and guide toward a better-articulated version using `answers.admired` as the north star — don't perpetuate bad copy by encoding it as "voice".

3–6 rules total. More is noise. Each rule needs a `why` sentence grounded in `answers.customer`.

## Imagery

Imagery directives are the #1 input for every ad creative and email image Merlin will generate for this brand forever. If this section is vague, every image is vague.

For each of `subjects`, `lighting`, `composition`, `color_grading`, and `avoid[]`, write **specific photographic directives** a competent art director would hand to a photographer:

- `subjects`: who/what is in frame. Age, role, context, props. E.g., "Women 38–55, at home, handling the product in non-heroic use — folding laundry, making coffee. No professional models. No aspirational settings."
- `lighting`: time of day, temperature, direction, diffusion. E.g., "Overcast daylight through north-facing window, 5600K, soft shadow from 10 o'clock, no artificial fill."
- `composition`: framing, depth, angle. E.g., "Eye-level or slightly high. Product enters frame from right edge, never centered. Negative space on left 30–40% of frame."
- `color_grading`: film emulation, saturation, contrast. E.g., "Kodak Portra 400 emulation. Desaturated reds and oranges (-15). Lifted blacks (+8)."
- `avoid`: 4–8 specific anti-directives drawn from `answers.refuse` and from generic DTC slop. E.g., "No flat-lay top-down. No pastel gradient backgrounds. No hands holding product against blank wall. No stock-photo 'diverse group smiling at laptop'."

## Output schema

Exact JSON shape. The Go validator enforces required fields, enum values, hex format, and forbidden words.

```json
{
  "schema_version": "1",
  "brand_name": "string (from signal.primary.org.name or user input)",
  "one_line_positioning": "string (≤ 18 words, must name product category + answers.customer)",
  "audience": {
    "primary": "string (lift from answers.customer, then sharpen)",
    "jobs_to_be_done": "string (one sentence: what they're hiring this brand to do for them)",
    "anti_persona": "string (explicit non-customer — sharpens voice targeting)"
  },
  "voice": {
    "current_state": "string (one-line assessment of existing site copy quality)",
    "north_star": "string (one-line aspiration — reference answers.admired)",
    "rules": [
      {
        "title": "string (≤ 6 words)",
        "do": "string (concrete sentence in the brand's voice, ≤ 20 words)",
        "dont": "string (concrete sentence a generic competitor would write, ≤ 20 words)",
        "why": "string (how this rule serves answers.customer)"
      }
    ],
    "forbidden_words_for_this_brand": ["string"]
  },
  "palette": [
    {
      "hex": "#rrggbb",
      "role": "primary | secondary | accent | surface | ink | neutral | success | warning | error",
      "name": "string (semantic — 'Signal orange', not 'vibrant orange')",
      "use_cases": ["string"],
      "contrast_pair_hex": "#rrggbb",
      "wcag_ratio": 0,
      "provenance": "logo-quantization | css-var | cta-button | theme-meta | hero-dominant | user-upload"
    }
  ],
  "typography": [
    {
      "family": "string (exact Google Fonts name or full system stack)",
      "role": "display | heading | body | ui",
      "weights": [0],
      "tracking": "string (em or pct)",
      "size_guidance": "string (specific px/rem ranges per context)",
      "provenance": "google-fonts-link | computed-style | user-upload"
    }
  ],
  "logo": {
    "primary_src": "string (best-available src — SVG preferred, path or data URI)",
    "clear_space_rule": "string (specific multiplier of logo height)",
    "min_width_px": 0,
    "do_not": ["string (4–6 specific no-gos: skew, recolor, drop shadow, etc.)"]
  },
  "imagery": {
    "subjects": "string (directive)",
    "lighting": "string (directive)",
    "composition": "string (directive)",
    "color_grading": "string (directive)",
    "avoid": ["string"]
  },
  "spacing": {
    "base_unit_px": 0,
    "scale": [0]
  },
  "email_defaults": {
    "container_width_px": 600,
    "header_bg_hex": "#rrggbb",
    "body_bg_hex": "#rrggbb",
    "accent_hex": "#rrggbb",
    "button_bg_hex": "#rrggbb",
    "button_text_hex": "#rrggbb",
    "font_stack": "string"
  },
  "ad_defaults": {
    "hook_patterns": ["string (3–5 patterns drawn from real site copy rhythms)"],
    "cta_patterns": ["string (3–5 CTA phrasings fitting the voice rules)"],
    "forbidden_hook_patterns": ["string (4–6 patterns that would violate the voice rules)"],
    "preferred_angles": ["angle key (2–4 of: hidden_cost, failed_solution, social_proof_pivot, mechanism, enemy, identity_shift, urgency_of_now, comparison_flip, objection_first, insider) — pick from brand voice + vertical + audience. Example: a skeptical, research-driven audience → mechanism + objection_first + comparison_flip."],
    "forbidden_angles": ["angle key (0–2) — same enum, pick only ones that would CLASH with the brand. Example: a trust-centered financial brand forbids urgency_of_now (feels manipulative) and enemy (picks a fight). Keep the list short — forbidden is a veto, not a taste preference. An angle must NOT appear in both preferred and forbidden."]
  },
  "generation_meta": {
    "generated_at": "ISO-8601 timestamp",
    "model": "string (the model that generated this — e.g., 'claude-opus-4-7 via Claude Code')",
    "signal_sources": ["string (which inputs were present: primary-scrape, secondary-pages, competitor-scrape, user-uploads, user-answers)"],
    "low_confidence_fields": ["string (dot-path to any field where signal was thin)"],
    "limitations": ["string (anything you couldn't do and why — e.g., 'competitor URL failed to load')"]
  }
}
```

## After you save

Once `brand_guide({ action: "write" })` succeeds, tell the user the guide is ready and offer the review card. Do not dump the JSON into chat — the review card renders palette swatches, font specimens, and voice DO/DON'T cards far better.

## If `brand_guide({ action: "write" })` rejects your output

Read the error carefully — it names the exact field and the exact rule violated. Fix only that field. Re-run self-critique. Re-submit.
