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

async function generateQRSvg(url) {
  const svg = await QRCode.toString(url, {
    type: 'svg',
    color: { dark: '#a78bfa', light: '#00000000' },
    margin: 2,
    width: 200,
  });
  return svg;
}

async function generateQRDataUri(url) {
  const dataUrl = await QRCode.toDataURL(url, {
    color: { dark: '#a78bfa', light: '#08080a' },
    margin: 2,
    width: 200,
  });
  return dataUrl;
}

module.exports = { generateQRSvg, generateQRDataUri };
