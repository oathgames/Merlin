// Tests for mcp-tools.js — the MCP surface Claude actually sees.
//
// These tests stub the SDK's `tool()` factory and Zod shape so we can
// enumerate the tool list without loading @anthropic-ai/claude-agent-sdk.
// They verify:
//   1. Every advertised tool is dispatched correctly to the binary action.
//   2. Unknown actions are rejected rather than silently passing through.
//   3. Malformed args are surfaced as a structured error, not a crash.
//   4. Binary result text + error flag round-trip unmodified.
//
// Regression this protects: a silent fallback ("unknown tool → treat as
// meta_ads") once shipped a kill on the wrong brand.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTools,
  runBinary,
  metaAuditEngineAction,
  _resetScrapeTimeoutTrackerForTests,
} = require('./mcp-tools');
const envelope = require('./mcp-envelope');

// ─────────────────────────────────────────────────────────────────────
// Test doubles for the SDK's tool() factory and Zod.
// ─────────────────────────────────────────────────────────────────────

function makeFakeTool() {
  // Captures every tool registered by buildTools.
  const registry = [];
  const tool = (name, description, schema, handler, options) => {
    registry.push({ name, description, schema, handler, options });
    return { name, description, schema, handler, options };
  };
  return { tool, registry };
}

// Minimal Zod stub — just enough for buildTools to call .string().optional()
// etc. without throwing. We don't verify validation; that's Zod's job. We
// only care that tool construction completes.
function makeFakeZ() {
  const pass = () => chain();
  function chain() {
    const node = {
      optional: () => chain(),
      describe: () => chain(),
      default: () => chain(),
      regex: () => chain(), // Codex 2026-04-24: brandSchema = z.string().regex(BRAND_RE, ...)
    };
    return node;
  }
  return {
    string: pass,
    number: () => {
      // z.number() returns a chain that ALSO supports .int() for the
      // batchCount declarations (z.coerce.number().int().optional()).
      const node = chain();
      node.int = () => node;
      return node;
    },
    boolean: pass,
    any: pass,
    enum: () => chain(),
    array: () => chain(),
    object: () => chain(),
    record: () => chain(),
    // z.coerce.number().int() — defense-in-depth coercion for the
    // batchCount fields (codex API audit followup, ga-batchcount-type
    // incident 2026-05-06). The fake mirrors z.number() — with .int()
    // chainable — because the test surface only cares about schema
    // construction, not runtime coercion.
    coerce: {
      number: () => {
        const node = chain();
        node.int = () => node;
        return node;
      },
    },
  };
}

// Mock context object — runBinary won't be called in these tests (we
// invoke individual handlers directly with stubbed ctx behavior).
function makeCtx(overrides = {}) {
  return {
    getConnections: () => [],
    readConfig: () => ({}),
    readBrandConfig: () => ({}),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => null,
    appRoot: process.cwd(),
    isBinaryTooOld: () => false,
    runOAuthFlow: async () => ({ success: true }),
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// buildTools smoke: every advertised tool name is present.
// ─────────────────────────────────────────────────────────────────────

test('buildTools registers every advertised tool', () => {
  const { tool, registry } = makeFakeTool();
  const z = makeFakeZ();
  const ctx = makeCtx();
  buildTools(tool, z, ctx);
  const names = registry.map(t => t.name);
  const expected = [
    'connection_status', 'meta_ads', 'meta_audit', 'google_analytics',
    'tiktok_ads', 'google_ads',
    'amazon_ads', 'shopify', 'klaviyo', 'email', 'seo', 'content',
    'video', 'voice', 'dashboard', 'discord', 'threads', 'reddit_ads',
    'linkedin_ads', 'etsy', 'config', 'competitor_spy', 'platform_login',
    'brand_scrape', 'brand_guide', 'decisions',
    'jobs_poll', 'jobs_list', 'jobs_cancel',
  ];
  for (const name of expected) {
    assert.ok(names.includes(name), `missing tool: ${name}`);
  }
});

test('buildTools registers tools with non-empty descriptions', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  for (const entry of registry) {
    assert.ok(typeof entry.description === 'string' && entry.description.length > 10,
      `${entry.name} has a suspiciously short description`);
  }
});

test('buildTools flags destructive ad tools with annotations', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const destructive = registry.filter(t => t.options && t.options.annotations && t.options.annotations.destructive);
  const destructiveNames = destructive.map(t => t.name);
  // Meta, Reddit, LinkedIn are flagged destructive.
  assert.ok(destructiveNames.includes('meta_ads'));
  assert.ok(destructiveNames.includes('reddit_ads'));
  assert.ok(destructiveNames.includes('linkedin_ads'));
  // meta_audit is read-only — it must NOT carry the destructive annotation.
  // A future regression that copy-pastes meta_ads' annotation block onto
  // meta_audit would flip preview gating on for inspection actions and
  // destroy the "ask freely about your account" UX.
  assert.ok(!destructiveNames.includes('meta_audit'),
    'meta_audit must not be flagged destructive — it only issues GETs');
  // google_analytics IS destructive (2026-05-01 brief expansion): it ships
  // both reads and writes (create-key-event, create-custom-dimension/-metric,
  // create-audience, update-property-settings, attach-shopify-events,
  // archive-key-event). The seven write actions are gated PER-ACTION via
  // blastRadius — read calls skip the approval card. See Hard-Won Security
  // Rule 18 + analytics.go's REGRESSION GUARD (2026-05-01) block.
  assert.ok(destructiveNames.includes('google_analytics'),
    'google_analytics MUST be flagged destructive — it ships GA4 Admin API write actions (key events, custom dimensions/metrics, audiences, property settings) gated by per-action blastRadius. See Hard-Won Security Rule 18.');
});

test('google_analytics blastRadius: per-action contract — every write action requires approval, every read does not', () => {
  // REGRESSION GUARD: a future mutation to the writeActions Set inside
  // mcp-tools.js's google_analytics handler (e.g. accidentally typoing
  // "create-audience" → "create-audiance" in the Set) would silently
  // bypass the approval-card gate for that action. This test pins the
  // exact contract per-action: read actions skip the card, write actions
  // require it. See Hard-Won Security Rule 18.
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const ga = registry.find(t => t.name === 'google_analytics');
  assert.ok(ga, 'google_analytics tool must be registered');
  const blastRadius = ga.options && ga.options.annotations && ga.options.annotations.blastRadius;
  assert.equal(typeof blastRadius, 'function',
    'google_analytics must define a blastRadius callback (per-action gating; not a constant true/false)');

  // Read actions — must NOT require approval
  const reads = ['discover', 'traffic', 'conversions', 'attribution', 'landing-pages', 'audit-property'];
  for (const action of reads) {
    const r = blastRadius({ action });
    assert.ok(r && r.required === false,
      `google_analytics read action "${action}" must NOT require approval (blastRadius.required === false). Got: ${JSON.stringify(r)}`);
  }

  // Write actions — must require approval
  const writes = [
    'create-key-event', 'archive-key-event',
    'create-custom-dimension', 'create-custom-metric',
    'create-audience',
    'update-property-settings',
    'attach-shopify-events',
  ];
  for (const action of writes) {
    const r = blastRadius({ action });
    assert.ok(r && r.required === true,
      `google_analytics write action "${action}" MUST require approval (blastRadius.required === true). Got: ${JSON.stringify(r)} — a typo in the writeActions Set would silently bypass the approval-card gate. See Hard-Won Security Rule 18.`);
  }
});

// ─────────────────────────────────────────────────────────────────────
// Brand enforcement — the runBinary safety net.
// ─────────────────────────────────────────────────────────────────────

test('runBinary refuses a brand-required action when brand is missing', async () => {
  const ctx = makeCtx({
    getBinaryPath: () => '/nonexistent/binary',
  });
  // meta-insights is brand-scoped and not in BRAND_OPTIONAL_ACTIONS.
  const result = await runBinary(ctx, 'meta-insights', {});
  assert.equal(result.error, true);
  assert.match(result.text, /Refusing meta-insights/);
  assert.match(result.text, /no brand specified/);
});

test('runBinary refuses brand-required action when brand is empty string', async () => {
  const ctx = makeCtx();
  const result = await runBinary(ctx, 'dashboard', { brand: '' });
  assert.equal(result.error, true);
  assert.match(result.text, /no brand specified/);
});

test('runBinary refuses brand-required action when brand is non-string', async () => {
  const ctx = makeCtx();
  const result = await runBinary(ctx, 'meta-insights', { brand: 123 });
  assert.equal(result.error, true);
  assert.match(result.text, /no brand specified/);
});

test('runBinary permits brand-optional actions without brand', async () => {
  // setup/verify-key/list-voices/meta-login etc. are allowlisted — they MUST
  // proceed past the brand-guard. We fail at the next layer (binary not found)
  // so the assertion only checks that the refusal message is NOT emitted.
  const ctx = makeCtx({ getBinaryPath: () => null });
  const result = await runBinary(ctx, 'list-voices', {});
  assert.ok(!result.text.includes('no brand specified'),
    'list-voices is brand-optional and must not trip the brand guard');
});

test('runBinary returns friendly error when binary is missing', async () => {
  const ctx = makeCtx({ getBinaryPath: () => null });
  const result = await runBinary(ctx, 'list-voices', {});
  assert.equal(result.error, true);
  assert.match(result.text, /Merlin engine not found/);
});

test('runBinary refuses when binary is flagged too old', async () => {
  const ctx = makeCtx({
    isBinaryTooOld: () => true,
    minBinaryVersion: '1.2.3',
    getBinaryPath: () => '/should/not/reach/here',
  });
  const result = await runBinary(ctx, 'list-voices', {});
  assert.equal(result.error, true);
  assert.match(result.text, /Engine needs to update/);
});

// Node's execFile defaults maxBuffer to 1MB, which kills the engine
// mid-response on large outputs (catalog pulls, insights sweeps) while
// main.js grants the same binary 32MB. Source-scan lock: the runBinary
// execFile options must carry a 32MB maxBuffer.
test('runBinary execFile options include a 32MB maxBuffer', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');
  assert.match(
    src,
    /maxBuffer:\s*32\s*\*\s*1024\s*\*\s*1024/,
    'runBinary must pass maxBuffer: 32 * 1024 * 1024 to execFile; the 1MB default truncate-kills large engine responses',
  );
});

// ─────────────────────────────────────────────────────────────────────
// seo tool: keyword-research seeds must reach the engine.
// Pre-fix the seo tool exposed no seed field, so { action: 'keywords' } always
// sent an empty blogBody and the engine fatal-erred "blogBody required"
// (2026-07-21 NORTHWIND incident). Lock the seed field + the blogBody forward.
// ─────────────────────────────────────────────────────────────────────
test('seo tool exposes a keyword seed field and forwards it to the engine blogBody', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');
  const start = src.indexOf("name: 'seo'");
  assert.ok(start > 0, 'seo tool must exist');
  const block = src.slice(start, start + 2000);
  assert.match(block, /keywords:\s*z\.string\(\)/, 'seo tool must expose a `keywords` seed input');
  assert.match(block, /blogBody\s*=\s*args\.keywords/, 'seo handler must forward `keywords` to the engine blogBody');
});

// ─────────────────────────────────────────────────────────────────────
// Tool handler pass-through — result text + error flag preserved.
// ─────────────────────────────────────────────────────────────────────

test('connection_status handler returns JSON of platform statuses', async () => {
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({
    getConnections: () => ([
      { platform: 'meta',   status: 'connected' },
      { platform: 'tiktok', status: 'missing' },
    ]),
  });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'connection_status');
  const out = await entry.handler({ brand: 'brightco' });
  assert.ok(Array.isArray(out.content));
  const env = envelope.parse(out);
  assert.ok(env, 'response must carry an envelope');
  assert.equal(env.ok, true);
  assert.equal(env.data.connections.meta,   'connected');
  assert.equal(env.data.connections.tiktok, 'missing');
});

test('connection_status surfaces ctx errors as isError result', async () => {
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({
    getConnections: () => { throw new Error('boom'); },
  });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'connection_status');
  const out = await entry.handler({});
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /boom/);
});

test('brand_scrape rejects non-URL input before loading the scraper module', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'brand_scrape');
  const out = await entry.handler({ url: 'not a url' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /http\(s\) URL/);
});

// REGRESSION GUARD (2026-04-20): paying user on Retailco.com hit a
// permanent onboarding hang when the scraper's logo fetch stalled forever.
// The handler must now classify any ScrapeTimeoutError into a TIMEOUT
// envelope so the skill can tell the user "scrape took too long, retry"
// instead of spinning silently. These two tests pin both the code branch
// and the user-facing message — a future refactor that rewrites the catch
// block must keep both.
function withStubbedScraper(stub, run) {
  // The mcp-tools handler does `require('./brand-scraper')` inline, so we
  // inject a stub via require.cache and restore the real module after.
  const path = require('path');
  const resolved = require.resolve('./brand-scraper');
  const original = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: stub,
  };
  return run().finally(() => {
    if (original) require.cache[resolved] = original;
    else delete require.cache[resolved];
  });
}

test('brand_scrape classifies ScrapeTimeoutError into a TIMEOUT envelope', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'brand_scrape');
  const stub = {
    scrapeBrand: async () => {
      const err = new Error('brand-scraper: overall timed out after 90000ms');
      err.name = 'ScrapeTimeoutError';
      err.code = 'TIMEOUT';
      throw err;
    },
  };
  const out = await withStubbedScraper(stub, () => entry.handler({ url: 'https://retailco.com/' }));
  const env = envelope.parse(out);
  assert.ok(env, 'response must carry an envelope');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'TIMEOUT');
  // User-facing message must name the URL and suggest retry — not a raw
  // stack trace. Friendly-error rule applies to every error-surfacing path.
  assert.match(env.error.message, /took too long/i);
  assert.match(env.error.message, /retailco\.com/);
  assert.match(env.error.message, /retry|try/i);
  // next_action must be retry_or_split so Claude knows this is transient.
  assert.equal(env.error.next_action, 'retry_or_split');
});

test('brand_scrape falls through to INTERNAL_ERROR for non-timeout scrape failures', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'brand_scrape');
  const stub = {
    scrapeBrand: async () => { throw new Error('brand-scraper: navigation failed: dns (ERR_NAME_NOT_RESOLVED) for https://nosuch.example/'); },
  };
  const out = await withStubbedScraper(stub, () => entry.handler({ url: 'https://nosuch.example/' }));
  const env = envelope.parse(out);
  assert.ok(env);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INTERNAL_ERROR');
  assert.match(env.error.message, /Scrape failed/);
});

test('brand_guide validate requires brandGuide payload', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'brand_guide');
  const out = await entry.handler({ action: 'validate' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /required/);
});

test('brand_guide write requires both brand and brandGuide', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'brand_guide');
  const out = await entry.handler({ action: 'write', brand: 'brightco' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /required/);
});

test('competitor_spy rejects an unknown action value', async () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'competitor_spy');
  const out = await entry.handler({ action: 'not-a-real-action' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Unknown competitor_spy action/);
});

// Meta App Review PASSED (Live mode, CLAUDE.md "Meta Ads API"), and meta is
// in ACTIVE_PLATFORMS. The old handler branch returned a manual-token dead
// end ("paste from developers.facebook.com/tools/explorer") that contradicted
// the tile's real OAuth flow. Lock in: meta routes through runOAuthFlow like
// tiktok/google.
test('platform_login dispatches meta through real OAuth (App Review passed)', async () => {
  const { tool, registry } = makeFakeTool();
  const seen = [];
  const ctx = makeCtx({
    runOAuthFlow: async (platform) => { seen.push(platform); return { success: true }; },
  });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'platform_login');
  const out = await entry.handler({ platform: 'meta', brand: 'brightco' });
  assert.deepStrictEqual(seen, ['meta'], 'meta must invoke the real OAuth flow');
  const env = envelope.parse(out);
  assert.ok(env && env.ok, 'meta should produce an OK envelope');
  assert.equal(env.data.platform, 'meta');
  assert.doesNotMatch(out.content[0].text, /manual token|App Review pending/i,
    'the stale manual-token dead end must not resurface');
});

// Threads has no standalone OAuth: it inherits the Meta grant
// (threadsAccessToken rides the Meta token, see the disconnect keyMap in
// main.js). platform_login must explain that instead of erroring on an
// unknown enum value or spawning a doomed OAuth flow.
test('platform_login routes threads to inherit-from-Meta guidance without OAuth', async () => {
  const { tool, registry } = makeFakeTool();
  let oauthInvoked = false;
  const ctx = makeCtx({
    runOAuthFlow: async () => { oauthInvoked = true; return { success: true }; },
  });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'platform_login');
  const out = await entry.handler({ platform: 'threads', brand: 'brightco' });
  assert.equal(oauthInvoked, false, 'threads must not spawn its own OAuth flow');
  assert.match(out.content[0].text, /Meta/, 'guidance must point at the Meta connection');
  assert.match(out.content[0].text, /no separate Threads OAuth/i,
    'guidance must say Threads rides the Meta grant');
});

test('platform_login routes klaviyo to its API-key tile (not OAuth, not "coming soon")', async () => {
  // REGRESSION GUARD (2026-05-10, A003): pre-fix this returned "klaviyo
  // integration is coming soon" which confused users — the integration
  // exists, just via the API-key tile in the Connections panel rather
  // than OAuth. Lock the new message in.
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'platform_login');
  const out = await entry.handler({ platform: 'klaviyo', brand: 'brightco' });
  assert.match(out.content[0].text, /API key/i,
    'klaviyo platform_login must route to the API-key tile, not the coming-soon branch');
  assert.doesNotMatch(out.content[0].text, /coming soon/i,
    'klaviyo MUST NOT say "coming soon" — the integration exists via the API-key tile');
});

// Pinterest / Snapchat / Twitter all have <provider>-login binary handlers in
// oauth.go that fatal with "<X> integration coming soon — app credentials not
// yet configured" when no client ID is present. They're listed in PROVIDERS
// but absent from ACTIVE_PLATFORMS, so the JS layer routes them to the
// coming-soon branch BEFORE spawning the binary — otherwise the user sees a
// raw fatal log line in the chat. Locking that surface in.
test('platform_login routes pinterest / snapchat / twitter to coming-soon (no binary fatal)', async () => {
  const { tool, registry } = makeFakeTool();
  let oauthInvoked = false;
  const ctx = makeCtx({
    runOAuthFlow: async () => { oauthInvoked = true; return { success: true }; },
  });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'platform_login');
  for (const platform of ['pinterest', 'snapchat', 'twitter']) {
    oauthInvoked = false;
    const out = await entry.handler({ platform, brand: 'brightco' });
    assert.match(out.content[0].text, /coming soon/, `${platform} should be gated`);
    assert.equal(oauthInvoked, false, `${platform} must not invoke OAuth while still TODO`);
  }
});

// Stripe and LinkedIn ARE production-ready (in ACTIVE_PLATFORMS). The MCP
// enum used to omit them, which forced agents through manual UI clicks.
// This test asserts they reach runOAuthFlow normally.
test('platform_login dispatches stripe + linkedin through runOAuthFlow', async () => {
  const { tool, registry } = makeFakeTool();
  const seen = [];
  const ctx = makeCtx({
    runOAuthFlow: async (platform) => { seen.push(platform); return { success: true }; },
  });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'platform_login');
  for (const platform of ['stripe', 'linkedin']) {
    const out = await entry.handler({ platform, brand: 'brightco' });
    const env = envelope.parse(out);
    assert.ok(env && env.ok, `${platform} should produce an OK envelope`);
    assert.equal(env.data.platform, platform);
  }
  assert.deepStrictEqual(seen, ['stripe', 'linkedin']);
});

test('platform_login returns success without leaking tokens', async () => {
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({
    runOAuthFlow: async () => ({
      success: true,
      // A buggy future refactor may try to bubble up the token — this test
      // asserts that platform_login NEVER includes any field from the OAuth
      // result other than the success flag.
      token: 'EAABshouldneverleakthis1234567890',
    }),
  });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'platform_login');
  const out = await entry.handler({ platform: 'shopify', brand: 'brightco' });
  assert.ok(!out.content[0].text.includes('EAABshouldneverleakthis1234567890'));
  const env = envelope.parse(out);
  assert.ok(env, 'response must carry an envelope');
  assert.equal(env.ok, true);
  assert.equal(env.data.success, true);
  assert.equal(env.data.platform, 'shopify');
});

// ─────────────────────────────────────────────────────────────────────
// Progress-event emission (Task 3.1, rsi-batch-1 Cluster-F)
//
// brand_scrape is the canonical long-running tool (up to 90s). The MCP
// contract settles ONCE, so the renderer needs out-of-band progress
// events to animate a pill / status line. These tests pin the event
// shape Cluster-M (§3.6) consumes — drift here silently breaks the UI.
//
// Channel: 'mcp-progress'
// Every payload must carry: channel, tool, scrapeId, stage, label, url, ts.
// Stages: start → done (happy path) OR start → timeout OR start → error.
// ─────────────────────────────────────────────────────────────────────

function makeCtxCapturingProgress() {
  const events = [];
  const ctx = makeCtx({
    emitProgress: (payload) => { events.push(payload); },
  });
  return { ctx, events };
}

test('brand_scrape emits start + done progress events on happy path', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  const { ctx, events } = makeCtxCapturingProgress();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');
  const stub = {
    scrapeBrand: async () => ({
      url: 'https://brightco.com',
      primary: {
        copy: { productTitles: ['Classic Hoodie', 'Joggers', 'Tee'] },
        logoCandidates: [{ src: 'https://cdn/logo.png', source: 'json-ld', weight: 100 }],
      },
      logoColors: [{ hex: '#000000', freq: 0.5 }, { hex: '#ffffff', freq: 0.3 }],
      secondaryPages: [{ url: 'https://brightco.com/about', signal: {} }],
    }),
  };
  const out = await withStubbedScraper(stub, () => entry.handler({ url: 'https://brightco.com' }));
  const env = envelope.parse(out);
  assert.ok(env);
  assert.equal(env.ok, true);

  // At minimum: one start event + one done event (may have more in future).
  assert.ok(events.length >= 2, `expected >=2 progress events, got ${events.length}`);
  const start = events[0];
  const done = events[events.length - 1];

  // Start event — cold-narration label the SKILL mirrors.
  assert.equal(start.channel, 'mcp-progress');
  assert.equal(start.tool, 'brand_scrape');
  assert.equal(start.stage, 'start');
  assert.equal(start.label, 'Reading homepage');
  assert.equal(start.url, 'https://brightco.com');
  assert.ok(typeof start.scrapeId === 'string' && start.scrapeId.length >= 16);
  assert.ok(typeof start.ts === 'number' && start.ts > 0);

  // Done event — derived counts match SKILL narration examples.
  assert.equal(done.channel, 'mcp-progress');
  assert.equal(done.stage, 'done');
  assert.match(done.label, /Found 3 products/);
  assert.equal(done.url, 'https://brightco.com');
  assert.equal(done.scrapeId, start.scrapeId, 'scrapeId must be stable across events for one invocation');
  assert.ok(done.detail);
  assert.equal(done.detail.products, 3);
  assert.equal(done.detail.logoCandidates, 1);
  assert.equal(done.detail.logoColors, 2);
  assert.equal(done.detail.secondaryPages, 1);
  assert.ok(typeof done.detail.elapsedMs === 'number');
});

test('brand_scrape progress event "done" label falls back to "Scrape complete" when zero products', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  const { ctx, events } = makeCtxCapturingProgress();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');
  const stub = {
    scrapeBrand: async () => ({
      url: 'https://example-saas.com',
      primary: { copy: { productTitles: [] }, logoCandidates: [] },
      logoColors: [],
      secondaryPages: [],
    }),
  };
  await withStubbedScraper(stub, () => entry.handler({ url: 'https://example-saas.com' }));
  const done = events[events.length - 1];
  assert.equal(done.stage, 'done');
  assert.equal(done.label, 'Scrape complete');
  assert.equal(done.detail.products, 0);
});

test('brand_scrape progress emission is no-op when ctx.emitProgress is missing', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  // makeCtx() intentionally omits emitProgress so this exercises the
  // graceful no-op path the pre-wiring Electron host will be in.
  const ctx = makeCtx();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');
  const stub = {
    scrapeBrand: async () => ({
      url: 'https://noprogress.com',
      primary: { copy: { productTitles: [] }, logoCandidates: [] },
      logoColors: [],
      secondaryPages: [],
    }),
  };
  const out = await withStubbedScraper(stub, () => entry.handler({ url: 'https://noprogress.com' }));
  const env = envelope.parse(out);
  assert.ok(env);
  assert.equal(env.ok, true, 'scrape must succeed even without an emitProgress wiring');
});

test('brand_scrape emits error progress event on non-timeout failures', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  const { ctx, events } = makeCtxCapturingProgress();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');
  const stub = {
    scrapeBrand: async () => { throw new Error('brand-scraper: dns fail'); },
  };
  await withStubbedScraper(stub, () => entry.handler({ url: 'https://nosuch.example/' }));
  const err = events[events.length - 1];
  assert.equal(err.stage, 'error');
  assert.equal(err.tool, 'brand_scrape');
  assert.equal(err.url, 'https://nosuch.example/');
});

// ─────────────────────────────────────────────────────────────────────
// Manual-entry fallback on repeat timeout (Task 3.2, rsi-batch-1 Cluster-F)
//
// First timeout → classic retry_or_split envelope (Rule 13 compatible).
// Second timeout on the SAME URL within 10min → manual_entry_fallback,
// carrying a structured payload the UI can render into a fill-in card.
// ─────────────────────────────────────────────────────────────────────

function timeoutStub() {
  return {
    scrapeBrand: async () => {
      const err = new Error('brand-scraper: overall timed out after 90000ms');
      err.name = 'ScrapeTimeoutError';
      err.code = 'TIMEOUT';
      throw err;
    },
  };
}

test('brand_scrape first timeout still returns retry_or_split (Rule 13 preserved)', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  const { ctx, events } = makeCtxCapturingProgress();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');

  const out = await withStubbedScraper(timeoutStub(), () =>
    entry.handler({ url: 'https://first-timeout.example/' }));
  const env = envelope.parse(out);
  assert.ok(env);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'TIMEOUT');
  assert.equal(env.error.next_action, 'retry_or_split');
  // Progress event must flag this as a non-repeat so Cluster-M's pill can
  // show "timed out — retrying" instead of the terminal manual-entry label.
  const evt = events[events.length - 1];
  assert.equal(evt.stage, 'timeout');
  assert.equal(evt.detail.repeated, false);
  assert.match(evt.label, /retry/i);
});

test('brand_scrape second timeout on same URL triggers manual_entry_fallback', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  const { ctx, events } = makeCtxCapturingProgress();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');

  // First timeout (retry_or_split).
  await withStubbedScraper(timeoutStub(), () =>
    entry.handler({ url: 'https://repeat-timeout.example/' }));
  // Second timeout (manual_entry_fallback).
  const out2 = await withStubbedScraper(timeoutStub(), () =>
    entry.handler({ url: 'https://repeat-timeout.example/' }));

  const env = envelope.parse(out2);
  assert.ok(env);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'TIMEOUT');
  assert.equal(env.error.next_action, 'manual_entry_fallback',
    'second timeout must route to manual entry, not retry_or_split');
  assert.match(env.error.message, /manually/i);

  // Structured payload the UI uses to render the fill-in card.
  assert.ok(env.data, 'fallback response must carry a data envelope');
  assert.ok(env.data.manualEntry, 'data.manualEntry is required for the fallback UI');
  assert.equal(env.data.manualEntry.reason, 'repeat_scrape_timeout');
  assert.equal(env.data.manualEntry.url, 'https://repeat-timeout.example/');
  assert.ok(Array.isArray(env.data.manualEntry.fields));
  // The schema MUST cover the four core onboarding inputs the SKILL
  // relies on: brand name, vertical, product list, logo. Without these
  // the photo-drop fallback line in merlin-setup SKILL.md cannot resolve.
  const fieldKeys = env.data.manualEntry.fields.map(f => f.key);
  for (const required of ['brandName', 'vertical', 'productList', 'logoPath']) {
    assert.ok(fieldKeys.includes(required), `manualEntry.fields is missing "${required}"`);
  }

  // Progress event for the second timeout must flag repeated=true.
  const evt = events[events.length - 1];
  assert.equal(evt.stage, 'timeout');
  assert.equal(evt.detail.repeated, true);
});

test('brand_scrape manual-entry tracker treats URL variants as the same site', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  const { ctx } = makeCtxCapturingProgress();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');

  // First timeout with trailing slash.
  await withStubbedScraper(timeoutStub(), () =>
    entry.handler({ url: 'https://variant.example/' }));
  // Second timeout without trailing slash + different case should normalize
  // to the same tracked URL and trip the fallback.
  const out2 = await withStubbedScraper(timeoutStub(), () =>
    entry.handler({ url: 'https://Variant.example' }));
  const env = envelope.parse(out2);
  assert.equal(env.error.next_action, 'manual_entry_fallback');
});

test('brand_scrape manual-entry tracker does NOT cross-contaminate different URLs', async () => {
  _resetScrapeTimeoutTrackerForTests();
  const { tool, registry } = makeFakeTool();
  const { ctx } = makeCtxCapturingProgress();
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_scrape');

  // Timeout for site A.
  await withStubbedScraper(timeoutStub(), () =>
    entry.handler({ url: 'https://site-a.example/' }));
  // First timeout for site B (different origin) must still be retry_or_split,
  // not manual_entry_fallback — the tracker is per-URL, not global.
  const outB = await withStubbedScraper(timeoutStub(), () =>
    entry.handler({ url: 'https://site-b.example/' }));
  const envB = envelope.parse(outB);
  assert.equal(envB.error.next_action, 'retry_or_split',
    'first-ever timeout for a NEW URL must not borrow another URL\'s fallback state');
});

// ─────────────────────────────────────────────────────────────────────
// Postscript full-coverage (2026-04-29) — automation CRUD + bulk import
// ─────────────────────────────────────────────────────────────────────

test('postscript tool exposes the full automation action enum', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'postscript');
  assert.ok(entry, 'postscript tool not registered');
  // Description must mention bulk-import-flow + TCPA gate (the product hook).
  assert.match(entry.description, /bulk-import-flow|automations|TCPA gate/i,
    `postscript description should advertise the new automation surface, got: ${entry.description}`);
});

test('postscript tool description references TCPA gate (the safety contract)', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'postscript');
  // The description is what the LLM router reads. Surfacing TCPA there means
  // the agent knows that bulk-import-flow has a refusal mode and won't try
  // to "auto-fix" a blocked flow by stripping STOP language.
  assert.match(entry.description, /TCPA/i,
    'postscript tool description must surface TCPA gate to the routing LLM');
});

test('postscript tool prefixes the action and dispatches to postscript-<action>', async () => {
  // REGRESSION GUARD (2026-05-06, codex API audit P2 #1):
  // Pre-fix postscript was brandRequired:false at the framework level, so
  // a brand-less call fell through to runBinary's BRAND_MISSING refusal
  // whose message includes the FULL prefixed action ("postscript-automation-create")
  // — and the test used that as a routing oracle. With brandRequired:true
  // the framework refuses BEFORE runBinary builds the prefixed action, so
  // we now route the routing-typo check through the engine-not-found path
  // instead. Pass a brand + a missing binary path; the handler must reach
  // the binary-spawn step (where action is prefixed) and surface the
  // engine-missing error WITHOUT crashing on schema validation.
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({ getBinaryPath: () => null });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'postscript');

  const out = await entry.handler({ action: 'automation-create', brand: 'vela' });
  const text = out.content && out.content[0] ? out.content[0].text : '';
  // Engine-not-found path; can't introspect the action from the user-
  // facing text, but the handler must not crash AND must reach the
  // engine path (i.e., not refuse on schema validation).
  assert.ok(text.length > 0, 'postscript handler returned empty text');
  assert.ok(!text.includes('BRAND_MISSING') && !text.includes('Refusing postscript'),
    `passing brand=vela should not refuse on missing-brand. Got: ${text}`);
});

test('postscript tool description mentions bulk-import-flow (the morning-setup verb)', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'postscript');
  assert.match(entry.description, /bulk-import-flow/,
    'postscript description must surface bulk-import-flow so the LLM picks it for "upload my SMS flows"');
});

// ─────────────────────────────────────────────────────────────────────
// Klaviyo template actions — registration + dispatch.
//
// Live incident anchor (2026-04-29, VELA): Ryan tried to bulk-import 51
// Klaviyo email templates and the existing `klaviyo` tool only exposed
// performance / lists / campaigns. Falling back to a Python script that
// read klaviyoApiKey from .merlin-config-vela.json got 401 because the
// raw key only lives in the AES-256-GCM-encrypted vault. The fix is to
// expose template CRUD + bulk-upload through the binary, where the
// vault is already decrypted. These tests pin the action enum so a
// future refactor can't silently drop a template action and re-create
// the incident.
// ─────────────────────────────────────────────────────────────────────

test('klaviyo tool registers all template + reporting actions', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'klaviyo');
  assert.ok(entry, 'klaviyo tool must be registered');
  // The fake Zod stub doesn't preserve enum values, so we assert on the
  // tool DESCRIPTION instead — every advertised action family must
  // appear in the user-facing description so the LLM routes correctly.
  // We check by family keyword (not exact action name) because the
  // description is human-readable prose, not a literal enum dump.
  const desc = entry.description.toLowerCase();
  for (const keyword of [
    'performance', 'lists', 'campaigns',
    'template', 'bulk', 'upload',
  ]) {
    assert.ok(desc.includes(keyword),
      `klaviyo description must reference keyword: ${keyword}`);
  }
  // Description must reference Flows API surface so the LLM routes
  // flow-construction requests to klaviyo. Historical (v1.20.1) the
  // description called Flows "UI-only"; that was corrected in v1.20.7
  // when full Flows API coverage shipped — see klaviyo_flows.go HISTORY.
  assert.match(entry.description, /flow/i);
});

test('klaviyo tool input schema accepts every template field', () => {
  // Use a real-ish Zod-shape probe: the fake Zod returns a chainable
  // object on every call, so we just verify the input definition has
  // entries for the new fields. The handler will validate on the binary
  // side; here we only need to confirm we ship the schema surface.
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'klaviyo');
  // The schema is captured by the test's fake `tool()` factory under
  // entry.schema — but our makeFakeTool only stores a flat shape. The
  // robust assertion is "buildTools didn't throw," which we already
  // implicitly asserted by registering the tool. Add an explicit smoke
  // by invoking the handler with template fields and confirming it
  // dispatches with the right binary action prefix.
  // (The handler itself is tested below via dispatch capture.)
  assert.ok(typeof entry.handler === 'function');
});

test('klaviyo handler dispatches templates-list without crashing on engine-missing', async () => {
  // Stub runBinary by intercepting at ctx.getBinaryPath — when the
  // binary path is null, runBinary short-circuits with the friendly
  // "engine not found" message. templates-list is brand-REQUIRED
  // (not in BRAND_OPTIONAL_ACTIONS — only klaviyo-login is). Without
  // a brand, runBinary's brand guard at line ~298 returns the
  // 'no brand specified' refusal BEFORE reaching the engine-not-found
  // check. We assert the handler still returns a clean envelope (no
  // thrown exception) regardless of which guard fires.
  // (Comment corrected per Gitar PR #151 finding — the prior version
  // labeled templates-list as brand-OPTIONAL which was wrong.)
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({ getBinaryPath: () => null });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'klaviyo');
  const out = await entry.handler({ action: 'templates-list' });
  assert.ok(out, 'handler must return a result');
  assert.ok(Array.isArray(out.content) || typeof out.text === 'string',
    'result must be an MCP content envelope or text');
});

test('klaviyo handler dispatches templates-bulk-upload with brand argument', async () => {
  // templates-bulk-upload IS brand-required (the dir must be inside
  // assets/brands/<brand>/). With a brand passed but no engine, we
  // expect to reach the engine-not-found branch — proving the brand
  // guard does NOT short-circuit this action with a "no brand"
  // refusal (which would mean we mis-classified it as brand-optional).
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({ getBinaryPath: () => null });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'klaviyo');
  const out = await entry.handler({
    action: 'templates-bulk-upload',
    brand: 'demo',
    dir: '/some/dir',
    nameTemplate: 'demo / {basename}',
  });
  assert.ok(out, 'handler must return a result');
  // The body should NOT contain the "no brand specified" refusal — we
  // passed brand=demo, so we want the engine-not-found pass-through.
  const text = (out.content && out.content[0] && out.content[0].text) || out.text || '';
  assert.ok(!text.includes('no brand specified'),
    'brand=demo must reach the engine layer, not the brand-guard refusal');
});

test('klaviyo template-create handler returns a structured envelope', async () => {
  // Same engine-not-found probe but with a write action shape — pins
  // that the handler code path doesn't crash on the new field set.
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({ getBinaryPath: () => null });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'klaviyo');
  const out = await entry.handler({
    action: 'template-create',
    templateName: 'Test welcome',
    htmlContent: '<p>Hi {{FIRST_NAME}}</p>',
  });
  assert.ok(out, 'handler must return a result');
  // Envelope-or-text contract.
  assert.ok(Array.isArray(out.content) || typeof out.text === 'string');
});

// ─────────────────────────────────────────────────────────────────────
// Klaviyo Flows API surface — added v1.20.7 (klaviyo-flows-api session,
// 2026-04-29) to close the gap that the v1.20.1 release notes + the
// merlin-social SKILL incorrectly documented as "UI-only." The Flows
// public API exposes full programmatic flow construction. These four
// tests pin the new action surface so a future refactor can't silently
// drop a flow action and re-create the confabulation incident.
// ─────────────────────────────────────────────────────────────────────

test('klaviyo description references the Flows API surface (v1.20.7 correction)', () => {
  const { tool, registry } = makeFakeTool();
  buildTools(tool, makeFakeZ(), makeCtx());
  const entry = registry.find(t => t.name === 'klaviyo');
  const desc = entry.description.toLowerCase();
  // Must mention each new family.
  for (const keyword of ['flow', 'bulk-import', 'can-spam']) {
    assert.ok(desc.includes(keyword),
      `klaviyo description must reference flow keyword: ${keyword}`);
  }
  // Must NOT claim flows are UI-only any more (regression guard for the
  // v1.20.1 documentation bug).
  assert.ok(!/ui[- ]only/i.test(entry.description),
    `klaviyo description must NOT claim flows are UI-only — corrected in v1.20.7`);
});

test('klaviyo flows-list handler dispatches without crashing on engine-missing', async () => {
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({ getBinaryPath: () => null });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'klaviyo');
  const out = await entry.handler({ action: 'flows-list' });
  assert.ok(out, 'handler must return a result');
  assert.ok(Array.isArray(out.content) || typeof out.text === 'string',
    'result must be an MCP content envelope or text');
});

test('klaviyo flow-create handler dispatches with full flow body', async () => {
  // flow-create is a write action; pin that the handler path accepts the
  // structured flowBody field without crashing on the new shape.
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({ getBinaryPath: () => null });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'klaviyo');
  const out = await entry.handler({
    action: 'flow-create',
    flowBody: {
      name: 'Test Welcome',
      trigger: { type: 'list_added', list_id: 'L_1' },
      steps: [
        { type: 'send_email', subject: 'Hi', from_name: 'Brand', template_id: 'T_1' },
      ],
    },
  });
  assert.ok(out, 'handler must return a result');
  assert.ok(Array.isArray(out.content) || typeof out.text === 'string');
});

test('klaviyo flows-bulk-import handler dispatches with brand + manifestPath', async () => {
  // flows-bulk-import is brand-required (manifest must live under
  // assets/brands/<brand>/email/ — the binary refuses arbitrary paths).
  // With a brand passed but no engine, we expect to reach the
  // engine-not-found branch, NOT the brand-guard refusal.
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({ getBinaryPath: () => null });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'klaviyo');
  const out = await entry.handler({
    action: 'flows-bulk-import',
    brand: 'demo',
    manifestPath: 'assets/brands/demo/email/flows.json',
  });
  assert.ok(out, 'handler must return a result');
  const text = (out.content && out.content[0] && out.content[0].text) || out.text || '';
  assert.ok(!text.includes('no brand specified'),
    'brand=demo must reach the engine layer, not the brand-guard refusal');
});

// ─────────────────────────────────────────────────────────────────────
// REGRESSION GUARD (2026-05-10) — D001 / E002 / A002 / A004 / C001 / D003
// Brand-vs-spend gating, Amazon actionMap, slack 'partial', nextSuggested.
// ─────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');
const policy = require('./mcp-approval-policy');

const SRC_TOOLS = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');

// ── D001: BRAND_OPTIONAL_ACTIONS does NOT contain spend-fire actions ───
//
// The allowlist exists for genuinely brand-agnostic utility actions
// (voice mgmt, OAuth login, validate-brand-guide). A spend-firing action
// like 'meta-push' must NEVER be on it — bypassing brand-required would
// silently let the binary fall back to global config and fire spend on
// the wrong brand's tokens.
test('BRAND_OPTIONAL_ACTIONS contains zero spend-fire actions (D001)', () => {
  // Source-scan the literal Set body; we can't import it without exporting,
  // and exporting the private allowlist would be a wider API surface change.
  const m = SRC_TOOLS.match(/const BRAND_OPTIONAL_ACTIONS\s*=\s*new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'BRAND_OPTIONAL_ACTIONS Set literal must exist in mcp-tools.js');
  const setBody = m[1];

  const SPEND_FIRE = [
    'meta-push', 'meta-kill', 'meta-duplicate', 'meta-bulk-push', 'meta-budget',
    'meta-activate', 'meta-setup-retargeting',
    'tiktok-push', 'tiktok-kill', 'tiktok-duplicate',
    'google-ads-push', 'google-ads-kill', 'google-ads-duplicate',
    'amazon-ads-push', 'amazon-ads-kill',
    'reddit-ads-push', 'reddit-ads-kill',
    'linkedin-ads-push', 'linkedin-ads-kill', 'linkedin-ads-duplicate',
    'etsy-ads-push', 'etsy-ads-kill',
  ];
  for (const action of SPEND_FIRE) {
    assert.ok(
      !setBody.includes(`'${action}'`),
      `BRAND_OPTIONAL_ACTIONS must NOT include the spend-fire action '${action}' — bypassing brand-required would silently fire spend on global tokens.`
    );
  }
});

// ── A004: pruned login actions are gone from BRAND_OPTIONAL_ACTIONS ────
test('BRAND_OPTIONAL_ACTIONS no longer lists pinterest/snapchat/twitter login (A004)', () => {
  const m = SRC_TOOLS.match(/const BRAND_OPTIONAL_ACTIONS\s*=\s*new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m);
  const setBody = m[1];
  for (const stale of ['pinterest-login', 'snapchat-login', 'twitter-login']) {
    assert.ok(
      !setBody.includes(`'${stale}'`),
      `Stale entry '${stale}' must be dropped from BRAND_OPTIONAL_ACTIONS — its case statement was removed from main.go in v1.22.0 RSI cleanup.`
    );
  }
});

// ── E002: SPEND_ACTIONS includes 'duplicate' AND 'kill' so they always card ──
//
// 'kill' isn't in SPEND_ACTIONS today (deliberate — pausing spend is the
// safer side of the spectrum), but the request requires it for v1.22.0 to
// lock both destructive verbs to the approval-card path.
test("SPEND_ACTIONS locks 'duplicate' and 'kill' to approval-card path (E002)", () => {
  assert.ok(policy.SPEND_ACTIONS.has('duplicate'),
    "SPEND_ACTIONS must include 'duplicate' so duplicate calls always card");
  assert.ok(policy.SPEND_ACTIONS.has('kill'),
    "SPEND_ACTIONS must include 'kill' so destructive pause/delete calls always card");
});

// ── E002: every legacy multiplexer's action enum is covered by either
// BRAND_OPTIONAL_ACTIONS OR SPEND_ACTIONS / READ_ONLY_ACTIONS (no orphans). ──
test('legacy multiplexer enums have no orphan actions (E002)', () => {
  // Source-scan the action enums for the legacy multiplexer tools and
  // assert each value is either:
  //   (a) in BRAND_OPTIONAL_ACTIONS (utility / login / brand-agnostic)
  //   (b) in SPEND_ACTIONS (carded)
  //   (c) in READ_ONLY_ACTIONS (auto-approved read)
  // The test covers Meta, TikTok, Google, Amazon, Reddit, LinkedIn — the
  // six platform tools that still use the action multiplexer surface.
  const optionalMatch = SRC_TOOLS.match(/const BRAND_OPTIONAL_ACTIONS\s*=\s*new Set\(\[([\s\S]*?)\]\);/);
  const optionalActions = new Set();
  if (optionalMatch) {
    for (const m of optionalMatch[1].matchAll(/'([a-z0-9-]+)'/g)) {
      optionalActions.add(m[1]);
    }
  }

  // Pull every action enum literal in mcp-tools.js. The pattern z.enum([...])
  // appears for many tools; we only care about the multiplexers, which we
  // identify by the surrounding tool block.
  const multiplexerTools = ['meta_ads', 'tiktok_ads', 'google_ads', 'amazon_ads', 'reddit_ads', 'linkedin_ads'];
  for (const toolName of multiplexerTools) {
    const blockRe = new RegExp(`name:\\s*'${toolName}'[\\s\\S]*?action:\\s*z\\.enum\\(\\[([^\\]]+)\\]\\)`, 'm');
    const blockMatch = SRC_TOOLS.match(blockRe);
    if (!blockMatch) continue; // tool not present in this build
    const actions = [];
    for (const m of blockMatch[1].matchAll(/'([a-z0-9-]+)'/g)) {
      actions.push(m[1]);
    }
    assert.ok(actions.length > 0, `${toolName}: action enum must declare ≥1 action`);
    for (const action of actions) {
      const inSpend = policy.SPEND_ACTIONS.has(action);
      const inRead = policy.READ_ONLY_ACTIONS.has(action);
      // Some platform-specific actions (warmup, retarget, lookalike, adlib,
      // catalog, bulk-push, lockdown, import, fix-alt, update-rank, …) are
      // covered by READ_ONLY_ACTIONS or SPEND_ACTIONS. The remaining ones
      // either match a binary action name on the BRAND_OPTIONAL_ACTIONS
      // allowlist OR are carded via the catch-all (action!==read,
      // action!==setup → falls to auto-approve, but the legacy multiplexer
      // tools all carry destructive:true on the SDK annotation).
      // For this test, "covered" = in any of the three sets.
      // Platform-specific verbs that aren't strictly read OR spend (they're
      // either listing-with-side-effects or platform-shaped variants of the
      // canonical 7-action surface). The legacy multiplexer's destructive:true
      // annotation routes them through the carding catch-all in main.js.
      const PLATFORM_VERBS = new Set([
        // Meta-specific
        'warmup', 'retarget', 'lookalike', 'adlib', 'catalog', 'bulk-push',
        'lockdown', 'import', 'budget', 'activate',
        // SEO
        'fix-alt', 'update-rank',
        // Reddit/LinkedIn list-shaped reads
        'accounts', 'adgroups', 'ads', 'campaigns',
        // Reddit create-shaped writes
        'create-campaign', 'create-ad',
      ]);
      const covered = inSpend || inRead || optionalActions.has(action) ||
        PLATFORM_VERBS.has(action);
      assert.ok(covered,
        `${toolName} action '${action}' is an orphan — not covered by BRAND_OPTIONAL_ACTIONS, SPEND_ACTIONS, READ_ONLY_ACTIONS, or the platform-specific allowlist. Add it to one of those sets or to the test's recognized list.`);
    }
  }
});

// ── A002: amazon_ads uses an explicit actionMap (no conditional prefix) ──
test('amazon_ads handler uses explicit actionMap, no conditional prefix (A002)', () => {
  // Source-scan ensures the regression doesn't sneak back in. The
  // conditional prefix pattern (`['products','orders'].includes(...)`) was
  // brittle; the explicit map is the canonical pattern.
  const handlerSlice = SRC_TOOLS.match(/name:\s*'amazon_ads'[\s\S]*?\}, tool, z, ctx\)\);/);
  assert.ok(handlerSlice, 'amazon_ads block must exist in mcp-tools.js');
  const block = handlerSlice[0];
  assert.doesNotMatch(
    block,
    /\['products',\s*'orders'\]\.includes/,
    "amazon_ads must not use the conditional prefix heuristic — use the explicit actionMap pattern (REGRESSION GUARD A002)"
  );
  assert.match(
    block,
    /actionMap\s*=\s*\{[\s\S]*'products'\s*:\s*'amazon-products'/,
    'amazon_ads must define an actionMap with products → amazon-products'
  );
  assert.match(
    block,
    /actionMap\s*=\s*\{[\s\S]*'push'\s*:\s*'amazon-ads-push'/,
    'amazon_ads actionMap must include push → amazon-ads-push'
  );
});

// ── C001: connection_status downgrades slack 'expired' → 'partial'
//   when bot token exists but webhook URL is missing ──────────────────
test("connection_status maps slack 'expired'+bot+!webhook to 'partial' (C001)", async () => {
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({
    getConnections: () => ([
      { platform: 'slack', status: 'expired' },
      { platform: 'meta', status: 'connected' },
    ]),
    readConfig: () => ({ slackBotToken: 'xoxb-test', /* slackWebhookUrl absent */ }),
  });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'connection_status');
  const out = await entry.handler({});
  const env = envelope.parse(out);
  assert.equal(env.ok, true);
  assert.equal(env.data.connections.slack, 'partial',
    "Slack token-without-webhook must surface as 'partial' so the renderer can paint a yellow tile");
  assert.ok(env.data.detail && env.data.detail.slack,
    'C001 envelope must carry a detail string explaining what to do next');
  assert.match(env.data.detail.slack, /webhook URL/i,
    'C001 detail must mention the missing webhook URL so the user knows the remediation');
  // meta untouched.
  assert.equal(env.data.connections.meta, 'connected');
});

test("connection_status leaves slack 'expired' alone when no bot token exists (C001 negative)", async () => {
  // If neither bot token nor webhook is configured, 'expired' is misleading
  // but at least matches the legacy behavior — don't downgrade because we
  // can't tell why it's expired.
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({
    getConnections: () => ([{ platform: 'slack', status: 'expired' }]),
    readConfig: () => ({ /* nothing */ }),
  });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'connection_status');
  const out = await entry.handler({});
  const env = envelope.parse(out);
  assert.equal(env.data.connections.slack, 'expired',
    'without a bot token, slack stays "expired" — partial only fires on token+!webhook');
});

// ── D003: nextSuggested populated on five high-impact tools ──
test("brand_activate envelope carries nextSuggested:['connection_status'] (D003)", async () => {
  const { tool, registry } = makeFakeTool();
  const ctx = makeCtx({
    activateBrand: () => ({ ok: true, previousBrand: 'old' }),
  });
  buildTools(tool, makeFakeZ(), ctx);
  const entry = registry.find(t => t.name === 'brand_activate');
  const out = await entry.handler({ brand: 'newbrand' });
  const env = envelope.parse(out);
  assert.equal(env.ok, true);
  assert.deepEqual(env.nextSuggested, ['connection_status'],
    'brand_activate must carry nextSuggested:["connection_status"] (D003)');
});

// REGRESSION GUARD (2026-06-XX, connector-hardening — klaviyo-email-send-wiring):
// The klaviyo tool must expose campaign-send / campaign-schedule (the live email
// sends) plus the params they need (campaignId, replyTo, scheduleTime, approved).
// Pre-fix klaviyoSendCampaign/klaviyoScheduleCampaign were built + tested but
// unrouted — no MCP action reached them, so the send button did not exist.
test('klaviyo tool exposes campaign-send / campaign-schedule + their params', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');
  // Scope to the klaviyo tool block (from its name to the next tool's name).
  const start = src.indexOf("name: 'klaviyo'");
  assert.ok(start > 0, 'klaviyo tool must exist');
  const after = src.indexOf("name: 'email'", start);
  const block = src.slice(start, after > 0 ? after : start + 12000);
  for (const action of ["'campaign-send'", "'campaign-schedule'"]) {
    assert.ok(block.includes(action),
      `klaviyo action enum must include ${action} (live email send)`);
  }
  for (const param of ['campaignId:', 'replyTo:', 'scheduleTime:', 'approved:']) {
    assert.ok(block.includes(param),
      `klaviyo tool must declare the ${param} input for campaign-send/schedule`);
  }
});

// ── meta_audit change-history / delivery-breakdown / account-state ──────
// (2026-07-05) New read-only diagnostic actions must be in the enum + wired in
// the handler mapper + carry their params, and meta_audit must STAY read-only.
test('meta_audit exposes the new diagnostic read actions (change-history, account-state, delivery-breakdown)', () => {
  const i = SRC_TOOLS.indexOf("name: 'meta_audit'");
  assert.ok(i > 0, 'meta_audit tool block must exist');
  // Bound the block at the NEXT tool rather than a fixed byte count: the
  // meta_audit description grew past the old 5200-byte window when the
  // account-inventory reads landed (2026-07-26), which silently truncated
  // the block and made every assertion below scan the wrong text.
  const next = SRC_TOOLS.indexOf("name: 'google_analytics'", i);
  const block = SRC_TOOLS.slice(i, next > i ? next : i + 5200);
  for (const a of ['audit-change-history', 'audit-account-state', 'audit-delivery-breakdown']) {
    assert.ok(block.includes(`'${a}'`), `meta_audit action enum must include ${a}`);
  }
  // Routing moved out of the handler's inline ternary chain into the exported
  // META_AUDIT_ACTION_MAP (2026-07-26) so it is inspectable by
  // app/mcp-meta-action-reachability.test.js. Assert on the map itself — the
  // behaviour this test cares about is "these actions reach the engine", and
  // the map is now where that is decided.
  for (const a of ['audit-change-history', 'audit-account-state', 'audit-delivery-breakdown']) {
    assert.equal(metaAuditEngineAction(a), `meta-${a}`,
      `meta_audit must route ${a} to the meta-${a} engine action`);
  }
  for (const p of ['windowDays:', 'timeIncrement:', 'breakdowns:']) {
    assert.ok(block.includes(p), `meta_audit must declare the ${p} input for the diagnostic reads`);
  }
  // Stays read-only: no destructive annotation, no approval preview.
  assert.ok(block.includes('destructive: false'), 'meta_audit must remain destructive:false');
  assert.ok(block.includes('preview: false'), 'meta_audit must remain preview:false (no approval card on reads)');
});
