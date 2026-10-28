// magic-tiles.test.js — REGRESSION GUARD (2026-06-19)
//
// The Magic panel renders connector tiles from static .magic-tile elements in
// index.html and filters them per the active brand's vertical in renderer.js
// (updateVertical). Two classes of bug this suite locks out:
//
//  1. UNIVERSAL TILES VANISHING: data-scope="universal" tiles (creative tools,
//     cross-brand intelligence like Foreplay/TrendTrack, notification channels)
//     must NEVER be hidden by the vertical filter. They previously survived only
//     by being duplicated into a vertical's integrations list (BASE_CREATIVE_TOOLS);
//     Foreplay + TrendTrack were omitted and silently disappeared on every
//     recognized vertical. The fix scopes the filter to brand tiles.
//
//  2. BRAND TILES IN ZERO VERTICALS: a brand-scope, non-stubbed tile that is not
//     in ANY vertical's integrations list is invisible on every recognized
//     vertical (only the unknown-vertical fallback shows it). This is the same
//     bug that hid mailchimp. Every brand tile must be visible on >=1 vertical.
//
// Pure source/text assertions — no Electron, no DOM. Runs under `node file` and
// `node --test file`.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = __dirname;
const renderer = fs.readFileSync(path.join(APP_DIR, 'renderer.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const oauthPersist = fs.readFileSync(path.join(APP_DIR, 'oauth-persist.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');

// Parse every <button class="magic-tile" ...> opening tag from index.html.
function parseTiles(html) {
  const tiles = [];
  const re = /<button class="magic-tile"([^>]*)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const plat = /data-platform="([^"]+)"/.exec(attrs);
    if (!plat) continue;
    const scope = /data-scope="([^"]+)"/.exec(attrs);
    tiles.push({
      platform: plat[1],
      scope: scope ? scope[1] : '',
      stubbed: /data-stubbed="true"/.test(attrs),
    });
  }
  return tiles;
}

// Extract each recognized vertical's integrations array (the ones ending with
// the ...BASE_CREATIVE_TOOLS spread). The UNKNOWN profile uses `integrations: null`.
function parseVerticalIntegrations(src) {
  const arrays = [];
  const re = /integrations:\s*\[([^\]]*?)\.\.\.BASE_CREATIVE_TOOLS\]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    arrays.push([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  }
  return arrays;
}

const tiles = parseTiles(indexHtml);
const verticals = parseVerticalIntegrations(renderer);
const allVerticalPlatforms = new Set(verticals.flat());

test('vertical filter never hides data-scope="universal" tiles', () => {
  assert.ok(
    renderer.includes("tile.dataset.scope === 'universal'"),
    'updateVertical must skip universal-scope tiles in the vertical filter (root-cause guard for Foreplay/TrendTrack)'
  );
});

test('Foreplay and TrendTrack tiles exist and are universal-scope', () => {
  for (const p of ['foreplay', 'trendtrack', 'fal', 'elevenlabs', 'heygen', 'arcads']) {
    const t = tiles.find((x) => x.platform === p);
    assert.ok(t, `universal tile "${p}" missing from index.html`);
    assert.equal(t.scope, 'universal', `tile "${p}" must be data-scope="universal"`);
  }
});

test('Triple Whale and OpenAI Ads brand tiles exist', () => {
  for (const p of ['triplewhale', 'openai_ads']) {
    const t = tiles.find((x) => x.platform === p);
    assert.ok(t, `brand tile "${p}" missing from index.html`);
    assert.equal(t.scope, 'brand', `tile "${p}" must be data-scope="brand"`);
  }
});

test('exactly 7 recognized verticals; every one includes openai_ads', () => {
  assert.equal(verticals.length, 7, `expected 7 recognized verticals, found ${verticals.length}`);
  for (const v of verticals) {
    assert.ok(v.includes('openai_ads'), 'a vertical is missing openai_ads (OpenAI Ads is a general paid-ads platform)');
  }
});

test('ecommerce vertical includes triplewhale and openai_ads', () => {
  const ecom = verticals.find((v) => v.includes('shopify'));
  assert.ok(ecom, 'ecommerce vertical (the one with shopify) not found');
  assert.ok(ecom.includes('triplewhale'), 'ecommerce vertical missing triplewhale');
  assert.ok(ecom.includes('openai_ads'), 'ecommerce vertical missing openai_ads');
});

test('CLASS GUARD: every non-stubbed brand tile is visible on >=1 vertical', () => {
  for (const t of tiles) {
    if (t.scope !== 'brand' || t.stubbed) continue;
    assert.ok(
      allVerticalPlatforms.has(t.platform),
      `brand tile "${t.platform}" is in NO vertical integrations list — it would be invisible on every recognized vertical (the Foreplay/TrendTrack/mailchimp bug class). Add it to the relevant VERTICAL_PROFILES integrations array.`
    );
  }
});

test('Triple Whale + OpenAI Ads have a working connect path (API_KEY_PLATFORMS + persist allowlists)', () => {
  assert.match(renderer, /triplewhale:\s*\{\s*key:\s*'triplewhaleApiKey'/, 'triplewhale missing from API_KEY_PLATFORMS');
  assert.match(renderer, /openai_ads:\s*\{\s*key:\s*'openaiAdsApiKey'/, 'openai_ads missing from API_KEY_PLATFORMS');
  // Each BYOK key must be accepted by save-config-field AND vaulted (no plaintext).
  assert.ok(oauthPersist.includes("'triplewhaleApiKey'"), 'triplewhaleApiKey not in oauth-persist allowlists');
  assert.ok(oauthPersist.includes("'openaiAdsApiKey'"), 'openaiAdsApiKey not in oauth-persist allowlists');
});

test('Microsoft Clarity brand tile exists, is brand-scope, and is on every vertical', () => {
  const t = tiles.find((x) => x.platform === 'clarity');
  assert.ok(t, 'clarity brand tile missing from index.html');
  assert.equal(t.scope, 'brand', 'clarity must be data-scope="brand" (each brand connects its own Clarity project)');
  assert.ok(!t.stubbed, 'clarity tile must not be stubbed; the connector ships (clarity.go)');
  for (const v of verticals) {
    assert.ok(v.includes('clarity'), 'a vertical is missing clarity (behavioral analytics applies to every web brand)');
  }
});

test('Microsoft Clarity has a working connect path (API_KEY_PLATFORMS + CONFIG_FIELD_ALLOWLIST + vaulted)', () => {
  assert.match(renderer, /clarity:\s*\{\s*key:\s*'clarityApiToken'/, 'clarity missing from API_KEY_PLATFORMS; the tile click would do nothing');
  // The allowlist membership is the load-bearing fix: clarityApiToken was already
  // in VAULT_SENSITIVE_KEYS but NOT in CONFIG_FIELD_ALLOWLIST, so a tile save would
  // hit "Unknown config field" (the postscript-save-broken incident class).
  const allowlistStart = oauthPersist.indexOf('const CONFIG_FIELD_ALLOWLIST = new Set([');
  assert.ok(allowlistStart >= 0, 'CONFIG_FIELD_ALLOWLIST definition not found');
  const allowlistBlock = oauthPersist.slice(allowlistStart, oauthPersist.indexOf(']', allowlistStart));
  assert.ok(allowlistBlock.includes("'clarityApiToken'"), 'clarityApiToken not in CONFIG_FIELD_ALLOWLIST; save-config-field would reject the paste with "Unknown config field"');
  // And it must be vaulted (sensitive), never written to merlin-config.json in plaintext.
  const sensitiveBlock = oauthPersist.slice(0, allowlistStart);
  assert.ok(sensitiveBlock.includes("'clarityApiToken'"), 'clarityApiToken not in VAULT_SENSITIVE_KEYS; would be written to config in plaintext');
});

test('PostHog brand tile exists, is brand-scope, and is on every vertical', () => {
  const t = tiles.find((x) => x.platform === 'posthog');
  assert.ok(t, 'posthog brand tile missing from index.html');
  assert.equal(t.scope, 'brand', 'posthog must be data-scope="brand" (each brand connects its own PostHog project)');
  assert.ok(!t.stubbed, 'posthog tile must not be stubbed; the connector ships (posthog.go)');
  for (const v of verticals) {
    assert.ok(v.includes('posthog'), 'a vertical is missing posthog (product analytics applies to every brand with a site/app)');
  }
});

test('PostHog has a working connect path (custom 3-field modal + CONFIG_FIELD_ALLOWLIST + vaulted key)', () => {
  // PostHog needs 3 fields, so it uses the custom modal (like Rokt), NOT the
  // single-field API_KEY_PLATFORMS path.
  assert.match(renderer, /posthog:\s*showPosthogConnectModal/, 'posthog missing from CUSTOM_CONNECT_HANDLERS; the tile click would do nothing');
  assert.ok(renderer.includes('function showPosthogConnectModal('), 'showPosthogConnectModal not defined');
  // The project-id step must reject non-numeric input in the modal (a pasted
  // project name/URL would otherwise 404 on the first insights pull).
  const modalStart = renderer.indexOf('function showPosthogConnectModal(');
  const modalBlock = renderer.slice(modalStart, modalStart + 2500);
  assert.match(modalBlock, /\/\^\\d\+\$\/\.test\(projectId\)/, 'showPosthogConnectModal must validate the Project ID is numeric');
  const allowlistStart = oauthPersist.indexOf('const CONFIG_FIELD_ALLOWLIST = new Set([');
  assert.ok(allowlistStart >= 0, 'CONFIG_FIELD_ALLOWLIST definition not found');
  const allowlistBlock = oauthPersist.slice(allowlistStart, oauthPersist.indexOf(']', allowlistStart));
  // Every field the modal saves via save-config-field must be allowlisted, or
  // that field hits "Unknown config field" (postscript-save-broken class).
  for (const k of ['posthogApiKey', 'posthogProjectId', 'posthogHost']) {
    assert.ok(allowlistBlock.includes(`'${k}'`), `${k} not in CONFIG_FIELD_ALLOWLIST; save-config-field would reject it`);
  }
  // The API key is the secret and must be vaulted; the project id / host are
  // non-secret identifiers and must NOT be in VAULT_SENSITIVE_KEYS (plaintext is fine).
  const sensitiveBlock = oauthPersist.slice(0, allowlistStart);
  assert.ok(sensitiveBlock.includes("'posthogApiKey'"), 'posthogApiKey not in VAULT_SENSITIVE_KEYS; the secret would be written to config in plaintext');
  assert.ok(!sensitiveBlock.includes("'posthogProjectId'"), 'posthogProjectId should NOT be in VAULT_SENSITIVE_KEYS (non-secret identifier)');
});

test('Alia brand tile exists, is brand-scoped, and is visible on every vertical', () => {
  const t = tiles.find((x) => x.platform === 'alia');
  assert.ok(t, 'alia brand tile missing from index.html');
  assert.equal(t.scope, 'brand', 'alia must be data-scope="brand" (each brand connects its own Alia merchant)');
  assert.ok(!t.stubbed, 'alia tile must not be stubbed; the connector ships (alia.go)');
  for (const v of verticals) {
    assert.ok(v.includes('alia'), 'a vertical is missing alia (popup analytics applies to every web brand)');
  }
});

test('Alia tile has a complete masked-key connection path', () => {
  assert.match(renderer, /alia:\s*\{\s*key:\s*'aliaApiKey'/, 'alia missing from API_KEY_PLATFORMS; clicking the tile would do nothing');
  assert.match(renderer, /alia:\s*'Alia Popups'/, 'alia missing from PLATFORM_DISPLAY_NAMES');
  const allowlistStart = oauthPersist.indexOf('const CONFIG_FIELD_ALLOWLIST = new Set([');
  assert.ok(allowlistStart >= 0, 'CONFIG_FIELD_ALLOWLIST definition not found');
  const allowlistBlock = oauthPersist.slice(allowlistStart, oauthPersist.indexOf(']', allowlistStart));
  const sensitiveBlock = oauthPersist.slice(0, allowlistStart);
  assert.ok(allowlistBlock.includes("'aliaApiKey'"), 'aliaApiKey not in CONFIG_FIELD_ALLOWLIST; save-config-field would reject the key');
  assert.ok(sensitiveBlock.includes("'aliaApiKey'"), 'aliaApiKey not in VAULT_SENSITIVE_KEYS; key would be written in plaintext');
});

test('all 8 frontier-lab connector tiles exist and are brand-scope', () => {
  for (const p of ['yotpo', 'sesami', 'faire', 'quickbooks', 'shopify_payments', 'shipstation', 'loop_returns', 'cin7', 'gorgias']) {
    const t = tiles.find((x) => x.platform === p);
    assert.ok(t, `brand tile "${p}" missing from index.html`);
    assert.equal(t.scope, 'brand', `tile "${p}" must be data-scope="brand" (each brand connects its own account)`);
    assert.ok(!t.stubbed, `tile "${p}" must not be stubbed; the connector ships in the binary`);
  }
});

test('ecommerce vertical includes all 8 frontier-lab connectors', () => {
  const ecom = verticals.find((v) => v.includes('shopify'));
  assert.ok(ecom, 'ecommerce vertical (the one with shopify) not found');
  for (const p of ['yotpo', 'sesami', 'faire', 'quickbooks', 'shopify_payments', 'shipstation', 'loop_returns', 'cin7', 'gorgias']) {
    assert.ok(ecom.includes(p), `ecommerce vertical missing ${p} — the tile would be invisible (the mailchimp bug class)`);
  }
});

test('all 8 frontier-lab connectors have a working connect path', () => {
  // Every non-stubbed tile click must reach OAuth, a custom modal, or the
  // single-field API_KEY_PLATFORMS modal — otherwise the click is a silent
  // no-op (the LinkedIn bug class pinned in renderer.js's REGRESSION GUARD).
  assert.ok(renderer.includes("'quickbooks'"), 'quickbooks missing from OAUTH_PLATFORMS');
  for (const p of ['yotpo', 'sesami', 'shipstation', 'cin7', 'gorgias', 'shopify_payments']) {
    assert.match(renderer, new RegExp(`${p}:\\s*show|${p}:\\s*connect`), `${p} missing from CUSTOM_CONNECT_HANDLERS; the tile click would do nothing`);
  }
  for (const p of ['faire', 'loop_returns']) {
    assert.match(renderer, new RegExp(`${p}:\\s*\\{\\s*key:`), `${p} missing from API_KEY_PLATFORMS; the tile click would do nothing`);
  }
  // Every field the modals save via save-config-field must be allowlisted,
  // or the save hits "Unknown config field" (postscript-save-broken class).
  const allowlistStart = oauthPersist.indexOf('const CONFIG_FIELD_ALLOWLIST = new Set([');
  assert.ok(allowlistStart >= 0, 'CONFIG_FIELD_ALLOWLIST definition not found');
  const allowlistBlock = oauthPersist.slice(allowlistStart, oauthPersist.indexOf(']', allowlistStart));
  const sensitiveBlock = oauthPersist.slice(0, allowlistStart);
  const savedKeys = [
    'yotpoAppKey', 'yotpoSecretKey',
    'sesamiApiKey', 'sesamiClientId', 'sesamiShopId',
    'faireApiToken',
    'shipStationApiKey', 'shipStationApiSecret',
    'loopApiKey',
    'cin7AccountId', 'cin7ApplicationKey',
    'gorgiasDomain', 'gorgiasEmail', 'gorgiasApiKey',
    'quickbooksAccessToken', 'quickbooksRefreshToken',
    'quickbooksRealmId', 'quickbooksTokenExpiresAt', 'quickbooksUseSandbox',
  ];
  for (const k of savedKeys) {
    assert.ok(allowlistBlock.includes(`'${k}'`), `${k} not in CONFIG_FIELD_ALLOWLIST; save-config-field would reject it`);
  }
  // Secrets must be vaulted. quickbooksRealmId is vaulted too — the Go
  // binary VaultPuts it brand-scoped (same treatment as shopifyStore), so
  // leaving it out of VAULT_SENSITIVE_KEYS orphaned the vault entry on
  // disconnect (2026-09-11 audit fix). tokenExpiresAt and useSandbox stay
  // plaintext non-secret identifiers.
  for (const k of savedKeys.filter((k) => k !== 'quickbooksTokenExpiresAt' && k !== 'quickbooksUseSandbox')) {
    assert.ok(sensitiveBlock.includes(`'${k}'`), `${k} not in VAULT_SENSITIVE_KEYS; would be written to config in plaintext`);
  }
  for (const k of ['quickbooksTokenExpiresAt', 'quickbooksUseSandbox']) {
    assert.ok(!sensitiveBlock.includes(`'${k}'`), `${k} should NOT be in VAULT_SENSITIVE_KEYS (non-secret identifier)`);
  }
});

test('legacy OAuth spawn passes brand — quickbooks tokens must not vault under _global', () => {
  // 2026-09-11 audit P0: runOAuthFlow's legacy fallback spawned
  // `Merlin.exe <platform>-login` with { action } only — no brand — so
  // quickbooks-login vaulted tokens under _global where brand-scoped
  // resolution (BRAND_KEYS / brandScopedKeys forbid the _global fallback)
  // never looks. The tile stayed gray and every report failed
  // 'not connected' after a successful OAuth. The spawn MUST carry brand.
  const legacySpawn = mainSrc.match(/Legacy binary-login fallback[\s\S]*?JSON\.stringify\(\{[^}]*\}\)/);
  assert.ok(legacySpawn, 'legacy binary-login spawn not found in main.js');
  assert.match(legacySpawn[0], /brand:/,
    'legacy spawn drops brand — brand-scoped OAuth tokens vault under _global and are unreachable');
});

// Rakuten Advertising (2026-09-30): read-only affiliate reporting. The connect
// modal parses the report's "Get API" link, so the parser is exercised here
// against the same key/locale/network patterns rakuten.go enforces.
test('rakuten tile exists, is brand-scope, visible, and has a connect path', () => {
  const t = tiles.find((x) => x.platform === 'rakuten');
  assert.ok(t, 'brand tile "rakuten" missing from index.html');
  assert.equal(t.scope, 'brand');
  assert.ok(!t.stubbed, 'rakuten tile must not be stubbed; the connector ships in the binary');
  const ecom = verticals.find((v) => v.includes('shopify'));
  assert.ok(ecom && ecom.includes('rakuten'), 'ecommerce vertical missing rakuten');
  assert.match(renderer, /rakuten:\s*showRakutenConnectModal/, 'rakuten missing from CUSTOM_CONNECT_HANDLERS');
  const allowlistStart = oauthPersist.indexOf('const CONFIG_FIELD_ALLOWLIST = new Set([');
  const allowlistBlock = oauthPersist.slice(allowlistStart, oauthPersist.indexOf(']', allowlistStart));
  const sensitiveBlock = oauthPersist.slice(0, allowlistStart);
  for (const k of ['rakutenReportToken', 'rakutenReportKey', 'rakutenTransactionsReportKey', 'rakutenReportLocale', 'rakutenNetwork']) {
    assert.ok(allowlistBlock.includes(`'${k}'`), `${k} not in CONFIG_FIELD_ALLOWLIST`);
    assert.ok(sensitiveBlock.includes(`'${k}'`), `${k} not in VAULT_SENSITIVE_KEYS`);
    assert.ok(mainSrc.includes(`'${k}'`), `${k} not in main.js BRAND_KEYS / disconnect map`);
  }
});

test('parseRakutenReportUrl accepts real Get API links and rejects everything else', () => {
  const start = renderer.indexOf('function parseRakutenReportUrl(');
  assert.ok(start >= 0, 'parseRakutenReportUrl not found in renderer.js');
  const end = renderer.indexOf('\nfunction showRakutenConnectModal', start);
  const parse = new Function(`${renderer.slice(start, end)}\nreturn parseRakutenReportUrl;`)();
  const base = 'https://ran-reporting.rakutenmarketing.com';
  assert.deepStrictEqual(
    parse(`${base}/en/reports/perf-by-publisher/filters?start_date=2026-01-01&end_date=2026-01-31&include_summary=N&network=1&tz=GMT&date_type=transaction&token=abc123`),
    { locale: 'en', reportKey: 'perf-by-publisher', token: 'abc123', network: '1' });
  assert.deepStrictEqual(parse(`  ${base}/en-gb/reports/k_1/filters?token=t&network=3  `),
    { locale: 'en-gb', reportKey: 'k_1', token: 't', network: '3' });
  assert.equal(parse(`${base}/en/reports/k/filters?token=t&network=abc`).network, '1', 'bad network falls back to 1');
  for (const bad of [
    '', 'not a url', `http://ran-reporting.rakutenmarketing.com/en/reports/k/filters?token=t`,
    `https://evil.example.com/en/reports/k/filters?token=t`,
    `https://ran-reporting.rakutenmarketing.com.evil.com/en/reports/k/filters?token=t`,
    `${base}/en/reports/k/filters`, `${base}/en/reports/k/filters?token=`,
    `${base}/EN/reports/k/filters?token=t`, `${base}/en/reports/../x/filters?token=t`,
    `${base}/en/reports/k/other?token=t`, `${base}/en/reports/-k/filters?token=t`,
  ]) {
    assert.equal(parse(bad), null, `should reject: ${bad}`);
  }
});

// impact.com (2026-10-05): read-only affiliate reporting over Basic auth
// (Account SID + Auth Token). The modal's SID and program patterns must match
// impactSIDRe / impactProgramRe in impact.go.
test('impact tile exists, is brand-scope, visible, and has a connect path', () => {
  const t = tiles.find((x) => x.platform === 'impact');
  assert.ok(t, 'brand tile "impact" missing from index.html');
  assert.equal(t.scope, 'brand');
  assert.ok(!t.stubbed, 'impact tile must not be stubbed; the connector ships in the binary');
  const ecom = verticals.find((v) => v.includes('shopify'));
  assert.ok(ecom && ecom.includes('impact'), 'ecommerce vertical missing impact');
  assert.match(renderer, /impact:\s*showImpactConnectModal/, 'impact missing from CUSTOM_CONNECT_HANDLERS');
  const allowlistStart = oauthPersist.indexOf('const CONFIG_FIELD_ALLOWLIST = new Set([');
  const allowlistBlock = oauthPersist.slice(allowlistStart, oauthPersist.indexOf(']', allowlistStart));
  const sensitiveBlock = oauthPersist.slice(0, allowlistStart);
  for (const k of ['impactAccountSid', 'impactAuthToken', 'impactProgramId']) {
    assert.ok(allowlistBlock.includes(`'${k}'`), `${k} not in CONFIG_FIELD_ALLOWLIST`);
    assert.ok(sensitiveBlock.includes(`'${k}'`), `${k} not in VAULT_SENSITIVE_KEYS`);
    assert.ok(mainSrc.includes(`'${k}'`), `${k} not in main.js BRAND_KEYS / disconnect map`);
  }
  const start = renderer.indexOf('function showImpactConnectModal(');
  const body = renderer.slice(start, renderer.indexOf('\n}', start));
  assert.ok(body.includes('/^[A-Za-z0-9]{8,64}$/'), 'SID pattern drifted from impactSIDRe');
  assert.ok(body.includes('/^[0-9]{1,12}$/'), 'program pattern drifted from impactProgramRe');
  assert.ok(body.includes("friendlyErrorPlain("), 'save errors must pass through friendlyErrorPlain');
  const goSrc = (() => { try { return require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'autocmo-core', 'impact.go'), 'utf8'); } catch (_) { return null; } })();
  if (goSrc) {
    assert.ok(goSrc.includes('`^[A-Za-z0-9]{8,64}$`'), 'impactSIDRe changed; update the modal');
    assert.ok(goSrc.includes('`^[0-9]{1,12}$`'), 'impactProgramRe changed; update the modal');
  }
});
