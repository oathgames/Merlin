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

// Platform-specific UI adjustments
if (merlin.platform === 'darwin') {
  // Hide Windows-style controls on Mac (traffic lights are native)
  document.querySelectorAll('.win-ctrl').forEach(el => el.style.display = 'none');
  // Add left padding for traffic lights
  document.getElementById('titlebar').style.paddingLeft = '72px';
  document.body.classList.add('platform-mac');
}
let turnStartTime = null;
let turnTokens = 0;
let sessionTotalTokens = 0;

// ── Inline Modal (replaces native prompt/alert) ────────────
function showModal({ title, body, inputPlaceholder, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  const modal = document.getElementById('merlin-modal');
  const titleEl = document.getElementById('merlin-modal-title');
  const bodyEl = document.getElementById('merlin-modal-body');
  const inputEl = document.getElementById('merlin-modal-input');
  const errorEl = document.getElementById('merlin-modal-error');
  const confirmBtn = document.getElementById('merlin-modal-confirm');
  const cancelBtn = document.getElementById('merlin-modal-cancel');
  const closeBtn = document.getElementById('merlin-modal-close');

  titleEl.textContent = title || '';
  bodyEl.textContent = body || '';
  errorEl.textContent = '';
  confirmBtn.textContent = confirmLabel || 'OK';
  cancelBtn.textContent = cancelLabel || 'Cancel';

  if (inputPlaceholder !== undefined) {
    inputEl.classList.remove('hidden');
    inputEl.value = '';
    inputEl.placeholder = inputPlaceholder;
    setTimeout(() => inputEl.focus(), 50);
  } else {
    inputEl.classList.add('hidden');
  }

  modal.classList.remove('hidden');

  function cleanup() {
    modal.classList.add('hidden');
    confirmBtn.onclick = null;
    cancelBtn.onclick = null;
    closeBtn.onclick = null;
    inputEl.onkeydown = null;
    document.removeEventListener('keydown', escHandler);
  }

  function escHandler(e) {
    if (e.key === 'Escape') { cleanup(); }
  }
  document.addEventListener('keydown', escHandler);

  confirmBtn.onclick = () => {
    const value = inputPlaceholder !== undefined ? inputEl.value.trim() : true;
    cleanup();
    if (onConfirm) onConfirm(value);
  };
  cancelBtn.onclick = () => {
    cleanup();
    if (onCancel) onCancel();
  };
  closeBtn.onclick = () => { cleanup(); };
  if (inputPlaceholder !== undefined) {
    inputEl.onkeydown = (e) => { if (e.key === 'Enter') confirmBtn.click(); };
  }
}

function showModalError(text) {
  document.getElementById('merlin-modal-error').textContent = text;
}

// ── Subscription ────────────────────────────────────────────
let _trialExpired = false;

(async function checkSubscription() {
  const sub = await merlin.getSubscription();
  const btn = document.getElementById('subscribe-btn');
  if (sub?.subscribed) {
    // Show "Manage Pro" instead of hiding entirely
    document.getElementById('trial-text').textContent = '✦ Pro';
    document.querySelector('.subscribe-cta').textContent = 'Manage';
    btn.classList.add('subscribed');
  } else {
    const days = sub?.daysLeft ?? 7;
    const bonus = sub?.bonusDays || 0;
    _trialExpired = days === 0;
    const dayText = _trialExpired ? 'Expired' : `${days}D Left`;
    document.getElementById('trial-text').textContent = bonus > 0 && !_trialExpired ? `${dayText} (+${bonus})` : dayText;
  }
})();

document.getElementById('subscribe-btn').addEventListener('click', async () => {
  const sub = await merlin.getSubscription();
  if (sub?.subscribed) {
    merlin.openManage();
    return;
  }
  showModal({
    title: 'Unlock Merlin Pro',
    body: 'Enter a license key to activate, or subscribe for full access.',
    inputPlaceholder: 'License key (e.g. XXXX-XXXX)',
    confirmLabel: 'Activate',
    cancelLabel: 'Subscribe',
    onConfirm: (key) => {
      if (key && key.length > 0) {
        merlin.activateKey(key).then((result) => {
          if (result.success) {
            document.getElementById('trial-text').textContent = '✦ Pro';
            document.querySelector('.subscribe-cta').textContent = 'Manage';
            document.getElementById('subscribe-btn').classList.add('subscribed');
            _trialExpired = false;
          } else {
            showModal({ title: 'Invalid Key', body: result.error || 'That key didn\'t work. Check for typos and try again.', confirmLabel: 'OK', onConfirm: () => {} });
          }
        });
      } else {
        merlin.openSubscribe();
      }
    },
    onCancel: () => { merlin.openSubscribe(); },
  });
});

// Auto-activate when Stripe payment completes (polled from main.js)
merlin.onSubscriptionActivated(() => {
  document.getElementById('subscribe-btn').classList.add('hidden-sub');
  _trialExpired = false;
  const bubble = addClaudeBubble();
  textBuffer = '✦ Payment received — welcome to Merlin Pro! All features are unlocked.';
  finalizeBubble();
});

// ── Window Controls ─────────────────────────────────────────
document.getElementById('btn-min').addEventListener('click', () => merlin.winMinimize());
document.getElementById('btn-max').addEventListener('click', () => merlin.winMaximize());
document.getElementById('btn-close').addEventListener('click', () => merlin.winClose());

// ── Setup Flow ──────────────────────────────────────────────
async function init() {
  // Show version in titlebar
  const vLabel = document.getElementById('version-label');
  if (vLabel && merlin.getVersion) {
    try { vLabel.textContent = 'v' + await merlin.getVersion(); } catch {}
  }

  // Show chat immediately with a welcome message — no blank screen
  setup.classList.add('hidden');

  const welcomeBubble = addClaudeBubble();
  // Instant animated welcome — shows before SDK even connects
  welcomeBubble.classList.remove('streaming');

  // Personalize welcome based on whether the user has brands set up
  const existingBrands = await merlin.getBrands().catch(() => []);
  const savedState = await merlin.loadState().catch(() => ({}));
  const isReturning = existingBrands && existingBrands.length > 0;
  const activeBrand = savedState?.activeBrand || (isReturning ? existingBrands[0].name : null);
  const activeBrandObj = existingBrands?.find(b => b.name === activeBrand) || existingBrands?.[0];
  const brandName = activeBrandObj?.displayName || activeBrand || (isReturning ? existingBrands[0].name : null);
  const productCount = isReturning ? existingBrands.reduce((sum, b) => sum + (b.productCount || 0), 0) : 0;

  if (isReturning) {
    // Check for morning briefing FIRST (cached, instant)
    const briefing = await merlin.getBriefing().catch(() => null);
    if (briefing) {
      welcomeBubble.classList.remove('streaming');
      let briefingHtml = `<div class="briefing-card"><div class="briefing-header">✦ While you were away</div>`;
      if (briefing.ads) briefingHtml += `<div class="briefing-section"><div class="briefing-label">Ad Performance</div><div class="briefing-content">${escapeHtml(briefing.ads)}</div></div>`;
      if (briefing.content) briefingHtml += `<div class="briefing-section"><div class="briefing-label">Content Published</div><div class="briefing-content">${escapeHtml(briefing.content)}</div></div>`;
      if (briefing.revenue) briefingHtml += `<div class="briefing-section"><div class="briefing-label">Revenue</div><div class="briefing-content">${escapeHtml(briefing.revenue)}</div></div>`;
      if (briefing.recommendation) briefingHtml += `<div class="briefing-section"><div class="briefing-label">💡 Recommendation</div><div class="briefing-content">${escapeHtml(briefing.recommendation)}</div></div>`;
      briefingHtml += `<button class="briefing-dismiss" onclick="this.closest('.msg').remove();merlin.dismissBriefing()">Got it</button></div>`;
      welcomeBubble.innerHTML = briefingHtml;
      currentBubble = null;
      textBuffer = '';
      // Add a second bubble for the normal welcome
      const wb2 = addClaudeBubble();
      wb2.classList.remove('streaming');
      wb2.innerHTML = `Welcome back — loading ${escapeHtml(brandName)}...`;
      currentBubble = null;
      textBuffer = '';
    } else {
      welcomeBubble.innerHTML = `Welcome back — loading ${escapeHtml(brandName)}...`;
    }
    // No interval needed — SDK takes over quickly for returning users
    window._welcomeInterval = null;
  } else {
    // New user — calm slide reveal, no flickering status lines
    const demoSlides = [
      { icon: '🎨', text: '<strong>Ad creatives</strong> from your product photos', stat: '~$0.04 each' },
      { icon: '📣', text: '<strong>Meta, TikTok, Google, Amazon</strong> ads — launched and optimized', stat: 'all platforms' },
      { icon: '🔍', text: '<strong>SEO audits</strong> and blog posts that rank on Google', stat: 'auto-published' },
      { icon: '⚡', text: '<strong>Daily autopilot</strong> — new content every morning, losers killed, winners scaled', stat: 'runs while you sleep' },
      { icon: '📊', text: '<strong>One dashboard</strong> for spend, ROAS, and what\'s actually working', stat: 'all channels' },
    ];

    // Build the bubble once — slides reveal in place, nothing flickers
    let slidesHtml = '<div class="demo-slides">';
    demoSlides.forEach((s, i) => {
      slidesHtml += `<div class="demo-slide" id="demo-${i}"><span class="demo-icon">${s.icon}</span>${s.text}<span class="demo-stat">${s.stat}</span></div>`;
    });
    slidesHtml += '</div><div class="status-line" id="welcome-status">Setting up your workspace...</div>';
    welcomeBubble.innerHTML = 'Hey — I\'m Merlin, your AI marketing wizard.<br>Drop your website below and I\'ll work some magic.' + slidesHtml;

    // Gentle reveal: status fades in, then one slide every 3s
    setTimeout(() => {
      const statusEl = document.getElementById('welcome-status');
      if (statusEl) statusEl.classList.add('visible');
    }, 500);

    let slideIndex = 0;
    window._welcomeInterval = setInterval(() => {
      const el = document.getElementById(`demo-${slideIndex}`);
      if (el) {
        el.classList.add('visible');
        scrollToBottom();
        slideIndex++;
      }
      if (slideIndex >= demoSlides.length) {
        clearInterval(window._welcomeInterval);
        window._welcomeInterval = null;
      }
    }, 3000);

    // First slide a bit sooner
    setTimeout(() => {
      const el = document.getElementById('demo-0');
      if (el && !el.classList.contains('visible')) {
        el.classList.add('visible');
        scrollToBottom();
        slideIndex = 1;
      }
    }, 2000);
  }

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
  try {
    const result = await merlin.checkSetup();
    if (result.ready) {
      setup.style.animation = 'fadeOut .3s ease forwards';
      setTimeout(async () => {
        setup.classList.add('hidden');
        setup.style.animation = '';
        sessionActive = true;
        await merlin.startSession();
      }, 300);
    } else {
      document.getElementById('setup-status').textContent = result.reason || 'Claude not found.';
    }
  } catch (err) {
    document.getElementById('setup-status').textContent = 'Check failed — make sure you\'re connected to the internet.';
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
      if (currentBubble && textBuffer.length - lastRenderedLength > 20) {
        currentBubble.innerHTML = renderMarkdown(textBuffer);
        lastRenderedLength = textBuffer.length;
      }
      scrollToBottom();
      rafPending = false;
    });
  }
}

let sessionActive = false;

function setInputDisabled(disabled) {
  const bar = document.getElementById('input-bar');
  if (disabled) {
    bar.classList.add('input-disabled');
    input.setAttribute('readonly', '');
    sendBtn.disabled = true;
  } else {
    bar.classList.remove('input-disabled');
    input.removeAttribute('readonly');
    sendBtn.disabled = false;
  }
}

let typingTimeout = null;
let typingStuckTimeout = null;

function finalizeBubble() {
  if (currentBubble) {
    currentBubble.classList.remove('streaming');
    currentBubble.innerHTML = renderMarkdown(textBuffer);
  }
  currentBubble = null;
  textBuffer = '';
  isStreaming = false;
  setInputDisabled(false);
  scrollToBottom();
  // Sparkle hint — show after the user has sent a few messages (past initial setup)
  // This avoids overwhelming new users during their first interaction
  if (!hasShownSparkleHint) {
    _userMessageCount = (_userMessageCount || 0);
    if (_userMessageCount >= 3) {
      hasShownSparkleHint = true;
      setTimeout(() => {
        const sparkle = document.getElementById('magic-btn');
        sparkle.classList.add('sparkle-hint');
        const hint = addClaudeBubble();
        textBuffer = '✦ **Tip:** Your connections, spells, and brand settings live behind the ✦ button up top.';
        finalizeBubble();
        setTimeout(() => sparkle.classList.remove('sparkle-hint'), 8000);
      }, 1500);
    }
  }

  // Refresh connections if panel is open (picks up newly connected platforms)
  const panel = document.getElementById('magic-panel');
  if (panel && !panel.classList.contains('hidden')) {
    loadConnections();
  }
  // If session is still active, show typing indicator after a pause
  // Long delay prevents flickering during rapid stream events
  scheduleTypingIndicator();
}

function scheduleTypingIndicator() {
  // Don't flicker — if typing indicator is already showing, leave it.
  // Only schedule if it's not already visible and session is active.
  if (typingTimeout) clearTimeout(typingTimeout);
  typingTimeout = null;
  if (!sessionActive) return;
  if (document.querySelector('.typing-indicator')) return; // already showing
  typingTimeout = setTimeout(() => {
    if (sessionActive && !currentBubble && !isStreaming) {
      showTypingIndicator();
    }
  }, 2000); // 2s delay — calm, no rush
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

  // HTML artifacts (```html blocks rendered as iframes)
  const artifacts = [];
  html = html.replace(/```html\n([\s\S]*?)```/g, (_, code) => {
    const id = `artifact-${Date.now()}-${artifacts.length}`;
    artifacts.push({ id, code });
    return `%%ARTIFACT_${artifacts.length - 1}%%`;
  });

  // Code blocks (triple backtick) — with copy button + language label
  const codeBlocks = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const langLabel = lang || 'text';
    const blockId = `cb-${Date.now()}-${codeBlocks.length}`;
    codeBlocks.push(
      `<div class="code-block"><div class="code-block-header"><span>${langLabel}</span><button class="copy-btn" onclick="navigator.clipboard.writeText(decodeURIComponent('${encodeURIComponent(code.replace(/\n$/, ''))}')).then(()=>{this.textContent='Copied!';this.classList.add('copied');setTimeout(()=>{this.textContent='Copy';this.classList.remove('copied')},2000)})">Copy</button></div><pre><code class="lang-${langLabel}">${code}</code></pre></div>`
    );
    return `%%CODEBLOCK_${codeBlocks.length - 1}%%`;
  });

  // Inline code — add copy button for long or actionable content (URLs, commands, keys)
  html = html.replace(/`([^`]+)`/g, (match, content) => {
    const isActionable = content.length > 20 || /^(https?:|\/|npm |curl |pip |brew |apt |git |cd |mkdir |xattr )/.test(content);
    if (isActionable) {
      const encoded = encodeURIComponent(content);
      return `<code>${content}</code><button class="copy-btn inline-copy" onclick="navigator.clipboard.writeText(decodeURIComponent('${encoded}')).then(()=>{this.textContent='✓';setTimeout(()=>{this.textContent='⧉'},1500)})">⧉</button>`;
    }
    return `<code>${content}</code>`;
  });
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
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    return match;
  });

  // Normalize Windows backslash paths to forward slashes before matching
  html = html.replace(/([a-zA-Z0-9_\-\.]+)\\([a-zA-Z0-9_\-\.\\]+\.(?:jpg|jpeg|png|gif|webp|mp4|webm|mov))/gi, (m, a, b) => `${a}/${b.replace(/\\/g, '/')}`);

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

  // Tables (markdown pipe tables)
  html = html.replace(/((?:^\|.+\|$\n?){2,})/gm, (table) => {
    const rows = table.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return table;
    // Check if row 2 is a separator (|---|---|)
    const isSep = /^\|[\s\-:]+\|/.test(rows[1]);
    let thead = '', tbody = '';
    const parseRow = (row) => row.split('|').slice(1, -1).map(c => c.trim());
    if (isSep && rows.length >= 2) {
      const headers = parseRow(rows[0]);
      thead = '<thead><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead>';
      const bodyRows = rows.slice(2);
      tbody = '<tbody>' + bodyRows.map(r => '<tr>' + parseRow(r).map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody>';
    } else {
      tbody = '<tbody>' + rows.map(r => '<tr>' + parseRow(r).map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody>';
    }
    return `<table>${thead}${tbody}</table>`;
  });

  // Line breaks
  html = html.replace(/\n/g, '<br>');
  // Clean up
  html = html.replace(/<\/li><br>/g, '</li>');
  html = html.replace(/<\/ul><br>/g, '</ul>');
  html = html.replace(/<\/pre><br>/g, '</pre>');
  html = html.replace(/<\/h[123]><br>/g, (m) => m.replace('<br>', ''));
  html = html.replace(/<hr><br>/g, '<hr>');
  html = html.replace(/<\/table><br>/g, '</table>');
  html = html.replace(/<\/tr><br>/g, '</tr>');
  html = html.replace(/<\/td><br>/g, '</td>');
  html = html.replace(/<\/th><br>/g, '</th>');

  // Restore code blocks
  codeBlocks.forEach((block, i) => {
    html = html.replace(`%%CODEBLOCK_${i}%%`, block);
  });

  // Restore HTML artifacts as sandboxed iframes
  artifacts.forEach((art, i) => {
    const encoded = encodeURIComponent(art.code);
    html = html.replace(`%%ARTIFACT_${i}%%`,
      `<div class="artifact"><div class="code-block-header"><span>preview</span><button class="copy-btn" onclick="navigator.clipboard.writeText(decodeURIComponent('${encoded}')).then(()=>{this.textContent='Copied!';this.classList.add('copied');setTimeout(()=>{this.textContent='Copy HTML';this.classList.remove('copied')},2000)})">Copy HTML</button></div><iframe sandbox="allow-scripts" srcdoc="${art.code.replace(/"/g, '&quot;').replace(/'/g, '&#39;')}" style="width:100%;min-height:200px;border:1px solid var(--border);border-radius:0 0 8px 8px;background:#fff"></iframe></div>`
    );
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
let hasShownSparkleHint = false;
let _userMessageCount = 0;

merlin.onSdkMessage((msg) => {
  // When first real SDK content arrives, clean up welcome state
  if (firstMessage && msg.type === 'stream_event') {
    if (window._welcomeInterval) clearInterval(window._welcomeInterval);
    firstMessage = false;
    _restartAttempts = 0; // session connected successfully — reset circuit breaker
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
      setInputDisabled(false);
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
      // Remove tool status when text starts
      const toolStatus = document.querySelector('.tool-status');
      if (toolStatus) toolStatus.remove();
      if (!currentBubble) {
        addClaudeBubble();
        isStreaming = true;
        setInputDisabled(true);
      }
    }
    // Show tool activity status (like Claude Code)
    if (event.content_block && event.content_block.type === 'tool_use') {
      const toolName = event.content_block.name || '';
      const friendlyNames = {
        'Bash': 'Running command', 'Read': 'Reading file', 'Write': 'Writing file',
        'Edit': 'Editing file', 'Glob': 'Searching files', 'Grep': 'Searching code',
        'WebSearch': 'Searching the web', 'WebFetch': 'Fetching page',
        'Agent': 'Working on it', 'TodoWrite': 'Planning',
        'AskUserQuestion': 'Asking you',
      };
      const label = friendlyNames[toolName] || 'Thinking';
      removeTypingIndicator();
      const existing = document.querySelector('.tool-status');
      if (existing) existing.remove();
      const status = document.createElement('div');
      status.className = 'msg msg-claude';
      status.innerHTML = `<div class="msg-avatar">✦</div><div class="msg-bubble tool-status">${label}</div>`;
      messages.appendChild(status);
      scrollToBottom();
    }
  }

  if (event.type === 'content_block_delta') {
    if (event.delta && event.delta.type === 'text_delta' && event.delta.text) {
      appendText(event.delta.text);
    }
  }

  if (event.type === 'message_stop') {
    const toolStatus = document.querySelector('.tool-status');
    if (toolStatus) toolStatus.closest('.msg')?.remove();
    finalizeBubble();
  }
}

// ── Approval Cards ──────────────────────────────────────────
let _approvalCountdown = null; // track active countdown to prevent stacking

merlin.onApprovalRequest(({ toolUseID, label, cost }) => {
  // Clear any previous countdown from a prior approval
  if (_approvalCountdown) { clearInterval(_approvalCountdown); _approvalCountdown = null; }

  document.getElementById('approval-label').textContent = label;
  const costEl = document.getElementById('approval-cost');
  costEl.textContent = cost ? `Cost: ${cost}` : '';
  costEl.style.color = '';

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

  // 5-minute countdown
  let secondsLeft = 300;
  _approvalCountdown = setInterval(() => {
    secondsLeft--;
    if (secondsLeft <= 60) {
      costEl.textContent = `Expires in ${secondsLeft}s`;
      costEl.style.color = '#ef4444';
    }
    if (secondsLeft <= 0) {
      clearInterval(_approvalCountdown);
      _approvalCountdown = null;
      approval.classList.add('hidden');
      costEl.style.color = '';
    }
  }, 1000);

  const clearApproval = () => {
    if (_approvalCountdown) { clearInterval(_approvalCountdown); _approvalCountdown = null; }
    approval.classList.add('hidden');
    costEl.style.color = '';
  };

  // Replace handlers cleanly (onclick= replaces previous, no stacking)
  approveBtn.onclick = () => { merlin.approveTool(toolUseID); clearApproval(); };
  denyBtn.onclick = () => { merlin.denyTool(toolUseID); clearApproval(); };

  // Enter = approve, Escape = deny
  const keyHandler = (e) => {
    if (approval.classList.contains('hidden')) return;
    if (e.key === 'Enter') { e.preventDefault(); approveBtn.click(); }
    if (e.key === 'Escape') { e.preventDefault(); denyBtn.click(); }
  };
  document.removeEventListener('keydown', window._approvalKeyHandler);
  window._approvalKeyHandler = keyHandler;
  document.addEventListener('keydown', keyHandler);
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
let _restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 3;

merlin.onSdkError((err) => {
  removeTypingIndicator();
  sessionActive = false;
  _errorCount++;
  checkFrustration('');
  isStreaming = false;
  setInputDisabled(false);

  _restartAttempts++;

  const errLower = (err || '').toLowerCase();
  let userMsg = 'Something went wrong. ';
  let isAuthError = false;
  if (errLower.includes('enotfound') || errLower.includes('econnrefused') || errLower.includes('etimedout') || errLower.includes('network')) {
    userMsg = 'Lost connection — check your internet. ';
  } else if (errLower.includes('401') || errLower.includes('unauthorized') || errLower.includes('auth')) {
    userMsg = 'Session expired. ';
    isAuthError = true;
  }

  const bubble = addClaudeBubble();

  if (_restartAttempts > MAX_RESTART_ATTEMPTS) {
    // Stop retrying — show manual recovery
    const reason = isAuthError
      ? 'Please open Claude Desktop and make sure you\'re logged in, then click Retry.'
      : 'Check your internet connection and click Retry when ready.';
    textBuffer = `${userMsg}Merlin tried ${MAX_RESTART_ATTEMPTS} times but couldn't connect.\n\n${reason}`;
    finalizeBubble();
    bubble.style.borderColor = 'rgba(239,68,68,.3)';

    // Add a retry button inline
    const retryBtn = document.createElement('button');
    retryBtn.textContent = 'Retry Connection';
    retryBtn.className = 'btn-action btn-approve-style';
    retryBtn.style.cssText = 'margin-top:12px;width:auto;padding:8px 20px;font-size:13px';
    retryBtn.onclick = () => {
      _restartAttempts = 0;
      retryBtn.remove();
      sessionActive = true;
      merlin.startSession();
    };
    bubble.appendChild(retryBtn);
    return;
  }

  // Exponential backoff: 2s, 4s, 8s
  const delay = Math.min(2000 * Math.pow(2, _restartAttempts - 1), 8000);
  textBuffer = `${userMsg}Retrying in ${delay / 1000}s... (attempt ${_restartAttempts}/${MAX_RESTART_ATTEMPTS})`;
  finalizeBubble();
  bubble.style.borderColor = 'rgba(239,68,68,.3)';

  setTimeout(() => {
    sessionActive = true;
    merlin.startSession();
  }, delay);
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
  ecom:    ['meta','tiktok','shopify','klaviyo','google','pinterest','amazon','fal','elevenlabs','heygen'],
  game:    ['meta','tiktok','google','fal','heygen','elevenlabs'],
  saas:    ['meta','google','klaviyo','fal','elevenlabs'],
  local:   ['meta','google','fal'],
  agency:  ['meta','tiktok','shopify','klaviyo','google','pinterest','amazon','fal','elevenlabs','heygen'],
};

async function loadBrands() {
  try {
    const brands = await merlin.getBrands();
    const select = document.getElementById('brand-select');
    const state = await merlin.loadState();
    select.innerHTML = '';
    if (!brands || brands.length === 0) {
      select.innerHTML = '<option value="">No brand loaded</option>';
      return;
    }
    const savedBrand = state?.activeBrand || '';
    let selectedBrand = brands[0];
    brands.forEach((b) => {
      const opt = document.createElement('option');
      opt.value = b.name;
      opt.textContent = b.displayName || b.name;
      if (b.name === savedBrand) { opt.selected = true; selectedBrand = b; }
      select.appendChild(opt);
    });
    if (!savedBrand && brands[0]) select.querySelector('option').selected = true;
    if (selectedBrand?.vertical) updateVertical(selectedBrand.vertical);
  } catch (err) { console.warn('[brands]', err); }
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
  // Persist active brand selection
  merlin.saveState({ activeBrand: e.target.value });
  merlin.getBrands().then((brands) => {
    const brand = brands.find(b => b.name === e.target.value);
    if (brand?.vertical) updateVertical(brand.vertical);
    else updateVertical('');
  }).catch((err) => { console.warn('[brands]', err); });
});

document.getElementById('add-brand-btn').addEventListener('click', () => {
  sendChatFromPanel('Set up a new brand for me');
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
  }).catch((err) => { console.warn('[connections]', err); });
}

document.getElementById('magic-btn').addEventListener('click', () => {
  const panel = document.getElementById('magic-panel');
  panel.classList.toggle('hidden');
  // Load brands first (sets vertical filter), then connections (hides connected from available)
  if (!panel.classList.contains('hidden')) {
    loadBrands().then(() => loadConnections());
    loadSpells();
    loadReferralInfo();
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
    }).catch((err) => { console.warn('[credits]', err); });
  }
});
document.getElementById('magic-close').addEventListener('click', () => {
  document.getElementById('magic-panel').classList.add('hidden');
});

// Close panel when clicking outside it (but not when interacting with approval cards or modals)
document.addEventListener('click', (e) => {
  const panel = document.getElementById('magic-panel');
  const btn = document.getElementById('magic-btn');
  if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== btn) {
    // Don't close if clicking approval card, modal, or tooltip
    if (e.target.closest('#approval') || e.target.closest('.merlin-modal-card') || e.target.closest('.merlin-tooltip')) return;
    panel.classList.add('hidden');
  }
});

// Connect platform tiles — use event delegation for original AND cloned tiles
document.addEventListener('click', (e) => {
  const tile = e.target.closest('.magic-tile');
  if (!tile) return;
  const platform = tile.dataset.platform;
  const names = {
    meta: 'Connect my Meta Ads account',
    tiktok: 'Connect my TikTok Ads account',
    shopify: 'Connect my Shopify store',
    klaviyo: 'Connect my Klaviyo account',
    google: 'Connect my Google Ads account',
    amazon: 'Connect my Amazon account for ads and product management',
    pinterest: 'Connect my Pinterest Ads account',
    fal: 'Set up fal.ai for image generation',
    elevenlabs: 'Set up ElevenLabs for voice',
    heygen: 'Set up HeyGen for video avatars',
    attentive: 'Connect Attentive for SMS marketing',
    discord: 'Connect Discord for community management',
    slack: 'Connect Slack for notifications',
  };
  if (names[platform]) {
    sendChatFromPanel(names[platform]);
  }
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

// ── Share Merlin (Referrals) ────────────────────────────────
async function loadReferralInfo() {
  try {
    const info = await merlin.getReferralInfo();
    const linkInput = document.getElementById('referral-link');
    const stats = document.getElementById('referral-stats');
    linkInput.value = `merlingotme.com?ref=${info.referralCode || ''}`;
    if (info.referralCount > 0) {
      stats.textContent = `${info.referralCount} friend${info.referralCount > 1 ? 's' : ''} referred · +${info.trialExtensionDays || 0} bonus days`;
    } else {
      stats.textContent = '';
    }
  } catch {}
}

document.getElementById('referral-copy').addEventListener('click', () => {
  const linkInput = document.getElementById('referral-link');
  navigator.clipboard.writeText('https://' + linkInput.value).then(() => {
    const btn = document.getElementById('referral-copy');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
});

// ── Spellbook ──────────────────────────────────────────────
function formatCron(cron) {
  if (!cron) return '';
  const parts = cron.split(' ');
  if (parts.length < 5) return cron;
  const [min, hour, , , dow] = parts;
  const h = parseInt(hour);
  if (isNaN(h) || h < 0 || h > 23) return cron; // invalid hour — show raw
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const timeStr = `${h12}${min !== '0' ? ':' + min.padStart(2, '0') : ''} ${ampm}`;
  const dayMap = { '*': '', '1-5': 'Weekdays', '0,6': 'Weekends', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat', '0': 'Sun' };
  const dayStr = dayMap[dow] || '';
  return dayStr ? `${dayStr} ${timeStr}` : timeStr;
}

function formatTimeAgo(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function sendChatFromPanel(msg) {
  document.getElementById('magic-panel').classList.add('hidden');
  addUserBubble(msg);
  showTypingIndicator();
  turnStartTime = Date.now();
  turnTokens = 0;
  sessionActive = true;
  startTickingTimer();
  merlin.sendMessage(msg);
}

async function loadSpells() {
  let spells;
  try { spells = await merlin.listSpells(); } catch { spells = []; }
  const list = document.getElementById('spellbook-list');
  const empty = document.getElementById('spellbook-empty');
  const warning = document.getElementById('spellbook-warning');

  // Check if Claude Desktop is running (spells won't fire if it's closed)
  if (spells && spells.length > 0) {
    try {
      const running = await merlin.checkClaudeRunning();
      warning.style.display = running ? 'none' : 'block';
    } catch { warning.style.display = 'none'; }
  } else {
    warning.style.display = 'none';
  }
  list.innerHTML = '';

  const templates = document.getElementById('spell-templates');
  if (!spells || spells.length === 0) {
    empty.style.display = 'none';
    // Show templates by default when no spells exist
    if (templates) templates.style.display = '';
    return;
  }
  empty.style.display = 'none';

  spells.forEach(spell => {
    const row = document.createElement('div');
    row.className = 'spell-row';
    row.dataset.id = spell.id;

    const dot = document.createElement('span');
    dot.className = `spell-dot ${spell.enabled ? 'dot-active' : 'dot-pending'}`;

    const info = document.createElement('div');
    info.className = 'spell-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'spell-name';
    nameRow.textContent = spell.description || spell.name;

    const meta = document.createElement('div');
    meta.className = 'spell-meta';
    const parts = [];
    if (spell.cron) parts.push(formatCron(spell.cron));
    if (spell.lastRun) {
      const ago = formatTimeAgo(spell.lastRun);
      parts.push(`Last: ${ago}`);
    }
    meta.textContent = parts.join(' · ');

    info.appendChild(nameRow);
    info.appendChild(meta);

    const toggle = document.createElement('button');
    toggle.className = `spell-toggle ${spell.enabled ? 'spell-on' : ''}`;
    toggle.textContent = spell.enabled ? 'On' : 'Off';
    toggle.onclick = (e) => {
      e.stopPropagation();
      merlin.toggleSpell(spell.id, !spell.enabled);
      setTimeout(loadSpells, 500);
    };

    row.appendChild(dot);
    row.appendChild(info);
    row.appendChild(toggle);

    row.addEventListener('click', () => {
      sendChatFromPanel(`Tell me about the "${spell.name}" spell and let me configure it.`);
    });

    list.appendChild(row);
  });

  // Update templates — dim ones that are already active
  document.querySelectorAll('.spell-template').forEach(tmpl => {
    const spellId = 'merlin-' + tmpl.dataset.spell;
    const isActive = spells.some(s => s.id === spellId);
    tmpl.classList.toggle('spell-template-active', isActive);
    tmpl.disabled = isActive;
  });
}

// Spell templates — toggle visibility on "Cast a new spell" click
document.getElementById('add-task-btn').addEventListener('click', () => {
  const templates = document.getElementById('spell-templates');
  if (templates.style.display === 'none') {
    templates.style.display = 'flex';
    document.getElementById('add-task-btn').textContent = '− Cancel';
  } else {
    templates.style.display = 'none';
    document.getElementById('add-task-btn').textContent = '+ Cast a new spell';
  }
});

// Template click — one-click spell activation
document.querySelectorAll('.spell-template').forEach(btn => {
  btn.addEventListener('click', () => {
    const spell = btn.dataset.spell;
    const cron = btn.dataset.cron;
    const desc = btn.dataset.desc;
    document.getElementById('spell-templates').style.display = 'none';
    document.getElementById('add-task-btn').textContent = '+ Cast a new spell';
    sendChatFromPanel(`Set up a "${desc}" spell for me. Use task ID "merlin-${spell}" with schedule "${cron}". Create it now — don't ask me questions, just set it up and confirm.`);
  });
});

// Real-time spell updates
merlin.onSpellActivity(() => {
  const panel = document.getElementById('magic-panel');
  if (panel && !panel.classList.contains('hidden')) setTimeout(loadSpells, 1000);
});
merlin.onSpellCompleted(({ taskId, timestamp }) => {
  if (taskId && typeof taskId === 'string') {
    merlin.updateSpellMeta(taskId, { lastRun: timestamp });
  }
  const panel = document.getElementById('magic-panel');
  if (panel && !panel.classList.contains('hidden')) loadSpells();
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
  // Auto-hide after 2 minutes to prevent stuck indicator
  if (typingStuckTimeout) clearTimeout(typingStuckTimeout);
  typingStuckTimeout = setTimeout(() => {
    removeTypingIndicator();
    typingStuckTimeout = null;
  }, 120000);
}

function removeTypingIndicator() {
  if (typingStuckTimeout) { clearTimeout(typingStuckTimeout); typingStuckTimeout = null; }
  const existing = document.querySelector('.typing-indicator');
  if (existing) {
    existing.style.transition = 'opacity .2s';
    existing.style.opacity = '0';
    setTimeout(() => existing.remove(), 200);
  }
}

function sendMessage() {
  const text = input.value.trim();
  if (!text || isStreaming) return;

  // Trial expiry gate — soft block, allow key activation
  if (_trialExpired) {
    showModal({
      title: 'Free Trial Ended',
      body: 'Your 7-day trial is up. Enter a license key or subscribe to keep using Merlin.',
      inputPlaceholder: 'License key (e.g. XXXX-XXXX)',
      confirmLabel: 'Activate',
      cancelLabel: 'Subscribe',
      onConfirm: (key) => {
        if (key && key.length > 0) {
          merlin.activateKey(key).then((result) => {
            if (result.success) {
              document.getElementById('subscribe-btn').classList.add('hidden-sub');
              _trialExpired = false;
              const bubble = addClaudeBubble();
              textBuffer = '✦ Welcome to Merlin Pro! All features are unlocked.';
              finalizeBubble();
              sendMessage();
            } else {
              showModal({ title: 'Invalid Key', body: result.error || 'That key didn\'t work. Check for typos and try again.', confirmLabel: 'OK', onConfirm: () => {} });
            }
          });
        } else {
          merlin.openSubscribe();
        }
      },
      onCancel: () => { merlin.openSubscribe(); },
    });
    return;
  }

  checkFrustration(text);
  _userMessageCount = (_userMessageCount || 0) + 1;
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

// ── Voice Input (stubbed) ────────────────────────────────────
// TODO: Integrate local speech-to-text via Go binary (Whisper.cpp or Vosk).
// Flow: mic click → Web Audio API records → save temp WAV → binary transcribes → text in input
// Web Speech API doesn't work in Electron (requires Google's servers).
// Mic button hidden via CSS (.mic-btn{display:none}) until this is built.

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

// ── Help Nudge (frustration detection) ──────────────────────
let _nudgeShown = false;
let _errorCount = 0;
let _rapidMessageCount = 0;
let _lastMessageTime = 0;

function checkFrustration(text) {
  if (_nudgeShown) return;

  const t = (text || '').toLowerCase();
  const now = Date.now();

  // Detect rapid repeated messages (3+ messages within 15 seconds)
  if (now - _lastMessageTime < 15000) {
    _rapidMessageCount++;
  } else {
    _rapidMessageCount = 0;
  }
  _lastMessageTime = now;

  // Frustration signals
  const frustrated =
    _rapidMessageCount >= 3 ||
    _errorCount >= 2 ||
    /\b(help|stuck|broken|not working|doesn'?t work|error|why won'?t|can'?t|wtf|wrong)\b/i.test(t);

  if (frustrated) showHelpNudge();
}

function showHelpNudge() {
  if (_nudgeShown) return;
  _nudgeShown = true;
  const nudge = document.getElementById('help-nudge');
  nudge.classList.remove('hidden');
  // Auto-hide after 15 seconds
  setTimeout(() => nudge.classList.add('hidden'), 15000);
}

document.getElementById('help-nudge-close').addEventListener('click', () => {
  document.getElementById('help-nudge').classList.add('hidden');
});

// ── Image Lightbox (click to zoom, click/Esc to close) ──────
document.addEventListener('click', (e) => {
  const img = e.target.closest('.msg-bubble img');
  if (!img) return;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  const lbImg = document.createElement('img');
  lbImg.src = img.src;
  lb.appendChild(lbImg);
  document.body.appendChild(lb);
  lb.addEventListener('click', () => lb.remove());
  const escHandler = (ev) => { if (ev.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', escHandler); } };
  document.addEventListener('keydown', escHandler);
});

// ── Tooltips (fixed position, never clipped by overflow) ────
(function() {
  let tip = null;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    if (tip) tip.remove();
    tip = document.createElement('div');
    tip.className = 'merlin-tooltip';
    tip.textContent = el.getAttribute('data-tip');
    document.body.appendChild(tip);

    const rect = el.getBoundingClientRect();
    const pos = el.getAttribute('data-tip-pos');
    const tipW = tip.offsetWidth;
    let left = rect.left + rect.width / 2 - tipW / 2;
    // Clamp to viewport
    if (left < 4) left = 4;
    if (left + tipW > window.innerWidth - 4) left = window.innerWidth - tipW - 4;

    const tipH = tip.offsetHeight;
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    // Auto-flip: prefer requested position, but flip if not enough room
    const showBelow = pos === 'bottom' || (spaceAbove < tipH + 10 && spaceBelow > tipH + 10);
    if (showBelow) {
      tip.style.top = (rect.bottom + 6) + 'px';
    } else {
      tip.style.top = (rect.top - tipH - 6) + 'px';
    }
    tip.style.left = left + 'px';
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-tip]') && tip) { tip.remove(); tip = null; }
  });
})();

// ── Init ────────────────────────────────────────────────────
init();
