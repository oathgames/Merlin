## Discord

When the user says "connect Discord", "set up Discord", or anything Discord-related:

### Discord Login (Bot Invite)
```bash
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"discord-login"}'
```
- Opens browser to Discord's bot authorization page
- User selects which server to add Merlin to
- Bot auto-discovers text channels and selects the first one
- Sends a welcome embed to confirm the connection works
- Use `timeout: 300000` (5 minutes) for the OAuth flow

### Discord Setup (Change Channel)
If user wants to change which channel receives notifications:
```bash
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"discord-setup"}'
```
Returns a list of text channels. Set `discordChannelId` in config to the desired channel ID.

### Discord Post (Manual Message)
```bash
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"discord-post","slackMessage":"Your message here"}'
```

### Automatic Discord Notifications
When Discord is connected, Merlin automatically posts to Discord when:
- Ads are published (Meta, TikTok, Google, Amazon)
- Ads are paused or scaled
- New creatives are generated (images, videos)

No manual action needed — notifications fire alongside existing Slack webhooks.

---

## Email Marketing

When the user says "audit my email", "check email flows", "email performance", or anything email-related:

### Email Audit
Run the email audit to analyze Klaviyo setup:
```bash
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"email-audit"}'
```

The app returns JSON with: existing flows, lists, campaigns, missing essential flows, and recommendations.

Present the results as:
```
✦  Email Audit — <Brand Name>
─────────────────────────────────────────────

Subscriber Lists: X
Active Flows: X/6 essential
Recent Campaigns: X in last 30 days

Flow Coverage:
  ✓ Welcome Series         ← active
  ✓ Abandoned Cart         ← active
  ✗ Browse Abandonment     ← MISSING — recovers window shoppers
  ✓ Post-Purchase          ← active
  ✗ Win-back               ← MISSING — re-engages lapsed buyers
  ✗ Sunset                 ← MISSING — protects deliverability

Recommendations:
  1. Set up Browse Abandonment — triggers when someone views
     a product but doesn't add to cart. Lower intent but high volume.
  2. Set up Win-back — re-engage customers silent for 60-90 days.
  3. ...
```

If `klaviyoApiKey` is not configured, ask: "Want to connect Klaviyo for email marketing? I'll need your API key from Klaviyo → Settings → API Keys."

### Essential DTC Email Flows
These 6 flows are the foundation. When recommending them, explain:

1. **Welcome Series** (3 emails over 5 days): Welcome + brand story → bestsellers showcase → social proof + first-purchase discount
2. **Abandoned Cart** (3 emails): Reminder (1hr) → social proof (24hr) → urgency/discount (48hr)
3. **Browse Abandonment** (2 emails): "Still looking?" (4hr) → related products (24hr)
4. **Post-Purchase** (3 emails): Thank you + order details → how to use/style → review request (14 days)
5. **Win-back** (3 emails): "We miss you" (60 days) → bestsellers update (75 days) → final discount (90 days)
6. **Sunset** (2 emails): "Still interested?" (90 days no opens) → final chance before suppression (120 days)

## Google Ads

**One-click OAuth — same pattern as Meta:**
Run the app's google-login action (use 5-minute timeout):
```
Bash({ command: '.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd \'{"action":"google-login"}\'', timeout: 300000 })
```
The app opens Google OAuth, user authorizes, token + customer ID are returned.
Save `googleAccessToken`, `googleRefreshToken`, and `googleAdsCustomerId` to config.

**Note:** The user also needs a Google Ads developer token from ads.google.com/aw/apicenter. Save it as `googleAdsDeveloperToken` in config. Without it, API calls will fail.

### Campaign setup
After connecting, set up Testing + Scaling campaigns:
```
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"google-ads-setup"}'
```
This creates two Performance Max campaigns: "Merlin - Testing" ($5/day) and "Merlin - Scaling" ($20/day).

### Publishing ads
```
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"google-ads-push","imagePath":"results/image.png","adHeadline":"Shop Now|Free Shipping|Best Price","adBody":"Premium quality products|Shop the collection","finalUrl":"https://example.com","dailyBudget":5}'
```
Headlines and descriptions use `|` delimiter for multiple values. Google requires 3-15 headlines and 2-4 descriptions.

### Performance review
```
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"google-ads-insights"}'
```
Returns yesterday's metrics per campaign with verdicts (WINNER/LOSER/KILL/OK). Use these to kill losers and scale winners, same as Meta.

### Kill / Scale
```
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"google-ads-kill","campaignId":"12345678"}'
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"google-ads-duplicate","campaignId":"12345678","targetCampaign":"Merlin - Scaling"}'
```

## Amazon (Ads + Seller)

**One-click OAuth** (use 5-minute timeout):
```
Bash({ command: '.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd \'{"action":"amazon-login"}\'', timeout: 300000 })
```
Save `amazonAccessToken`, `amazonRefreshToken`, `amazonProfileId`, `amazonSellerId` to config.

### Campaign setup
```
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"amazon-ads-setup"}'
```
Creates "Merlin - Testing" (manual targeting, $10/day) and "Merlin - Scaling" (auto targeting, $50/day) Sponsored Products campaigns.

### Publishing ads
```
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"amazon-ads-push","campaignId":"...","adGroupName":"SP - Product Name","keywords":["keyword1","keyword2"],"defaultBid":0.75}'
```

### Performance review
```
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"amazon-ads-insights"}'
```
Returns campaign metrics with ACOS, ROAS, and WINNER/LOSER/KILL verdicts.

### Kill / Scale
```
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"amazon-ads-kill","campaignId":"..."}'
```

### Product management
```
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"amazon-products"}'
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"amazon-orders","days":7}'
```

## Marketing Calendar

When the user says "marketing calendar", "plan my content", "launch schedule", or anything calendar-related:

### Step 1: Analyze Launch Cadence
If Shopify is connected, pull product launch data:
```bash
.claude/tools/Merlin.exe --config .claude/tools/merlin-config.json --cmd '{"action":"calendar"}'
```

The app returns: launch history, average cadence, seasonal signals, and gaps.

### Step 2: Present the Analysis
```
✦  Marketing Calendar Analysis — <Brand>
─────────────────────────────────────────────────

Product Catalog: 24 products across 5 categories
Launch Cadence: ~1 new product every 18 days
Most Active: March (6 launches) | Least Active: July (0 launches)
Last Launch: 12 days ago (Bonefish Blues Hoodie)
Next Predicted: ~6 days from now

Seasonal Signals:
  • Summer collection detected (June-August tags)
  • Holiday products detected (November-December)

Gaps:
  • No launches planned for July — historically your quietest month
  • No Valentine's Day products detected
```

### Step 3: Propose a Calendar
Based on the analysis, generate a 30-day marketing calendar:

```
✦  Proposed 30-Day Calendar — <Brand>
─────────────────────────────────────────────────

Week 1:
  Mon  - Product spotlight: [recent launch] (image ad + blog post)
  Wed  - Lifestyle content: [seasonal topic] (image ad)
  Fri  - UGC/testimonial style (talking-head or product-showcase)

Week 2:
  Mon  - Blog post: [SEO topic from content gaps]
  Wed  - Product spotlight: [rotate to different product]
  Fri  - Competitor-inspired angle (based on competitor scan)

Week 3:
  Mon  - Email campaign: [product roundup or seasonal theme]
  Wed  - New product tease (if launch predicted)
  Fri  - Performance review + double down on winners

Week 4:
  Mon  - Blog post: [lifestyle/culture angle]
  Wed  - Retarget last month's best performer
  Fri  - Monthly digest + plan next month

Channels per piece:
  • Every image → Meta Testing + TikTok Testing
  • Every blog → Shopify + email newsletter
  • Winners from Week 1-2 → scale in Week 3-4
```

Ask: "Want me to set this up as your daily schedule? I'll generate the right content on the right days automatically."

If yes, update the merlin-daily scheduled task prompt to follow the calendar pattern instead of random product selection.
