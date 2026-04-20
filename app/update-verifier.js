// update-verifier.js — Ed25519 signature verification for auto-update.
//
// The goal: make a compromise of the GitHub release (stolen token,
// malicious PR merged, CI poisoning) insufficient on its own to ship
// malicious code to paying users. An attacker who can write release
// assets can swap `checksums.txt` and every artifact it covers. What
// they can't do — unless they also have Ryan's offline signing key —
// is produce a valid Ed25519 signature over `checksums.txt`.
//
// This module is the pinned-pubkey verifier. The pubkey below is baked
// into the shipped asar. An attacker who rewrites the key after install
// has already compromised the user's machine directly, which is a
// strictly different (and much harder) attack surface.
//
// Bootstrap behavior: when UPDATE_PUBKEY_BASE64 is the empty string,
// signatures are not yet enforced — the verifier logs a prominent
// warning and allows the update. This preserves today's trust level
// for the first release that ships this code (no-op for existing
// behavior, keeps the door open for key rotation). Once the pubkey
// is populated, signatures become MANDATORY: missing or invalid
// signature aborts the update with the user's on-disk state intact.

'use strict';

const crypto = require('node:crypto');

// ─────────────────────────────────────────────────────────────────────
// REGRESSION GUARD (2026-04-20): the public key below is the anchor of
// trust for all auto-updates shipped to paying users. Rules:
//
//   1. This string is the BASE64 of the raw 32-byte Ed25519 public key.
//      Not base64url. Not hex. Not PEM. Exactly 44 characters including
//      padding, OR the empty string for the bootstrap state described
//      above. Anything else is a bug.
//   2. When the production key is generated (via
//      tools/generate-signing-key), paste the PUBLIC half here and in
//      autocmo-core/bootstrapper/main.go — both MUST match byte-for-byte.
//      An out-of-band drift between installer and app yields a split-
//      brain trust root where bootstrapper accepts releases the app
//      refuses, or vice-versa.
//   3. The matching PRIVATE key MUST never leave Ryan's machine, MUST
//      never land in CI secrets, MUST never be pasted into chat, Slack,
//      issue trackers, or LLM conversations. A key in CI is a key an
//      attacker with CI access has — see the premise above.
//   4. Rotating: generate a new key, update both source constants,
//      ship a release signed by the OLD key that contains the NEW pubkey
//      in-binary. The old pubkey is retired when every user has updated
//      past that release. Do not skip the bridge release — users still
//      on the old pubkey will refuse updates signed by the new one.
// ─────────────────────────────────────────────────────────────────────
const UPDATE_PUBKEY_BASE64 = '';

// ASN.1 SPKI prefix for an Ed25519 public key (RFC 8410). 12 bytes:
//   30 2a                   SEQUENCE, 42 bytes
//     30 05                 SEQUENCE, 5 bytes
//       06 03 2b 65 70      OID 1.3.101.112 (id-Ed25519)
//     03 21                 BIT STRING, 33 bytes
//       00                  unused bits
//     [32 raw bytes follow]
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function pubkeyConfigured() {
  return typeof UPDATE_PUBKEY_BASE64 === 'string' && UPDATE_PUBKEY_BASE64.length > 0;
}

function decodePubkey(base64) {
  const raw = Buffer.from(base64, 'base64');
  if (raw.length !== 32) {
    throw new Error(`Ed25519 pubkey must decode to 32 bytes, got ${raw.length}`);
  }
  const spki = Buffer.concat([SPKI_ED25519_PREFIX, raw]);
  return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

// verifyChecksumsSignature — verifies a detached Ed25519 signature over
// the EXACT bytes of checksums.txt. Returns { ok: true } on success,
// { ok: false, reason } on failure. Throws only on programmer error
// (bad pubkey format in the source constant).
//
// Inputs:
//   checksumsText: string — raw text of checksums.txt as fetched from the
//     release. We sign/verify the UTF-8 bytes of the unmodified file.
//   signatureBase64: string — detached signature, base64 of 64 raw bytes.
//   pubkeyBase64Override (optional): string — override for tests. In
//     production leave undefined so the module-level constant is used.
function verifyChecksumsSignature(checksumsText, signatureBase64, pubkeyBase64Override) {
  const pubkeyB64 = typeof pubkeyBase64Override === 'string'
    ? pubkeyBase64Override
    : UPDATE_PUBKEY_BASE64;

  if (typeof pubkeyB64 !== 'string' || pubkeyB64.length === 0) {
    return {
      ok: true,
      enforced: false,
      reason: 'update-signing pubkey not configured; verification skipped (bootstrap state)',
    };
  }
  if (typeof checksumsText !== 'string' || checksumsText.length === 0) {
    return { ok: false, enforced: true, reason: 'checksums.txt is empty' };
  }
  if (typeof signatureBase64 !== 'string' || signatureBase64.length === 0) {
    return { ok: false, enforced: true, reason: 'signature is missing or empty' };
  }

  let sigRaw;
  try {
    sigRaw = Buffer.from(signatureBase64.trim(), 'base64');
  } catch (e) {
    return { ok: false, enforced: true, reason: `signature base64 decode failed: ${e.message}` };
  }
  if (sigRaw.length !== 64) {
    return { ok: false, enforced: true, reason: `Ed25519 signature must be 64 bytes, got ${sigRaw.length}` };
  }

  let pubkey;
  try {
    pubkey = decodePubkey(pubkeyB64);
  } catch (e) {
    throw new Error(`update-verifier: pubkey is malformed in source. This is a build-time bug. ${e.message}`);
  }

  const message = Buffer.from(checksumsText, 'utf8');
  let valid = false;
  try {
    valid = crypto.verify(null, message, pubkey, sigRaw);
  } catch (e) {
    return { ok: false, enforced: true, reason: `verify threw: ${e.message}` };
  }
  if (!valid) {
    return { ok: false, enforced: true, reason: 'signature does not match checksums.txt contents' };
  }
  return { ok: true, enforced: true };
}

module.exports = {
  verifyChecksumsSignature,
  pubkeyConfigured,
  UPDATE_PUBKEY_BASE64,
  // Exported for tests only:
  _decodePubkey: decodePubkey,
};
