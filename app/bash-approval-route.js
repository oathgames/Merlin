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
const approvalPolicy = require('./mcp-approval-policy');

// ── Card tiers for engine actions on the Bash path ─────────────────────
//
// REGRESSION GUARD (2026-11-20, snapchat-budget): meta-budget,
// snapchat-budget and snapchat-activate move ad dollars, and the MCP path
// cards them ('budget' / 'activate' in SPEND_ACTIONS). They were missing
// here, so in auto mode classifyLongTailApproval let
// `Merlin '{"action":"snapchat-budget","approved":true,...}'` run with no
// card at all. They go in BASH_SPEND only, never BASH_PUSH_ONLY, so they
// always card. Pinned by bash-spend-card.test.js.
//
// REGRESSION GUARD (2026-11-20, bash-approval-followup): the lists were
// hand-maintained and drifted from the engine. meta-activate, meta-bulk-push,
// google-ads-budget, openai-ads-budget, openai-ads-activate,
// snapchat-batch-status and about forty other engine actions that start
// spend, change a budget or flip live delivery reached the engine from Bash
// with no card. Every engine action the dispatcher gates (requireApproval,
// the spend caps, a .Approved read, or an ACTIVE / budget field write) is
// listed in engine-approval-actions.json, generated from autocmo-core
// main.go; bash-engine-approval-manifest.test.js fails when one of them is
// in neither list below nor ENGINE_GATED_EXEMPT. Classification mirrors the
// MCP path (mcp-approval-policy.js): its SPEND_ACTIONS ('push', 'duplicate',
// 'activate', 'budget', 'bulk-push', 'setup', 'retarget', 'demandgen-push',
// 'search-create', 'roi-target', ...) land here, its
// CARDED_DESTRUCTIVE_ACTIONS land in BASH_CARDED_DESTRUCTIVE.
const BASH_SPEND = new Set([
  'meta-push', 'tiktok-push', 'google-ads-push', 'amazon-ads-push', 'reddit-create-campaign', 'reddit-create-ad',
  'meta-budget', 'snapchat-budget', 'snapchat-activate',
  // Meta: start delivery, create budgeted objects, or change what live
  // budget buys (MCP 'activate' / 'bulk-push' / 'duplicate' / 'setup' /
  // 'retarget', and the meta_* intent tools routed to 'duplicate').
  'meta-activate', 'meta-bulk-push', 'meta-duplicate', 'meta-clone-adset', 'meta-dpa-setup',
  'meta-setup', 'meta-setup-retargeting', 'meta-retarget',
  'meta-edit-link', 'meta-refresh-creative-spec', 'meta-set-url-tags',
  'meta-set-optimization-goal', 'meta-set-attribution',
  // Batch status cards unless it can only pause (see BASH_PAUSE_ONLY_STATUS).
  'meta-batch-status', 'snapchat-batch-status',
  // Google Ads
  'google-ads-activate', 'google-ads-budget', 'google-ads-duplicate', 'google-ads-setup',
  'google-ads-demandgen-push', 'google-ads-search-create',
  // OpenAI Ads, LinkedIn, Amazon, TikTok, Pinterest, X
  'openai-ads-push', 'openai-ads-activate', 'openai-ads-budget',
  'linkedin-push', 'linkedin-duplicate', 'linkedin-budget', 'linkedin-setup',
  'amazon-ads-setup',
  'tiktok-duplicate', 'tiktok-setup', 'tiktok-gmv-max-update-roi',
  'pinterest-activate', 'twitter-activate',
  // Snapchat builders: every object is created PAUSED, but each carries the
  // budget that spends once it is turned on (MCP 'create-campaign' /
  // 'bulk-push' / 'setup' class).
  'snapchat-create-campaign', 'snapchat-create-ad-squad', 'snapchat-create-ad',
  'snapchat-bulk-push', 'snapchat-build-architecture', 'snapchat-dpa-setup',
]);
// Push-equivalent actions are the only ones eligible for in-cap auto-
// approve. Mirrors the MCP path's `action === 'push'` filter (NOT
// `'push' || 'duplicate'`). If a future edit adds a setup-equivalent
// Bash action to BASH_SPEND, it will still card by default, which is
// what we want, since setup actions touch ad-account state without
// necessarily moving budget. Keep this set in sync with BASH_SPEND
// additions: anything that creates or scales paid ad spend goes here;
// anything that touches account configuration stays out.
// openai-ads-push and linkedin-push are the engine actions behind the MCP
// 'push' action on their tools, so they share its in-cap eligibility.
const BASH_PUSH_ONLY = new Set(['meta-push', 'tiktok-push', 'google-ads-push', 'amazon-ads-push', 'reddit-create-campaign', 'reddit-create-ad', 'openai-ads-push', 'linkedin-push']);

// Batch status actions that only stop spend when batchStatus is PAUSED.
// Pausing follows the meta-kill policy on the Bash path (uncarded: an
// emergency brake that asks permission is not an emergency brake) and the
// MCP path's meta_batch_pause routing. Any other value, a missing value, or
// a value the shell could rewrite cards as spend. Go binds the LAST
// batchStatus key in any letter case, and so does lastString.
const BASH_PAUSE_ONLY_STATUS = new Set(['meta-batch-status', 'snapchat-batch-status']);

// Engine actions the dispatcher gates (engine-approval-actions.json) that the
// Bash path deliberately does not card, each with its reason. Mirrors the
// MCP path; bash-engine-approval-manifest.test.js requires every gated action
// to be carded or listed here.
const KILL_POLICY = 'Stops spend. Follows the Bash meta-kill policy: the emergency brake is never carded.';
const READ_ONLY = 'Read-only: the gate signal is a status or budget field it filters or prints, not a write.';
const LOGIN = 'OAuth connect flow: the user authorizes in the browser, no spend and no customer contact.';
const ENGINE_GATED_EXEMPT = Object.freeze({
  'pinterest-kill': KILL_POLICY,
  'snapchat-kill': KILL_POLICY,
  'twitter-kill': KILL_POLICY,
  'competitor-scan': READ_ONLY,
  'google-ads-audiences': READ_ONLY,
  'impact-partners': READ_ONLY,
  'meta-audit-account-state': READ_ONLY,
  'meta-audit-frequency-caps': READ_ONLY,
  'meta-audit-retargeting-cascade': READ_ONLY,
  'meta-discover': READ_ONLY,
  'meta-export-creatives': READ_ONLY,
  'meta-import': READ_ONLY,
  'meta-list-adsets': READ_ONLY,
  'pinterest-campaigns': READ_ONLY,
  'pinterest-insights': READ_ONLY,
  'postscript-keywords': READ_ONLY,
  'snapchat-ad-squads': READ_ONLY,
  'snapchat-ads': READ_ONLY,
  'snapchat-campaigns': READ_ONLY,
  'tiktok-campaigns': READ_ONLY,
  'tiktok-gmv-max-campaign-info': READ_ONLY,
  'twitter-campaigns': READ_ONLY,
  'meta-login': LOGIN,
  'pinterest-login': LOGIN,
  'snapchat-login': LOGIN,
  'twitter-login': LOGIN,
  'oauth-exchange': LOGIN,
  'meta-lookalike': 'Creates a lookalike audience: no spend, no customer contact. The MCP path routes meta_build_lookalike to the auto-approved audit tier.',
  'snapchat-upload-media': 'Uploads an asset to the ad account library. No spend and nothing is served; the MCP snapchat tool auto-approves it.',
  'snapchat-create-creative': 'Creates an unattached creative. No spend and nothing is served until an ad uses it; the MCP snapchat tool auto-approves it.',
  'snapchat-create-product-set': 'Creates a catalog product set. No spend and nothing is served; the MCP snapchat tool auto-approves it.',
  'snapchat-create-dynamic-template': 'Creates a catalog ad template. No spend and nothing is served; the MCP snapchat tool auto-approves it.',
  'reddit-prospect-post': 'Carded by its own branch in main.js handleToolApproval (REDDIT ORGANIC POST), which runs before these tiers.',
});

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
  // 2026-11-20 (bash-approval-followup): engine-gated or live
  // customer-facing writes the MCP path cards via CARDED_DESTRUCTIVE_ACTIONS
  // ('brand-exclusion', 'exclude-audience', the GA4 Admin and GTM writes,
  // 'campaign-send' / 'campaign-schedule', 'export-raw', 'create-audience',
  // 'post', the Postscript flow writes) or via 'setup' (audience creation,
  // customer-list upload, frequency cap) with no budget to show.
  'google-ads-brand-exclusion', 'google-ads-exclude-audience',
  'google-analytics-create-key-event', 'google-analytics-archive-key-event',
  'google-analytics-create-custom-dimension', 'google-analytics-create-custom-metric',
  'google-analytics-create-audience', 'google-analytics-update-property-settings',
  'google-analytics-update-stream-settings', 'google-analytics-attach-shopify-events',
  'gtm-install-ga4', 'gtm-install-quiz-funnel', 'gtm-tier1-cleanup', 'gtm-create-version', 'gtm-publish',
  'klaviyo-campaign-send', 'klaviyo-campaign-schedule',
  'gorgias-export-raw',
  'meta-create-audience', 'meta-create-engagement-audience', 'meta-upload-customer-list',
  'meta-set-frequency-cap', 'snapchat-create-audience',
  'discord-post', 'slack-post',
  'postscript-automation-create', 'postscript-automation-update',
  'postscript-automation-activate', 'postscript-automation-deactivate',
  'postscript-automation-step-create', 'postscript-automation-step-update',
  'postscript-automation-step-delete', 'postscript-bulk-import-flow',
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

// ── ANSI-C quoting ($'...') ───────────────────────────────────────────
//
// REGRESSION GUARD (2026-11-20, bash-approval-followup review): bash decodes
// $'..' strings (\xHH, \NNN octal, \uHHHH, \n, \cX ...) before the program
// sees its arguments, and nothing here did. So
//   .claude/tools/$'Merl\x69n.exe' $'\x2d\x2dcmd' $'{"\x61ction":"meta-budget","adId":"1","dailyBudget":900}'
// routed 'other' and ran a budget change uncarded, and
//   .claude/tools/M?rlin.exe $'\055cmd' $'{"\141ction":"meta-push"}'
// hid its --cmd flag from the glob rule. routeBash now decodes every $'..'
// string into an equivalent single-quoted word FIRST, so the engine detector,
// the action reader and the spend card all read what bash passes. An escape
// this decoder cannot reproduce exactly (a NUL, a raw byte >= 0x80, \c with
// no printable letter, \x / \u / \U with no digits, an invalid code point,
// an unterminated string) makes the whole command fail closed as an
// unreadable engine call. Bash rules mirrored: \a \b \e \E \f \n \r \t \v
// \\ \' \" \?, \NNN (1-3 octal digits), \xHH (1-2 hex), \uHHHH (1-4),
// \UHHHHHHHH (1-8), \cX (X & 0x1f); any other backslash pair stays as
// written. $'..' is not special inside double or single quotes.
// Pinned by bash-ansi-c-fold.test.js.
//
// REGRESSION GUARD (2026-11-20, bash-approval-followup review 2): the
// decoder kept its own quote state and did not know # comments, so the
// apostrophe in `echo hi # don't` opened a quote and every later $'..' was
// left undecoded (routed 'other', hook exit 0). The decoder now comments
// exactly as bash does (a # beginning a word outside quotes; not a#b, $#,
// ${x#y}), looking through backslash-newline, and drops quote characters
// from comment text. Lexing it does not model (here-docs, << , backticks,
// $( / quoted ${..} inside double quotes) rewrites nothing. Backstop, whatever
// the decoder believed: an unterminated quote, an output that splitSegments
// would pair differently, or any $' whose body holds a backslash left in the
// output (naive scan, no quote or comment context) fails closed.
const ANSI_C_SIMPLE = Object.freeze({
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  '\\': '\\', "'": "'", '"': '"', '?': '?',
});

// decodeAnsiCBody(s, i) -> { value, end } | null. s[i] is the first char after $'.
function decodeAnsiCBody(s, i) {
  let out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === "'") return { value: out, end: i + 1 };
    if (c !== '\\') { out += c; i++; continue; }
    const n = s[i + 1];
    if (n === undefined) return null;
    if (Object.prototype.hasOwnProperty.call(ANSI_C_SIMPLE, n)) { out += ANSI_C_SIMPLE[n]; i += 2; continue; }
    let m = /^[0-7]{1,3}/.exec(s.slice(i + 1));
    if (m) {
      const v = parseInt(m[0], 8);
      if (v === 0 || v > 0x7f) return null;
      out += String.fromCharCode(v); i += 1 + m[0].length; continue;
    }
    if (n === 'x' || n === 'u' || n === 'U') {
      const max = n === 'x' ? 2 : n === 'u' ? 4 : 8;
      m = new RegExp('^[0-9A-Fa-f]{1,' + max + '}').exec(s.slice(i + 2));
      if (!m) return null;
      const v = parseInt(m[0], 16);
      if (v === 0 || (n === 'x' && v > 0x7f) || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return null;
      out += String.fromCodePoint(v); i += 2 + m[0].length; continue;
    }
    if (n === 'c') {
      const x = s[i + 2];
      if (x === undefined || x.charCodeAt(0) < 0x21 || x.charCodeAt(0) > 0x7e) return null;
      const v = x.charCodeAt(0) & 0x1f;
      if (v === 0) return null;
      out += String.fromCharCode(v); i += 3; continue;
    }
    out += '\\' + n; i += 2;
  }
  return null;
}

// decodeAnsiC -> { text, failed }: the command with every $'..' rewritten as
// a plain single-quoted word holding its decoded value.
function decodeAnsiC(command) {
  const s = String(command || '');
  const hasAnsi = s.includes("$'");
  if (!hasAnsi && !s.includes('#')) return { text: s, failed: false };
  // residue(t): a $' whose body (up to the next unescaped ') holds a
  // backslash, found with no quote or comment context at all.
  const residue = (t) => {
    for (let k = t.indexOf("$'"); k >= 0; k = t.indexOf("$'", k + 2)) {
      for (let j = k + 2; j < t.length && t[j] !== "'"; j++) if (t[j] === '\\') return true;
    }
    return false;
  };
  // balanced(t): quote pairing as splitSegments reads it.
  const balanced = (t) => {
    let q = '';
    for (let j = 0; j < t.length; j++) {
      const ch = t[j];
      if (q === "'") { if (ch === "'") q = ''; continue; }
      if (ch === '\\') { j++; continue; }
      if (q === '"') { if (ch === '"') q = ''; continue; }
      if (ch === "'" || ch === '"') q = ch;
    }
    return q === '';
  };
  // wordStart(i): s[i] begins a word. A backslash-newline continuation
  // vanishes before bash splits words, so it is looked through. CR is an
  // ordinary character to bash, not a separator.
  const wordStart = (i) => {
    let p = i - 1;
    while (p >= 1 && s[p] === '\n') {
      let b = 0;
      while (p - 1 - b >= 0 && s[p - 1 - b] === '\\') b++;
      if (b % 2 === 0) break;
      p -= 2;
    }
    return p < 0 || /[ \t\n;&|()<>]/.test(s[p]);
  };
  // Lexing this decoder does not model exactly (here-docs, << shifts,
  // backticks, $( or ${..} with quotes inside double quotes) means the
  // quote state below may be wrong. Then nothing is rewritten: an
  // escape-bearing $'..' fails closed, anything else is returned as written.
  const giveUp = () => ({ text: s, failed: hasAnsi && residue(s) });
  let out = '';
  let state = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (state === "'") { out += c; if (c === "'") state = ''; continue; }
    if (c === '\\') { out += c + (s[i + 1] || ''); i++; continue; }
    if (state === '"') {
      if (c === '`' || (c === '$' && s[i + 1] === '(')) return giveUp();
      if (c === '$' && s[i + 1] === '{') {
        const close = s.indexOf('}', i);
        if (close < 0 || /['"`\\]|\$\(/.test(s.slice(i, close))) return giveUp();
      }
      out += c;
      if (c === '"') state = '';
      continue;
    }
    if (c === '`') return giveUp();
    if (c === '<' && s[i + 1] === '<') {
      if (s[i + 2] !== '<') return giveUp();
      out += '<<<'; i += 2; continue;
    }
    // A # that begins a word outside quotes comments to end of line, as in
    // bash. Its quote and escape characters are dropped so no later lexer
    // reads a quote that bash never sees.
    if (c === '#' && wordStart(i)) {
      let j = i;
      while (j < s.length && s[j] !== '\n') j++;
      out += s.slice(i, j).replace(/['"`\\]/g, '');
      i = j - 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '$') { out += '$$'; i++; continue; }
    if (c === '$' && s[i + 1] === "'") {
      const d = decodeAnsiCBody(s, i + 2);
      if (!d) return { text: s, failed: true };
      out += "'" + d.value.replace(/'/g, "'\\''") + "'";
      i = d.end - 1;
      continue;
    }
    if (c === "'" || c === '"') state = c;
    out += c;
  }
  // Fail-closed backstop: an unterminated quote, a result whose quote
  // pairing splitSegments would read differently, or an escape-bearing $'
  // left anywhere in the result means the lexing above went wrong.
  if (state !== '' || !balanced(out) || residue(out)) return { text: s, failed: hasAnsi };
  return { text: out, failed: false };
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

// ── Engine calls the literal text does not show ───────────────────────
//
// REGRESSION GUARD (2026-11-20, bash-approval-followup): every detector
// above reads the binary name from the literal command. The shell can build
// it instead, and each of these routed as 'other' and ran uncarded in auto
// mode:
//   B=.claude/tools/Mer; A=-cmd; ${B}lin.exe $A '{"action":"meta-push","approved":true,"dailyBudget":900}'
//   "${B}"lin.exe $A '{...same...}'
//   echo "Mer""lin.ex""e -c""md {...}" > s.sh && . s.sh
// The rule (hiddenEngineCall), applied when no literal engine invocation was
// found:
//   (a) a segment whose COMMAND WORD cannot be resolved from the text (it
//       contains $, a backtick or a glob character, so the shell picks the
//       program), or whose command word runs other text as a program
//       (. / source / eval / exec, a shell interpreter, or a ./path script),
//       AND the de-quoted command carries an engine signal anywhere: a
//       --cmd / -cmd / --cmd-file flag in any spliced form (A=-cmd, -c""md),
//       the binary name in any spliced form, or an "action" JSON key.
//       -> card as "could not read action". Neither the program nor its
//       input can be read, and the signal says it may be the engine.
//   (b) independent of the command word: the de-quoted text names a
//       BASH_SPEND or BASH_CARDED_DESTRUCTIVE action as an "action" value,
//       and some segment is led by a program that is not a known text-only
//       command (NON_EXEC_COMMANDS or git). -> card as unreadable.
// Fails closed because both conditions only ever ADD a card: an unresolvable
// program plus an engine signal is treated as the engine with an unknown
// action, which is the most restrictive reading available short of a deny.
// It does not over-block: a resolvable known-safe program (`grep -n
// '"action":"meta-push"' f.js`, `git commit -m "fix meta-push"`) never
// trips (b), and (a) needs both an unresolvable or script-running program
// and an engine signal, so `cd "$HOME" && ls` and `echo $PATH` are unchanged.
// Interpreters (node, python, powershell, cmd) run code that can build the
// engine path and flag by string concatenation ("Mer"+"lin.exe",
// "-"+"-c"+"md") or cmd's ^ escape. Rule (a) still needs an engine signal,
// so `node script.js` and `python x.py` with no signal are not carded.
const SCRIPT_RUNNERS = new Set([
  '.', 'source', 'eval', 'exec', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'busybox',
  'node', 'node.exe', 'python', 'python.exe', 'python3', 'python3.exe',
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cmd', 'cmd.exe',
]);
// Programs that only search or print text: a carded action NAME in their
// arguments is a search pattern, not an engine call (rule (b)). sed counts
// only while its script cannot execute: GNU sed's `e` command and the s///e
// flag hand text to /bin/sh (SED_EXEC_RE). awk is not here (system()).
const TEXT_SEARCH_COMMANDS = ['rg', 'rg.exe', 'ag', 'ack', 'findstr', 'findstr.exe', 'select-string', 'sls'];
const TEXT_ONLY_COMMANDS = new Set([...NON_EXEC_COMMANDS, 'git', ...TEXT_SEARCH_COMMANDS]);
const SED_EXEC_RE = /(?:^|[\s;{}0-9$\/!])e(?:\s|;|}|$)|s(.)(?:(?!\1).)*\1(?:(?!\1).)*\1[gpiImMw0-9]*e/;
const HIDDEN_CMD_FLAG_RE = /(?:^|[\s"'`=(\[,])--?cmd(?:-file)?(?:=|(?=$|[\s"'`;&|),\]]))/i;
const HIDDEN_BIN_RE = /merlin(?:\.exe)?(?=$|[\s;&|),\]])/i;
// A glob or variable command word under the engine's own directories picks
// the engine binary however it is spelled (.claude/tools/M?rlin.exe,
// $D/Merlin/bin/*), so it is an engine signal by itself.
const ENGINE_DIR_RE = /(?:^|[\\/])\.claude[\\/]tools[\\/]|merlin[\\/]bin(?:[\\/]|$)/i;

function textOnlyProgram(word, segment) {
  const base = baseName(word);
  if (base === 'sed' || base === 'sed.exe') {
    return !SED_EXEC_RE.test(shellWords(segment).slice(1).join(' '));
  }
  return TEXT_ONLY_COMMANDS.has(base);
}

function wordUnresolvable(word) {
  const w = String(word || '');
  if (w === '[' || w === '[[') return false;
  return /[$`*?[]/.test(w);
}

function wordRunsScript(word) {
  const w = String(word || '');
  if (SCRIPT_RUNNERS.has(baseName(w))) return true;
  // ./s.sh, ../x/run, /tmp/s.sh: a path the shell executes directly.
  return /^\.{0,2}\//.test(w) && !ENGINE_BIN_RE.test(baseName(w));
}

// The command as the shell would see it after quote removal, in several
// forms, so a signal split across quotes or escapes is still seen.
// Extra forms (2026-11-20 review): printf / echo -e escapes decoded at any
// backslash depth (\115erlin.exe, \055\055cmd), string concatenation and
// cmd caret escapes squeezed out ("Mer"+"lin.exe", Mer^lin.exe), and long
// base64 tokens decoded (echo LmNs... | base64 -d | sh). Each form only
// adds signals.
// Each pattern matches a WHOLE backslash run, with the escape optional, so a
// long run with no escape after it is consumed once instead of being retried
// from every backslash (/\\+u.../ was quadratic: 50KB of backslashes took
// ~10s). A run with no escape is returned unchanged, so the result is the
// same as the plain /\\+u(....)/g replace.
function decodeEscapesLoose(text) {
  let s = String(text);
  for (let i = 0; i < 4; i++) {
    s = s
      .replace(/\\+(?:u([0-9A-Fa-f]{4}))?/g, (m, h) => (h ? String.fromCharCode(parseInt(h, 16)) : m))
      .replace(/\\+(?:x([0-9A-Fa-f]{2}))?/g, (m, h) => (h ? String.fromCharCode(parseInt(h, 16)) : m))
      .replace(/\\+(?:0?([0-7]{3}))?/g, (m, o) => (o ? String.fromCharCode(parseInt(o, 8) & 0xff) : m));
  }
  return s;
}
function base64Decodings(text) {
  const out = [];
  for (const tok of String(text).match(/[A-Za-z0-9+/]{12,}={0,2}/g) || []) {
    const d = Buffer.from(tok, 'base64').toString('latin1');
    if (/^[\x09\x0a\x0d\x20-\x7e]+$/.test(d)) out.push(d);
    else if (/^(?:[\x20-\x7e]\x00)+$/.test(d)) out.push(d.replace(/\x00/g, '')); // UTF-16LE (-EncodedCommand)
  }
  return out;
}
function dequotedForms(raw) {
  const { segments } = splitSegments(raw);
  const joined = segments.map((seg) => shellWords(seg).join(' ')).join(' ; ');
  const stripped = raw.replace(/['"\\]/g, '');
  const escDecoded = decodeEscapesLoose(raw);
  const squeezed = escDecoded.replace(/['"\\+^`]/g, '');
  const b64 = base64Decodings(stripped);
  return [raw, raw.replace(/\\"/g, '"'), joined, stripped, escDecoded, squeezed, ...b64, ...b64.map(decodeEscapesLoose)];
}

function engineSignal(raw) {
  for (const text of dequotedForms(raw)) {
    if (HIDDEN_CMD_FLAG_RE.test(text) || HIDDEN_BIN_RE.test(text)) return true;
    const parsed = bashMerlinAction.parseAction(text);
    if (parsed.count > 0) return true;
  }
  return false;
}

function carriesCardedAction(raw) {
  for (const text of dequotedForms(raw)) {
    const parsed = bashMerlinAction.parseAction(text);
    if (parsed.ambiguous && parsed.count > 0) return true;
    if (BASH_SPEND.has(parsed.action) || BASH_CARDED_DESTRUCTIVE.has(parsed.action)) return true;
  }
  return false;
}

// hiddenEngineCall -> boolean (see the rule above).
function hiddenEngineCall(command) {
  const raw = String(command || '');
  const { segments } = splitSegments(raw);
  const programs = segments.map((seg) => {
    const words = shellWords(seg);
    return words[commandWordIndex(words)] || '';
  });
  if (programs.some((w) => wordUnresolvable(w) && ENGINE_DIR_RE.test(w))) return true;
  if (programs.some((w) => wordUnresolvable(w) || wordRunsScript(w)) && engineSignal(raw)) return true;
  const allTextOnly = programs.every((w, i) => w === '' || (!wordUnresolvable(w) && textOnlyProgram(w, segments[i])));
  return !allTextOnly && carriesCardedAction(raw);
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
  if (!engine && hiddenEngineCall(raw)) {
    return { engine: true, kind: 'unreadable', action: '', cmdText: raw, reason: 'shell' };
  }
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

// True only when the engine JSON's batchStatus is exactly PAUSED, read the
// way Go binds it (last key wins, any letter case, escapes decoded). cmdText
// is the value exactly as the shell passes it (readSegmentCall verifies it),
// so no shell rewrite changes it after this check.
function onlyPauses(cmdText) {
  const v = bashMerlinAction.lastString(cmdText, 'batchStatus');
  return typeof v === 'string' && goNormalizeBatchStatus(v) === 'PAUSED';
}

// goNormalizeBatchStatus mirrors autocmo-core normalizeBatchStatus
// (meta_batch_status.go, used by meta- and snapchat-batch-status):
// strings.ToUpper(strings.TrimSpace(s)). TrimSpace trims unicode.IsSpace
// runes (not U+FEFF, which String.prototype.trim also strips), and ToUpper
// is the simple per-rune mapping, so a JS mapping that expands one rune into
// several (as for U+00DF) leaves that rune unchanged, as Go does.
const GO_SPACE = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;
function goNormalizeBatchStatus(s) {
  const runes = Array.from(String(s));
  let a = 0;
  let b = runes.length;
  while (a < b && GO_SPACE.test(runes[a])) a++;
  while (b > a && GO_SPACE.test(runes[b - 1])) b--;
  return runes.slice(a, b).map((ch) => {
    const up = ch.toUpperCase();
    return Array.from(up).length === 1 ? up : ch;
  }).join('');
}

// routeBash -> { route, action, cmdText, reason }, route one of:
//   'safe'             auto-allow (every segment safe, no engine call)
//   'deny-ambiguous'   names its action more than once / undecodable
//   'card-unreadable'  invokes the engine, action could not be read
//   'spend'            BASH_SPEND action: main.js budget card path
//   'destructive'      BASH_CARDED_DESTRUCTIVE action: generic card
//   'other'            falls through to the long tail
// main.js handleToolApproval dispatches on exactly this value.
//
// REGRESSION GUARD (2026-11-20, bash-approval-followup review 3): three
// review rounds each desynced decodeAnsiC's quote / comment lexer from real
// bash, and every desync hid an ANSI-C engine call:
//   cd .claude/tools && : ${x:- # } ; ./$'Merl\x69n.exe' $'\x2d\x2dcmd' $'{"\x61ction":"meta-budget","adId":"1","dailyBudget":900}'
// (the # inside ${..} is not a comment to bash, but the decoder dropped the
// rest of the line's quotes), and
//   ./$\<newline>'Mer\u6cin.exe' ...
// (bash removes backslash-newline before lexing, so this IS $'..'). The
// decision therefore no longer rests on lexing bash right. Backslash-newline
// is removed first (stripLineContinuations, bash's own first step; an
// escaped backslash before the newline is kept), then routeBash reads the
// command two ways and keeps the most restrictive result:
//   1. the context-aware decode (decodeAnsiC),
//   2. a CONTEXT-FREE worst case (worstCaseAnsiC): every $' anywhere,
//      whatever quote, comment, here-doc or expansion it sits in, decoded
//      with full bash ANSI-C rules and substituted.
// Reading 2 can only ADD a card, never remove one or downgrade a card to
// 'safe' / 'other'. If reading 2 shows an engine call or engine signal
// reading 1 does not, the command cards (as reading 2's spend / destructive
// action when it parses cleanly to one, otherwise unreadable). Two carded
// readings that disagree on the action card as unreadable.
// If any naive $' body cannot be decoded exactly and the text carries an
// engine signal in either reading or an unresolvable command word, it cards
// as unreadable. An attacker who desyncs the lexer still meets reading 3.
// Mirrored in .claude/hooks/block-api-bypass.js; pinned by
// bash-ansi-c-worst-case.test.js.

// stripLineContinuations: remove backslash-newline (and backslash-CRLF)
// where the backslash is not itself escaped (an odd run of backslashes), as
// bash does before tokenising. `a\\<newline>b` keeps its newline.
function stripLineContinuations(command) {
  const s = String(command || '');
  if (!s.includes('\\')) return s;
  // A linear scan, not /(\\+)\r?\n/: that regex is quadratic on a long
  // backslash run with no newline.
  let out = '';
  let from = 0;
  for (let nl = s.indexOf('\n'); nl >= 0; nl = s.indexOf('\n', nl + 1)) {
    let p = nl - 1;
    if (p >= 0 && s[p] === '\r') p--;
    let b = 0;
    while (p - b >= 0 && s[p - b] === '\\') b++;
    if (b % 2 === 1) { out += s.slice(from, p); from = nl + 1; }
  }
  return out + s.slice(from);
}

// worstCaseAnsiC -> { text, failed }: every $' in the text, with no quote,
// comment, here-doc or expansion context at all, has its body (up to the next
// unescaped ') decoded and substituted as a single-quoted word. failed is
// true when any such body cannot be decoded exactly (unterminated, NUL, a byte
// >= 0x80, an escape with no digits); that body is left as written.
function worstCaseAnsiC(command) {
  const s = String(command || '');
  let out = '';
  let from = 0;
  let failed = false;
  for (let k = s.indexOf("$'"); k >= 0; k = s.indexOf("$'", k)) {
    const d = decodeAnsiCBody(s, k + 2);
    if (!d) { failed = true; k += 2; continue; }
    out += s.slice(from, k) + "'" + d.value.replace(/'/g, "'\\''") + "'";
    from = d.end;
    k = d.end;
  }
  return { text: out + s.slice(from), failed };
}

const ROUTE_RANK = Object.freeze({
  safe: 0, other: 1, spend: 2, destructive: 2, 'card-unreadable': 3, 'deny-ambiguous': 4,
});
const CARDED_ROUTES = new Set(['spend', 'destructive', 'card-unreadable', 'deny-ambiguous']);

function unreadableRoute(command) {
  return { route: 'card-unreadable', action: '', cmdText: String(command || ''), reason: 'shell' };
}

// stricter(base, extra, raw): extra may only escalate base to a carded route.
// Two different carded readings (another action, or spend vs destructive)
// card as unreadable: the readings disagree on what runs.
function stricter(base, extra, raw) {
  if (!CARDED_ROUTES.has(extra.route)) return base;
  const rb = ROUTE_RANK[base.route];
  const re = ROUTE_RANK[extra.route];
  if (re > rb) return extra;
  if (re < rb) return base;
  if (re === 2 && (base.route !== extra.route || base.action !== extra.action)) return unreadableRoute(raw);
  return base;
}

function engineSignals(text) {
  return {
    invocation: isEngineInvocation(text),
    hidden: hiddenEngineCall(text),
    signal: engineSignal(text),
    carded: carriesCardedAction(text),
    dir: ENGINE_DIR_RE.test(text),
  };
}

function anyUnresolvableCommandWord(text) {
  return splitSegments(text).segments.some((seg) => {
    const words = shellWords(seg);
    return wordUnresolvable(words[commandWordIndex(words)] || '');
  });
}

function routeBash(command) {
  const raw = String(command || '');
  const norm = stripLineContinuations(raw);
  const ctx = decodeAnsiC(norm);
  if (ctx.failed) return unreadableRoute(raw);
  const worst = worstCaseAnsiC(norm);

  let out = routeDecodedBash(ctx.text);
  if (worst.text === ctx.text && !worst.failed) return out;

  const worstRoute = worst.text === ctx.text ? out : routeDecodedBash(worst.text);
  out = stricter(out, worstRoute, raw);
  const sCtx = engineSignals(ctx.text);
  const sWorst = worst.text === ctx.text ? sCtx : engineSignals(worst.text);
  if (Object.keys(sWorst).some((k) => sWorst[k] && !sCtx[k]) && !CARDED_ROUTES.has(out.route)) {
    out = unreadableRoute(raw);
  }
  if (worst.failed) {
    const sig = (s) => s.invocation || s.hidden || s.signal || s.carded;
    if (sig(sCtx) || sig(sWorst) || anyUnresolvableCommandWord(ctx.text) || anyUnresolvableCommandWord(worst.text)) {
      out = stricter(out, unreadableRoute(raw), raw);
    }
  }
  return out;
}

function routeDecodedBash(command) {
  if (isSafeBash(command)) return { route: 'safe', action: '', cmdText: String(command || ''), reason: '' };
  const c = classifyEngineCall(command);
  const out = { action: c.action, cmdText: c.cmdText, reason: c.reason };
  if (c.kind === 'ambiguous') return { route: 'deny-ambiguous', ...out };
  if (c.kind === 'unreadable') return { route: 'card-unreadable', ...out };
  if (c.kind === 'action' && BASH_PAUSE_ONLY_STATUS.has(c.action) && c.engine && onlyPauses(c.cmdText)) {
    return { route: 'other', ...out };
  }
  if (c.kind === 'action' && BASH_SPEND.has(c.action)) return { route: 'spend', ...out };
  if (c.kind === 'action' && BASH_CARDED_DESTRUCTIVE.has(c.action)) return { route: 'destructive', ...out };
  return { route: 'other', ...out };
}

// ── Other shell tools ─────────────────────────────────────────────────
//
// REGRESSION GUARD (2026-11-20, bash-approval-followup): every tier in
// handleToolApproval keyed on toolName === 'Bash'. The Agent SDK also ships
// a PowerShell tool (on by default on Windows unless
// CLAUDE_CODE_USE_POWERSHELL_TOOL is falsy) and a Monitor tool that runs a
// shell command in the background. Both reached the long tail, which
// auto-allows in auto mode, and the PreToolUse hook matched only "Bash", so
// `& .claude/tools/Merlin.exe --cmd '{"action":"meta-push","approved":true}'`
// from PowerShell ran with no card and no hook. main.js now disables the
// PowerShell tool, and every shell-shaped tool call is routed here:
//   - any tool that is not an MCP tool and carries a string `command` is a
//     shell tool (Bash, Monitor, PowerShell, and any future one), so a new
//     SDK shell tool is gated the day it appears, not after a review;
//   - Bash-syntax tools take routeBash unchanged;
//   - PowerShell syntax is not parsed by routeBash, so it fails closed: a
//     'safe' or 'other' result is kept only when the text carries no engine
//     signal at all (no Merlin name, no cmd flag, no action key in any
//     de-quoted form); otherwise the call cards as an unreadable engine call.
function isShellTool(toolName, input) {
  const name = String(toolName || '');
  if (name === 'Bash' || name === 'PowerShell' || name === 'Monitor') return true;
  if (name.startsWith('mcp__')) return false;
  return !!(input && typeof input.command === 'string');
}

function routeShellTool(toolName, command) {
  const raw = String(command || '');
  const r = routeBash(raw);
  if (String(toolName || '') !== 'PowerShell') return r;
  // PowerShell splices with backtick escapes, + concatenation and $(...)
  // subexpressions, so also test the text with all of those squeezed out.
  const squeezed = raw.replace(/[`'"+()$\s{}]/g, '');
  const psSignal = /merlin/i.test(raw) || /merlin/i.test(squeezed) || /-cmd/i.test(raw.replace(/`/g, '')) || engineSignal(raw);
  if ((r.route === 'safe' || r.route === 'other') && psSignal) {
    return { route: 'card-unreadable', action: '', cmdText: raw, reason: 'shell' };
  }
  return r;
}

// failClosedApproval(fn) -> async (toolName, input, opts) => decision.
// An exception or rejection anywhere in the approval decision denies the
// tool call; it never falls through to the SDK's own handling.
function failClosedApproval(fn, onError) {
  return async function approvalFailClosed(toolName, input, opts) {
    try {
      const d = await fn(toolName, input, opts);
      if (d && (d.behavior === 'allow' || d.behavior === 'deny')) return d;
      throw new Error('approval returned no decision');
    } catch (e) {
      try { if (onError) onError(e, toolName); } catch {}
      return { behavior: 'deny', message: 'Merlin could not check this action safely, so it was blocked. Try again.' };
    }
  };
}

// ── Spend card object id (Bash path) ───────────────────────────────────
//
// REGRESSION GUARD (2026-11-20, bash-approval-followup): the Bash spend card
// showed the platform and the amount but not WHICH object the engine would
// change, so a budget card for one ad set read the same as one for another.
// The id is read from the engine JSON exactly as Go binds it (last key wins,
// any case) and rendered by the MCP budget card's own helpers, so the two
// paths sanitize ids identically (control, bidi-override and zero-width
// characters stripped, 64 character cap) and follow the same precedence.
const BUDGET_ACTION_TOOL = Object.freeze({
  'meta-budget': 'meta_ads', 'snapchat-budget': 'snapchat', 'google-ads-budget': 'google_ads',
  'linkedin-budget': 'linkedin_ads', 'openai-ads-budget': 'openai_ads',
});
function engineActionTool(action) {
  const a = String(action || '');
  if (BUDGET_ACTION_TOOL[a]) return BUDGET_ACTION_TOOL[a];
  if (a.startsWith('meta-')) return 'meta_ads';
  if (a.startsWith('snapchat-')) return 'snapchat';
  if (a.startsWith('google-ads-')) return 'google_ads';
  if (a.startsWith('linkedin-')) return 'linkedin_ads';
  if (a.startsWith('openai-ads-')) return 'openai_ads';
  return '';
}

// bashSpendCard -> { label: string|null, target: string }
//   label: the full budget-card label for a budget action (null otherwise),
//   target: 'ad set (123)' style id line for any spend action ('' if none).
function bashSpendCard(action, cmdText) {
  const tool = engineActionTool(action);
  const input = {
    targetAdSetId: bashMerlinAction.lastString(cmdText, 'targetAdSetId'),
    campaignId: bashMerlinAction.lastString(cmdText, 'campaignId'),
    adId: bashMerlinAction.lastString(cmdText, 'adId'),
    dailyBudget: bashMerlinAction.lastNumber(cmdText, 'dailyBudget'),
  };
  const target = approvalPolicy.budgetCardTarget(tool, input);
  const label = BUDGET_ACTION_TOOL[action] ? approvalPolicy.budgetChangeCard(tool, input).label : null;
  return { label, target };
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
  BASH_PAUSE_ONLY_STATUS,
  ENGINE_GATED_EXEMPT,
  SAFE_BASH_PATTERNS,
  splitSegments,
  shellWords,
  isEngineInvocation,
  isSafeBash,
  classifyEngineCall,
  hiddenEngineCall,
  decodeAnsiC,
  stripLineContinuations,
  worstCaseAnsiC,
  routeBash,
  isShellTool,
  routeShellTool,
  failClosedApproval,
  unreadableEngineCard,
  bashSpendCard,
};
