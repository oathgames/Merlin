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
