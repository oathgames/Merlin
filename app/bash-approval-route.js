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

// REGRESSION GUARD (2026-11-20, bash-approval-followup review 6): the
// text-only exemption trusted git and sed by name, and both run programs
// (verified in real bash with a fake engine, routed 'other', hook exit 0):
//   git -c alias.x='!./.claude/tools/Merl""in.exe --c""md' x '{"action":"meta-budget","adId":"1","dailyBudget":900}'
//   sed 's/.*\/*/.\/.claude\/tools\/Merl""in.exe --c""md &/eg' <<< "'{...meta-budget...}'"
// Denylisting exec flags per program is leaky, so the exemption has two
// tiers:
//   TIER 1 (strongEngineSignal): the binary name (merlin.exe), a cmd flag, or
//     an engine directory in ANY reading (raw, de-quoted, erased, decoded,
//     assignment-substituted). The command cards as unreadable unless every
//     program is in INERT_COMMANDS (cannot run another program under any
//     flag) or is the literal engine binary the router reads directly, AND
//     no segment assigns a variable, writes a file by redirection (a file
//     that later runs: .bashrc, .git/hooks, s.sh), passes a cmd flag WORD to
//     an inert program (a same-named copy of the engine earlier on PATH), or
//     uses printf -v / test -v / [ -v (bash evaluates an array subscript
//     there, running $(..) inside it: verified). Applied in routeBash, so it
//     also overrides a 'safe' route. Not inert, on purpose: git, sed, awk,
//     find, xargs, env, less, man, tee, rg (--pre), sort
//     (--compress-program), cp / mv / ln (stage the engine under an inert
//     name).
//   TIER 2 (textOnlyProgram, rules (b) and splicedEngineSignal): only an
//     "action" key or a carded action name, no strong signal. The broader
//     text-only set keeps the exemption, but git only for an allowlisted
//     subcommand with no exec-capable option, sed only for a single simple
//     s / p / d script, rg / ag / ack without their program options, and
//     nothing at all when the command assigns PATH, GIT_*, a pager, an
//     editor, BASH_ENV or similar.
// Both tiers only add cards. Pinned by bash-hidden-engine.test.js.
const INERT_COMMANDS = new Set([
  'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'ls', 'dir', 'grep', 'egrep', 'fgrep',
  'findstr', 'pwd', 'true', 'test', '[', 'basename', 'dirname', 'uniq', 'cut', 'tr',
  // No-exec file utilities that cannot stage the engine under another name.
  // chmod is NOT here (review 7): `chmod +x merlin` arms a staged wrapper.
  'cd', 'mkdir', 'touch', 'stat', 'du', 'which', 'realpath', 'readlink',
  'sha256sum', 'shasum', 'md5sum',
]);
const STRONG_DIR_RE = /(?:^|[\s\\/"'`=(;&|<>])\.claude[\\/]tools(?=$|[\\/\s;&|)"'`<>])|merlin[\\/]bin(?=$|[\\/\s;&|)"'`<>])/i;

function strongEngineSignal(raw) {
  const texts = new Set(dequotedForms(raw));
  for (const v of new Set([raw, joinAllContinuations(raw)])) {
    texts.add(eraseExpansions(v, false));
    texts.add(eraseExpansions(v, true));
    for (const a of assignmentReadings(v)) { texts.add(a); texts.add(eraseExpansions(a, false)); }
  }
  for (const t of texts) {
    if (/merlin\.exe/i.test(t) || HIDDEN_CMD_FLAG_RE.test(t) || STRONG_DIR_RE.test(t)) return true;
  }
  return false;
}

// A redirection that writes a file (not /dev/null or an fd duplicate).
//
// REGRESSION GUARD (2026-11-20, bash-approval-followup review 7): every `>&`
// was read as an fd duplicate, but bash writes stdout and stderr to FILE
// `word` for `>&word` / `>& word` unless word is all digits or `-`. So
//   echo 'xargs -0 ./.claude/tools/Merlin.exe --cmd' >&merlin; chmod +x merlin; printf %s '{...meta-budgeX...}' | tr X t | ./merlin
// staged a wrapper with no write seen and ran meta-budget uncarded (verified
// in real bash). Forms read here, all outside quotes: `>`, `>>`, `>|`, `N>`,
// `{fd}>`, `&>`, `&>>`, `<>` always name a file (only /dev/null, /dev/stdout,
// /dev/stderr, /dev/fd/N, /dev/tty and nul do not count); `>&word` and
// `N>&word` are a duplicate only when the de-quoted word is digits, `-` or
// digits followed by `-`; anything else, an expansion, or a missing word is
// a write. tee, dd, cp, mv, ln and install are not inert programs at all.
const NON_FILE_TARGET_RE = /^(?:\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)|nul)$/i;
function redirectTarget(s, j) {
  while (s[j] === ' ' || s[j] === '\t') j++;
  let word = '';
  let q = '';
  let expands = false;
  for (; j < s.length; j++) {
    const c = s[j];
    if (q === "'") { if (c === "'") q = ''; else word += c; continue; }
    if (q === '"') {
      if (c === '"') { q = ''; continue; }
      if (c === '$' || c === '`') expands = true;
      if (c === '\\' && j + 1 < s.length) { word += s[++j]; continue; }
      word += c;
      continue;
    }
    if (c === '\\') { if (j + 1 < s.length) word += s[++j]; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (/[\s;&|()<>]/.test(c)) break;
    if (/[$`*?[{]/.test(c)) expands = true;
    word += c;
  }
  return { word, expands, end: j };
}
function segmentWritesFile(segment) {
  const s = String(segment || '');
  let state = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (state === "'") { if (c === "'") state = ''; continue; }
    if (c === '\\') { i++; continue; }
    if (state === '"') { if (c === '"') state = ''; continue; }
    if (c === "'" || c === '"') { state = c; continue; }
    let j;
    let dup = false;
    if (c === '<' && s[i + 1] === '>') j = i + 2;
    else if (c === '&' && s[i + 1] === '>') j = s[i + 2] === '>' ? i + 3 : i + 2;
    else if (c === '>') {
      j = i + 1;
      if (s[j] === '&') { dup = true; j++; } else if (s[j] === '>' || s[j] === '|') j++;
    } else continue;
    const t = redirectTarget(s, j);
    i = Math.max(i, t.end - 1);
    if (t.expands || !t.word) return true;
    if (dup && /^(?:\d+-?|-)$/.test(t.word)) continue;
    if (NON_FILE_TARGET_RE.test(t.word)) continue;
    return true;
  }
  return false;
}

// ── Literal engine calls (review 7) ────────────────────────────────────
//
// REGRESSION GUARD (2026-11-20, bash-approval-followup review 7): TIER 1
// trusted ANY command word whose basename is merlin / merlin.exe as "the
// literal engine call", so a wrapper staged under that name (the >&merlin
// reproducer above) ran a budget change with no card. A segment is the
// literal engine call only when literalEngineSegment says so: no variable
// prefix, the command word is the engine name, readSegmentCall reads the
// --cmd value exactly as the shell passes it, and that value parses to one
// action (it then routes by that action: spend actions card). A version /
// help probe (every argument is --version / --help / -h) also counts. An
// engine-named command word with the payload on stdin, in a file, in a
// variable or absent is NOT a literal call: in a command with a strong
// signal it cards as unreadable.
//
// The hidden-engine readings (strongSignalUngated, splicedEngineSignal,
// shellCodeBuiltAtRunTime) are computed on the command with each literal
// engine segment's command word replaced by the inert word `echo` and its
// --cmd flag and value removed, every other argument kept (review 8,
// withoutLiteralEngineCalls), so the engine path and flag in
// `.claude/tools/Merlin.exe --cmd '{"action":"dashboard"}' | jq .` no longer
// count against jq; the literal segment routes by its own action and the
// most restrictive result wins. The replacement is refused (the command is
// read whole, as before) whenever another lexer could place the segment
// boundaries differently: any $' , #-comment quote stripping, backslash
// continuation, CR, here-doc, backtick, $( or <( / >( substitution, an
// unbalanced quote, or segment spans that do not reproduce splitSegments.
//
// REGRESSION GUARD (2026-11-20, bash-approval-followup review 8): the swap
// replaced the WHOLE literal segment, so attacker text in its OTHER
// arguments vanished from every hidden-engine reading. The engine echoes its
// --config path in an error, so (verified in real bash, routed 'other')
//   ./.claude/tools/Merlin.exe --config 'x; printf %s "{\"action\":\"meta-budgeX\",...}" | tr X t | xargs -0 ./.claude/tools/Merlin.exe --cmd; #' --cmd '{"action":"dashboard"}' 2>&1 | sh
// ran meta-budget uncarded. Now (literalEngineCall):
//   - only the command word (-> echo) and the --cmd flag and its value are
//     neutralised; every other argument, redirect target and operator stays
//     in the text the hidden-engine readings see;
//   - trust is refused (the segment is not a literal call, so it cards under
//     a strong signal) when any other argument carries a strong signal, an
//     "action" key, a carded action name, a binary-name signal, or a shell
//     metacharacter ; | & $ ` ( ) < > or a newline in its value. Exceptions:
//     a --config value that is a plain path ([A-Za-z0-9 / \ : . _ - ~ space],
//     no cmd flag, no binary name, no carded action name) may name the engine
//     directory (.claude/tools/merlin-config.json is normal) and is reduced
//     to an inert placeholder when it does; a --brand value must be a simple
//     slug. $VAR forms never reach here (segmentShellRewrites), as on main;
//   - a --cmd JSON value with a strong signal (binary name, cmd flag, engine
//     directory) anywhere in it is not trusted either;
//   - a call without --cmd is trusted only when every argument is a probe
//     flag (--version, --help, -h, --setup: main.go flags that run no JSON
//     command), nothing is piped into it and it reads no < / << input.
// Engine output fed to anything that executes it is a separate rule
// (engineOutputExecuted). Pinned by bash-literal-engine-args.test.js.
// main.go: --version prints and exits; Go's flag package answers -h / -help
// itself; --setup prints setup instructions and reads no command.
const VERSION_PROBE_ARGS = new Set(['--version', '-version', '--help', '-help', '-h', '--setup', '-setup']);
const LITERAL_CONFIG_PATH_RE = /^[A-Za-z0-9/\\:._~ -]+$/;
const LITERAL_BRAND_SLUG_RE = /^[A-Za-z0-9._-]+$/;
const LITERAL_ARG_META_RE = /[;|&$`()<>\n\r]/;
let cardedActionNames = null;
function namesCardedAction(v) {
  if (!cardedActionNames) cardedActionNames = [...BASH_SPEND, ...BASH_CARDED_DESTRUCTIVE].map((n) => n.toLowerCase());
  const l = String(v || '').toLowerCase();
  return cardedActionNames.some((n) => l.includes(n));
}
function literalArgSignal(v) {
  return LITERAL_ARG_META_RE.test(v) || namesCardedAction(v) || strongEngineSignal(v) || engineSignal(v);
}
function literalConfigPathOk(v) {
  return LITERAL_CONFIG_PATH_RE.test(v) && !HIDDEN_CMD_FLAG_RE.test(v) && !/merlin\.exe/i.test(v) &&
    !HIDDEN_BIN_RE.test(v) && !namesCardedAction(v);
}

// segmentTokens -> [{ start, end, value, op }]: the words of one segment with
// their offsets, de-quoted the way shellWords de-quotes them, and every
// unquoted redirect operator (optional fd number or {name}, then < > <> >>
// >| &> &>> << <<< <& >& with an fd-duplicate target) as its own op token.
const REDIRECT_OP_RE = /(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:&>>?|<<<|<<-?|<>|[<>]&(?:\d+-?|-)?|>>|>\||<|>)/y;
function segmentTokens(seg) {
  const s = String(seg || '');
  const toks = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    const start = i;
    REDIRECT_OP_RE.lastIndex = i;
    const m = REDIRECT_OP_RE.exec(s);
    if (m) { i += m[0].length; toks.push({ start, end: i, value: m[0], op: true }); continue; }
    let val = '';
    let q = '';
    for (; i < s.length; i++) {
      const c = s[i];
      if (q === "'") { if (c === "'") q = ''; else val += c; continue; }
      if (q === '"') {
        if (c === '\\' && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1])) { if (s[i + 1] !== '\n') val += s[i + 1]; i++; continue; }
        if (c === '"') q = ''; else val += c;
        continue;
      }
      if (c === '\\') { if (s[i + 1] === '\n') { i++; continue; } if (i + 1 < s.length) { val += s[i + 1]; i++; } continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (/\s/.test(c) || c === '<' || c === '>' || c === '&') break;
      val += c;
    }
    if (i === start) { i++; toks.push({ start, end: i, value: s[start], op: true }); continue; }
    toks.push({ start, end: i, value: val, op: false });
  }
  return toks;
}

// literalEngineCall -> null | { text }: text is the segment with the command
// word replaced by `echo` and the --cmd flag and value removed (see above).
// pipedIn: true when the segment may read a pipe (unknown counts as true).
function literalEngineCall(seg, raw, pipedIn) {
  if (segmentShellRewrites(seg)) return null;
  const words = shellWords(seg);
  if (!words.length || commandWordIndex(words) !== 0 || !ENGINE_BIN_RE.test(baseName(words[0]))) return null;
  const call = readSegmentCall(seg, raw);
  if (call.unreadable) return null;
  if (call.cmdText !== null) {
    const parsed = bashMerlinAction.parseAction(call.cmdText);
    if (parsed.ambiguous || !parsed.action || strongEngineSignal(call.cmdText)) return null;
  }
  const toks = segmentTokens(seg);
  if (!toks.length || toks[0].op || toks[0].value !== words[0]) return null;
  // Go's usage text echoes argv[0]: the command word must be a plain path.
  if (!LITERAL_CONFIG_PATH_RE.test(words[0])) return null;
  const edits = [{ start: toks[0].start, end: toks[0].end, text: 'echo' }];
  let cmdFlags = 0;
  let probeOnly = true;
  for (let k = 1; k < toks.length; k++) {
    const t = toks[k];
    if (t.op) {
      // Input redirection could carry a payload; output and fd duplicates
      // are fine (the target word is checked as an argument below).
      if (t.value.includes('<')) { if (call.cmdText === null) return null; }
      continue;
    }
    const v = t.value;
    const cm = /^--?cmd(-file)?(?:=([\s\S]*))?$/i.exec(v);
    if (cm) {
      if (cm[1] || ++cmdFlags > 1) return null;
      if (cm[2] !== undefined) {
        if (cm[2] !== call.cmdText) return null;
        edits.push({ start: t.start, end: t.end, text: '' });
      } else {
        const next = toks[k + 1];
        if (!next || next.op || next.value !== call.cmdText) return null;
        edits.push({ start: t.start, end: next.end, text: '' });
        k++;
      }
      probeOnly = false;
      continue;
    }
    const fm = /^(--?(?:config|brand))(?:=([\s\S]*))?$/i.exec(v);
    if (fm) {
      probeOnly = false;
      let val = fm[2];
      let valTok = null;
      if (val === undefined) {
        valTok = toks[k + 1];
        if (!valTok || valTok.op) return null;
        val = valTok.value;
        k++;
      }
      if (/brand/i.test(fm[1])) {
        if (!LITERAL_BRAND_SLUG_RE.test(val) || literalArgSignal(val)) return null;
        continue;
      }
      if (!literalConfigPathOk(val)) return null;
      if (strongEngineSignal(val)) {
        const tok = valTok || t;
        edits.push({ start: tok.start, end: tok.end, text: valTok ? 'cfg.json' : `${fm[1]}=cfg.json` });
      }
      continue;
    }
    if (literalArgSignal(v)) return null;
    // A redirect target follows an op token; anything else must be a probe
    // flag for a call with no --cmd.
    const prev = toks[k - 1];
    const isTarget = prev && prev.op && !/[\d-]$/.test(prev.value);
    if (!isTarget && !VERSION_PROBE_ARGS.has(v.toLowerCase())) probeOnly = false;
  }
  if (call.cmdText === null) {
    if (pipedIn !== false || !probeOnly) return null;
    if (!toks.slice(1).some((t) => !t.op && VERSION_PROBE_ARGS.has(t.value.toLowerCase()))) return null;
  }
  let text = seg;
  for (const e of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return { text };
}
function literalEngineSegment(seg, raw, pipedIn) {
  return literalEngineCall(seg, raw, pipedIn) !== null;
}

// pipedInFlags(raw, spans) -> boolean[]: whether each segment may read a
// pipe (a single | in the text between it and the previous segment).
function pipedInFlags(raw, spans) {
  return spans.map((sp, k) => k > 0 && /(?:^|[^|])\|(?!\|)/.test(raw.slice(spans[k - 1].end, sp.start)));
}

// segmentSpans -> [{ start, end }] | null: where each splitSegments segment
// sits in the text, by the same lexing. null when it cannot be mapped.
function segmentSpans(command) {
  const s = String(command || '');
  const spans = [];
  let start = -1;
  let last = -1;
  let state = '';
  const add = (i, n) => { if (start < 0 && /\S/.test(s[i])) start = i; if (start >= 0) last = i + n - 1; };
  const push = () => { if (start >= 0) spans.push({ start, end: last + 1 }); start = -1; last = -1; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (state === "'") { add(i, 1); if (c === "'") state = ''; continue; }
    if (c === '\\') { add(i, i + 1 < s.length ? 2 : 1); i++; continue; }
    if (c === '`' || (c === '$' && s[i + 1] === '(')) return null;
    if (state === '"') { add(i, 1); if (c === '"') state = ''; continue; }
    if (c === "'" || c === '"') { state = c; add(i, 1); continue; }
    if ((c === '<' || c === '>') && s[i + 1] === '(') return null;
    if (c === '&') {
      const prev = s[i - 1];
      if (prev === '>' || prev === '<' || s[i + 1] === '>') { add(i, 1); continue; }
      push(); continue;
    }
    if (c === ';' || c === '|' || c === '\n' || c === '\r' || c === '(' || c === ')') { push(); continue; }
    add(i, 1);
  }
  if (state !== '') return null;
  push();
  return spans;
}

function withoutLiteralEngineCalls(command) {
  const raw = String(command || '');
  if (/\$'|\\\r?\n|\r|<<|`|\$\(|[<>]\(/.test(raw)) return raw;
  const dec = decodeAnsiC(raw);
  if (dec.failed || dec.text !== raw) return raw;
  const { segments, substitution, unbalanced } = splitSegments(raw);
  if (substitution || unbalanced) return raw;
  const spans = segmentSpans(raw);
  if (!spans || spans.length !== segments.length) return raw;
  if (spans.some((sp, k) => raw.slice(sp.start, sp.end).trim() !== segments[k])) return raw;
  const piped = pipedInFlags(raw, spans);
  let out = raw;
  for (let k = spans.length - 1; k >= 0; k--) {
    const lit = literalEngineCall(segments[k], raw, piped[k]);
    if (!lit) continue;
    // spans[k] starts at the segment's first character (segmentSpans).
    out = out.slice(0, spans[k].start) + lit.text + out.slice(spans[k].start + segments[k].length);
  }
  return out;
}

// Per-segment pipe flags for the raw text, or null when its spans do not
// reproduce splitSegments (callers then treat every segment as piped).
function rawPipedIn(raw) {
  const spans = segmentSpans(raw);
  const { segments } = splitSegments(raw);
  if (!spans || spans.length !== segments.length) return null;
  if (spans.some((sp, k) => raw.slice(sp.start, sp.end).trim() !== segments[k])) return null;
  return pipedInFlags(raw, spans);
}

function inertBase(word) {
  return baseName(word).replace(/\.exe$/, '');
}

// tier1Exempt: every program can be read as text only (see TIER 1 above).
function tier1Exempt(raw) {
  const piped = rawPipedIn(raw);
  for (const v of new Set([raw, joinAllContinuations(raw)])) {
    const segs = splitSegments(v).segments;
    for (let k = 0; k < segs.length; k++) {
      const seg = segs[k];
      const words = shellWords(seg);
      const ci = commandWordIndex(words);
      if (ci > 0) return false;
      const w = words[0] || '';
      if (!w || wordUnresolvable(w)) return false;
      // Only a fully read literal call (review 7); any other engine-named
      // command word is a program whose input cannot be read.
      if (ENGINE_BIN_RE.test(baseName(w))) {
        if (v === raw && literalEngineSegment(seg, raw, piped ? piped[k] : true)) continue;
        return false;
      }
      if (/[\\/]/.test(w) || !INERT_COMMANDS.has(inertBase(w))) return false;
      const args = words.slice(1);
      if (args.some((a) => CMD_FLAG_WORD_RE.test(a))) return false;
      if (['printf', 'test', '['].includes(inertBase(w)) && args.some((a) => /^-[vR]/.test(a))) return false;
      if (segmentWritesFile(seg)) return false;
    }
  }
  return true;
}

function strongSignalUngated(command) {
  const raw = String(command || '');
  return strongEngineSignal(raw) && !tier1Exempt(raw);
}

// TIER 2 helpers.
const DANGEROUS_ENV_ASSIGN_RE = /(?:^|[^\w$])(?:PATH|PATHEXT|BASH_ENV|ENV|PAGER|MANPAGER|EDITOR|VISUAL|PS4|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|RIPGREP_CONFIG_PATH|ACK_OPTIONS|ACKRC|ACK_PAGER\w*|GIT_\w*|LESS\w*|LD_\w+|DYLD_\w+|BASH_FUNC_[^\s=]*)\+?=/;
const GIT_TEXT_SUBCOMMANDS = new Set([
  'commit', 'log', 'show', 'diff', 'status', 'add', 'branch', 'checkout', 'switch', 'restore',
  'stash', 'tag', 'rev-parse', 'grep', 'blame', 'ls-files', 'merge-base', 'fetch', 'pull', 'push', 'remote',
]);
const GIT_SAFE_GLOBAL = new Set([
  '--no-pager', '--bare', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs',
  '--icase-pathspecs', '--no-optional-locks', '--no-replace-objects', '--no-lazy-fetch', '--no-advice',
]);
// git accepts any unambiguous prefix of a long option (--upload-p, --open).
const GIT_EXEC_LONG = ['upload-pack', 'receive-pack', 'exec', 'open-files-in-pager', 'ext-diff', 'textconv'];
function gitTextOnly(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C' || /^--(?:git-dir|work-tree|namespace)$/.test(a)) { i += 2; continue; }
    if (/^--(?:git-dir|work-tree|namespace)=/.test(a) || GIT_SAFE_GLOBAL.has(a)) { i++; continue; }
    return false; // -c, --config-env, --exec-path, -p / --paginate, anything unknown
  }
  const sub = args[i];
  if (!GIT_TEXT_SUBCOMMANDS.has(sub)) return false;
  for (const w of args.slice(i + 1)) {
    if (w === '--') break;
    const long = /^--([^=]+)/.exec(w);
    if (long && GIT_EXEC_LONG.some((d) => d.startsWith(long[1]) && long[1].length >= 2 || long[1].startsWith(d))) return false;
    if (sub === 'grep' && /^-[^-]*O/.test(w)) return false;
  }
  return true;
}
const SED_ADDR1 = String.raw`(?:\d+|\$|/(?:\\.|[^/\\\n])*/I?)`;
const SED_ADDR = `${SED_ADDR1}(?:,${SED_ADDR1})?`;
const SED_SIMPLE_S_RE = new RegExp(String.raw`^\s*(?:${SED_ADDR})?s([^\w\s\\])((?:\\.|(?!\1)[^\\\n])*)\1((?:\\.|(?!\1)[^\\\n])*)\1[gpiI0-9]*\s*$`);
const SED_SIMPLE_PD_RE = new RegExp(String.raw`^\s*${SED_ADDR}[pd]\s*$`);
function sedTextOnly(args) {
  const scripts = [];
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { operands.push(...args.slice(i + 1)); break; }
    if (a === '-e' || a === '--expression') { if (i + 1 >= args.length) return false; scripts.push(args[++i]); continue; }
    if (a.startsWith('--expression=')) { scripts.push(a.slice(13)); continue; }
    if (/^-e./.test(a)) { scripts.push(a.slice(2)); continue; }
    if (/^-[nErsuz]+$/.test(a) || /^--(?:quiet|silent|regexp-extended|separate|unbuffered|null-data|posix|sandbox)$/.test(a)) continue;
    if (/^-[nErsuz]*i/.test(a) || /^--in-place(?:=|$)/.test(a)) continue;
    if (a.startsWith('-') && a !== '-') return false; // -f, --file, -l, anything unknown
    operands.push(a);
  }
  if (!scripts.length) {
    if (!operands.length) return false;
    scripts.push(operands[0]);
  }
  return scripts.every((s) => SED_SIMPLE_S_RE.test(s) || SED_SIMPLE_PD_RE.test(s));
}

function textOnlyProgram(word, segment, raw) {
  if (DANGEROUS_ENV_ASSIGN_RE.test(String(raw === undefined ? segment : raw))) return false;
  const words = shellWords(segment);
  const args = words.slice(commandWordIndex(words) + 1);
  const base = inertBase(word);
  if (base === 'sed') return sedTextOnly(args) && !SED_EXEC_RE.test(args.join(' '));
  if (base === 'git') return gitTextOnly(args);
  if (base === 'rg' && args.some((a) => /^--(?:pre|pre-glob|hostname-bin)(?:=|$)/.test(a))) return false;
  // ack (Getopt::Long) and ag (getopt_long) accept any unambiguous prefix of
  // a long option (--pag=x is --pager=x), so match prefixes, as for git.
  if ((base === 'ag' || base === 'ack') && args.some((a) => {
    const m = /^--([^=]+)/.exec(a);
    return !!m && m[1].length >= 2 && ['pager', 'ackrc', 'output'].some((d) => d.startsWith(m[1].toLowerCase()));
  })) return false;
  if (['printf', 'test', '['].includes(base) && args.some((a) => /^-[vR]/.test(a))) return false;
  return TEXT_ONLY_COMMANDS.has(baseName(word)) || TEXT_ONLY_COMMANDS.has(base);
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
// Review 4: bash's own short and long forms too (\U6c, \u6c, \x6, \55),
// since eval re-lexes a $' the shell assembled from a variable
// (d=\$; eval "$d'./Mer\U6cin.exe'") and bash decodes those forms.
function looseCodePoint(m, h) {
  if (!h) return m;
  const v = parseInt(h, 16);
  return v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff) ? m : String.fromCodePoint(v);
}
function decodeEscapesLoose(text) {
  let s = String(text);
  for (let i = 0; i < 4; i++) {
    s = s
      .replace(/\\+(?:U([0-9A-Fa-f]{1,8}))?/g, looseCodePoint)
      .replace(/\\+(?:u([0-9A-Fa-f]{1,4}))?/g, looseCodePoint)
      .replace(/\\+(?:x([0-9A-Fa-f]{1,2}))?/g, looseCodePoint)
      .replace(/\\+(?:0?([0-7]{1,3}))?/g, (m, o) => (o ? String.fromCharCode(parseInt(o, 8) & 0xff) : m));
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
  const allTextOnly = programs.every((w, i) => w === '' || (!wordUnresolvable(w) && textOnlyProgram(w, segments[i], raw)));
  return !allTextOnly && carriesCardedAction(raw);
}

// REGRESSION GUARD (2026-11-20, bash-approval-followup review 5): every
// signal above reads the text with expansions in place, so splicing an EMPTY
// expansion into each one hid them all (verified in real bash, routed
// 'other', hook exit 0):
//   x=; ./Mer${x}lin.exe --c${x}md '{"act'${x}'ion":"meta-push"}'
// splicedEngineSignal reads the text with every expansion ERASED
// (eraseExpansions): ${..} (nested, any operator), $name, $1, $@ style, and
// every $( .. ) / backtick span deleted whole; quote characters and the
// backslash of a \x escape dropped. A second erased reading keeps the text of
// a substitution body and of a ${x:-word} operand, since either can be the
// literal characters. A third substitutes the right-hand side of each simple
// name=value assignment in the same command (a=Mer; b=lin.exe; ./$a$b), and
// the assignment values concatenated are read too. Any engine signal in one
// of those readings, in a command holding any $ or backtick, cards as
// unreadable unless every program in the command is text-only (echo, grep,
// git, rg, ls ... the rule (b) set), so `grep '"action":"meta-push"' "$F"`
// and `git commit -m "fix meta-push for $BRAND"` stay uncarded. This only
// adds cards. Note: lower-case "merlin" followed by a space or end of text is
// already a binary-name signal (HIDDEN_BIN_RE), so `node "$S" merlin` cards,
// while `echo "$USER uses merlin"` does not (echo is text-only).
// Out of scope: a variable holding real characters that no assignment in the
// same command shows (a value from the environment or a file).
// Pinned by bash-hidden-engine.test.js.
function eraseExpansions(text, keepBodies) {
  const s = String(text || '');
  let out = '';
  let open = 0; // ${ opened in keepBodies mode, whose } is dropped
  const close = (i, o, c) => {
    let depth = 1;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === o) depth++;
      else if (s[j] === c && --depth === 0) return j;
    }
    return s.length;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { if (i + 1 < s.length && s[i + 1] !== '\n') out += s[i + 1]; i++; continue; }
    if (c === "'" || c === '"') continue;
    if (c === '`') {
      if (keepBodies) continue;
      let j = i + 1;
      while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (c === '}' && open > 0) { open--; continue; }
    if (c !== '$') { out += c; continue; }
    const n = s[i + 1];
    if (n === '{') {
      if (!keepBodies) { i = close(i + 2, '{', '}'); continue; }
      const m = /^[!#]?(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])?(?:\[[^\]]*\])?:?[-+=?#%/^,@]*/.exec(s.slice(i + 2, i + 130));
      i += 1 + m[0].length;
      open++;
      continue;
    }
    if (n === '(') {
      if (!keepBodies) i = close(i + 2, '(', ')');
      else i++;
      continue;
    }
    if (/[A-Za-z_]/.test(n || '')) { while (/[A-Za-z0-9_]/.test(s[i + 1] || '')) i++; continue; }
    if (/[0-9@*#?$!-]/.test(n || '')) { i++; continue; }
    if (n === "'" || n === '"') continue;
    out += c;
  }
  return out;
}

const SIMPLE_ASSIGN_RE = /(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"$`\\]*)"|([^\s;&|()'"$`\\<>]*))/g;
function assignmentReadings(raw) {
  const vals = new Map();
  const seq = [];
  for (const m of raw.matchAll(SIMPLE_ASSIGN_RE)) {
    if (seq.length >= 64) break;
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    vals.set(m[1], v);
    seq.push(v);
  }
  if (!seq.length) return [];
  const sub = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (all, a, b) => (vals.has(a || b) ? vals.get(a || b) : all));
  return [sub, seq.join(''), seq.join(' ')];
}

// withoutCdOperands (review 7): `cd DIR` hands DIR to no program, so a weak
// signal in it (the trailing `Merlin` of "$HOME/Merlin", HIDDEN_BIN_RE) is not
// an engine call by another segment. Each segment that is exactly `cd DIR`,
// with no redirection and no strong signal in DIR, is read as a bare `cd` by
// splicedEngineSignal only. Every other reading keeps the operand, and a
// strong signal (engine dir, merlin.exe, cmd flag) is never dropped.
function withoutCdOperands(command) {
  const raw = String(command || '');
  const { segments } = splitSegments(raw);
  const spans = segmentSpans(raw);
  if (!spans || spans.length !== segments.length) return raw;
  let out = raw;
  for (let k = spans.length - 1; k >= 0; k--) {
    const seg = segments[k];
    if (raw.slice(spans[k].start, spans[k].end).trim() !== seg) return raw;
    const words = shellWords(seg);
    if (words.length !== 2 || words[0] !== 'cd' || /[<>]/.test(seg) || strongEngineSignal(seg)) continue;
    out = out.slice(0, spans[k].start) + 'cd' + out.slice(spans[k].end);
  }
  return out;
}

function splicedEngineSignal(command) {
  const raw = String(command || '');
  if (!/[$`]/.test(raw)) return false;
  const { segments } = splitSegments(raw);
  const allTextOnly = segments.every((seg) => {
    const words = shellWords(seg);
    const w = words[commandWordIndex(words)] || '';
    return w === '' || (!wordUnresolvable(w) && textOnlyProgram(w, seg, raw));
  });
  if (allTextOnly) return false;
  const texts = [];
  for (const v of new Set([withoutCdOperands(raw), withoutCdOperands(joinAllContinuations(raw))])) {
    texts.push(eraseExpansions(v, false), eraseExpansions(v, true));
    for (const a of assignmentReadings(v)) texts.push(eraseExpansions(a, false));
  }
  return texts.some((t) => /merlin\.exe/i.test(t) || isEngineInvocation(t) || engineSignal(t) || carriesCardedAction(t));
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

// worstCaseAnsiC(command, start) -> { text, failed }: scanning from index
// start (default 0), every $' in the text, with no quote, comment, here-doc
// or expansion context at all, has its body (up to the next unescaped ')
// decoded and substituted as a single-quoted word. Text before start is kept
// as written. failed is true when any such body cannot be decoded exactly
// (unterminated, NUL, a byte >= 0x80, an escape with no digits); that body is
// left as written.
function worstCaseAnsiC(command, start) {
  const s = String(command || '');
  let out = '';
  let from = 0;
  let failed = false;
  const starts = [];
  for (let k = s.indexOf("$'", start || 0); k >= 0; k = s.indexOf("$'", k)) {
    starts.push(k);
    const d = decodeAnsiCBody(s, k + 2);
    if (!d) { failed = true; k += 2; continue; }
    out += s.slice(from, k) + "'" + d.value.replace(/'/g, "'\\''") + "'";
    from = d.end;
    k = d.end;
  }
  return { text: out + s.slice(from), failed, starts };
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

// REGRESSION GUARD (2026-11-20, bash-approval-followup review 4): two more
// desyncs hid an engine call (routed 'other', hook exit 0):
//   echo hi # note \<newline>: '$' ; eval $'\U2e/Mer\U6cin.exe \U2d\U2d\U63md \x27{...meta-budget...}\x27'
// (1) stripLineContinuations joined the backslash-ended # comment with the
// next line, which bash never does, so line 2 read as comment text; (2)
// worstCaseAnsiC scanned sequentially, so the $' inside '$' opened a body
// that swallowed the real one. Three layers now, all mirrored in the hook:
//   A. ansiCCharCodeBackstop, independent of every lexer and decoder: the
//      text as given, or with every backslash-newline removed, holding $'
//      and a character-code escape (\x \u \U \0-7 \c) anywhere at or after
//      the first $', always cards. Plain $'\n' / $'\t' stay uncarded;
//      printf $'\x41\n' cards, on purpose.
//   B. worstCaseAnsiC runs from EVERY $' alignment (overlapping), on every
//      variant of the text, and every reading is routed; the most
//      restrictive wins. When every reading agrees on a spend / destructive
//      action the card names it; readings that disagree card as unreadable.
//   C. continuations inside a # comment or quotes are not joined
//      (stripLineContinuationsOutsideComments); because that is one more
//      lexer, readings joined by parity, joined everywhere, and (worst case
//      only) not joined at all are also taken.
// Pinned by bash-ansi-c-worst-case.test.js.
const ANSI_C_CHAR_CODE_RE = /\\(?:x[0-9A-Fa-f]|u[0-9A-Fa-f]|U[0-9A-Fa-f]|[0-7]|c[\s\S])/;
const MAX_ANSI_C_STARTS = 8;

// joinAllContinuations: every backslash-newline / backslash-CRLF removed,
// whatever precedes it.
function joinAllContinuations(command) {
  return String(command || '').replace(/\\\r?\n/g, '');
}

function ansiCCharCodeBackstop(command) {
  const raw = String(command || '');
  for (const v of [raw, joinAllContinuations(raw)]) {
    const k = v.indexOf("$'");
    if (k >= 0 && ANSI_C_CHAR_CODE_RE.test(v.slice(k))) return true;
  }
  return false;
}

// stripLineContinuationsOutsideComments: backslash-newline removed only where
// bash removes it: not inside a # comment, '..' or $'..'. Only one more
// reading; a desync here cannot remove a card the other readings give.
function stripLineContinuationsOutsideComments(command) {
  const s = String(command || '');
  if (!s.includes('\\')) return s;
  let out = '';
  let state = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (state === '#') { out += c; if (c === '\n') state = ''; continue; }
    if (state === "'") { out += c; if (c === "'") state = ''; continue; }
    if (state === '$') {
      out += c;
      if (c === '\\' && i + 1 < s.length) { out += s[++i]; continue; }
      if (c === "'") state = '';
      continue;
    }
    if (c === '\\') {
      if (s[i + 1] === '\n') { i++; continue; }
      if (s[i + 1] === '\r' && s[i + 2] === '\n') { i += 2; continue; }
      out += c;
      if (i + 1 < s.length) out += s[++i];
      continue;
    }
    if (state === '"') { out += c; if (c === '"') state = ''; continue; }
    if (c === '#' && (out === '' || /[ \t\n;&|()<>]/.test(out[out.length - 1]))) { state = '#'; out += c; continue; }
    if (c === '$' && s[i + 1] === '$') { out += '$$'; i++; continue; }
    if (c === '$' && s[i + 1] === "'") { state = '$'; out += "$'"; i++; continue; }
    if (c === "'" || c === '"') state = c;
    out += c;
  }
  return out;
}

function routeBash(command) {
  const raw = String(command || '');
  let out = routeAllReadings(raw);
  if (CARDED_ROUTES.has(out.route)) return out;
  // Literal engine segments route by their own action (out); the hidden-engine
  // readings look at everything else (review 7, withoutLiteralEngineCalls).
  const rest = withoutLiteralEngineCalls(raw);
  if (ansiCCharCodeBackstop(raw) || shellCodeBuiltAtRunTime(rest) || splicedEngineSignal(rest) || strongSignalUngated(rest) ||
      chmodWithStrongSignal(raw) || engineOutputExecuted(raw)) out = unreadableRoute(raw);
  return out;
}

// REGRESSION GUARD (2026-11-20, bash-approval-followup review 8): the engine
// echoes argument text (a --config path, an unknown key, a brand or outputDir
// value) in its output and errors, so engine output handed to something that
// runs it as code executes text the router never read as a command:
//   ./.claude/tools/Merlin.exe --config 'x; ...meta-budget...' --cmd '{"action":"dashboard"}' 2>&1 | sh
// also `| bash -s`, `| source /dev/stdin`, `| xargs -0 bash -c`, and
// `> s.sh 2>&1; sh s.sh` (all verified in real bash with a fake engine).
// engineOutputExecuted cards, whatever the engine call is (trusted literal
// or not), when a segment after the first engine segment
//   - reads a pipe and runs its stdin: a shell, source / . / eval / exec, any
//     xargs, a wrapper that runs another program (env, nohup, time, sudo,
//     timeout ...), an interpreter with no script file (python, node, perl,
//     ruby, php, pwsh ... reading stdin, `-`, or -c / -e / -p code), awk with
//     system / getline / a pipe, sed with an exec command, or a program the
//     text cannot resolve;
//   - or, once any segment from the engine on wrote a file (a redirect, tee,
//     dd, cp, mv, ln, install, sponge), runs or sources a file: a shell or
//     script runner, chmod, a wrapper, or a path-named program (./s.sh);
//   - or the command holds a substitution the segment map cannot place
//     (process substitution, $( ), backticks) and any of those programs.
// jq, tee, tail, head, grep, python -m json.tool, node script.js and a plain
// `> out.json` route as on main. Only adds cards. Pinned by
// bash-literal-engine-args.test.js.
const OUTPUT_EXEC_WRAPPERS = new Set([
  'xargs', 'env', 'exec', 'command', 'builtin', 'nohup', 'time', 'sudo', 'doas', 'su', 'runuser', 'stdbuf',
  'timeout', 'nice', 'ionice', 'setsid', 'parallel', 'watch', 'script', 'unbuffer', 'chroot', 'flock',
  'strace', 'ltrace', 'busybox', 'start', 'wsl', 'wsl.exe',
]);
const STDIN_INTERPRETERS = new Set([
  'python', 'python3', 'python2', 'py', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'tclsh',
  'osascript', 'pwsh', 'powershell', 'cmd', 'rscript', 'irb', 'jshell', 'groovy', 'java',
]);
// Programs that run commands read from stdin: a remote or scheduled shell,
// editors and REPLs with a shell escape (ed / ex / vi `!`, sqlite3 .shell,
// psql / mysql \!, gdb shell, m4 syscmd, dc !), and make -f -.
const STDIN_COMMAND_PROGRAMS = new Set([
  'ssh', 'docker', 'podman', 'kubectl', 'at', 'batch', 'crontab', 'dc', 'ed', 'ex', 'vi', 'vim', 'nvim', 'emacs',
  'gdb', 'lldb', 'sqlite3', 'mysql', 'psql', 'expect', 'wish', 'm4', 'make', 'gnuplot', 'r',
]);
const FILE_WRITERS = new Set(['tee', 'dd', 'cp', 'mv', 'ln', 'install', 'sponge', 'rsync', 'scp', 'exec']);
// A file some program runs later without being named as a script.
const EXEC_SENSITIVE_TARGET_RE = /(?:^|[\s\\/>'"=])(?:\.git[\\/](?:hooks|config)|\.(?:bash|zsh|ksh|mksh)rc|\.(?:bash_)?profile|\.zshenv|\.zprofile|\.envrc|\.npmrc|[Mm]akefile|GNUmakefile|package\.json)(?=$|[\s\\/'";&|<>])/;
const STDIN_PATH_RE = /^(?:\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0|-)$/;
// Words that open a compound command; the command after them runs with the
// compound's stdin.
const COMPOUND_WORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'select', 'case', 'esac', 'time', 'coproc']);
function programOf(seg) {
  const words = shellWords(seg);
  let idx = commandWordIndex(words);
  let compound = false;
  while (idx < words.length && COMPOUND_WORDS.has(words[idx])) { idx++; compound = true; }
  idx += commandWordIndex(words.slice(idx));
  return { words, idx, word: words[idx] || '', prog: inertBase(words[idx] || ''), compound };
}
function runsStdinAsCode(seg) {
  const { words, idx, word, prog } = programOf(seg);
  if (!word) return false;
  if (wordUnresolvable(word)) return true;
  if (SHELL_CODE_RUNNERS.has(prog) || ['eval', 'exec'].includes(prog) || OUTPUT_EXEC_WRAPPERS.has(prog) ||
      STDIN_COMMAND_PROGRAMS.has(prog) || SCRIPT_RUNNERS.has(baseName(word)) && !STDIN_INTERPRETERS.has(prog)) return true;
  const args = words.slice(idx + 1);
  if ((STDIN_INTERPRETERS.has(prog) || /^[gnm]?awk$/.test(prog) || prog === 'sed') && args.some((a) => STDIN_PATH_RE.test(a))) return true;
  if (STDIN_INTERPRETERS.has(prog)) {
    // Code from stdin (`-`, no script argument) or from an argument (-c, -e,
    // --eval, -Command, /c) that can read stdin; -m runs a named module.
    if (args.some((a) => /^(?:-|--?(?:eval|print|command|encodedcommand|ec|r)|\/[ck])$/i.test(a) || /^-[A-Za-z]*[ce]$/.test(a))) return true;
    if (args.includes('-m')) return false;
    return !args.some((a) => !a.startsWith('-'));
  }
  if (/^[gnm]?awk$/.test(prog)) return /system|getline|\|/.test(args.join(' '));
  if (prog === 'sed') return SED_EXEC_RE.test(args.join(' '));
  return false;
}
function runsFile(seg) {
  const { word, prog } = programOf(seg);
  if (!word) return false;
  return wordUnresolvable(word) || /[\\/]/.test(word) || prog === 'chmod' || SCRIPT_RUNNERS.has(baseName(word)) ||
    SHELL_CODE_RUNNERS.has(prog) || OUTPUT_EXEC_WRAPPERS.has(prog) || STDIN_INTERPRETERS.has(prog) ||
    STDIN_COMMAND_PROGRAMS.has(prog);
}
function engineOutputExecuted(command) {
  const raw = String(command || '');
  for (const v of new Set([raw, joinAllContinuations(raw)])) {
    const { segments, substitution, unbalanced } = splitSegments(v);
    const first = segments.findIndex((seg) => segmentInvokesEngine(seg, { noNonExecExemption: substitution || unbalanced }));
    if (first < 0) continue;
    const spans = segmentSpans(v);
    const mapped = !substitution && !unbalanced && spans && spans.length === segments.length &&
      spans.every((sp, k) => v.slice(sp.start, sp.end).trim() === segments[k]);
    if (!mapped) {
      // The segment map is unknown: any program that runs code it is handed.
      if (segments.some((seg) => runsStdinAsCode(seg) || ['chmod', ...SHELL_CODE_RUNNERS].includes(programOf(seg).prog))) return true;
      continue;
    }
    const piped = pipedInFlags(v, spans);
    // A write before the engine counts too: `exec 3>s.sh` opens a file the
    // engine's `>&3` then fills.
    let wrote = false;
    let compound = false;
    for (let j = 0; j < segments.length; j++) {
      const seg = segments[j];
      const p = programOf(seg);
      if (j > first) {
        // Inside a group or compound command (or after a subshell paren)
        // every command may read the engine's output.
        compound = compound || p.compound || /[()]/.test(v.slice(spans[j - 1].end, spans[j].start));
        if ((piped[j] || compound) && runsStdinAsCode(seg)) return true;
        if (wrote && runsFile(seg)) return true;
      }
      if (segmentWritesFile(seg) || FILE_WRITERS.has(p.prog)) wrote = true;
      if (j >= first && wrote && EXEC_SENSITIVE_TARGET_RE.test(seg)) return true;
    }
  }
  return false;
}

// chmod anywhere in a command whose WHOLE text carries a strong signal cards
// (review 7): it can arm a file the same command staged, even one written
// from a literal engine call's output.
function chmodWithStrongSignal(raw) {
  if (!/chmod/i.test(raw.replace(/['"\\]/g, ''))) return false;
  const progs = [];
  for (const v of new Set([raw, joinAllContinuations(raw)])) {
    for (const seg of splitSegments(v).segments) {
      const words = shellWords(seg);
      progs.push(inertBase(words[commandWordIndex(words)] || ''));
    }
  }
  return progs.includes('chmod') && strongEngineSignal(raw);
}

// shellCodeBuiltAtRunTime (review 4 self-attack): a program that re-lexes its
// argument as shell code (eval, or a shell given -c) runs text the shell
// assembles first, so no static reading of the command is the code it runs.
// Verified in real bash: d=\$; eval "$d'./Mer\U6cin.exe' ..." runs the
// engine ($d' becomes $' only when eval re-lexes it), and so does
// x=; bash -c "./Mer${x}lin.exe --c${x}md ...". Such a command cards when its
// text carries a character-code escape or a $ / backtick expansion. Any
// shell-code runner with a character-code escape anywhere cards too
// (printf '\x24' | sh). Both raw variants of layer A are read.
const SHELL_CODE_RUNNERS = new Set(['eval', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'busybox', 'source', '.']);
function shellCodeBuiltAtRunTime(command) {
  const raw = String(command || '');
  for (const v of [raw, joinAllContinuations(raw)]) {
    for (const seg of splitSegments(v).segments) {
      const words = shellWords(seg);
      const idx = commandWordIndex(words);
      const prog = baseName(words[idx] || '');
      if (!SHELL_CODE_RUNNERS.has(prog)) continue;
      if (ANSI_C_CHAR_CODE_RE.test(v)) return true;
      const relexes = prog === 'eval' || words.slice(idx + 1).some((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      if (relexes && /\$[A-Za-z_{(0-9@*#?!$-]|`/.test(seg)) return true;
    }
  }
  return false;
}

// routeAllReadings: the most restrictive route across every reading:
// for each joined variant (parity, outside comments, everywhere) the
// context-aware decode and the worst case from every $' alignment, and for
// the unjoined text the worst case from every alignment. The base reading is
// the parity-joined decode; another reading only escalates it (stricter).
// A partial reading (worst case from a later $', or of the unjoined text)
// that sees two actions cards as unreadable rather than denied, since its
// alignment may be wrong. A later $' already decoded as a body start by an
// earlier reading of the same variant gives the same reading from there on
// and is skipped; past MAX_ANSI_C_STARTS alignments in all the text counts
// as undecodable (cards alongside any engine signal; layer A still applies).
function routeAllReadings(raw) {
  const joined = [...new Set([stripLineContinuations(raw), stripLineContinuationsOutsideComments(raw), joinAllContinuations(raw)])];
  const complete = new Set();
  const partial = new Set();
  let failed = false;
  let alignments = 0;
  for (const v of joined.includes(raw) ? joined : [...joined, raw]) {
    const isJoined = joined.includes(v);
    if (isJoined) {
      const ctx = decodeAnsiC(v);
      if (ctx.failed) return unreadableRoute(raw);
      complete.add(ctx.text);
    }
    const covered = new Set();
    let first = true;
    for (let k = v.indexOf("$'"); k >= 0; k = v.indexOf("$'", k + 1)) {
      if (covered.has(k)) continue;
      if (alignments === MAX_ANSI_C_STARTS) { failed = true; break; }
      alignments++;
      const w = worstCaseAnsiC(v, k);
      if (w.failed) failed = true;
      for (const j of w.starts) covered.add(j);
      (first && isJoined ? complete : partial).add(w.text);
      first = false;
    }
  }
  const base = complete.values().next().value;
  complete.delete(base);
  partial.delete(base);
  for (const t of complete) partial.delete(t);

  let out = routeDecodedBash(base);
  if (!complete.size && !partial.size && !failed) return out;

  const sBase = engineSignals(base);
  const sig = (s) => s.invocation || s.hidden || s.signal || s.carded;
  let anySignal = sig(sBase) || anyUnresolvableCommandWord(base);
  const weigh = (t, isPartial) => {
    const r = routeDecodedBash(t);
    out = stricter(out, isPartial && r.route === 'deny-ambiguous' ? unreadableRoute(raw) : r, raw);
    const s = engineSignals(t);
    if (Object.keys(s).some((k) => s[k] && !sBase[k]) && !CARDED_ROUTES.has(out.route)) out = unreadableRoute(raw);
    anySignal = anySignal || sig(s) || anyUnresolvableCommandWord(t);
  };
  for (const t of complete) weigh(t, false);
  for (const t of partial) weigh(t, true);
  if (failed && anySignal) out = stricter(out, unreadableRoute(raw), raw);
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
  joinAllContinuations,
  stripLineContinuationsOutsideComments,
  ansiCCharCodeBackstop,
  eraseExpansions,
  splicedEngineSignal,
  strongSignalUngated,
  sedTextOnly,
  gitTextOnly,
  routeBash,
  isShellTool,
  routeShellTool,
  failClosedApproval,
  unreadableEngineCard,
  bashSpendCard,
};
