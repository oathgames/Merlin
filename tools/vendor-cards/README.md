# Vendor Capability Cards

Per-vendor routing cards injected into domain skills. Every integration
(HeyGen, fal, ElevenLabs, Meta, TikTok, Google Ads, Shopify, Klaviyo, …)
gets a standardized block with **Pick when / Skip when / Killer features /
Constraints / Cost / Output / Docs / Last verified** so the LLM routes to
the right tool for the right job instead of defaulting to whatever it saw
last.

## Files

| Path | Role |
|---|---|
| `vendor-capabilities.json` | **Source of truth.** Edit here. One entry per vendor. |
| `gen-vendor-cards.js` | Regenerates the `<!-- VENDOR-CARDS:BEGIN -->` / `<!-- :END -->` fenced region in each domain SKILL.md. Deterministic output. |
| `../../test/validate-vendor-cards.js` | CI validator: schema, action coverage against `autocmo-core/main.go`, hygiene (no hedge words), generator-sync. |
| `../../test/vendor-docs-drift.js` | Monthly drift detector: hashes each vendor's docs page, opens a draft PR if any page changed. |
| `../../.github/workflows/vendor-docs-drift.yml` | Scheduled workflow that runs the drift detector on the first of each month. **Runs on GitHub infrastructure — never on user machines.** |

## Workflow

### Adding a new vendor

1. Add an entry to `vendor-capabilities.json`. Required fields:
   - `name`, `skill` (must match a `.claude/skills/<skill>/SKILL.md`), `headline`
   - `actions[]` — every entry must exist as a `case "<name>":` in `autocmo-core/main.go`
   - `pick_when[]` (≥2), `skip_when[]` (≥2), `killer_features[]` (≥2)
   - `constraints`, `cost`, `output`
   - `docs_url` (https only), `last_verified` (ISO date ≤18 months old)
2. `node tools/vendor-cards/gen-vendor-cards.js` — writes the card into the right SKILL.md.
3. `node test/validate-vendor-cards.js` — confirm schema + action coverage + sync.
4. Commit both the JSON and the regenerated SKILL.md.

### Updating an existing vendor

Same loop: edit JSON → regenerate → validate → commit. `last_verified`
should be bumped whenever you materially change `pick_when` / `skip_when` /
`killer_features`.

### Drift detection (passive, background)

The `Vendor Docs Drift` workflow fires monthly, fetches each vendor's
`docs_url`, and compares a normalized hash of the page body against the
hash stored in `test/.vendor-docs-hashes.json`. When any vendor's page has
changed, the workflow opens a **draft PR** with a markdown diff report.
Ryan reviews the vendor's docs, updates the card if capabilities shifted,
bumps `last_verified`, and merges.

Drift detection is intentionally biased toward false positives. A false
positive costs ~10 seconds to review and close. A false negative means a
stale card silently routes paying users to the wrong integration.

## Design constraints

- **Zero user-machine network calls.** Cards ship to users as part of the
  normal `/update` path alongside every other SKILL.md change. Drift
  detection lives on GitHub infrastructure exclusively.
- **Cards live inside SKILL bodies**, not in frontmatter descriptions. They
  load on-demand when the LLM routes into a skill — cold-start context is
  unchanged.
- **Source JSON does not ship in the installer.** `extraResources` in
  `package.json` only bundles `.claude/` and `assets/`. `tools/` is a
  dev-only directory.
- **Fenced-region writes are gated.** The block-api-bypass hook protects
  `.claude/skills/` from mid-session edits. Regeneration is a release-time
  operation: edit JSON in a session branch → regenerate → commit → ship.
