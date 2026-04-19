#!/usr/bin/env node
// test/vendor-docs-drift.js
//
// Monthly drift detector for vendor capability cards. For each vendor in
// tools/vendor-cards/vendor-capabilities.json, fetches the docs_url, hashes
// a normalized excerpt, and compares to the last-known hash stored in
// test/.vendor-docs-hashes.json.
//
// Output: a markdown report to stdout when drift is detected, OR the literal
// marker "NO-DRIFT" when every hash matches. Exits 0 either way — the
// workflow inspects the report to decide whether to open a PR.
//
// Runs on GitHub Actions (ubuntu-latest, Node 20+). Uses the built-in
// global `fetch` — zero npm dependencies.
//
// Normalization strategy (before hashing):
//   - lowercase everything
//   - strip all whitespace runs to a single space
//   - strip HTML tags and HTML attributes (quick-and-dirty, not perfect)
//   - truncate to first 100KB of body to keep the hash stable against
//     pagination/footer churn
//
// This is DELIBERATELY noisy toward false positives. A false positive costs
// Ryan 10s to diff-and-close. A false negative (stale card silently shipped)
// costs production routing quality.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(REPO_ROOT, 'tools', 'vendor-cards', 'vendor-capabilities.json');
const HASH_STORE = path.join(__dirname, '.vendor-docs-hashes.json');

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = 'merlin-vendor-docs-drift/1.0 (+https://github.com/oathgames/Merlin)';
const MAX_BODY_BYTES = 100 * 1024;

function normalize(raw) {
  return raw
    .toLowerCase()
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BODY_BYTES);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

async function fetchDocs(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,*/*' },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, status: res.status, body: '' };
    const body = await res.text();
    return { ok: true, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, err: err.message, body: '' };
  } finally {
    clearTimeout(timer);
  }
}

function loadStore() {
  try { return JSON.parse(fs.readFileSync(HASH_STORE, 'utf8')); }
  catch { return { hashes: {} }; }
}

function saveStore(store) {
  fs.writeFileSync(HASH_STORE, JSON.stringify(store, null, 2) + '\n');
}

async function main() {
  const data = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  const store = loadStore();
  const now = new Date().toISOString().slice(0, 10);

  const drift = [];
  const errors = [];
  const unchanged = [];

  for (const [id, v] of Object.entries(data.vendors)) {
    process.stderr.write(`fetching ${id} (${v.docs_url})\n`);
    const r = await fetchDocs(v.docs_url);
    if (!r.ok) {
      errors.push({ id, url: v.docs_url, status: r.status, err: r.err });
      continue;
    }
    const normalized = normalize(r.body);
    const hash = sha256(normalized);
    const previous = store.hashes[id];
    if (!previous) {
      // First run — record baseline, no drift yet.
      store.hashes[id] = { hash, firstSeen: now, lastChecked: now };
      unchanged.push({ id, note: 'baseline recorded' });
      continue;
    }
    if (previous.hash === hash) {
      store.hashes[id] = { ...previous, lastChecked: now };
      unchanged.push({ id });
      continue;
    }
    drift.push({ id, vendor: v.name, url: v.docs_url, previousAt: previous.lastChecked });
    store.hashes[id] = { ...previous, hash, lastChecked: now, lastDrift: now };
  }

  saveStore(store);

  if (drift.length === 0 && errors.length === 0) {
    console.log('NO-DRIFT');
    return;
  }

  const lines = [];
  if (drift.length) {
    lines.push('## Drift detected');
    lines.push('');
    lines.push('The following vendor docs pages changed since the last audit. Review each, update `tools/vendor-cards/vendor-capabilities.json` if any capabilities or constraints changed, bump `last_verified`, then regenerate cards with `node tools/vendor-cards/gen-vendor-cards.js`.');
    lines.push('');
    lines.push('| Vendor | Docs URL | Previous check |');
    lines.push('|---|---|---|');
    for (const d of drift) {
      lines.push(`| **${d.vendor}** (\`${d.id}\`) | <${d.url}> | ${d.previousAt} |`);
    }
    lines.push('');
  }
  if (errors.length) {
    lines.push('## Fetch errors');
    lines.push('');
    lines.push('These vendors could not be reached this cycle — hash unchanged, re-check next month. Persistent failures likely indicate a dead docs URL in the card.');
    lines.push('');
    lines.push('| Vendor | URL | Status / error |');
    lines.push('|---|---|---|');
    for (const e of errors) {
      lines.push(`| \`${e.id}\` | <${e.url}> | ${e.status || ''} ${e.err || ''} |`);
    }
    lines.push('');
  }
  lines.push('## No change');
  lines.push('');
  lines.push(unchanged.map(u => `- \`${u.id}\`${u.note ? ' — ' + u.note : ''}`).join('\n'));
  lines.push('');

  console.log(lines.join('\n'));
}

main().catch(err => { console.error(err); process.exit(1); });
