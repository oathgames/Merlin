'use strict';

// Tests for brand-scaffold.js — dropdown-first brand registration.
//
// Run: node --test app/brand-scaffold.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scaffoldBrandStub, BRAND_SLUG_RE } = require('./brand-scaffold');

function tmpBrandsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-brands-'));
}

test('scaffoldBrandStub creates folder + stub brand.md + memory.md when absent', () => {
  const brandsDir = tmpBrandsDir();
  const r = scaffoldBrandStub(brandsDir, 'gymshark', { displayName: 'Gymshark', url: 'https://gymshark.com' });
  assert.equal(r.created, true);
  const brandDir = path.join(brandsDir, 'gymshark');
  assert.ok(fs.statSync(brandDir).isDirectory(), 'brand dir created');
  const brandMd = fs.readFileSync(path.join(brandDir, 'brand.md'), 'utf8');
  assert.ok(brandMd.includes('# Gymshark'), 'brand.md has the display name as H1');
  assert.ok(brandMd.includes('https://gymshark.com'), 'brand.md records the URL');
  assert.ok(brandMd.toLowerCase().includes('setup in progress'), 'brand.md flags in-progress state so a half-finished brand is not confusing');
  const memMd = fs.readFileSync(path.join(brandDir, 'memory.md'), 'utf8');
  assert.ok(/## Run Log/.test(memMd), 'memory.md carries the standard template sections');
});

// REGRESSION GUARD (2026-05-22, dropdown-first onboarding): the scaffolder
// must NEVER clobber an existing brand. The scrape enrichment write and any
// re-run of setup overwrite the stub with real data; a second scaffold call
// must be a no-op so it can't wipe a user's brand profile.
test('scaffoldBrandStub never clobbers an existing brand (idempotent no-op)', () => {
  const brandsDir = tmpBrandsDir();
  const brandDir = path.join(brandsDir, 'brightco');
  fs.mkdirSync(brandDir, { recursive: true });
  const realBrand = '# Bright Co\n\nFull enriched brand profile with palette + voice.\n';
  fs.writeFileSync(path.join(brandDir, 'brand.md'), realBrand, 'utf8');
  fs.writeFileSync(path.join(brandDir, 'memory.md'), '# Bright Co — Memory\n\n## Run Log\n- ran a campaign\n', 'utf8');

  const r = scaffoldBrandStub(brandsDir, 'brightco', { displayName: 'Bright Co', url: 'https://brightco.com' });
  assert.equal(r.created, false, 'existing brand → no-op');
  assert.equal(fs.readFileSync(path.join(brandDir, 'brand.md'), 'utf8'), realBrand, 'existing brand.md untouched');
  assert.ok(fs.readFileSync(path.join(brandDir, 'memory.md'), 'utf8').includes('ran a campaign'), 'existing memory.md untouched');
});

test('scaffoldBrandStub falls back to slug for displayName when none given', () => {
  const brandsDir = tmpBrandsDir();
  scaffoldBrandStub(brandsDir, 'acme', { url: 'https://acme.com' });
  const brandMd = fs.readFileSync(path.join(brandsDir, 'acme', 'brand.md'), 'utf8');
  assert.ok(brandMd.includes('# acme'), 'display name falls back to the slug');
});

test('scaffoldBrandStub omits the Website line when no url given', () => {
  const brandsDir = tmpBrandsDir();
  scaffoldBrandStub(brandsDir, 'acme', { displayName: 'Acme' });
  const brandMd = fs.readFileSync(path.join(brandsDir, 'acme', 'brand.md'), 'utf8');
  assert.ok(!/Website:/.test(brandMd), 'no Website: line when url absent');
});

test('scaffoldBrandStub rejects an invalid slug with BRAND_INVALID', () => {
  const brandsDir = tmpBrandsDir();
  assert.throws(
    () => scaffoldBrandStub(brandsDir, '../evil', { url: 'x' }),
    (e) => e && e.code === 'BRAND_INVALID',
    'path-traversal / bad charset slug must throw BRAND_INVALID, not create a folder',
  );
  // Nothing should have been written outside the brands dir.
  assert.ok(!fs.existsSync(path.join(brandsDir, '..', 'evil')), 'no folder created on bad slug');
});

// The host activateBrand guard in main.js uses the SAME slug regex. If these
// drift, a slug that passes one but not the other creates an inconsistent
// state (folder made but activation refused, or vice versa). Pin the pattern.
test('BRAND_SLUG_RE matches the host activateBrand guard pattern', () => {
  // The canonical pattern from main.js activateBrand.
  const HOST_PATTERN = '^[a-z0-9][a-z0-9_-]{0,63}$';
  assert.equal(BRAND_SLUG_RE.source, HOST_PATTERN, 'brand-scaffold slug regex must equal the main.js activateBrand guard');
  assert.ok(BRAND_SLUG_RE.test('gymshark'));
  assert.ok(BRAND_SLUG_RE.test('bright-co'));
  assert.ok(!BRAND_SLUG_RE.test('-leading-dash'));
  assert.ok(!BRAND_SLUG_RE.test('has space'));
});
