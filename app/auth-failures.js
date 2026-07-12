// auth-failures.js: per-platform-per-brand revoked-grant flags.
//
// Why this exists (2026-07-11 audit fix): getConnections in main.js marked a
// platform 'expired' purely by token AGE (55 days since the last OAuth
// exchange). A grant revoked server-side (user removed the app in the
// platform's security settings, password change, platform-side token sweep)
// returns 401 / token-expired on every call while the tile stays green: the
// user sees "connected" while every action fails. The MCP layer already
// classifies those raw errors as TOKEN_EXPIRED (mcp-errors.js); this store
// persists that signal so getConnections can downgrade the tile to
// 'expired' and the existing expired-tile reconnect UX takes over.
//
// Storage: the `authFailures` key of the app state file (.merlin-state.json
// via the injected readState/writeState from main.js), shaped
//   { "<platform>|<brand-or-_global>": <flaggedAtMs> }
// Scope mirrors the credential scope: brand-scoped platforms flag under the
// brand slug, global platforms (and brand-less legacy setups) under
// '_global'.
//
// Lifecycle:
//   mark(platform, brand) : MCP layer saw TOKEN_EXPIRED for this platform.
//   clear(platform, brand): OAuth completed for the platform (main.js
//                            applyExchangeResult / fast-open success) or any
//                            action for it succeeded (runBinary success).
//   applyToConnections()  : final overlay inside getConnections.
// onChange fires only on real mutations (a repeat mark or a clear of an
// absent key is a no-op) so connections-changed broadcasts never spam.

'use strict';

function scopeKey(platform, brandName) {
  return `${platform}|${brandName || '_global'}`;
}

function createAuthFailureStore(deps) {
  const d = deps || {};
  const readState = d.readState;
  const writeState = d.writeState;
  const onChange = d.onChange;
  if (typeof readState !== 'function' || typeof writeState !== 'function') {
    throw new Error('createAuthFailureStore requires readState and writeState');
  }

  function snapshot() {
    try {
      const s = readState() || {};
      return (s.authFailures && typeof s.authFailures === 'object' && !Array.isArray(s.authFailures))
        ? s.authFailures
        : {};
    } catch {
      return {};
    }
  }

  function emitChange() {
    try { if (typeof onChange === 'function') onChange(); } catch {}
  }

  // Flag a revoked/expired grant. Returns true when the store changed.
  function mark(platform, brandName) {
    if (typeof platform !== 'string' || !platform) return false;
    const flags = { ...snapshot() };
    const key = scopeKey(platform, brandName);
    if (flags[key]) return false; // already flagged: no rewrite, no rebroadcast
    flags[key] = Date.now();
    try { writeState({ authFailures: flags }); } catch { return false; }
    emitChange();
    return true;
  }

  // Clear the flag (successful reconnect or successful action). Returns
  // true when the store changed.
  function clear(platform, brandName) {
    if (typeof platform !== 'string' || !platform) return false;
    const flags = { ...snapshot() };
    const key = scopeKey(platform, brandName);
    if (!(key in flags)) return false;
    delete flags[key];
    try { writeState({ authFailures: flags }); } catch { return false; }
    emitChange();
    return true;
  }

  // Overlay for getConnections: downgrade 'connected' entries to 'expired'
  // when the platform is flagged for this brand scope. Statuses other than
  // 'connected' are left alone (slack's 'expired'-as-needs-setup, the
  // 55-day age path, etc.). Mutates and returns the array.
  function applyToConnections(connected, brandName) {
    if (!Array.isArray(connected)) return connected;
    const flags = snapshot();
    for (const entry of connected) {
      if (!entry || entry.status !== 'connected') continue;
      if (flags[scopeKey(entry.platform, brandName)]) entry.status = 'expired';
    }
    return connected;
  }

  return { mark, clear, applyToConnections, _snapshot: snapshot };
}

module.exports = { createAuthFailureStore, scopeKey };
