'use strict';

// tile-disconnect.test.js
//
// REGRESSION GUARD (2026-10-17, tile-disconnect): every connection tile in the
// Magic panel can be disconnected with a right-click (or the ContextMenu key /
// Shift+F10), and the disconnect clears exactly one platform for exactly one
// brand. Anchor incident: Snapchat was connected to APOTHEKE instead of
// Forever 21 and there was no reliable way to undo it from the tile.
//
// This file locks three things:
//   1. Registry: every data-platform tile in index.html has a disconnect key
//      list in main.js's keyMap, its data-scope agrees with how main.js
//      decides global vs brand scope, and the key lists cover the engine's
//      platformVaultKeys. A new tile without a mapping fails CI here.
//   2. Behavior: platform-disconnect.applyDisconnect, the scoping core of the
//      IPC handler, never touches another brand, another platform, or the
//      global config on a brand-scoped disconnect.
//   3. Renderer: one context-menu handler, brand captured at open, friendly
//      errors, keyboard access, textContent-only labels.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { applyDisconnect, disconnectScope, stripKeys } = require('./platform-disconnect');

const APP_DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(APP_DIR, f), 'utf8').replace(/\r\n/g, '\n');
const MAIN_JS = read('main.js');
const RENDERER_JS = read('renderer.js');
const INDEX_HTML = read('index.html');

function sliceBetween(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.ok(a >= 0, `marker not found: ${startMarker}`);
  const b = src.indexOf(endMarker, a + startMarker.length);
  assert.ok(b > a, `end marker not found after: ${startMarker}`);
  return src.slice(a, b + endMarker.length);
}

function evalLiteral(code, name) {
  const ctx = {};
  vm.runInNewContext(`${code.replace(/^const /, 'var ')}\n;__out = ${name};`, ctx);
  return ctx.__out;
}

const handlerSrc = sliceBetween(MAIN_JS, "ipcMain.handle('disconnect-platform'", '\n});');
const KEY_MAP = evalLiteral(sliceBetween(handlerSrc, 'const keyMap = {', '\n    };').trim(), 'keyMap');
const BRAND_KEYS = new Set(evalLiteral(sliceBetween(MAIN_JS, 'const BRAND_KEYS = [', '\n];'), 'BRAND_KEYS'));
const UNIVERSAL_KEYS = evalLiteral(sliceBetween(MAIN_JS, 'const UNIVERSAL_KEYS = new Set([', '\n]);'), 'UNIVERSAL_KEYS');
const EXTRA_GLOBAL = evalLiteral(
  sliceBetween(MAIN_JS, 'const DISCONNECT_EXTRA_GLOBAL_KEYS = new Set(', ');'),
  'DISCONNECT_EXTRA_GLOBAL_KEYS');

const isGlobalPlatform = (keys) => keys.length > 0 && keys.every(k => UNIVERSAL_KEYS.has(k) || EXTRA_GLOBAL.has(k));

function tilesFromIndex() {
  const tiles = [];
  const re = /<button class="magic-tile[^"]*"([^>]*)>/g;
  let m;
  while ((m = re.exec(INDEX_HTML))) {
    const attrs = m[1];
    const platform = (attrs.match(/data-platform="([a-z0-9_]+)"/) || [])[1];
    const scope = (attrs.match(/data-scope="([a-z]+)"/) || [])[1] || '';
    if (platform) tiles.push({ platform, scope });
  }
  return tiles;
}

// ── 1. Registry ────────────────────────────────────────────────────────────

test('index.html has connection tiles to check (scan is not vacuous)', () => {
  const tiles = tilesFromIndex();
  assert.ok(tiles.length >= 30, `expected the full tile grid, found ${tiles.length}`);
  assert.equal(tiles.length, (INDEX_HTML.match(/data-platform="/g) || []).length,
    'every data-platform element must be a .magic-tile button the scan can see');
});

test('every data-platform tile has a non-empty disconnect key list in main.js keyMap', () => {
  const missing = tilesFromIndex()
    // shopify_payments is the one deliberate empty entry: it rides the Shopify
    // grant and the handler answers it with an explanatory message.
    .filter(t => !Array.isArray(KEY_MAP[t.platform])
      || (KEY_MAP[t.platform].length === 0 && t.platform !== "shopify_payments"))
    .map(t => t.platform);
  assert.deepEqual(missing, [],
    `tiles with no disconnect mapping: ${missing.join(', ')}. Add them to the keyMap in ` +
    `main.js disconnect-platform, listing every config/vault key the connect flow writes.`);
});

test('tile data-scope="universal" matches how main.js scopes the disconnect', () => {
  const wrong = [];
  for (const t of tilesFromIndex()) {
    const keys = KEY_MAP[t.platform];
    if (!keys || keys.length === 0) continue;
    const global = isGlobalPlatform(keys);
    if (global !== (t.scope === 'universal')) wrong.push(`${t.platform} (tile=${t.scope || 'brand'}, main=${global ? 'global' : 'brand'})`);
  }
  assert.deepEqual(wrong, [], `scope disagreement: ${wrong.join('; ')}`);
});

test('arcads disconnect is global (was missing from the old hand-kept global set)', () => {
  assert.equal(isGlobalPlatform(KEY_MAP.arcads), true);
});

test('brand-scoped keyMap keys are brand-scoped in the vault (BRAND_KEYS)', () => {
  // Keys a brand-scoped platform writes per brand must be in BRAND_KEYS, or
  // buildStrictBrandConfig would leak the global copy back into brand mode
  // after a disconnect. App-level credentials (client id/secret) are global by
  // design and listed here explicitly.
  const APP_LEVEL = new Set(['amazonClientId', 'amazonClientSecret']);
  // Scoped to platforms that have a tile; threads (no tile, rides the Meta
  // grant) is a known BRAND_KEYS gap reported separately.
  const tilePlatforms = new Set(tilesFromIndex().map(t => t.platform));
  const missing = [];
  for (const [platform, keys] of Object.entries(KEY_MAP)) {
    if (!tilePlatforms.has(platform) || isGlobalPlatform(keys)) continue;
    for (const k of keys) {
      if (UNIVERSAL_KEYS.has(k) || APP_LEVEL.has(k) || BRAND_KEYS.has(k)) continue;
      missing.push(`${platform}:${k}`);
    }
  }
  // Report, do not fail, for keys the engine stores that BRAND_KEYS does not
  // yet list; the strict fail is on the token itself.
  const tokens = missing.filter(m => /AccessToken$|ApiKey$/.test(m));
  assert.deepEqual(tokens, [], `brand-scoped credentials missing from BRAND_KEYS: ${tokens.join(', ')}`);
});

test('keyMap covers every key in the engine platformVaultKeys (when engine source is present)', (t) => {
  const candidates = [
    path.resolve(APP_DIR, '../../autocmo-core/oauth.go'),
    path.resolve(APP_DIR, '../../../autocmo-core/oauth.go'),
  ];
  const goPath = candidates.find(p => fs.existsSync(p));
  if (!goPath) { t.skip('autocmo-core not checked out next to the app'); return; }
  const go = fs.readFileSync(goPath, 'utf8').replace(/\r\n/g, '\n');
  const block = sliceBetween(go, 'var platformVaultKeys = map[string][]string{', '\n}');
  const gaps = [];
  const rowRe = /^\s*"([a-z0-9_]+)":\s*\{([^}]*)\}/gm;
  let m;
  let rows = 0;
  while ((m = rowRe.exec(block))) {
    rows++;
    const platform = m[1];
    const goKeys = [...m[2].matchAll(/"([A-Za-z0-9_]+)"/g)].map(x => x[1]);
    const js = KEY_MAP[platform];
    if (!js) { gaps.push(`${platform}: no keyMap entry`); continue; }
    for (const k of goKeys) if (!js.includes(k)) gaps.push(`${platform}:${k}`);
  }
  assert.ok(rows >= 10, `parsed only ${rows} platformVaultKeys rows`);
  assert.deepEqual(gaps, [], `keys the engine stores but disconnect would leave behind: ${gaps.join(', ')}`);
});

test('main.js handler routes through applyDisconnect and derives scope from UNIVERSAL_KEYS', () => {
  assert.match(handlerSrc, /applyDisconnect\(/);
  assert.match(handlerSrc, /UNIVERSAL_KEYS\.has\(k\)/);
  assert.doesNotMatch(handlerSrc, /GLOBAL_KEYS_SET/, 'the hand-kept global key set drifted (arcads); do not reintroduce it');
  assert.match(handlerSrc, /vaultDeleteKeys:[^\n]*vaultDeleteMany/);
});

// ── 2. Behavior ────────────────────────────────────────────────────────────

function makeWorld() {
  const world = {
    global: {
      falApiKey: 'g-fal', snapchatAccessToken: 'legacy-snap', metaAccessToken: 'legacy-meta',
      _tokenTimestamps: { snapchat: 1, meta: 2 },
    },
    brands: {
      apotheke: {
        snapchatAccessToken: 'A-snap', snapchatRefreshToken: 'A-snap-r', snapchatAdAccountId: 'A-acct',
        metaAccessToken: 'A-meta', _tokenTimestamps: { snapchat: 10, meta: 11 },
      },
      forever21: {
        snapchatAccessToken: 'F-snap', snapchatAdAccountId: 'F-acct', metaAccessToken: 'F-meta',
        _tokenTimestamps: { snapchat: 20 },
      },
    },
    vault: {
      '_global/falApiKey': 'g-fal', '_global/snapchatAccessToken': 'g-snap',
      'apotheke/snapchatAccessToken': 'A-snap', 'apotheke/snapchatAdAccountId': 'A-acct',
      'apotheke/metaAccessToken': 'A-meta',
      'forever21/snapchatAccessToken': 'F-snap', 'forever21/snapchatAdAccountId': 'F-acct',
    },
    authCleared: [],
    legacyScrubbed: [],
  };
  const io = {
    readGlobalConfig: () => JSON.parse(JSON.stringify(world.global)),
    writeGlobalConfig: (c) => { world.global = c; },
    readBrandConfig: (b) => (world.brands[b] ? JSON.parse(JSON.stringify(world.brands[b])) : null),
    writeBrandConfig: (b, c) => { world.brands[b] = c; },
    vaultDeleteKeys: (scope, keys) => {
      let n = 0;
      for (const k of keys) {
        const id = `${scope}/${k}`;
        if (Object.prototype.hasOwnProperty.call(world.vault, id)) { delete world.vault[id]; n++; }
      }
      return n;
    },
    scrubLegacyTokens: (b, keys) => world.legacyScrubbed.push([b, keys]),
    clearAuthFailure: (p, b) => world.authCleared.push([p, b]),
  };
  return { world, io };
}

test('disconnecting Snapchat from APOTHEKE leaves Forever 21, other platforms, and global intact', () => {
  const { world, io } = makeWorld();
  const keys = KEY_MAP.snapchat;
  assert.ok(keys.includes('snapchatAccessToken'));
  const res = applyDisconnect({ platform: 'snapchat', brandName: 'apotheke', keys, isGlobalPlatform: isGlobalPlatform(keys) }, io);
  assert.equal(res.scope, 'brand');
  assert.equal(res.brand, 'apotheke');

  // APOTHEKE snapchat gone (config, timestamps, vault), APOTHEKE meta kept.
  const a = world.brands.apotheke;
  assert.equal(a.snapchatAccessToken, undefined);
  assert.equal(a.snapchatRefreshToken, undefined);
  assert.equal(a.snapchatAdAccountId, undefined, 'selected account id must clear so reconnect re-discovers');
  assert.equal(a._tokenTimestamps.snapchat, undefined);
  assert.equal(a.metaAccessToken, 'A-meta');
  assert.equal(a._tokenTimestamps.meta, 11);
  assert.equal(world.vault['apotheke/snapchatAccessToken'], undefined);
  assert.equal(world.vault['apotheke/snapchatAdAccountId'], undefined);
  assert.equal(world.vault['apotheke/metaAccessToken'], 'A-meta');

  // Forever 21 untouched.
  assert.deepEqual(world.brands.forever21, makeWorld().world.brands.forever21);
  assert.equal(world.vault['forever21/snapchatAccessToken'], 'F-snap');
  assert.equal(world.vault['forever21/snapchatAdAccountId'], 'F-acct');

  // Global config and _global vault untouched by a brand disconnect.
  assert.deepEqual(world.global, makeWorld().world.global);
  assert.equal(world.vault['_global/snapchatAccessToken'], 'g-snap');
  assert.equal(world.vault['_global/falApiKey'], 'g-fal');

  assert.deepEqual(world.authCleared, [['snapchat', 'apotheke']]);
  assert.equal(world.legacyScrubbed[0][0], 'apotheke');
  assert.equal(res.vaultCleared, 2);
});

test('universal platform disconnect clears only global config + _global vault', () => {
  const { world, io } = makeWorld();
  const keys = KEY_MAP.fal;
  assert.equal(isGlobalPlatform(keys), true);
  const res = applyDisconnect({ platform: 'fal', brandName: 'apotheke', keys, isGlobalPlatform: true }, io);
  assert.equal(res.scope, 'global');
  assert.equal(world.global.falApiKey, undefined);
  assert.equal(world.vault['_global/falApiKey'], undefined);
  assert.equal(world.global.snapchatAccessToken, 'legacy-snap');
  assert.deepEqual(world.brands, makeWorld().world.brands);
  assert.deepEqual(world.authCleared, [['fal', '']]);
});

test('legacy no-brand disconnect clears the global copy only', () => {
  const { world, io } = makeWorld();
  const res = applyDisconnect({ platform: 'snapchat', brandName: '', keys: KEY_MAP.snapchat, isGlobalPlatform: false }, io);
  assert.equal(res.scope, 'legacy-global');
  assert.equal(world.global.snapchatAccessToken, undefined);
  assert.equal(world.global._tokenTimestamps.snapchat, undefined);
  assert.equal(world.global.metaAccessToken, 'legacy-meta');
  assert.equal(world.global._tokenTimestamps.meta, 2);
  assert.deepEqual(world.brands, makeWorld().world.brands);
});

test('missing brand config file is not an error; vault is still cleared', () => {
  const { world, io } = makeWorld();
  world.vault['newbrand/snapchatAccessToken'] = 'N';
  const res = applyDisconnect({ platform: 'snapchat', brandName: 'newbrand', keys: KEY_MAP.snapchat, isGlobalPlatform: false }, io);
  assert.equal(res.configChanged, false);
  assert.equal(res.vaultCleared, 1);
  assert.equal(world.vault['forever21/snapchatAccessToken'], 'F-snap');
});

test('every tile disconnect, for every brand-scoped platform, stays inside its brand', () => {
  for (const t of tilesFromIndex()) {
    const keys = KEY_MAP[t.platform];
    if (keys.length === 0 || isGlobalPlatform(keys)) continue;
    const { world, io } = makeWorld();
    const before = JSON.stringify({ g: world.global, f: world.brands.forever21 });
    const beforeVault = Object.entries(world.vault).filter(([k]) => !k.startsWith('apotheke/'));
    applyDisconnect({ platform: t.platform, brandName: 'apotheke', keys, isGlobalPlatform: false }, io);
    assert.equal(JSON.stringify({ g: world.global, f: world.brands.forever21 }), before, `${t.platform} touched another scope`);
    for (const [k, v] of beforeVault) assert.equal(world.vault[k], v, `${t.platform} removed ${k}`);
  }
});

test('scope helpers and guards', () => {
  assert.equal(disconnectScope({ brandName: 'x', isGlobalPlatform: true }), 'global');
  assert.equal(disconnectScope({ brandName: 'x', isGlobalPlatform: false }), 'brand');
  assert.equal(disconnectScope({ brandName: '', isGlobalPlatform: false }), 'legacy-global');
  assert.throws(() => applyDisconnect({ platform: 'snapchat', brandName: 'a', keys: [] }, {}));
  assert.equal(stripKeys(null, ['a'], 'p'), false);
});

// ── 3. Renderer ────────────────────────────────────────────────────────────

test('renderer has exactly one tile context-menu handler', () => {
  assert.doesNotMatch(RENDERER_JS, /disconnectHandlerAttached/, 'old panel-level Disconnect listener must stay removed');
  const tileCtx = RENDERER_JS.match(/addEventListener\('contextmenu',\s*\(e\)\s*=>\s*\{\s*const tile = e\.target\.closest\('\.magic-tile'\)/g) || [];
  assert.equal(tileCtx.length, 1, 'exactly one document contextmenu listener may own .magic-tile');
});

function fnBody(name) {
  return sliceBetween(RENDERER_JS, `function ${name}(`, '\n}\n');
}

test('menu label names platform and brand; brand captured when the menu opens', () => {
  const build = fnBody('buildTileMenuItems');
  assert.match(build, /const brand = getActiveBrandSelection\(\)/);
  assert.match(build, /`Disconnect \$\{name\} from \$\{brandLabel\}`/);
  assert.match(build, /`Disconnect \$\{name\} \(all brands\)`/);
  assert.match(build, /confirmTileDisconnect\(tile, platform, name, brand, brandLabel, isUniversal\)/);
  assert.match(build, /tile\.dataset\.connStatus/);
  const confirm = fnBody('confirmTileDisconnect');
  assert.match(confirm, /merlin\.disconnectPlatform\(platform, isUniversal \? '' : brand\)/,
    'the IPC must send the brand captured at open, never re-read the selector');
  assert.doesNotMatch(confirm.split('onConfirm')[1].split('disconnectPlatform')[0], /getActiveBrandSelection/);
});

test('disconnect failures go through friendlyErrorPlain (Rule 6)', () => {
  const confirm = fnBody('confirmTileDisconnect');
  assert.match(confirm, /friendlyErrorPlain\(raw, name\)/);
  assert.doesNotMatch(confirm, /innerHTML/);
});

test('menu items use textContent, never innerHTML', () => {
  const open = fnBody('openTileContextMenu');
  assert.match(open, /el\.textContent = item\.label/);
  assert.doesNotMatch(open, /innerHTML/);
  assert.match(open, /tile-context-menu/, 'class keeps the magic panel from closing on item click');
  assert.match(open, /role', 'menuitem'/);
});

test('keyboard: ContextMenu key and Shift+F10 open the menu; Escape closes', () => {
  assert.match(RENDERER_JS, /e\.key === 'ContextMenu' \|\| \(e\.shiftKey && e\.key === 'F10'\)/);
  const open = fnBody('openTileContextMenu');
  assert.match(open, /ev\.key === 'Escape'/);
  assert.match(open, /ArrowDown/);
});

test('loadConnections records connStatus even for awaiting-client-id tiles', () => {
  assert.match(RENDERER_JS, /delete t\.dataset\.connStatus/);
  assert.match(RENDERER_JS, /tile\.dataset\.connStatus = status/);
});
