const { contextBridge, ipcRenderer } = require('electron');

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
  stopGeneration: () => ipcRenderer.invoke('stop-generation'),
  getAccountInfo: () => ipcRenderer.invoke('get-account-info'),
  getCredits: (brand) => ipcRenderer.invoke('get-credits', assertBrand(brand)),
  getConnectedPlatforms: (brand) => ipcRenderer.invoke('get-connected-platforms', assertBrand(brand)),
  getBrands: () => ipcRenderer.invoke('get-brands'),

  // State persistence
  saveState: (data) => ipcRenderer.invoke('save-state', assertObj(data)),
  loadState: () => ipcRenderer.invoke('load-state'),

  // Revenue tracker
  getStatsCache: () => ipcRenderer.invoke('get-stats-cache'),

  // Performance + Activity
  getPerfSummary: (days, brand) => ipcRenderer.invoke('get-perf-summary', assertInt(days, 7), assertBrand(brand)),
  refreshPerf: (brand, days) => ipcRenderer.invoke('refresh-perf', assertBrand(brand), Number.isInteger(days) && days > 0 && days <= 365 ? days : undefined),
  getPerfUpdated: (brand) => ipcRenderer.invoke('get-perf-updated', assertBrand(brand)),
  getActivityFeed: (brand, limit) => ipcRenderer.invoke('get-activity-feed', assertBrand(brand), assertInt(limit, 50)),

  // Archive
  getArchiveItems: (filters) => ipcRenderer.invoke('get-archive-items', assertObj(filters)),
  getLiveAds: (brand) => ipcRenderer.invoke('get-live-ads', assertBrand(brand)),
  refreshLiveAds: (brand) => ipcRenderer.invoke('refresh-live-ads', assertBrand(brand)),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', assertStr(folderPath, 500)),
  copyImage: (filePath) => ipcRenderer.invoke('copy-image', assertStr(filePath, 500)),
  deleteFile: (folderPath) => ipcRenderer.invoke('delete-file', assertStr(folderPath, 500)),

  // Wisdom
  getWisdom: (brandName) => ipcRenderer.invoke('get-wisdom', assertBrand(brandName)),

  // Disconnect platform
  disconnectPlatform: (platform, brand) => ipcRenderer.invoke('disconnect-platform', assertPlatform(platform), assertBrand(brand)),

  // Competitor swipes
  getSwipes: (brand) => ipcRenderer.invoke('get-swipes', assertBrand(brand)),

  // Morning briefing
  getBriefing: (brand) => ipcRenderer.invoke('get-briefing', assertBrand(brand)),
  dismissBriefing: (brand) => ipcRenderer.invoke('dismiss-briefing', assertBrand(brand)),

  // Referral
  getReferralInfo: () => ipcRenderer.invoke('get-referral-info'),
  applyReferralCode: (code) => ipcRenderer.invoke('apply-referral-code', assertStr(code, 100)),

  // Spellbook
  checkClaudeRunning: () => ipcRenderer.invoke('check-claude-running'),
  // listSpells moved below with brand param
  toggleSpell: (id, enabled) => ipcRenderer.invoke('toggle-spell', assertStr(id, 200), !!enabled),
  updateSpellMeta: (id, meta) => ipcRenderer.invoke('update-spell-meta', assertStr(id, 200), assertObj(meta)),
  savePastedMedia: (dataUrl, filename) => ipcRenderer.invoke('save-pasted-media', assertStr(dataUrl, 5000000), assertStr(filename, 200)),
  runOAuth: (platform, brand, extra) => ipcRenderer.invoke('run-oauth', assertPlatform(platform), assertBrand(brand), assertObj(extra)),
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
  // Auto-install whisper-cli + ggml-tiny.en.bin + ffmpeg into
  // .claude/tools/. Main-process handler streams 'voice-install-progress'
  // events so the renderer can show a live bar; returns { success } or
  // { error } at the end. Windows only today — mac/linux return an error
  // with manual instructions.
  installVoiceTools: () => ipcRenderer.invoke('install-voice-tools'),
  onVoiceInstallProgress: (cb) => {
    const h = (_, data) => cb(data);
    ipcRenderer.on('voice-install-progress', h);
    return () => ipcRenderer.removeListener('voice-install-progress', h);
  },
});
