// Merlin PWA — client script.
//
// Two connection modes, decided at page load:
//
//   1. RELAY (roaming)  Primary path. Credentials come from a pair URL
//      (#pair=<sessionId>.<pairCode>) on first load, then live in
//      localStorage for subsequent launches. Connects to
//      wss://relay.merlingotme.com/ws/pwa with the PWA token.
//
//   2. LAN (same WiFi)  Legacy path. URL hash is a raw session token and
//      the page was served by the Electron app's local WS server. This is
//      the zero-infrastructure fallback — still useful at the desk.
//
// Security notes:
//   - The pair code is ONE-SHOT: /pair/claim deletes the server-side row.
//     We strip the fragment immediately after a successful claim so the
//     code doesn't linger in browser history / share sheets.
//   - pwaToken is stored in localStorage scoped to pwa.merlingotme.com.
//     It's the only credential on the device; losing it = re-pair.
//   - Push subscribe happens AFTER WS auth succeeds so we never store a
//     push sub for a session that can't actually route. One less
//     zombie endpoint to clean up.

const RELAY_BASE = 'https://relay.merlingotme.com';
const RELAY_WS_BASE = 'wss://relay.merlingotme.com';
const CREDS_KEY = 'merlin.relay.creds.v1';
const MAX_RECONNECT_MS = 60_000;
const MIN_RECONNECT_MS = 1_500;

let ws = null;
let currentBubble = null;
let textBuffer = '';
let rafPending = false;
let isStreaming = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let mode = null; // 'relay' | 'lan'
let relayCreds = null; // { sessionId, pwaToken, deviceId } — token never logged

const messages = document.getElementById('messages');
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const approval = document.getElementById('approval');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

function setStatus(connected, text) {
  statusDot.className = connected ? 'dot-ok' : 'dot-err';
  statusText.textContent = text || (connected ? 'Connected' : 'Not paired');
}

// ── Credential storage ──────────────────────────────────────
function loadCreds() {
  try {
    const raw = localStorage.getItem(CREDS_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (typeof c?.sessionId === 'string' && typeof c?.pwaToken === 'string' && typeof c?.deviceId === 'string') {
      return c;
    }
  } catch {}
  return null;
}

function saveCreds(c) {
  try { localStorage.setItem(CREDS_KEY, JSON.stringify(c)); } catch {}
}

function clearCreds() {
  try { localStorage.removeItem(CREDS_KEY); } catch {}
  relayCreds = null;
}

// ── Mode detection ──────────────────────────────────────────
function parseHash() {
  const h = window.location.hash ? window.location.hash.slice(1) : '';
  if (!h) return { kind: 'none' };
  if (h.startsWith('pair=')) {
    const v = h.slice(5);
    const dot = v.indexOf('.');
    if (dot > 0) {
      const sessionId = v.slice(0, dot);
      const pairCode  = v.slice(dot + 1);
      if (sessionId && pairCode) return { kind: 'pair', sessionId, pairCode };
    }
  }
  // Legacy: raw LAN token in the hash (base64-ish string)
  if (/^[A-Fa-f0-9]{32}$/.test(h)) return { kind: 'lan', token: h };
  return { kind: 'unknown', raw: h };
}

// ── Pair-code claim ─────────────────────────────────────────
async function claimPairCode(sessionId, pairCode) {
  const label = guessDeviceLabel();
  const resp = await fetch(`${RELAY_BASE}/pair/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, pairCode, label }),
  });
  if (!resp.ok) {
    let err = {};
    try { err = await resp.json(); } catch {}
    throw new Error(err.error || `http_${resp.status}`);
  }
  const data = await resp.json();
  if (!data.sessionId || !data.pwaToken || !data.deviceId) throw new Error('bad_response');
  return { sessionId: data.sessionId, pwaToken: data.pwaToken, deviceId: data.deviceId };
}

function guessDeviceLabel() {
  // Best-effort human-readable label. Capped at 64 chars server-side.
  // We deliberately don't include UA strings or fingerprinting data.
  try {
    const platform = navigator.platform || 'device';
    const ua = navigator.userAgent || '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    return platform.slice(0, 32);
  } catch {
    return 'device';
  }
}

// ── Push subscription ───────────────────────────────────────
async function subscribePush() {
  // Silently no-op on browsers without push (e.g. iOS <16.4 non-standalone,
  // older Safari). The WS path still works; push is additive.
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (!relayCreds) return;

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;

      const keyResp = await fetch(`${RELAY_BASE}/vapid-public`);
      if (!keyResp.ok) return;
      const { key } = await keyResp.json();
      if (!key) return;

      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }

    const json = sub.toJSON();
    await fetch(`${RELAY_BASE}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: relayCreds.sessionId,
        pwaToken: relayCreds.pwaToken,
        deviceId: relayCreds.deviceId,
        subscription: {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        },
      }),
    });
  } catch {
    // Push failures never break the chat. Swallow and move on.
  }
}

function urlBase64ToUint8Array(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('/sw.js'); } catch {}
}

// ── WS connection ───────────────────────────────────────────
function connectRelay() {
  if (!relayCreds) return;
  const url = `${RELAY_WS_BASE}/ws/pwa`
    + `?session=${encodeURIComponent(relayCreds.sessionId)}`
    + `&t=${encodeURIComponent(relayCreds.pwaToken)}`;
  openSocket(url);
}

function connectLan(token) {
  const wsHost = window.location.hostname;
  const wsPort = window.location.port;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${wsHost}${wsPort ? ':' + wsPort : ''}`;
  openSocket(url, () => ws.send(JSON.stringify({ type: 'auth', token })));
}

function openSocket(url, onOpen) {
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectAttempts = 0;
    if (onOpen) onOpen();
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    switch (msg.type) {
      case 'auth-ok':
        setStatus(true);
        // Push subscription is only attempted after auth succeeds.
        if (mode === 'relay') subscribePush();
        break;
      case 'auth-fail':
        setStatus(false);
        if (mode === 'relay') clearCreds();
        try { ws.close(); } catch {}
        break;
      case 'sdk-message':       handleSdkMessage(msg.payload); break;
      case 'approval-request':  showApproval(msg.payload);     break;
      case 'ask-user-question': showQuestion(msg.payload);     break;
      case 'sdk-error':         showError(msg.payload);        break;
      case 'user-message':      addUserBubble('\u{1F5A5}\u{FE0F} ' + msg.payload.text); break;
      case 'transcription':     handleTranscription(msg.payload); break;
    }
  };

  ws.onclose = (ev) => {
    setStatus(false);
    // 1008/4401 = permanent auth failure; clear creds and stop.
    if (ev && (ev.code === 1008 || ev.code === 4401)) {
      if (mode === 'relay') clearCreds();
      setStatus(false);
      return;
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(
    MAX_RECONNECT_MS,
    MIN_RECONNECT_MS * Math.pow(2, Math.min(reconnectAttempts, 6)) + Math.floor(Math.random() * 500),
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (mode === 'relay') connectRelay();
    else if (mode === 'lan' && lanToken) connectLan(lanToken);
  }, delay);
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ── Message Rendering ───────────────────────────────────────
function addUserBubble(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.textContent = text;
  messages.appendChild(div);
  scrollToBottom();
}

function addClaudeBubble() {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg msg-claude';
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = '\u{1FA84}';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble streaming';
  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  currentBubble = bubble;
  textBuffer = '';
  scrollToBottom();
  return bubble;
}

function appendText(text) {
  textBuffer += text;
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      if (currentBubble) currentBubble.innerHTML = renderMarkdown(textBuffer);
      scrollToBottom();
      rafPending = false;
    });
  }
}

function finalizeBubble() {
  if (currentBubble) {
    currentBubble.classList.remove('streaming');
    currentBubble.innerHTML = renderMarkdown(textBuffer);
  }
  currentBubble = null;
  textBuffer = '';
  isStreaming = false;
  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
}

// ── Markdown ────────────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';
  text = text.replace(/^\s*\u{1FA84}\s*/gu, '');
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/<\/li><br>/g, '</li>');
  html = html.replace(/<\/ul><br>/g, '</ul>');
  html = html.replace(/<\/pre><br>/g, '</pre>');
  return html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── SDK Messages ────────────────────────────────────────────
function handleSdkMessage(msg) {
  switch (msg.type) {
    case 'stream_event':
      handleStreamEvent(msg);
      break;
    case 'assistant':
    case 'result':
      finalizeBubble();
      break;
  }
}

function handleStreamEvent(msg) {
  if (msg.parent_tool_use_id) return;
  const event = msg.event;
  if (!event) return;

  if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
    if (!currentBubble) { addClaudeBubble(); isStreaming = true; }
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    appendText(event.delta.text);
  }
  if (event.type === 'message_stop') {
    finalizeBubble();
  }
}

// ── Approvals ───────────────────────────────────────────────
function showApproval({ toolUseID, label, cost }) {
  document.getElementById('approval-label').textContent = label;
  document.getElementById('approval-cost').textContent = cost ? `Cost: ${cost}` : '';

  const approveBtn = document.getElementById('btn-approve');
  approveBtn.textContent = 'Allow';
  if (label.includes('Publish')) approveBtn.textContent = 'Publish';
  else if (label.includes('Generate')) approveBtn.textContent = 'Generate';
  else if (label.includes('Connect')) approveBtn.textContent = 'Connect';

  approval.classList.remove('hidden');
  approveBtn.onclick = () => { send({ type: 'approve-tool', toolUseID }); approval.classList.add('hidden'); };
  document.getElementById('btn-deny').onclick = () => { send({ type: 'deny-tool', toolUseID }); approval.classList.add('hidden'); };
}

// ── Questions ───────────────────────────────────────────────
function showQuestion({ toolUseID, questions }) {
  const answers = {};
  const bubble = addClaudeBubble();
  finalizeBubble();

  const container = document.createElement('div');
  for (const q of questions) {
    const qDiv = document.createElement('div');
    qDiv.style.marginBottom = '12px';
    const label = document.createElement('p');
    label.className = 'question-text';
    label.textContent = q.question;
    qDiv.appendChild(label);

    const chips = document.createElement('div');
    chips.className = 'option-chips';
    for (const opt of q.options) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = opt.label;
      chip.addEventListener('click', () => {
        chips.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
        answers[q.question] = opt.label;
        if (Object.keys(answers).length === questions.length) {
          setTimeout(() => {
            send({ type: 'answer-question', toolUseID, answers });
            container.querySelectorAll('.chip').forEach(c => { c.disabled = true; c.style.cursor = 'default'; });
          }, 200);
        }
      });
      chips.appendChild(chip);
    }
    qDiv.appendChild(chips);
    container.appendChild(qDiv);
  }
  bubble.appendChild(container);
  scrollToBottom();
}

// ── Errors ──────────────────────────────────────────────────
function showError(err) {
  const bubble = addClaudeBubble();
  textBuffer = `Something went wrong: ${err}`;
  finalizeBubble();
  bubble.style.borderColor = 'rgba(239,68,68,.3)';
}

// ── Input ───────────────────────────────────────────────────
function sendMessage() {
  const text = input.value.trim();
  if (!text || isStreaming) return;
  addUserBubble(text);
  send({ type: 'send-message', text });
  input.value = '';
  input.style.height = 'auto';
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
});

// ── Send button: tap = send, hold = record voice ────────────
// Hold threshold keeps short taps feeling like a normal send. Swipe off the
// button mid-hold cancels (iMessage pattern). Recording caps at 15s so the
// base64 payload fits under the relay's 128 KB per-frame cap.
const sendBtn = document.getElementById('send-btn');
const sendIcon = document.getElementById('send-icon');
const micIcon = document.getElementById('mic-icon');
const voicePill = document.getElementById('voice-pill');
const voicePillTitle = document.getElementById('voice-pill-title');
const voicePillSub = document.getElementById('voice-pill-sub');

const HOLD_MS = 300;
const MAX_RECORD_MS = 15_000;
const PENDING_TRANSCRIBE = new Map(); // requestId → { resolve, reject, timer }

let holdTimer = null;
let recordingMediaRecorder = null;
let recordingStream = null;
let recordingChunks = [];
let recordingCapTimer = null;
let isRecording = false;
let isRecordingCanceled = false;

function setRecordingUI(on) {
  if (on) {
    sendBtn.classList.add('recording');
    sendIcon.classList.add('hidden');
    micIcon.classList.remove('hidden');
    voicePill.classList.remove('hidden', 'transcribing');
    voicePillTitle.textContent = 'Listening…';
    voicePillSub.textContent = 'release to send';
    voicePillSub.classList.remove('hidden');
  } else {
    sendBtn.classList.remove('recording');
    sendIcon.classList.remove('hidden');
    micIcon.classList.add('hidden');
    voicePill.classList.add('hidden');
  }
}

function setTranscribingUI(on) {
  if (on) {
    voicePill.classList.remove('hidden');
    voicePill.classList.add('transcribing');
    voicePillTitle.textContent = 'Transcribing…';
    voicePillSub.classList.add('hidden');
    sendBtn.disabled = true;
  } else {
    voicePill.classList.add('hidden');
    voicePill.classList.remove('transcribing');
    sendBtn.disabled = false;
  }
}

async function startRecording() {
  if (isRecording) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    // User denied or no mic — silently abort the hold. No modal: the user
    // intended to send, recording is a progressive enhancement.
    return;
  }
  // Double-check the hold wasn't released while the permission prompt was up.
  if (!holdTimer && !isRecording) {
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
    return;
  }
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm');
  recordingStream = stream;
  recordingChunks = [];
  isRecordingCanceled = false;
  recordingMediaRecorder = new MediaRecorder(stream, { mimeType: mime });
  recordingMediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordingChunks.push(e.data);
  };
  recordingMediaRecorder.onstop = onRecordingStop;
  recordingMediaRecorder.start();
  isRecording = true;
  setRecordingUI(true);
  // Hard cap so we never exceed the relay frame size.
  recordingCapTimer = setTimeout(() => stopRecording(false), MAX_RECORD_MS);
}

function stopRecording(cancel) {
  if (!isRecording) return;
  isRecordingCanceled = !!cancel;
  clearTimeout(recordingCapTimer);
  recordingCapTimer = null;
  try { recordingMediaRecorder && recordingMediaRecorder.stop(); } catch {}
  try { recordingStream && recordingStream.getTracks().forEach(t => t.stop()); } catch {}
  recordingStream = null;
  isRecording = false;
}

async function onRecordingStop() {
  setRecordingUI(false);
  if (isRecordingCanceled || recordingChunks.length === 0) return;
  const mime = recordingMediaRecorder && recordingMediaRecorder.mimeType
    ? recordingMediaRecorder.mimeType
    : 'audio/webm';
  const blob = new Blob(recordingChunks, { type: mime });
  if (blob.size < 2048) return; // too short — silent drop, same as desktop

  setTranscribingUI(true);
  try {
    const text = await transcribeBlob(blob, mime);
    if (text && text.trim()) {
      const prefix = input.value ? input.value.trimEnd() + ' ' : '';
      input.value = (prefix + text.trim()).replace(/^\s+/, '');
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      input.focus();
    }
  } catch (_e) {
    // Surface nothing on failure — user can re-hold or type.
  } finally {
    setTranscribingUI(false);
  }
}

function transcribeBlob(blob, mime) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read-failed'));
    reader.onload = () => {
      const result = reader.result;
      // result is a data URL — strip the "data:*;base64," prefix.
      const comma = String(result).indexOf(',');
      const data = comma >= 0 ? String(result).slice(comma + 1) : '';
      if (!data) return reject(new Error('empty'));
      const requestId = 'tx-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        if (PENDING_TRANSCRIBE.has(requestId)) {
          PENDING_TRANSCRIBE.delete(requestId);
          reject(new Error('timeout'));
        }
      }, 20_000);
      PENDING_TRANSCRIBE.set(requestId, { resolve, reject, timer });
      send({ type: 'transcribe-audio', requestId, mime, data });
    };
    reader.readAsDataURL(blob);
  });
}

function handleTranscription(payload) {
  if (!payload || typeof payload.requestId !== 'string') return;
  const pending = PENDING_TRANSCRIBE.get(payload.requestId);
  if (!pending) return;
  PENDING_TRANSCRIBE.delete(payload.requestId);
  clearTimeout(pending.timer);
  if (payload.error) pending.reject(new Error(payload.error));
  else pending.resolve(typeof payload.text === 'string' ? payload.text : '');
}

sendBtn.addEventListener('pointerdown', (e) => {
  if (isStreaming) return;
  e.preventDefault();
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    holdTimer = null;
    startRecording();
  }, HOLD_MS);
});
sendBtn.addEventListener('pointerup', () => {
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
    sendMessage();
    return;
  }
  if (isRecording) stopRecording(false);
});
sendBtn.addEventListener('pointerleave', () => {
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
    return;
  }
  if (isRecording) stopRecording(true);
});
sendBtn.addEventListener('pointercancel', () => {
  clearTimeout(holdTimer);
  holdTimer = null;
  if (isRecording) stopRecording(true);
});

// ── Install banner (Android/Chrome beforeinstallprompt + iOS hint) ─
// Shown once per device (dismiss persists in localStorage). Never nagged
// on users already running in standalone mode.
const INSTALL_DISMISS_KEY = 'merlin.install.dismissed.v1';
const installBanner = document.getElementById('install-banner');
const installYes = document.getElementById('install-yes');
const installNo = document.getElementById('install-no');
let deferredInstallPrompt = null;

function isStandalone() {
  return window.matchMedia && window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
function installDismissed() {
  try { return localStorage.getItem(INSTALL_DISMISS_KEY) === '1'; } catch { return false; }
}
function dismissInstall() {
  try { localStorage.setItem(INSTALL_DISMISS_KEY, '1'); } catch {}
  installBanner.classList.add('hidden');
}
function showInstallBanner(iosHint) {
  if (installDismissed() || isStandalone()) return;
  if (iosHint) {
    document.getElementById('install-desc').textContent = 'Tap Share → Add to Home Screen.';
    installYes.classList.add('hidden');
  }
  installBanner.classList.remove('hidden');
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner(false);
});
installYes && installYes.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  try {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
  } catch {}
  deferredInstallPrompt = null;
  dismissInstall();
});
installNo && installNo.addEventListener('click', dismissInstall);
// iOS path: beforeinstallprompt never fires. Wait a bit so we don't flash
// the banner during a rapid reconnect, then show the Share-sheet hint.
if (isIOS() && !isStandalone() && !installDismissed()) {
  setTimeout(() => showInstallBanner(true), 2500);
}

// ── Init ────────────────────────────────────────────────────
let lanToken = null;

async function init() {
  const parsed = parseHash();

  if (parsed.kind === 'lan') {
    // Legacy LAN path — served by the Electron app directly.
    mode = 'lan';
    lanToken = parsed.token;
    setStatus(false, 'Connecting');
    connectLan(lanToken);
    return;
  }

  mode = 'relay';
  await registerServiceWorker();

  if (parsed.kind === 'pair') {
    setStatus(false, 'Connecting');
    try {
      relayCreds = await claimPairCode(parsed.sessionId, parsed.pairCode);
      saveCreds(relayCreds);
      // Strip the fragment so the one-shot pair code isn't kept in history.
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (e) {
      setStatus(false);
      return;
    }
  } else {
    relayCreds = loadCreds();
  }

  if (!relayCreds) {
    setStatus(false);
    return;
  }

  setStatus(false, 'Connecting');
  connectRelay();
}

init();
