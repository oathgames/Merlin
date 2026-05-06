#!/usr/bin/env node
// test/validate-mcp-annotations.js
//
// MCP tool-annotation CI validator. Runs on every PR that touches
// `autoCMO/app/mcp-tools.js` or `autoCMO/app/mcp-meta-intent.js`.
//
// Every tool registered via defineTool() MUST declare the four annotations
// the MCP surface relies on for safety + UX:
//   • destructive: boolean  — if true the tool must also be idempotent
//   • idempotent: boolean   — if true the tool can be safely retried
//   • costImpact: 'none' | 'api' | 'spend' | 'generation'
//   • brandRequired: boolean
//
// Destructive tools also need one of:
//   • preview: false (explicitly opted out of blast-radius gating)
//   • preview: true + blastRadius(args, ctx) function
//
// How it works: this script spins up the existing test-suite fakes
// (mcp-tools.test.js has the same fakes inline) and calls buildTools()
// with a stubbed SDK. Every registration comes back with its full
// `options.annotations` — we assert on those.
//
// Run: node test/validate-mcp-annotations.js
// Exit codes:
//   0 — all tools pass
//   1 — one or more violations found
//   2 — script error (couldn't load modules, etc.)

'use strict';

const path = require('path');

const APP_DIR = path.resolve(__dirname, '..', 'app');

// ── Required annotation schema ───────────────────────────────────────────────

const REQUIRED_KEYS = ['destructive', 'idempotent', 'costImpact', 'brandRequired'];
const ALLOWED_COST_IMPACTS = new Set(['none', 'api', 'spend', 'generation']);

// ── Fakes (copied intentionally to keep this script self-contained) ─────────

function makeFakeTool() {
  const registry = [];
  const tool = (name, description, schema, handler, options) => {
    registry.push({ name, description, schema, handler, options });
    return { name };
  };
  return { tool, registry };
}

function makeFakeZ() {
  // REGRESSION GUARD (2026-05-06, ga-batchcount-type followup):
  // chain().int() supports `z.number().int()` and `z.coerce.number().int()`
  // declarations introduced for batchCount fields (ga-batchcount-type
  // session — defense-in-depth coerce-to-int so an LLM passing "7"
  // string still lands as integer 7 in the Go binary).
  const chain = () => ({
    optional: () => chain(), describe: () => chain(), default: () => chain(),
    regex: () => chain(), int: () => chain(),
  });
  return {
    string: () => chain(), number: () => chain(), boolean: () => chain(),
    any: () => chain(), enum: () => chain(), array: () => chain(),
    object: () => chain(), record: () => chain(),
    // z.coerce.number() shape — paired with .int() in the live code at
    // every batchCount declaration. mcp-batchcount-coerce.test.js
    // source-scans the declarations; this fake-zod has to mirror the
    // shape so buildTools doesn't throw at registration time.
    coerce: { number: () => chain() },
  };
}

function makeStubCtx() {
  return {
    getConnections: () => [],
    readConfig: () => ({}),
    readBrandConfig: () => ({}),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    getBinaryPath: () => '/fake',
    appRoot: APP_DIR,
    isBinaryTooOld: () => false,
    runOAuthFlow: async () => ({}),
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
  };
}

// ── Main check ───────────────────────────────────────────────────────────────

function main() {
  let buildTools;
  try {
    ({ buildTools } = require(path.join(APP_DIR, 'mcp-tools.js')));
  } catch (e) {
    console.error(`[validate-mcp-annotations] Could not load mcp-tools.js: ${e.message}`);
    process.exit(2);
  }

  const { tool, registry } = makeFakeTool();
  try {
    buildTools(tool, makeFakeZ(), makeStubCtx());
  } catch (e) {
    console.error(`[validate-mcp-annotations] buildTools threw: ${e.message}`);
    process.exit(2);
  }

  const violations = [];

  for (const entry of registry) {
    const ann = entry.options && entry.options.annotations;
    const name = entry.name || '<unknown>';

    if (!ann) {
      violations.push(`${name}: missing annotations (defineTool returned no options.annotations)`);
      continue;
    }

    // Required keys.
    for (const key of REQUIRED_KEYS) {
      if (!(key in ann)) {
        violations.push(`${name}: missing required annotation "${key}"`);
      }
    }

    // Type checks.
    if ('destructive' in ann && typeof ann.destructive !== 'boolean') {
      violations.push(`${name}: destructive must be boolean (got ${typeof ann.destructive})`);
    }
    if ('idempotent' in ann && typeof ann.idempotent !== 'boolean') {
      violations.push(`${name}: idempotent must be boolean (got ${typeof ann.idempotent})`);
    }
    if ('brandRequired' in ann && typeof ann.brandRequired !== 'boolean') {
      violations.push(`${name}: brandRequired must be boolean (got ${typeof ann.brandRequired})`);
    }
    if ('costImpact' in ann && !ALLOWED_COST_IMPACTS.has(ann.costImpact)) {
      violations.push(`${name}: costImpact="${ann.costImpact}" not in {${[...ALLOWED_COST_IMPACTS].join(', ')}}`);
    }

    // Cross-field rules.
    //
    // REGRESSION GUARD (2026-05-06, Gitar review on PR #224 followup):
    // Pre-fix this rule rejected `destructive: true, idempotent: false`.
    // That baked in a falsehood for inherently non-idempotent destructive
    // operations (Reddit comment posts, single-send Klaviyo campaigns,
    // SMS blasts) — every call mutates a unique public artifact, retry
    // semantics differ. Marking them idempotent:true would have let the
    // framework's idempotency cache silently return stale failures on
    // retried calls. Now the rule only requires `idempotent` to be a
    // boolean (universal annotation rule already enforced by
    // mcp-define-tool.js). Either value is valid for destructive tools;
    // false is a deliberate "retries create dupes" annotation.
    if (ann.destructive === true && typeof ann.idempotent !== 'boolean') {
      violations.push(`${name}: destructive tools MUST declare idempotent explicitly (true | false)`);
    }

    // Preview gating: if destructive, preview must be explicitly set.
    // (mcp-define-tool.js already warns on this at construction time; CI
    // turns the warning into a hard stop.)
    if (ann.destructive === true && !('preview' in ann)) {
      violations.push(`${name}: destructive tools MUST declare preview: true | false (blast-radius gating opt-in/out)`);
    }
  }

  // Summary.
  const total = registry.length;
  if (violations.length === 0) {
    console.log(`[validate-mcp-annotations] ✓ ${total} tool(s) pass annotation checks.`);
    process.exit(0);
  }

  console.error(`[validate-mcp-annotations] ✗ ${violations.length} violation(s) across ${total} tool(s):`);
  for (const v of violations) console.error(`  • ${v}`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { main };
