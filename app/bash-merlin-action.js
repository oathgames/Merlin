'use strict';

// Reads the engine action (and other fields) out of a Bash `Merlin --cmd '{...}'`
// command line the SAME way the Go engine will, so the approval gate cards
// what actually runs.
//
// REGRESSION GUARD (2026-10-04, Roundel adversarial review, MEDIUM 6):
// handleToolApproval used to take the FIRST `"action":"..."` match, while
// Go's encoding/json keeps the LAST duplicate key and matches keys
// case-insensitively after decoding \u escapes. So
//   {"action":"roundel-status","action":"roundel-budget","approved":true}
// carded as a harmless read (or not at all) and then ran a spend write. The
// same first-vs-last split let `"dailyBudget":5,"dailyBudget":5000` pass the
// in-cap auto-approve at $5 and launch at $5000. Rules here:
//   - keys are decoded (JSON string escapes) and compared case-insensitively;
//   - more than one action key, or an action key/value Merlin cannot decode,
//     is AMBIGUOUS and the caller denies the command outright;
//   - numeric fields resolve to the LAST occurrence, as Go does.
// A command that only carries the JSON with backslash-escaped quotes (a
// double-quoted shell argument) is read through the unescaped form too.

const STRING_KEY_RE = /"((?:[^"\\]|\\.)*)"\s*:\s*/g;

function decodeJSONString(lit) {
  try {
    const v = JSON.parse('"' + lit + '"');
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function scanKeys(text, wantKey) {
  const hits = []; // { valueText, undecodable }
  const want = wantKey.toLowerCase();
  STRING_KEY_RE.lastIndex = 0;
  let m;
  while ((m = STRING_KEY_RE.exec(text)) !== null) {
    const key = decodeJSONString(m[1]);
    if (key === null) {
      if (m[1].toLowerCase().includes(want.slice(0, 3))) hits.push({ valueText: null, undecodable: true });
      continue;
    }
    if (key.toLowerCase() !== want) continue;
    hits.push({ valueText: text.slice(m.index + m[0].length), undecodable: false });
  }
  return hits;
}

function candidates(command) {
  const s = String(command || '');
  const out = [s];
  if (s.includes('\\"')) out.push(s.replace(/\\"/g, '"'));
  return out;
}

// parseAction -> { action: string, ambiguous: boolean, count: number }
function parseAction(command) {
  let best = { action: '', ambiguous: false, count: 0 };
  for (const text of candidates(command)) {
    const hits = scanKeys(text, 'action');
    if (hits.length === 0) continue;
    const values = hits.map((h) => {
      if (h.undecodable) return null;
      const vm = h.valueText.match(/^"((?:[^"\\]|\\.)*)"/);
      return vm ? decodeJSONString(vm[1]) : null;
    });
    const ambiguous = hits.length > 1 || values.some((v) => v === null || v === '');
    best = { action: values[values.length - 1] || '', ambiguous, count: hits.length };
    break;
  }
  return best;
}

// lastNumber -> number | null. Go keeps the last duplicate key, so do we.
function lastNumber(command, key) {
  for (const text of candidates(command)) {
    const hits = scanKeys(text, key).filter((h) => !h.undecodable);
    if (hits.length === 0) continue;
    const vm = hits[hits.length - 1].valueText.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!vm) return null;
    const n = Number(vm[0]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// lastString -> string | null (same last-wins rule).
function lastString(command, key) {
  for (const text of candidates(command)) {
    const hits = scanKeys(text, key).filter((h) => !h.undecodable);
    if (hits.length === 0) continue;
    const vm = hits[hits.length - 1].valueText.match(/^"((?:[^"\\]|\\.)*)"/);
    return vm ? decodeJSONString(vm[1]) : null;
  }
  return null;
}

// requestsOverride -> boolean. True when ANY occurrence of `key` carries a
// value other than literal false (or cannot be decoded). Same scanner as the
// readers above, so escaped quotes (\"force\"), other letter case ("Force",
// which Go's decoder still binds) and escaped key names are all seen. Any
// occurrence counts rather than last-wins: a malformed or duplicated flag
// over-cards rather than slipping through (2026-10-05, google-budget-force).
//
// The JSON scan reads the literal command, but the shell rebuilds the --cmd
// argument before Go sees it: quote splicing ('for''ce', "fo""rce"), line
// continuation (backslash-newline), brace expansion (fo{r,x}ce), globbing,
// ANSI-C escapes ($'\x63') and $VAR / $(...) / backtick expansion all yield
// a key the scanner never saw. Rather than chase each form, the fallbacks
// return true (card) whenever the shell could rewrite the text at all:
//   - any $ or backtick, or any backslash-newline continuation;
//   - any brace or glob character OUTSIDE quotes, or an unbalanced quote
//     (a plain --cmd '{...}' keeps every brace inside single quotes);
//   - a pipe or input redirect outside quotes, or xargs / --cmd-file
//     anywhere: the JSON is then produced by another program (printf, cat)
//     whose output the text does not show;
//   - the key's letters appearing (any case, after decoding \uXXXX, \xXX and
//     octal escapes at any backslash depth and dropping every non-letter)
//     more often than the scan found it set to literal false. This covers
//     quote splicing and nested escapes in one rule, at the cost of carding a
//     Bash push whose copy merely contains the word.
// All of these only ever ADD a card; a false positive costs one click.
const SHELL_EXPANSION_RE = /[$`]|\\\r?\n|--cmd-file|\bxargs\b/;
function shellCanRewrite(raw) {
  if (SHELL_EXPANSION_RE.test(raw)) return true;
  let state = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (state === "'") { if (c === "'") state = ''; continue; }
    if (state === '"') {
      if (c === '\\') { i++; continue; }
      if (c === '"') state = '';
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { state = c; continue; }
    if (c === '{' || c === '}' || c === '*' || c === '?' || c === '[' || c === '|' || c === '<') return true;
  }
  return state !== '';
}
function lettersOnly(text) {
  let s = String(text);
  for (let i = 0; i < 4; i++) {
    s = s
      .replace(/\\+u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\+x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\+([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  }
  return s.toLowerCase().replace(/[^a-z]/g, '');
}
function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}
function requestsOverride(command, key) {
  const raw = String(command || '');
  let falseHits = 0;
  for (const text of candidates(raw)) {
    const hits = scanKeys(text, key);
    for (const h of hits) {
      if (h.undecodable) return true;
      if (!/^false(?![A-Za-z0-9_])/.test(h.valueText)) return true;
    }
    falseHits = Math.max(falseHits, hits.length);
  }
  if (shellCanRewrite(raw)) return true;
  return countOccurrences(lettersOnly(raw), lettersOnly(key)) > falseHits;
}

module.exports = { parseAction, lastNumber, lastString, requestsOverride };
