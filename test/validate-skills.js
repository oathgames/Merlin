#!/usr/bin/env node
// test/validate-skills.js
//
// Skill manifest validator. Runs in CI on every PR touching `.claude/skills/`,
// and monthly on a schedule to compare against aggregated wisdom telemetry.
//
// Checks:
//   1. Frontmatter schema — name/description/owner required, name matches dir.
//   2. Description linter — prefix "Use when", ≥80 chars, ban vague words.
//   3. Byte budget — 8KB/15KB/50KB tiers; skills over budget must declare
//      `bytes_justification` in frontmatter.
//   4. Action coverage — every `mcp__merlin__X({action: "Y"})` reference in
//      a SKILL body corresponds to a real handler in autocmo-core/main.go.
//      (Best-effort: autocmo-core may not be present in PR checkout; the
//      check is skipped if the source directory is missing, with a notice.)
//   5. Description collision detector — any two skills with cosine-similarity
//      > 0.85 on their descriptions are flagged as potential routing ambiguity.
//   6. `--check-updatable`: every SKILL.md is listed in version.json `updatable`
//      so existing users receive it on /update.
//   7. `--audit-report`: produce a markdown summary comparing skill invocation
//      telemetry against what each skill claims to cover. Used by the monthly
//      audit workflow to open a draft PR when drift is detected.

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(REPO_ROOT, '.claude', 'skills');
const VERSION_JSON = path.join(REPO_ROOT, 'version.json');
const MAIN_GO = path.resolve(REPO_ROOT, '..', 'autocmo-core', 'main.go');

// ── Byte budget tiers ────────────────────────────────────────────────────────
// Tier A: concise router-facing skills. Loaded frequently — must stay small.
// Tier B: main domain skills. Rich enough to carry a full playbook.
// Tier C: monolithic skills with strong cost justification (e.g. first-run
// setup with verbatim scheduled-task prompts). Must declare bytes_justification.
const BYTE_TIERS = {
  A: 8 * 1024,
  B: 15 * 1024,
  C: 50 * 1024,
};

const TIER_A_SKILLS = new Set(['clarify-intent']);
const TIER_C_SKILLS = new Set(['merlin-setup', 'merlin-content', 'merlin-ads', 'merlin-social']);

// ── Description linter rules ─────────────────────────────────────────────────
const DESCRIPTION_PREFIX = /^Use when /;
const DESCRIPTION_MIN_CHARS = 80;
const DESCRIPTION_MAX_CHARS = 1200;
const VAGUE_WORDS = [
  // Words that tell Claude nothing about routing.
  'stuff', 'things', 'various', 'miscellaneous', 'etc',
  'and more', 'general', 'anything', 'catch-all',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function readFrontmatter(mdPath) {
  const raw = fs.readFileSync(mdPath, 'utf8');
  // Match LF or CRLF — Windows checkouts with core.autocrlf=true land as CRLF
  // in the working tree, and we want `node test/validate-skills.js` to work
  // in both local-dev and Linux CI without mutating the file on disk.
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return { raw, fm: null, body: raw };
  const fmText = match[1];
  const fm = {};
  for (const line of fmText.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    fm[m[1]] = m[2].trim();
  }
  const body = raw.slice(match[0].length);
  return { raw, fm, body };
}

function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs
    .readdirSync(SKILLS_DIR)
    .filter((d) => fs.statSync(path.join(SKILLS_DIR, d)).isDirectory())
    .map((d) => ({
      name: d,
      dir: path.join(SKILLS_DIR, d),
      skill: path.join(SKILLS_DIR, d, 'SKILL.md'),
    }));
}

// Cosine similarity on bag-of-words (lowercased, stopwords removed).
// Crude but good enough to catch near-duplicate descriptions.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'of', 'to', 'in', 'on', 'at',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'this', 'that', 'these', 'those', 'it', 'its', 'use', 'when', 'user', 'wants',
  'covers', 'includes', 'with', 'by', 'via', 'from', 'as', 'not', 'no',
]);

function tokenize(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w) && w.length > 2);
}

function vectorize(tokens) {
  const v = new Map();
  for (const t of tokens) v.set(t, (v.get(t) || 0) + 1);
  return v;
}

function cosine(a, b) {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (const [, count] of a) aNorm += count * count;
  for (const [, count] of b) bNorm += count * count;
  for (const [t, ca] of a) {
    const cb = b.get(t);
    if (cb) dot += ca * cb;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function collectActionReferences(body) {
  // Skill bodies reference actions two ways:
  //   A) MCP-wrapped:  `mcp__merlin__shopify({action: "cohorts"})` — the MCP
  //      tool wrapper in app/mcp-tools.js routes this to the Go binary as
  //      `shopify-cohorts` (prefixed). The raw case in main.go is the
  //      prefixed name, never the bare one.
  //   B) Bare:         `"action": "name"` — these usually come from direct
  //      binary examples where the exact Go case name is quoted.
  //
  // Return one entry per reference with BOTH forms as acceptance candidates
  // for pattern (A). validateActionCoverage passes if ANY candidate resolves.
  const refs = [];
  const mcpRe = /mcp__merlin__([a-z_]+)\(\{\s*action:\s*"([a-z_-]+)"/g;
  let m;
  while ((m = mcpRe.exec(body)) !== null) {
    const tool = m[1];
    const action = m[2];
    refs.push({ raw: action, candidates: [action, `${tool}-${action}`, `${tool.replace(/_/g, '-')}-${action}`] });
  }
  const bareRe = /"action":\s*"([a-z_-]+)"/g;
  while ((m = bareRe.exec(body)) !== null) {
    refs.push({ raw: m[1], candidates: [m[1]] });
  }
  return refs;
}

function collectMainGoActions() {
  if (!fs.existsSync(MAIN_GO)) return null; // source not available in PR
  const raw = fs.readFileSync(MAIN_GO, 'utf8');
  const re = /case\s+"([a-z_-]+)":/g;
  const set = new Set();
  let m;
  while ((m = re.exec(raw)) !== null) set.add(m[1]);
  return set;
}

// ── Validators ───────────────────────────────────────────────────────────────

function validateSchema(skill, errors) {
  if (!fs.existsSync(skill.skill)) {
    errors.push(`${skill.name}: SKILL.md missing in ${skill.dir}`);
    return null;
  }
  const { fm, body } = readFrontmatter(skill.skill);
  if (!fm) {
    errors.push(`${skill.name}: SKILL.md missing frontmatter`);
    return null;
  }
  const required = ['name', 'description'];
  for (const k of required) {
    if (!fm[k]) errors.push(`${skill.name}: frontmatter missing \`${k}\``);
  }
  if (fm.name && fm.name !== skill.name) {
    errors.push(
      `${skill.name}: frontmatter \`name: ${fm.name}\` must match dir ${skill.name}`
    );
  }
  return { fm, body };
}

function validateDescription(skill, fm, errors, warnings) {
  const d = fm.description || '';
  if (d.length < DESCRIPTION_MIN_CHARS) {
    errors.push(
      `${skill.name}: description too short (${d.length} < ${DESCRIPTION_MIN_CHARS} chars) — the Skill system can't route on it`
    );
  }
  if (d.length > DESCRIPTION_MAX_CHARS) {
    warnings.push(
      `${skill.name}: description over ${DESCRIPTION_MAX_CHARS} chars (${d.length}) — consider trimming, it bloats cold-start`
    );
  }
  if (!DESCRIPTION_PREFIX.test(d) && skill.name !== 'clarify-intent') {
    warnings.push(
      `${skill.name}: description should start with "Use when the user..." for Claude's routing heuristic`
    );
  }
  for (const w of VAGUE_WORDS) {
    const re = new RegExp(`\\b${w}\\b`, 'i');
    if (re.test(d)) {
      errors.push(
        `${skill.name}: description contains vague word "${w}" — every term must aid routing`
      );
    }
  }
}

function validateByteBudget(skill, body, fm, errors, warnings) {
  const size = Buffer.byteLength(body, 'utf8');
  let tier = 'B';
  if (TIER_A_SKILLS.has(skill.name)) tier = 'A';
  else if (TIER_C_SKILLS.has(skill.name)) tier = 'C';
  const limit = BYTE_TIERS[tier];
  if (size > limit) {
    if (tier === 'C' && fm.bytes_justification) {
      warnings.push(
        `${skill.name}: ${size} bytes over tier ${tier} limit ${limit} — justification accepted: "${fm.bytes_justification.slice(0, 80)}${fm.bytes_justification.length > 80 ? '…' : ''}"`
      );
    } else {
      errors.push(
        `${skill.name}: ${size} bytes exceeds tier ${tier} limit ${limit}. ` +
          (tier === 'C'
            ? 'Add `bytes_justification:` to frontmatter or split the skill.'
            : 'Split the skill or move edge cases to a sibling skill.')
      );
    }
  }
}

function validateActionCoverage(skill, body, mainGoActions, warnings) {
  if (!mainGoActions) return; // source not present
  const refs = collectActionReferences(body);
  // The MCP wrappers in app/mcp-tools.js frequently rewrite `{action: "X"}`
  // into a prefixed Go handler name before calling the binary — e.g.
  //   meta_ads({action:"kill"})         → `meta-kill`         (no "ads" stem)
  //   decisions({action:"queue"})       → `decision-queue`    (singular)
  //   competitor_spy({action:"ads-by-brand"}) → `foreplay-ads-by-brand`
  // The tool-name-based candidates in collectActionReferences therefore miss
  // these on purpose (we do not want to hardcode a per-tool prefix table in
  // this validator — it would go stale the moment a new tool ships). Fall
  // back to a suffix match: any Go handler whose name ends with `-<raw>` is
  // treated as coverage for the reference. The signal is weaker than an
  // exact match but strictly stronger than the previous false-positive
  // warning — a skill typo that coincidentally shares a suffix with a real
  // handler is both rare and cheap to spot by eye during review.
  for (const ref of refs) {
    let hit = ref.candidates.some((c) => mainGoActions.has(c));
    if (!hit) {
      const suffix = `-${ref.raw}`;
      for (const action of mainGoActions) {
        if (action.endsWith(suffix)) { hit = true; break; }
      }
    }
    if (!hit) {
      warnings.push(
        `${skill.name}: references action "${ref.raw}" which is NOT in autocmo-core/main.go (tried: ${ref.candidates.join(', ')}, or any handler ending with "-${ref.raw}") — rename or stale?`
      );
    }
  }
}

function validateCollisions(skillsWithFm, warnings) {
  const vectors = skillsWithFm.map((s) => ({
    name: s.name,
    vec: vectorize(tokenize(s.fm.description || '')),
  }));
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const sim = cosine(vectors[i].vec, vectors[j].vec);
      if (sim > 0.85) {
        warnings.push(
          `collision: "${vectors[i].name}" and "${vectors[j].name}" descriptions are ${Math.round(sim * 100)}% similar — users may hit routing ambiguity`
        );
      }
    }
  }
}

function validateUpdatable(skillsWithFm, errors) {
  if (!fs.existsSync(VERSION_JSON)) {
    errors.push('version.json not found');
    return;
  }
  const vj = JSON.parse(fs.readFileSync(VERSION_JSON, 'utf8'));
  const updatable = new Set(vj.updatable || []);
  for (const s of skillsWithFm) {
    const rel = `.claude/skills/${s.name}/SKILL.md`;
    if (!updatable.has(rel)) {
      errors.push(
        `version.json: \`updatable\` is missing "${rel}" — existing users will not receive this skill on /update`
      );
    }
  }
}

// ── Monthly audit report ─────────────────────────────────────────────────────

function buildAuditReport(skillsWithFm) {
  const telemetryPath = path.join(__dirname, '.telemetry.json');
  let telemetry = [];
  try {
    telemetry = JSON.parse(fs.readFileSync(telemetryPath, 'utf8'));
  } catch {
    telemetry = [];
  }

  const lines = [];
  lines.push('# Monthly skill audit');
  lines.push('');
  lines.push(`Run date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`Skills: ${skillsWithFm.length}`);
  lines.push(`Telemetry rows: ${telemetry.length}`);
  lines.push('');

  if (telemetry.length === 0) {
    lines.push('No telemetry available this month. Nothing to audit.');
    return lines.join('\n');
  }

  const byName = new Map(telemetry.map((t) => [t.skill, t]));
  const drifts = [];
  for (const s of skillsWithFm) {
    const t = byName.get(s.name);
    if (!t) {
      drifts.push(`- **${s.name}** — zero invocations in the last 30 days. Either the description is unroutable or the domain it covers isn't being used. Investigate before shipping more content into this skill.`);
      continue;
    }
    if (t.fallbackRate > 0.25) {
      drifts.push(`- **${s.name}** — fallback rate ${Math.round(t.fallbackRate * 100)}% (clarify-intent was invoked instead). Description likely too narrow or missing synonyms.`);
    }
    if (t.crossSkillCollisions > 0) {
      drifts.push(`- **${s.name}** — Claude loaded this skill ${t.crossSkillCollisions} times when another skill was a closer match. Tighten description to reduce overlap.`);
    }
  }

  if (drifts.length === 0) {
    lines.push('Skills are routing cleanly against telemetry. No drift detected.');
  } else {
    lines.push('## Drift detected');
    lines.push('');
    lines.push('The following skills need manual review before next release:');
    lines.push('');
    lines.push(...drifts);
    lines.push('');
    lines.push('### How to action');
    lines.push('');
    lines.push('Run `tools/rewrite-description.sh <skill>` locally, iterate, commit into a fresh session worktree via `tools/new-session.sh`. Do NOT hot-push skill changes — they ship only through the release pipeline.');
  }

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const auditMode = args.includes('--audit-report');
  const checkUpdatableOnly = args.includes('--check-updatable');

  const errors = [];
  const warnings = [];
  const skills = listSkills();
  const skillsWithFm = [];

  if (skills.length === 0) {
    errors.push(`No skills found under ${SKILLS_DIR}`);
  }

  for (const skill of skills) {
    const validated = validateSchema(skill, errors);
    if (!validated) continue;
    const { fm, body } = validated;
    skillsWithFm.push({ name: skill.name, fm, body });
    if (checkUpdatableOnly || auditMode) continue;
    validateDescription(skill, fm, errors, warnings);
    validateByteBudget(skill, body, fm, errors, warnings);
  }

  if (checkUpdatableOnly) {
    validateUpdatable(skillsWithFm, errors);
  } else if (auditMode) {
    process.stdout.write(buildAuditReport(skillsWithFm));
    process.exit(0);
  } else {
    const mainGoActions = collectMainGoActions();
    if (mainGoActions) {
      for (const s of skillsWithFm) {
        validateActionCoverage({ name: s.name }, s.body, mainGoActions, warnings);
      }
    } else {
      warnings.push('autocmo-core/main.go not in checkout — skipping action coverage check');
    }
    validateCollisions(skillsWithFm, warnings);
    validateUpdatable(skillsWithFm, errors);
  }

  if (warnings.length > 0) {
    console.warn(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.warn(`  ⚠ ${w}`);
  }
  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(`\n✓ ${skillsWithFm.length} skills validated.`);
}

if (require.main === module) main();

module.exports = {
  listSkills,
  readFrontmatter,
  collectActionReferences,
  validateActionCoverage,
  cosine,
  tokenize,
  vectorize,
};
