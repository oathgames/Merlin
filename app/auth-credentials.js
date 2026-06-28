// auth-credentials.js — pure, testable helpers for parsing the Claude
// Code OAuth credentials JSON and deciding whether the file-based
// credentials carry the refresh capability needed for silent renewal.
//
// Why a separate module: main.js is heavy (Electron imports, os, fs,
// child_process, ipcMain, etc.) and cannot be loaded in plain Node
// unit tests. These two helpers are the load-bearing pieces of the
// 2026-04-27 silent-refresh fix — keeping them isolated lets the tests
// in app/auth-credentials.test.js exercise every expiry / refresh
// branch without booting Electron.
//
// Stays in lockstep with main.js: the helpers are required from main.js,
// so any drift would be caught immediately by the canary tests.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_CRED_FILE = path.join(os.homedir(), '.claude', '.credentials.json');

// REGRESSION GUARD (2026-04-27, sdk-token-silent-refresh):
// extractToken MUST NOT auto-reject expired tokens that still carry a
// refreshToken. The Claude Agent SDK refreshes silently against
// platform.claude.com/v1/oauth/token using the refreshToken stored in the
// SAME credentials file — but only if Merlin actually hands the file off
// to the SDK. The previous early-rejection here turned every token expiry
// into a forced full browser sign-in, regardless of whether refresh was
// possible. Live incident 2026-04-27 was the symptom.
//
// Contract: returns either null (no usable accessToken) OR
//   { token, raw, expiresAt, refreshable }
// where:
//   - token: the access token string (may be past expiresAt — caller decides)
//   - raw: the original JSON string, suitable to persist via persistCredentials
//   - expiresAt: epoch ms (number) or null if unknown
//   - refreshable: true iff a non-empty refreshToken is present alongside —
//                  the SDK can refresh autonomously when the SDK reads the
//                  credentials file directly (i.e. when CLAUDE_CODE_OAUTH_TOKEN
//                  env is NOT injected)
//
// DO NOT re-introduce expiry rejection here. If a non-refreshable token is
// past expiry, the SDK itself will hit a 401 and Merlin's auth-error
// interceptor in startSession() routes through requireAuth() — the correct
// UX for that case.
function extractToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    return null;
  }
  // Handle both { claudeAiOauth: { accessToken } } and { accessToken } formats.
  const oauth = (creds && creds.claudeAiOauth) || creds;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
  let expiresAt = null;
  if (oauth.expiresAt !== undefined && oauth.expiresAt !== null) {
    const ms = typeof oauth.expiresAt === 'number'
      ? oauth.expiresAt
      : new Date(oauth.expiresAt).getTime();
    if (!isNaN(ms)) expiresAt = ms;
  }
  const refreshable = typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0;
  return { token: oauth.accessToken, raw, expiresAt, refreshable };
}

// REGRESSION GUARD (2026-04-27, sdk-token-silent-refresh):
// readFileCredentialsForSession is the FAST file-only probe used by
// startSession() to decide whether to inject CLAUDE_CODE_OAUTH_TOKEN env
// into the SDK subprocess.
//
//   - If the canonical file (~/.claude/.credentials.json) holds a blob
//     with both accessToken AND refreshToken, the SDK can refresh
//     autonomously by reading the file. In that case startSession MUST
//     skip env injection, because the SDK's env-fed code path explicitly
//     returns {refreshToken:null} and disables refresh.
//
//   - If the file is missing, malformed, or has no refresh capability,
//     this returns null and the caller falls back to readCredentials()
//     (keychain / win alt-paths / env), which returns just the access
//     token — the SDK then runs in env-token mode without refresh, and a
//     future expiry triggers Merlin's existing requireAuth() flow.
//
// Sync (no await) so it's safe to call in the hot path of startSession
// without adding any wall-clock budget. Optional `deps` arg is for
// tests — production callers omit it.
function readFileCredentialsForSession(deps) {
  const _fs = (deps && deps.fs) || fs;
  const _persist = deps && deps.persist;
  const homeDir = (deps && deps.homeDir) || os.homedir();
  const canonical = path.join(homeDir, '.claude', '.credentials.json');
  const candidates = [
    canonical,
    path.join(homeDir, '.claude', 'credentials.json'), // no-dot variant
  ];
  // REGRESSION GUARD (2026-06-28, windows-altpath-tier1): on Windows the Claude
  // CLI (older versions) may store the blob under %APPDATA%/%LOCALAPPDATA%\
  // Claude[ Code]\.credentials.json. If such a blob is REFRESHABLE, promote it
  // to Tier-1 (the SDK silent-refresh path) and normalize it to the canonical
  // path below — instead of letting it fall through to readCredentials(), which
  // returns a bare token and pins the user to Tier-2 (no refresh → forced
  // re-auth on every expiry). deps.platform/appData/localAppData are test seams.
  const platform = (deps && deps.platform) || process.platform;
  if (platform === 'win32') {
    const appData = (deps && deps.appData) || process.env.APPDATA || '';
    const localAppData = (deps && deps.localAppData) || process.env.LOCALAPPDATA || '';
    for (const base of [appData, localAppData]) {
      if (!base) continue;
      candidates.push(path.join(base, 'Claude', '.credentials.json'));
      candidates.push(path.join(base, 'Claude Code', '.credentials.json'));
    }
  }
  for (const file of candidates) {
    let raw;
    try {
      raw = _fs.readFileSync(file, 'utf8').trim();
    } catch {
      continue;
    }
    const parsed = extractToken(raw);
    if (parsed && parsed.refreshable) {
      // Normalize to the canonical path so the SDK reads the same file we
      // just validated. Skip if already canonical.
      if (file !== canonical && _persist) {
        try { _persist(parsed.raw); } catch {}
      }
      const expired = typeof parsed.expiresAt === 'number'
        ? Date.now() > parsed.expiresAt
        : false;
      return {
        source: 'file',
        token: parsed.token,
        expiresAt: parsed.expiresAt,
        expired,
        refreshable: true,
      };
    }
  }
  return null;
}

module.exports = {
  CLAUDE_CRED_FILE,
  extractToken,
  readFileCredentialsForSession,
};
