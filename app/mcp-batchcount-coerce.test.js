// REGRESSION GUARD (2026-05-06, ga-batchcount-type incident):
//
// Live user report: "the GA wrapper advertises batchCount as a string,
// but the backend wants an integer. I'm retrying that cleanly now; no
// data judgment from the failed calls."
//
// Root cause: the prior schema declared `batchCount: z.number().optional()`
// which generates a `{type: "number"}` JSON schema. Something in the
// LLM-facing pipeline (Anthropic SDK schema generator, stale schema
// cache on the MCP client, agent confusion from the long-form
// description) advertised the field as string-typed and the LLM
// passed `"7"` instead of `7`. Go's `BatchCount int` JSON unmarshal
// rejected the string and the call failed.
//
// Defense-in-depth fix: switch to `z.coerce.number().int().optional()`
// on every batchCount declaration. Properties:
//   1. The JSON schema now declares `{type: "integer"}` (was `"number"`,
//      which permits floats — sloppy for a days-counter).
//   2. `z.coerce.number()` accepts both number AND string inputs and
//      coerces strings via `Number(value)`. So even if a confused agent
//      passes `"7"`, zod normalizes it to `7` BEFORE the value reaches
//      runBinary — the Go binary never sees a string.
//
// This source-scan locks the pattern in. Any future edit that re-
// introduces `batchCount: z.number()` without the coerce + int will
// fail CI.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TARGET_FILES = [
  path.join(__dirname, 'mcp-tools.js'),
  path.join(__dirname, 'mcp-meta-intent.js'),
];

test('every batchCount declaration uses z.coerce.number().int()', () => {
  const violations = [];
  for (const file of TARGET_FILES) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/\bbatchCount\s*:/.test(line)) continue;
      // Allow the canonical form OR a string-coerce alternate.
      // Reject the legacy `z.number()` (no coerce) form because it
      // generates `{type: "number"}` and rejects string inputs.
      if (!/z\.coerce\.number\(\)\.int\(\)/.test(line)) {
        violations.push(`${path.basename(file)}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepStrictEqual(violations, [],
    `every batchCount declaration must use z.coerce.number().int() so the schema advertises {type: "integer"} AND accepts a string-coerced value as defense-in-depth against confused LLM/SDK pipelines. Violations:\n  ${violations.join('\n  ')}`);
});

test('coerce.number().int() accepts both number and string inputs', () => {
  // Sanity-check zod itself behaves the way we expect — if a future
  // SDK upgrade changes coerce semantics, this test surfaces it
  // before we ship a regression.
  let z;
  try {
    z = require('zod');
  } catch {
    // zod not in dev deps; the SDK provides it at runtime. Skip.
    return;
  }
  const schema = z.coerce.number().int().optional();

  // Number passes through.
  assert.equal(schema.parse(7), 7);
  assert.equal(schema.parse(30), 30);
  // String coerces to number.
  assert.equal(schema.parse('7'), 7);
  assert.equal(schema.parse('30'), 30);
  // Negative is allowed (GA's batchCount uses -1 for "today only").
  assert.equal(schema.parse(-1), -1);
  assert.equal(schema.parse('-1'), -1);
  // undefined → undefined (optional).
  assert.equal(schema.parse(undefined), undefined);
  // Float rejected by .int() — caller is expected to pass an integer.
  assert.throws(() => schema.parse(7.5));
  // Non-numeric string rejected — Number("abc") = NaN, .int() rejects.
  assert.throws(() => schema.parse('abc'));
});
