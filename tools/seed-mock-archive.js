// Seeds results/ with mock generated creatives so the Archive + chat
// gallery preview can be exercised end-to-end without running real
// generation pipelines. Dev-only — never bundled.
//
// Layout produced (relative to autoCMO/):
//   results/img/mockbrand/img_<ts>_<i>/portrait.png   <- visible thumb
//   results/img/mockbrand/img_<ts>_<i>/metadata.json  <- archive scanner hooks
//   results/img/mockbrand/loose_<i>.png               <- loose-item path
//
// PNGs are tiny (1×1 solid color, ~70 bytes). The archive scanner only
// reads file size + mtime for indexing, so this is sufficient to drive
// the entire UX. Different colors per item make the stack/viewer show
// visibly different cards.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Build a noisy-textured PNG so each thumb is visibly different AND the
// file is >1KB (the archive scanner's ARCHIVE_MIN_IMAGE_BYTES threshold
// drops anything smaller as a truncated write). 96×96 RGBA with per-pixel
// hue variation around the requested color makes deflate ineffective and
// produces ~30–40KB files — fine for dev seeding.
function makeNoisyPng(baseR, baseG, baseB) {
  const W = 96, H = 96;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(H * (1 + W * 4));
  let off = 0;
  for (let y = 0; y < H; y++) {
    raw[off++] = 0; // filter byte per scanline
    for (let x = 0; x < W; x++) {
      const noise = (Math.random() - 0.5) * 60;
      const dy = (y / H - 0.5) * 50;
      raw[off++] = clamp(baseR + noise + dy);
      raw[off++] = clamp(baseG + noise);
      raw[off++] = clamp(baseB + noise - dy);
      raw[off++] = 255;
    }
  }
  const idatData = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0))]);
}
function clamp(v) { return Math.max(0, Math.min(255, Math.round(v))); }

let _crcTable;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(ROOT, 'results');
// Brand override: pass `--brand <name>` to seed under a specific brand.
// Defaults to the first user brand discovered under assets/brands/ (skips
// `example` so dev seeding doesn't pollute the shipped sample brand).
let BRAND = (() => {
  const idx = process.argv.indexOf('--brand');
  if (idx > -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  const brandsDir = path.join(ROOT, 'assets', 'brands');
  try {
    const entries = fs.readdirSync(brandsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'example') continue;
      return e.name;
    }
  } catch {}
  return 'mockbrand';
})();
const BASE_TS = Date.now() - 1000 * 60 * 60 * 6; // 6 hours ago, count up

const RUN_COUNT = 28;
const LOOSE_COUNT = 6;

fs.mkdirSync(path.join(RESULTS, 'img', BRAND), { recursive: true });

const products = ['Velocity Hoodie', 'Stratus Tote', 'Aurora Jacket', 'Kintsugi Mug', 'Linen Set', 'Polar Beanie'];
const models = ['fal/banana-pro-edit', 'fal/seedance-2', 'fal/flux-pro'];
const angles = ['hidden_cost', 'social_proof_pivot', 'mechanism', 'identity_shift', 'urgency_of_now'];
const formats = ['portrait', 'square'];

console.log('Seeding mock archive in', RESULTS);

for (let i = 0; i < RUN_COUNT; i++) {
  const ts = BASE_TS + i * 1000 * 60 * 12; // 12-min spacing
  // Folder name must match the scanner's ARCHIVE_RUN_FOLDER regex:
  // /^(ad|img)_\d{8}_\d{6}(_v\d+)?$/ — bare timestamp or _v<n> suffix.
  // The 12-min spacing makes every formatTs output unique.
  const folderName = `img_${formatTs(ts)}`;
  const dir = path.join(RESULTS, 'img', BRAND, folderName);
  fs.mkdirSync(dir, { recursive: true });

  // Hue rotates through the spectrum so every card looks different.
  const hue = (i * 360 / RUN_COUNT) % 360;
  const sat = 0.55 + (i % 3) * 0.1;
  const val = 0.78 + (i % 2) * 0.08;
  const [r, g, b] = hsvToRgb(hue, sat, val);
  const png = makeNoisyPng(r, g, b);
  fs.writeFileSync(path.join(dir, 'portrait.png'), png);

  const product = products[i % products.length];
  const angle = angles[i % angles.length];
  const model = models[i % models.length];
  const qaPass = i % 7 !== 6; // ~14% fail QA

  const metadata = {
    type: 'image',
    brand: BRAND,
    product,
    model,
    angle,
    format: formats[i % formats.length],
    timestamp: new Date(ts).toISOString(),
    qaPassed: qaPass,
    qaReason: qaPass ? '' : 'Composition score below threshold',
    files: ['portrait.png'],
    thumbnail: 'portrait.png',
  };
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));

  // Touch mtime so the scanner sorts these by timestamp.
  fs.utimesSync(dir, ts / 1000, ts / 1000);
  console.log(`  [run ${i+1}/${RUN_COUNT}] ${folderName} (${product}, ${model}, qa=${qaPass ? 'pass' : 'fail'})`);
}

// Loose files in the brand root — exercises the legacy / orphan code path.
for (let i = 0; i < LOOSE_COUNT; i++) {
  const ts = BASE_TS + (RUN_COUNT + i) * 1000 * 60 * 12;
  const hue = (180 + i * 24) % 360;
  const [r, g, b] = hsvToRgb(hue, 0.6, 0.85);
  const png = makeNoisyPng(r, g, b);
  const fname = `loose_${formatTs(ts)}_${i}.png`;
  const fullPath = path.join(RESULTS, 'img', BRAND, fname);
  fs.writeFileSync(fullPath, png);
  fs.utimesSync(fullPath, ts / 1000, ts / 1000);
  console.log(`  [loose ${i+1}/${LOOSE_COUNT}] ${fname}`);
}

// Invalidate any cached archive index so the next archive open does a
// fresh scan. The renderer rebuilds on the next loadArchive() call.
const idxPath = path.join(RESULTS, 'archive-index.json');
try { fs.unlinkSync(idxPath); } catch {}

console.log(`\nDone. Seeded ${RUN_COUNT} run folders + ${LOOSE_COUNT} loose files for brand "${BRAND}".`);
console.log('Open the Archive tab in Merlin and switch to the Images filter to see them.');

function formatTs(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
