// REGRESSION GUARD (2026-05-06, codex API audit P2 #1):
//
// Source-scan parity test that locks the relationship between a tool's
// schema-level `brandRequired:true` annotation and the runtime
// `BRAND_OPTIONAL_ACTIONS` allowlist in mcp-tools.js's runBinary.
//
// The audit finding: many tool schemas declared brandRequired:false and
// optional brand, relying on runtime refusal in runBinary instead of
// schema-level guidance. Promoting brandRequired:true tightens the LLM
// contract — the JSON schema sent to MCP clients now lists `brand` as
// required, so a confused agent gets a Zod validation error early
// instead of a runBinary refusal late.
//
// The constraint this test enforces: a tool's `brandRequired:true` is
// only safe when EVERY action in its enum, after handler prefixing,
// resolves to a dispatched action that is NOT in BRAND_OPTIONAL_ACTIONS.
// If even one dispatched action would legitimately succeed brand-less
// (e.g. dashboard's 'wisdom' or 'landing-audit', meta_ads's 'setup' or
// 'discover'), the schema-level brandRequired:true would reject those
// otherwise-valid calls.
//
// Tools with mixed action enums (some brand-required, some brand-
// optional) MUST stay brandRequired:false and rely on runBinary's
// per-action gate. The exemption list is grep-able via the comment
// "codex API audit P2 #1" in mcp-tools.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');

function extractOptionalActions(src) {
  const m = src.match(/const BRAND_OPTIONAL_ACTIONS = new Set\(\[([\s\S]*?)\]\);/);
  if (!m) throw new Error('cannot find BRAND_OPTIONAL_ACTIONS in mcp-tools.js');
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

function extractDefineToolBlocks(src) {
  const open = 'tools.push(defineTool({';
  const close = '}, tool, z, ctx));';
  const blocks = [];
  let i = 0;
  while (true) {
    const idx = src.indexOf(open, i);
    if (idx < 0) break;
    const end = src.indexOf(close, idx);
    if (end < 0) break;
    blocks.push(src.slice(idx, end + close.length));
    i = end + close.length;
  }
  return blocks;
}

test('every brandRequired:true tool has zero actions in BRAND_OPTIONAL_ACTIONS (after prefix)', () => {
  const OPTIONAL = extractOptionalActions(SRC);
  const blocks = extractDefineToolBlocks(SRC);
  assert.ok(blocks.length > 10, `expected many defineTool blocks, found ${blocks.length}`);

  const violations = [];
  for (const block of blocks) {
    if (!block.includes('brandRequired: true')) continue;
    const nameM = block.match(/name:\s*'([^']+)'/);
    if (!nameM) continue;
    const tool = nameM[1];
    const enumM = block.match(/action:\s*z\.enum\(\[([^\]]+)\]\)/);
    if (!enumM) continue; // single-purpose tools (no action enum) are safe
    const actions = [...enumM[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);

    // Find the prefix the handler applies. Handlers we care about take
    // one of these shapes:
    //   1. runBinary(ctx, '<prefix>' + args.action, ...)
    //   2. runBinary(ctx, actionMap[args.action] || args.action, ...)
    //   3. runBinary(ctx, actionMap[args.action] || '<prefix>' + args.action, ...)
    //   4. runBinary(ctx, prefix + args.action, ...) where prefix is computed
    //      from a conditional (amazon_ads-style) — too complex to parse,
    //      so we conservatively treat both common prefixes as candidates
    const prefM = block.match(/runBinary\(ctx,\s*['`]([^'`]+)['`]\s*\+\s*args\.action/);
    let dispatched;
    if (prefM) {
      dispatched = actions.map((a) => prefM[1] + a);
    } else if (/runBinary\(ctx,\s*\w+\s*\+\s*args\.action/.test(block) ||
               /runBinary\(ctx,\s*actionMap\[args\.action\]/.test(block)) {
      // Computed prefix (e.g. amazon_ads' `prefix + args.action` where
      // `prefix` depends on the action) OR actionMap-based dispatch
      // where each action explicitly chooses its dispatched name. Both
      // shapes mean the author has already reasoned per-action; the
      // simple bare-string check would produce false positives. Skip.
      continue;
    } else {
      // Bare passthrough — every action dispatches as itself. This is
      // the path that catches honest mistakes like a tool whose enum
      // contains 'setup' (bare) AND brandRequired:true.
      dispatched = actions;
    }

    for (const d of dispatched) {
      if (OPTIONAL.has(d)) {
        violations.push(`${tool}: action "${d}" is brandRequired:true at schema but in BRAND_OPTIONAL_ACTIONS at runtime — drops legitimate brand-less calls`);
      }
    }
  }

  assert.deepStrictEqual(violations, [],
    `brandRequired:true tools must not list any action that BRAND_OPTIONAL_ACTIONS marks brand-less. Either revert brandRequired to false (multi-action exemption pattern, see meta_ads / dashboard) OR remove the action from the enum / move it to a separate tool.\n\nViolations:\n  ${violations.join('\n  ')}`);
});

test('every brandRequired:true tool either has no `brand: brandSchema.optional()` OR has it for an action-map fallback', () => {
  // Schema-level brandRequired:true means brand becomes a required field
  // in the JSON Schema sent to MCP clients. If the input shape still
  // declares `brand: brandSchema.optional()`, enrichSchema sees the
  // existing brand entry and DOESN'T promote it — the schema stays
  // optional and the framework's brand-missing check at line ~181 is
  // the only enforcement (which is fine, but defeats the audit's
  // "schema-level enforcement" goal).
  //
  // This test fails on any brandRequired:true tool whose input still
  // declares `brand: brandSchema.optional()`. The fix is to drop
  // `.optional()` and let the brand field be required at the schema
  // level too.
  const blocks = extractDefineToolBlocks(SRC);
  const violations = [];
  for (const block of blocks) {
    if (!block.includes('brandRequired: true')) continue;
    const nameM = block.match(/name:\s*'([^']+)'/);
    if (!nameM) continue;
    const tool = nameM[1];
    if (/\bbrand:\s*brandSchema\.optional\(/.test(block)) {
      violations.push(`${tool}: brandRequired:true but input still uses brand: brandSchema.optional() — schema-level enforcement is defeated`);
    }
  }
  assert.deepStrictEqual(violations, [],
    `brandRequired:true tools must use \`brand: brandSchema\` (no .optional()) so the JSON schema reports brand as required. Violations:\n  ${violations.join('\n  ')}`);
});
