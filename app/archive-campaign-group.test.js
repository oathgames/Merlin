// Unit tests for archive-campaign-group.js. Run with:
//   node app/archive-campaign-group.test.js
//
// The Archive "Ads" tab relies on this helper to bucket live ads into
// campaign sections. Regressions here surface as "all my ads collapsed into
// one Uncategorized group" or "the order shuffled randomly after a refresh",
// so the tests cover: correct bucketing, stable sort, Uncategorized pin,
// platform-namespacing, and defensive input handling.

const assert = require('assert');
const { groupLiveAdsByCampaign, NO_CAMPAIGN_KEY } = require('./archive-campaign-group');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  \u2713', name);
    passed++;
  } catch (err) {
    console.error('  \u2717', name);
    console.error('   ', err && err.message ? err.message : err);
    failed++;
  }
}

// Helper to build a minimal ad object
const ad = (over) => Object.assign({
  adId: 'ad_' + Math.random().toString(36).slice(2, 8),
  platform: 'meta',
  campaignName: '',
  spend: 0,
  status: 'live',
}, over);

// \u2500\u2500 Core bucketing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

test('groups ads by campaignName', () => {
  const ads = [
    ad({ adId: 'a', campaignName: 'Merlin Scaling', spend: 100 }),
    ad({ adId: 'b', campaignName: 'Merlin Scaling', spend: 50 }),
    ad({ adId: 'c', campaignName: 'Merlin Testing', spend: 20 }),
  ];
  const { groups, flatAds, showHeaders } = groupLiveAdsByCampaign(ads);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(showHeaders, true);
  assert.strictEqual(groups[0].name, 'Merlin Scaling');
  assert.strictEqual(groups[0].ads.length, 2);
  assert.strictEqual(groups[0].totalSpend, 150);
  assert.strictEqual(groups[1].name, 'Merlin Testing');
  assert.strictEqual(groups[1].totalSpend, 20);
  // flatAds preserves group order and intra-group order
  assert.deepStrictEqual(flatAds.map(a => a.adId), ['a', 'b', 'c']);
});

test('orders groups by totalSpend desc', () => {
  const ads = [
    ad({ adId: 'low1', campaignName: 'Low', spend: 5 }),
    ad({ adId: 'high1', campaignName: 'High', spend: 100 }),
    ad({ adId: 'mid1', campaignName: 'Mid', spend: 25 }),
  ];
  const { groups } = groupLiveAdsByCampaign(ads);
  assert.deepStrictEqual(groups.map(g => g.name), ['High', 'Mid', 'Low']);
});

test('pins Uncategorized bucket last even if it has the most ads', () => {
  const ads = [
    // 5 ads with no campaign
    ad({ adId: 'n1', campaignName: '' }),
    ad({ adId: 'n2', campaignName: '' }),
    ad({ adId: 'n3', campaignName: '' }),
    ad({ adId: 'n4', campaignName: '' }),
    ad({ adId: 'n5', campaignName: '' }),
    // 1 named campaign ad with low spend
    ad({ adId: 'named', campaignName: 'Retargeting', spend: 2 }),
  ];
  const { groups } = groupLiveAdsByCampaign(ads);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].name, 'Retargeting');
  assert.strictEqual(groups[1].key, NO_CAMPAIGN_KEY);
});

test('single-bucket ads set showHeaders=false (legacy brand fallback)', () => {
  const ads = [
    ad({ adId: 'a', campaignName: '' }),
    ad({ adId: 'b', campaignName: '' }),
    ad({ adId: 'c', campaignName: '' }),
  ];
  const { showHeaders, groups } = groupLiveAdsByCampaign(ads);
  assert.strictEqual(showHeaders, false);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].key, NO_CAMPAIGN_KEY);
});

test('single named campaign also sets showHeaders=false', () => {
  const ads = [
    ad({ adId: 'a', campaignName: 'Only Campaign', spend: 10 }),
    ad({ adId: 'b', campaignName: 'Only Campaign', spend: 20 }),
  ];
  const { showHeaders } = groupLiveAdsByCampaign(ads);
  assert.strictEqual(showHeaders, false);
});

test('coincident campaign names on different platforms stay separate', () => {
  // User runs "Scaling" campaign on both Meta AND TikTok — they must NOT
  // merge into one bucket with mixed platforms.
  const ads = [
    ad({ adId: 'm1', platform: 'meta',   campaignName: 'Scaling', spend: 80 }),
    ad({ adId: 't1', platform: 'tiktok', campaignName: 'Scaling', spend: 20 }),
  ];
  const { groups } = groupLiveAdsByCampaign(ads);
  assert.strictEqual(groups.length, 2);
  const metaGroup = groups.find(g => g.platform === 'meta');
  const tiktokGroup = groups.find(g => g.platform === 'tiktok');
  assert.ok(metaGroup && tiktokGroup, 'both platforms should have a group');
  assert.strictEqual(metaGroup.ads.length, 1);
  assert.strictEqual(tiktokGroup.ads.length, 1);
});

test('whitespace-only campaignName falls into Uncategorized', () => {
  const ads = [
    ad({ adId: 'a', campaignName: '   ' }),
    ad({ adId: 'b', campaignName: '\t\n' }),
  ];
  const { groups } = groupLiveAdsByCampaign(ads);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].key, NO_CAMPAIGN_KEY);
  assert.strictEqual(groups[0].ads.length, 2);
});

test('preserves intra-group input order (which is spend-desc from renderer)', () => {
  // The caller pre-sorts by spend desc; the grouper must not re-sort within
  // a group, or the "top spender first" promise breaks.
  const ads = [
    ad({ adId: 'top',    campaignName: 'C', spend: 500 }),
    ad({ adId: 'middle', campaignName: 'C', spend: 50 }),
    ad({ adId: 'low',    campaignName: 'C', spend: 5 }),
  ];
  const { flatAds } = groupLiveAdsByCampaign(ads);
  assert.deepStrictEqual(flatAds.map(a => a.adId), ['top', 'middle', 'low']);
});

test('negative or NaN spend is ignored in totalSpend (treated as zero)', () => {
  const ads = [
    ad({ adId: 'a', campaignName: 'X', spend: 10 }),
    ad({ adId: 'b', campaignName: 'X', spend: -5 }),    // shouldn't subtract
    ad({ adId: 'c', campaignName: 'X', spend: NaN }),   // shouldn't pollute
    ad({ adId: 'd', campaignName: 'X', spend: 'abc' }), // non-numeric
  ];
  const { groups } = groupLiveAdsByCampaign(ads);
  assert.strictEqual(groups[0].totalSpend, 10);
});

test('tie-breaks by ad count desc, then campaign name asc', () => {
  const ads = [
    ad({ adId: 'z1', campaignName: 'Zebra', spend: 10 }),
    ad({ adId: 'a1', campaignName: 'Alpha', spend: 10 }),
    ad({ adId: 'a2', campaignName: 'Alpha', spend: 0 }),
  ];
  const { groups } = groupLiveAdsByCampaign(ads);
  // Alpha has 2 ads at $10 total; Zebra has 1 at $10 total — spend ties,
  // count breaks the tie so Alpha ranks higher.
  assert.strictEqual(groups[0].name, 'Alpha');
  assert.strictEqual(groups[1].name, 'Zebra');
});

test('totals ignore missing/undefined spend fields', () => {
  const ads = [
    { adId: 'a', platform: 'meta', campaignName: 'X', spend: 10 },
    { adId: 'b', platform: 'meta', campaignName: 'X' },        // no spend field
    { adId: 'c', platform: 'meta', campaignName: 'X', spend: null },
  ];
  const { groups } = groupLiveAdsByCampaign(ads);
  assert.strictEqual(groups[0].ads.length, 3);
  assert.strictEqual(groups[0].totalSpend, 10);
});

// \u2500\u2500 Defensive input handling \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

test('non-array input returns empty result safely', () => {
  for (const bad of [null, undefined, 'string', 42, {}, true]) {
    const { groups, flatAds, showHeaders } = groupLiveAdsByCampaign(bad);
    assert.deepStrictEqual(groups, []);
    assert.deepStrictEqual(flatAds, []);
    assert.strictEqual(showHeaders, false);
  }
});

test('skips non-object / null entries in the ad array', () => {
  const ads = [
    null,
    undefined,
    'string',
    42,
    ad({ adId: 'real', campaignName: 'C', spend: 5 }),
  ];
  const { groups, flatAds } = groupLiveAdsByCampaign(ads);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(flatAds.length, 1);
  assert.strictEqual(flatAds[0].adId, 'real');
});

test('empty ads array produces empty result, showHeaders=false', () => {
  const { groups, flatAds, showHeaders } = groupLiveAdsByCampaign([]);
  assert.deepStrictEqual(groups, []);
  assert.deepStrictEqual(flatAds, []);
  assert.strictEqual(showHeaders, false);
});

test('exports NO_CAMPAIGN_KEY as a stable string constant', () => {
  assert.strictEqual(typeof NO_CAMPAIGN_KEY, 'string');
  assert.ok(NO_CAMPAIGN_KEY.length > 0);
});

// \u2500\u2500 Run \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

console.log(`\narchive-campaign-group tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
