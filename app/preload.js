const { contextBridge, ipcRenderer } = require('electron');
const fsNode = require('fs');
const pathNode = require('path');

// ── Fact-binding rollout gate (MUST run before renderer.js evaluates) ──
//
// `factBindingEnabled` in renderer.js is a `const` resolved at module-init
// time (see the Phase 12 rollout comment there). It reads
// `window.__merlinFactBindingForceOn === true` exactly once. Preload
// scripts evaluate BEFORE the renderer <script src="renderer.js"> tag
// runs, so this is the ONLY place we can set that flag early enough for
// the const to capture true.
//
// Previously this flag-set lived in main.js inside a `ready-to-show`
// handler that pushed `window.__merlinFactBindingForceOn = true` via
// `win.webContents.executeJavaScript(...)`. That fires AFTER renderer.js
// has already evaluated — meaning `factBindingEnabled` already captured
// false, and every downstream helper short-circuited to a no-op. Real
// users on v1.12.0 got fact-binding disabled despite shipping with
// `version.json.featureFlags.factBinding: true`. Moving the decision
// into preload fixes that timing bug AND lets us use the clean IPC
// bridge below (see `merlinFactBinding.onInit`) instead of an
// executeJavaScript source string that interpolates the HMAC key.
//
// REGRESSION GUARD (2026-04-18): do NOT move this read back into
// main.js's `ready-to-show` handler — the flag must be set pre-renderer.
// If you need the main-process copy of the decision (e.g. to gate the
// session-prelude binary spawn), duplicate the read in main.js; both
// sides must agree on the same version.json/env signals.
try {
  let factOn = false;
  try {
    const v = JSON.parse(fsNode.readFileSync(pathNode.resolve(__dirname, '..', 'version.json'), 'utf8'));
    if (v && v.featureFlags && v.featureFlags.factBinding === true) factOn = true;
  } catch { /* missing / malformed version.json — stay off */ }
  if (process.env.MERLIN_FACT_BINDING === '1') factOn = true;
  if (factOn) {
    // exposeInMainWorld freezes the property on `window` — the renderer
    // sees `window.__merlinFactBindingForceOn === true` synchronously
    // before its own scripts run. A true primitive, no accessor that
    // could leak additional state.
    contextBridge.exposeInMainWorld('__merlinFactBindingForceOn', true);
  }
} catch { /* preload must never block window creation */ }

// ── IPC Input Validation ──────────────────────────────────────
// Defense-in-depth: validate types and lengths before forwarding
// to main process. Prevents renderer-side injection/flood attacks.
const MAX_STR = 10000;
const MAX_TEXT = 50000;
const BRAND_RE = /^[a-z0-9_-]{1,100}$/i;
const PLATFORM_RE = /^[a-z0-9_-]{1,50}$/i;

function assertStr(v, max = MAX_STR) {
  if (typeof v !== 'string' || v.length > max) throw new Error('invalid string argument');
  return v;
}
function assertBrand(v) {
  // Empty string is a legitimate "no brand / global scope" marker used
  // throughout the renderer (e.g. `brandSelect?.value || ''`) and matched
  // in main by `brand || ''`. Treat it identically to null/undefined so
  // first-run and global-config flows don't throw synchronously here.
  if (v === undefined || v === null || v === '') return v;
  if (typeof v !== 'string' || !BRAND_RE.test(v)) throw new Error('invalid brand');
  return v;
}
function assertPlatform(v) {
  if (typeof v !== 'string' || !PLATFORM_RE.test(v)) throw new Error('invalid platform');
  return v;
}
function assertInt(v, defaultValue) {
  // Undefined → use default (no silent coercion of valid 0 values).
  if (v === undefined || v === null) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error('missing integer argument');
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error('invalid integer');
  return v;
}
function assertObj(v) {
  if (v === undefined || v === null) return v;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid object');
  return v;
}
function assertBrandArray(v) {
  if (!Array.isArray(v)) throw new Error('invalid brand array');
  if (v.length > 200) throw new Error('too many brands');
  for (const b of v) {
    if (typeof b !== 'string' || !BRAND_RE.test(b)) throw new Error('invalid brand in array');
  }
  return v;
}
function assertCron(v) {
  if (typeof v !== 'string' || v.length > 50) throw new Error('invalid cron');
  const parts = v.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron must have 5 fields');
  if (/^\*\/1?\s/.test(v.trim()) || v.trim() === '* * * * *') throw new Error('cron expression runs too frequently');
  return v;
}

contextBridge.exposeInMainWorld('merlin', {
  // Platform
  platform: process.platform,

  // Version
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Window controls
  winMinimize: () => ipcRenderer.invoke('win-minimize'),
  winMaximize: () => ipcRenderer.invoke('win-maximize'),
  winClose: () => ipcRenderer.invoke('win-close'),

  // Subscription
  getSubscription: () => ipcRenderer.invoke('get-subscription'),
  openSubscribe: () => ipcRenderer.invoke('open-subscribe'),
  openManage: () => ipcRenderer.invoke('open-manage'),
  activateKey: (key) => ipcRenderer.invoke('activate-key', assertStr(key, 200)),
  checkSubscriptionStatus: () => ipcRenderer.invoke('check-subscription-status'),

  // Setup + Install
  checkSetup: (force) => ipcRenderer.invoke('check-setup', !!force),
  installClaude: () => ipcRenderer.invoke('install-claude'),
  setApiKey: (key) => ipcRenderer.invoke('set-api-key', assertStr(key, 500)),
  hasApiKey: () => ipcRenderer.invoke('has-api-key'),
  openClaudeDownload: () => ipcRenderer.invoke('open-claude-download'),
  openMerlinFolder: () => ipcRenderer.invoke('open-merlin-folder'),
  checkTosAccepted: () => ipcRenderer.invoke('check-tos-accepted'),
  acceptTos: (opts) => ipcRenderer.invoke('accept-tos', assertObj(opts)),

  // Mobile
  getMobileQR: () => ipcRenderer.invoke('get-mobile-qr'),

  // Session
  startSession: () => ipcRenderer.invoke('start-session'),
  // REGRESSION GUARD (2026-04-24, stale-resume-graceful): clears the
  // persisted resume UUID for the active brand, then starts fresh. Used
  // by the renderer fail-fast branch on stale-resume SDK errors so we
  // don't loop retrying the same broken sessionId.
  startFreshSession: () => ipcRenderer.invoke('start-fresh-session'),
  stopGeneration: () => ipcRenderer.invoke('stop-generation'),
  getAccountInfo: () => ipcRenderer.invoke('get-account-info'),
  getCredits: (brand) => ipcRenderer.invoke('get-credits', assertBrand(brand)),
  getConnectedPlatforms: (brand) => ipcRenderer.invoke('get-connected-platforms', assertBrand(brand)),
  getBrands: () => ipcRenderer.invoke('get-brands'),

  // Brand context threads — each brand has its own SDK session + bubble log.
  // switchBrand aborts the current turn and resumes the target brand's thread.
  switchBrand: (brand) => ipcRenderer.invoke('switch-brand', assertBrand(brand)),
  getBrandThread: (brand) => ipcRenderer.invoke('get-brand-thread', assertBrand(brand)),

  // State persistence
  saveState: (data) => ipcRenderer.invoke('save-state', assertObj(data)),
  loadState: () => ipcRenderer.invoke('load-state'),

  // Revenue tracker
  getStatsCache: () => ipcRenderer.invoke('get-stats-cache'),

  // Performance + Activity
  getPerfSummary: (days, brand) => ipcRenderer.invoke('get-perf-summary', assertInt(days, 7), assertBrand(brand)),
  getAgencyReport: (days, brands) => ipcRenderer.invoke('get-agency-report', assertInt(days, 7), assertBrandArray(brands)),
  refreshPerf: (brand, days) => ipcRenderer.invoke('refresh-perf', assertBrand(brand), Number.isInteger(days) && days > 0 && days <= 365 ? days : undefined),
  getPerfUpdated: (brand) => ipcRenderer.invoke('get-perf-updated', assertBrand(brand)),
  getActivityFeed: (brand, limit) => ipcRenderer.invoke('get-activity-feed', assertBrand(brand), assertInt(limit, 50)),
  // getActivityFeedFull reads the brand's activity.jsonl in its entirety
  // (subject to a 10 MB safety cap). Used by the export + search-all paths
  // in the activity feed, where tailing 50 entries is not enough.
  getActivityFeedFull: (brand) => ipcRenderer.invoke('get-activity-feed-full', assertBrand(brand)),

  // Archive
  getArchiveItems: (filters) => ipcRenderer.invoke('get-archive-items', assertObj(filters)),
  getLiveAds: (brand) => ipcRenderer.invoke('get-live-ads', assertBrand(brand)),
  refreshLiveAds: (brand) => ipcRenderer.invoke('refresh-live-ads', assertBrand(brand)),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', assertStr(folderPath, 500)),
  copyImage: (filePath) => ipcRenderer.invoke('copy-image', assertStr(filePath, 500)),
  // Copy an in-memory PNG data URL (e.g. the share card canvas) to the
  // OS clipboard via Electron's native clipboard API. More reliable than
  // the browser ClipboardItem API, which is blocked in many contexts and
  // silently falls back to text — the share card is supposed to be an
  // image, never a paragraph of copy.
  copyImageDataUrl: (dataUrl) => ipcRenderer.invoke('copy-image-data-url', assertStr(dataUrl, 8_000_000)),
  saveImageDataUrl: (dataUrl, filename) => ipcRenderer.invoke('save-image-data-url', assertStr(dataUrl, 8_000_000), assertStr(filename, 200)),
  // Accepts either a single relative path (legacy — used by context menus on
  // message images) or an array of paths (archive cards — the renderer
  // decides whether to delete a whole run folder or just the loose file(s)).
  deleteFile: (target) => {
    if (Array.isArray(target)) {
      // Cap raised from 20 → 500 (2026-04-26, batch-cull-at-scale): the
      // legacy 20 was sized for the 2-cap selection era; with multi-
      // select Lightroom-style culling, paying users routinely trash
      // 100+ at a time. 500 matches the bulk-flags cap and is bounded
      // by main.js's per-target validation cost.
      if (target.length === 0 || target.length > 500) throw new Error('invalid delete batch');
      for (const t of target) assertStr(t, 500);
      return ipcRenderer.invoke('delete-file', target);
    }
    return ipcRenderer.invoke('delete-file', assertStr(target, 500));
  },

  // Archive keep/reject flag sidecar (results/.flags.json). Read/write goes
  // through main so atomic writes + path validation live in one place — the
  // renderer never touches the file directly.
  getArchiveFlags: () => ipcRenderer.invoke('archive-flags-get'),
  setArchiveFlag: (key, flag) => {
    if (typeof key !== 'string' || key.length === 0 || key.length > 500) throw new Error('invalid flag key');
    if (flag !== null && flag !== 'keep' && flag !== 'reject') throw new Error('invalid flag value');
    return ipcRenderer.invoke('archive-flags-set', { key, flag });
  },
  setArchiveFlagsBulk: (updates) => {
    if (!Array.isArray(updates)) throw new Error('updates must be an array');
    if (updates.length > 5000) throw new Error('bulk update too large');
    return ipcRenderer.invoke('archive-flags-set-bulk', updates);
  },
  // Subscribe to filesystem-driven archive invalidations. The main process
  // mounts an fs.watch on results/ and sends `archive-changed` whenever
  // the tree changes (new run folder, external drop, bulk trash). Returns
  // an unsubscribe function so the caller can detach on tab teardown.
  onArchiveChanged: (cb) => {
    const h = () => { try { cb(); } catch {} };
    ipcRenderer.on('archive-changed', h);
    return () => ipcRenderer.removeListener('archive-changed', h);
  },

  // Wisdom
  getWisdom: (brandName, opts) => ipcRenderer.invoke('get-wisdom', assertBrand(brandName), opts ? { force: !!opts.force } : undefined),
  getSeasonal: () => ipcRenderer.invoke('get-seasonal'),

  // Disconnect platform
  disconnectPlatform: (platform, brand) => ipcRenderer.invoke('disconnect-platform', assertPlatform(platform), assertBrand(brand)),

  // Competitor swipes
  getSwipes: (brand) => ipcRenderer.invoke('get-swipes', assertBrand(brand)),

  // Brand guide — read persisted brand-guide.json for the onboarding review
  // card. Main process resolves assets/brands/<brand>/brand-guide.json,
  // validates the path stays inside assets/brands, and returns the raw JSON
  // string or null if missing. Never exposes arbitrary file-read.
  readBrandGuide: (brand) => ipcRenderer.invoke('read-brand-guide', assertBrand(brand)),
  onBrandGuideUpdated: (cb) => {
    const h = (_, data) => cb(data); ipcRenderer.on('brand-guide-updated', h);
    return () => ipcRenderer.removeListener('brand-guide-updated', h);
  },

  // Morning briefing
  getBriefing: (brand) => ipcRenderer.invoke('get-briefing', assertBrand(brand)),
  dismissBriefing: (brand) => ipcRenderer.invoke('dismiss-briefing', assertBrand(brand)),

  // Referral
  getReferralInfo: () => ipcRenderer.invoke('get-referral-info'),
  applyReferralCode: (code) => ipcRenderer.invoke('apply-referral-code', assertStr(code, 100)),
  onReferralAutoApplied: (cb) => {
    const handler = (_e, payload) => cb(payload || {});
    ipcRenderer.on('referral-auto-applied', handler);
    return () => ipcRenderer.removeListener('referral-auto-applied', handler);
  },

  // Spellbook
  checkClaudeRunning: () => ipcRenderer.invoke('check-claude-running'),
  // listSpells moved below with brand param
  toggleSpell: (id, enabled) => ipcRenderer.invoke('toggle-spell', assertStr(id, 200), !!enabled),
  updateSpellMeta: (id, meta) => ipcRenderer.invoke('update-spell-meta', assertStr(id, 200), assertObj(meta)),
  savePastedMedia: (dataUrl, filename) => ipcRenderer.invoke('save-pasted-media', assertStr(dataUrl, 5000000), assertStr(filename, 200)),
  runOAuth: (platform, brand, extra) => ipcRenderer.invoke('run-oauth', assertPlatform(platform), assertBrand(brand), assertObj(extra)),
  // Manual-override Meta connect: after the renderer saves metaAccessToken
  // via saveConfigField, this runs the Go binary's meta-discover action to
  // auto-resolve ad account / page / pixel IDs. Normal path is runOAuth —
  // this exists only for users with a pre-existing long-lived token.
  discoverMetaIds: (brand) => ipcRenderer.invoke('discover-meta-ids', assertBrand(brand)),
  onConnectionsChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('connections-changed', handler);
    return () => ipcRenderer.removeListener('connections-changed', handler);
  },
  saveConfigField: (key, value, brand) => ipcRenderer.invoke('save-config-field', assertStr(key, 100), assertStr(String(value), 2000), assertBrand(brand)),
  sendMessage: (text, options) => ipcRenderer.invoke('send-message', assertStr(text, MAX_TEXT), assertObj(options)),
  sendSilent: (text) => ipcRenderer.invoke('send-message', assertStr(text, MAX_TEXT), { silent: true }),
  createSpell: (taskId, cron, desc, prompt, brand) => ipcRenderer.invoke('create-spell', assertStr(taskId, 100), assertCron(cron), assertStr(desc, 500), assertStr(prompt, MAX_STR), assertBrand(brand)),
  listSpells: (brand) => ipcRenderer.invoke('list-spells', assertBrand(brand)),

  // Approvals
  approveTool: (id) => ipcRenderer.invoke('approve-tool', assertStr(id, 200)),
  denyTool: (id) => ipcRenderer.invoke('deny-tool', assertStr(id, 200)),
  answerQuestion: (id, answers) => ipcRenderer.invoke('answer-question', assertStr(id, 200), assertObj(answers)),

  // Auto-update
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  // Events — each returns a cleanup function: const unsub = merlin.onX(cb); unsub();
  onPlatform: (cb) => {
    const h = (_, p) => cb(p); ipcRenderer.on('platform', h);
    return () => ipcRenderer.removeListener('platform', h);
  },
  onSdkMessage: (cb) => {
    const h = (_, msg) => cb(msg); ipcRenderer.on('sdk-message', h);
    return () => ipcRenderer.removeListener('sdk-message', h);
  },
  onBrandSwitched: (cb) => {
    const h = (_, data) => cb(data); ipcRenderer.on('brand-switched', h);
    return () => ipcRenderer.removeListener('brand-switched', h);
  },
  // brand-activated fires the moment the merlin-setup skill calls the
  // brand_activate MCP tool — used during onboarding to swap the dropdown
  // to the freshly-scaffolded brand without restarting the SDK session
  // (the active turn IS the setup turn) or repainting chat (the user is
  // watching the WOW moment unfold).
  onBrandActivated: (cb) => {
    const h = (_, data) => cb(data); ipcRenderer.on('brand-activated', h);
    return () => ipcRenderer.removeListener('brand-activated', h);
  },
  onApprovalRequest: (cb) => {
    const h = (_, data) => cb(data); ipcRenderer.on('approval-request', h);
    return () => ipcRenderer.removeListener('approval-request', h);
  },
  onAskUserQuestion: (cb) => {
    const h = (_, data) => cb(data); ipcRenderer.on('ask-user-question', h);
    return () => ipcRenderer.removeListener('ask-user-question', h);
  },
  onSdkError: (cb) => {
    const h = (_, err) => cb(err); ipcRenderer.on('sdk-error', h);
    return () => ipcRenderer.removeListener('sdk-error', h);
  },
  onInlineMessage: (cb) => {
    const h = (_, data) => cb(data); ipcRenderer.on('inline-message', h);
    return () => ipcRenderer.removeListener('inline-message', h);
  },
  onRemoteUserMessage: (cb) => {
    const h = (_, text) => cb(text); ipcRenderer.on('remote-user-message', h);
    return () => ipcRenderer.removeListener('remote-user-message', h);
  },
  onSubscriptionActivated: (cb) => {
    const h = (_, data) => cb(data); ipcRenderer.on('subscription-activated', h);
    return () => ipcRenderer.removeListener('subscription-activated', h);
  },
  onSubscriptionCanceled: (cb) => {
    const h = (_, data) => cb(data || {}); ipcRenderer.on('subscription-canceled', h);
    return () => ipcRenderer.removeListener('subscription-canceled', h);
  },
  onActivationTimeout: (cb) => {
    const h = () => cb(); ipcRenderer.on('activation-timeout', h);
    return () => ipcRenderer.removeListener('activation-timeout', h);
  },
  onSpellActivity: (cb) => {
    const h = (_, data) => cb(data); ipcRenderer.on('spell-activity', h);
    return () => ipcRenderer.removeListener('spell-activity', h);
  },
  onSpellCompleted: (cb) => {
    const h = (_, data) => cb(data); ipcRenderer.on('spell-completed', h);
    return () => ipcRenderer.removeListener('spell-completed', h);
  },
  onPerfDataChanged: (cb) => {
    const h = (_, data) => cb(data); ipcRenderer.on('perf-data-changed', h);
    return () => ipcRenderer.removeListener('perf-data-changed', h);
  },
  onLiveAdsChanged: (cb) => {
    const h = (_, data) => cb(data); ipcRenderer.on('live-ads-changed', h);
    return () => ipcRenderer.removeListener('live-ads-changed', h);
  },
  onLiveAdsRefreshProgress: (cb) => {
    const h = (_, data) => cb(data); ipcRenderer.on('live-ads-refresh-progress', h);
    return () => ipcRenderer.removeListener('live-ads-refresh-progress', h);
  },
  onUpdateAvailable: (cb) => {
    const h = (_, info) => cb(info); ipcRenderer.on('update-available', h);
    return () => ipcRenderer.removeListener('update-available', h);
  },
  onUpdateProgress: (cb) => {
    const h = (_, msg) => cb(msg); ipcRenderer.on('update-progress', h);
    return () => ipcRenderer.removeListener('update-progress', h);
  },
  onUpdateReady: (cb) => {
    const h = (_, info) => cb(info); ipcRenderer.on('update-ready', h);
    return () => ipcRenderer.removeListener('update-ready', h);
  },
  onUpdateError: (cb) => {
    const h = (_, err) => cb(err); ipcRenderer.on('update-error', h);
    return () => ipcRenderer.removeListener('update-error', h);
  },
  // §2.7: merlin:// URLs routed in from open-url (Mac) or second-instance
  // (Win/Linux). URL schema TBD; payload is the raw URL string — renderer
  // parses it. Returns an unsubscribe handle.
  onMerlinDeepLink: (cb) => {
    const h = (_, url) => { try { cb(url); } catch {} };
    ipcRenderer.on('merlin-deep-link', h);
    return () => ipcRenderer.removeListener('merlin-deep-link', h);
  },
  // §3.6: progress events emitted by long-running MCP tools (brand_scrape,
  // image/video generation). Payload shape is the envelope documented in
  // app/mcp-tools.js § "Progress event emission" — { channel, tool,
  // scrapeId, stage, label, pct?, url?, ts, detail? }. Callers typically
  // filter by `tool` or `scrapeId` to correlate multi-stage events.
  onMcpProgress: (cb) => {
    const h = (_, payload) => { try { cb(payload); } catch {} };
    ipcRenderer.on('mcp-progress', h);
    return () => ipcRenderer.removeListener('mcp-progress', h);
  },
  // §3.9: OAuth pending-flow chips. Main process polls `oauth-pending-list`
  // every 30s and pushes the result here; renderer renders a chip row in
  // the connections panel. Payload: { pending: [{provider, provider_name,
  // started_unix, expires_unix, minutes_remaining, auth_url}], checkedAt }.
  onOAuthPending: (cb) => {
    const h = (_, payload) => { try { cb(payload); } catch {} };
    ipcRenderer.on('oauth-pending', h);
    return () => ipcRenderer.removeListener('oauth-pending', h);
  },
  // §3.10: onboarding checkpoint persistence. Schema v1 whitelist:
  // { pending_products_for_autopilot, vertical_confirmed, autopilot_asked,
  //   goal, setup_step, tos_accepted_at, referral_captured }. Renderer reads
  // at startup to resume the right screen; writes partial updates as the
  // user advances through referral → goal → init().
  readOnboardingCheckpoint: () => ipcRenderer.invoke('onboarding-checkpoint-read'),
  writeOnboardingCheckpoint: (partial) => ipcRenderer.invoke('onboarding-checkpoint-write', partial),
  // §6.2: fired once on did-finish-load after a render-process-gone reload.
  // Renderer shows a one-shot "Merlin recovered from a hiccup" toast.
  // Payload: { reason, exitCode }.
  onPostCrashReload: (cb) => {
    const h = (_, payload) => { try { cb(payload); } catch {} };
    ipcRenderer.on('post-crash-reload', h);
    return () => ipcRenderer.removeListener('post-crash-reload', h);
  },
  onTrialExpired: (cb) => {
    const h = () => cb(); ipcRenderer.on('trial-expired', h);
    return () => ipcRenderer.removeListener('trial-expired', h);
  },
  onBypassAttempt: (cb) => {
    const h = (_, info) => cb(info); ipcRenderer.on('bypass-attempt', h);
    return () => ipcRenderer.removeListener('bypass-attempt', h);
  },
  onEngineStatus: (cb) => {
    const h = (_, msg) => cb(msg); ipcRenderer.on('engine-status', h);
    return () => ipcRenderer.removeListener('engine-status', h);
  },
  triggerClaudeLogin: () => ipcRenderer.invoke('trigger-claude-login'),
  // Cancel an in-flight login subprocess. Returns { ok: true } after killing
  // the child. Safe to call even if no login is running (ipcMain will just
  // error and we swallow it renderer-side).
  cancelClaudeLogin: () => ipcRenderer.invoke('cancel-claude-login').catch(() => ({ ok: false })),
  onAuthCodePrompt: (cb) => {
    const h = () => cb(); ipcRenderer.on('auth-code-prompt', h);
    return () => ipcRenderer.removeListener('auth-code-prompt', h);
  },
  onAuthCodeDismiss: (cb) => {
    const h = () => cb(); ipcRenderer.on('auth-code-dismiss', h);
    return () => ipcRenderer.removeListener('auth-code-dismiss', h);
  },
  // Unified auth-required event (Codex P1 #1). Fires whenever the main
  // process discovers missing or invalid credentials — from startSession,
  // from SDK errors, from anywhere. The renderer auto-triggers login and
  // replays the triggering message on success.
  onAuthRequired: (cb) => {
    const h = (_, data) => cb(data || {}); ipcRenderer.on('auth-required', h);
    return () => ipcRenderer.removeListener('auth-required', h);
  },
  // Two paths:
  //   - send:   fire-and-forget (legacy, no feedback)
  //   - invoke: returns { ok, reason? } so the dialog can show the user
  //             whether the paste actually reached the CLI subprocess
  submitAuthCode: (code) => ipcRenderer.send('auth-code-submit', assertStr(code, 500)),
  submitAuthCodeWithResult: (code) => ipcRenderer.invoke('auth-code-submit-invoke', assertStr(code, 500)),
  openExternal: (url) => ipcRenderer.invoke('open-external-url', assertStr(url, 2000)),

  // Voice input: webm audio bytes → transcript via bundled whisper.cpp
  transcribeAudio: (bytes) => {
    if (!Array.isArray(bytes)) throw new Error('invalid audio bytes');
    if (bytes.length === 0) throw new Error('empty audio');
    if (bytes.length > 50 * 1024 * 1024) throw new Error('audio too large');
    return ipcRenderer.invoke('transcribe-audio', bytes);
  },

  // §2.6: OS-level mic permission. These wrap the Electron `systemPreferences`
  // TCC helpers on macOS and are no-ops elsewhere (return granted=true).
  // Use micPermissionStatus() before attempting getUserMedia on first launch
  // so we can render a clean "Enable mic" card instead of a silent rejection.
  // micPermissionRequest() shows the native TCC prompt exactly once; subsequent
  // calls when the user previously denied return false silently — wire
  // micPermissionOpenSettings() to the "Open System Settings" button.
  micPermissionStatus: () => ipcRenderer.invoke('mic-permission-status'),
  micPermissionRequest: () => ipcRenderer.invoke('mic-permission-request'),
  micPermissionOpenSettings: () => ipcRenderer.invoke('mic-permission-open-settings'),

  // Voice output: text → Kokoro TTS → WAV bytes for playback in renderer.
  // Returns { success: true, audio: Uint8Array } | { aborted: true } | { error }.
  // Main process handles download, caching, and synthesis; renderer plays
  // the WAV via <audio> with a Blob URL.
  speakText: (text, voice, requestId) => {
    if (typeof text !== 'string') throw new Error('text must be a string');
    if (text.length > 5000) throw new Error('text too long (5000 char max)');
    return ipcRenderer.invoke('speak-text', { text, voice, requestId });
  },
  stopSpeaking: () => ipcRenderer.invoke('stop-speaking'),
  // Filler bank — short pre-synthesized phrases played on send while Claude
  // is still generating. Returns { audio: Array<Uint8Array> | null }. Null
  // means the main-process cache isn't ready yet (first ~5 s after boot);
  // renderer treats that as "silently skip filler for this send".
  getFillerAudio: () => ipcRenderer.invoke('get-filler-audio'),
  // Streaming TTS: open a session at the start of a Claude response, push
  // complete sentences as they arrive, close on finalize. Chunks come back
  // on the same `onVoiceOutputChunk` channel tagged with requestId.
  speakTextStreamStart: (requestId, voice) => {
    if (!Number.isInteger(requestId) || requestId < 0) throw new Error('invalid requestId');
    if (voice !== undefined && typeof voice !== 'string') throw new Error('voice must be a string');
    return ipcRenderer.invoke('speak-text-stream-start', { requestId, voice });
  },
  speakTextStreamAppend: (requestId, text) => {
    if (!Number.isInteger(requestId) || requestId < 0) throw new Error('invalid requestId');
    if (typeof text !== 'string') throw new Error('text must be a string');
    if (text.length > 5000) throw new Error('text too long (5000 char max)');
    return ipcRenderer.invoke('speak-text-stream-append', { requestId, text });
  },
  speakTextStreamEnd: (requestId) => {
    if (!Number.isInteger(requestId) || requestId < 0) throw new Error('invalid requestId');
    return ipcRenderer.invoke('speak-text-stream-end', { requestId });
  },
  onVoiceOutputProgress: (callback) => {
    if (typeof callback !== 'function') throw new Error('callback must be a function');
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('voice-output-progress', handler);
    return () => ipcRenderer.removeListener('voice-output-progress', handler);
  },
  // Streaming TTS: one event per synthesised sentence. Payload shape:
  // { requestId, seq, audio: Uint8Array, final: false } for each sentence,
  // then { requestId, seq, audio: null, final: true } to close.
  onVoiceOutputChunk: (callback) => {
    if (typeof callback !== 'function') throw new Error('callback must be a function');
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('voice-output-chunk', handler);
    return () => ipcRenderer.removeListener('voice-output-chunk', handler);
  },
});

// ── Fact-binding init bridge ──────────────────────────────────
//
// Main sends `{ sessionId, vaultKeyHex, brand, toolsDir }` on the
// `fact-binding:init` channel once the Go binary's session-prelude
// action returns the per-session HMAC seed. This preload handler
// converts the hex string to a Buffer IN NODE CONTEXT and hands the
// Buffer to the renderer via the registered callback. The hex NEVER
// crosses into the renderer's JS world:
//   - no `executeJavaScript` source string containing the hex
//   - no `window.<name> = hex` assignment
//   - no IPC payload the renderer can read directly
// DevTools snapshot of `window` contains no 64-char hex substring
// after init; memory-dump analysis would find the Buffer bytes but
// not a hex-encoded string representation.
//
// REGRESSION GUARD (2026-04-18): if you change this bridge, keep
// three invariants intact:
//   (1) hex → Buffer happens inside this preload handler (Node ctx),
//   (2) the bridge delivers the Buffer via function-arg (structured
//       clone → Uint8Array in renderer), never via
//       exposeInMainWorld of a named property, and
//   (3) no `.toString('hex')` or `.toString()` on the Buffer inside
//       this file — that would reconstitute the hex mid-flight.
// `app/facts/preload-bridge.test.js` source-scans this file + main.js
// to lock all three.
//
// ── Opaque-handle bridge (renderer has no require / no Node globals) ──
//
// The renderer runs with `contextIsolation: true, nodeIntegration: false`.
// Inside that world there is no `require`, no `Buffer`, no `fs`. Before
// this refactor, `renderer.js` did `require('./facts/facts-cache')`,
// `require('./facts/verify-facts')`, and `require('./facts/chart-renderer')`
// unconditionally — every call threw `ReferenceError: require is not
// defined`, caught silently by try/catch. Result: fact-binding was a
// no-op for every production user despite the feature flag being ON.
//
// Fix: this preload file (Node context) requires the three facts modules
// directly, then exposes a curated function surface through contextBridge.
// Class instances (FactCache, TailQuarantine) can't cross contextBridge
// cleanly — contextBridge's structured clone strips prototypes — so we
// keep them on the preload side in integer-keyed handle tables and let
// the renderer reference them by handle. Every bridge method takes a
// handle and opaque args; preload resolves the real instance and calls
// through.
//
// Handle allocation uses a monotonic counter (never reused) so a stale
// handle from a prior turn can't accidentally hit a live instance. Handle
// tables sit at module scope; they survive page reloads of the renderer
// only if the preload stays loaded (which Electron does). On teardown
// (closeCache / stopWatcher / tailFinalize) the entry is deleted and
// future calls with that handle silently no-op.
//
// Error handling: bridge methods swallow exceptions and log via
// console.warn. A bad call from the renderer must never crash preload.
const factsCache = require('./facts/facts-cache');
const verifyFacts = require('./facts/verify-facts');
const chartRenderer = require('./facts/chart-renderer');

const _cacheHandles = new Map();   // handle -> FactCache instance
const _watcherHandles = new Map(); // handle -> stop() function
const _tailHandles = new Map();    // handle -> TailQuarantine instance
let _handleSeq = 1;
function _nextHandle() { return _handleSeq++; }

contextBridge.exposeInMainWorld('merlinFactBinding', {
  onInit: (cb) => {
    if (typeof cb !== 'function') throw new Error('merlinFactBinding.onInit cb must be a function');
    const handler = (_e, payload) => {
      try {
        if (!payload || typeof payload !== 'object') return;
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
        const vaultKeyHex = typeof payload.vaultKeyHex === 'string' ? payload.vaultKeyHex : '';
        const brand = typeof payload.brand === 'string' ? payload.brand : '';
        const toolsDir = typeof payload.toolsDir === 'string' ? payload.toolsDir : '';
        if (!sessionId) return;
        // HKDF output for the HMAC seed is 32 bytes → 64 hex chars.
        // Allow 32–128 hex chars for forward-compat (larger seed),
        // reject anything outside that so a malformed main-side
        // payload doesn't smuggle garbage into FactCache.
        if (!/^[0-9a-f]{32,128}$/i.test(vaultKeyHex)) return;
        const vaultKey = Buffer.from(vaultKeyHex, 'hex');
        cb({ sessionId, vaultKey, brand, toolsDir });
      } catch (err) {
        // Swallow — fact-binding failing init must never surface a
        // noisy error to the user. The renderer stays in its
        // default-off state on error.
        console.warn('[fact-binding preload] init handler failed:', err && err.message);
      }
    };
    ipcRenderer.on('fact-binding:init', handler);
    return () => ipcRenderer.removeListener('fact-binding:init', handler);
  },

  /**
   * createCache({ sessionId, vaultKey, brand, contractHash }) → handle
   *
   * `vaultKey` may be either a Buffer (preload-internal) or a Uint8Array
   * (renderer-originated). We normalise to Buffer here so the renderer
   * never needs Buffer at all. Returns an integer handle, or 0 on
   * failure (renderer treats 0 as "no cache, stay off").
   */
  createCache: (opts) => {
    try {
      if (!opts || typeof opts !== 'object') return 0;
      const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId : '';
      const brand = typeof opts.brand === 'string' ? opts.brand : '';
      const contractHash = typeof opts.contractHash === 'string' ? opts.contractHash : '';
      if (!sessionId) return 0;
      let vk;
      const raw = opts.vaultKey;
      if (Buffer.isBuffer(raw)) {
        vk = raw;
      } else if (raw instanceof Uint8Array) {
        vk = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      } else {
        return 0;
      }
      if (vk.length < 16) return 0;
      const cache = new factsCache.FactCache({
        sessionId, vaultKey: vk, brand, contractHash,
        onSafeMode: (info) => console.warn('[facts] SAFE MODE', info),
      });
      const h = _nextHandle();
      _cacheHandles.set(h, cache);
      return h;
    } catch (e) {
      console.warn('[fact-binding preload] createCache failed:', e && e.message);
      return 0;
    }
  },

  /**
   * closeCache(handle) — drop the cache instance and release its memory.
   * Any watcher still referencing the handle is NOT stopped here — call
   * stopWatcher separately. Returns true on success, false if unknown.
   */
  closeCache: (handle) => {
    if (!Number.isInteger(handle)) return false;
    const existed = _cacheHandles.delete(handle);
    return existed;
  },

  /**
   * watchFactsFile({ toolsDir, sessionId, pollMs, cacheHandle }) → watcherHandle
   *
   * Starts a JSONL tail-reader that feeds the cache identified by
   * cacheHandle. Returns a watcher handle the renderer can pass to
   * stopWatcher. Returns 0 on invalid args or unknown cache.
   */
  watchFactsFile: (opts) => {
    try {
      if (!opts || typeof opts !== 'object') return 0;
      const toolsDir = typeof opts.toolsDir === 'string' ? opts.toolsDir : '';
      const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId : '';
      const pollMs = Number.isInteger(opts.pollMs) && opts.pollMs >= 50 ? opts.pollMs : 120;
      const cacheHandle = Number.isInteger(opts.cacheHandle) ? opts.cacheHandle : 0;
      if (!toolsDir || !sessionId || !cacheHandle) return 0;
      const cache = _cacheHandles.get(cacheHandle);
      if (!cache) return 0;
      const filePath = factsCache.defaultFactsFilePath({ toolsDir, sessionId });
      const stop = factsCache.watchFactsFile(filePath, cache, { pollMs });
      const h = _nextHandle();
      _watcherHandles.set(h, stop);
      return h;
    } catch (e) {
      console.warn('[fact-binding preload] watchFactsFile failed:', e && e.message);
      return 0;
    }
  },

  /**
   * stopWatcher(handle) — stop the JSONL tail-reader. Returns true on
   * success, false if unknown.
   */
  stopWatcher: (handle) => {
    if (!Number.isInteger(handle)) return false;
    const stop = _watcherHandles.get(handle);
    if (!stop) return false;
    try { stop(); } catch { /* swallow */ }
    _watcherHandles.delete(handle);
    return true;
  },

  /**
   * runAllPasses(html, cacheHandle) → { html, unresolvedTokens, quarantinedLiterals }
   *
   * Wraps verify-facts.runAllPasses. Returns the input html unchanged on
   * invalid args / unknown cache (safe default — lets streaming keep
   * working even if fact binding is partly broken).
   */
  runAllPasses: (html, cacheHandle) => {
    if (typeof html !== 'string') return { html: String(html || ''), unresolvedTokens: 0, quarantinedLiterals: 0 };
    if (!Number.isInteger(cacheHandle)) return { html, unresolvedTokens: 0, quarantinedLiterals: 0 };
    const cache = _cacheHandles.get(cacheHandle);
    if (!cache) return { html, unresolvedTokens: 0, quarantinedLiterals: 0 };
    try {
      const r = verifyFacts.runAllPasses(html, cache);
      return {
        html: r.html,
        unresolvedTokens: r.unresolvedTokens | 0,
        quarantinedLiterals: r.quarantinedLiterals | 0,
      };
    } catch (e) {
      console.warn('[fact-binding preload] runAllPasses failed:', e && e.message);
      return { html, unresolvedTokens: 0, quarantinedLiterals: 0 };
    }
  },

  /**
   * mountCharts(html) → html
   *
   * String-based SVG chart mount (see chart-renderer.mountChartsInHtml).
   * Safe to call on any HTML string — returns unchanged if no placeholders
   * are present.
   */
  mountCharts: (html) => {
    if (typeof html !== 'string') return String(html || '');
    try { return chartRenderer.mountChartsInHtml(html); }
    catch (e) {
      console.warn('[fact-binding preload] mountCharts failed:', e && e.message);
      return html;
    }
  },

  /**
   * createTailQuarantine({ absoluteMs }) → handle
   *
   * Allocates a TailQuarantine instance. Pair with tailPush / tailFinalize.
   * Returns 0 on failure.
   */
  createTailQuarantine: (opts) => {
    try {
      const absoluteMs = opts && Number.isInteger(opts.absoluteMs) && opts.absoluteMs > 0
        ? opts.absoluteMs
        : 2000;
      const tq = new verifyFacts.TailQuarantine({ absoluteMs });
      const h = _nextHandle();
      _tailHandles.set(h, tq);
      return h;
    } catch (e) {
      console.warn('[fact-binding preload] createTailQuarantine failed:', e && e.message);
      return 0;
    }
  },

  /** tailPush(handle, delta) → safe-to-render prefix. "" on unknown handle. */
  tailPush: (handle, delta) => {
    if (!Number.isInteger(handle)) return '';
    const tq = _tailHandles.get(handle);
    if (!tq) return '';
    try { return tq.push(typeof delta === 'string' ? delta : String(delta || '')); }
    catch (e) {
      console.warn('[fact-binding preload] tailPush failed:', e && e.message);
      return '';
    }
  },

  /**
   * tailFinalize(handle) → remaining tail. Also drops the handle so the
   * TailQuarantine can be garbage collected. Subsequent calls return "".
   */
  tailFinalize: (handle) => {
    if (!Number.isInteger(handle)) return '';
    const tq = _tailHandles.get(handle);
    if (!tq) return '';
    let out = '';
    try { out = tq.finalize(); }
    catch (e) {
      console.warn('[fact-binding preload] tailFinalize failed:', e && e.message);
    }
    _tailHandles.delete(handle);
    return out;
  },
});
