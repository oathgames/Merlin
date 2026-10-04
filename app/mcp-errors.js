// Merlin MCP — Structured Error Codes
//
// Canonical error codes the agent branches on. The binary stderr / stdout
// is classified into one of these codes by `classifyBinaryError`. The agent
// reads the code (machine-readable); the user sees the `message` (plain
// English, friendly).
//
// Adding a code: pick a stable SHOUTY_SNAKE name, document the default
// next_action, and add a classifier pattern if it maps to a known binary
// string. Do NOT reuse codes for different semantics — the agent's retry
// logic branches on code.
//
// Rate-limit semantics: RATE_LIMITED always carries retry_after_sec. Auto
// mode waits that long before retrying. Never retry with a shorter delay.
// The binary's preflight is the authoritative spacing enforcer; MCP-level
// retry is belt-and-braces.

'use strict';

const { redactText } = require('./mcp-redact');

// REGRESSION GUARD (2026-08-22, Benebone 7-Pack push): EVERY error envelope
// carries `detail` - the raw, redacted platform/engine text that produced the
// classification. Before this, `classifyBinaryError` matched a pattern,
// returned a canned friendly `message`, and THREW THE RAW TEXT AWAY. A live
// bulk-push failed 8/8 on Meta's
//
//   "Ad Account Has No Access To Instagram Account ... (code 200/1815199)"
//
// and the agent received only "Access denied - the platform refused this
// request." with next_action check_permissions. The word "permissions" inside
// Meta's string tripped the PERMISSION_DENIED arm, and every id, subcode and
// noun in the actual cause was discarded. Diagnosing it took a direct CLI
// invocation of the engine outside the app, and the real cause (a leaked
// cross-brand Instagram id) was invisible from the envelope alone.
//
// `message` stays friendly and is what a human reads (Hard-Won Rule 6 is
// unchanged - friendlyError still governs anything rendered in the UI).
// `detail` is the machine/agent-facing diagnostic: it never replaces
// `message`, and it is redacted through mcp-redact before it leaves this
// module, so a token embedded in engine stderr cannot ride out on it.
//
// Do NOT "clean up" a classifier arm by dropping detail. A classification
// without the evidence behind it is a guess the next session cannot check.

// Error code table. Each row: { code, defaultMessage, next_action }.
const CODES = {
  // ── Transient (auto-retry safe) ────────────────────────────
  RATE_LIMITED: {
    message: 'Slowing down to respect platform limits.',
    next_action: 'wait_and_retry',
  },
  PLATFORM_DOWN: {
    message: 'The platform is temporarily unreachable.',
    next_action: 'wait_and_retry',
  },
  TIMEOUT: {
    message: 'The request took too long and was cancelled.',
    next_action: 'retry_or_split',
  },

  // ── Permanent (stop, ask user, re-auth) ────────────────────
  TOKEN_EXPIRED: {
    message: 'Connection expired — please reconnect this platform.',
    next_action: 'reconnect_platform',
  },
  NOT_CONNECTED: {
    message: 'This platform is not connected yet.',
    next_action: 'connect_platform',
  },
  PERMISSION_DENIED: {
    message: 'Access denied — the platform refused this request.',
    next_action: 'check_permissions',
  },
  BUDGET_REJECTED: {
    message: 'Budget exceeds the configured limit.',
    next_action: 'ask_user_to_raise_cap',
  },
  CONFIRM_REQUIRED: {
    message: 'This action is large enough to need a confirmation step.',
    next_action: 'call_preview_first',
  },
  BRAND_MISSING: {
    message: 'A brand name is required for this action.',
    next_action: 'retry_with_brand',
  },
  INVALID_INPUT: {
    message: 'One of the inputs was wrong.',
    next_action: 'fix_inputs_and_retry',
  },
  NOT_FOUND: {
    message: 'The requested item could not be found.',
    next_action: 'verify_identifier',
  },
  PRECONDITION_FAILED: {
    message: 'A prerequisite for this action is missing.',
    next_action: 'run_prerequisite_setup',
  },

  // ── Job lifecycle ──────────────────────────────────────────
  JOB_RUNNING: {
    message: 'The job is still running.',
    next_action: 'poll_again_later',
  },
  JOB_FAILED: {
    message: 'The background job failed.',
    next_action: 'inspect_job_output',
  },
  JOB_NOT_FOUND: {
    message: 'No job with that id exists or it has expired.',
    next_action: 'start_new_job',
  },

  // ── Merlin internal ────────────────────────────────────────
  BINARY_UNAVAILABLE: {
    message: 'The Merlin engine is not available. Try restarting.',
    next_action: 'restart_app',
  },
  BINARY_TOO_OLD: {
    message: 'The Merlin engine needs to update.',
    next_action: 'restart_app',
  },
  CONFIG_MISSING: {
    message: 'No configuration found for this brand.',
    next_action: 'run_onboarding',
  },
  INTERNAL_ERROR: {
    message: 'Something went wrong inside Merlin.',
    next_action: 'retry_or_report',
  },
};

/**
 * Build a structured error. Always prefer a known code; falls back to
 * INTERNAL_ERROR if the code is unknown (with a loud warning).
 */
function makeError(code, overrides = {}) {
  const base = CODES[code];
  if (!base) {
    console.warn(`[mcp-errors] unknown code: ${code} — falling back to INTERNAL_ERROR`);
    return {
      code: 'INTERNAL_ERROR',
      message: overrides.message || CODES.INTERNAL_ERROR.message,
      next_action: overrides.next_action || CODES.INTERNAL_ERROR.next_action,
      retry_after_sec: overrides.retry_after_sec || null,
      detail: normalizeDetail(overrides.detail),
    };
  }
  return {
    code,
    message: overrides.message || base.message,
    next_action: overrides.next_action || base.next_action,
    retry_after_sec: typeof overrides.retry_after_sec === 'number' ? overrides.retry_after_sec : null,
    detail: normalizeDetail(overrides.detail),
  };
}

// Maximum characters of raw output carried on `detail`. Long enough for a
// full Meta Graph error line (message + type + code + subcode + fbtrace_id)
// plus the surrounding context, short enough that a 60-ad bulk-push failure
// log does not flood the agent's context.
const DETAIL_MAX_CHARS = 1200;

/**
 * Normalize raw engine/platform output into the `detail` field: redact any
 * credential material, drop blank lines, and cap the length.
 *
 * Returns null for empty input so `detail` is consistently `null | string`
 * and never an empty string a caller has to special-case.
 */
function normalizeDetail(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = redactText(raw)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length <= DETAIL_MAX_CHARS) return cleaned;
  // Keep the TAIL, not the head. The engine prints progress lines first and
  // the failure last, so the final characters are the diagnostic ones.
  return '...(truncated)\n' + cleaned.slice(cleaned.length - DETAIL_MAX_CHARS);
}

// ── Binary-stderr classifier ────────────────────────────────
//
// Maps the raw strings the Go binary prints into canonical codes.
// Each pattern has a matcher (regex or substring) and a mapping.
// Order matters — first match wins. Most specific patterns first.
//
// When you teach the binary a new error string, add it here. The agent
// will only branch correctly if this classifier covers it.

const CLASSIFIERS = [
  // Safe mode: MUST stay ABOVE the generic "merlin rate limit" matcher.
  // ratelimit_preflight.go enters a 24-hour safe mode when its HMAC-signed
  // state file is tampered with (or the clock rolls backwards), and the
  // error string contains "safe mode" (e.g. "merlin rate limit: safe mode
  // engaged"). Before this arm existed, that string fell through to the
  // generic rate-limit copy ("Retrying in ~30s"), which was a lie: no 30s
  // retry succeeds against a 24-hour pause, so users watched an endless
  // "retrying" loop. Tell the truth in plain language and carry the real
  // wait so auto-retry backs off for the whole window.
  {
    test: (s) => /safe[\s_-]?mode/i.test(s),
    classify: (s) => {
      const retry = parseRetryAfter(s);
      const waitSec = retry || 24 * 3600; // safe mode lasts 24h when the raw string carries no remaining time
      return makeError('RATE_LIMITED', {
        message: `Merlin paused this platform to keep your account safe. It will start working again on its own ${describeDuration(waitSec)}. You do not need to do anything.`,
        retry_after_sec: waitSec,
        detail: s,
      });
    },
  },
  // Rate-limit family: highest priority after safe mode.
  // Example strings from ratelimit_preflight.go:
  //   "merlin rate limit: meta minute cap reached, try again in 12s"
  //   "merlin rate limit: backing off from tiktok, 45s remaining"
  {
    test: (s) => /merlin rate limit/i.test(s),
    classify: (s) => {
      const retry = parseRetryAfter(s);
      return makeError('RATE_LIMITED', {
        message: `Pausing briefly to keep your account safe with the platform. Retrying in ~${retry || 30}s.`,
        retry_after_sec: retry || 30,
        detail: s,
      });
    },
  },
  // Platform-reported rate limits (HTTP 429, Retry-After header)
  {
    test: (s) => /\b429\b|too many requests|rate.?limit(ed)?/i.test(s),
    classify: (s) => {
      const retry = parseRetryAfter(s);
      return makeError('RATE_LIMITED', {
        retry_after_sec: retry || 60,
        detail: s,
      });
    },
  },
  // Token expiration
  {
    test: (s) => /token (has )?expired|invalid.?token|oauth.*expired|re-?auth(enticate|orize)/i.test(s),
    classify: (s) => makeError('TOKEN_EXPIRED', { detail: s }),
  },
  // Not connected
  {
    test: (s) => /no (config|token|credentials)|not connected|no.*(access.?token|api.?key).* (found|set|configured)/i.test(s),
    classify: (s) => makeError('NOT_CONNECTED', { detail: s }),
  },
  // Permission / auth failure
  {
    test: (s) => /\b401\b|\b403\b|unauthoriz(ed|e)|forbidden|access (denied|refused)|permission/i.test(s),
    classify: (s) => makeError('PERMISSION_DENIED', { detail: s }),
  },
  // Budget rejection
  {
    test: (s) => /budget.*(exceed|too high|over|cap|limit)|maxDailyAdBudget|monthly.?cap/i.test(s),
    classify: (s) => makeError('BUDGET_REJECTED', { detail: s }),
  },
  // Not found
  {
    test: (s) => /\b404\b|not found|does not exist|no such/i.test(s),
    classify: (s) => makeError('NOT_FOUND', { detail: s }),
  },
  // Timeout / context deadline
  {
    test: (s) => /context deadline|deadline exceeded|timeout|timed out/i.test(s),
    classify: (s) => makeError('TIMEOUT', { detail: s }),
  },
  // Platform outage
  {
    test: (s) => /\b5\d\d\b|bad gateway|service unavailable|gateway timeout|temporarily unavailable/i.test(s),
    classify: (s) => makeError('PLATFORM_DOWN', { retry_after_sec: 30, detail: s }),
  },
  // Precondition — e.g. Meta app in dev mode (subcode 1885183)
  {
    test: (s) => /\b1885183\b|development mode|app.*review.*pending/i.test(s),
    classify: (s) => makeError('PRECONDITION_FAILED', {
      message: 'Meta app is in development mode - ad creatives cannot be created until Meta approves the app.',
      detail: s,
    }),
  },
  // Missing input
  {
    test: (s) => /missing (required|field|parameter|argument)|required.*not.*provided|must be specified/i.test(s),
    classify: (s) => makeError('INVALID_INPUT', { detail: s }),
  },
];

/**
 * Parse a retry-after value out of a string.
 * Recognizes:
 *   "try again in 12s" | "12 seconds" | "Retry-After: 30"
 *   "try again in 2m" | "2 minutes"  | "45s remaining"
 * Returns seconds (number) or null.
 */
function parseRetryAfter(s) {
  if (!s || typeof s !== 'string') return null;

  // Retry-After header style: "Retry-After: 30"
  const headerMatch = /retry[-_ ]?after[:\s]+(\d+)/i.exec(s);
  if (headerMatch) return parseInt(headerMatch[1], 10);

  // "try again in 12s" / "45s remaining" / "12 seconds"
  const secMatch = /(\d+)\s*(?:s\b|seconds?\b)/i.exec(s);
  if (secMatch) return parseInt(secMatch[1], 10);

  // "try again in 2m" / "2 minutes"
  const minMatch = /(\d+)\s*(?:m\b|min(?:ute)?s?\b)/i.exec(s);
  if (minMatch) return parseInt(minMatch[1], 10) * 60;

  // "resets in 3h"
  const hrMatch = /(\d+)\s*(?:h\b|hours?\b)/i.exec(s);
  if (hrMatch) return parseInt(hrMatch[1], 10) * 3600;

  return null;
}

/**
 * Human-friendly wait description for user-facing copy ("in about 18
 * hours"). Plain words a 5th grader reads without pausing: no "s"
 * abbreviations, no ISO durations. Used by the safe-mode classifier.
 */
function describeDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'soon';
  if (seconds >= 5400) return `in about ${Math.round(seconds / 3600)} hours`;
  if (seconds >= 3600) return 'in about an hour';
  if (seconds >= 90) return `in about ${Math.round(seconds / 60)} minutes`;
  if (seconds >= 60) return 'in about a minute';
  return `in about ${Math.round(seconds)} seconds`;
}

/**
 * Classify a raw stderr/stdout string into a structured error.
 * Returns null if no pattern matched — callers should fall back to
 * INTERNAL_ERROR with the raw string as the message.
 */
function classifyBinaryError(text) {
  if (!text || typeof text !== 'string') return null;
  for (const { test, classify } of CLASSIFIERS) {
    if (test(text)) return classify(text);
  }
  return null;
}

/**
 * Convenience: classify, and fall back to INTERNAL_ERROR with a redacted
 * message if no known pattern matched. Use this as the default path in
 * `runBinary`'s error handler.
 */
function classifyOrFallback(text, fallbackMessage) {
  const classified = classifyBinaryError(text);
  if (classified) return classified;
  // The unclassified path is exactly where raw context matters most: no
  // pattern matched, so `message` carries no information the caller did not
  // already have. Always attach the evidence.
  return makeError('INTERNAL_ERROR', {
    message: fallbackMessage || 'Something went wrong inside Merlin.',
    detail: text,
  });
}

module.exports = {
  CODES,
  makeError,
  normalizeDetail,
  DETAIL_MAX_CHARS,
  classifyBinaryError,
  classifyOrFallback,
  parseRetryAfter,
  describeDuration,
};
