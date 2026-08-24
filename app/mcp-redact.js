// Merlin MCP — Output Redaction
//
// Single-purpose module: strip all credentials, tokens, and sensitive
// patterns from binary stdout/stderr BEFORE returning to Claude.
// This is the last line of defense — even if every other layer fails,
// redaction ensures tokens never enter Claude's context window.
//
// Applied to BOTH stdout and stderr. Called from mcp-tools.js on every
// binary invocation result.

'use strict';

// Known token prefixes — platform-specific patterns that are never
// legitimate in sanitized output. Order: most specific first.
const TOKEN_PREFIXES = [
  /\bEAA[A-Za-z0-9]{20,}/g,         // Meta (Facebook) access tokens
  /\bshpat_[A-Za-z0-9]{20,}/g,      // Shopify access tokens
  /\bshpss_[A-Za-z0-9]{20,}/g,      // Shopify shared secrets
  /\bxoxb-[A-Za-z0-9\-]{20,}/g,     // Slack bot tokens
  /\bxoxp-[A-Za-z0-9\-]{20,}/g,     // Slack user tokens
  /\bsk-[A-Za-z0-9]{20,}/g,         // Generic API keys (OpenAI, Anthropic, etc.)
  /\bsk_live_[A-Za-z0-9]{20,}/g,    // Stripe live keys
  /\bsk_test_[A-Za-z0-9]{20,}/g,    // Stripe test keys
  /\bAIza[A-Za-z0-9\-_]{20,}/g,    // Google API keys
  /\bfal-[A-Za-z0-9]{20,}/g,        // fal.ai API keys
  /\bgsk_[A-Za-z0-9]{20,}/g,        // Groq API keys
  /\bwhsec_[A-Za-z0-9]{20,}/g,      // Webhook signing secrets
  /\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, // Discord bot tokens (base64.timestamp.hmac)
  // PARITY WITH THE GO SIDE (2026-08-23). These shapes existed in
  // autocmo-core/main.go's secretPrefixPattern but not here. That asymmetry was
  // survivable while the 32-char catch-all swept everything, but the label-field
  // exemption below relies on the PREFIX list being complete, so any gap here is
  // now a real leak path. Keep the two lists in sync.
  /\bAKIA[0-9A-Z]{12,}/g,  // AWS access key ids
  /\bASIA[0-9A-Z]{12,}/g,  // AWS temporary access key ids
  /\bghp_[A-Za-z0-9]{20,}/g,  // GitHub personal access tokens
  /\bgho_[A-Za-z0-9]{20,}/g,  // GitHub OAuth tokens
  /\bghs_[A-Za-z0-9]{20,}/g,  // GitHub server tokens
  /\bghu_[A-Za-z0-9]{20,}/g,  // GitHub user tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,  // GitHub fine-grained PATs
  /\bxoxa-[A-Za-z0-9\-]{20,}/g,  // Slack app tokens
  /\bxoxs-[A-Za-z0-9\-]{20,}/g,  // Slack session tokens
  /\bxoxr-[A-Za-z0-9\-]{20,}/g,  // Slack refresh tokens
  /\bca_live_[A-Za-z0-9]{16,}/g,  // Stripe Connect live
  /\bca_test_[A-Za-z0-9]{16,}/g,  // Stripe Connect test
];

// REGRESSION GUARD (2026-08-11, audit-audience-rule returned "[REDACTED]"):
// Fields whose values are platform TARGETING CONFIGURATION, not credential
// material. Values in these subtrees are exempt from the opaque-token
// HEURISTIC (isLikelyToken + the long-run sweep) but still get every
// deterministic credential rule: login block, TOKEN_PREFIXES, Bearer, and
// access_token=/token= URL params. Exemption is from guessing, never from
// redacting.
//
// Why this exists: `meta_audit action=audit-audience-rule` exists to answer
// "why is this audience empty / mis-targeted", and the answer lives in the
// rule blob (url / i_contains conditions, event names, retention windows).
// Meta returns that blob as one long JSON string, which tripped
// isLikelyToken (32+ chars, no `/`+`.` pair, not a UUID, not hex) and was
// replaced wholesale with `[REDACTED]` — the action returned nothing but its
// own name. Live case 2026-08-11 (benebone): 17 website-pixel audiences under
// Meta's 1,000-person floor while the pixel was provably healthy (162.9K
// PageViews/28d, Purchase EMQ 8.9/10). The pixel serves 49 domains, so the
// URL filter isolating one brand was the remaining suspect and was the one
// thing unreadable.
//
// Even parsed into an object the blob lost data: the long-run sweep shreds a
// URL at every `.` (LONG_TOKEN_RE's charset has no dot), so
// "https://www.benebone.com/collections/durable-dog-chews" came back as
// "https://www.benebone.[REDACTED]" — the path condition, i.e. the answer.
//
// A Meta audience rule cannot contain a credential: its schema is operators,
// numeric pixel/app ids, retention_seconds, and url/event/parameter filters.
// The other `rule` fields Merlin emits (brand-guide + manifest violations,
// Klaviyo/Mailchimp/Postscript flow checks) are short named-rule identifiers
// like "hex_format" or "ten_dlc_missing" — under the 32-char floor, so
// unaffected either way.
//
// Test coverage: mcp-redact.test.js, "audience rule" block — rule survives
// intact as both a JSON string and a parsed object, embedded sk-/EAA tokens
// are still redacted, and sensitive field names still win inside a rule.
const STRUCTURAL_FIELD_NAMES = new Set(['rule', 'ruleAggregation']);

// LABEL FIELDS (2026-08-23, ad names arrived on a client deck as "[REDACTED]").
// Human-authored names, never credentials. isLikelyToken() calls ANY string of
// 32+ characters a token unless it looks like a path, a UUID or a hex hash, and
// Merlin's own Meta naming convention (MMDDYYYY_Batch_Descriptor, see
// META-ADS.md) routinely exceeds that: "08102026_Breeds_SmallCompanions_Schnauzer_Static"
// is 48 characters. Live case 2026-08-23 (Forever 21 weekly deck): four ad set
// names and two creative-tile labels rendered as "[REDACTED]" on slides that
// went to a client, and the same wipe hit adset_name in the source pull, so the
// damage was invisible until the deck was audited. The Go engine returns these
// intact; this layer destroyed them.
//
// Exemption is from the length GUESS only. Label values still run every
// deterministic credential rule (login block, TOKEN_PREFIXES, Bearer,
// access_token=/token=), so a real key typed into an ad name is still redacted,
// and SENSITIVE_FIELD_NAMES still wins outright at any depth. Label-ness is
// deliberately NOT propagated to child subtrees the way structural is: a label
// is a leaf string, and inheriting the exemption downward would silently exempt
// whatever a future schema nests under a key called "name".
const LABEL_FIELD_NAMES = new Set([
  'ad_name', 'adName', 'campaign_name', 'campaignName', 'adset_name', 'adsetName',
  'name', 'title', 'headline', 'label', 'audience_name', 'audienceName',
  'pageName', 'page_name', 'pixelName', 'pixel_name', 'adAccountName',
  'product_name', 'productName', 'creative_name', 'creativeName',
  'window',
]);

// Fields whose values should ALWAYS be redacted from JSON output,
// regardless of what they contain.
const SENSITIVE_FIELD_NAMES = new Set([
  'metaAccessToken', 'tiktokAccessToken', 'googleAccessToken',
  'googleRefreshToken', 'shopifyAccessToken', 'klaviyoAccessToken',
  'klaviyoApiKey', 'amazonAccessToken', 'amazonRefreshToken',
  'pinterestAccessToken', 'pinterestRefreshToken',
  'falApiKey', 'elevenLabsApiKey', 'heygenApiKey', 'arcadsApiKey',
  'slackBotToken', 'slackWebhookUrl', 'googleApiKey',
  'access_token', 'refresh_token', 'client_secret',
  'api_key', 'apiKey', 'secret', 'token',
]);

// The binary prints a delimited block during login flows:
//   ============================================================
//   Connected! Values for your config:
//   ============================================================
//   { "metaAccessToken": "EAAL...", ... }
// This entire block must be stripped.
const LOGIN_RESULT_BLOCK = /={50,}\s*\n\s*Connected!.*?\n\s*={50,}\s*\n\s*\{[\s\S]*?\n\s*\}/g;

// Generic base64-ish strings that are likely tokens (32+ chars of
// alphanumeric + common base64 chars). Excludes strings that look
// like file paths (contain / and .) or UUIDs (contain exactly 4 hyphens).
function isLikelyToken(str) {
  if (!str || str.length < 32) return false;
  // REGRESSION GUARD (2026-08-24): whitespace disqualifies. A credential is a
  // single opaque run by construction, so any string containing a space, tab
  // or newline is prose, not a secret. Without this the length test alone made
  // EVERY sentence of 32+ characters a token: the WHOLE value was replaced with
  // '[REDACTED]', not a substring of it. Live case 2026-08-23 (RIPIT weekly
  // deck): meta-attribution-compare's explanatory 'note' came back as
  // '[REDACTED]' in full, so the one field telling a reader what the
  // view-through gap MEANS was the one field destroyed.
  //
  // This does not weaken anything. A credential embedded IN prose is still
  // caught: applyCredentialPatterns runs its deterministic rules (login block,
  // TOKEN_PREFIXES, Bearer, access_token=/token=) on every string regardless,
  // and redactOpaqueRuns' LONG_TOKEN_RE charset already excludes whitespace, so
  // it sweeps the individual runs inside the sentence anyway. The only thing
  // that changes is that the SENTENCE stops being mistaken for the secret.
  if (/\s/.test(str)) return false;
  // File paths
  if (str.includes('/') && str.includes('.')) return false;
  if (str.includes('\\') && str.includes('.')) return false;
  // UUIDs (8-4-4-4-12 hex)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)) return false;
  // Hex hashes (SHA256 etc.) are OK to show
  if (/^[0-9a-f]+$/i.test(str) && str.length <= 64) return false;
  return true;
}

const LONG_TOKEN_RE = /[A-Za-z0-9_\-+/]{32,}={0,2}/g;

// Deterministic credential rules: a match here is a credential by construction
// (known platform prefix, Bearer header, token URL param, login result block),
// never a guess. These ALWAYS run — on every string, structural or not.
function applyCredentialPatterns(value) {
  let out = value.replace(LOGIN_RESULT_BLOCK, '[LOGIN_RESULT_REDACTED]');
  for (const re of TOKEN_PREFIXES) {
    re.lastIndex = 0;
    out = out.replace(re, '[REDACTED]');
  }
  out = out.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
  out = out.replace(/(access_token=)[^&\s"']+/gi, '$1[REDACTED]');
  out = out.replace(/(token=)[^&\s"']+/gi, '$1[REDACTED]');
  return out;
}

// Heuristic sweep: opaque high-entropy-looking runs embedded in a longer
// string. This is the guessing half — it is what STRUCTURAL_FIELD_NAMES
// exempts, because it cannot tell a base64 token from a URL path segment.
function redactOpaqueRuns(value) {
  LONG_TOKEN_RE.lastIndex = 0;
  return value.replace(LONG_TOKEN_RE, (match) => (isLikelyToken(match) ? '[REDACTED]' : match));
}

// Apply redaction to a single string. Shared by object properties and array
// elements so tokens inside JSON arrays (e.g. {"logs":["Bearer EAA..."]}) are
// never emitted verbatim.
//
// `structural: true` (see STRUCTURAL_FIELD_NAMES) keeps the deterministic
// credential rules and drops only the opaque-token heuristic.
function redactStringValue(value, structural = false) {
  if (typeof value !== 'string') return value;
  if (structural) return applyCredentialPatterns(value);
  if (isLikelyToken(value)) return '[REDACTED]';
  // Sweep embedded runs here rather than relying on a later whole-text pass:
  // the walker knows which subtrees are structural, a text pass does not.
  return redactOpaqueRuns(applyCredentialPatterns(value));
}

/**
 * Redact a parsed JSON value. Returns the redacted value — callers MUST use
 * the return value (arrays are rebuilt, objects are mutated and returned).
 *
 * REGRESSION GUARD (2026-04-16): do not drop the return value when recursing
 * into an array — `obj.map(...)` produces a new array and mutating the
 * original is not possible. Previous version discarded the map result and
 * also failed to run string-level redaction on array elements, so tokens
 * inside arrays (e.g. {"logs":["Bearer EAA..."]}) round-tripped unchanged.
 *
 * `structural` propagates down a STRUCTURAL_FIELD_NAMES subtree so a nested
 * URL condition inside a parsed rule object survives too. SENSITIVE_FIELD_NAMES
 * is still checked first and still wins at any depth.
 */
function redactJsonObj(obj, structural = false) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactStringValue(obj, structural);
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => redactJsonObj(item, structural));
  }
  for (const [key, value] of Object.entries(obj)) {
    const childStructural = structural || STRUCTURAL_FIELD_NAMES.has(key);
    if (typeof value === 'string') {
      if (SENSITIVE_FIELD_NAMES.has(key)) {
        obj[key] = '[REDACTED]';
      } else {
        obj[key] = redactStringValue(value, childStructural || LABEL_FIELD_NAMES.has(key));
      }
    } else if (typeof value === 'object' && value !== null) {
      // Reassign: Array.prototype.map returns a NEW array, so in-place
      // mutation of the parent is required for array children.
      obj[key] = redactJsonObj(value, childStructural);
    }
  }
  return obj;
}

/**
 * Redact a raw text string (stdout or stderr from the binary).
 * Handles both JSON and plain-text output.
 */
function redactText(text) {
  if (!text) return '';
  // 1-3: login result block, known token prefixes, Bearer + token URL params.
  // 4: long base64-ish strings that look like tokens.
  return redactOpaqueRuns(applyCredentialPatterns(text));
}

/**
 * Main entry point. Redacts both stdout and stderr, returns sanitized text.
 * Attempts to parse JSON from the output for field-level redaction,
 * then falls back to text-level redaction.
 */
function redactOutput(stdout, stderr) {
  let result = '';

  // Try JSON-level redaction on stdout
  if (stdout) {
    try {
      // Binary may print status lines before JSON. Find the JSON block:
      // the FIRST bare `{` line through the LAST bare `}` line.
      //
      // REGRESSION GUARD (2026-08-11): this scan used to run backwards for
      // both ends, taking the last bare `}` and then the first bare `{` it
      // met walking further back. `JSON.stringify(_, null, 2)` puts an
      // ARRAY ELEMENT's opening brace alone on its line (nested objects keep
      // theirs on the key's line), so any payload containing an array of
      // objects — audiences, ads, ad sets, campaigns, products, orders, i.e.
      // most list and audit actions — anchored jsonStart on an array element,
      // produced an unparseable slice, and silently fell through to the
      // catch. Consequence was not just over-redaction: the field-level
      // walker never ran, so SENSITIVE_FIELD_NAMES never applied and a short
      // (<32 char) value under a key like `access_token` matched no pattern
      // and round-tripped in the clear. Scanning forward for the opening
      // brace anchors the real top-level object. An unparseable slice still
      // falls back to redactText, so the failure mode is unchanged when the
      // output genuinely isn't JSON.
      const lines = stdout.split('\n');
      let jsonStart = -1, jsonEnd = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '{') { jsonStart = i; break; }
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim() === '}') { jsonEnd = i; break; }
      }
      if (jsonEnd < jsonStart) jsonEnd = -1;
      if (jsonStart >= 0 && jsonEnd >= 0) {
        const jsonStr = lines.slice(jsonStart, jsonEnd + 1).join('\n');
        const parsed = JSON.parse(jsonStr);
        const redacted = redactJsonObj(parsed);
        // Reconstruct: status lines (redacted) + JSON (redacted).
        //
        // Belt-and-braces pass over the stringified JSON, minus the opaque-run
        // heuristic. The walker above visits every leaf — including array
        // elements and unknown container shapes — and now runs the embedded
        // opaque-run sweep itself on non-structural leaves, so re-running it
        // here adds nothing and would undo the STRUCTURAL_FIELD_NAMES exemption
        // by shredding rule URLs the walker deliberately preserved. The
        // deterministic rules (login block, prefixes, Bearer, token params)
        // still run over the whole body.
        //
        // Narrowing accepted: a token-shaped JSON *key* is no longer swept.
        // Keys come from Merlin's own Go structs, never from platform data.
        // Status lines outside the JSON still get the full redactText.
        //
        // Trailing lines after the JSON block were previously dropped on the
        // floor; keep them (redacted) rather than silently swallowing output.
        const statusLines = lines.slice(0, jsonStart).join('\n');
        const trailingLines = lines.slice(jsonEnd + 1).join('\n');
        result = redactText(statusLines) + '\n' + applyCredentialPatterns(JSON.stringify(redacted, null, 2));
        if (trailingLines.trim()) result += '\n' + redactText(trailingLines);
      } else {
        result = redactText(stdout);
      }
    } catch {
      // Not valid JSON — use text-level redaction
      result = redactText(stdout);
    }
  }

  // Always redact stderr too (error messages can contain partial tokens)
  if (stderr) {
    const redactedErr = redactText(stderr);
    if (redactedErr.trim()) {
      result += (result ? '\n' : '') + redactedErr;
    }
  }

  return result.trim();
}

module.exports = { redactOutput, redactJsonObj, redactText, isLikelyToken };
