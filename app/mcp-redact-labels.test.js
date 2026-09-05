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

// REGRESSION GUARD (2026-09-04, labels-took-the-structural-branch). The label
// exemption was implemented by routing label values through the STRUCTURAL
// branch, which drops redactOpaqueRuns entirely -- not just the whole-string
// length guess the comment claimed. So any credential WITHOUT a known prefix,
// a Bearer header, or an access_token= shape round-tripped verbatim out of
// title / label / name, while the identical value under 'notes' was redacted.
// Both values below were verified to survive unredacted pre-fix.
test('an unprefixed key in a label field is redacted, and its shape is why', () => {
  const key = 'pk_live_51H8xKjE2eZvKYlo2C0abcdefghij';   // 37 chars, no TOKEN_PREFIX match
  const b64 = 'aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkMTIz'; // 44 chars, no prefix
  for (const field of ['title', 'label', 'name', 'ad_name', 'headline']) {
    for (const secret of [key, b64]) {
      const bare = walk({ [field]: secret })[field];
      assert.ok(!bare.includes(secret), `credential survived verbatim in ${field}: ${secret}`);
      assert.strictEqual(bare, '[REDACTED]');
      const embedded = walk({ [field]: `Batch ${secret} v2` })[field];
      assert.ok(!embedded.includes(secret), `embedded credential survived in ${field}`);
      assert.ok(embedded.includes('[REDACTED]'));
    }
  }
});

test('label and non-label fields agree on what is a credential', () => {
  const secret = 'aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkMTIz';
  assert.strictEqual(walk({ notes: secret }).notes, '[REDACTED]');
  assert.strictEqual(walk({ title: secret }).title, '[REDACTED]');
});

test("'window' is not a label field", () => {
  // It carries reporting windows, never human-authored names, so exempting it
  // widened the hole for nothing.
  const secret = 'aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkMTIz';
  assert.strictEqual(walk({ window: secret }).window, '[REDACTED]');
});
