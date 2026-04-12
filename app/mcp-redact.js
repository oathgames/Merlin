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
];

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

/**
 * Redact a parsed JSON object in-place. Replaces sensitive field values
 * and any string value that looks like a token.
 */
function redactJsonObj(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => redactJsonObj(item));
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      if (SENSITIVE_FIELD_NAMES.has(key)) {
        obj[key] = '[REDACTED]';
      } else if (isLikelyToken(value)) {
        obj[key] = '[REDACTED]';
      } else {
        // Check for known token prefixes inline
        let redacted = value;
        for (const re of TOKEN_PREFIXES) {
          re.lastIndex = 0;
          redacted = redacted.replace(re, '[REDACTED]');
        }
        obj[key] = redacted;
      }
    } else if (typeof value === 'object' && value !== null) {
      redactJsonObj(value);
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
  let out = text;

  // 1. Strip the entire login result block (contains raw tokens)
  out = out.replace(LOGIN_RESULT_BLOCK, '[LOGIN_RESULT_REDACTED]');

  // 2. Strip known token prefixes
  for (const re of TOKEN_PREFIXES) {
    re.lastIndex = 0;
    out = out.replace(re, '[REDACTED]');
  }

  // 3. Strip Bearer tokens and access_token URL params
  out = out.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
  out = out.replace(/(access_token=)[^&\s"']+/gi, '$1[REDACTED]');
  out = out.replace(/(token=)[^&\s"']+/gi, '$1[REDACTED]');

  // 4. Strip long base64-ish strings that look like tokens
  out = out.replace(LONG_TOKEN_RE, (match) => {
    if (isLikelyToken(match)) return '[REDACTED]';
    return match;
  });

  return out;
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
      // Binary may print status lines before JSON. Find the JSON block.
      const lines = stdout.split('\n');
      let jsonStart = -1, jsonEnd = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim() === '}' && jsonEnd < 0) jsonEnd = i;
        if (lines[i].trim() === '{' && jsonEnd >= 0) { jsonStart = i; break; }
      }
      if (jsonStart >= 0 && jsonEnd >= 0) {
        const jsonStr = lines.slice(jsonStart, jsonEnd + 1).join('\n');
        const parsed = JSON.parse(jsonStr);
        const redacted = redactJsonObj(parsed);
        // Reconstruct: status lines (redacted) + JSON (redacted)
        const statusLines = lines.slice(0, jsonStart).join('\n');
        result = redactText(statusLines) + '\n' + JSON.stringify(redacted, null, 2);
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
