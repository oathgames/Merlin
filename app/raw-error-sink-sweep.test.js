// raw-error-sink-sweep.test.js — REGRESSION GUARD (2026-06-30, Rule 6 sweep)
//
// Hard-Won Security Rule 6: no raw API/Go/JSON/stack/HTTP error string reaches a
// user surface. This locks the producers + sinks fixed in the v1.31.6 sweep so a
// future edit can't reintroduce a raw leak into chat bubbles, modals, or panels.
//
// Pure source-scan.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const R = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

test('auth-flow chat sinks route through friendlyErrorPlain (not raw result.error / e.message)', () => {
  const i = R.indexOf('[auth] triggerClaudeLogin threw');
  assert.ok(i >= 0, 'auth catch anchor not found');
  const around = R.slice(i - 400, i + 260);
  // The else-branch setStatus must wrap the login error, and the catch must wrap e.message.
  assert.ok(/setStatus\(friendlyErrorPlain\(err, 'Claude'\)\)/.test(around),
    'runAuthRequiredFlow login-failed path must wrap err via friendlyErrorPlain');
  assert.ok(/setStatus\(friendlyErrorPlain\(\(e && e\.message\)/.test(around),
    'runAuthRequiredFlow catch must wrap e.message via friendlyErrorPlain, never append it raw');
  assert.ok(!/setStatus\('Sign-in failed unexpectedly\. ' \+/.test(around),
    'the raw "Sign-in failed unexpectedly. " + e.message concat must be gone');
});

test('meta-discover modal routes d.error / r1.error through friendlyError', () => {
  const i = R.indexOf('await merlin.discoverMetaIds(activeBrand)');
  assert.ok(i >= 0, 'meta-discover anchor not found');
  const around = R.slice(i - 300, i + 500);
  assert.ok(/showModalError\(friendlyError\(d\.error, 'Meta'\)\)/.test(around),
    'discover error must route through friendlyError (has a Command-failed branch)');
  assert.ok(/showModalError\(friendlyError\(r1\.error/.test(around),
    'save-token error must route through friendlyError');
});

test('QR relayError is a boolean marker, never a sliced raw exception', () => {
  // Producer: no String(e).slice(...) into relayError.
  assert.ok(/relayError:\s*true/.test(MAIN), 'producer must send relayError: true (boolean marker)');
  assert.ok(!/relayError:\s*String\(/.test(MAIN),
    'producer must NOT slice a raw exception into relayError (the Rule 6 anti-pattern)');
  // Sink: the QR note must not interpolate ${payload.relayError}.
  assert.ok(!/\$\{payload\.relayError\}/.test(R),
    'QR note must not interpolate the raw relayError value');
});

test('billing + activate-key + config-field producers never return raw stderr/err.message', () => {
  // billing network catch → friendly, not err.message
  assert.ok(!/text: `Could not reach billing portal \(\$\{err/.test(MAIN),
    'billing network catch must not embed raw err.message');
  // activate-key → no `Server returned ${status}` and no raw err?.message default
  const ak = MAIN.slice(MAIN.indexOf("ipcMain.handle('activate-key'"), MAIN.indexOf("ipcMain.handle('activate-key'") + 2100);
  assert.ok(!/error: err\?\.message \|\| 'network error'/.test(ak),
    'activate-key catch must not return raw err.message');
  assert.ok(/Could not reach the activation server/.test(ak),
    'activate-key catch must return a friendly network message');
  // save-config-field catch → friendly, not err.message
  const scf = MAIN.slice(MAIN.indexOf("ipcMain.handle('save-config-field'"), MAIN.indexOf("ipcMain.handle('save-config-field'") + 2000);
  assert.ok(/error: 'Could not save that\. Please try again\.'/.test(scf),
    'save-config-field catch must return a friendly message, not err.message');
});

test('login-failed producer does not embed raw CLI stderr in the user string', () => {
  const i = MAIN.indexOf("'[claude-login] verification failed: exit'");
  assert.ok(i >= 0, 'login verification-failed log anchor not found');
  const around = MAIN.slice(i, i + 400);
  assert.ok(/reason = code === 0[\s\S]*'Sign-in did not complete\. Please try again\.'/.test(around),
    'non-zero exit must yield a friendly reason, never `exited with code N: <stderr>`');
});

test('oauth exchange failure prefers Go friendly stderr, never raw Node err.message', () => {
  const i = MAIN.indexOf("'[oauth] exchange failed:'");
  assert.ok(i >= 0, 'oauth exchange-failed log anchor not found');
  const around = MAIN.slice(i - 120, i + 320);
  assert.ok(/goMsg \|\| 'Could not finish connecting\. Please try again\.'/.test(around),
    'oauth exchange error must fall back to a friendly message, not raw err.message');
});
