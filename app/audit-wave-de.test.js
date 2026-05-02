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

test('analytics SKILL no longer claims dashboard returns LTV:CAC + payback', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '.claude', 'skills', 'merlin-analytics', 'SKILL.md'),
    'utf8',
  );
  // Pre-fix the dashboard row promised LTV:CAC + payback that the binary
  // does not compute. Sim 6 (Anna B2B SaaS) called this out as fireable.
  assert.doesNotMatch(
    src,
    /\| `dashboard` \| `brand`, `batchCount` \(days\) \| MER \+ contribution margin \+ platform ROAS table \+ LTV:CAC \+ payback,/,
    'REGRESSION: SKILL row reverted to claiming dashboard returns LTV:CAC + payback — the binary does NOT compute these; the claim is a marketing lie',
  );
  // The honest replacement must explicitly redirect unit-economics
  // questions to stripe-cohorts.
  assert.match(
    src,
    /chain `stripe-cohorts` separately/,
    'SKILL must instruct the agent to chain stripe-cohorts when the user asks unit-economics questions (LTV / payback)',
  );
  // The new stripe-cohorts row must surface the cohort-age
  // normalization caveat (Sim 6 flagged the bare AvgRevenue is
  // misleading).
  assert.match(
    src,
    /Older cohorts naturally show higher AvgRevenue/,
    'SKILL stripe-cohorts row must surface the cohort-age normalization caveat',
  );
});
