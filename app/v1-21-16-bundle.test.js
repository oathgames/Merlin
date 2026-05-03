// v1-21-16-bundle.test.js — regression guards for tonight's bundle.
// Covers: cancel UX (escape-cancel-leaves-stale-bubble), chat-gallery
// partial-render v2, refine artifact emit, content SKILL gallery
// instruction, scale_winner action routing, Meta upload error_user_msg
// surfacing, bulk-push campaignId resolver, brand-match page picker.
//
// Source-scan style — pins each fix's contract so a future "tighten /
// cleanup" sweep can't silently revert any of them.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rendererPath = path.join(__dirname, 'renderer.js');
const stylePath = path.join(__dirname, 'style.css');
const artifactParserPath = path.join(__dirname, 'artifact-parser.js');
const metaIntentPath = path.join(__dirname, 'mcp-meta-intent.js');
const contentSkillPath = path.join(__dirname, '..', '.claude', 'skills', 'merlin-content', 'SKILL.md');
const metaGoPath = path.join(__dirname, '..', '..', 'autocmo-core', 'meta.go');
const refinementGoPath = path.join(__dirname, '..', '..', 'autocmo-core', 'creative_refinement.go');

// ── Cancel UX ────────────────────────────────────────────────────────

test('Escape cancel calls abortActiveQuery (not stopGeneration alone)', () => {
  const src = fs.readFileSync(rendererPath, 'utf8');
  const m = src.match(/if \(e\.key === 'Escape' && \(isStreaming \|\| sessionActive\)\)[\s\S]*?\n  \}/);
  assert.ok(m, 'Escape handler block must exist');
  const block = m[0];
  assert.match(block, /merlin\.abortActiveQuery/, 'Escape MUST call abortActiveQuery to truly interrupt the SDK; stopGeneration alone only ends the next-turn generator');
  assert.match(block, /clearStatusLabel/, 'Escape MUST clear the "TALKING TO …" status pill');
  assert.match(block, /dataset\.canceled\s*=\s*['"]true['"]/, 'Escape MUST mark the current bubble canceled so late-arriving tokens drop');
});

test('appendText drops writes to a canceled bubble', () => {
  const src = fs.readFileSync(rendererPath, 'utf8');
  assert.match(src, /currentBubble\.dataset\.canceled === 'true'[\s\S]{0,100}return/, 'appendText must early-return when the current bubble was canceled');
});

test('content_block_start opens fresh bubble when prior was canceled', () => {
  const src = fs.readFileSync(rendererPath, 'utf8');
  assert.match(src, /if \(!currentBubble \|\| currentBubble\.dataset\.canceled === 'true'\)/, 'content_block_start must open a fresh bubble when prior was canceled — otherwise the next turn absorbs into the stale bubble');
});

// ── Sluggishness Win 1: prefix-cache reuse ───────────────────────────

test('streaming prefix cache reuses _streamRenderState.prefixHtml across frames', () => {
  const src = fs.readFileSync(rendererPath, 'utf8');
  // The reuse branch must concatenate cached prefixHtml + delta render,
  // not re-parse the full prefix every frame.
  assert.match(src, /_streamRenderState\.prefixHtml\s*\+\s*renderMarkdown\(deltaPrefix\)/, 'streaming prefix cache must reuse cached HTML and only render the delta — pre-fix it re-parsed the full prefix every frame');
});

// ── Chat-gallery partial-render v2 ───────────────────────────────────

test('.merlin-artifact img drops black background + uses data-loaded gate', () => {
  const css = fs.readFileSync(stylePath, 'utf8');
  const blockMatch = css.match(/\.merlin-artifact img,\s*\.merlin-artifact video\s*\{[^}]*\}/);
  assert.ok(blockMatch, '.merlin-artifact img/video block must exist');
  assert.match(blockMatch[0], /background:transparent/, '.merlin-artifact img/video must declare background:transparent — partial-decoded scanlines must not show through as a stuck black band');
  // Negative guard — strip comments first, then assert no live rule sets background:#000.
  const blockNoComments = blockMatch[0].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(blockNoComments, /background:\s*#000/, 'REGRESSION: .merlin-artifact has a live background:#000 rule — the partial-render surface');
  assert.match(css, /\.merlin-artifact img:not\(\[data-loaded="true"\]\)\s*\{[^}]*opacity\s*:\s*0/, 'IMG must be opacity:0 until data-loaded="true" — defense-in-depth against partial decode');
  assert.match(css, /\.merlin-artifact img\[data-loaded="true"\]\s*\{[^}]*opacity\s*:\s*1/, 'IMG must be opacity:1 when data-loaded="true"');
});

test('renderer flips data-loaded on chat-artifact img load events', () => {
  const src = fs.readFileSync(rendererPath, 'utf8');
  // The hook must walk all .merlin-artifact img elements and attach
  // load + error listeners that flip data-loaded='true'.
  assert.match(src, /merlin-artifact img:not\(\[data-loaded\]\)/, 'gallery hook must select unflagged imgs');
  assert.match(src, /img\.dataset\.loaded\s*=\s*['"]true['"]/, 'gallery hook must flip dataset.loaded to true on load');
  assert.match(src, /img\.complete && img\.naturalWidth > 0/, 'gallery hook must short-circuit for cache-hit images so the shimmer does not blink');
});

test('artifact-parser image template declares decoding=async', () => {
  const src = fs.readFileSync(artifactParserPath, 'utf8');
  // The image branch of the switch must contain a body assignment with
  // decoding="async". Anchored on the case label to scope the search.
  const imageBranch = src.match(/case 'image':[\s\S]{0,800}?break;/);
  assert.ok(imageBranch, 'artifact-parser must have an image case in renderItemHtml');
  assert.match(imageBranch[0], /decoding="async"/, 'artifact-parser image template must declare decoding="async" so bitmap decode runs off the main thread');
  assert.match(imageBranch[0], /<img src=/, 'artifact-parser image template must produce an <img> tag');
});

// ── Fan-of-cards ─────────────────────────────────────────────────────

test('content SKILL instructs Claude to echo gallery <div> blocks verbatim', () => {
  const skill = fs.readFileSync(contentSkillPath, 'utf8');
  assert.match(skill, /MANDATORY post-tool: echo the gallery block verbatim/, 'content SKILL must contain the post-tool gallery-echo instruction');
  assert.match(skill, /merlin-gallery/, 'content SKILL must reference the merlin-gallery class so Claude knows what to echo');
  assert.match(skill, /must echo each block verbatim/i, 'content SKILL must instruct Claude to echo verbatim — paraphrasing was the original incident');
});

test('creative_refinement.go emits artifact bundle for refine winners', () => {
  const src = fs.readFileSync(refinementGoPath, 'utf8');
  assert.match(src, /emitArtifactBundle\(ArtifactBundle\{/, 'runRefineCreative must call emitArtifactBundle so the renderer renders the refined winner as a gallery card');
  assert.match(src, /Refined winner/, 'emitted artifact must be labeled — "Refined winner" anchors the visible label');
  assert.match(src, /fan-of-cards-missing-on-variants incident/, 'REGRESSION GUARD comment must anchor the 2026-05-03 incident');
});

// ── Meta scale_winner routing ────────────────────────────────────────

test('meta_scale_winner routes to meta-duplicate (not meta-warmup)', () => {
  const src = fs.readFileSync(metaIntentPath, 'utf8');
  // The handler block for meta_scale_winner must invoke 'meta-duplicate'.
  const block = src.match(/name:\s*'meta_scale_winner'[\s\S]*?\}, tool, z, ctx\)\)/);
  assert.ok(block, 'meta_scale_winner block must exist');
  assert.match(block[0], /runBinary\(ctx,\s*['"]meta-duplicate['"]/, 'meta_scale_winner MUST route to meta-duplicate — pre-fix it routed to meta-warmup which is the API-permissions ladder, not scaling. Silent no-op on a costImpact:spend tool was the bug.');
  assert.doesNotMatch(block[0], /runBinary\(ctx,\s*['"]meta-warmup['"]/, 'REGRESSION: meta_scale_winner reverted to meta-warmup — silent no-op on spend');
});

// ── Meta upload error surfacing ──────────────────────────────────────

test('meta.go image/video upload + batch errors route through metaErrorPreview', () => {
  const src = fs.readFileSync(metaGoPath, 'utf8');
  // All three sites — image upload, video upload, batch sub-response —
  // must call metaErrorPreview(body) so error_user_title +
  // error_user_msg get surfaced. Pre-fix they returned the raw body
  // (or 200-char truncation for batch) which dropped the
  // human-readable resource identification.
  assert.match(src, /Meta image upload HTTP %d: %s["][^\n]*metaErrorPreview\(body\)/, 'image upload error must route through metaErrorPreview');
  assert.match(src, /Meta video upload HTTP %d: %s["][^\n]*metaErrorPreview\(body\)/, 'video upload error must route through metaErrorPreview');
  assert.match(src, /Meta batch API HTTP %d: %s["][^\n]*metaErrorPreview\(body\)/, 'batch API error must route through metaErrorPreview — bulk-push fans out via ExecuteBatch and was hitting the truncated-raw-body path');
  // Negative guards: the raw-body forms must NOT appear.
  assert.doesNotMatch(src, /Meta image upload HTTP %d: %s["][^\n]*string\(body\)/, 'REGRESSION: image upload reverted to raw body');
  assert.doesNotMatch(src, /Meta video upload HTTP %d: %s["][^\n]*string\(body\)/, 'REGRESSION: video upload reverted to raw body');
});

// ── Meta bulk-push campaignId resolver ───────────────────────────────

test('meta.go has resolveTargetCampaign and runMetaPush + runMetaBulkPush use it', () => {
  const src = fs.readFileSync(metaGoPath, 'utf8');
  assert.match(src, /func resolveTargetCampaign\(cfg \*Config, cmd \*Command\)/, 'resolveTargetCampaign helper must exist');
  // The body must check cmd.CampaignID first, then cmd.CampaignName, then fall back to metaEnsureCampaigns.
  const fn = src.match(/func resolveTargetCampaign[\s\S]*?\n\}/);
  assert.ok(fn, 'resolveTargetCampaign body must be readable');
  assert.match(fn[0], /cmd\.CampaignID/, 'resolveTargetCampaign must check cmd.CampaignID first');
  assert.match(fn[0], /cmd\.CampaignName/, 'resolveTargetCampaign must check cmd.CampaignName second');
  assert.match(fn[0], /metaEnsureCampaigns\(cfg\)/, 'resolveTargetCampaign must fall back to auto-create Testing campaign');
  assert.match(fn[0], /metaFindCampaign\(cfg, cmd\.CampaignName\)/, 'resolveTargetCampaign must use metaFindCampaign for name lookup');
  // Both push paths must use the helper, not metaEnsureCampaigns directly.
  // Run a count: there should be 4+ resolveTargetCampaign call sites.
  const calls = (src.match(/resolveTargetCampaign\(cfg, cmd\)/g) || []).length;
  assert.ok(calls >= 3, `expected at least 3 resolveTargetCampaign call sites in runMetaPush + runMetaBulkPush, got ${calls}`);
});

test('meta_launch_test_batch + meta_launch_test_ad accept campaignId', () => {
  const src = fs.readFileSync(metaIntentPath, 'utf8');
  // Both schemas must declare a campaignId optional string.
  const launchAdBlock = src.match(/name:\s*'meta_launch_test_ad'[\s\S]*?\}, tool, z, ctx\)\)/);
  assert.ok(launchAdBlock);
  assert.match(launchAdBlock[0], /campaignId:\s*z\.string\(\)\.optional/, 'meta_launch_test_ad must accept campaignId');
  const launchBatchBlock = src.match(/name:\s*'meta_launch_test_batch'[\s\S]*?\}, tool, z, ctx\)\)/);
  assert.ok(launchBatchBlock);
  assert.match(launchBatchBlock[0], /campaignId:\s*z\.string\(\)\.optional/, 'meta_launch_test_batch must accept campaignId');
});

// ── Brand-match Meta page picker ─────────────────────────────────────

test('runMetaLogin accepts *Command and brand-matches pages + ad accounts', () => {
  const src = fs.readFileSync(metaGoPath, 'utf8');
  assert.match(src, /func runMetaLogin\(cfg \*Config, cmd \*Command, pre \*OAuthResult\)/, 'runMetaLogin signature must accept *Command so cmd.Brand reaches the page-picking logic');
  // The brand-match must use brandMatches against page name + ad account name.
  // Anchored on the post-2026-05-03 fix block to guard against regression to
  // the blind-pick-Data[0] form.
  assert.match(src, /brand-swap-picks-wrong-page/, 'runMetaLogin must carry the REGRESSION GUARD anchoring the 2026-05-03 incident');
  assert.match(src, /brandMatches\(p\.Name, brandName\)/, 'runMetaLogin must brand-match page names');
  assert.match(src, /brandMatches\(a\.Name, brandName\)/, 'runMetaLogin must brand-match ad account names');
});
