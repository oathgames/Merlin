// brand-manifest-scaffolder.js
//
// Closes the producer/consumer gap on `assets/brands/<brand>/brand-manifest.json`.
//
// THE PROBLEM (live incident, 2026-05-04):
// `autocmo-core/brand_manifest.go` enforces a manifest contract on every
// `mcp__merlin__content` image-gen call: when a manifest is present, the
// `productRefPath` MUST resolve to a canonical asset listed in
// `products[].assets.*` or `generic_assets.*`, AND `compositeMode` MUST
// be `true`. When the manifest is ABSENT, the gate soft-warns and
// proceeds in non-composite mode — banana-pro-edit then treats the
// `references/1.jpg` as a style hint and re-renders the garment from
// scratch instead of preserving it. Wrong product, every time.
//
// Onboarding (`merlin-setup`), product import, and brand activation all
// SHIPPED without a producer step that creates the manifest. The
// consumer-side check shipped, the producer-side scaffolder didn't —
// every brand on Merlin (POG, MadChill, Merlin, example, ivory-ella,
// every future brand) sits in the same broken state.
//
// THE FIX:
// `scaffoldBrandManifest(appRoot, brand)` is called inside `activateBrand`
// (host-side `ctx.activateBrand`, which the merlin-setup skill invokes
// the instant `brand.md` exists). It:
//
//   1. Walks `assets/brands/<brand>/products/*/references/*.{jpg,jpeg,png,webp}`
//      and groups files by product slug.
//   2. Picks up `assets/brands/<brand>/logo/logo.png` (or .svg / .webp) if present.
//   3. Builds a `brand-manifest.json` with paths RELATIVE TO THE MANIFEST
//      (which lives at `assets/brands/<brand>/brand-manifest.json`), so
//      callers passing either cwd-relative or manifest-relative
//      productRefPath both match the binary's
//      brandManifestProductRefMatchesCanonical comparator (which tries
//      both shapes — see brand_manifest.go:365-389).
//   4. Writes atomically (tmp + rename), 0o600 file mode on POSIX.
//
// IDEMPOTENT: re-running on a brand that already has a manifest does
// NOT clobber a hand-curated file. We only write if:
//   (a) the file doesn't exist, OR
//   (b) the file exists but is empty / 0-byte (treated as scaffold-stub).
//
// RE-RUN BEHAVIOR: when products are ADDED to the brand later (bulk
// upload of references, Shopify product import, etc.), the manifest
// gets STALE. The contract is: an explicit `rebuild: true` flag forces
// regeneration. Otherwise, additions outside the scaffolder must be
// applied via subsequent calls. This is conservative on purpose — a
// hand-edited manifest with extra fields (visual_direction, voice
// rules, compliance) MUST NOT be overwritten silently.
//
// NEVER throws. Returns { ok, manifestPath, products, error } so the
// caller can log + proceed regardless. Failing the scaffolder must
// never block brand activation — the binary's no-manifest soft-warn
// path remains the safety net.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REF_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic']);
const LOGO_BASENAMES = ['logo.png', 'logo.svg', 'logo.webp', 'logo.jpg', 'logo.jpeg'];

// Build a display name from a slug — "ivory-ella" → "Ivory Ella",
// "pog_v2" → "Pog V2", "POG" → "POG" (preserves all-caps).
function deriveDisplayName(slug) {
  if (!slug) return '';
  if (slug === slug.toUpperCase()) return slug;
  return slug
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .map((w) => w ? w[0].toUpperCase() + w.slice(1) : '')
    .join(' ')
    .trim();
}

// List image files in a directory, sorted alphabetically. Returns
// basenames (just the filename, no path). Quietly returns [] on any
// I/O error.
function listRefImages(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && REF_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// Look for a brand-level logo. Returns the basename (e.g. "logo.png")
// if found, '' otherwise. Checks each candidate in priority order so
// PNG wins over WEBP for clarity in chat thumbnails.
function findBrandLogo(brandDir) {
  const logoDir = path.join(brandDir, 'logo');
  for (const candidate of LOGO_BASENAMES) {
    const p = path.join(logoDir, candidate);
    try {
      if (fs.statSync(p).isFile()) return candidate;
    } catch { /* skip */ }
  }
  return '';
}

// Discover every product folder. A product folder is any direct
// subdirectory of `assets/brands/<brand>/products/`. Returns slugs
// sorted alphabetically. Slugs that look invalid (start with a dot,
// contain path separators) are skipped.
function listProductSlugs(brandDir) {
  const productsDir = path.join(brandDir, 'products');
  try {
    const entries = fs.readdirSync(productsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && /^[a-z0-9][a-z0-9_-]*$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// Atomic write — tmp + rename. Returns true on success, false on any
// failure (caller logs but does not throw).
function atomicWrite(targetPath, contents) {
  const tmp = targetPath + '.tmp';
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o600 });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
    }
    fs.renameSync(tmp, targetPath);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* clean tmp */ }
    return false;
  }
}

// Build the manifest object. Asset paths are relative to the manifest
// directory (assets/brands/<brand>/), so callers passing the same
// shape from cwd will match via brand_manifest.go's
// brandManifestProductRefMatchesCanonical (which tries both manifest-
// relative and cwd-relative candidates).
function buildManifest(brand, productSlugs, productAssets, logoBasename) {
  const manifest = {
    $schema: 'https://schemas.merlin.tools/brand-manifest/v1.json',
    _scaffold: {
      generated_by: 'app/brand-manifest-scaffolder.js',
      generated_at: new Date().toISOString(),
      hostname: (() => { try { return os.hostname(); } catch { return ''; } })(),
      note: 'Auto-scaffolded on brand_activate. Edit freely — re-running brand_activate will NOT overwrite a hand-curated file. To force regenerate, delete this file or pass {rebuild:true}.',
    },
    brand: {
      id: brand,
      display_name: deriveDisplayName(brand),
    },
    products: productSlugs.map((slug) => {
      const assets = {};
      const refs = productAssets[slug] || [];
      // Use ref_1, ref_2, … as keys so the canonical asset set stays
      // diffable across reference uploads. If the user later renames
      // a reference photo, the keyspace stays stable.
      refs.forEach((basename, i) => {
        assets[`ref_${i + 1}`] = `products/${slug}/references/${basename}`;
      });
      return {
        id: slug,
        display_name: deriveDisplayName(slug),
        assets,
      };
    }),
    generic_assets: logoBasename ? { logo_primary: `logo/${logoBasename}` } : {},
  };
  // Drop empty products[].assets entries — the binary's canonical set
  // skips empty Assets maps, but emitting them as `{}` is noise.
  manifest.products = manifest.products.filter((p) => Object.keys(p.assets).length > 0);
  return manifest;
}

/**
 * Scaffold brand-manifest.json into assets/brands/<brand>/ if missing.
 *
 * @param {string} appRoot   Absolute path to the workspace root (the
 *                            ContentDir; the same `appRoot` main.js
 *                            already uses).
 * @param {string} brand      Brand slug (the directory name under
 *                            assets/brands/).
 * @param {object} [opts]
 * @param {boolean} [opts.rebuild=false]  When true, regenerate even if
 *                            the file already exists. Use sparingly —
 *                            overwrites hand-curated manifests.
 * @returns {{ok: boolean, manifestPath: string, products: number,
 *           hadLogo: boolean, action: string, error?: string}}
 *   action: 'created' | 'rebuilt' | 'skipped-exists' | 'skipped-empty-brand' |
 *           'skipped-no-assets' | 'failed'
 */
function scaffoldBrandManifest(appRoot, brand, opts) {
  const options = opts || {};
  const result = {
    ok: false,
    manifestPath: '',
    products: 0,
    hadLogo: false,
    action: 'failed',
    error: '',
  };

  if (typeof appRoot !== 'string' || !appRoot ||
      typeof brand !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(brand)) {
    result.action = 'skipped-empty-brand';
    result.error = 'invalid appRoot or brand';
    return result;
  }

  const brandDir = path.join(appRoot, 'assets', 'brands', brand);
  const manifestPath = path.join(brandDir, 'brand-manifest.json');
  result.manifestPath = manifestPath;

  // Brand directory must exist for the scaffold to make sense — the
  // caller (activateBrand) already enforces this, but we double-check.
  try {
    if (!fs.statSync(brandDir).isDirectory()) {
      result.action = 'skipped-empty-brand';
      result.error = `brand directory does not exist: ${brandDir}`;
      return result;
    }
  } catch {
    result.action = 'skipped-empty-brand';
    result.error = `brand directory does not exist: ${brandDir}`;
    return result;
  }

  // Idempotency: if the file exists and is non-empty AND rebuild flag
  // is false, do not touch it. Hand-curated manifests with extra
  // fields (visual_direction, voice_rules, compliance) must survive.
  let existingNonEmpty = false;
  try {
    const stat = fs.statSync(manifestPath);
    if (stat.isFile() && stat.size > 0) {
      existingNonEmpty = true;
    }
  } catch { /* file absent — proceed */ }

  if (existingNonEmpty && !options.rebuild) {
    result.ok = true;
    result.action = 'skipped-exists';
    return result;
  }

  // Walk the brand for canonical assets.
  const productSlugs = listProductSlugs(brandDir);
  const productAssets = {};
  for (const slug of productSlugs) {
    productAssets[slug] = listRefImages(path.join(brandDir, 'products', slug, 'references'));
  }
  const logoBasename = findBrandLogo(brandDir);

  // Count canonical assets (sum of all product refs + logo if present).
  // Refuse to scaffold an empty manifest — the binary's enforcement
  // path treats `len(canonical) == 0` as a hard refuse, and we'd
  // ship a manifest that BREAKS image-gen for fresh brands. Better to
  // skip and let the binary's no-manifest soft-warn path remain.
  let canonicalCount = 0;
  for (const slug of productSlugs) canonicalCount += productAssets[slug].length;
  if (logoBasename) canonicalCount += 1;
  if (canonicalCount === 0) {
    result.action = 'skipped-no-assets';
    result.error = 'no product references or logo to anchor the manifest — scaffolder will retry on next brand_activate after assets land';
    return result;
  }

  // Build + write.
  const manifest = buildManifest(brand, productSlugs, productAssets, logoBasename);
  result.products = manifest.products.length;
  result.hadLogo = !!logoBasename;

  const json = JSON.stringify(manifest, null, 2) + '\n';
  if (!atomicWrite(manifestPath, json)) {
    result.action = 'failed';
    result.error = 'atomic write failed (check filesystem permissions on the brand directory)';
    return result;
  }

  result.ok = true;
  result.action = existingNonEmpty ? 'rebuilt' : 'created';
  return result;
}

module.exports = {
  scaffoldBrandManifest,
  // Exposed for tests:
  __deriveDisplayName: deriveDisplayName,
  __listRefImages: listRefImages,
  __findBrandLogo: findBrandLogo,
  __listProductSlugs: listProductSlugs,
  __buildManifest: buildManifest,
};
