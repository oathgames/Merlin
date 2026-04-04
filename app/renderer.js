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
let turnStartTime = null;
let turnTokens = 0;
let sessionTotalTokens = 0;

// ── Subscription ────────────────────────────────────────────
(async function checkSubscription() {
  const sub = await merlin.getSubscription();
  const btn = document.getElementById('subscribe-btn');
  if (sub?.subscribed) {
    btn.classList.add('hidden-sub');
  } else {
    const days = sub?.daysLeft ?? 7;
    document.getElementById('trial-text').textContent = days === 0 ? 'Trial Ended' : `${days}D Left`;
  }
})();

document.getElementById('subscribe-btn').addEventListener('click', () => {
  merlin.openSubscribe();
});

// ── Window Controls ─────────────────────────────────────────
document.getElementById('btn-min').addEventListener('click', () => merlin.winMinimize());
document.getElementById('btn-max').addEventListener('click', () => merlin.winMaximize());
document.getElementById('btn-close').addEventListener('click', () => merlin.winClose());

// ── Setup Flow ──────────────────────────────────────────────
async function init() {
  // Show chat immediately with a welcome message — no blank screen
  setup.classList.add('hidden');

  const welcomeBubble = addClaudeBubble();
  // Instant animated welcome — shows before SDK even connects
  welcomeBubble.classList.remove('streaming');

  const welcomeLines = [
    { text: '✦ Hey — I\'m Merlin, your marketing wizard.' },
    { text: 'One moment while I check things out...' },
  ];

  let lineIndex = 0;
  welcomeBubble.innerHTML = welcomeLines[0].text;

  window._welcomeInterval = setInterval(() => {
    lineIndex++;
    if (lineIndex < welcomeLines.length) {
      welcomeBubble.innerHTML += '<br><br>' + welcomeLines[lineIndex].text;
      scrollToBottom();
    } else {
      clearInterval(window._welcomeInterval);
    }
  }, 1500);

  // Start session in background — when SDK connects, it takes over
  merlin.checkSetup().then((result) => {
    if (result.ready) {
      turnStartTime = Date.now();
      sessionActive = true;
      merlin.startSession();
    } else {
      clearInterval(window._welcomeInterval);
      setup.classList.remove('hidden');
      document.getElementById('setup-status').textContent = result.reason || 'Install Claude Desktop to get started.';
      welcomeBubble.parentElement.remove();
    }
  });

  // When SDK sends first real message, DON'T remove the welcome —
  // let the conversation continue naturally below it
  window._welcomeShown = true;
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
  avatar.textContent = '✦';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble streaming';

  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);

  currentBubble = bubble;
  textBuffer = '';
  lastRenderedLength = 0;
  scrollToBottom();
  return bubble;
}

let lastRenderedLength = 0;

function appendText(text) {
  textBuffer += text;
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      if (currentBubble) {
        // Only re-render if buffer grew significantly (reduces layout thrashing)
        if (textBuffer.length - lastRenderedLength > 20 || textBuffer.includes('\n')) {
          currentBubble.innerHTML = renderMarkdown(textBuffer);
          lastRenderedLength = textBuffer.length;
        } else {
          // For small deltas, just update textContent of last text node
          currentBubble.innerHTML = renderMarkdown(textBuffer);
        }
      }
      scrollToBottom();
      rafPending = false;
    });
  }
}

let sessionActive = false;

let typingTimeout = null;

function finalizeBubble() {
  if (currentBubble) {
    currentBubble.classList.remove('streaming');
    currentBubble.innerHTML = renderMarkdown(textBuffer);
  }
  currentBubble = null;
  textBuffer = '';
  isStreaming = false;
  scrollToBottom();
  // If session is still active, show typing indicator after a pause
  // Long delay prevents flickering during rapid stream events
  scheduleTypingIndicator();
}

function scheduleTypingIndicator() {
  if (typingTimeout) clearTimeout(typingTimeout);
  typingTimeout = null;
  if (sessionActive) {
    typingTimeout = setTimeout(() => {
      if (sessionActive && !currentBubble && !isStreaming) {
        showTypingIndicator();
      }
    }, 1500);
  }
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    chat.scrollTop = chat.scrollHeight;
  });
}

// ── Performance: limit DOM nodes for long conversations ─────
const MAX_VISIBLE_MESSAGES = 200;

function pruneOldMessages() {
  const allMsgs = messages.querySelectorAll('.msg, .stats-bar');
  if (allMsgs.length > MAX_VISIBLE_MESSAGES) {
    const toRemove = allMsgs.length - MAX_VISIBLE_MESSAGES;
    for (let i = 0; i < toRemove; i++) {
      allMsgs[i].remove();
    }
  }
}

// Prune every 30 seconds to keep DOM lean
setInterval(pruneOldMessages, 30000);

// ── Markdown Renderer with Image Support ────────────────────
function renderMarkdown(text) {
  if (!text) return '';

  // Strip mascot prefix if Claude prepends it
  text = text.replace(/^\s*✦\s*/g, '');

  let html = escapeHtml(text);

  // Code blocks (triple backtick) — preserve content
  const codeBlocks = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code class="lang-${lang || 'text'}">${code}</code></pre>`);
    return `%%CODEBLOCK_${codeBlocks.length - 1}%%`;
  });

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
  // Numbered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Image file paths → inline <img>
  html = html.replace(/(?:\.\/)?([a-zA-Z0-9_\-\.\/]+\.(?:jpg|jpeg|png|gif|webp))/gi, (match, p1) => {
    if (p1.includes('/')) return `<img src="merlin://${p1}" alt="Image" loading="lazy">`;
    return match;
  });

  // Video file paths → inline <video>
  html = html.replace(/(?:\.\/)?([a-zA-Z0-9_\-\.\/]+\.(?:mp4|webm|mov))/gi, (match, p1) => {
    if (p1.includes('/')) return `<video src="merlin://${p1}" controls playsinline preload="metadata" style="max-width:100%;border-radius:10px;margin:8px 0"></video>`;
    return match;
  });

  // Line breaks
  html = html.replace(/\n/g, '<br>');
  // Clean up
  html = html.replace(/<\/li><br>/g, '</li>');
  html = html.replace(/<\/ul><br>/g, '</ul>');
  html = html.replace(/<\/pre><br>/g, '</pre>');
  html = html.replace(/<\/h[123]><br>/g, (m) => m.replace('<br>', ''));
  html = html.replace(/<hr><br>/g, '<hr>');

  // Restore code blocks
  codeBlocks.forEach((block, i) => {
    html = html.replace(`%%CODEBLOCK_${i}%%`, block);
  });

  return html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── SDK Message Handling ────────────────────────────────────
let firstMessage = true;

merlin.onSdkMessage((msg) => {
  // When first real SDK content arrives, clean up welcome state
  if (firstMessage && msg.type === 'stream_event') {
    if (window._welcomeInterval) clearInterval(window._welcomeInterval);
    firstMessage = false;
    currentBubble = null;
    textBuffer = '';
  }

  // Remove typing indicator + cancel pending when real content starts
  if (msg.type === 'stream_event' && msg.event?.type === 'content_block_start') {
    if (typingTimeout) { clearTimeout(typingTimeout); typingTimeout = null; }
    removeTypingIndicator();
    stopTickingTimer();
  }


  // Track token usage from message_delta events
  if (msg.type === 'stream_event' && msg.event?.type === 'message_delta' && msg.event?.usage) {
    turnTokens = (turnTokens || 0) + (msg.event.usage.output_tokens || 0);
  }

  switch (msg.type) {
    case 'system':
      // Session init — ready
      break;

    case 'stream_event':
      handleStreamEvent(msg);
      break;

    case 'assistant':
      finalizeBubble();
      // Check for image content blocks in the assistant message
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'image' && block.source?.data) {
            const imgBubble = addClaudeBubble();
            imgBubble.innerHTML = `<img src="data:${block.source.media_type || 'image/png'};base64,${block.source.data}" alt="Image">`;
            imgBubble.classList.remove('streaming');
            currentBubble = null;
            textBuffer = '';
          }
        }
      }
      break;

    case 'result':
      sessionActive = false;
      if (typingTimeout) { clearTimeout(typingTimeout); typingTimeout = null; }
      finalizeBubble();
      removeTypingIndicator();
      isStreaming = false;
      stopTickingTimer();
      // Show stats bar like Claude Desktop
      if (turnStartTime) {
        const duration = ((Date.now() - turnStartTime) / 1000).toFixed(0);
        const statsDiv = document.createElement('div');
        statsDiv.className = 'stats-bar';
        // Try multiple paths for token count
        const tokens = msg.usage?.output_tokens
          || msg.result?.usage?.output_tokens
          || msg.num_output_tokens
          || null;
        let statsText = `${duration}s`;
        // Use turn token count from message_delta events
        const numTurns = msg.num_turns || '';
        if (turnTokens > 0) statsText += ` · ${turnTokens} tokens`;
        statsDiv.textContent = statsText;
        messages.appendChild(statsDiv);
        scrollToBottom();
        turnStartTime = null;
      }
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
merlin.onUpdateAvailable(({ current, latest }) => {
  document.getElementById('update-text').textContent = `Merlin ${latest} is available`;
  document.getElementById('update-btn').textContent = 'Update';
  document.getElementById('update-toast').classList.remove('hidden');

  document.getElementById('update-btn').onclick = () => {
    document.getElementById('update-btn').disabled = true;
    document.getElementById('update-btn').textContent = 'Updating...';
    document.getElementById('update-dismiss').classList.add('hidden');
    merlin.applyUpdate();
  };
  document.getElementById('update-dismiss').onclick = () => {
    document.getElementById('update-toast').classList.add('hidden');
  };
});

merlin.onUpdateProgress((msg) => {
  document.getElementById('update-text').textContent = msg;
});

merlin.onUpdateReady(({ latest }) => {
  document.getElementById('update-text').textContent = `Merlin ${latest} installed`;
  document.getElementById('update-btn').textContent = 'Restart';
  document.getElementById('update-btn').disabled = false;
  document.getElementById('update-btn').onclick = () => {
    merlin.restartApp();
  };
});

merlin.onUpdateError((err) => {
  document.getElementById('update-text').textContent = `Update failed: ${err}`;
  document.getElementById('update-btn').textContent = 'Retry';
  document.getElementById('update-btn').disabled = false;
  document.getElementById('update-btn').onclick = () => {
    document.getElementById('update-btn').textContent = 'Updating...';
    document.getElementById('update-btn').disabled = true;
    merlin.applyUpdate();
  };
  document.getElementById('update-dismiss').classList.remove('hidden');
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

// ── Magic Panel ─────────────────────────────────────────────
// ── Brand + Integration Filtering ────────────────────────────
const verticalIntegrations = {
  ecom:    ['meta','tiktok','shopify','klaviyo','google','pinterest','fal','elevenlabs','heygen','attentive','slack'],
  apparel: ['meta','tiktok','shopify','klaviyo','google','pinterest','fal','elevenlabs','heygen','attentive','slack'],
  skincare:['meta','tiktok','shopify','klaviyo','google','pinterest','fal','elevenlabs','attentive','slack'],
  fitness: ['meta','tiktok','google','fal','elevenlabs','heygen','slack'],
  food:    ['meta','tiktok','shopify','klaviyo','google','fal','attentive','slack'],
  tech:    ['meta','google','tiktok','fal','elevenlabs','slack'],
  gaming:  ['meta','tiktok','google','fal','heygen','discord','slack'],
  saas:    ['meta','google','klaviyo','fal','slack'],
};

function loadBrands() {
  return merlin.getBrands().then((brands) => {
    const select = document.getElementById('brand-select');
    select.innerHTML = '';
    if (!brands || brands.length === 0) {
      select.innerHTML = '<option value="">No brand loaded</option>';
      return;
    }
    brands.forEach((b, i) => {
      const opt = document.createElement('option');
      opt.value = b.name;
      opt.textContent = `${b.name} (${b.productCount} products)`;
      if (i === 0) opt.selected = true;
      select.appendChild(opt);
    });
    // Set vertical tag + filter integrations
    if (brands[0]?.vertical) updateVertical(brands[0].vertical);
  }).catch(() => {});
}

function updateVertical(vertical) {
  const tag = document.getElementById('vertical-tag');
  const v = document.getElementById('brand-vertical');
  if (vertical) {
    tag.textContent = vertical;
    v.textContent = `Category: ${vertical}`;
    // Filter integrations
    const allowed = verticalIntegrations[vertical.toLowerCase()] || null;
    if (allowed) {
      document.querySelectorAll('.magic-tile').forEach(tile => {
        tile.style.display = allowed.includes(tile.dataset.platform) ? '' : 'none';
      });
    }
  } else {
    tag.textContent = '';
    v.textContent = '';
    document.querySelectorAll('.magic-tile').forEach(t => t.style.display = '');
  }
}

document.getElementById('brand-select').addEventListener('change', (e) => {
  merlin.getBrands().then((brands) => {
    const brand = brands.find(b => b.name === e.target.value);
    if (brand?.vertical) updateVertical(brand.vertical);
    else updateVertical('');
  });
});

document.getElementById('add-brand-btn').addEventListener('click', () => {
  document.getElementById('magic-panel').classList.add('hidden');
  const msg = 'Set up a new brand for me';
  addUserBubble(msg);
  showTypingIndicator();
  turnStartTime = Date.now();
  turnTokens = 0;
  sessionActive = true;
  startTickingTimer();
  merlin.sendMessage(msg);
});

function loadConnections() {
  merlin.getConnectedPlatforms().then((connected) => {
    const connectedSection = document.getElementById('connected-tiles');
    const noConnections = document.getElementById('no-connections');
    const availableTiles = document.getElementById('available-tiles');

    // Always reset: show all available tiles, clear connected section
    connectedSection.innerHTML = '';
    availableTiles.querySelectorAll('.magic-tile').forEach(t => {
      t.style.display = '';
      t.classList.remove('connected');
    });

    if (!connected || connected.length === 0) {
      noConnections.style.display = 'block';
      return;
    }

    noConnections.style.display = 'none';

    connected.forEach(platform => {
      const tile = availableTiles.querySelector(`.magic-tile[data-platform="${platform}"]`);
      if (tile) {
        // Clone into connected section
        const clone = tile.cloneNode(true);
        clone.classList.add('connected');
        connectedSection.appendChild(clone);
        // Hide the original in available
        tile.style.display = 'none';
      }
    });
  }).catch(() => {});
}

document.getElementById('magic-btn').addEventListener('click', () => {
  const panel = document.getElementById('magic-panel');
  panel.classList.toggle('hidden');
  // Load brands first (sets vertical filter), then connections (hides connected from available)
  if (!panel.classList.contains('hidden')) {
    loadBrands().then(() => loadConnections());
    merlin.getCredits().then((credits) => {
      if (!credits) return;
      // Update tiles with credit info
      document.querySelectorAll('.magic-tile').forEach(tile => {
        const platform = tile.dataset.platform;
        const existing = tile.querySelector('.tile-credits');
        if (existing) existing.remove();
        if (credits[platform]) {
          const span = document.createElement('div');
          span.className = 'tile-credits';
          span.textContent = credits[platform];
          tile.appendChild(span);
        }
      });
    }).catch(() => {});
  }
});
document.getElementById('magic-close').addEventListener('click', () => {
  document.getElementById('magic-panel').classList.add('hidden');
});

// Close panel when clicking outside it
document.addEventListener('click', (e) => {
  const panel = document.getElementById('magic-panel');
  const btn = document.getElementById('magic-btn');
  if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== btn) {
    panel.classList.add('hidden');
  }
});

// Connect platform tiles — clicking sends a natural language message
document.querySelectorAll('.magic-tile').forEach(tile => {
  tile.addEventListener('click', () => {
    const platform = tile.dataset.platform;
    const names = {
      meta: 'Connect my Meta Ads account',
      tiktok: 'Connect my TikTok Ads account',
      shopify: 'Connect my Shopify store',
      klaviyo: 'Connect my Klaviyo account',
      google: 'Connect my Google Ads account',
      pinterest: 'Connect my Pinterest Ads account',
      fal: 'Set up fal.ai for image generation',
      elevenlabs: 'Set up ElevenLabs for voice',
      heygen: 'Set up HeyGen for video avatars',
      attentive: 'Connect Attentive for SMS marketing',
      discord: 'Connect Discord for community management',
      slack: 'Connect Slack for notifications',
    };
    if (names[platform]) {
      document.getElementById('magic-panel').classList.add('hidden');
      addUserBubble(names[platform]);
      showTypingIndicator();
      turnStartTime = Date.now();
      turnTokens = 0;
      sessionActive = true;
      startTickingTimer();
      merlin.sendMessage(names[platform]);
    }
  });
});

// Request a platform
document.getElementById('request-toggle').addEventListener('click', () => {
  document.getElementById('request-form').classList.toggle('hidden');
});
document.getElementById('request-send').addEventListener('click', () => {
  const text = document.getElementById('request-input').value.trim();
  if (!text) return;
  // Send silently via fetch to a webhook (no window/email popup)
  fetch('https://merlin-wisdom.ryan-fec.workers.dev/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'platform-request', text, ts: Date.now() }),
  }).catch(() => {});
  document.getElementById('request-form').classList.add('hidden');
  document.getElementById('request-thanks').classList.remove('hidden');
  document.getElementById('request-input').value = '';
  setTimeout(() => document.getElementById('request-thanks').classList.add('hidden'), 3000);
});
document.getElementById('request-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('request-send').click();
});

// Add scheduled task button
document.getElementById('add-task-btn').addEventListener('click', () => {
  document.getElementById('magic-panel').classList.add('hidden');
  const msg = 'I want to add a new scheduled task. What would be useful?';
  addUserBubble(msg);
  showTypingIndicator();
  turnStartTime = Date.now();
  turnTokens = 0;
  sessionActive = true;
  startTickingTimer();
  merlin.sendMessage(msg);
});

// Autopilot row clicks
document.querySelectorAll('.autopilot-row').forEach(row => {
  row.addEventListener('click', () => {
    document.getElementById('magic-panel').classList.add('hidden');
    const taskName = row.textContent.trim().replace(/\d+\s*(AM|PM|Mon).*/, '').trim();
    const msg = `Tell me about the "${taskName}" scheduled task and let me configure it.`;
    addUserBubble(msg);
    showTypingIndicator();
    turnStartTime = Date.now();
    turnTokens = 0;
    sessionActive = true;
    startTickingTimer();
    merlin.sendMessage(msg);
  });
});

// ── Input Handling ──────────────────────────────────────────
// ── Ticking Timer ───────────────────────────────────────────
let tickerInterval = null;
let tickerEl = null;

function startTickingTimer() {
  stopTickingTimer();
  tickerEl = document.createElement('div');
  tickerEl.className = 'stats-bar ticker-live';
  tickerEl.textContent = '0s';
  messages.appendChild(tickerEl);
  scrollToBottom();
  const start = Date.now();
  tickerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    tickerEl.textContent = `${elapsed}s...`;
    scrollToBottom();
  }, 1000);
}

function stopTickingTimer() {
  if (tickerInterval) { clearInterval(tickerInterval); tickerInterval = null; }
  if (tickerEl) { tickerEl.remove(); tickerEl = null; }
}

// ── Typing Indicator ────────────────────────────────────────
function showTypingIndicator() {
  // Remove any existing indicator
  removeTypingIndicator();
  const wrapper = document.createElement('div');
  wrapper.className = 'msg msg-claude typing-indicator';
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = '✦';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = '<div class="dot-pulse"><span></span><span></span><span></span></div>';
  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  scrollToBottom();
}

function removeTypingIndicator() {
  const existing = document.querySelector('.typing-indicator');
  if (existing) existing.remove();
}

function sendMessage() {
  const text = input.value.trim();
  if (!text || isStreaming) return;

  addUserBubble(text);
  showTypingIndicator();
  turnStartTime = Date.now();
  turnTokens = 0;
  sessionActive = true;
  startTickingTimer();
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

// ── Image/Video Paste + Drag-Drop ───────────────────────────
function savePastedMedia(file) {
  if (!file) return;
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isVideo) return;

  const reader = new FileReader();
  reader.onload = () => {
    const ext = file.type.split('/')[1] === 'jpeg' ? 'jpg' : (file.type.split('/')[1] || 'png');
    const filename = `pasted_${Date.now()}.${ext}`;
    merlin.savePastedMedia(reader.result, filename).then((savedPath) => {
      // Show preview inline
      addUserBubble(`📎 ${file.name || filename}`);
      const mediaDiv = document.createElement('div');
      mediaDiv.className = 'msg msg-user';
      if (isImage) {
        mediaDiv.innerHTML = `<img src="${reader.result}" alt="Pasted" style="max-width:100%;border-radius:10px">`;
      } else {
        mediaDiv.innerHTML = `<video src="${reader.result}" controls playsinline style="max-width:100%;border-radius:10px"></video>`;
      }
      messages.appendChild(mediaDiv);
      scrollToBottom();
      // Tell Claude
      showTypingIndicator();
      turnStartTime = Date.now();
      turnTokens = 0;
      sessionActive = true;
      startTickingTimer();
      const type = isImage ? 'image' : 'video';
      merlin.sendMessage(`I just pasted a ${type} — saved at ${savedPath}. Take a look.`);
    });
  };
  reader.readAsDataURL(file);
}

input.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/') || item.type.startsWith('video/')) {
      e.preventDefault();
      savePastedMedia(item.getAsFile());
      return;
    }
  }
});

const chatEl = document.getElementById('chat');
chatEl.addEventListener('dragover', (e) => { e.preventDefault(); chatEl.classList.add('drag-over'); });
chatEl.addEventListener('dragleave', () => { chatEl.classList.remove('drag-over'); });
chatEl.addEventListener('drop', (e) => {
  e.preventDefault();
  chatEl.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file && (file.type.startsWith('image/') || file.type.startsWith('video/'))) savePastedMedia(file);
});

// ── Init ────────────────────────────────────────────────────
init();
