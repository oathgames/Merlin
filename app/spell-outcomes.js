// Spell outcomes — aggregate DecisionFacts + errors + generation events
// from a brand's activity.jsonl within the time window around a spell run.
// Returns a small summary object ({kills, scales, generated, errors}) that
// the Spellbook row renders on the second line.
//
// Split out from main.js so it can be unit-tested without Electron. The
// only runtime-specific argument is appRoot (the Electron installation
// root that contains assets/brands/); everything else is pure Node
// fs/path.
//
// Prefers DecisionFact fields (entry.decision.action) over prose — a
// signed DecisionFact is the authoritative record of what happened, and
// the counts roll up cleanly across kill/scale/generate phases. Falls
// back to legacy event shapes (type="error", action="image") so pre-
// DecisionFact activity.jsonl entries still surface as "something
// happened" instead of an empty row.

const fs = require('fs');
const path = require('path');

// Window heuristic: spell runs are bursty (seconds to minutes) but file
// writes settle after the cron fires, so we include [lastRun - 5min,
// lastRun + 4h]. The 4h ceiling keeps us from blending two consecutive
// runs of a frequently-firing spell.
const WINDOW_LEAD_MS = 5 * 60 * 1000;
const WINDOW_TAIL_MS = 4 * 60 * 60 * 1000;

// Tail-read cap for large logs — covers a typical 4h window without
// loading the whole file.
const TAIL_BYTES = 128 * 1024;

function readActivityContent(logPath) {
  const stat = fs.statSync(logPath);
  if (stat.size > 1024 * 1024) {
    const fd = fs.openSync(logPath, 'r');
    try {
      const tailSize = Math.min(stat.size, TAIL_BYTES);
      const buf = Buffer.alloc(tailSize);
      fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
      let content = buf.toString('utf8');
      const firstNewline = content.indexOf('\n');
      if (firstNewline > 0) content = content.slice(firstNewline + 1);
      return content;
    } finally {
      fs.closeSync(fd);
    }
  }
  return fs.readFileSync(logPath, 'utf8');
}

function readSpellOutcomes(appRoot, brand, lastRunIso) {
  if (!appRoot || !brand || !lastRunIso) return null;
  if (!/^[a-z0-9_-]+$/i.test(brand)) return null;
  const lastRunMs = Date.parse(lastRunIso);
  if (!Number.isFinite(lastRunMs)) return null;
  const windowStart = lastRunMs - WINDOW_LEAD_MS;
  const windowEnd = lastRunMs + WINDOW_TAIL_MS;

  const logPath = path.join(appRoot, 'assets', 'brands', brand, 'activity.jsonl');
  if (!fs.existsSync(logPath)) return null;

  let content;
  try { content = readActivityContent(logPath); }
  catch { return null; }

  const outcomes = { kills: 0, scales: 0, generated: 0, errors: 0 };
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    const ts = Date.parse(entry.ts || '');
    if (!Number.isFinite(ts) || ts < windowStart || ts > windowEnd) continue;

    if (entry.type === 'decision' && entry.decision && typeof entry.decision === 'object') {
      const act = entry.decision.action;
      if (act === 'kill') outcomes.kills++;
      else if (act === 'scale') outcomes.scales++;
      else if (act === 'generate') outcomes.generated++;
    } else if (entry.type === 'error' || entry.severity === 'error') {
      outcomes.errors++;
    } else if (entry.action === 'image' || entry.action === 'blog-post' || entry.action === 'video') {
      outcomes.generated++;
    }
  }
  return outcomes;
}

module.exports = { readSpellOutcomes };
