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
