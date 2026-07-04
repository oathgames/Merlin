// REGRESSION GUARD (2026-06-30, truesight cross-brand leak + fit/scrollbar)
//
// Live incident: Truesight showed the SAME funnel numbers for every brand
// ("incorrect information, not specific to each brand"). Root cause: the
// truesight IPC handler passed the RAW GLOBAL config to the Go binary. The
// global config holds plain (non-vault) legacy credentials from the
// pre-multi-brand era (metaAccessToken / metaAdAccountId), and the binary's
// applyBrandVault only rewrites @@VAULT@@ placeholder fields — so every
// brand's funnel pulled the SAME ad account. This is a recurrence of the
// 2026-04-15 "codex per-brand revenue audit finding #2" class; refresh-perf
// got the strict-config fix then, truesight (added v1.29.0) never did.
//
// Also locked here: the Truesight panel's themed scrollbar (was the raw OS
// scrollbar) and the compact vertical budget so the full funnel fits the
// DEFAULT 900x670 window with no scrolling.
//
// Run with: node --test app/truesight-brand-scope.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');

function truesightHandlerSlice() {
  const idx = MAIN_JS.indexOf("ipcMain.handle('truesight'");
  assert.ok(idx > 0, 'truesight IPC handler exists');
  return MAIN_JS.slice(idx, idx + 4000);
}

// ── Fix 1: strict per-brand config (cross-brand leak) ───────────────

test('truesight handler builds a STRICT brand config when a brand is named', () => {
  const h = truesightHandlerSlice();
  assert.match(
    h,
    /buildStrictBrandConfig\(cmdObj\.brand\)/,
    'truesight MUST route through buildStrictBrandConfig — passing the raw '
      + 'global config leaks the legacy plain metaAccessToken/metaAdAccountId '
      + 'into EVERY brand\'s funnel (the 2026-06-30 incident).',
  );
});

test('truesight strict config is written to a tmp file inside .claude/tools/', () => {
  const h = truesightHandlerSlice();
  assert.match(
    h,
    /\.merlin-config-tmp-/,
    'strict config must be materialized as a .merlin-config-tmp-* file so the '
      + 'Go binary reads brand-scoped credentials (same pattern as refresh-perf).',
  );
  assert.match(
    h,
    /mode:\s*0o600/,
    'the tmp config holds resolved credentials — it must be written 0600.',
  );
});

test('truesight deletes the tmp config immediately in the exec callback', () => {
  const h = truesightHandlerSlice();
  assert.match(
    h,
    /if \(isTmpConfig\) \{ try \{ fs\.unlinkSync\(configPath\); \} catch \{\} \}/,
    'the tmp config must be unlinked in the execFile callback — resolved '
      + 'credentials must never linger on disk.',
  );
});

test('truesight tmp cleanup runs BEFORE the result parse (never skipped on early return)', () => {
  const h = truesightHandlerSlice();
  const unlinkIdx = h.indexOf('fs.unlinkSync(configPath)');
  const parseIdx = h.indexOf("extractPrefixedJSON(stdout, 'TRUESIGHT_RESULT ')");
  assert.ok(unlinkIdx > 0 && parseIdx > 0, 'both the cleanup and the parse exist');
  assert.ok(
    unlinkIdx < parseIdx,
    'unlink must precede the TRUESIGHT_RESULT parse so no early return path '
      + 'can leave the resolved-credential tmp file on disk.',
  );
});

// ── Fix 2: themed scrollbar ──────────────────────────────────────────

test('truesight scroll container has the app-themed scrollbar (not the OS default)', () => {
  // 2026-07-04 scrollbar dedup: the per-selector blocks were collapsed into
  // grouped selector lists, so .truesight-scroll is now comma-joined into the
  // shared rules. Assert it appears in each themed group (width 5px, thumb
  // var(--hover-8), transparent track) whether standalone or grouped.
  assert.match(
    STYLE_CSS,
    /\.truesight-scroll::-webkit-scrollbar\s*[,{][^}]*width:\s*5px/s,
    'scrollbar width must match the app convention (#chat uses 5px)',
  );
  assert.match(
    STYLE_CSS,
    /\.truesight-scroll::-webkit-scrollbar-thumb\s*[,{][^}]*background:\s*var\(--hover-8\)/s,
    'scrollbar thumb must use var(--hover-8), the app-wide themed thumb color',
  );
  assert.match(
    STYLE_CSS,
    /\.truesight-scroll::-webkit-scrollbar-track\s*[,{][^}]*background:\s*transparent/s,
    'scrollbar track must be transparent per the app convention',
  );
});

// ── Fix 3: compact vertical budget (fits 900x670 with no scroll) ────
// The scroll viewport at the default window is ~577px. These caps keep the
// summed layout inside that budget; loosening any of them re-introduces the
// default-window scrollbar. If a redesign needs more room, re-derive the
// whole budget — don't bump one value.

function cssNum(re, label) {
  const m = STYLE_CSS.match(re);
  assert.ok(m, label + ' rule found');
  return Number(m[1]);
}

test('funnel bars are compact (height <= 34px)', () => {
  const h = cssNum(/\.ts-bar\s*\{[^}]*height:\s*(\d+)px/, '.ts-bar height');
  assert.ok(h <= 34, `.ts-bar height must be <= 34px to fit the default window (got ${h})`);
});

test('scroll padding is compact (top <= 12px)', () => {
  const p = cssNum(/\.truesight-scroll\s*\{[^}]*padding:\s*(\d+)px/, '.truesight-scroll padding');
  assert.ok(p <= 12, `.truesight-scroll top padding must be <= 12px (got ${p})`);
});

test('growth card is compact (margin-bottom <= 14px, tile padding <= 6px)', () => {
  const mb = cssNum(/\.ts-growth\s*\{[^}]*margin:\s*0 auto (\d+)px/, '.ts-growth margin-bottom');
  assert.ok(mb <= 14, `.ts-growth bottom margin must be <= 14px (got ${mb})`);
  const tp = cssNum(/\.ts-growth-tile\s*\{[^}]*padding:\s*(\d+)px/, '.ts-growth-tile padding');
  assert.ok(tp <= 6, `.ts-growth-tile vertical padding must be <= 6px (got ${tp})`);
});

test('stage connectors are compact (padding <= 4px)', () => {
  const sp = cssNum(/\.ts-step\s*\{[^}]*padding:\s*(\d+)px 0/, '.ts-step padding');
  assert.ok(sp <= 4, `.ts-step vertical padding must be <= 4px (got ${sp})`);
});
