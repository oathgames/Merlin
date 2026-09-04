// Engine (Go binary) install primitives — checksum resolution + atomic swap.
//
// REGRESSION GUARD (2026-09-04, engine-update-fail-open + non-atomic-swap):
// `ensureBinary()` in main.js downloads Merlin.exe from the latest GitHub
// release. Two defects lived in that path and both are closed here.
//
//   1. FAIL-OPEN CHECKSUM. The verification block was wrapped in
//      `if (checksumAsset) { ... }`, and inside it in `if (expectedHash)`.
//      A release that published no `checksums.txt`, or a manifest with no
//      line for this platform's asset, therefore installed whatever bytes
//      came back from the network with ZERO integrity check — the exact
//      posture the bootstrapper (Hard-Won Security Rule 15) refuses to
//      take. Rule 15 says the bootstrapper "SHA-verifies every asset it
//      downloads against a pinned checksums.txt"; the Electron side must
//      match, because both write the same executable. `resolveExpectedHash`
//      throws when the manifest is absent, unfetchable, or silent about the
//      asset, and the caller must NOT replace the binary on a throw.
//
//      The thrown message deliberately contains the word "integrity" so
//      renderer.js `humanizeUpdateError` routes it to its
//      /checksum|hash|integrity/ branch ("The update file looks corrupted.
//      Try again in a moment") rather than the generic fallback. If you
//      reword these errors, keep one of those three words in them.
//
//   2. NON-ATOMIC SWAP. The install did `unlinkSync(target)` and THEN
//      `renameSync(tmp, target)`. If the rename failed (AV lock, EPERM on
//      a running binary, cross-device tmp) the user was left with NO engine
//      at all and no way back — every action in the app fails until a full
//      reinstall. `atomicReplaceBinary` writes a `.new` sibling, re-hashes
//      what actually landed on disk, moves the incumbent aside to `.bak`,
//      renames the new file into place, and only then drops the `.bak`.
//      Any failure restores the `.bak`, so the worst case is "update did
//      not apply", never "engine is gone".
//
// Both functions take their `fs` / `crypto` / `httpsGet` collaborators as
// arguments so they can be unit-tested against mocks without an Electron
// runtime. See app/engine-install.test.js.

'use strict';

/**
 * Parse a GitHub-release `checksums.txt` (sha256sum output format) and return
 * the hash for `assetName`, or '' when the manifest carries no line for it.
 *
 * Accepts the `*` binary-mode prefix sha256sum emits (`<hash> *<name>`), and
 * requires exactly 64 hex characters so a truncated or HTML error page can
 * never be mistaken for a manifest.
 */
function expectedHashFor(checksumsText, assetName) {
  if (!checksumsText || !assetName) return '';
  for (const line of String(checksumsText).split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const hash = parts[0];
    const name = parts[1].replace(/^\*/, '');
    if (name !== assetName) continue;
    if (!/^[0-9a-f]{64}$/i.test(hash)) return '';
    return hash.toLowerCase();
  }
  return '';
}

/**
 * Fetch the release's checksums.txt and resolve the expected hash for
 * `assetName`. Retries transient fetch failures, then FAILS CLOSED.
 *
 * @param {object} o
 * @param {object|null} o.checksumAsset  the release asset entry for checksums.txt
 * @param {string} o.assetName           the engine asset we are verifying
 * @param {function} o.httpsGet          async (url) => Buffer|string
 * @param {number} [o.attempts]          total fetch attempts (default 3)
 * @param {function} [o.sleep]           async (ms) => void, injectable for tests
 * @returns {Promise<string>} lowercase 64-hex digest
 * @throws when no manifest exists, none could be fetched, or it omits the asset
 */
async function resolveExpectedHash({ checksumAsset, assetName, httpsGet, attempts = 3, sleep }) {
  // FAIL CLOSED: a release with no manifest is not installable. Do not
  // "proceed unverified" — see the guard block at the top of this file.
  if (!checksumAsset || !checksumAsset.browser_download_url) {
    throw new Error(
      'Cannot verify engine integrity — this release publishes no checksums.txt manifest. Update aborted for security.',
    );
  }
  const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await wait(2000 * attempt);
    let text;
    try {
      text = (await httpsGet(checksumAsset.browser_download_url)).toString();
    } catch (e) {
      lastErr = e;
      continue;
    }
    const hash = expectedHashFor(text, assetName);
    // A manifest that fetched cleanly but names no hash for this asset is a
    // publishing bug, not a transient failure — retrying cannot fix it, and
    // installing anyway is the fail-open hole. Stop immediately.
    if (!hash) {
      throw new Error(
        `Cannot verify engine integrity — checksums.txt has no entry for ${assetName}. Update aborted for security.`,
      );
    }
    return hash;
  }
  throw new Error(
    `Cannot verify engine integrity — checksum manifest unavailable after ${attempts} attempts${lastErr && lastErr.message ? ` (${lastErr.message})` : ''}. Update aborted for security.`,
  );
}

/**
 * Install `buffer` at `targetPath` without ever leaving the path empty.
 *
 * Sequence: write `<target>.new` → re-hash the bytes ON DISK against
 * `expectedHash` → move any incumbent to `<target>.bak` → rename `.new` into
 * place → delete `.bak`. On any failure the `.bak` is restored and the `.new`
 * removed, so the incumbent engine survives a failed update untouched.
 *
 * @param {object} o
 * @param {object} o.fs            node:fs (or a mock)
 * @param {object} o.crypto        node:crypto (or a mock)
 * @param {string} o.targetPath
 * @param {Buffer} o.buffer
 * @param {string} o.expectedHash  lowercase 64-hex digest, REQUIRED
 * @returns {{ replaced: boolean, backedUp: boolean }}
 */
function atomicReplaceBinary({ fs, crypto, targetPath, buffer, expectedHash }) {
  if (!/^[0-9a-f]{64}$/i.test(String(expectedHash || ''))) {
    // Defence in depth: the caller already fails closed, but this function
    // must never be reachable without a digest to check against.
    throw new Error('Cannot verify engine integrity — no expected checksum supplied. Update aborted for security.');
  }
  const newPath = `${targetPath}.new`;
  const bakPath = `${targetPath}.bak`;

  // Clear any debris from a previously interrupted update before writing.
  try { fs.unlinkSync(newPath); } catch {}

  fs.writeFileSync(newPath, buffer);

  // Verify what actually LANDED, not what we intended to write: a truncated
  // write (full disk) or an AV rewrite is exactly the case a pre-write hash
  // of the in-memory buffer would miss.
  let onDisk;
  try {
    onDisk = crypto.createHash('sha256').update(fs.readFileSync(newPath)).digest('hex').toLowerCase();
  } catch (e) {
    try { fs.unlinkSync(newPath); } catch {}
    throw new Error(`Cannot verify engine integrity — staged file unreadable (${e.message}). Update aborted for security.`);
  }
  if (onDisk !== String(expectedHash).toLowerCase()) {
    try { fs.unlinkSync(newPath); } catch {}
    throw new Error(
      `Engine checksum mismatch after write: expected ${String(expectedHash).slice(0, 12)}..., got ${onDisk.slice(0, 12)}...`,
    );
  }

  let backedUp = false;
  let incumbentExists = false;
  try { incumbentExists = fs.existsSync(targetPath); } catch { incumbentExists = false; }
  if (incumbentExists) {
    try { fs.unlinkSync(bakPath); } catch {}
    try {
      fs.renameSync(targetPath, bakPath);
      backedUp = true;
    } catch (e) {
      // Could not move the incumbent aside (locked / in use). Abandon the
      // update: the running engine is more valuable than the new one.
      try { fs.unlinkSync(newPath); } catch {}
      throw new Error(`Engine update could not replace the current binary (${e.message}). Your install is unchanged.`);
    }
  }

  try {
    fs.renameSync(newPath, targetPath);
  } catch (e) {
    if (backedUp) {
      try { fs.renameSync(bakPath, targetPath); } catch {}
    }
    try { fs.unlinkSync(newPath); } catch {}
    throw new Error(`Engine update failed to install (${e.message}). Your install is unchanged.`);
  }

  // Only now is the old copy expendable. A leftover .bak is harmless (the
  // next update clears it) so failure here is not an update failure.
  if (backedUp) { try { fs.unlinkSync(bakPath); } catch {} }

  return { replaced: true, backedUp };
}

module.exports = { expectedHashFor, resolveExpectedHash, atomicReplaceBinary };
