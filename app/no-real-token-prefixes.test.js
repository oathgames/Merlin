// Pre-PR guard against test fixtures that resemble real Anthropic OAuth
// tokens (sk-ant-oat01-* / sk-ant-ort01-* / sk-ant-api03-*).
//
// Why: secret scanners (GitGuardian, TruffleHog) flag any string with the
// real prefix as a "Generic High Entropy Secret" the moment a PR opens —
// even if the fixture is obviously a fake (e.g. "sk-ant-oat01-abc"). A
// merged PR with that prefix in source produces a high-priority security
// alert that takes effort to triage and dismiss as "false positive,
// fixture only." Worse, it desensitizes reviewers to real token leaks.
//
// Live incident 2026-04-27: app/auth-credentials.test.js was merged with
// six fake-but-prefix-matching strings. GitGuardian flagged all six.
//
// Rule: NO test fixture may carry a real Anthropic token prefix. Use
// `FAKE_ACCESS_TOKEN_*` / `FAKE_REFRESH_TOKEN_*` / `TEST_KEY_*` instead.
// This file source-scans every app/*.test.js for the real prefixes
// inside string literals and fails the build on any hit. Comments,
// regex patterns, and prose mentioning the prefix as a string fragment
// are ignored — only quoted string LITERALS that start with the prefix
// trip the rule.
//
// Run with: node app/no-real-token-prefixes.test.js

const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.log('  ✗', name);
    console.log('   ', err.message);
    failed++;
  }
}

// Collect every app/*.test.js (excluding this file) plus app/*.test.mjs.
const TEST_FILES = fs.readdirSync(APP_DIR)
  .filter((f) => /\.test\.m?js$/.test(f) && f !== 'no-real-token-prefixes.test.js')
  .map((f) => path.join(APP_DIR, f));

// The Anthropic real-token prefixes we want to keep out of source. Each
// matches a different token kind:
//   sk-ant-oat01- — OAuth access token (Claude Code)
//   sk-ant-ort01- — OAuth refresh token (Claude Code)
//   sk-ant-api03- — direct API key
const REAL_PREFIX_PATTERNS = [
  { name: 'sk-ant-oat01-', regex: /['"`]sk-ant-oat01-[^'"`]*['"`]/ },
  { name: 'sk-ant-ort01-', regex: /['"`]sk-ant-ort01-[^'"`]*['"`]/ },
  { name: 'sk-ant-api03-', regex: /['"`]sk-ant-api03-[^'"`]*['"`]/ },
];

for (const file of TEST_FILES) {
  const rel = path.relative(path.dirname(APP_DIR), file).replace(/\\/g, '/');
  test(`${rel} contains no real-prefix Anthropic token literals`, () => {
    const src = fs.readFileSync(file, 'utf8');
    // Strip line comments and block comments so a documentary mention
    // (e.g. "sk-ant-oat01- starts with sk-") inside a comment doesn't
    // trip the scan.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const hits = [];
    for (const pat of REAL_PREFIX_PATTERNS) {
      const m = code.match(pat.regex);
      if (m) hits.push(`${pat.name} → ${m[0]}`);
    }
    if (hits.length > 0) {
      throw new Error(
        `Found ${hits.length} real-prefix token literal(s) in ${rel}:\n`
        + hits.map((h) => `        ${h}`).join('\n')
        + '\n\n'
        + '        Replace with FAKE_ACCESS_TOKEN_* / FAKE_REFRESH_TOKEN_* '
        + 'placeholders. Real prefixes trigger GitGuardian as a "Generic '
        + 'High Entropy Secret" the moment the PR opens, regardless of '
        + 'whether the value is obviously a test fake.'
      );
    }
  });
}

// ─── done ──────────────────────────────────────────────────────────────────
console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
