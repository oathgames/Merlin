// Merlin MCP — Tool Definitions
//
// Each tool maps to a category of binary actions. The handler reads the
// vault, builds a temp config, spawns the binary, redacts the output,
// and returns sanitized results. Claude NEVER sees credentials.
//
// All tools receive a `context` object with shared helpers from main.js.
// No circular requires — context is injected at creation time.

'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redactOutput } = require('./mcp-redact');

// ── Shared binary runner ─────────────────────────────────────

/**
 * Spawn the Merlin binary with a sanitized temp config and return
 * redacted output. This is the ONLY path from MCP tools to the binary.
 *
 * @param {object} ctx - Context from main.js (getBinaryPath, readBrandConfig, appRoot, etc.)
 * @param {string} action - Binary action name (e.g., "meta-insights")
 * @param {object} args - MCP tool input args (mapped to Command struct fields)
 * @param {object} opts - { timeout?: number }
 * @returns {Promise<{text: string, error?: boolean}>}
 */
async function runBinary(ctx, action, args, opts = {}) {
  const binaryPath = ctx.getBinaryPath();
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    return { text: 'Merlin engine not found. Try reinstalling or running /update.', error: true };
  }

  // Build merged config with vault-resolved tokens
  const brandName = args.brand || '';
  const cfg = brandName ? ctx.readBrandConfig(brandName) : ctx.readConfig();

  // OAuth client secrets are handled server-side (BFF pattern).
  // The Go binary calls merlingotme.com/api/oauth/exchange directly.
  // No secrets are injected into the config from the Electron app.

  return new Promise((resolve) => {
    if (!cfg || Object.keys(cfg).length === 0) {
      return resolve({ text: 'No configuration found. Connect a platform first.', error: true });
    }

    // Write temp config — named .merlin-config-tmp-{hex}.json so it matches
    // the PROTECTED_COMMAND_PATTERNS regex and can't be read via cat/grep.
    const tmpName = `.merlin-config-tmp-${crypto.randomBytes(16).toString('hex')}.json`;
    const tmpPath = path.join(os.tmpdir(), tmpName);

    // Build the Command JSON from MCP args
    const cmdObj = { action };
    // Map MCP field names to binary Command struct fields
    for (const [k, v] of Object.entries(args)) {
      if (k === 'action') continue; // already set
      if (v !== undefined && v !== null && v !== '') {
        cmdObj[k] = v;
      }
    }

    try {
      fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    } catch (e) {
      return resolve({ text: `Failed to write temp config: ${e.message}`, error: true });
    }

    const timeout = opts.timeout || 300000; // 5 min default
    const child = execFile(binaryPath, ['--config', tmpPath, '--cmd', JSON.stringify(cmdObj)], {
      timeout,
      cwd: ctx.appRoot,
    }, (err, stdout, stderr) => {
      // Delete temp config IMMEDIATELY — don't wait
      try { fs.unlinkSync(tmpPath); } catch {}

      // Track for cleanup on app exit
      if (ctx.activeChildProcesses) ctx.activeChildProcesses.delete(child);

      if (err && !stdout) {
        // Binary failed with no output — redact the error message too
        const errMsg = redactOutput('', stderr || err.message);
        return resolve({ text: errMsg || 'Action failed. Try again.', error: true });
      }

      // Redact BOTH stdout and stderr
      const sanitized = redactOutput(stdout || '', stderr || '');
      resolve({ text: sanitized || 'Done.', error: err ? true : false });
    });

    if (ctx.activeChildProcesses) ctx.activeChildProcesses.add(child);
  });
}

// ── Tool builder helper ──────────────────────────────────────

/**
 * Build all tool definitions. Called from mcp-server.js with the SDK's
 * `tool` function and Zod (`z`) injected — avoids requiring them directly
 * (they come from the dynamic SDK import).
 */
function buildTools(tool, z, ctx) {
  const tools = [];

  // ── connection_status ────────────────────────────────────
  tools.push(tool(
    'connection_status',
    'Check which platforms are connected for a brand. Returns true/false per platform — never exposes tokens.',
    { brand: z.string().optional().describe('Brand name (uses active brand if omitted)') },
    async ({ brand }) => {
      try {
        const connections = ctx.getConnections(brand || '');
        const status = {};
        for (const c of connections) status[c.platform] = c.status;
        return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  ));

  // ── meta_ads ─────────────────────────────────────────────
  tools.push(tool(
    'meta_ads',
    'Manage Meta/Facebook ad campaigns — create ads, check performance, pause/scale ads, discover accounts.',
    {
      action: z.enum(['push', 'insights', 'kill', 'activate', 'duplicate', 'setup', 'discover', 'warmup', 'retarget', 'lookalike', 'setup-retargeting', 'adlib', 'catalog', 'budget', 'bulk-push', 'lockdown', 'import']).describe('The operation to perform'),
      brand: z.string().optional().describe('Brand name'),
      adId: z.string().optional().describe('Ad ID (for kill/duplicate/lockdown)'),
      campaignId: z.string().optional().describe('Target campaign ID'),
      campaignName: z.string().optional().describe('Campaign name'),
      adImagePath: z.string().optional().describe('Path to ad image'),
      adVideoPath: z.string().optional().describe('Path to ad video'),
      adHeadline: z.string().optional().describe('Ad headline text'),
      adBody: z.string().optional().describe('Ad primary text'),
      adLink: z.string().optional().describe('Destination URL'),
      dailyBudget: z.number().optional().describe('Daily budget in dollars'),
      batchCount: z.number().optional().describe('Days of data (-1=today, 7=last week, 30=last month)'),
      sortBy: z.string().optional().describe('Sort results by: spend, roas, ctr, clicks, impressions, cpc, purchases'),
      sortOrder: z.string().optional().describe('Sort order: desc (default) or asc'),
      limit: z.number().optional().describe('Max results to return (e.g. 5 for top 5)'),
      // Bulk & advanced features
      ads: z.array(z.object({ imagePath: z.string().optional(), videoPath: z.string().optional(), headline: z.string().optional(), body: z.string().optional(), link: z.string().optional(), dailyBudget: z.number().optional(), hookStyle: z.string().optional(), postId: z.string().optional() })).optional().describe('Array of ads for bulk-push (up to 50)'),
      adFormat: z.enum(['single', 'carousel', 'collection']).optional().describe('Ad format (default: single)'),
      carouselCards: z.array(z.object({ imagePath: z.string().optional(), videoPath: z.string().optional(), headline: z.string().optional(), description: z.string().optional(), link: z.string().optional() })).optional().describe('Carousel card data (2-10 cards)'),
      postId: z.string().optional().describe('Existing post ID to reuse as ad creative (preserves social proof)'),
      languages: z.array(z.string()).optional().describe('ISO 639-1 codes for multi-language variants (e.g. ["es","fr","de"])'),
      status: z.string().optional().describe('Filter by status: active, paused, all (for import)'),
    },
    async (args) => {
      const action = 'meta-' + (args.action === 'setup-retargeting' ? 'setup-retargeting' : args.action);
      const result = await runBinary(ctx, action, args);

      // After discover: parse the JSON output and auto-save the discovered
      // ad account, page, and pixel IDs to the brand config. The binary
      // prints these for "Claude to parse and write into config" — but Claude
      // can't write config files (hooks block it). So we do it here.
      if (args.action === 'discover' && !result.error && result.text) {
        try {
          // Extract JSON from the output (binary prints status lines then JSON)
          const jsonMatch = result.text.match(/\{[\s\S]*"adAccountId"[\s\S]*\}/);
          if (jsonMatch) {
            const discovered = JSON.parse(jsonMatch[0]);
            const brandName = args.brand || '';
            const updates = {};
            if (discovered.adAccountId) updates.metaAdAccountId = discovered.adAccountId;
            if (discovered.pageId) updates.metaPageId = discovered.pageId;
            if (discovered.pixelId) updates.metaPixelId = discovered.pixelId;
            if (Object.keys(updates).length > 0) {
              if (brandName) {
                ctx.writeBrandTokens(brandName, updates);
              } else {
                const cfg = ctx.readConfig();
                Object.assign(cfg, updates);
                ctx.writeConfig(cfg);
              }
            }
          }
        } catch (e) {
          console.error('[meta-discover] Failed to auto-save IDs:', e.message);
        }
      }

      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    },
    { annotations: { destructive: true } }
  ));

  // ── tiktok_ads ───────────────────────────────────────────
  tools.push(tool(
    'tiktok_ads',
    'Manage TikTok ad campaigns — create ads, check performance, pause/scale ads.',
    {
      action: z.enum(['push', 'insights', 'kill', 'duplicate', 'setup', 'lookalike']).describe('The operation to perform'),
      brand: z.string().optional(),
      adId: z.string().optional(),
      campaignId: z.string().optional(),
      dailyBudget: z.number().optional(),
      adImagePath: z.string().optional(),
      adVideoPath: z.string().optional(),
      adHeadline: z.string().optional(),
      adBody: z.string().optional(),
      adLink: z.string().optional(),
      batchCount: z.number().optional().describe('Days of data (-1=today, 7=last week, 30=last month)'),
      sortBy: z.string().optional().describe('Sort results by: spend, roas, ctr, clicks'),
      limit: z.number().optional().describe('Max results to return'),
    },
    async (args) => {
      const result = await runBinary(ctx, 'tiktok-' + args.action, args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── google_ads ───────────────────────────────────────────
  tools.push(tool(
    'google_ads',
    'Manage Google Ads campaigns — create, check performance, pause/scale.',
    {
      action: z.enum(['push', 'insights', 'kill', 'duplicate', 'setup', 'status']).describe('Operation'),
      brand: z.string().optional(),
      adId: z.string().optional(),
      campaignId: z.string().optional(),
      adImagePath: z.string().optional(),
      adHeadline: z.string().optional(),
      adBody: z.string().optional(),
      adLink: z.string().optional().describe('Final URL'),
      dailyBudget: z.number().optional(),
      batchCount: z.number().optional().describe('Days of data (-1=today, 7=last week, 30=last month)'),
      sortBy: z.string().optional().describe('Sort results by: spend, roas, ctr, clicks, conversions'),
      limit: z.number().optional().describe('Max results to return'),
    },
    async (args) => {
      const result = await runBinary(ctx, 'google-ads-' + args.action, args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── amazon_ads ───────────────────────────────────────────
  tools.push(tool(
    'amazon_ads',
    'Manage Amazon Advertising — Sponsored Products, orders, product status.',
    {
      action: z.enum(['push', 'insights', 'kill', 'setup', 'status', 'products', 'orders']).describe('Operation'),
      brand: z.string().optional(),
      adId: z.string().optional(),
      campaignId: z.string().optional(),
      dailyBudget: z.number().optional(),
      batchCount: z.number().optional().describe('Days of data'),
    },
    async (args) => {
      const prefix = ['products', 'orders'].includes(args.action) ? 'amazon-' : 'amazon-ads-';
      const result = await runBinary(ctx, prefix + args.action, args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── shopify ──────────────────────────────────────────────
  tools.push(tool(
    'shopify',
    'Shopify store data — products, orders, analytics, customer cohorts, import.',
    {
      action: z.enum(['products', 'orders', 'import', 'analytics', 'cohorts']).describe('Operation'),
      brand: z.string().optional(),
      batchCount: z.number().optional().describe('Days of data (for analytics/orders)'),
    },
    async (args) => {
      const result = await runBinary(ctx, 'shopify-' + args.action, args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── klaviyo ──────────────────────────────────────────────
  tools.push(tool(
    'klaviyo',
    'Klaviyo email marketing — performance, lists, campaigns.',
    {
      action: z.enum(['performance', 'lists', 'campaigns']).describe('Operation'),
      brand: z.string().optional(),
      batchCount: z.number().optional().describe('Days of data'),
    },
    async (args) => {
      const result = await runBinary(ctx, 'klaviyo-' + args.action, args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── email ────────────────────────────────────────────────
  tools.push(tool(
    'email',
    'Email marketing — audit email program, check revenue attribution.',
    {
      action: z.enum(['audit', 'revenue']).describe('Operation'),
      brand: z.string().optional(),
      batchCount: z.number().optional().describe('Days of data'),
    },
    async (args) => {
      const result = await runBinary(ctx, 'email-' + args.action, args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── seo ──────────────────────────────────────────────────
  tools.push(tool(
    'seo',
    'SEO tools — audit, keyword research, rankings, fix alt text, track rankings, find gaps.',
    {
      action: z.enum(['audit', 'keywords', 'rankings', 'fix-alt', 'track', 'gaps', 'update-rank']).describe('Operation'),
      brand: z.string().optional(),
      url: z.string().optional().describe('Target URL (for audit)'),
    },
    async (args) => {
      const actionMap = { 'fix-alt': 'seo-fix-alt', 'update-rank': 'seo-update-rank' };
      const action = actionMap[args.action] || 'seo-' + args.action;
      const result = await runBinary(ctx, action, args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── content ──────────────────────────────────────────────
  tools.push(tool(
    'content',
    'Create ad images, blog posts, social posts, and batch variations.',
    {
      action: z.enum(['image', 'batch', 'blog-post', 'blog-list', 'social-post']).describe('Operation'),
      brand: z.string().optional(),
      product: z.string().optional(),
      imagePrompt: z.string().optional().describe('Freeform image prompt'),
      imageCount: z.number().optional().describe('Number of images (1-4)'),
      imageFormat: z.string().optional().describe('"portrait", "square", or "both"'),
      imageModel: z.string().optional().describe('"flux", "ideogram", or "recraft"'),
      adBrief: z.any().optional().describe('Structured ad brief object'),
      compositeMode: z.boolean().optional().describe('Use real product photo + AI scene'),
      productRefPath: z.string().optional().describe('Path to product reference photo'),
      referenceImages: z.array(z.string()).optional(),
      referencesDir: z.string().optional(),
      templatePath: z.string().optional(),
      batchCount: z.number().optional().describe('Number of variations (for batch)'),
      blogTitle: z.string().optional(),
      blogBody: z.string().optional(),
      blogTags: z.string().optional(),
      blogImage: z.string().optional(),
      blogSummary: z.string().optional(),
      socialPlatform: z.string().optional(),
      socialCaption: z.string().optional(),
      socialImageUrl: z.string().optional(),
      socialImagePath: z.string().optional(),
    },
    async (args) => {
      const actionMap = { 'blog-post': 'blog-post', 'blog-list': 'blog-list', 'social-post': 'social-post' };
      const action = actionMap[args.action] || args.action;
      const result = await runBinary(ctx, action, args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── video ────────────────────────────────────────────────
  tools.push(tool(
    'video',
    'Generate video ads — talking head, product showcase, etc.',
    {
      brand: z.string().optional(),
      product: z.string().optional(),
      script: z.string().optional().describe('Custom script text'),
      format: z.string().optional().describe('"9:16", "16:9", or "1:1"'),
      duration: z.number().optional().describe('Duration in seconds'),
      provider: z.string().optional().describe('"fal", "veo", "arcads", "heygen"'),
      falModel: z.string().optional().describe('"kling", "veo", "seedance", "minimax", "wan"'),
      mode: z.string().optional().describe('"talking-head", "product-showcase", "auto"'),
      avatarId: z.string().optional(),
      voiceId: z.string().optional(),
      productHook: z.string().optional(),
    },
    async (args) => {
      const result = await runBinary(ctx, 'generate', args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── voice ────────────────────────────────────────────────
  tools.push(tool(
    'voice',
    'Voice management — clone voices, list available voices/avatars, delete voices.',
    {
      action: z.enum(['clone', 'list', 'delete', 'list-avatars']).describe('Operation'),
      brand: z.string().optional(),
      voiceName: z.string().optional(),
      voiceId: z.string().optional(),
      voiceSampleDir: z.string().optional(),
      deleteVoice: z.string().optional().describe('Voice ID to delete'),
    },
    async (args) => {
      const actionMap = { clone: 'clone-voice', list: 'list-voices', delete: 'delete-voice', 'list-avatars': 'list-avatars' };
      const result = await runBinary(ctx, actionMap[args.action], args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── dashboard ────────────────────────────────────────────
  tools.push(tool(
    'dashboard',
    'Analytics and intelligence — cross-platform dashboard, calendar analysis, collective wisdom, landing page audit, competitor scan.',
    {
      action: z.enum(['dashboard', 'calendar', 'wisdom', 'report', 'competitor-scan', 'landing-audit']).describe('Operation'),
      brand: z.string().optional(),
      batchCount: z.number().optional().describe('Days of data'),
      url: z.string().optional().describe('URL (for landing-audit)'),
    },
    async (args) => {
      const actionMap = { 'competitor-scan': 'competitor-scan', 'landing-audit': 'landing-audit' };
      const action = actionMap[args.action] || args.action;
      const result = await runBinary(ctx, action, args, { timeout: 60000 });
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── discord ──────────────────────────────────────────────
  tools.push(tool(
    'discord',
    'Discord notifications — set up channel, send messages.',
    {
      action: z.enum(['setup', 'post']).describe('Operation'),
      slackMessage: z.string().optional().describe('Message text (for post)'),
    },
    async (args) => {
      const result = await runBinary(ctx, 'discord-' + args.action, args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── threads ─────────────────────────────────────────────
  tools.push(tool(
    'threads',
    'Threads (Meta) — view profile, read posts, check engagement insights.',
    {
      action: z.enum(['profile', 'posts', 'insights']).describe('Operation'),
      brand: z.string().optional(),
    },
    async (args) => {
      const result = await runBinary(ctx, 'threads-' + args.action, args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── reddit_ads ───────────────────────────────────────────
  tools.push(tool(
    'reddit_ads',
    'Reddit Ads — manage campaigns, ad groups, ads, and check performance.',
    {
      action: z.enum(['accounts', 'campaigns', 'adgroups', 'ads', 'insights', 'create-campaign', 'create-ad', 'kill']).describe('Operation'),
      brand: z.string().optional(),
      campaignId: z.string().optional().describe('Campaign ID'),
      adId: z.string().optional().describe('Ad or ad group ID'),
      campaignName: z.string().optional().describe('Campaign name'),
      dailyBudget: z.number().optional().describe('Daily budget in dollars'),
      adHeadline: z.string().optional().describe('Ad headline'),
      adLink: z.string().optional().describe('Destination URL'),
      batchCount: z.number().optional().describe('Days of data (for insights)'),
    },
    async (args) => {
      const result = await runBinary(ctx, 'reddit-' + args.action, args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    },
    { annotations: { destructive: true } }
  ));

  // ── linkedin_ads ─────────────────────────────────────────
  tools.push(tool(
    'linkedin_ads',
    'LinkedIn Ads — manage campaigns, creatives, budgets, and check performance.',
    {
      action: z.enum(['accounts', 'campaigns', 'setup', 'push', 'insights', 'kill', 'duplicate', 'budget']).describe('Operation'),
      brand: z.string().optional(),
      campaignId: z.string().optional().describe('Campaign ID or URN'),
      adId: z.string().optional().describe('Creative ID or URN'),
      campaignName: z.string().optional().describe('Campaign name'),
      dailyBudget: z.number().optional().describe('Daily budget in dollars'),
      adHeadline: z.string().optional().describe('Ad headline'),
      adBody: z.string().optional().describe('Ad body text'),
      adLink: z.string().optional().describe('Destination URL'),
      batchCount: z.number().optional().describe('Days of data (for insights)'),
    },
    async (args) => {
      const result = await runBinary(ctx, 'linkedin-' + args.action, args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    },
    { annotations: { destructive: true } }
  ));

  // ── etsy ─────────────────────────────────────────────────
  tools.push(tool(
    'etsy',
    'Etsy shop management — view shop details, browse listings, check orders.',
    {
      action: z.enum(['shop', 'products', 'orders']).describe('Operation'),
      brand: z.string().optional(),
      batchCount: z.number().optional().describe('Number of results to return (max 100)'),
    },
    async (args) => {
      const result = await runBinary(ctx, 'etsy-' + args.action, args);
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── config ───────────────────────────────────────────────
  tools.push(tool(
    'config',
    'Configuration — set up API keys, verify connections, check version.',
    {
      action: z.enum(['api-key-setup', 'verify-key', 'dry-run', 'version']).describe('Operation'),
      provider: z.string().optional().describe('API provider name (for api-key-setup)'),
      apiKey: z.string().optional().describe('API key to verify'),
    },
    async (args) => {
      const action = args.action;
      const result = await runBinary(ctx, action, args, { timeout: 30000 });
      return { content: [{ type: 'text', text: result.text }], isError: result.error };
    }
  ));

  // ── platform_login ───────────────────────────────────────
  tools.push(tool(
    'platform_login',
    'Connect a platform via OAuth — opens browser for authorization. Returns success/failure only, never tokens.',
    {
      platform: z.enum(['meta', 'tiktok', 'google', 'shopify', 'amazon', 'klaviyo', 'slack', 'discord', 'etsy', 'reddit']).describe('Platform to connect'),
      brand: z.string().optional(),
      store: z.string().optional().describe('Shopify store URL or name (for shopify)'),
    },
    async (args) => {
      // Meta: App Review pending — OAuth not available. User connects via
      // manual token entry in the UI (Meta tile in Connections panel).
      if (args.platform === 'meta') {
        return { content: [{ type: 'text', text: 'Meta is currently connected via manual token entry (App Review pending). Ask the user to click the Meta tile in the Connections panel and paste their token from developers.facebook.com/tools/explorer. Then use connection_status to verify.' }] };
      }
      // Guard platforms that don't have OAuth credentials yet
      const comingSoon = ['klaviyo'];
      if (comingSoon.includes(args.platform)) {
        return { content: [{ type: 'text', text: `${args.platform} integration is coming soon — not yet available.` }] };
      }
      try {
        const extra = args.store ? { store: args.store } : undefined;
        const result = await ctx.runOAuthFlow(args.platform, args.brand || '', extra);
        if (result.error) {
          return { content: [{ type: 'text', text: `Connection failed: ${redactOutput(result.error, '')}` }], isError: true };
        }
        // NEVER return tokens. Only success status.
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, platform: args.platform }) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Connection error: ${redactOutput(e.message, '')}` }], isError: true };
      }
    }
  ));

  return tools;
}

module.exports = { buildTools, runBinary };
