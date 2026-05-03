// brand-slug.js — Wave F-5 (Sim 8, Lin "Lalí Cosmetics")
//
// Mirror of autocmo-core/brand_slug.go's SlugifyBrandName. Used by
// the merlin-setup flow to derive the path-safe brand identifier
// from the user's display name. The display name (e.g. "Lalí
// Cosmetics") is preserved verbatim in brand.md; this slug is what
// flows into folder paths, vault keys, and the three regex-checked
// surfaces (mcp-tools.js BRAND_NAME_PATTERN, preload.js BRAND_RE,
// klaviyo_templates.go ^[a-z0-9_-]{1,100}$).
//
// Algorithm: NFKD-decompose, drop combining marks, lowercase,
// non-[a-z0-9] runs → single dash, trim, truncate to 100. Output
// is empty string when no extractable alphanumeric chars (caller
// surfaces a friendly "couldn't derive a folder name" rather than
// crashing on the regex rejection).

'use strict';

function slugifyBrandName(input) {
  if (typeof input !== 'string' || input === '') return '';

  // NFKD splits "í" into "i" + combining acute (U+0301).
  // /\p{M}/gu matches combining marks (Unicode category Mark).
  const folded = input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');

  let out = '';
  let prevDash = false;
  for (const ch of folded) {
    const code = ch.charCodeAt(0);
    if (code >= 0x41 && code <= 0x5a) {
      // A-Z → a-z
      out += String.fromCharCode(code + 32);
      prevDash = false;
    } else if ((code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)) {
      // a-z, 0-9 — passthrough
      out += ch;
      prevDash = false;
    } else if (!prevDash && out.length > 0) {
      out += '-';
      prevDash = true;
    }
  }

  // Trim leading/trailing dashes.
  out = out.replace(/^-+|-+$/g, '');

  if (out.length > 100) {
    out = out.slice(0, 100).replace(/-+$/, '');
  }
  return out;
}

function isValidBrandSlug(s) {
  return typeof s === 'string' && /^[a-z0-9_-]{1,100}$/.test(s);
}

module.exports = { slugifyBrandName, isValidBrandSlug };
