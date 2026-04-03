# Merlin — Your AI CMO

Open in Claude Code. Type `/cmo`. Everything else is automatic.

The `/cmo` command handles all setup on first run:
- Downloads the binary if missing
- Creates the config file if missing
- Asks for a fal.ai API key (the only requirement)
- Walks through brand + product setup
- Sets up daily automation if wanted

## Session Protocol

### On Start
1. Scan `assets/brands/` for brands and products
2. Read active brand's `brand.md` + product's `product.md`
3. Read `memory.md` — past learnings

### On Every Run
1. Resolve brand + product from user's request
2. Load brand.md + product.md + reference photos + quality benchmarks
3. After pipeline → show output inline, get approval before posting
4. After approval → update `memory.md`

## Folder Structure

```
assets/brands/
└── <brand>/                    ← e.g., "madchill"
    ├── brand.md                ← Brand voice, audience, CTA (auto-generated)
    ├── quality-benchmark/      ← S-tier ad examples (quality bar)
    ├── voices/                 ← Voice samples for cloning
    ├── avatars/                ← Creator faces/videos
    ├── competitors.md          ← Auto-discovered competitors
    ├── seo.md                  ← SEO audit findings (if Shopify connected)
    └── products/
        └── <product>/          ← e.g., "full-zip"
            ├── references/     ← Product photos (auto-pulled from store)
            └── product.md      ← Product details (auto-generated)

results/                        ← All output (timestamped)
memory.md                       ← Learning memory (grows over time)
```

### Adding a new brand
Run `/cmo` — setup flow asks for website + writes brand.md.

### Adding a new product
Create a subfolder under `assets/brands/<brand>/products/` with a `references/` folder inside. Drop photos in it. Claude auto-generates `product.md` on first use.

## Updates
Type `/update` to check for and install new versions.
Downloads the latest binary + framework files from GitHub while preserving user data (memory.md, brand folders, config).
Backups are saved to `.merlin-backup/{version}/` before overwriting.

## How Merlin Improves Over Time
Merlin learns from anonymous, aggregated performance trends across all users.
When you check ad performance, Merlin contributes metrics like CTR and CPC
(never brand names, ad copy, or personal data) to improve recommendations for
everyone. This is what makes hook suggestions, format picks, and timing
recommendations smarter with every release.

## Key Rules
- Only `falApiKey` required to start. Everything else optional.
- Show cost estimate before running. Get confirmation.
- Show output inline before posting anywhere. `skipSlack: true` by default.
- Scheduled/automated runs skip confirmation.
- Memory compounds — every run improves the next.
- Brand-level assets (voice, avatar, quality bar) are shared across all products.
- Product-level assets (reference photos) are unique per item.

## Technical Reference (read before executing)

### Quality Gate (universal)
Every piece of content — email images, ad creatives, social posts, blog featured images — must pass through QA before use. Verify product images match reference photos. Images get full 3-attempt retry. Video gets a lighter check (script + first frame) due to cost.

### Email Templates
- 600px wide (Klaviyo standard). Table-based HTML with inline styles.
- Use the real logo PNG (downloaded during onboarding to `logo/logo.png`), never AI-generated text.
- Use real product photos from Shopify CDN, never AI-generated product shots.
- Brand colors are exact hex codes from the website's CSS (stored in `brand.md` → Brand Colors section).
- Puppeteer for HTML screenshots: set `NODE_PATH` to global npm modules path on Windows.

### Slack File Upload (3-step — the ONLY method that works)
1. `GET https://slack.com/api/files.getUploadURLExternal?filename=X&length=Y` (with query params, NOT JSON body)
2. `POST` the raw file bytes to the returned `upload_url`
3. `POST https://slack.com/api/files.completeUploadExternal` with JSON: `{files: [{id, title}], channel_id, initial_comment}`
- `files.upload` and `files.uploadV2` are deprecated and will fail.
- Bot requires scopes: `channels:read`, `channels:join`, `files:read`, `files:write`, `chat:write`.
- `files:write` alone will upload but silently fail to share to channels.

### Meta Ads API
- The Merlin app must be in **Live mode** (not Development) to create ad creatives. This is a hard Meta platform restriction.
- Campaigns, ad sets, image uploads all work in dev mode — only ad creative creation is blocked.
- Error subcode `1885183` = app in development mode. No workaround exists (page tokens, system user tokens all fail).
- `metaFindCampaign` uses URL-encoded filtering to avoid duplicate campaign creation.
- `is_adset_budget_sharing_enabled` is required on ALL campaigns (Meta v22.0+).
- CBO campaigns need `is_campaign_budget_optimization: true` + `daily_budget` at campaign level.
- On partial failure (creative/ad fails after ad set created), the ad set is auto-cleaned up.

### AI Image Generation
- fal.ai cannot produce pixel-perfect logos or text — only use for lifestyle/hero imagery.
- Always use real logos, real product photos, and real brand colors for production content.
- Brand colors extracted from website CSS custom properties (`--color-button`, `--color-foreground`, etc.) during onboarding.
