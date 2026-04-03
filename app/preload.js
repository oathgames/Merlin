const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('r2', {
  // Setup
  checkSetup: () => ipcRenderer.invoke('check-setup'),
  saveApiKey: (key) => ipcRenderer.invoke('save-api-key', key),

  // Session
  startSession: () => ipcRenderer.invoke('start-session'),
  sendMessage: (text) => ipcRenderer.invoke('send-message', text),

  // Approvals
  approveTool: (id) => ipcRenderer.invoke('approve-tool', id),
  denyTool: (id) => ipcRenderer.invoke('deny-tool', id),
  answerQuestion: (id, answers) => ipcRenderer.invoke('answer-question', id, answers),

  // Events from main process
  onPlatform: (cb) => ipcRenderer.on('platform', (_, p) => cb(p)),
  onSdkMessage: (cb) => ipcRenderer.on('sdk-message', (_, msg) => cb(msg)),
  onApprovalRequest: (cb) => ipcRenderer.on('approval-request', (_, data) => cb(data)),
  onAskUserQuestion: (cb) => ipcRenderer.on('ask-user-question', (_, data) => cb(data)),
  onSdkError: (cb) => ipcRenderer.on('sdk-error', (_, err) => cb(err)),
});
