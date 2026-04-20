'use strict';

// test/validate-skills.test.js
//
// REGRESSION GUARD (2026-04-20)
// --------------------------------------------------------------------------
// The skill validator's action-coverage check used to only try three forms
// of a reference: the raw action name, `tool-action`, and `tool-with-dashes-
// action`. That missed every skill reference where the MCP wrapper rewrites
// the action name into a differently-prefixed Go handler, e.g.
//     meta_ads({action:"kill"})         → Go case "meta-kill"
//     decisions({action:"queue"})       → Go case "decision-queue"
//     competitor_spy({action:"ads-by-brand"}) → Go case "foreplay-ads-by-brand"
// Those four warnings sat open in CI output for weeks because they looked
// cosmetic. The validator now also accepts any Go handler whose name ends
// with `-<raw_action>` as coverage — robust to future MCP tools with new
// prefix conventions without hardcoding a per-tool map that would itself
// silently go stale.
//
// These tests pin the behavior so a well-intentioned "simplify the
// candidate list" refactor can't reintroduce the four false positives.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectActionReferences,
  validateActionCoverage,
} = require('./validate-skills');

test('validateActionCoverage: meta_ads({action:"kill"}) resolves via -kill suffix to meta-kill', () => {
  const body = 'Example: mcp__merlin__meta_ads({action: "kill", adId: "x"})';
  const mainGo = new Set(['meta-kill', 'meta-push']);
  const warnings = [];
  validateActionCoverage({ name: 'merlin-setup' }, body, mainGo, warnings);
  assert.deepEqual(warnings, [], 'meta-kill should cover meta_ads({action:"kill"}) via suffix match');
});

test('validateActionCoverage: meta_ads({action:"duplicate"}) resolves via -duplicate suffix to meta-duplicate', () => {
  const body = 'Example: mcp__merlin__meta_ads({action: "duplicate", adId: "x"})';
  const mainGo = new Set(['meta-duplicate']);
  const warnings = [];
  validateActionCoverage({ name: 'merlin-setup' }, body, mainGo, warnings);
  assert.deepEqual(warnings, []);
});

test('validateActionCoverage: decisions({action:"queue"}) resolves via -queue suffix to decision-queue (singular)', () => {
  const body = 'Call mcp__merlin__decisions({action:"queue", brand:"x"})';
  const mainGo = new Set(['decision-queue']); // singular; MCP tool name is plural `decisions`
  const warnings = [];
  validateActionCoverage({ name: 'merlin-setup' }, body, mainGo, warnings);
  assert.deepEqual(warnings, []);
});

test('validateActionCoverage: competitor_spy({action:"ads-by-brand"}) resolves via -ads-by-brand suffix to foreplay-ads-by-brand', () => {
  const body = 'mcp__merlin__competitor_spy({action: "ads-by-brand", foreplayBrandIds: "x"})';
  const mainGo = new Set(['foreplay-ads-by-brand', 'foreplay-ad-duplicates']);
  const warnings = [];
  validateActionCoverage({ name: 'merlin-tournament' }, body, mainGo, warnings);
  assert.deepEqual(warnings, []);
});

test('validateActionCoverage: still warns when NO handler matches — suffix match does not rubber-stamp typos', () => {
  const body = 'mcp__merlin__meta_ads({action: "explodinate", adId: "x"})';
  const mainGo = new Set(['meta-kill', 'meta-duplicate', 'decision-queue']);
  const warnings = [];
  validateActionCoverage({ name: 'merlin-setup' }, body, mainGo, warnings);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /references action "explodinate"/);
  assert.match(warnings[0], /any handler ending with "-explodinate"/);
});

test('validateActionCoverage: exact-match still preferred (exact-matching refs do not fall through to suffix scan)', () => {
  const body = 'Direct: { "action": "generate" }';
  const mainGo = new Set(['generate']);
  const warnings = [];
  validateActionCoverage({ name: 'merlin-content' }, body, mainGo, warnings);
  assert.deepEqual(warnings, []);
});

test('validateActionCoverage: suffix match is anchored on the dash — a raw action "kill" does NOT spuriously match "overkill"', () => {
  // Guard against a naive `.includes(ref.raw)` regression — the suffix must
  // be `-<raw>`, not the bare substring. Otherwise "kill" would match
  // "skillgrowth-overkill" (silly example, but the principle matters).
  const body = 'mcp__merlin__meta_ads({action: "kill", adId: "x"})';
  const mainGo = new Set(['skill-overkill']); // ends with "overkill", not "-kill"
  const warnings = [];
  validateActionCoverage({ name: 'merlin-setup' }, body, mainGo, warnings);
  assert.equal(warnings.length, 1, 'should still warn — "skill-overkill" is not a valid coverage for "kill"');
});

test('validateActionCoverage: suffix match IS anchored on the dash — "skill-kill" DOES match "kill" (legitimate)', () => {
  const body = 'mcp__merlin__meta_ads({action: "kill", adId: "x"})';
  const mainGo = new Set(['skill-kill']); // ends with "-kill"
  const warnings = [];
  validateActionCoverage({ name: 'merlin-setup' }, body, mainGo, warnings);
  assert.deepEqual(warnings, []);
});

test('collectActionReferences: mcp-wrapped refs produce the three legacy candidate forms', () => {
  const refs = collectActionReferences('mcp__merlin__meta_ads({action: "kill"})');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].raw, 'kill');
  // candidates still include the three legacy forms — exact match on any of
  // them is the primary signal, suffix match is only the fallback.
  assert.ok(refs[0].candidates.includes('kill'));
  assert.ok(refs[0].candidates.includes('meta_ads-kill'));
  assert.ok(refs[0].candidates.includes('meta-ads-kill'));
});

test('collectActionReferences: bare {"action": "X"} refs parse as single-candidate', () => {
  const refs = collectActionReferences('Direct: { "action": "generate" }');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].raw, 'generate');
  assert.deepEqual(refs[0].candidates, ['generate']);
});
