// ── Connection ──────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const host = params.get('host');
const port = params.get('port');
const token = params.get('token');

let ws = null;
let currentBubble = null;
let textBuffer = '';
let rafPending = false;
let isStreaming = false;

const messages = document.getElementById('messages');
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const approval = document.getElementById('approval');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

function setStatus(connected) {
  statusDot.className = connected ? 'dot-ok' : 'dot-err';
  statusText.textContent = connected ? 'Connected' : 'Reconnecting...';
}

function connect() {
  if (!host || !port || !token) {
    statusText.textContent = 'Missing connection info';
    return;
  }

  ws = new WebSocket(`ws://${host}:${port}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'auth-ok':
        setStatus(true);
        break;
      case 'auth-fail':
        statusText.textContent = 'Auth failed — scan QR again';
        statusDot.className = 'dot-err';
        break;
      case 'sdk-message':
        handleSdkMessage(msg.payload);
        break;
      case 'approval-request':
        showApproval(msg.payload);
        break;
      case 'ask-user-question':
        showQuestion(msg.payload);
        break;
      case 'sdk-error':
        showError(msg.payload);
        break;
    }
  };

  ws.onclose = () => {
    setStatus(false);
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    ws.close();
  };
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
      finalizeBubble();
      break;
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
document.getElementById('send-btn').addEventListener('click', sendMessage);
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
});

// ── Init ────────────────────────────────────────────────────
connect();
