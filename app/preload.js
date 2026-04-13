const { contextBridge, ipcRenderer } = require('electron');

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
  activateKey: (key) => ipcRenderer.invoke('activate-key', key),

  // Setup + Install
  checkSetup: (force) => ipcRenderer.invoke('check-setup', force),
  installClaude: () => ipcRenderer.invoke('install-claude'),
  setApiKey: (key) => ipcRenderer.invoke('set-api-key', key),
  hasApiKey: () => ipcRenderer.invoke('has-api-key'),
  openClaudeDownload: () => ipcRenderer.invoke('open-claude-download'),
  openMerlinFolder: () => ipcRenderer.invoke('open-merlin-folder'),
  checkTosAccepted: () => ipcRenderer.invoke('check-tos-accepted'),
  acceptTos: (opts) => ipcRenderer.invoke('accept-tos', opts),

  // Mobile
  getMobileQR: () => ipcRenderer.invoke('get-mobile-qr'),

  // Session
  startSession: () => ipcRenderer.invoke('start-session'),
  stopGeneration: () => ipcRenderer.invoke('stop-generation'),
  getAccountInfo: () => ipcRenderer.invoke('get-account-info'),
  getCredits: (brand) => ipcRenderer.invoke('get-credits', brand),
  getConnectedPlatforms: (brand) => ipcRenderer.invoke('get-connected-platforms', brand),
  getBrands: () => ipcRenderer.invoke('get-brands'),

  // State persistence
  saveState: (data) => ipcRenderer.invoke('save-state', data),
  loadState: () => ipcRenderer.invoke('load-state'),

  // Revenue tracker
  getStatsCache: () => ipcRenderer.invoke('get-stats-cache'),

  // Performance + Activity
  getPerfSummary: (days, brand) => ipcRenderer.invoke('get-perf-summary', days, brand),
  refreshPerf: (brand) => ipcRenderer.invoke('refresh-perf', brand),
  getPerfUpdated: (brand) => ipcRenderer.invoke('get-perf-updated', brand),
  getActivityFeed: (brand, limit) => ipcRenderer.invoke('get-activity-feed', brand, limit),

  // Archive
  getArchiveItems: (filters) => ipcRenderer.invoke('get-archive-items', filters),
  getLiveAds: (brand) => ipcRenderer.invoke('get-live-ads', brand),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  copyImage: (filePath) => ipcRenderer.invoke('copy-image', filePath),
  deleteFile: (folderPath) => ipcRenderer.invoke('delete-file', folderPath),

  // Wisdom
  getWisdom: (brandName) => ipcRenderer.invoke('get-wisdom', brandName),

  // Disconnect platform
  disconnectPlatform: (platform, brand) => ipcRenderer.invoke('disconnect-platform', platform, brand),

  // Competitor swipes
  getSwipes: (brand) => ipcRenderer.invoke('get-swipes', brand),

  // Morning briefing
  getBriefing: (brand) => ipcRenderer.invoke('get-briefing', brand),
  dismissBriefing: (brand) => ipcRenderer.invoke('dismiss-briefing', brand),

  // Referral
  getReferralInfo: () => ipcRenderer.invoke('get-referral-info'),
  applyReferralCode: (code) => ipcRenderer.invoke('apply-referral-code', code),

  // Spellbook
  checkClaudeRunning: () => ipcRenderer.invoke('check-claude-running'),
  // listSpells moved below with brand param
  toggleSpell: (id, enabled) => ipcRenderer.invoke('toggle-spell', id, enabled),
  updateSpellMeta: (id, meta) => ipcRenderer.invoke('update-spell-meta', id, meta),
  savePastedMedia: (dataUrl, filename) => ipcRenderer.invoke('save-pasted-media', dataUrl, filename),
  runOAuth: (platform, brand, extra) => ipcRenderer.invoke('run-oauth', platform, brand, extra),
  onConnectionsChanged: (cb) => ipcRenderer.on('connections-changed', () => cb()),
  saveConfigField: (key, value, brand) => ipcRenderer.invoke('save-config-field', key, value, brand),
  sendMessage: (text, options) => ipcRenderer.invoke('send-message', text, options),
  sendSilent: (text) => ipcRenderer.invoke('send-message', text, { silent: true }),
  createSpell: (taskId, cron, desc, prompt, brand) => ipcRenderer.invoke('create-spell', taskId, cron, desc, prompt, brand),
  listSpells: (brand) => ipcRenderer.invoke('list-spells', brand),

  // Approvals
  approveTool: (id) => ipcRenderer.invoke('approve-tool', id),
  denyTool: (id) => ipcRenderer.invoke('deny-tool', id),
  answerQuestion: (id, answers) => ipcRenderer.invoke('answer-question', id, answers),

  // Auto-update
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  // Events
  onPlatform: (cb) => ipcRenderer.on('platform', (_, p) => cb(p)),
  onSdkMessage: (cb) => ipcRenderer.on('sdk-message', (_, msg) => cb(msg)),
  onApprovalRequest: (cb) => ipcRenderer.on('approval-request', (_, data) => cb(data)),
  onAskUserQuestion: (cb) => ipcRenderer.on('ask-user-question', (_, data) => cb(data)),
  onSdkError: (cb) => ipcRenderer.on('sdk-error', (_, err) => cb(err)),
  onRemoteUserMessage: (cb) => ipcRenderer.on('remote-user-message', (_, text) => cb(text)),
  onSubscriptionActivated: (cb) => ipcRenderer.on('subscription-activated', (_, data) => cb(data)),
  onSpellActivity: (cb) => ipcRenderer.on('spell-activity', (_, data) => cb(data)),
  onSpellCompleted: (cb) => ipcRenderer.on('spell-completed', (_, data) => cb(data)),
  onPerfDataChanged: (cb) => ipcRenderer.on('perf-data-changed', (_, data) => cb(data)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_, info) => cb(info)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_, msg) => cb(msg)),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (_, info) => cb(info)),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (_, err) => cb(err)),
  onTrialExpired: (cb) => ipcRenderer.on('trial-expired', () => cb()),
  onBypassAttempt: (cb) => ipcRenderer.on('bypass-attempt', (_, info) => cb(info)),
  onEngineStatus: (cb) => ipcRenderer.on('engine-status', (_, msg) => cb(msg)),
  triggerClaudeLogin: () => ipcRenderer.invoke('trigger-claude-login'),
  onAuthCodePrompt: (cb) => ipcRenderer.on('auth-code-prompt', () => cb()),
  onAuthRequired: (cb) => ipcRenderer.on('auth-required', () => cb()),
  submitAuthCode: (code) => ipcRenderer.send('auth-code-submit', code),
  openExternal: (url) => ipcRenderer.invoke('open-external-url', url),
});
