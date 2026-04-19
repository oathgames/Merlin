#!/usr/bin/env node
// tools/vendor-cards/gen-vendor-cards.js
//
// Reads tools/vendor-cards/vendor-capabilities.json and rewrites the
// `<!-- VENDOR-CARDS:BEGIN -->` / `<!-- VENDOR-CARDS:END -->` fenced region
// inside every .claude/skills/<name>/SKILL.md that owns at least one vendor.
//
// Deterministic: vendors within a skill are sorted alphabetically by id so
// repeated runs produce byte-identical output.
//
// CI mode: pass `--check` to fail non-zero if running the generator would
// change any SKILL.md (i.e. a contributor edited JSON without regenerating).
//
// No external deps. JSON parse only.

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(__dirname, 'vendor-capabilities.json');
const SKILLS_DIR = path.join(REPO_ROOT, '.claude', 'skills');

const BEGIN = '<!-- VENDOR-CARDS:BEGIN -->';
const END = '<!-- VENDOR-CARDS:END -->';
const HEADER_NOTE = '<!-- Generated from tools/vendor-cards/vendor-capabilities.json — do not edit by hand. Run `node tools/vendor-cards/gen-vendor-cards.js` to regenerate. -->';

function loadVendors() {
  const raw = fs.readFileSync(SOURCE, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed.schema_version !== 1) {
    throw new Error(`Unsupported schema_version: ${parsed.schema_version}`);
  }
  return parsed.vendors;
}

function groupBySkill(vendors) {
  const by = new Map();
  for (const [id, v] of Object.entries(vendors)) {
    if (!v.skill) throw new Error(`Vendor "${id}" missing "skill"`);
    if (!by.has(v.skill)) by.set(v.skill, []);
    by.get(v.skill).push({ id, ...v });
  }
  for (const arr of by.values()) arr.sort((a, b) => a.id.localeCompare(b.id));
  return by;
}

function renderCard(v) {
  const actions = v.actions.map(a => '`' + a + '`').join(', ');
  const pick = v.pick_when.map(s => `- ${s}`).join('\n');
  const skip = v.skip_when.map(s => `- ${s}`).join('\n');
  const kf = v.killer_features.map(f => `- **${f.name}** — ${f.desc}`).join('\n');
  return [
    `### ${v.name} — ${v.headline}`,
    ``,
    `**Actions:** ${actions}`,
    ``,
    `**Pick when:**`,
    pick,
    ``,
    `**Skip when:**`,
    skip,
    ``,
    `**Killer features:**`,
    kf,
    ``,
    `**Constraints:** ${v.constraints}`,
    `**Cost:** ${v.cost}`,
    `**Output:** ${v.output}`,
    `**Docs:** <${v.docs_url}>`,
    `**Last verified:** ${v.last_verified}`,
  ].join('\n');
}

function renderMatrix(vendors) {
  const rows = vendors.map(v => {
    const firstPick = v.pick_when[0] || '';
    const firstAction = v.actions[0] || '';
    return `| **${v.name}** | ${firstPick.replace(/\|/g, '\\|')} | \`${firstAction}\` |`;
  }).join('\n');
  return [
    '| Vendor | Primary pick-when | Entry action |',
    '|---|---|---|',
    rows,
  ].join('\n');
}

function renderBlock(vendors) {
  const parts = [
    BEGIN,
    HEADER_NOTE,
    '',
    '## Vendor Capability Cards',
    '',
    renderMatrix(vendors),
    '',
    ...vendors.map(renderCard),
    '',
    END,
  ];
  return parts.join('\n');
}

function upsertBlock(skillPath, block) {
  let body = fs.readFileSync(skillPath, 'utf8');
  const beginIdx = body.indexOf(BEGIN);
  const endIdx = body.indexOf(END);
  const hasRegion = beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx;

  if (hasRegion) {
    const before = body.slice(0, beginIdx);
    const after = body.slice(endIdx + END.length);
    return before + block + after;
  }

  // No region yet — append at end of file with a leading blank line.
  const trimmed = body.endsWith('\n') ? body : body + '\n';
  return trimmed + '\n' + block + '\n';
}

function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');

  const vendors = loadVendors();
  const bySkill = groupBySkill(vendors);

  let changed = 0;
  const missing = [];

  for (const [skillName, vendorList] of bySkill) {
    const skillPath = path.join(SKILLS_DIR, skillName, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      missing.push(`${skillName} (${vendorList.length} vendors)`);
      continue;
    }
    const block = renderBlock(vendorList);
    const current = fs.readFileSync(skillPath, 'utf8');
    const next = upsertBlock(skillPath, block);
    if (current === next) continue;
    if (checkMode) {
      changed++;
      console.error(`[CHECK] ${skillName}/SKILL.md is out of date — run gen-vendor-cards.js`);
      continue;
    }
    fs.writeFileSync(skillPath, next);
    console.log(`[WRITE] ${skillName}/SKILL.md (${vendorList.length} vendors)`);
    changed++;
  }

  if (missing.length) {
    console.error(`[ERROR] referenced SKILL.md not found: ${missing.join(', ')}`);
    process.exit(1);
  }

  if (checkMode && changed > 0) {
    console.error(`[CHECK] ${changed} SKILL.md file(s) out of date`);
    process.exit(1);
  }

  if (checkMode) {
    console.log('[CHECK] all vendor cards in sync');
  }
}

try {
  main();
} catch (err) {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
}
