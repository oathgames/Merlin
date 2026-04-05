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

  // Setup
  checkSetup: () => ipcRenderer.invoke('check-setup'),
  openClaudeDownload: () => ipcRenderer.invoke('open-claude-download'),

  // Mobile
  getMobileQR: () => ipcRenderer.invoke('get-mobile-qr'),

  // Session
  startSession: () => ipcRenderer.invoke('start-session'),
  getAccountInfo: () => ipcRenderer.invoke('get-account-info'),
  getCredits: () => ipcRenderer.invoke('get-credits'),
  getConnectedPlatforms: () => ipcRenderer.invoke('get-connected-platforms'),
  getBrands: () => ipcRenderer.invoke('get-brands'),

  // State persistence
  saveState: (data) => ipcRenderer.invoke('save-state', data),
  loadState: () => ipcRenderer.invoke('load-state'),

  // Morning briefing
  getBriefing: () => ipcRenderer.invoke('get-briefing'),
  dismissBriefing: () => ipcRenderer.invoke('dismiss-briefing'),

  // Referral
  getReferralInfo: () => ipcRenderer.invoke('get-referral-info'),
  applyReferralCode: (code) => ipcRenderer.invoke('apply-referral-code', code),

  // Spellbook
  checkClaudeRunning: () => ipcRenderer.invoke('check-claude-running'),
  listSpells: () => ipcRenderer.invoke('list-spells'),
  toggleSpell: (id, enabled) => ipcRenderer.invoke('toggle-spell', id, enabled),
  updateSpellMeta: (id, meta) => ipcRenderer.invoke('update-spell-meta', id, meta),
  savePastedMedia: (dataUrl, filename) => ipcRenderer.invoke('save-pasted-media', dataUrl, filename),
  sendMessage: (text) => ipcRenderer.invoke('send-message', text),

  // Approvals
  approveTool: (id) => ipcRenderer.invoke('approve-tool', id),
  denyTool: (id) => ipcRenderer.invoke('deny-tool', id),
  answerQuestion: (id, answers) => ipcRenderer.invoke('answer-question', id, answers),

  // Auto-update
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  restartApp: () => ipcRenderer.invoke('restart-app'),

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
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_, info) => cb(info)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_, msg) => cb(msg)),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (_, info) => cb(info)),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (_, err) => cb(err)),
});
