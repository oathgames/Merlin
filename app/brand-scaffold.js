'use strict';

// brand-scaffold.js — dropdown-first brand registration (zero-friction onboarding).
//
// When a user adds a new brand, the brand must appear in the dropdown the
// INSTANT we know the URL — before the website scrape (which can take up to
// 90s and can fail, see Hard-Won Rule 13) and before any enrichment write.
// If setup is interrupted after this point, the brand is already switchable
// and the user can resume instead of starting over.
//
// scaffoldBrandStub creates assets/brands/<brand>/ with a minimal brand.md +
// memory.md when the folder does not already exist. It is the host-side
// primitive behind brand_activate's create-if-missing path. Pure filesystem,
// no Electron — unit-testable directly against a temp dir.
//
// CONTRACT:
//   - Idempotent: if the folder already exists, it is a no-op (returns
//     { created: false }). It NEVER clobbers an existing brand.md / memory.md —
//     enrichment writes (the scrape result) overwrite the stub later via the
//     agent's Write tool, and a re-run must not wipe real brand data.
//   - The stub is a VALID, switchable brand on its own. A user who lands on a
//     half-finished brand sees a clear "setup in progress" note, not a blank
//     or broken folder.
//   - Slug is validated against the same charset the host activateBrand guard
//     uses, so a bad slug fails loudly here rather than creating a junk dir.

const fs = require('node:fs');
const path = require('node:path');

// Mirror the slug guard in main.js activateBrand. Single source would be nicer
// but main.js is not requireable in unit tests (boots Electron); the
// brand-scaffold.test.js pins these two in lockstep.
const BRAND_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function displayNameOf(opts, brand) {
  const dn = opts && opts.displayName != null ? String(opts.displayName).trim() : '';
  return dn || brand;
}

function urlOf(opts) {
  return opts && opts.url != null ? String(opts.url).trim() : '';
}

function stubBrandMd(displayName, url) {
  const lines = [`# ${displayName}`, ''];
  if (url) lines.push(`Website: ${url}`, '');
  lines.push(
    '_Setup in progress — Merlin is building this brand profile. You can switch '
    + 'to this brand at any time. If setup was interrupted, just re-run setup for '
    + 'this brand and Merlin will pick up where it left off — your brand is already saved._',
    '',
  );
  return lines.join('\n');
}

function stubMemoryMd(displayName) {
  return [
    `# ${displayName} — Memory`,
    '',
    '## Run Log',
    '',
    '## What Works',
    '',
    '## What Fails',
    '',
    '## Monthly Spend',
    '',
  ].join('\n');
}

/**
 * Create a minimal switchable brand folder if it does not already exist.
 *
 * @param {string} brandsDir  Absolute path to assets/brands
 * @param {string} brand      Brand slug (validated)
 * @param {{displayName?:string,url?:string}} [opts]
 * @returns {{created:boolean, brandDir:string}}
 * @throws  Error with .code === 'BRAND_INVALID' on a bad slug
 */
function scaffoldBrandStub(brandsDir, brand, opts = {}) {
  if (!brand || !BRAND_SLUG_RE.test(brand)) {
    const e = new Error('Invalid brand slug');
    e.code = 'BRAND_INVALID';
    throw e;
  }
  const brandDir = path.join(brandsDir, brand);

  let exists = false;
  try { exists = fs.statSync(brandDir).isDirectory(); } catch (_) {}
  if (exists) {
    // Already a brand — never clobber. Enrichment / re-runs own the content.
    return { created: false, brandDir };
  }

  const displayName = displayNameOf(opts, brand);
  const url = urlOf(opts);
  fs.mkdirSync(brandDir, { recursive: true });
  fs.writeFileSync(path.join(brandDir, 'brand.md'), stubBrandMd(displayName, url), 'utf8');
  fs.writeFileSync(path.join(brandDir, 'memory.md'), stubMemoryMd(displayName), 'utf8');
  return { created: true, brandDir };
}

module.exports = { scaffoldBrandStub, BRAND_SLUG_RE, stubBrandMd, stubMemoryMd };
