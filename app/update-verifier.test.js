// Tests for update-verifier.js.
//
// These tests cover the customer-facing contract for update signature
// verification: a valid signature must verify, an invalid/truncated/
// swapped-key/tampered-message signature must NOT, and the bootstrap
// state (empty pubkey) must pass through without enforcement. Every
// assertion here sits on the path a paying user's auto-update runs
// through — a weakening of any branch is a shipped vulnerability.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { verifyChecksumsSignature, _decodePubkey } = require('./update-verifier');

// ─────────────────────────────────────────────────────────────────────
// Test keypair — generated fresh in-memory every test run. The private
// key never touches disk. This is NOT the production key.
// ─────────────────────────────────────────────────────────────────────

function freshKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  // Extract the raw 32-byte public key by exporting as DER SPKI and
  // slicing off the 12-byte algorithm-identifier prefix. Gives us the
  // exact base64 format the production UPDATE_PUBKEY_BASE64 constant uses.
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const rawPub = spki.slice(spki.length - 32);
  return { publicKey, privateKey, rawPubBase64: rawPub.toString('base64') };
}

function signMessage(privateKey, message) {
  // Ed25519 in Node uses digest=null (prehash is built-in).
  const sig = crypto.sign(null, Buffer.from(message, 'utf8'), privateKey);
  return sig.toString('base64');
}

// ─────────────────────────────────────────────────────────────────────
// Happy path + every plausible tampering vector.
// ─────────────────────────────────────────────────────────────────────

test('valid signature over unmodified checksums verifies', () => {
  const kp = freshKeypair();
  const checksums = 'abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd  Merlin-windows-amd64.exe\n';
  const sig = signMessage(kp.privateKey, checksums);
  const r = verifyChecksumsSignature(checksums, sig, kp.rawPubBase64);
  assert.equal(r.ok, true);
  assert.equal(r.enforced, true);
});

test('tampered checksums.txt fails verification (one-byte change)', () => {
  const kp = freshKeypair();
  const checksums = 'abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd  Merlin-windows-amd64.exe\n';
  const sig = signMessage(kp.privateKey, checksums);
  // Flip one character of the hash — simulates an attacker swapping the
  // expected SHA for a different binary they control.
  const tampered = 'abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abce  Merlin-windows-amd64.exe\n';
  const r = verifyChecksumsSignature(tampered, sig, kp.rawPubBase64);
  assert.equal(r.ok, false);
  assert.equal(r.enforced, true);
  assert.match(r.reason, /signature does not match/);
});

test('tampered filename fails verification', () => {
  const kp = freshKeypair();
  const checksums = 'abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd  Merlin-windows-amd64.exe\n';
  const sig = signMessage(kp.privateKey, checksums);
  const tampered = 'abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd  Evil-windows-amd64.exe\n';
  const r = verifyChecksumsSignature(tampered, sig, kp.rawPubBase64);
  assert.equal(r.ok, false);
});

test('signature from different key fails verification', () => {
  const kpSigner = freshKeypair();
  const kpVerifier = freshKeypair();
  const checksums = 'abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd  Merlin-windows-amd64.exe\n';
  const sig = signMessage(kpSigner.privateKey, checksums);
  const r = verifyChecksumsSignature(checksums, sig, kpVerifier.rawPubBase64);
  assert.equal(r.ok, false);
  assert.equal(r.enforced, true);
});

test('truncated signature fails verification with a descriptive reason', () => {
  const kp = freshKeypair();
  const checksums = 'test\n';
  const sig = signMessage(kp.privateKey, checksums);
  const truncated = Buffer.from(sig, 'base64').slice(0, 32).toString('base64');
  const r = verifyChecksumsSignature(checksums, truncated, kp.rawPubBase64);
  assert.equal(r.ok, false);
  assert.match(r.reason, /64 bytes/);
});

test('empty signature fails verification', () => {
  const kp = freshKeypair();
  const r = verifyChecksumsSignature('anything\n', '', kp.rawPubBase64);
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing or empty/);
});

test('empty checksums.txt fails verification even with a valid-looking signature', () => {
  const kp = freshKeypair();
  const sig = signMessage(kp.privateKey, 'something');
  const r = verifyChecksumsSignature('', sig, kp.rawPubBase64);
  assert.equal(r.ok, false);
});

test('garbage base64 signature fails gracefully (no throw)', () => {
  const kp = freshKeypair();
  // Still base64-valid characters but wrong length / garbage — the verify
  // step must return {ok:false} rather than throw into the caller.
  const r = verifyChecksumsSignature('test\n', 'AAAA', kp.rawPubBase64);
  assert.equal(r.ok, false);
  assert.equal(r.enforced, true);
});

// ─────────────────────────────────────────────────────────────────────
// Bootstrap state: empty pubkey means verification is not yet enforced.
// This preserves today's trust level for the first release that ships
// the verifier before Ryan has generated a production key.
// ─────────────────────────────────────────────────────────────────────

test('empty pubkey override returns enforced=false with a descriptive reason', () => {
  const r = verifyChecksumsSignature('whatever\n', 'AAAA', '');
  assert.equal(r.ok, true);
  assert.equal(r.enforced, false);
  assert.match(r.reason, /pubkey not configured/);
});

test('once pubkey is configured, bootstrap mode is no longer available', () => {
  // Safety check: if a PR ever changes the default to pass through when
  // pubkey is set, this test will catch it.
  const kp = freshKeypair();
  // Invalid signature, valid pubkey → must fail, must NOT bootstrap-pass.
  const r = verifyChecksumsSignature('test\n', 'BADBADBADBADBADBAD==', kp.rawPubBase64);
  assert.equal(r.ok, false);
  assert.equal(r.enforced, true);
});

// ─────────────────────────────────────────────────────────────────────
// Pubkey-format hygiene: wrong-length pubkeys must fail loudly at
// decode, not silently produce a verifier that accepts anything.
// ─────────────────────────────────────────────────────────────────────

test('pubkey of wrong length throws from the decoder', () => {
  const tooShort = Buffer.alloc(16).toString('base64');
  assert.throws(
    () => _decodePubkey(tooShort),
    /32 bytes/,
  );
});

test('pubkey decoder produces a usable Node KeyObject for a 32-byte input', () => {
  const kp = freshKeypair();
  const obj = _decodePubkey(kp.rawPubBase64);
  assert.equal(obj.asymmetricKeyType, 'ed25519');
});
