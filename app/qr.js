// Minimal QR code generator — SVG output, no dependencies
// Based on the QR code spec for alphanumeric mode, simplified for URLs

// We'll use a tiny vendored QR encoder. For URLs up to ~200 chars,
// version 6 (41x41) with error correction L is sufficient.
// Rather than implementing the full QR spec, we generate via a
// well-known algorithm approach using the 'qrcode' npm package
// which is tiny (17KB, zero deps).

// Since we want zero external deps for this module, we'll generate
// a simple text-based representation and render as SVG.

// Actually — let's just use the `qrcode` package (zero deps, 17KB).
// It's worth the tradeoff vs implementing QR encoding from scratch.
const QRCode = require('qrcode');

// Brand-purple modules on a transparent background — the QR then inherits
// whatever background the modal card provides, so it reads correctly on both
// dark (#0e0e10) and light (#fafaff) themes without the hard-coded black
// square that previously shipped.
const QR_BRAND_DARK = '#a78bfa';
const QR_BRAND_LIGHT = '#00000000';

async function generateQRSvg(url) {
  const svg = await QRCode.toString(url, {
    type: 'svg',
    color: { dark: QR_BRAND_DARK, light: QR_BRAND_LIGHT },
    margin: 2,
    width: 200,
  });
  return svg;
}

// Returns an SVG data URI (not a PNG) so the transparent background is
// preserved and the QR scales crisply. The modal's .qr-image CSS constrains
// the display size, so the 200px intrinsic width is irrelevant.
async function generateQRDataUri(url) {
  const svg = await generateQRSvg(url);
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

module.exports = { generateQRSvg, generateQRDataUri };
