// brand-slug.test.js — Wave F-5 regression guard mirroring the Go
// counterpart at autocmo-core/brand_slug_test.go. Both must agree on
// the slug for the same input — the Electron setup flow slugifies in
// JS, but the Go binary's klaviyo_templates.go validation will reject
// any drift.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { slugifyBrandName, isValidBrandSlug } = require('./brand-slug');

test('slugifyBrandName — common cases', () => {
  const cases = [
    ['Lalí Cosmetics', 'lali-cosmetics'],
    ['Café Reino', 'cafe-reino'],
    ['Crème de la Crème', 'creme-de-la-creme'],
    ['Mädchen', 'madchen'],
    ['Frères & Cie.', 'freres-cie'],
    ['Açaí Bowl Co', 'acai-bowl-co'],
    ['Pâté Maison', 'pate-maison'],
    ['Naïve Skincare', 'naive-skincare'],
    ['Kraków Goods', 'krakow-goods'],
    ['Český Krumlov', 'cesky-krumlov'],
    ['Madchill', 'madchill'],
    ['MADCHILL', 'madchill'],
    ['MadChill', 'madchill'],
    ['  spaced  out  ', 'spaced-out'],
    ['B&H Photo', 'b-h-photo'],
    ['AT&T', 'at-t'],
    ['madchill', 'madchill'],
    ['madchill-cosmetics', 'madchill-cosmetics'],
    ['', ''],
    ['---', ''],
    ['💯💯💯', ''],
  ];
  for (const [input, want] of cases) {
    assert.strictEqual(slugifyBrandName(input), want, `slugifyBrandName(${JSON.stringify(input)})`);
  }
});

test('slugifyBrandName — truncates to 100 chars', () => {
  const long = 'a'.repeat(150);
  const got = slugifyBrandName(long);
  assert.strictEqual(got.length, 100);
});

test('slugifyBrandName output passes isValidBrandSlug for common DTC names', () => {
  const inputs = ['Lalí Cosmetics', 'Café Reino', 'B&H Photo', 'MADCHILL', 'Crème de la Crème'];
  for (const input of inputs) {
    const slug = slugifyBrandName(input);
    if (slug !== '') {
      assert.ok(isValidBrandSlug(slug), `slug ${JSON.stringify(slug)} from ${JSON.stringify(input)} must be valid`);
    }
  }
});

test('isValidBrandSlug — accepts the strict contract', () => {
  for (const good of ['madchill', 'lali-cosmetics', 'brand_2025', 'a', 'a1', '123']) {
    assert.ok(isValidBrandSlug(good), `${JSON.stringify(good)} must be valid`);
  }
  for (const bad of ['', 'Madchill', 'lalí', 'brand name', 'brand!', 'a'.repeat(101)]) {
    assert.ok(!isValidBrandSlug(bad), `${JSON.stringify(bad)} must be invalid`);
  }
});

test('Go and JS slugifiers must agree on Lin\'s persona case', () => {
  // The headline regression guard: Sim 8 (Lin "Lalí Cosmetics") found
  // that all three regex layers rejected non-Latin brands. Both
  // slugifiers must produce the same path-safe identifier so the
  // setup flow → binary handoff round-trips cleanly.
  assert.strictEqual(slugifyBrandName('Lalí Cosmetics'), 'lali-cosmetics');
});
