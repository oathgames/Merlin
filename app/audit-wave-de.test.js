// REGRESSION GUARDS for audit Wave D+E (2026-05-02): user-facing UX
// honesty fixes from the 10-persona audit.
//
// (E10) Sim 10 (grandma persona) flagged that surfacing the literal
//       vendor name "fal.ai" / "ElevenLabs" / "HeyGen" to a non-
//       technical user looks like phishing. friendlyError now maps
//       these to capability labels ("image generation", "voice
//       generation", "video generation") and routes the user to
//       Settings rather than a third-party URL.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('renderer.js friendlyError no longer surfaces fal.ai vendor name to grandma-persona users', () => {
  const src = fs.readFileSync(
    path.join(__dirname, 'renderer.js'),
    'utf8',
  );
  // The pre-fix shipped strings — these MUST be gone from the live
  // friendlyError path. Match the literal user-facing template.
  assert.doesNotMatch(
    src,
    /Your fal\.ai balance is empty\\nTry: Add credits at fal\.ai\/dashboard/,
    'REGRESSION: friendlyError reverted to leaking the fal.ai vendor name to non-technical users (Sim 10 grandma — looks like phishing)',
  );
  // The replacement template must use capability labels + Settings
  // routing (no third-party URL). The user-visible string is built
  // at runtime via `${capability} credits ran out` so the test
  // matches the literal source fragments rather than the rendered
  // string.
  assert.match(
    src,
    /capability = 'image generation'/,
    'friendlyError must map fal.ai → "image generation" capability label (not the vendor name)',
  );
  assert.match(
    src,
    /capability = 'voice generation'/,
    'friendlyError must map ElevenLabs → "voice generation" capability label',
  );
  assert.match(
    src,
    /capability = 'video generation'/,
    'friendlyError must map HeyGen → "video generation" capability label',
  );
  assert.match(
    src,
    /credits ran out/,
    'friendlyError must include the "credits ran out" wording (capability-led, not vendor-led)',
  );
  assert.match(
    src,
    /Open Settings → Connections to add more credits/,
    'friendlyError must route the user to in-app Settings rather than a third-party URL the user has never seen',
  );
});

test('analytics SKILL describes dashboard\'s NC-ROAS + LTV surface (Wave F-1)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '.claude', 'skills', 'merlin-analytics', 'SKILL.md'),
    'utf8',
  );
  // Pre-Wave-F: the dashboard row promised LTV:CAC + payback that the
  // binary did not compute (Sim 6 Anna). Wave D+E made the claim
  // honest by saying "chain stripe-cohorts." Wave F-1 actually built
  // NC-ROAS + LTV + LTV:CAC + payback into the dashboard, so the
  // SKILL row now describes the real surface — and must NOT regress
  // to silently promising metrics the binary doesn't compute.
  assert.doesNotMatch(
    src,
    /\| `dashboard` \| `brand`, `batchCount` \(days\) \| MER \+ contribution margin \+ platform ROAS table \+ LTV:CAC \+ payback,/,
    'REGRESSION: SKILL row reverted to the pre-Wave-F shape that promised LTV:CAC + payback as a flat list (without describing the confidence label or the Shopify orders_count==1 source).',
  );
  // The Wave-F dashboard row must cite NC-ROAS + LTV authoritatively
  // and explain the confidence label so the agent doesn't render a
  // 0 LTV as "$0 LTV" when the brand has no cohort yet.
  assert.match(
    src,
    /NC-ROAS, LTV, LTV:CAC, payback/,
    'SKILL must describe the new NC-ROAS + LTV + LTV:CAC + payback surface returned by dashboard',
  );
  assert.match(
    src,
    /confidence/,
    'SKILL must mention the LTV confidence label so the agent doesn\'t render 0 as "$0 LTV"',
  );
  // The stripe-cohorts row must still surface the cohort-age
  // normalization caveat (Sim 6 flagged the bare AvgRevenue is
  // misleading).
  assert.match(
    src,
    /Older cohorts naturally show higher AvgRevenue/,
    'SKILL stripe-cohorts row must surface the cohort-age normalization caveat',
  );
});
