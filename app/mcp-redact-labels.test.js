// REGRESSION GUARD (2026-08-11, redacted-ad-name incident).
//
// A creative leaderboard tile on a CLIENT deck rendered "[REDACTED]" as the ad
// name. Cause: isLikelyToken() classes ANY string of 32+ chars that is not a
// path, UUID, or hex hash as a credential. Our own Meta naming convention
// (MMDDYYYY_Batch_Descriptor, per META-ADS.md) routinely exceeds 32 chars, so
// descriptive ad names were destroyed -- 13 of 36 on the Benebone account. The
// Go engine returns them intact; this layer wiped them.
//
// The fix must hold BOTH directions: labels survive, credentials never do.
const test = require('node:test');
const assert = require('node:assert');
const { redactJsonObj } = require('./mcp-redact');

const walk = (o) => redactJsonObj(JSON.parse(JSON.stringify(o)));

test('long human-authored ad names survive redaction', () => {
  const names = [
    '08102026_Breeds_SmallCompanions_Schnauzer_Static',   // 48 chars, real
    '07012026_Batch_Bundle_Wishbone_Bacon_Static_V2',
    '06172026_Batch_PreLaunch_Durable_Chew_Lifestyle_Video',
  ];
  for (const n of names) {
    assert.strictEqual(walk({ ad_name: n }).ad_name, n, `ad_name destroyed: ${n}`);
    assert.strictEqual(walk({ adset_name: n }).adset_name, n);
    assert.strictEqual(walk({ campaign_name: n }).campaign_name, n);
  }
});

test('a real credential pasted into a label field is STILL redacted', () => {
  for (const tok of ['sk-abcdefghij1234567890ABCDEFGHIJ',
                     'EAABsbCS1iHgBO7ZCabcdefghijklmnop',
                     'AKIAIOSFODNN7EXAMPLE']) {
    const out = walk({ ad_name: `campaign ${tok} here` }).ad_name;
    assert.ok(!out.includes(tok), `credential leaked through a label field: ${tok}`);
    assert.ok(out.includes('[REDACTED]'));
  }
});

test('non-label long opaque strings are still redacted', () => {
  const opaque = '0aB9xYz2QwErTyUiOpAsDfGhJkLzXcVbNm1234567';
  assert.strictEqual(walk({ notes: opaque }).notes, '[REDACTED]');
});

test('explicitly sensitive field names still win outright', () => {
  const out = walk({ access_token: 'EAABsbCS1iHgBO7ZCabcdefghijklmnop' });
  assert.strictEqual(out.access_token, '[REDACTED]');
});

test('label exemption survives nesting and arrays', () => {
  const n = '08102026_Breeds_SmallCompanions_Schnauzer_Static';
  const out = walk({ data: { ads: [{ ad_name: n, spend: 1 }] } });
  assert.strictEqual(out.data.ads[0].ad_name, n);
});

// REGRESSION GUARD (2026-08-24, redacted-prose incident). The label exemption
// above only covers NAMED fields. Any 32+ char prose string under an unlisted
// key was still swallowed whole, because isLikelyToken tested length and
// nothing about shape. Live case: meta-attribution-compare's 'note', the field
// that explains what the view-through gap means, returned as '[REDACTED]'.
// Whitespace now disqualifies: a credential is one opaque run by construction.
test('prose under an unlisted key survives redaction', () => {
  const note = 'Click-only windows exclude view-through and engaged-view conversions.';
  assert.strictEqual(walk({ note }).note, note);
  const summary = 'Spend rose 12% week over week while ROAS held flat at 2.1x.';
  assert.strictEqual(walk({ summary }).summary, summary);
});

test('a credential embedded in prose is STILL redacted', () => {
  const cases = [
    'Set the header to Bearer EAABsbCS1iHgBO7ZCabcdefghijklmnop before calling.',
    'Use ?access_token=EAABsbCS1iHgBO7ZCabcdefghijklmnop to authenticate.',
    'The key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 for that account.',
    'Paste AKIAIOSFODNN7EXAMPLE into the console.',
  ];
  for (const c of cases) {
    const out = walk({ note: c }).note;
    assert.ok(out.includes('[REDACTED]'), `credential survived in prose: ${c}`);
  }
});

test('a bare credential with no whitespace is still redacted whole', () => {
  const t = 'aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkMTIz';
  assert.strictEqual(walk({ note: t }).note, '[REDACTED]');
});
