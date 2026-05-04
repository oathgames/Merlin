// brand-manifest-scaffolder.test.js — pins the producer-side contract
// that mirrors autocmo-core/brand_manifest.go's consumer shape. Each
// test creates an isolated tmp brand directory, runs the scaffolder,
// and asserts the file shape + idempotency.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  scaffoldBrandManifest,
  __deriveDisplayName,
  __listRefImages,
  __findBrandLogo,
  __listProductSlugs,
  __buildManifest,
} = require('./brand-manifest-scaffolder');

// Build a fresh tmp workspace with a brand at assets/brands/<slug>/.
// Returns the appRoot. Caller passes a layout descriptor:
//   { products: { 'slug': ['ref_1.jpg', 'ref_2.png'] }, logo: 'logo.png' }
function makeTmpWorkspace(brand, layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-brand-scaffolder-test-'));
  const brandDir = path.join(root, 'assets', 'brands', brand);
  fs.mkdirSync(brandDir, { recursive: true });
  if (layout && layout.products) {
    for (const [slug, refs] of Object.entries(layout.products)) {
      const refDir = path.join(brandDir, 'products', slug, 'references');
      fs.mkdirSync(refDir, { recursive: true });
      for (const ref of refs) {
        fs.writeFileSync(path.join(refDir, ref), 'fake');
      }
    }
  }
  if (layout && layout.logo) {
    const logoDir = path.join(brandDir, 'logo');
    fs.mkdirSync(logoDir, { recursive: true });
    fs.writeFileSync(path.join(logoDir, layout.logo), 'fake');
  }
  if (layout && layout.preExistingManifest) {
    fs.writeFileSync(path.join(brandDir, 'brand-manifest.json'), layout.preExistingManifest);
  }
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

// ── deriveDisplayName ────────────────────────────────────────────

test('deriveDisplayName: hyphen → space + title-case', () => {
  assert.equal(__deriveDisplayName('ivory-ella'), 'Ivory Ella');
});

test('deriveDisplayName: underscore → space + title-case', () => {
  assert.equal(__deriveDisplayName('mad_chill'), 'Mad Chill');
});

test('deriveDisplayName: all-caps preserved (POG, NASA, etc)', () => {
  assert.equal(__deriveDisplayName('POG'), 'POG');
});

test('deriveDisplayName: empty string is empty', () => {
  assert.equal(__deriveDisplayName(''), '');
});

// ── happy path: full scaffold ────────────────────────────────────

test('scaffolds a manifest with products + logo for a fresh brand', () => {
  const root = makeTmpWorkspace('ivory-ella', {
    products: {
      'elephant-tee': ['1.jpg', '2.jpg'],
      'logo-hoodie': ['front.png', 'back.png'],
    },
    logo: 'logo.png',
  });
  try {
    const result = scaffoldBrandManifest(root, 'ivory-ella');
    assert.equal(result.ok, true);
    assert.equal(result.action, 'created');
    assert.equal(result.products, 2);
    assert.equal(result.hadLogo, true);

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    assert.equal(manifest.brand.id, 'ivory-ella');
    assert.equal(manifest.brand.display_name, 'Ivory Ella');
    assert.equal(manifest.products.length, 2);
    assert.equal(manifest.products[0].id, 'elephant-tee');
    assert.equal(manifest.products[0].assets.ref_1, 'products/elephant-tee/references/1.jpg');
    assert.equal(manifest.products[0].assets.ref_2, 'products/elephant-tee/references/2.jpg');
    assert.equal(manifest.generic_assets.logo_primary, 'logo/logo.png');
    assert.equal(manifest.$schema, 'https://schemas.merlin.tools/brand-manifest/v1.json');
    // Scaffold metadata helps debug stale/auto-generated files.
    assert.ok(manifest._scaffold);
    assert.ok(manifest._scaffold.generated_at);
  } finally {
    cleanup(root);
  }
});

// ── idempotency ──────────────────────────────────────────────────

test('does NOT clobber a hand-curated existing manifest', () => {
  const handCurated = JSON.stringify({
    brand: { id: 'ivory-ella', display_name: 'Ivory Ella' },
    products: [{ id: 'special', assets: { hero: 'custom/hero.png' } }],
    visual_direction: { always: ['preserve garment color'] },  // hand-added
  }, null, 2);
  const root = makeTmpWorkspace('ivory-ella', {
    products: { 'elephant-tee': ['1.jpg'] },
    logo: 'logo.png',
    preExistingManifest: handCurated,
  });
  try {
    const result = scaffoldBrandManifest(root, 'ivory-ella');
    assert.equal(result.ok, true);
    assert.equal(result.action, 'skipped-exists');
    const onDisk = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    // Hand-curated content survived — visual_direction must still be there.
    assert.deepEqual(onDisk.visual_direction, { always: ['preserve garment color'] });
    assert.equal(onDisk.products[0].id, 'special');
    // Auto-scaffold didn't add its own products[].
    assert.equal(onDisk.products.length, 1);
  } finally {
    cleanup(root);
  }
});

test('rebuild:true regenerates even when manifest exists', () => {
  const root = makeTmpWorkspace('ivory-ella', {
    products: { 'elephant-tee': ['1.jpg'] },
    logo: 'logo.png',
    preExistingManifest: '{"brand":{"id":"old"}}',
  });
  try {
    const result = scaffoldBrandManifest(root, 'ivory-ella', { rebuild: true });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'rebuilt');
    const onDisk = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    assert.equal(onDisk.brand.id, 'ivory-ella');
    assert.equal(onDisk.products.length, 1);
  } finally {
    cleanup(root);
  }
});

test('treats 0-byte stub file as "no manifest" and creates a real one', () => {
  const root = makeTmpWorkspace('ivory-ella', {
    products: { 'elephant-tee': ['1.jpg'] },
    logo: 'logo.png',
    preExistingManifest: '',
  });
  try {
    const result = scaffoldBrandManifest(root, 'ivory-ella');
    assert.equal(result.ok, true);
    assert.equal(result.action, 'created');
    const onDisk = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    assert.equal(onDisk.brand.id, 'ivory-ella');
  } finally {
    cleanup(root);
  }
});

// ── empty-brand guard ────────────────────────────────────────────

test('refuses to scaffold an empty manifest (no products + no logo)', () => {
  // The binary's brand_manifest.go enforcement returns a HARD error
  // when manifest exists but canonical asset set is empty. Scaffolding
  // an empty file would BREAK image-gen for fresh brands. Instead, the
  // scaffolder skips and lets the binary's no-manifest soft-warn path
  // remain — once references/logo land, a subsequent brand_activate
  // call retries and creates the manifest.
  const root = makeTmpWorkspace('fresh-brand', { /* no products, no logo */ });
  try {
    const result = scaffoldBrandManifest(root, 'fresh-brand');
    assert.equal(result.ok, false);
    assert.equal(result.action, 'skipped-no-assets');
    assert.ok(result.error.includes('no product references or logo'));
    // Verify nothing was written.
    const exists = fs.existsSync(path.join(root, 'assets', 'brands', 'fresh-brand', 'brand-manifest.json'));
    assert.equal(exists, false);
  } finally {
    cleanup(root);
  }
});

test('logo-only brand still scaffolds (logo is canonical via generic_assets)', () => {
  const root = makeTmpWorkspace('logo-only', { logo: 'logo.png' });
  try {
    const result = scaffoldBrandManifest(root, 'logo-only');
    assert.equal(result.ok, true);
    assert.equal(result.action, 'created');
    assert.equal(result.products, 0);
    assert.equal(result.hadLogo, true);
    const onDisk = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    assert.deepEqual(onDisk.products, []);
    assert.equal(onDisk.generic_assets.logo_primary, 'logo/logo.png');
  } finally {
    cleanup(root);
  }
});

// ── input validation ─────────────────────────────────────────────

test('refuses invalid brand slugs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-brand-scaffolder-test-'));
  try {
    for (const bad of ['', '../etc', 'has spaces', 'has/slash', '.hidden']) {
      const r = scaffoldBrandManifest(root, bad);
      assert.equal(r.ok, false);
      assert.equal(r.action, 'skipped-empty-brand');
    }
  } finally {
    cleanup(root);
  }
});

test('refuses missing brand directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-brand-scaffolder-test-'));
  try {
    const r = scaffoldBrandManifest(root, 'nonexistent');
    assert.equal(r.ok, false);
    assert.equal(r.action, 'skipped-empty-brand');
  } finally {
    cleanup(root);
  }
});

// ── path encoding (asset paths must match brand_manifest.go's
//    brandManifestProductRefMatchesCanonical comparator) ─────────

test('asset paths use forward slashes (cross-platform manifest compat)', () => {
  const root = makeTmpWorkspace('cross-os', {
    products: { 'p': ['a.jpg'] },
    logo: 'logo.png',
  });
  try {
    const result = scaffoldBrandManifest(root, 'cross-os');
    const onDisk = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    // Even on Windows runners, paths inside the manifest MUST use
    // forward-slashes — autocmo-core/brand_manifest.go normalizes both
    // sides via strings.ReplaceAll('\\','/') + path.Clean before
    // comparing, but emitting backslashes in the manifest is still a
    // smell because manual readers / IDEs interpret them as escape
    // sequences.
    assert.ok(!onDisk.products[0].assets.ref_1.includes('\\'),
      `asset path must not contain backslashes: ${onDisk.products[0].assets.ref_1}`);
    assert.ok(!onDisk.generic_assets.logo_primary.includes('\\'),
      `logo path must not contain backslashes: ${onDisk.generic_assets.logo_primary}`);
  } finally {
    cleanup(root);
  }
});

// ── helpers ──────────────────────────────────────────────────────

test('listRefImages picks .jpg/.jpeg/.png/.webp; skips .txt/.svg', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-brand-scaffolder-test-'));
  try {
    for (const f of ['1.jpg', '2.jpeg', '3.PNG', '4.webp', 'README.txt', 'icon.svg']) {
      fs.writeFileSync(path.join(root, f), 'x');
    }
    const out = __listRefImages(root);
    // .jpg/.jpeg/.png/.webp pass; .txt and .svg skip. Names are sorted.
    assert.deepEqual(out, ['1.jpg', '2.jpeg', '3.PNG', '4.webp']);
  } finally {
    cleanup(root);
  }
});

test('findBrandLogo prefers PNG over WEBP/JPG', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-brand-scaffolder-test-'));
  try {
    const logoDir = path.join(root, 'logo');
    fs.mkdirSync(logoDir);
    fs.writeFileSync(path.join(logoDir, 'logo.webp'), 'x');
    fs.writeFileSync(path.join(logoDir, 'logo.png'), 'x');
    assert.equal(__findBrandLogo(root), 'logo.png');
  } finally {
    cleanup(root);
  }
});

test('listProductSlugs skips dot-files and invalid slugs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-brand-scaffolder-test-'));
  try {
    const productsDir = path.join(root, 'products');
    fs.mkdirSync(productsDir);
    for (const slug of ['valid-slug', 'good_one', '.hidden', '..invalid']) {
      fs.mkdirSync(path.join(productsDir, slug), { recursive: true });
    }
    const out = __listProductSlugs(root);
    // Only valid slugs (lowercase alphanumeric + hyphen + underscore).
    assert.deepEqual(out, ['good_one', 'valid-slug']);
  } finally {
    cleanup(root);
  }
});
