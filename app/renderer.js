// ── State ────────────────────────────────────────────────────
let currentBubble = null;
let isStreaming = false;
let textBuffer = '';
let rafPending = false;

const messages = document.getElementById('messages');
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const setup = document.getElementById('setup');
const approval = document.getElementById('approval');

// ── Platform Detection ──────────────────────────────────────
merlin.onPlatform((platform) => {
  if (platform === 'win32') {
    document.getElementById('win-controls').classList.remove('hidden');
    document.getElementById('btn-min').onclick = () => merlin.invoke?.('win-minimize');
    document.getElementById('btn-max').onclick = () => merlin.invoke?.('win-maximize');
    document.getElementById('btn-close').onclick = () => merlin.invoke?.('win-close');
  }
});

// ── Setup Flow ──────────────────────────────────────────────
async function init() {
  const result = await merlin.checkSetup();
  if (result.ready) {
    // Claude is installed and authenticated — skip setup, go straight to /cmo
    setup.classList.add('hidden');
    await merlin.startSession();
  } else {
    // Show setup — user needs Claude Desktop
    document.getElementById('setup-status').textContent = result.reason || 'Install Claude Desktop to get started.';
  }
}

document.getElementById('setup-install-btn').addEventListener('click', () => {
  merlin.openClaudeDownload();
});

document.getElementById('setup-retry-btn').addEventListener('click', async () => {
  document.getElementById('setup-status').textContent = 'Checking...';
  const result = await merlin.checkSetup();
  if (result.ready) {
    setup.style.animation = 'fadeOut .3s ease forwards';
    setTimeout(async () => {
      setup.classList.add('hidden');
      setup.style.animation = '';
      await merlin.startSession();
    }, 300);
  } else {
    document.getElementById('setup-status').textContent = result.reason || 'Claude Desktop not found.';
  }
});

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
  avatar.textContent = '🪄';

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
      if (currentBubble) {
        currentBubble.innerHTML = renderMarkdown(textBuffer);
      }
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
  requestAnimationFrame(() => {
    chat.scrollTop = chat.scrollHeight;
  });
}

// ── Minimal Markdown Renderer ───────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';

  // Strip mascot prefix if Claude prepends it
  text = text.replace(/^\s*🪄\s*/g, '');

  let html = escapeHtml(text);

  // Code blocks (triple backtick)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bullet lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  // Clean up double breaks in lists
  html = html.replace(/<\/li><br>/g, '</li>');
  html = html.replace(/<\/ul><br>/g, '</ul>');
  html = html.replace(/<\/pre><br>/g, '</pre>');
  html = html.replace(/<\/h[123]><br>/g, (m) => m.replace('<br>', ''));

  return html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── SDK Message Handling ────────────────────────────────────
merlin.onSdkMessage((msg) => {
  switch (msg.type) {
    case 'system':
      // Session init — ready
      break;

    case 'stream_event':
      handleStreamEvent(msg);
      break;

    case 'assistant':
      finalizeBubble();
      break;

    case 'result':
      finalizeBubble();
      isStreaming = false;
      break;
  }
});

function handleStreamEvent(msg) {
  // Skip tool subprocess output (subagent messages)
  if (msg.parent_tool_use_id) return;

  const event = msg.event;
  if (!event) return;

  if (event.type === 'content_block_start') {
    if (event.content_block && event.content_block.type === 'text') {
      if (!currentBubble) {
        addClaudeBubble();
        isStreaming = true;
      }
    }
  }

  if (event.type === 'content_block_delta') {
    if (event.delta && event.delta.type === 'text_delta' && event.delta.text) {
      appendText(event.delta.text);
    }
  }

  if (event.type === 'message_stop') {
    finalizeBubble();
  }
}

// ── Approval Cards ──────────────────────────────────────────
merlin.onApprovalRequest(({ toolUseID, label, cost }) => {
  document.getElementById('approval-label').textContent = label;
  document.getElementById('approval-cost').textContent = cost ? `Cost: ${cost}` : '';

  const approveBtn = document.getElementById('btn-approve');
  const denyBtn = document.getElementById('btn-deny');

  // Reset button text to action-specific
  approveBtn.textContent = 'Allow';
  if (label.includes('Publish')) approveBtn.textContent = 'Publish';
  else if (label.includes('Generate')) approveBtn.textContent = 'Generate';
  else if (label.includes('Connect')) approveBtn.textContent = 'Connect';
  else if (label.includes('Pause')) approveBtn.textContent = 'Pause';
  else if (label.includes('Scale')) approveBtn.textContent = 'Scale';

  approval.classList.remove('hidden');

  approveBtn.onclick = () => {
    merlin.approveTool(toolUseID);
    approval.classList.add('hidden');
  };
  denyBtn.onclick = () => {
    merlin.denyTool(toolUseID);
    approval.classList.add('hidden');
  };
});

// ── AskUserQuestion (Option Chips) ──────────────────────────
merlin.onAskUserQuestion(({ toolUseID, questions }) => {
  const answers = {};
  const bubble = addClaudeBubble();
  finalizeBubble(); // Stop streaming cursor

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
      if (opt.description) chip.title = opt.description;
      chip.addEventListener('click', () => {
        // Deselect siblings
        chips.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
        answers[q.question] = opt.label;

        // If all questions answered, submit
        if (Object.keys(answers).length === questions.length) {
          setTimeout(() => {
            merlin.answerQuestion(toolUseID, answers);
            // Disable all chips after answering
            container.querySelectorAll('.chip').forEach(c => {
              c.disabled = true;
              c.style.cursor = 'default';
            });
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
});

// ── Error Handling ──────────────────────────────────────────
merlin.onSdkError((err) => {
  const bubble = addClaudeBubble();
  textBuffer = `Something went wrong: ${err}\n\nTry sending your message again.`;
  finalizeBubble();
  bubble.style.borderColor = 'rgba(239,68,68,.3)';
});

// ── Update Toast ────────────────────────────────────────────
merlin.onUpdateAvailable(({ current, latest, url }) => {
  document.getElementById('update-text').textContent = `Merlin ${latest} is available (you have ${current})`;
  document.getElementById('update-toast').classList.remove('hidden');

  document.getElementById('update-btn').onclick = () => {
    window.open(url, '_blank');
    document.getElementById('update-toast').classList.add('hidden');
  };
  document.getElementById('update-dismiss').onclick = () => {
    document.getElementById('update-toast').classList.add('hidden');
  };
});

// ── Remote User Messages (from PWA) ─────────────────────────
merlin.onRemoteUserMessage((text) => {
  addUserBubble('📱 ' + text);
});

// ── Mobile QR ───────────────────────────────────────────────
document.getElementById('mobile-btn').addEventListener('click', async () => {
  const { qrDataUri, pwaUrl } = await merlin.getMobileQR();
  document.getElementById('qr-image').src = qrDataUri;
  document.getElementById('qr-url').textContent = pwaUrl;
  document.getElementById('qr-modal').classList.remove('hidden');
});

document.getElementById('qr-close').addEventListener('click', () => {
  document.getElementById('qr-modal').classList.add('hidden');
});

document.getElementById('qr-modal').addEventListener('click', (e) => {
  if (e.target.id === 'qr-modal') {
    document.getElementById('qr-modal').classList.add('hidden');
  }
});

// ── Input Handling ──────────────────────────────────────────
function sendMessage() {
  const text = input.value.trim();
  if (!text || isStreaming) return;

  addUserBubble(text);
  merlin.sendMessage(text);
  input.value = '';
  autoResize();
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener('click', sendMessage);

// Auto-resize textarea
function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}
input.addEventListener('input', autoResize);

// ── Init ────────────────────────────────────────────────────
init();
