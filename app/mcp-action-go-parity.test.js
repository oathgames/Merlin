// mcp-action-go-parity.test.js
//
// REGRESSION GUARD (2026-05-10, C004):
// MCP-tool action-enum ↔ Go binary case-statement parity. Whenever an
// MCP tool ships a new `action: z.enum([...])` value, the corresponding
// `case "<prefix>-<action>":` MUST exist in autocmo-core/main.go's
// router switch — otherwise the binary returns "unknown action" and
// the user sees a generic failure with no recovery hint.
//
// Historical bug class: 2026-04-23 codex review caught seo's
// `update-rank` action defined in mcp-tools.js but not routed in
// main.go (silent 404 from the renderer). The fix landed an explicit
// actionMap; this test pins the contract so a new enum entry without
// a Go-side handler fails CI before the release.
//
// Approach: source-scan mcp-tools.js for `name: '<tool>'` + `action:
// z.enum([...])` pairs, derive each tool's binary-action prefix from
// a known map (tools either prefix actions like 'meta-' + action, or
// use an explicit actionMap, or pass through unchanged). For each
// (prefix, enum-value) build the expected `case "<prefix>-<value>"`
// string and assert it appears in main.go.
//
// Scope: every multi-action tool whose handler is the canonical
// "prefix + action" or "prefix + actionMap[action]" pattern. Tools
// whose handler invokes a single fixed binary action regardless of
// args.action (voice → 'generate', reddit_organic_post → 'reddit-
// prospect-post') are skipped — they don't have a 1:1 enum:case
// relationship.
//
// Run with: `node --test app/mcp-action-go-parity.test.js`

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MCP_TOOLS_SRC = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');

// The Go binary lives in a sibling repo (autocmo-core, private). It IS
// present in dev workspaces (D:\autoCMO-claude\sessions\<topic>\autocmo-core)
// but NOT in the public-repo CI runner — Merlin's CI only checks out the
// autoCMO repo. When main.go isn't reachable we skip the parity tests
// gracefully rather than fail the build (the parity contract is enforced
// at dev-time, not in public-repo CI). Local devs ALWAYS hit the full
// suite because their sibling worktree is always present.
const MAIN_GO_PATH = path.join(__dirname, '..', '..', 'autocmo-core', 'main.go');
const MAIN_GO_SRC = fs.existsSync(MAIN_GO_PATH)
  ? fs.readFileSync(MAIN_GO_PATH, 'utf8')
  : null;
const PARITY_AVAILABLE = MAIN_GO_SRC !== null;

// ── Tool → binary-action prefix map ─────────────────────────────
//
// One row per multi-action MCP tool. Format:
//   { name, prefix, actionMap?, skip?, exemptions? }
//
// `prefix` — joined with '-' before the enum value. `meta_ads` uses
// 'meta', so action 'push' → 'meta-push'.
//
// `actionMap` — when the handler maps enum values to non-trivial
// binary action names. Key = enum value, value = binary action.
// Missing keys fall back to `${prefix}-${action}`.
//
// `skip` — true for tools whose handler doesn't follow the prefix
// pattern (single fixed action, intent-tool dispatch, etc.).
//
// `exemptions` — enum values that legitimately have no Go-side case
// (server-side-only routing — currently empty by design).

const TOOL_ROUTING = [
  { name: 'meta_ads', prefix: 'meta',
    // BUG FOUND BY THIS TEST (2026-05-10), FIXED 2026-07-26:
    // 'adlib' was in mcp-tools.js's meta_ads action enum but main.go has
    // NO `case "meta-adlib":` — invoking it returned "unknown action". It
    // was exempted here so the parity test could still gate OTHER drift,
    // and then sat broken for two and a half months. The exemption is now
    // GONE because the enum value is gone: Ad Library research routes
    // through meta_research_competitor_ads → the real 'competitor-scan'
    // action. Do not re-add an exemption to silence this test — an
    // exemption is a documented outage, not a fix.
  },
  { name: 'meta_audit', prefix: 'meta',
    // meta_audit's handler routes through META_AUDIT_ACTION_MAP in
    // mcp-tools.js (an exported object as of 2026-07-26 — it used to be
    // an inline ternary chain). Most enum values keep the meta- prefix
    // and the value verbatim; the rows below are the ones that don't.
    // app/mcp-meta-action-reachability.test.js asserts THIS table and the
    // exported map agree, so a row added to one and not the other fails CI
    // rather than drifting.
    actionMap: {
      'list-audiences':    'meta-audit-audiences',
      'list-conversions':  'meta-audit-conversions',
      'list-catalog-sets': 'meta-catalog-sets',
      'list-boosted-posts': 'meta-boosted-posts',
      'resolve-geo':       'meta-geo-resolve',
      // meta_audit actions whose engine case carries no meta- prefix.
      'aware-audience':    'aware-audience',
      'angle-performance': 'angle-performance',
    },
  },
  // Alia Popups analytics. Every action routes as alia-<action>:
  // alia-connect, alia-verify, alia-status, alia-merchant, alia-campaigns,
  // alia-stats, alia-distributions, alia-poll-distributions, alia-report.
  { name: 'alia', prefix: 'alia' },
  { name: 'google_analytics', prefix: 'google-analytics' },
  // Every action routes as gtm-<action>: gtm-discover, gtm-audit,
  // gtm-list-versions, gtm-install-ga4, gtm-create-version, gtm-publish.
  { name: 'google_tag_manager', prefix: 'gtm' },
  { name: 'tiktok_ads', prefix: 'tiktok' },
  { name: 'google_ads', prefix: 'google-ads' },
  { name: 'amazon_ads', prefix: 'amazon',
    actionMap: {
      'products': 'amazon-products',
      'orders':   'amazon-orders',
      'status':   'amazon-ads-status',
      'setup':    'amazon-ads-setup',
      'push':     'amazon-ads-push',
      'insights': 'amazon-ads-insights',
      'kill':     'amazon-ads-kill',
    },
  },
  { name: 'shopify', prefix: 'shopify' },
  { name: 'klaviyo', prefix: 'klaviyo' },
  { name: 'mailchimp', prefix: 'mailchimp' },
  { name: 'applovin', prefix: 'applovin' },
  { name: 'postscript', prefix: 'postscript' },
  { name: 'clarity', prefix: 'clarity' },
  { name: 'posthog', prefix: 'posthog' },
  { name: 'email', prefix: 'email' },
  { name: 'seo', prefix: 'seo',
    actionMap: {
      'fix-alt':     'seo-fix-alt',
      'update-rank': 'seo-update-rank',
    },
  },
  { name: 'content', prefix: 'content',
    // content's handler is unusual — it doesn't always prepend 'content-'.
    actionMap: {
      'image':           'image',
      'batch':           'batch',
      'blog-post':       'blog-post',
      'blog-list':       'blog-list',
      'social-post':     'social-post',
      // RSI stefan-georgi iter 5: quiz-funnel-gen routes 1:1 (no prefix).
      'quiz-funnel-gen': 'quiz-funnel-gen',
    },
  },
  { name: 'video', skip: true },          // mixed routing — not tested here
  { name: 'voice', prefix: 'voice',
    actionMap: {
      'clone':        'clone-voice',
      'list':         'list-voices',
      'delete':       'delete-voice',
      'list-avatars': 'list-avatars',
    },
  },
  { name: 'captions', skip: true },        // single fixed action
  // dashboard's handler routes via:
  //   actionMap['competitor-scan'] = 'competitor-scan';
  //   actionMap['landing-audit']   = 'landing-audit';
  //   default:                       args.action  (no prefix)
  // so the empty-prefix pass-through model fits — every enum value is
  // also the binary action verbatim. main.go has top-level cases:
  // 'dashboard', 'calendar', 'wisdom', 'report'.
  { name: 'dashboard', prefix: '' },
  { name: 'discord', prefix: 'discord' },
  { name: 'slack', prefix: 'slack' },
  { name: 'threads', prefix: 'threads' },
  { name: 'stripe', prefix: 'stripe' },
  { name: 'google_merchant', prefix: 'merchant' },
  { name: 'triplewhale', prefix: 'triplewhale',
    // summary → triplewhale-summary, status → triplewhale-status (prefix).
    // verify → triplewhale-verify-key (not -verify). connect is handled
    // entirely JS-side (returns instructions, no binary call) → exempt.
    actionMap: { 'verify': 'triplewhale-verify-key' },
    exemptions: ['connect'],
  },
  { name: 'openai_ads', prefix: 'openai-ads',
    // account/campaigns/insights/push/pause/verify map 1:1 via the prefix to
    // openai-ads-*. connect is JS-only (returns instructions) → exempt.
    exemptions: ['connect'],
  },
  { name: 'rokt', prefix: 'rokt',
    // report → rokt-report, status → rokt-status, verify → rokt-verify map 1:1
    // via the prefix. connect is JS-only (returns instructions) → exempt.
    exemptions: ['connect'],
  },
  { name: 'reddit_organic', prefix: 'reddit-prospect' },
  { name: 'reddit_organic_post', skip: true },  // single fixed action
  { name: 'trendtrack', prefix: 'trendtrack' },
  { name: 'reddit_ads', prefix: 'reddit' },
  { name: 'linkedin_ads', prefix: 'linkedin' },
  { name: 'etsy', prefix: 'etsy' },
  { name: 'config', prefix: '' },          // pass-through: action verbatim
  { name: 'competitor_spy', prefix: 'foreplay' },
  { name: 'connection_status', skip: true },
  { name: 'platform_login', skip: true },
  { name: 'brand_scrape', skip: true },
  { name: 'bulk_upload', skip: true },
  { name: 'brand_guide', skip: true },
  { name: 'brand_activate', skip: true },
  { name: 'decisions', skip: true },
  { name: 'jobs_poll', skip: true },
  { name: 'jobs_list', skip: true },
  { name: 'jobs_cancel', skip: true },
];

// ── Source extraction helpers ───────────────────────────────────

// Extract every tool block from mcp-tools.js: name + the FIRST action
// enum literal inside it. Walks from `name: '<tool>'` to the next
// `name:` so the regex match doesn't accidentally jump across tools.
function extractToolEnums(src) {
  const out = {};
  // Find every `name: '<id>'` declaration. Each marks a tool boundary.
  const nameRe = /name:\s*'([a-z_]+)'/g;
  const boundaries = [];
  let m;
  while ((m = nameRe.exec(src)) !== null) {
    boundaries.push({ name: m[1], idx: m.index });
  }
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].idx;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].idx : src.length;
    const block = src.slice(start, end);
    // Find the FIRST top-level `action: z.enum([...])`. Some tools have
    // additional nested z.enum (e.g. status, format) — only the action
    // enum maps to the Go switch.
    const actionEnumIdx = block.indexOf('action: z.enum([');
    if (actionEnumIdx < 0) continue;
    const openBracket = block.indexOf('[', actionEnumIdx);
    if (openBracket < 0) continue;
    // Walk bracket depth to find the matching `]`. Some enums span
    // multiple lines AND may contain inline comments — depth-walking
    // is robust against both. Comments must be stripped FIRST so a
    // line-comment with an apostrophe (e.g. "// subject line is\n
    // // winning") doesn't seed a phantom open-quote.
    const cleanedForBracket = block
      .replace(/\/\/[^\n]*/g, '')        // strip line comments
      .replace(/\/\*[\s\S]*?\*\//g, ''); // strip block comments
    // Re-anchor since strip changed offsets.
    const cleanedActionIdx = cleanedForBracket.indexOf('action: z.enum([');
    const cleanedOpen = cleanedForBracket.indexOf('[', cleanedActionIdx);
    let depth = 0;
    let cleanedClose = -1;
    for (let j = cleanedOpen; j < cleanedForBracket.length; j++) {
      if (cleanedForBracket[j] === '[') depth++;
      else if (cleanedForBracket[j] === ']') { depth--; if (depth === 0) { cleanedClose = j; break; } }
    }
    if (cleanedClose < 0) continue;
    const enumBody = cleanedForBracket.slice(cleanedOpen, cleanedClose + 1);
    // Match only string literals — single-quoted, no embedded quotes.
    // After comment stripping, every remaining `'foo'` is a real enum value.
    const values = (enumBody.match(/'([a-zA-Z][a-zA-Z0-9_-]*)'/g) || [])
      .map(s => s.slice(1, -1));
    out[boundaries[i].name] = values;
  }
  return out;
}

// Extract every `case "<x>":` string literal from main.go. Returns a
// Set for O(1) membership checks.
function extractGoCases(src) {
  const cases = new Set();
  const re = /case\s+"([a-z][a-zA-Z0-9_-]*)":/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    cases.add(m[1]);
  }
  return cases;
}

const TOOL_ENUMS = extractToolEnums(MCP_TOOLS_SRC);
const GO_CASES = PARITY_AVAILABLE ? extractGoCases(MAIN_GO_SRC) : new Set();

// ── Tests ───────────────────────────────────────────────────────

test('every TOOL_ROUTING entry corresponds to a real tool name', () => {
  // Drift guard: if a tool is renamed in mcp-tools.js without updating
  // this list, the silent-skip would mask the parity check.
  const orphans = TOOL_ROUTING.filter(r => !TOOL_ENUMS[r.name] && !r.skip);
  assert.deepStrictEqual(orphans.map(o => o.name), [],
    `TOOL_ROUTING references tools that no longer ship in mcp-tools.js: ${orphans.map(o => o.name).join(', ')}`);
});

test('every multi-action MCP tool has a TOOL_ROUTING entry', () => {
  const known = new Set(TOOL_ROUTING.map(r => r.name));
  // List of tools whose action enum has > 1 value AND whose handler
  // is NOT a fixed pass-through. We discover these from TOOL_ENUMS.
  const undeclared = [];
  for (const name of Object.keys(TOOL_ENUMS)) {
    if (!known.has(name)) {
      undeclared.push(name);
    }
  }
  assert.deepStrictEqual(undeclared, [],
    `MCP tools with action enums but no TOOL_ROUTING entry: ${undeclared.join(', ')}. ` +
    `Add a row above or mark { skip: true } if the tool's handler doesn't follow the prefix pattern.`);
});

test('every action enum value maps to a Go switch case', { skip: !PARITY_AVAILABLE && 'autocmo-core sibling repo not present (public-repo CI)' }, () => {
  const offenders = [];
  for (const route of TOOL_ROUTING) {
    if (route.skip) continue;
    const enums = TOOL_ENUMS[route.name];
    if (!enums) continue;
    const exemptions = new Set(route.exemptions || []);
    for (const action of enums) {
      if (exemptions.has(action)) continue;
      let expected;
      if (route.actionMap && route.actionMap[action]) {
        expected = route.actionMap[action];
      } else if (route.prefix === '') {
        expected = action;
      } else {
        expected = `${route.prefix}-${action}`;
      }
      if (!GO_CASES.has(expected)) {
        offenders.push(`${route.name}/${action} → expected case "${expected}" in main.go`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    `MCP tool action enum values without a Go switch case in main.go:\n  ${offenders.join('\n  ')}\n` +
    `Each missing case means the binary returns "unknown action" when the agent runs that operation. ` +
    `Either add the case in main.go's router or add an explicit entry to TOOL_ROUTING's actionMap to redirect.`);
});

test('seo update-rank case exists (2026-04-23 incident)', { skip: !PARITY_AVAILABLE && 'autocmo-core sibling repo not present (public-repo CI)' }, () => {
  // Anchor the historical bug class explicitly so a future regression
  // surfaces with the right context.
  assert.ok(GO_CASES.has('seo-update-rank'),
    'seo-update-rank case missing from main.go — same regression as the 2026-04-23 codex incident');
  assert.ok(GO_CASES.has('seo-fix-alt'),
    'seo-fix-alt case missing from main.go');
});

test('amazon_ads action map covers every enum value', () => {
  // Anchor for the 2026-05-10 A002 regression noted in mcp-tools.js
  // line 903: adding a new amazon enum value without a map row
  // silently routes to a 404 binary action.
  const amazon = TOOL_ROUTING.find(r => r.name === 'amazon_ads');
  const enums = TOOL_ENUMS['amazon_ads'];
  if (!amazon || !enums) return;
  for (const action of enums) {
    assert.ok(amazon.actionMap[action],
      `amazon_ads enum '${action}' has no TOOL_ROUTING.actionMap entry — would mismap to a stale prefix path`);
  }
});

test('GO_CASES extraction sanity check — found enough cases to be confident', { skip: !PARITY_AVAILABLE && 'autocmo-core sibling repo not present (public-repo CI)' }, () => {
  // Raw guard: if the main.go regex breaks, GO_CASES would be tiny and
  // every parity test would silently false-positive (claiming everything
  // is missing). Pin a floor — main.go has 200+ cases as of 2026-05-10.
  assert.ok(GO_CASES.size > 200,
    `Expected > 200 case statements parsed from main.go, got ${GO_CASES.size}. ` +
    `The regex may have broken — check extractGoCases.`);
});
