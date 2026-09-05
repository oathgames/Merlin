// Source-scan regression test for version.json's `updatable` manifest.
//
// REGRESSION GUARD (2026-04-20 bootstrapper-update-coverage):
// Merlin ships through two install paths:
//
//   1. NSIS installer (Windows) / DMG (macOS) — `app.isPackaged === true`.
//      Auto-update replaces the entire install via
//      `installUpdateFromLatestRelease` which downloads the full installer
//      and re-runs it. Every file in the repo ships via this path, so the
//      `updatable` manifest is not consulted.
//   2. Go bootstrapper (`MerlinSetup.exe` / `MerlinSetup`). Installs the
//      source tree into `~/Documents/Merlin/` (Win) or
//      `~/Applications/Merlin/` (Mac) and runs Electron from
//      `node_modules/.bin/electron .`. Here `app.isPackaged === false`
//      and auto-update flows through `downloadAndApplyUpdate`, which
//      ONLY touches files listed in `version.json`'s `updatable` array.
//
// Through v1.16.1 the `updatable` array covered .claude/ (skills,
// commands, hooks, settings) + brand-scraper.js + version.json + the
// README + CLAUDE.md, but it was MISSING every Electron app source file
// under app/ (main.js, renderer.js, preload.js, the MCP layer, the facts
// subsystem, the PWA LAN-fallback assets, etc.). Every bootstrapper user
// who upgraded through /update or the in-app Update toast from
// v1.12.0 → v1.16.1 silently kept their ORIGINAL app/main.js and
// renderer.js and preload.js — version.json reported "you are on
// v1.16.1" but features that shipped inside those files (v1.12.0
// fact-binding, v1.15.0 inline artifact gallery, v1.15.0 PWA install
// banner, v1.16.0 creative angles rubric, v1.16.1 brand-scraper
// timeouts) were invisible to them. Calls into a renamed function in
// main.js raised a silent error; calls into a new preload.js bridge
// returned `undefined` because the old preload had no such bridge.
//
// This test walks the on-disk source tree and fails the build if any
// shipped production file is missing from the manifest. New files added
// to app/ or pwa/ MUST be added to version.json's updatable array in
// the same PR, OR be explicitly listed in EXCLUDED_FILES below with a
// one-line justification.
//
// Run with: node app/updatable-coverage.test.js

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const VERSION_JSON = path.join(REPO_ROOT, 'version.json');
const APP_DIR = path.join(REPO_ROOT, 'app');
const FACTS_DIR = path.join(APP_DIR, 'facts');
const PWA_DIR = path.join(REPO_ROOT, 'pwa');

// Files that MUST NOT appear in `updatable` even though they live under
// app/ or pwa/. Each entry carries a one-line justification so a future
// contributor knows why it's excluded. If the list grows beyond ~15
// entries, rethink the scan predicate instead of padding this list.
const EXCLUDED_FILES = new Set([
  // Dev-only preview harness for Claude Code's preview tools.
  'app/preview-harness.html',
  'app/preview-stub.js',
  // One-off dev scripts that generate app icons from an SVG source.
  // They run on the maintainer's machine, not on install.
  'app/gen-icon.js',
  'app/gen-icon-hires.js',
  // Source SVG for icon generation — never loaded at runtime.
  'app/icon.svg',
  'app/icon-template.html',
  // Icon PNGs / ICO bundle. Auto-generated and stable; shipped once
  // via the installer / source zip. Adding them to updatable would
  // churn bytes with no behavior change.
  'app/icon.ico',
  'app/icon.png',
  'app/icon-32.png',
  'app/icon-48.png',
  'app/icon-64.png',
  'app/icon-1024.png',
  'app/icon-1200.png',
  // Unreferenced dev leftover — no code path loads it.
  'app/demo-preview.html',
  // Frozen-surface parity harness: a dev/CI-only refactor guard. The
  // collector is loaded only by app/frozen-surfaces.test.js and its snapshot
  // is a committed review artifact, not runtime data — no app code path
  // requires either one. Both are excluded from the electron-builder `files`
  // lists too, so they never reach an install and have nothing to update.
  'app/frozen-surfaces.js',
  'app/__snapshots__/frozen-surfaces.snapshot.json',
  // PWA Cloudflare Worker source — deployed to pwa.merlingotme.com
  // via wrangler, not served from the desktop.
  'pwa/worker.js',
  'pwa/wrangler.toml',
]);

function walk(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'testdata' || entry.name === 'node_modules') continue;
      out.push(...walk(full, relPath));
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }
  return out;
}

function isTestFile(name) {
  return /\.test\.(js|mjs|cjs)$/i.test(name);
}

function isProductionFile(relPath) {
  // Only .js / .mjs / .cjs / .html / .css / .json / .min.js ship as code.
  // .png/.ico/.svg are excluded via EXCLUDED_FILES above.
  return /\.(js|mjs|cjs|html|css|json)$/i.test(relPath);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  \u2713', name);
    passed++;
  } catch (err) {
    console.log('  \u2717', name);
    console.log('   ', err.message);
    failed++;
  }
}

if (!fs.existsSync(VERSION_JSON)) {
  console.error('version.json missing at', VERSION_JSON);
  process.exit(1);
}
const versionJson = JSON.parse(fs.readFileSync(VERSION_JSON, 'utf8'));
const updatable = new Set(versionJson.updatable || []);

test('version.json updatable array exists and is non-empty', () => {
  if (!Array.isArray(versionJson.updatable) || versionJson.updatable.length === 0) {
    throw new Error('version.json is missing its `updatable` array, or it is empty.');
  }
});

test('every app/*.{js,html,css} ships via updatable (or is in EXCLUDED_FILES)', () => {
  const appFiles = walk(APP_DIR, 'app').filter((f) => {
    const base = path.basename(f);
    if (isTestFile(base)) return false;
    if (!isProductionFile(base)) return false;
    if (EXCLUDED_FILES.has(f)) return false;
    return true;
  });
  const missing = appFiles.filter((f) => !updatable.has(f));
  if (missing.length) {
    throw new Error(
      'These app/ files ship to bootstrapper-installed users but are NOT ' +
      'listed in version.json\'s `updatable` array. Bootstrapper users ' +
      'will never receive updates to these files via /update or the ' +
      'in-app Update toast, so every future change to them will silently ' +
      'fail to reach that install path. Add them to version.json ' +
      '`updatable` OR list them in EXCLUDED_FILES with a justification. ' +
      'Missing:\n  - ' + missing.join('\n  - '),
    );
  }
});

test('every pwa/*.{js,html,css,json,svg} ships via updatable (or is in EXCLUDED_FILES)', () => {
  if (!fs.existsSync(PWA_DIR)) return;
  const pwaFiles = walk(PWA_DIR, 'pwa').filter((f) => {
    const base = path.basename(f);
    if (isTestFile(base)) return false;
    // Include svg in the PWA dir since it's actually rendered (manifest icon).
    if (!/\.(js|mjs|cjs|html|css|json|svg)$/i.test(base)) return false;
    if (EXCLUDED_FILES.has(f)) return false;
    return true;
  });
  const missing = pwaFiles.filter((f) => !updatable.has(f));
  if (missing.length) {
    throw new Error(
      'These pwa/ files are served by the desktop ws-server.js LAN ' +
      'fallback but are NOT in version.json\'s `updatable` array. ' +
      'Bootstrapper users will never receive updates to them. Add to ' +
      'version.json OR EXCLUDED_FILES. Missing:\n  - ' + missing.join('\n  - '),
    );
  }
});

test('every app/facts/*.js (non-test) ships via updatable', () => {
  if (!fs.existsSync(FACTS_DIR)) return;
  const factsFiles = walk(FACTS_DIR, 'app/facts').filter((f) => {
    const base = path.basename(f);
    if (isTestFile(base)) return false;
    if (!/\.js$/i.test(base)) return false;
    if (EXCLUDED_FILES.has(f)) return false;
    return true;
  });
  const missing = factsFiles.filter((f) => !updatable.has(f));
  if (missing.length) {
    throw new Error(
      'Fact-binding source files under app/facts/ are not in `updatable`. ' +
      'These files are loaded by app/preload.js at window creation — a ' +
      'bootstrapper user stuck on an old version of them will either ' +
      'crash preload bridge resolution or silently no-op fact binding. ' +
      'Missing:\n  - ' + missing.join('\n  - '),
    );
  }
});

test('no test fixture / test file accidentally leaked into updatable', () => {
  const leaked = [...updatable].filter((f) => isTestFile(path.basename(f)) || f.includes('/testdata/'));
  if (leaked.length) {
    throw new Error(
      'Test files do not belong in `updatable`. These leaked in:\n  - ' +
      leaked.join('\n  - '),
    );
  }
});

test('every updatable entry that is NOT a trailing-slash dir resolves to a real file', () => {
  // Trailing-slash entries (e.g. `assets/brands/example/`) are interpreted
  // by the updater as directory prefixes — skip the file-exists check.
  const missing = [];
  for (const entry of updatable) {
    if (typeof entry !== 'string') continue;
    if (entry.endsWith('/')) continue;
    const full = path.resolve(REPO_ROOT, entry);
    if (!fs.existsSync(full)) missing.push(entry);
  }
  if (missing.length) {
    throw new Error(
      'version.json `updatable` references files that do not exist in ' +
      'the source tree. The updater will log a 404 and skip them on ' +
      'every install. Remove or fix:\n  - ' + missing.join('\n  - '),
    );
  }
});

test('every EXCLUDED_FILES entry resolves to a real file (stale-exclusion guard)', () => {
  const stale = [];
  for (const entry of EXCLUDED_FILES) {
    const full = path.resolve(REPO_ROOT, entry);
    if (!fs.existsSync(full)) stale.push(entry);
  }
  if (stale.length) {
    throw new Error(
      'EXCLUDED_FILES contains entries that no longer exist on disk. ' +
      'Drop them so the list stays meaningful:\n  - ' + stale.join('\n  - '),
    );
  }
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
