// Tests for mcp-redact.js — the last-line-of-defense redactor that strips
// credentials from binary stdout/stderr before Claude ever sees them.
//
// Failure mode being guarded: a single token slipping through = live
// credential in Claude's context window = potential exfiltration through
// whatever tool Claude decides to call next. Every regression here is
// incident-grade, so we test the patterns exhaustively rather than
// "happy path + one edge case."
//
// Fixture shape note: every token-shaped string in this file is assembled
// via fake(...parts) so the raw source never contains a complete token
// pattern. GitHub push-protection secret scanning runs on source — if a
// literal `sk_live_<32>` appears in the file, the push is rejected even
// though the value is obviously fake. Runtime behavior is identical:
// fake('sk_', 'live_', BODY_32) produces the same string the redactor
// sees. Do NOT inline these back into single literals.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { redactText, redactJsonObj, redactOutput, isLikelyToken } = require('./mcp-redact');

const fake = (...parts) => parts.join('');

const BODY_32  = 'abcdef1234567890abcdef1234567890';
const BODY_22  = 'abcdef1234567890abcdef12';
const BODY_25  = 'abcdef1234567890abcdef12345';

// ─────────────────────────────────────────────────────────────────────
// Prefix-based token patterns. Each platform gets a targeted fixture so
// a regex regression on one platform doesn't hide behind the others.
// ─────────────────────────────────────────────────────────────────────

test('redactText strips Meta (Facebook) EAA access tokens', () => {
  const token = fake('EAA', 'Bsdfghjkl', 'QWERTY1234567890zxcvbnm');
  const input = `Got token ${token} from login`;
  const out = redactText(input);
  assert.match(out, /\[REDACTED\]/);
  assert.ok(!out.includes(token));
});

test('redactText strips Shopify shpat_ access tokens', () => {
  const token = fake('shpat', '_', BODY_22);
  const input = `shopify token: ${token}`;
  const out = redactText(input);
  assert.ok(out.includes('[REDACTED]'));
  assert.ok(!out.includes(token));
});

test('redactText strips Shopify shpss_ shared secrets', () => {
  const token = fake('shpss', '_', BODY_22);
  const input = `shared secret ${token} leaked`;
  const out = redactText(input);
  assert.ok(!out.includes(token));
});

test('redactText strips Slack xoxb- bot tokens', () => {
  const token = fake('xoxb', '-', '1234567890-1234567890-AbCdEfGhIjKlMnOpQrSt');
  const input = `SLACK_BOT=${token}`;
  const out = redactText(input);
  assert.ok(out.includes('[REDACTED]'));
  assert.ok(!out.includes(token));
});

test('redactText strips Slack xoxp- user tokens', () => {
  const token = fake('xoxp', '-', '1234567890-1234567890-1234567890-AbCdEfGhIjKl');
  const input = `user token=${token}`;
  const out = redactText(input);
  assert.ok(!out.includes(token));
});

test('redactText strips OpenAI sk- keys', () => {
  const token = fake('sk', '-', BODY_32);
  const input = `OPENAI_API_KEY=${token}`;
  const out = redactText(input);
  assert.ok(!out.includes(token));
});

test('redactText strips Anthropic sk-ant- keys (via sk- prefix)', () => {
  // sk-ant- starts with sk- so it's covered by the generic sk- rule.
  const token = fake('sk', '-', 'ant-api03-', 'abcdef1234567890abcdef12345');
  const input = `ANTHROPIC_KEY=${token}`;
  const out = redactText(input);
  assert.ok(!out.includes(token));
});

test('redactText strips Stripe sk_live_ keys', () => {
  const token = fake('sk_', 'live_', BODY_32);
  const input = `live=${token}`;
  const out = redactText(input);
  assert.ok(!out.includes(token));
});

test('redactText strips Stripe sk_test_ keys', () => {
  const token = fake('sk_', 'test_', BODY_32);
  const input = `test=${token}`;
  const out = redactText(input);
  assert.ok(!out.includes(token));
});

test('redactText strips Google AIza API keys', () => {
  const token = fake('AIza', 'SyB1234567890_abcdef1234567890xyz');
  const input = `GOOGLE_KEY=${token}`;
  const out = redactText(input);
  assert.ok(!out.includes(token));
});

test('redactText strips fal.ai fal- API keys', () => {
  const token = fake('fal', '-', BODY_32);
  const input = `FAL_KEY=${token}`;
  const out = redactText(input);
  assert.ok(!out.includes(token));
});

test('redactText strips Groq gsk_ keys', () => {
  const token = fake('gsk', '_', 'abcdef1234567890abcdef1234567890ABCD');
  const input = `key=${token}`;
  const out = redactText(input);
  assert.ok(!out.includes(token));
});

test('redactText strips webhook signing secrets whsec_', () => {
  const token = fake('whsec', '_', BODY_25);
  const input = `STRIPE_WHSEC=${token}`;
  const out = redactText(input);
  assert.ok(!out.includes(token));
});

test('redactText strips Discord bot tokens (base64.ts.hmac shape)', () => {
  // Discord shape: 24+ base64 chars . 6 base64 chars . 27+ base64 chars.
  const tokenBody = fake('aBcDeFgHiJkLmNoPqRsTuVwXyZ', '01234567ABC');
  const token = fake('MTExMjIyMzMzNDQ0', 'NTU1NjY2', '.', 'GaAbCd', '.', tokenBody);
  const input = `DISCORD=${token}`;
  const out = redactText(input);
  // The regex requires 24 chars . 6 chars . 27+ chars — fixture above matches.
  assert.ok(!out.includes(tokenBody));
});

// ─────────────────────────────────────────────────────────────────────
// Bearer / access_token URL param — generic shapes that don't carry a
// known prefix but must still be scrubbed.
// ─────────────────────────────────────────────────────────────────────

test('redactText scrubs Authorization Bearer header values', () => {
  const jwt = fake('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NSJ9', '.', 'abcdef');
  const input = `Authorization: Bearer ${jwt}`;
  const out = redactText(input);
  assert.match(out, /Bearer \[REDACTED\]/);
  assert.ok(!out.includes(jwt));
});

test('redactText scrubs access_token=... URL params', () => {
  const token = fake('EAA', 'Bsomeverylongstring123');
  const input = `GET /api?access_token=${token}&foo=bar`;
  const out = redactText(input);
  assert.match(out, /access_token=\[REDACTED\]/);
});

test('redactText scrubs bare token=... URL params', () => {
  const input = `callback?token=${BODY_25}&user=ryan`;
  const out = redactText(input);
  assert.match(out, /token=\[REDACTED\]/);
});

// ─────────────────────────────────────────────────────────────────────
// JWT — full three-segment token covered by the Discord regex shape and
// by the generic long-token heuristic.
// ─────────────────────────────────────────────────────────────────────

test('redactText scrubs standalone JWTs through the long-token heuristic', () => {
  // Long token with dots should be caught by LONG_TOKEN_RE or by the
  // Bearer rule when preceded. Here we test standalone — the heuristic
  // considers "contains / and ." as "path-like", but dot-alone is fine.
  const blob = fake(
    'eyJhbGciOiJIUzI1NiJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkphbmUifQ',
    'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  );
  const input = `token ${blob}`;
  const out = redactText(input);
  // That's a 100+ char alphanumeric blob — isLikelyToken returns true.
  assert.ok(out.includes('[REDACTED]'));
});

// ─────────────────────────────────────────────────────────────────────
// Multi-secret payloads — one input carrying multiple token shapes must
// have every shape scrubbed independently.
// ─────────────────────────────────────────────────────────────────────

test('redactText scrubs all secrets in a multi-token payload', () => {
  const meta    = fake('EAA', 'Bsdfghjkl', 'QWERTY1234567890zxcvbnm');
  const shopify = fake('shpat', '_', BODY_22);
  const openai  = fake('sk', '-', BODY_32);
  const google  = fake('AIza', 'SyB1234567890_abcdef1234567890xyz');
  const bearer  = fake('eyJ', 'longlongtoken1234567890');
  const input = [
    `META=${meta}`,
    `SHOPIFY=${shopify}`,
    `OPENAI=${openai}`,
    `GOOGLE=${google}`,
    `Authorization: Bearer ${bearer}`,
  ].join('\n');
  const out = redactText(input);
  assert.ok(!out.includes(meta));
  assert.ok(!out.includes(shopify));
  assert.ok(!out.includes(openai));
  assert.ok(!out.includes(google));
  // Bearer value scrubbed
  assert.match(out, /Bearer \[REDACTED\]/);
});

// ─────────────────────────────────────────────────────────────────────
// JSON structure handling.
// ─────────────────────────────────────────────────────────────────────

test('redactJsonObj redacts nested sensitive field names', () => {
  const obj = {
    brand: 'brightco',
    meta: { metaAccessToken: fake('EAA', 'Breallylongtoken1234567890abcde') },
    safe: 'hello world',
  };
  const out = redactJsonObj(obj);
  assert.equal(out.meta.metaAccessToken, '[REDACTED]');
  assert.equal(out.safe, 'hello world');
  assert.equal(out.brand, 'brightco');
});

test('redactJsonObj redacts arrays of objects with secrets', () => {
  const embedded = fake('sk', '-', BODY_32);
  const obj = {
    logs: [
      { access_token: fake('EAA', 'Bsecret1234567890longtokenvalue') },
      // isLikelyToken treats file-path-like strings (contain / and .) as safe,
      // so the surrounding prose is preserved and embedded token prefix is
      // scrubbed.
      { note: `wrote /tmp/log.txt with ${embedded} value` },
    ],
  };
  const out = redactJsonObj(obj);
  assert.equal(out.logs[0].access_token, '[REDACTED]');
  assert.ok(!out.logs[1].note.includes(embedded));
  assert.match(out.logs[1].note, /\[REDACTED\]/);
});

test('redactJsonObj redacts strings inside primitive arrays (array.map return value preserved)', () => {
  // Regression-guarded behavior (see REGRESSION GUARD 2026-04-16): array map
  // result must be reassigned so element-level redaction survives into the
  // returned structure. Before the fix, tokens inside array-typed values
  // round-tripped unchanged.
  const token = fake('shpat', '_', BODY_22);
  const obj = { logs: [`path /a.log has ${token} inside`] };
  const out = redactJsonObj(obj);
  assert.ok(!out.logs[0].includes(token));
  assert.match(out.logs[0], /\[REDACTED\]/);
});

test('redactJsonObj preserves non-sensitive structure after redaction', () => {
  const obj = { a: 1, b: true, c: null, d: [1, 2, 'three'], e: { nested: 'ok' } };
  const out = redactJsonObj(obj);
  assert.deepEqual(out, { a: 1, b: true, c: null, d: [1, 2, 'three'], e: { nested: 'ok' } });
});

test('redactJsonObj output remains parseable after JSON.stringify roundtrip', () => {
  const obj = {
    tokens: { access_token: fake('sk', '-', BODY_32) },
    nested: [{ note: fake('EAA', 'Bsecret1234567890abcdef1234567890') }],
  };
  const redacted = redactJsonObj(obj);
  const serialized = JSON.stringify(redacted);
  const reparsed = JSON.parse(serialized);
  assert.equal(reparsed.tokens.access_token, '[REDACTED]');
  assert.equal(reparsed.nested[0].note, '[REDACTED]');
});

// ─────────────────────────────────────────────────────────────────────
// Edge cases — must not throw on missing / malformed inputs.
// ─────────────────────────────────────────────────────────────────────

test('redactText handles empty string', () => {
  assert.equal(redactText(''), '');
});

test('redactText handles null', () => {
  assert.equal(redactText(null), '');
});

test('redactText handles undefined', () => {
  assert.equal(redactText(undefined), '');
});

test('redactJsonObj handles null', () => {
  assert.equal(redactJsonObj(null), null);
});

test('redactJsonObj handles undefined', () => {
  assert.equal(redactJsonObj(undefined), undefined);
});

test('redactJsonObj handles primitives unchanged', () => {
  assert.equal(redactJsonObj(42), 42);
  assert.equal(redactJsonObj(true), true);
  assert.equal(redactJsonObj(false), false);
});

test('redactJsonObj handles a raw string primitive', () => {
  // Top-level string input — receives string-level redaction.
  assert.equal(redactJsonObj(fake('sk', '-', BODY_32)), '[REDACTED]');
  assert.equal(redactJsonObj('hello'), 'hello');
});

// ─────────────────────────────────────────────────────────────────────
// False-positive guard — benign strings that superficially resemble a
// token must NOT be redacted, or the output becomes unreadable.
// ─────────────────────────────────────────────────────────────────────

test('isLikelyToken rejects file paths', () => {
  assert.equal(isLikelyToken('C:/Users/ryan/project/results/ad_20260419_120000.json'), false);
  assert.equal(isLikelyToken('/home/user/somelongpath/with/nested/folders/file.txt'), false);
});

test('isLikelyToken rejects UUIDs', () => {
  assert.equal(isLikelyToken('a1b2c3d4-e5f6-7890-abcd-ef1234567890'), false);
});

test('isLikelyToken rejects short strings', () => {
  assert.equal(isLikelyToken('short'), false);
  assert.equal(isLikelyToken(''), false);
});

test('isLikelyToken rejects SHA-256 hex hashes', () => {
  // 64 hex chars are common in output — never redact.
  const sha = 'a'.repeat(64);
  assert.equal(isLikelyToken(sha), false);
});

test('redactText leaves normal prose untouched', () => {
  const input = 'The quick brown fox jumps over the lazy dog. Shipped 12 orders today.';
  const out = redactText(input);
  assert.equal(out, input);
});

test('redactText leaves Windows paths alone', () => {
  const input = 'Wrote C:\\Users\\ryan\\project\\results\\ad_20260419_120000\\metadata.json';
  const out = redactText(input);
  assert.ok(out.includes('C:\\Users\\ryan\\project\\results'));
});

// ─────────────────────────────────────────────────────────────────────
// Login result block — the biggest single-exfil vector.
// ─────────────────────────────────────────────────────────────────────

test('redactText strips the entire login success block', () => {
  const token = fake('EAA', 'Breallylongtoken1234567890abcde');
  const input = [
    '============================================================',
    'Connected! Values for your config:',
    '============================================================',
    '{',
    `  "metaAccessToken": "${token}",`,
    '  "metaAdAccountId": "act_12345"',
    '}',
    'Saved to config.',
  ].join('\n');
  const out = redactText(input);
  assert.match(out, /\[LOGIN_RESULT_REDACTED\]/);
  assert.ok(!out.includes(token));
});

// ─────────────────────────────────────────────────────────────────────
// redactOutput — integration: both stdout and stderr scrubbed.
// ─────────────────────────────────────────────────────────────────────

test('redactOutput scrubs both stdout and stderr', () => {
  const skToken = fake('sk', '-', BODY_32);
  const jwtToken = fake('eyJ', 'longtoken1234567890');
  const stdout = `Success. Token: ${skToken}`;
  const stderr = `Warning: Bearer ${jwtToken} expired`;
  const out = redactOutput(stdout, stderr);
  assert.ok(!out.includes(skToken));
  assert.ok(!out.includes(jwtToken));
});

test('redactOutput returns empty string on empty inputs', () => {
  assert.equal(redactOutput('', ''), '');
  assert.equal(redactOutput(null, null), '');
  assert.equal(redactOutput(undefined, undefined), '');
});

test('redactOutput parses JSON block embedded in stdout status lines', () => {
  const token = fake('sk', '-', BODY_32);
  const stdout = [
    'Running...',
    'Status: ok',
    '{',
    `  "access_token": "${token}"`,
    '}',
  ].join('\n');
  const out = redactOutput(stdout, '');
  assert.ok(!out.includes(token));
  assert.match(out, /"access_token":\s*"\[REDACTED\]"/);
});

test('redactOutput falls back to text redaction on unparseable stdout', () => {
  const token = fake('EAA', 'Bsecret1234567890abcdef1234567890');
  const stdout = `not valid json: ${token}`;
  const out = redactOutput(stdout, '');
  assert.ok(!out.includes(token));
});

// ─────────────────────────────────────────────────────────────────────────────
// Audience rule — STRUCTURAL_FIELD_NAMES exemption.
//
// REGRESSION GUARD (2026-08-11): `meta_audit action=audit-audience-rule`
// returned "rule": "[REDACTED]" for every custom audience, making the action
// useless for the one question it exists to answer. Meta ships the rule as a
// long JSON string, which tripped isLikelyToken and was nuked wholesale; even
// parsed into an object, the long-run sweep shredded URL conditions at every
// dot. Live case (benebone): 17 pixel audiences under Meta's 1,000-person
// floor, pixel healthy, pixel shared across 49 domains — the URL filter was
// the remaining suspect and the one unreadable field.
//
// The exemption drops the opaque-token HEURISTIC only. Every deterministic
// credential rule still applies inside a rule blob, which the token tests
// below pin.
// ─────────────────────────────────────────────────────────────────────────────

// Representative Meta website-custom-audience rule: url/i_contains conditions,
// event names, pixel id, retention window.
const AUDIENCE_RULE = {
  inclusions: {
    operator: 'or',
    rules: [{
      event_sources: [{ type: 'pixel', id: '1463260117266408' }],
      retention_seconds: 2592000,
      filter: {
        operator: 'and',
        filters: [
          { field: 'url', operator: 'i_contains', value: 'https://www.benebone.com/collections/durable-dog-chews' },
          { field: 'event', operator: 'eq', value: 'AddToCart' },
        ],
      },
    }],
  },
};

const auditStdout = (rule) => [
  '============================================================',
  '  Meta — Audience Rule',
  '============================================================',
  '',
  JSON.stringify({ id: '23851234567890123', name: 'Benebone ATC 30d', rule, retentionDays: 30 }, null, 2),
].join('\n');

test('audience rule survives redaction intact when Meta returns it as a JSON string', () => {
  const out = redactOutput(auditStdout(JSON.stringify(AUDIENCE_RULE)), '');
  assert.ok(!out.includes('[REDACTED]'), `rule was redacted:\n${out}`);
  assert.match(out, /i_contains/);
  assert.match(out, /AddToCart/);
  assert.match(out, /1463260117266408/);
  assert.match(out, /2592000/);
  // The URL condition survives whole — host AND path. Truncating the path is
  // the failure mode that hid which of the pixel's 49 domains was filtered.
  assert.ok(out.includes('https://www.benebone.com/collections/durable-dog-chews'));
});

test('audience rule survives redaction intact when Meta returns it as an object', () => {
  const out = redactOutput(auditStdout(AUDIENCE_RULE), '');
  assert.ok(!out.includes('[REDACTED]'), `rule was redacted:\n${out}`);
  assert.match(out, /"i_contains"/);
  assert.match(out, /"AddToCart"/);
  assert.ok(out.includes('https://www.benebone.com/collections/durable-dog-chews'));
});

test('audience rule redacts an embedded sk- token but keeps the rest of the rule', () => {
  const token = fake('sk', '-', BODY_32);
  const rule = JSON.parse(JSON.stringify(AUDIENCE_RULE));
  rule.inclusions.rules[0].filter.filters.push({ field: 'url', operator: 'i_contains', value: `utm_key=${token}` });
  const out = redactOutput(auditStdout(JSON.stringify(rule)), '');
  assert.ok(!out.includes(token), 'sk- token leaked out of the audience rule');
  assert.match(out, /i_contains/);
  assert.match(out, /AddToCart/);
});

test('audience rule redacts an embedded EAA token but keeps the rest of the rule', () => {
  const token = fake('EAA', 'B', BODY_32);
  const rule = JSON.parse(JSON.stringify(AUDIENCE_RULE));
  rule.inclusions.rules[0].filter.filters.push({ field: 'url', operator: 'i_contains', value: `access=${token}` });
  const out = redactOutput(auditStdout(rule), '');
  assert.ok(!out.includes(token), 'EAA token leaked out of the audience rule');
  assert.match(out, /"i_contains"/);
  assert.match(out, /"AddToCart"/);
});

test('audience rule still strips Bearer headers and token= URL params', () => {
  const token = fake(BODY_32, 'zzzz');
  const out = redactJsonObj({ rule: { note: `Bearer ${token}`, cb: `https://x.example/cb?access_token=${token}` } });
  assert.ok(!out.rule.note.includes(token));
  assert.ok(!out.rule.cb.includes(token));
});

test('sensitive field names still win inside a rule subtree', () => {
  const token = fake('shpat_', BODY_32);
  const out = redactJsonObj({ rule: { filters: [{ access_token: token, field: 'url' }] } });
  assert.equal(out.rule.filters[0].access_token, '[REDACTED]');
  assert.equal(out.rule.filters[0].field, 'url');
});

test('the structural exemption does not leak to sibling or unrelated fields', () => {
  const opaque = fake(BODY_32, 'abcdefgh');
  const out = redactJsonObj({ rule: { keep: opaque }, description: opaque, nested: { other: opaque } });
  assert.equal(out.rule.keep, opaque, 'rule subtree should be exempt');
  assert.equal(out.description, '[REDACTED]', 'non-structural sibling must still be swept');
  assert.equal(out.nested.other, '[REDACTED]', 'unrelated subtree must still be swept');
});

test('embedded opaque tokens in non-structural leaves are still swept (belt-and-braces moved into the walker)', () => {
  const opaque = fake(BODY_32, 'abcdefgh');
  const out = redactOutput(['{', `  "note": "the value is ${opaque} ok"`, '}'].join('\n'), '');
  assert.ok(!out.includes(opaque), 'embedded opaque token leaked from a non-structural leaf');
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON block detection — arrays of objects.
//
// REGRESSION GUARD (2026-08-11): the block scan ran backwards for both ends,
// so an array element's bare `{` line (JSON.stringify puts it alone; nested
// objects keep theirs on the key's line) became jsonStart. The slice was
// unparseable, redactOutput fell through to the text-only path, and the
// field-level walker never ran — SENSITIVE_FIELD_NAMES never applied.
// ─────────────────────────────────────────────────────────────────────────────

test('redactOutput applies field-level redaction inside an array of objects', () => {
  // Deliberately SHORT: under the 32-char floor, so it matches no prefix and
  // no long-run pattern. Only the field-name walker can catch it — which is
  // exactly what the broken block scan skipped.
  const shortToken = 'abc123def456ghi789';
  const stdout = [
    'Fetching audiences...',
    JSON.stringify({ total: 1, audiences: [{ id: '23851', access_token: shortToken }] }, null, 2),
  ].join('\n');
  const out = redactOutput(stdout, '');
  assert.ok(!out.includes(shortToken), 'short token under access_token leaked from an array of objects');
  assert.match(out, /"access_token":\s*"\[REDACTED\]"/);
  assert.match(out, /"id":\s*"23851"/, 'non-sensitive sibling fields must survive');
});

test('redactOutput anchors the JSON block on the top-level brace, not an array element', () => {
  const stdout = JSON.stringify({ total: 1, rows: [{ a: 1 }, { b: 2 }] }, null, 2);
  const out = redactOutput(stdout, '');
  assert.match(out, /"total":\s*1/, 'top-level keys before the array must survive');
  assert.match(out, /"rows"/);
});

test('redactOutput keeps trailing lines after the JSON block', () => {
  const stdout = [
    JSON.stringify({ ok: true, rows: [{ a: 1 }] }, null, 2),
    'Done in 1.2s',
  ].join('\n');
  const out = redactOutput(stdout, '');
  assert.match(out, /Done in 1\.2s/, 'trailing output must not be dropped');
});

test('redactOutput still falls back to text redaction when the block is unparseable', () => {
  const token = fake('EAA', 'B', BODY_32);
  const out = redactOutput(`{ broken ${token}\n}`, '');
  assert.ok(!out.includes(token));
});
