'use strict';

// Routes a Bash command through handleToolApproval's tiers (main.js). Pure:
// no Electron, no fs, so the decision can be driven end to end by tests.
//
// REGRESSION GUARD (2026-11-20, compound command bypass found in review):
// isSafeBash used to decide a command was safe from how it STARTED
// (/^cd\b/, /^echo\b/, /^cp\b/ ...), and it ran BEFORE the BASH_SPEND /
// BASH_CARDED_DESTRUCTIVE branch. So
//   cd /d/x && .claude/tools/Merlin.exe --cmd '{"action":"snapchat-budget","approved":true,"dailyBudget":900}'
// was auto-allowed with no approval card, and so was meta-push behind a
// `cd`, and `echo '{...}' > c.json && Merlin.exe --cmd-file c.json`. The
// engine detector was also a case-sensitive includes('Merlin'), so
// `merlin.exe` (Windows does not care about case) skipped the spend tiers
// entirely. Rules now, all fail closed:
//   - The safe shortcut splits the command on every shell separator outside
//     quotes (&&, ||, ;, |, &, newline, parentheses) and applies only when
//     EVERY segment is independently safe and none invokes the engine. Any
//     $(...), backtick or <( )/>( ) substitution disqualifies the shortcut.
//   - Engine detection (isEngineInvocation) is one detector, used by the
//     safe shortcut AND the spend / destructive branch: Merlin / Merlin.exe
//     as the command word (any path, any case, quoted), Merlin.exe anywhere
//     else in a segment, .../tools/Merlin or .../bin/Merlin (the workspace and
//     the canonical %LOCALAPPDATA%/Merlin/bin binary), or a -cmd / --cmd /
//     --cmd= / --cmd-file flag. A segment whose command word only reads or
//     moves files (cd, ls, cp, echo ...) is not an invocation, so
//     `cd ~/Merlin && ls` stays safe.
//   - The action is read from the engine segment's --cmd value AS THE SHELL
//     WILL PASS IT. When it cannot be read (--cmd-file, $ or backtick
//     expansion, globbing or brace expansion, quote splicing that changes the
//     text, no action key) the command cards as "action could not be read".
//     Numbers and brand for the spend card come from that same value, so a
//     later `echo '{"dailyBudget":5}'` cannot pose as the engine's budget.
// Do not reintroduce a prefix test, and do not let a segment that is not
// independently safe ride on a safe first word.

const bashMerlinAction = require('./bash-merlin-action');

// ── Card tiers for engine actions on the Bash path ─────────────────────
//
// REGRESSION GUARD (2026-11-20, snapchat-budget): meta-budget,
// snapchat-budget and snapchat-activate move ad dollars, and the MCP path
// cards them ('budget' / 'activate' in SPEND_ACTIONS). They were missing
// here, so in auto mode classifyLongTailApproval let
// `Merlin '{"action":"snapchat-budget","approved":true,...}'` run with no
// card at all. They go in BASH_SPEND only, never BASH_PUSH_ONLY, so they
// always card. Pinned by bash-spend-card.test.js.
const BASH_SPEND = new Set(['meta-push', 'tiktok-push', 'google-ads-push', 'amazon-ads-push', 'reddit-create-campaign', 'reddit-create-ad', 'meta-budget', 'snapchat-budget', 'snapchat-activate']);
// Push-equivalent actions are the only ones eligible for in-cap auto-
// approve. Mirrors the MCP path's `action === 'push'` filter (NOT
// `'push' || 'duplicate'`). If a future edit adds a setup-equivalent
// Bash action to BASH_SPEND, it will still card by default, which is
// what we want, since setup actions touch ad-account state without
// necessarily moving budget. Keep this set in sync with BASH_SPEND
// additions: anything that creates or scales paid ad spend goes here;
// anything that touches account configuration stays out.
const BASH_PUSH_ONLY = new Set(['meta-push', 'tiktok-push', 'google-ads-push', 'amazon-ads-push', 'reddit-create-campaign', 'reddit-create-ad']);

// BUDGET-LESS DESTRUCTIVE BASH ACTIONS: mirror of the MCP path's
// CARDED_DESTRUCTIVE_ACTIONS tier (see mcp-approval-policy.js).
//
// REGRESSION GUARD (2026-05-11, post-audit bash bypass):
// The adversarial audit found that an agent could bypass the MCP
// CARDED_DESTRUCTIVE card by calling the binary directly via Bash,
// e.g. `Merlin '{"action":"mailchimp-campaign-send", ...}'`
// would route to the binary, run the CAN-SPAM gate, and ship real
// emails to the brand's audience WITHOUT the Electron card. The
// MCP tool's destructive-action gate is sufficient for tool-using
// agents (Claude on the MCP path); the Bash bypass let any agent
// that knows the binary's action names exfiltrate around it.
//
// Fix: a parallel set of bash actions that require the same
// generic card (no budget context, these actions don't move ad
// dollars). The card auto-expires in 15 min if ignored.
const BASH_CARDED_DESTRUCTIVE = new Set([
  'mailchimp-campaign-send', 'mailchimp-campaign-schedule',
  'mailchimp-automation-pause', 'mailchimp-automation-start',
  // Same bypass shape for the Merchant Center catalog push: the MCP
  // google_merchant tool cards sync-shopify, so the Bash path has to
  // card the engine action it maps to or the card is one binary
  // invocation away from being skipped.
  'merchant-sync-shopify',
  // Permanent marketing-asset deletes, gated in the engine by
  // requireApproval (merlin-core PR #387). Same bypass shape: the MCP
  // tools card these via CARDED_DESTRUCTIVE_ACTIONS, so the Bash path
  // has to card the engine action names or the card is one binary
  // invocation away from being skipped.
  'klaviyo-flow-delete', 'klaviyo-template-delete',
  'mailchimp-campaign-delete', 'postscript-automation-delete',
  // Klaviyo bulk consent import + list create (2026-10-20). Both are
  // requireApproval-gated in the engine and carded on the MCP path; the
  // Bash path cards them too (a Bash dry run cards as well, which only
  // over-protects).
  'klaviyo-subscribe-bulk', 'klaviyo-list-create',
  // Same bypass shape again (2026-09-04). Both are requireApproval-gated
  // in the engine, and both are now carded on the MCP path via
  // CARDED_DESTRUCTIVE_ACTIONS ('quiz-funnel-gen' on the content tool,
  // 'resume-all' on spend_control). Without the engine action names here,
  // the card is one `Merlin '{"action":"resume-all-spend","approved":true}'`
  // away from being skipped, and resume-all-spend re-arms every
  // spend-increasing action across every platform for the brand.
  'quiz-funnel-gen', 'resume-all-spend',
]);

// Safe Bash patterns that can be auto-approved (read-only or setup operations).
// Removed: /^curl\s.*-[sS]/, /^curl\s.*download/, /^node\s+-e\b/, all three
// were blanket auto-approvals that Claude could use to make arbitrary network
// calls. Curl is now permission-checked via the allow/deny lists + hook, and
// node -e is blocked by the hook when it contains network intent.
// Each pattern is tested against ONE segment, never the whole command.
const SAFE_BASH_PATTERNS = [
  // REMOVED: cat, head, tail, can read decrypted temp config files.
  // They now require user approval via the approval card.
  /^ls\b/, /^wc\b/, /^find\b/, /^grep\b/,
  /^mkdir\b/, /^cp\b/, /^mv\b/, /^echo\b/, /^pwd\b/, /^cd\b/, /^test\b/,
  /^chmod\b/, /^xattr\b/, /^codesign\b/,
  // npx REMOVED, auto-approving it lets Claude run arbitrary packages
];
// find can run or delete things; those forms are not "safe".
const FIND_EXEC_RE = /(?:^|\s)-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)\b/i;

// Command words that never execute their arguments. A segment led by one of
// these is not an engine invocation even when an argument names the binary
// (`cd ~/Merlin`, `ls .claude/tools/Merlin.exe`, `chmod +x .../Merlin`).
const NON_EXEC_COMMANDS = new Set([
  'cd', 'ls', 'pwd', 'wc', 'grep', 'mkdir', 'cp', 'mv', 'echo', 'printf',
  'test', '[', 'chmod', 'xattr', 'codesign', 'cat', 'head', 'tail', 'touch',
  'stat', 'file', 'du', 'ln', 'rm', 'rmdir', 'which', 'basename', 'dirname',
  'realpath', 'readlink', 'sha256sum', 'shasum', 'md5sum',
]);

// splitSegments -> { segments: string[], substitution: boolean, unbalanced: boolean }
// Splits on every separator outside quotes. Backslash escapes the next char
// outside single quotes. `&` that is part of a redirection (2>&1, &>) is not a
// separator. $( and backticks also open a new segment so their contents are
// checked on their own.
function splitSegments(command) {
  const s = String(command || '');
  const segments = [];
  let cur = '';
  let state = '';
  let substitution = false;
  const push = () => { if (cur.trim()) segments.push(cur.trim()); cur = ''; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (state === "'") { cur += c; if (c === "'") state = ''; continue; }
    if (c === '\\') { cur += c + (s[i + 1] || ''); i++; continue; }
    if (c === '`') { substitution = true; push(); continue; }
    if (c === '$' && s[i + 1] === '(') { substitution = true; push(); i++; continue; }
    if (state === '"') { cur += c; if (c === '"') state = ''; continue; }
    if (c === "'" || c === '"') { state = c; cur += c; continue; }
    if ((c === '<' || c === '>') && s[i + 1] === '(') { substitution = true; push(); i++; continue; }
    if (c === '&') {
      const prev = s[i - 1];
      if (prev === '>' || prev === '<' || s[i + 1] === '>') { cur += c; continue; }
      push(); continue;
    }
    if (c === ';' || c === '|' || c === '\n' || c === '\r' || c === '(' || c === ')') { push(); continue; }
    cur += c;
  }
  const unbalanced = state !== '';
  push();
  return { segments, substitution, unbalanced };
}

// shellWords -> string[]: the words the shell would pass, quotes removed,
// escapes applied. Expansions are NOT performed; callers check
// segmentShellRewrites first when they need exact words.
function shellWords(segment) {
  const s = String(segment || '');
  const words = [];
  let cur = '';
  let inWord = false;
  let state = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (state === "'") { if (c === "'") state = ''; else cur += c; continue; }
    if (state === '"') {
      if (c === '\\' && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1])) {
        if (s[i + 1] !== '\n') cur += s[i + 1];
        i++; continue;
      }
      if (c === '"') { state = ''; continue; }
      cur += c; continue;
    }
    if (c === '\\') {
      if (s[i + 1] === '\n') { i++; continue; }
      if (i + 1 < s.length) { cur += s[i + 1]; inWord = true; i++; }
      continue;
    }
    if (c === "'" || c === '"') { state = c; inWord = true; continue; }
    if (/\s/.test(c)) { if (inWord) { words.push(cur); cur = ''; inWord = false; } continue; }
    cur += c; inWord = true;
  }
  if (inWord) words.push(cur);
  return words;
}

// True when the shell could produce text the literal command does not show:
// $ or backtick outside single quotes (variables, $'..', ${..}), glob or
// brace characters outside quotes, or an unbalanced quote.
function segmentShellRewrites(segment) {
  const s = String(segment || '');
  let state = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (state === "'") { if (c === "'") state = ''; continue; }
    if (c === '$' || c === '`') return true;
    if (state === '"') {
      if (c === '\\') { i++; continue; }
      if (c === '"') state = '';
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { state = c; continue; }
    if (c === '{' || c === '}' || c === '*' || c === '?' || c === '[' || c === ']') return true;
  }
  return state !== '';
}

function baseName(word) {
  return String(word || '').split(/[\\/]/).pop().toLowerCase();
}

function commandWordIndex(words) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  return i;
}

const ENGINE_BIN_RE = /^merlin(?:\.exe)?$/i;
// Raw-text forms, for an engine call wrapped in another command
// (bash -c "...", cmd /c, xargs, env, find -exec, { ...; }).
const ENGINE_EXE_RE = /(?:^|[\s"'`=(\\/&;|])merlin\.exe(?=$|[\s"'`;&|)])/i;
const ENGINE_PATH_RE = /[\\/](?:tools|bin)[\\/]merlin(?:\.exe)?(?=$|[\s"'`;&|)])/i;
const CMD_FLAG_WORD_RE = /^--?cmd(?:-file)?(?:=|$)/i;
const CMD_FLAG_RAW_RE = /(?:^|[\s"'`])--?cmd(?:-file)?(?:=|(?=$|[\s"'`]))/i;

function segmentInvokesEngine(segment, opts) {
  const words = shellWords(segment);
  const ci = commandWordIndex(words);
  const cmdWord = words[ci] || '';
  if (ENGINE_BIN_RE.test(baseName(cmdWord))) return true;
  const allowNonExec = !(opts && opts.noNonExecExemption);
  if (allowNonExec && NON_EXEC_COMMANDS.has(baseName(cmdWord))) return false;
  if (words.slice(ci).some((w) => ENGINE_BIN_RE.test(w) || CMD_FLAG_WORD_RE.test(w))) return true;
  return ENGINE_EXE_RE.test(segment) || ENGINE_PATH_RE.test(segment) || CMD_FLAG_RAW_RE.test(segment);
}

// The one engine detector. A command substitution disables the non-exec
// exemption (`echo "$(Merlin.exe --cmd ...)"` runs the engine).
function isEngineInvocation(command) {
  const { segments, substitution, unbalanced } = splitSegments(command);
  const opts = { noNonExecExemption: substitution || unbalanced };
  return segments.some((seg) => segmentInvokesEngine(seg, opts));
}

function isSafeBash(command) {
  const { segments, substitution, unbalanced } = splitSegments(command);
  if (substitution || unbalanced || segments.length === 0) return false;
  return segments.every((seg) =>
    SAFE_BASH_PATTERNS.some((p) => p.test(seg)) &&
    !(/^find\b/.test(seg) && FIND_EXEC_RE.test(seg)) &&
    !segmentInvokesEngine(seg));
}

// readSegmentCall -> { cmdText: string|null, unreadable: '' | 'file' | 'shell' | 'no-action' }
// cmdText is the --cmd value exactly as Go receives it (last flag wins, as
// Go's flag package does). null with unreadable '' means the segment runs the
// binary without a JSON command (--version, --setup).
function readSegmentCall(segment, rawCommand) {
  if (segmentShellRewrites(segment)) return { cmdText: null, unreadable: 'shell' };
  const words = shellWords(segment);
  // The binary must be the command word. A wrapped call (bash -c "...",
  // env, xargs, find -exec, cmd /c) hides its arguments in another
  // program's input, so its action cannot be read from these words.
  if (!ENGINE_BIN_RE.test(baseName(words[commandWordIndex(words)]))) {
    return { cmdText: null, unreadable: 'shell' };
  }
  let cmdText = null;
  let file = false;
  for (let i = 0; i < words.length; i++) {
    const m = words[i].match(/^--?cmd(-file)?(?:=([\s\S]*))?$/i);
    if (!m) continue;
    const value = m[2] !== undefined ? m[2] : words[i + 1];
    if (m[2] === undefined) i++;
    if (m[1]) file = true;
    else cmdText = value === undefined ? '' : value;
  }
  // Go reads --cmd-file only when --cmd is empty; either way the action is
  // not on the command line when a file is involved, so card it.
  if (file) return { cmdText: null, unreadable: 'file' };
  if (cmdText === null) return { cmdText: null, unreadable: '' };
  // The value the shell passes must appear in the command text as written
  // (directly, or with \" unescaped). Otherwise quote splicing or escapes
  // changed it, and the text-based readers would not see what Go runs.
  const raw = String(rawCommand || '');
  if (!raw.includes(cmdText) && !raw.replace(/\\"/g, '"').includes(cmdText)) {
    return { cmdText: null, unreadable: 'shell' };
  }
  return { cmdText, unreadable: '' };
}

// classifyEngineCall -> {
//   engine: boolean,      the command invokes the binary somewhere
//   kind: 'none' | 'ambiguous' | 'unreadable' | 'action',
//   action: string, cmdText: string, reason: '' | 'file' | 'shell' | 'no-action'
// }
// A command that only MENTIONS Merlin (legacy includes('Merlin') reach) is
// still read for its action as before, but never cards as unreadable.
function classifyEngineCall(command) {
  const raw = String(command || '');
  const engine = isEngineInvocation(raw);
  if (!engine && !raw.includes('Merlin')) {
    return { engine: false, kind: 'none', action: '', cmdText: raw, reason: '' };
  }
  const whole = bashMerlinAction.parseAction(raw);
  if (whole.ambiguous) return { engine, kind: 'ambiguous', action: '', cmdText: raw, reason: '' };
  if (!engine) return { engine, kind: 'action', action: whole.action || '', cmdText: raw, reason: '' };

  const { segments, substitution, unbalanced } = splitSegments(raw);
  if (substitution || unbalanced) return { engine, kind: 'unreadable', action: '', cmdText: raw, reason: 'shell' };
  const calls = [];
  for (const seg of segments) {
    if (!segmentInvokesEngine(seg)) continue;
    const call = readSegmentCall(seg, raw);
    if (call.unreadable) return { engine, kind: 'unreadable', action: '', cmdText: raw, reason: call.unreadable };
    if (call.cmdText === null) continue;
    const parsed = bashMerlinAction.parseAction(call.cmdText);
    if (parsed.ambiguous) return { engine, kind: 'ambiguous', action: '', cmdText: raw, reason: '' };
    if (!parsed.action) return { engine, kind: 'unreadable', action: '', cmdText: raw, reason: 'no-action' };
    calls.push({ action: parsed.action, cmdText: call.cmdText });
  }
  if (calls.length > 1) return { engine, kind: 'ambiguous', action: '', cmdText: raw, reason: '' };
  if (calls.length === 0) return { engine, kind: 'action', action: '', cmdText: raw, reason: '' };
  return { engine, kind: 'action', action: calls[0].action, cmdText: calls[0].cmdText, reason: '' };
}

// routeBash -> { route, action, cmdText, reason }, route one of:
//   'safe'             auto-allow (every segment safe, no engine call)
//   'deny-ambiguous'   names its action more than once / undecodable
//   'card-unreadable'  invokes the engine, action could not be read
//   'spend'            BASH_SPEND action: main.js budget card path
//   'destructive'      BASH_CARDED_DESTRUCTIVE action: generic card
//   'other'            falls through to the long tail
// main.js handleToolApproval dispatches on exactly this value.
function routeBash(command) {
  if (isSafeBash(command)) return { route: 'safe', action: '', cmdText: String(command || ''), reason: '' };
  const c = classifyEngineCall(command);
  const out = { action: c.action, cmdText: c.cmdText, reason: c.reason };
  if (c.kind === 'ambiguous') return { route: 'deny-ambiguous', ...out };
  if (c.kind === 'unreadable') return { route: 'card-unreadable', ...out };
  if (c.kind === 'action' && BASH_SPEND.has(c.action)) return { route: 'spend', ...out };
  if (c.kind === 'action' && BASH_CARDED_DESTRUCTIVE.has(c.action)) return { route: 'destructive', ...out };
  return { route: 'other', ...out };
}

const UNREADABLE_REASON_TEXT = Object.freeze({
  file: 'The action comes from a file (--cmd-file), so Merlin could not read which action this command runs.',
  shell: 'The shell builds part of this command, so Merlin could not read which action it runs.',
  'no-action': 'Merlin could not read which action this command runs.',
});

// Card for route 'card-unreadable'. Same wording conventions as the
// ambiguous-action deny in main.js ("in a form Merlin cannot read").
function unreadableEngineCard(reason) {
  return {
    label: 'Run a Merlin command whose action could not be read',
    cost: (UNREADABLE_REASON_TEXT[reason] || UNREADABLE_REASON_TEXT['no-action']) +
      ' It may spend money or contact customers.',
    budget: 'Review the command before approving. Auto-expires in 15 min if ignored.',
  };
}

module.exports = {
  BASH_SPEND,
  BASH_PUSH_ONLY,
  BASH_CARDED_DESTRUCTIVE,
  SAFE_BASH_PATTERNS,
  splitSegments,
  shellWords,
  isEngineInvocation,
  isSafeBash,
  classifyEngineCall,
  routeBash,
  unreadableEngineCard,
};
