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

function getSetupStatusText(result, fallback = 'Checking Claude...') {
  if (result?.reason) return result.reason;
  if (result?.ready) return 'Claude is ready. Starting Merlin...';
  return fallback;
}

function resetSetupButton() {
  const btn = document.getElementById('setup-auto-btn');
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = 'Open Claude Desktop';
}

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
// Pass `body` for plain text (escaped) or `bodyHTML` for trusted HTML.
// Never pass user input through bodyHTML — it bypasses escaping.
function showModal({ title, body, bodyHTML, inputPlaceholder, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  const modal = document.getElementById('merlin-modal');
  const titleEl = document.getElementById('merlin-modal-title');
  const bodyEl = document.getElementById('merlin-modal-body');
  const inputEl = document.getElementById('merlin-modal-input');
  const errorEl = document.getElementById('merlin-modal-error');
  const confirmBtn = document.getElementById('merlin-modal-confirm');
  const cancelBtn = document.getElementById('merlin-modal-cancel');
  const closeBtn = document.getElementById('merlin-modal-close');

  titleEl.textContent = title || '';
  if (bodyHTML !== undefined) {
    bodyEl.innerHTML = bodyHTML;
  } else {
    bodyEl.textContent = body || '';
  }
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
    try {
      const info = await merlin.getVersion();
      const ver = typeof info === 'object' ? info.version : info;
      vLabel.textContent = 'v' + ver;
      // News tooltip — pulled from version.json whatsNew array
      const bullets = (typeof info === 'object' && info.whatsNew && info.whatsNew.length)
        ? info.whatsNew.map(b => '• ' + b).join('\n')
        : '• Up to date';
      vLabel.dataset.tip = '✦ What\'s New\n' + bullets + '\n\nClick to check for updates';
    } catch {}

    // Click to manually check for updates (auto-check fires every 30 min,
    // but users want a way to force it after seeing a new release land).
    vLabel.style.cursor = 'pointer';
    vLabel.addEventListener('click', async () => {
      if (!merlin.checkForUpdates) return;
      const original = vLabel.textContent;
      vLabel.textContent = 'checking…';
      try {
        const result = await merlin.checkForUpdates();
        if (!result?.ok) {
          vLabel.textContent = 'check failed';
          setTimeout(() => { vLabel.textContent = original; }, 2000);
          return;
        }
        if (result.hasUpdate) {
          // The IPC handler already fired update-available; the toast will appear.
          vLabel.textContent = `v${result.latest} ready`;
        } else {
          vLabel.textContent = 'up to date';
          setTimeout(() => { vLabel.textContent = original; }, 2000);
        }
      } catch {
        vLabel.textContent = 'check failed';
        setTimeout(() => { vLabel.textContent = original; }, 2000);
      }
    });
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
  // Persist active brand so main.js initial prompt uses the same one
  if (activeBrand && (!savedState?.activeBrand || savedState.activeBrand !== activeBrand)) {
    merlin.saveState({ activeBrand });
  }
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
      briefingHtml += `</div>`;
      welcomeBubble.innerHTML = briefingHtml;
      merlin.dismissBriefing(); // Mark as seen so it doesn't repeat
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

    // Native progress bar handles onboarding status — no duplicate in chat
  } else {
    // New user — clean welcome, native progress bar handles status
    welcomeBubble.innerHTML = 'Hey — I\'m Merlin, your AI marketing wizard.<br>Drop your website below and I\'ll work some magic.';
  }

  // Auto-detect Claude — poll every 3 seconds until found
  async function detectClaude() {
    // Guard against double-start from poller + retry button racing
    if (sessionActive) return true;
    const result = await merlin.checkSetup();
    document.getElementById('setup-status').textContent = getSetupStatusText(result);
    if (result.ready) {
      // Found! Clear polling and start session
      if (window._claudePoller) { clearInterval(window._claudePoller); window._claudePoller = null; }
      setup.classList.add('hidden');
      turnStartTime = Date.now();
      sessionActive = true;
      merlin.startSession();
      setTimeout(updateProgressBar, 2000);
      return true;
    }
    return false;
  }

  // Check for API key fallback first — skip Claude check if key exists
  const apiKeyCheck = await merlin.hasApiKey().catch(() => ({ hasKey: false }));
  if (apiKeyCheck.hasKey) {
    setup.classList.add('hidden');
    turnStartTime = Date.now();
    sessionActive = true;
    merlin.startSession();
    return;
  }

  const found = await detectClaude();
  if (!found) {
    // Not found on first check — show setup screen and keep polling
    clearInterval(window._welcomeInterval);
    setup.classList.remove('hidden');
    document.getElementById('setup-status').textContent = 'Checking Claude...';
    welcomeBubble.parentElement.remove();

    // Poll every 3 seconds — auto-continue when Claude is detected
    if (window._claudePoller) clearInterval(window._claudePoller);
    window._claudePoller = setInterval(async () => {
      const detected = await detectClaude();
      if (detected) {
        setup.style.animation = 'fadeOut .3s ease forwards';
        setTimeout(() => { setup.classList.add('hidden'); setup.style.animation = ''; }, 300);
      }
    }, 3000);
  }

  // When SDK sends first real message, DON'T remove the welcome —
  // let the conversation continue naturally below it
  window._welcomeShown = true;
}


// Setup: Open Claude Desktop / download it if needed
document.getElementById('setup-auto-btn')?.addEventListener('click', async () => {
  const status = document.getElementById('setup-status');
  const btn = document.getElementById('setup-auto-btn');
  btn.disabled = true;
  btn.textContent = 'Opening...';
  status.textContent = 'Opening Claude Desktop...';

  const result = await merlin.installClaude();
  if (result.success) {
    status.textContent = 'Checking Claude...';
    setTimeout(async () => {
      const check = await merlin.checkSetup();
      if (check.ready) {
        setup.style.animation = 'fadeOut .3s ease forwards';
        setTimeout(() => { setup.classList.add('hidden'); merlin.startSession(); }, 300);
      } else {
        status.textContent = getSetupStatusText(check, 'Claude is not ready yet.');
        resetSetupButton();
      }
    }, 1000);
  } else {
    status.textContent = result.reason || 'Could not open Claude Desktop.';
    resetSetupButton();
  }
});

// Setup: Manual retry
document.getElementById('setup-manual-btn')?.addEventListener('click', async () => {
  document.getElementById('setup-status').textContent = 'Checking Claude...';
  const result = await merlin.checkSetup();
  if (result.ready) {
    setup.style.animation = 'fadeOut .3s ease forwards';
    setTimeout(() => { setup.classList.add('hidden'); merlin.startSession(); }, 300);
  } else {
    document.getElementById('setup-status').textContent = getSetupStatusText(result, 'Claude is not ready yet.');
  }
});

// Setup: API key fallback
document.getElementById('setup-apikey-btn')?.addEventListener('click', () => {
  document.getElementById('setup-main').style.display = 'none';
  document.getElementById('setup-apikey-form').style.display = 'block';
  document.getElementById('setup-status').textContent = 'API key mode (advanced)';
});

document.getElementById('setup-apikey-back')?.addEventListener('click', () => {
  document.getElementById('setup-main').style.display = 'block';
  document.getElementById('setup-apikey-form').style.display = 'none';
  document.getElementById('setup-status').textContent = '';
});

document.getElementById('setup-apikey-save')?.addEventListener('click', async () => {
  const key = document.getElementById('setup-apikey-input').value.trim();
  const err = document.getElementById('setup-apikey-error');
  err.textContent = '';
  if (!key || !key.startsWith('sk-ant-')) {
    err.textContent = 'Key must start with sk-ant-';
    return;
  }
  const result = await merlin.setApiKey(key);
  if (result.success) {
    setup.style.animation = 'fadeOut .3s ease forwards';
    setTimeout(() => { setup.classList.add('hidden'); merlin.startSession(); }, 300);
  } else {
    err.textContent = result.error || 'Invalid key.';
  }
});

// Legacy fallback
document.getElementById('setup-install-btn')?.addEventListener('click', () => {
  merlin.openClaudeDownload();
});

// ── Message Rendering ───────────────────────────────────────
function addUserBubble(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.textContent = text;
  messages.appendChild(div);
  scrollToBottom(true); // User sent a message — always scroll to show it
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
  input.focus();
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
  // Update progress bar (may have changed after this turn)
  updateProgressBar();
  // If session is still active, show typing indicator after a pause
  // Long delay prevents flickering during rapid stream events
  scheduleTypingIndicator();
}

function scheduleTypingIndicator() {
  if (typingTimeout) clearTimeout(typingTimeout);
  typingTimeout = null;
  if (!sessionActive) return;
  // If status is already showing something, don't override it
  if (document.getElementById('chat-status').innerHTML) return;
  typingTimeout = setTimeout(() => {
    if (sessionActive && !currentBubble && !isStreaming) {
      showTypingIndicator();
    }
  }, 2000);
}

// Only auto-scroll if user is near the bottom (respects scroll-up intent)
let _userScrolledUp = false;
const scrollBtn = document.getElementById('scroll-bottom-btn');

chat.addEventListener('scroll', () => {
  const distFromBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
  _userScrolledUp = distFromBottom > 80;
  // Show/hide scroll-to-bottom button
  if (_userScrolledUp) {
    scrollBtn.classList.remove('hidden');
  } else {
    scrollBtn.classList.add('hidden');
  }
});

scrollBtn.addEventListener('click', () => {
  scrollToBottom(true);
  scrollBtn.classList.add('hidden');
});

function scrollToBottom(force) {
  if (_userScrolledUp && !force) return;
  requestAnimationFrame(() => {
    const anchor = document.getElementById('scroll-anchor');
    if (anchor) {
      anchor.scrollIntoView({ block: 'end' });
    } else {
      chat.scrollTop = chat.scrollHeight;
    }
    _userScrolledUp = false;
  });
}

// ── Performance: limit DOM nodes for long conversations ─────
const MAX_VISIBLE_MESSAGES = 200;

function pruneOldMessages() {
  const allMsgs = messages.querySelectorAll('.msg, .turn-stats');
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
      `<div class="code-block"><div class="code-block-header"><span>${langLabel}</span><button class="copy-btn" data-copy="${encodeURIComponent(code.replace(/\n$/, ''))}">Copy</button></div><pre><code class="lang-${langLabel}">${code}</code></pre></div>`
    );
    return `%%CODEBLOCK_${codeBlocks.length - 1}%%`;
  });

  // Inline code — add copy button for long or actionable content (URLs, commands, keys)
  html = html.replace(/`([^`]+)`/g, (match, content) => {
    const isActionable = content.length > 20 || /^(https?:|\/|npm |curl |pip |brew |apt |git |cd |mkdir |xattr )/.test(content);
    if (isActionable) {
      return `<code>${content}</code><button class="copy-btn inline-copy" data-copy="${encodeURIComponent(content)}">⧉</button>`;
    }
    return `<code>${content}</code>`;
  });
  // Bold — markdown **text** and escaped <strong> tags from Claude
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/&lt;strong&gt;(.*?)&lt;\/strong&gt;/g, '<strong>$1</strong>');
  // Italic — markdown *text* and escaped <em> tags
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/&lt;em&gt;(.*?)&lt;\/em&gt;/g, '<em>$1</em>');
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
  // Markdown images: ![alt](path) — render inline
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
    // Local file path → use merlin:// protocol
    if (src.includes('/') && !src.startsWith('http')) {
      return `<img src="merlin://${src}" alt="${alt || 'Image'}" loading="lazy">`;
    }
    // Remote URL or data URI
    if (src.startsWith('http') || src.startsWith('data:')) {
      return `<img src="${src}" alt="${alt || 'Image'}" loading="lazy">`;
    }
    return match;
  });

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    // Local file links → render as merlin:// links
    if (url.includes('/') && /\.(jpg|jpeg|png|gif|webp|pdf|mp4)$/i.test(url)) {
      return `<a href="merlin://${url}" target="_blank">${text}</a>`;
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
    if (p1.includes('/')) return `<div class="video-wrap" data-file="${p1}"><video src="merlin://${p1}" controls playsinline preload="metadata" style="max-width:100%;border-radius:10px"></video></div>`;
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
      thead = '<thead><tr>' + headers.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr></thead>';
      const bodyRows = rows.slice(2);
      tbody = '<tbody>' + bodyRows.map(r => '<tr>' + parseRow(r).map(c => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>').join('') + '</tbody>';
    } else {
      tbody = '<tbody>' + rows.map(r => '<tr>' + parseRow(r).map(c => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>').join('') + '</tbody>';
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
      `<div class="artifact"><div class="code-block-header"><span>preview</span><button class="copy-btn" data-copy="${encoded}">Copy HTML</button></div><iframe sandbox="allow-scripts" srcdoc="${art.code.replace(/"/g, '&quot;').replace(/'/g, '&#39;')}" style="width:100%;min-height:200px;border:1px solid var(--border);border-radius:0 0 8px 8px;background:#fff"></iframe></div>`
    );
  });

  return html;
}

// Delegated copy handler for all data-copy buttons (prevents XSS from inline onclick)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const text = decodeURIComponent(btn.dataset.copy);
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = orig === '⧉' ? '✓' : 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
  });
});

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Sanitize raw errors into user-friendly messages
function friendlyError(raw, platformName) {
  if (!raw) return `Could not connect to ${platformName || 'the platform'}. Please try again.`;
  const s = String(raw);
  const sl = s.toLowerCase();

  // Balance / billing errors — detect actual platform from error text
  if (sl.includes('exhausted balance') || sl.includes('top up') || sl.includes('insufficient') || sl.includes('billing')) {
    const src = sl.includes('fal.ai') ? 'fal.ai' : sl.includes('elevenlabs') ? 'ElevenLabs' : sl.includes('heygen') ? 'HeyGen' : (platformName || 'API');
    return `Your ${src} balance is empty. Add credits to continue.`;
  }
  if (sl.includes('rate limit') || sl.includes('too many requests') || sl.includes('429')) return `Too many requests. Wait a moment and try again.`;
  if (sl.includes('quota') || sl.includes('exceeded')) return `${platformName || 'API'} quota exceeded. Check your plan limits.`;

  // Auth errors
  if (sl.includes('401') || sl.includes('unauthorized') || sl.includes('invalid.*key') || sl.includes('invalid.*token')) return `Authorization failed. Try reconnecting ${platformName || 'the platform'}.`;
  if (sl.includes('403') || sl.includes('forbidden') || sl.includes('locked')) return `Access denied on ${platformName || 'the platform'}. Check your account status.`;

  // Network errors
  if (sl.includes('enoent') || sl.includes('not found') || sl.includes('spawn')) return `Merlin engine not found. Try reinstalling or running /update.`;
  if (sl.includes('etimedout') || sl.includes('timeout')) return `Connection timed out. Check your internet and try again.`;
  if (sl.includes('econnrefused')) return `${platformName || 'Platform'} refused the connection. The service may be down.`;
  if (sl.includes('enotfound') || sl.includes('dns')) return `Can't reach ${platformName || 'the service'}. Check your internet connection.`;

  // Command/binary errors — never show raw paths
  if (s.includes('Command failed') || s.includes('.exe') || s.includes('--cmd') || s.includes('--config')) {
    return `Could not connect to ${platformName || 'the platform'}. Please check your internet connection and try again.`;
  }

  // JSON / technical errors — strip and simplify
  if (s.includes('{"') || s.includes('[ERROR]') || s.includes('HTTP 4') || s.includes('HTTP 5')) {
    if (sl.includes('500') || sl.includes('internal server')) return `${platformName || 'Service'} is having issues. Try again in a few minutes.`;
    if (sl.includes('404')) return `${platformName || 'Resource'} not found. It may have been moved or deleted.`;
    return `Something went wrong with ${platformName || 'the service'}. Try again.`;
  }

  // Truncate anything still long
  if (s.length > 150) return s.slice(0, 140) + '…';
  return s;
}

// ── SDK Message Handling ────────────────────────────────────
let firstMessage = true;
let hasShownSparkleHint = false;
let _userMessageCount = 0;

merlin.onSdkMessage((msg) => {
  // Suppress internal action responses (spell toggle/create) — no chat bubbles
  if (msg._internal) return;

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
          if (block.type === 'image' && block.source?.data && block.source.data.length > 100 && block.source.data.length < 10_000_000) { // cap at ~7.5MB decoded
            const imgBubble = addClaudeBubble();
            imgBubble.innerHTML = `<img src="data:${block.source.media_type || 'image/png'};base64,${block.source.data}" alt="Image" style="max-width:100%;border-radius:10px">`;
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
      clearStatusLabel();
      isStreaming = false;
      setInputDisabled(false);
      stopTickingTimer();
      // Show stats bar like Claude Desktop
      if (turnStartTime) {
        const duration = ((Date.now() - turnStartTime) / 1000).toFixed(0);
        const statsDiv = document.createElement('div');
        statsDiv.className = 'turn-stats';
        // Try multiple paths for token count
        const tokens = msg.usage?.output_tokens
          || msg.result?.usage?.output_tokens
          || msg.num_output_tokens
          || null;
        let statsText = `${duration}s`;
        // Use turn token count from message_delta events
        const numTurns = msg.num_turns || '';
        if (turnTokens > 0) statsText += ` \u00b7 ${turnTokens} tokens`;
        statsText += ' \u00b7 Merlin can make mistakes';
        statsDiv.textContent = statsText;
        messages.appendChild(statsDiv);
        scrollToBottom();
        turnStartTime = null;
      }
      input.focus();
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
      setStatusLabel('Weaving a response'); // Keep status visible — only clear on turn end
      if (!currentBubble) {
        addClaudeBubble();
        isStreaming = true;
        setInputDisabled(true);
      }
    }
    // Show tool activity status (like Claude Code) — single persistent row, no stacking
    if (event.content_block && event.content_block.type === 'tool_use') {
      const toolName = event.content_block.name || '';
      const labels = {
        'Bash': 'Casting a spell', 'Read': 'Reading the scrolls', 'Write': 'Inscribing',
        'Edit': 'Refining the formula', 'Glob': 'Scanning the vault', 'Grep': 'Divining patterns',
        'WebSearch': 'Consulting the oracle', 'WebFetch': 'Summoning knowledge',
        'Agent': 'Dispatching a familiar', 'TodoWrite': 'Charting the course',
        'AskUserQuestion': 'Awaiting your wisdom',
      };
      const label = labels[toolName] || 'Channeling';
      setStatusLabel(label);
    }
  }

  if (event.type === 'content_block_delta') {
    if (event.delta && event.delta.type === 'text_delta' && event.delta.text) {
      appendText(event.delta.text);
    }
  }

  if (event.type === 'message_stop') {
    // Don't clear status — message_stop is not turn-end (more tools may follow)
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

  // 15-minute countdown (matches backend APPROVAL_TIMEOUT_MS)
  let secondsLeft = 900;
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
  if (typingTimeout) { clearTimeout(typingTimeout); typingTimeout = null; }
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
  let isClaudeNotFound = false;
  if (errLower.includes('enotfound') || errLower.includes('econnrefused') || errLower.includes('etimedout') || errLower.includes('network')) {
    userMsg = 'Lost connection — check your internet. ';
  } else if (errLower.includes('401') || errLower.includes('unauthorized')) {
    userMsg = 'Session expired. ';
    isAuthError = true;
  } else if (errLower.includes('enoent') && (errLower.includes('spawn') || errLower.includes('node'))) {
    // Only match actual spawn ENOENT — not every error containing "not found"
    userMsg = 'Claude CLI not found. ';
    isClaudeNotFound = true;
  }
  // ALWAYS log the real error so we can debug
  console.error('[SDK Error]', err);

  const bubble = addClaudeBubble();

  if (_restartAttempts > MAX_RESTART_ATTEMPTS) {
    // Stop retrying — show manual recovery with specific guidance
    let reason;
    if (isClaudeNotFound) {
      reason = 'Claude CLI is not installed. Install it from claude.ai/download, then click Retry.';
    } else if (isAuthError) {
      reason = 'Please open Claude Desktop and make sure you\'re logged in, then click Retry.';
    } else {
      reason = 'Check your internet connection and click Retry when ready.';
    }
    const debugInfo = err ? `\n\nError: ${(err || '').slice(0, 200)}` : '';
    textBuffer = `${userMsg}Merlin tried ${MAX_RESTART_ATTEMPTS} times but couldn't connect.\n\n${reason}${debugInfo}`;
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
  // Show the actual error on first attempt so Mac users can report it
  const debugHint = _restartAttempts === 1 ? `\n(${(err || '').slice(0, 120)})` : '';
  textBuffer = `${userMsg}Retrying in ${delay / 1000}s... (attempt ${_restartAttempts}/${MAX_RESTART_ATTEMPTS})${debugHint}`;
  finalizeBubble();
  bubble.style.borderColor = 'rgba(239,68,68,.3)';

  setTimeout(() => {
    sessionActive = true;
    merlin.startSession();
  }, delay);
});

// ── Update Toast ────────────────────────────────────────────
merlin.onUpdateAvailable(({ current, latest }) => {
  // Double-check: don't show if versions are equal
  if (current === latest) return;
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

merlin.onUpdateReady(({ latest, needsReinstall }) => {
  // Always restore the dismiss button — onUpdateAvailable hides it during the
  // "Updating..." phase, but the user must always be able to close the toast.
  const dismiss = document.getElementById('update-dismiss');
  dismiss.classList.remove('hidden');
  dismiss.onclick = () => document.getElementById('update-toast').classList.add('hidden');

  if (needsReinstall) {
    // Shell asar can't be hot-swapped — we need to run the new installer.
    // The Install button kicks off a download + silent install + relaunch.
    document.getElementById('update-text').textContent = `Merlin ${latest} ready — install now?`;
    document.getElementById('update-btn').textContent = 'Install Now';
    document.getElementById('update-btn').disabled = false;
    document.getElementById('update-btn').onclick = async () => {
      document.getElementById('update-btn').disabled = true;
      document.getElementById('update-btn').textContent = 'Installing...';
      dismiss.classList.add('hidden');
      try {
        const r = await merlin.installUpdate();
        if (!r?.ok) {
          document.getElementById('update-text').textContent = `Install failed: ${r?.error || 'unknown error'}`;
          document.getElementById('update-btn').textContent = 'Retry';
          document.getElementById('update-btn').disabled = false;
          dismiss.classList.remove('hidden');
        }
        // On success, the app will quit shortly — no further UI needed
      } catch (e) {
        document.getElementById('update-text').textContent = `Install failed: ${e.message}`;
        document.getElementById('update-btn').textContent = 'Retry';
        document.getElementById('update-btn').disabled = false;
        dismiss.classList.remove('hidden');
      }
    };
  } else {
    document.getElementById('update-text').textContent = `Merlin ${latest} installed`;
    document.getElementById('update-btn').textContent = 'Restart';
    document.getElementById('update-btn').disabled = false;
    document.getElementById('update-btn').onclick = () => {
      merlin.restartApp();
    };
  }
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

// ── Security: bypass attempt toast ──────────────────────────
// Surfaces when the hook or canUseTool blocks an API bypass attempt.
// Tells the user something was blocked without alarming them — it's
// expected behavior when Claude is exploring.
let _bypassToastTimer = null;
merlin.onBypassAttempt(({ reason }) => {
  let toast = document.getElementById('bypass-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'bypass-toast';
    toast.style.cssText = 'position:fixed;bottom:20px;right:20px;max-width:360px;padding:12px 16px;background:rgba(20,20,24,0.96);border:1px solid rgba(251,191,36,0.4);border-radius:12px;color:#e4e4e7;font-size:12px;line-height:1.4;z-index:9999;box-shadow:0 8px 32px rgba(0,0,0,0.5);backdrop-filter:blur(12px);opacity:0;transform:translateY(10px);transition:all .3s ease';
    toast.innerHTML = '<div style="font-weight:600;color:#fbbf24;margin-bottom:4px">✦ Merlin prevented an unsafe action</div><div id="bypass-toast-body" style="color:rgba(228,228,231,0.8)"></div>';
    document.body.appendChild(toast);
  }
  document.getElementById('bypass-toast-body').textContent = reason || 'An unauthorized action was blocked.';
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });
  if (_bypassToastTimer) clearTimeout(_bypassToastTimer);
  _bypassToastTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
  }, 7000);
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
  ecom:    ['meta','tiktok','shopify','klaviyo','google','pinterest','amazon','fal','elevenlabs','heygen','slack','discord'],
  game:    ['meta','tiktok','google','fal','heygen','elevenlabs','slack','discord'],
  saas:    ['meta','google','klaviyo','fal','elevenlabs','slack','discord'],
  local:   ['meta','google','fal','slack','discord'],
  agency:  ['meta','tiktok','shopify','klaviyo','google','pinterest','amazon','fal','elevenlabs','heygen','slack','discord'],
};

async function loadBrands() {
  try {
    const brands = await merlin.getBrands();
    const select = document.getElementById('brand-select');
    const state = await merlin.loadState();
    select.innerHTML = '';
    if (!brands || brands.length === 0) {
      select.innerHTML = '<option value="">No brand</option>';
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
    // "+ New Brand" at the bottom
    const addOpt = document.createElement('option');
    addOpt.value = '__add__';
    addOpt.textContent = '+ New Brand';
    select.appendChild(addOpt);

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
  // Handle "+ New Brand" option
  if (e.target.value === '__add__') {
    // Reset to previous selection
    e.target.value = '';
    addUserBubble('Set up a new brand for me');
    showTypingIndicator();
    turnStartTime = Date.now();
    turnTokens = 0;
    sessionActive = true;
    startTickingTimer();
    merlin.sendMessage('Set up a new brand for me');
    return;
  }

  // Persist active brand selection
  merlin.saveState({ activeBrand: e.target.value });
  merlin.getBrands().then((brands) => {
    const brand = brands.find(b => b.name === e.target.value);
    if (brand?.vertical) updateVertical(brand.vertical);
    else updateVertical('');
  }).catch((err) => { console.warn('[brands]', err); });
  // Reload connections and spells for the selected brand
  loadConnections();
  loadSpells();
  // Load perf bar for new brand — cache handles instant swap, no blank flash
  const activePeriod = document.querySelector('.perf-period-btn.active')?.dataset.days || '7';
  const newBrand = e.target.value;
  // Show cached immediately or skeleton if no cache
  const cached = perfState.cache[newBrand]?.[parseInt(activePeriod)];
  if (cached) renderPerfBar(cached);
  else renderPerfBarSkeleton();
  loadPerfBar(parseInt(activePeriod), newBrand);
});

// add-brand-btn moved into brand dropdown as "+ New Brand" option

// ── Revenue Tracker (Merlin Made Me) ────────────────────────
function fmtMoney(n) {
  if (n == null || isNaN(n)) return '--';
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return '$' + Math.round(n);
}

function setStatsEmpty() {
  ['stats-revenue','stats-roas','stats-spend'].forEach(id => {
    document.getElementById(id).textContent = '--';
  });
  document.getElementById('stats-period').textContent = 'No data yet — run a performance check first';
  document.getElementById('stats-story').textContent = '';
  document.getElementById('stats-bar-spend').style.width = '50%';
  document.getElementById('stats-bar-revenue').style.width = '50%';
  document.getElementById('stats-bar-spend').querySelector('.stats-bar-label').textContent = '';
  document.getElementById('stats-bar-revenue').querySelector('.stats-bar-label').textContent = '';
}

function updateStatsBarAndStory(rev, spend, mer) {
  const total = rev + spend;
  if (total > 0) {
    const spendPct = Math.max(10, Math.round((spend / total) * 100));
    const revPct = 100 - spendPct;
    document.getElementById('stats-bar-spend').style.width = spendPct + '%';
    document.getElementById('stats-bar-revenue').style.width = revPct + '%';
    document.getElementById('stats-bar-spend').querySelector('.stats-bar-label').textContent = fmtMoney(spend) + ' spent';
    document.getElementById('stats-bar-revenue').querySelector('.stats-bar-label').textContent = fmtMoney(rev) + ' revenue';
  } else {
    document.getElementById('stats-bar-spend').style.width = '50%';
    document.getElementById('stats-bar-revenue').style.width = '50%';
    document.getElementById('stats-bar-spend').querySelector('.stats-bar-label').textContent = '';
    document.getElementById('stats-bar-revenue').querySelector('.stats-bar-label').textContent = '';
  }
  if (mer > 0 && spend > 0) {
    document.getElementById('stats-story').textContent = 'Every $1 you spent returned $' + mer.toFixed(2);
  } else if (rev > 0) {
    document.getElementById('stats-story').textContent = fmtMoney(rev) + ' in revenue tracked';
  } else {
    document.getElementById('stats-story').textContent = '';
  }
}

function populateStatsCard(cache) {
  const revenueKeys = ['totalRevenue', 'revenue', 'total_revenue', 'grossRevenue', 'gross_revenue', 'sales', 'totalSales'];
  const spendKeys = ['totalSpend', 'spend', 'total_spend', 'adSpend', 'ad_spend', 'cost', 'totalCost'];
  const roasKeys = ['blendedROAS', 'roas', 'blended_roas', 'ROAS', 'returnOnAdSpend'];

  function findKey(obj, keys) {
    for (const k of keys) { if (obj[k] != null) return obj[k]; }
    return null;
  }

  let revenue = null, spend = null, roas = null;
  let lastUpdated = null;

  if (!cache) {
    setStatsEmpty();
    return;
  }

  const priorityOrder = ['dashboard'];
  const allKeys = Object.keys(cache);
  allKeys.forEach(k => { if (k !== 'dashboard') priorityOrder.push(k); });

  for (const key of priorityOrder) {
    const entry = cache[key];
    if (!entry?.data) continue;
    try {
      const d = JSON.parse(entry.data);
      if (revenue == null) revenue = findKey(d, revenueKeys);
      if (spend == null) spend = findKey(d, spendKeys);
      if (roas == null) roas = findKey(d, roasKeys);
      if (!lastUpdated || entry.timestamp > lastUpdated) lastUpdated = entry.timestamp;
    } catch {}
  }

  const rev = revenue != null ? Number(revenue) : 0;
  const sp = spend != null ? Number(spend) : 0;
  const mer = roas != null ? Number(roas) : (sp > 0 ? rev / sp : 0);

  document.getElementById('stats-revenue').textContent = rev > 0 ? fmtMoney(rev) : '--';
  document.getElementById('stats-spend').textContent = sp > 0 ? fmtMoney(sp) : '--';
  document.getElementById('stats-roas').textContent = mer > 0 ? mer.toFixed(1) + 'x return' : '--';
  updateStatsBarAndStory(rev, sp, mer);

  const period = document.getElementById('stats-period');
  if (lastUpdated) {
    const ago = Math.round((Date.now() - new Date(lastUpdated).getTime()) / 3600000);
    period.textContent = ago < 1 ? 'Updated just now' : ago < 24 ? `Updated ${ago}h ago` : `Updated ${Math.round(ago / 24)}d ago`;
  } else {
    setStatsEmpty();
  }
}

// brand-stats-btn removed — revenue tracker opens via perf bar click

document.getElementById('stats-close').addEventListener('click', () => {
  document.getElementById('stats-overlay').classList.add('hidden');
});

// ── Wisdom Overlay ─────────────────────────────────────────
document.getElementById('wisdom-header-btn').addEventListener('click', async () => {
  document.getElementById('magic-panel').classList.add('hidden');
  document.getElementById('archive-panel').classList.add('hidden');
  closeAgencyOverlay();
  const overlay = document.getElementById('wisdom-overlay');

  // Toggle — if already open, just close
  if (!overlay.classList.contains('hidden')) {
    overlay.classList.add('hidden');
    return;
  }

  const grid = document.getElementById('wisdom-grid');
  const sampleEl = document.getElementById('wisdom-sample');

  grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-dim);padding:20px">Loading...</div>';
  overlay.classList.remove('hidden');

  let w = null;
  try { w = await merlin.getWisdom(); } catch {}
  if (!w) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-dim);padding:20px">No data yet — Wisdom grows as ads run.</div>';
    return;
  }

  const sample = w.sample_size || 0;
  sampleEl.textContent = sample > 0 ? `From ${sample.toLocaleString()} anonymized ads` : 'Collecting data...';

  const patterns = w.patterns || {};
  const topHooks = (patterns.top_hooks || []).slice(0, 4);
  const topScenes = (patterns.top_scenes || []).slice(0, 4);
  const topModels = (patterns.top_models || []);
  const imageModels = topModels.filter(m => m.type === 'image').slice(0, 3);
  const videoModels = topModels.filter(m => m.type === 'video').slice(0, 3);
  const formats = w.formats || {};
  const timing = w.timing || {};

  const formatList = Object.entries(formats)
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => (b.avg_roas || 0) - (a.avg_roas || 0))
    .slice(0, 4);

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const bestDays = (timing.best_days || []).map(i => dayNames[i] || i).join(', ');
  const bestHours = (timing.best_hours || []).map(h => {
    const ampm = h >= 12 ? 'PM' : 'AM';
    return (h === 0 ? 12 : h > 12 ? h - 12 : h) + ampm;
  }).join(', ');

  const empty = '<div style="color:var(--text-dim);font-size:12px">Collecting...</div>';

  function rankRows(items, valFn, color, maxVal) {
    if (!items.length) return empty;
    return items.map(item => {
      const val = valFn(item);
      const pct = maxVal > 0 ? Math.min(100, (val / maxVal) * 100) : 0;
      return `<div class="wisdom-rank">
        <div class="wisdom-rank-row">
          <span class="wisdom-rank-label">${escapeHtml(item.label)}</span>
          <span class="wisdom-rank-value" style="color:${color}">${item.display}</span>
        </div>
        <div class="wisdom-bar"><div class="wisdom-bar-fill" style="width:${pct}%;background:${color}"></div></div>
        ${item.sub ? `<div class="wisdom-rank-sub">${escapeHtml(item.sub)}</div>` : ''}
      </div>`;
    }).join('');
  }

  const hookItems = topHooks.map(h => ({ label: h.hook, display: h.avg_roas + 'x', sub: h.sample + ' ads', val: h.avg_roas }));
  const sceneItems = topScenes.map(s => ({ label: s.scene, display: s.avg_roas + 'x', sub: s.sample + ' ads', val: s.avg_roas }));
  const imgItems = imageModels.map(m => ({ label: m.model, display: m.avg_roas + 'x', sub: m.win_rate + '% wins · ' + m.sample + ' ads', val: m.avg_roas }));
  const vidItems = videoModels.map(m => ({ label: m.model, display: m.avg_roas + 'x', sub: m.win_rate + '% wins · ' + m.sample + ' ads', val: m.avg_roas }));
  const fmtItems = formatList.map(f => ({ label: f.name, display: f.avg_roas + 'x', sub: (f.win_rate || 0) + '% wins', val: f.avg_roas }));

  // Benchmark: compare user's brand to collective averages
  const brand = document.getElementById('brand-select')?.value || '';
  const userPerf = perfState.cache[brand]?.[7] || perfState.cache[brand]?.[perfState.currentPeriod];
  let benchmarkHtml = '';
  if (userPerf && w.hooks) {
    const avgCTR = Object.values(w.hooks).reduce((s, h) => s + (h.avg_ctr || 0), 0) / Math.max(1, Object.keys(w.hooks).length);
    const avgROAS = topHooks.length > 0 ? topHooks.reduce((s, h) => s + h.avg_roas, 0) / topHooks.length : 0;
    const userMER = userPerf.mer || 0;
    benchmarkHtml = `<div style="grid-column:1/-1;padding:12px 0;border-bottom:1px solid var(--border);margin-bottom:4px">
      <div class="wisdom-card-title">Your Performance vs Network</div>
      <div style="display:flex;gap:24px;flex-wrap:wrap">
        <div><span style="font-size:18px;font-weight:700;color:${userMER >= avgROAS ? '#22c55e' : '#f59e0b'}">${userMER > 0 ? userMER.toFixed(1) + 'x' : '—'}</span>
          <span style="font-size:11px;color:var(--text-dim)"> your MER vs ${avgROAS > 0 ? avgROAS.toFixed(1) + 'x' : '—'} avg</span></div>
        <div><span style="font-size:12px;color:var(--text-dim)">${userMER >= avgROAS ? '✦ Above network average' : '↑ Room to improve — check top hooks'}</span></div>
      </div>
    </div>`;
  }

  // Creative intelligence: actionable insight from top data
  let intelHtml = '';
  if (topHooks.length >= 2) {
    const best = topHooks[0];
    const worst = topHooks[topHooks.length - 1];
    const diff = best.avg_roas > 0 && worst.avg_roas > 0 ? Math.round(((best.avg_roas - worst.avg_roas) / worst.avg_roas) * 100) : 0;
    if (diff > 10) {
      intelHtml = `<div style="grid-column:1/-1;padding:10px 14px;background:rgba(139,92,246,.06);border:1px solid rgba(139,92,246,.15);border-radius:8px;margin-bottom:8px">
        <span style="font-size:12px;color:var(--text-muted)">✦ <strong>${escapeHtml(best.hook)}</strong> hooks outperform <strong>${escapeHtml(worst.hook)}</strong> by ${diff}% in your vertical right now.</span>
      </div>`;
    }
  }

  // Seasonal insight
  const month = String(new Date().getMonth() + 1);
  let seasonalHtml = '';
  try {
    const seasonal = await fetch('seasonal.json').then(r => r.ok ? r.json() : null).catch(() => null);
    if (seasonal && seasonal[month]) {
      seasonalHtml = `<div style="grid-column:1/-1;padding:10px 14px;background:rgba(52,211,153,.06);border:1px solid rgba(52,211,153,.15);border-radius:8px;margin-bottom:8px">
        <span style="font-size:12px;color:var(--text-muted)">📅 ${escapeHtml(seasonal[month])}</span>
      </div>`;
    }
  } catch {}

  grid.innerHTML = `
    ${benchmarkHtml}
    ${intelHtml}
    ${seasonalHtml}
    <div>
      <div class="wisdom-card-title">Top Hooks</div>
      ${rankRows(hookItems, i => i.val, '#22c55e', hookItems.length ? Math.max(...hookItems.map(i => i.val)) : 1)}
    </div>
    <div>
      <div class="wisdom-card-title">Creative Styles</div>
      ${rankRows(sceneItems, i => i.val, '#8b5cf6', sceneItems.length ? Math.max(...sceneItems.map(i => i.val)) : 1)}
    </div>
    <div>
      <div class="wisdom-card-title">Best Formats</div>
      ${rankRows(fmtItems, i => i.val, '#06b6d4', fmtItems.length ? Math.max(...fmtItems.map(i => i.val)) : 1)}
    </div>
    <div>
      <div class="wisdom-card-title">Image Models</div>
      ${rankRows(imgItems, i => i.val, '#3b82f6', imgItems.length ? Math.max(...imgItems.map(i => i.val)) : 1)}
    </div>
    <div>
      <div class="wisdom-card-title">Video Models</div>
      ${rankRows(vidItems, i => i.val, '#f59e0b', vidItems.length ? Math.max(...vidItems.map(i => i.val)) : 1)}
    </div>
    <div>
      <div class="wisdom-card-title">Best Timing</div>
      <div class="wisdom-timing-label">BEST DAYS</div>
      <div class="wisdom-timing-value">${escapeHtml(bestDays || 'Collecting...')}</div>
      <div class="wisdom-timing-label">BEST HOURS</div>
      <div class="wisdom-timing-value" style="margin-bottom:0">${escapeHtml(bestHours || 'Collecting...')}</div>
    </div>
  `;
});

document.getElementById('wisdom-close').addEventListener('click', () => {
  document.getElementById('wisdom-overlay').classList.add('hidden');
});
document.getElementById('stats-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'stats-overlay') document.getElementById('stats-overlay').classList.add('hidden');
});

// Share button — copy stats as shareable text
document.getElementById('stats-share').addEventListener('click', async () => {
  const btn = document.getElementById('stats-share');
  const brand = document.getElementById('stats-brand-name').textContent;
  const rev = document.getElementById('stats-revenue').textContent;
  const period = document.getElementById('stats-period').textContent;
  const roas = document.getElementById('stats-roas').textContent;
  const story = document.getElementById('stats-story').textContent;
  const spend = document.getElementById('stats-spend').textContent;
  const text = `✦ Merlin Got Me\n${brand} — ${period}\n${rev} revenue\n${story ? story + '\n' : ''}${spend} spent · ${roas}\nmerlingotme.com`;
  try { await navigator.clipboard.writeText(text); } catch {}
  const orig = btn.innerHTML;
  btn.textContent = 'Copied!';
  btn.style.background = 'var(--success)';
  setTimeout(() => { btn.innerHTML = orig; btn.style.background = ''; }, 2000);
});

function loadConnections() {
  const brand = document.getElementById('brand-select')?.value;
  merlin.getConnectedPlatforms(brand).then((connected) => {
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

    connected.forEach(conn => {
      // Support both old format (string) and new format ({ platform, status })
      const platform = typeof conn === 'string' ? conn : conn.platform;
      const status = typeof conn === 'string' ? 'connected' : (conn.status || 'connected');
      const tile = availableTiles.querySelector(`.magic-tile[data-platform="${platform}"]`);
      if (tile) {
        const clone = tile.cloneNode(true);
        clone.classList.add('connected');
        if (status === 'expired') clone.classList.add('expired');
        // Right-click to disconnect
        clone.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const name = clone.querySelector('.tile-name')?.textContent || platform;
          showContextMenu(e, [
            { label: 'Disconnect', danger: true, action: () => {
              showModal({
                title: `Disconnect ${name}?`,
                body: 'You can reconnect anytime from the sidebar.',
                confirmLabel: 'Disconnect',
                cancelLabel: 'Keep',
                onConfirm: async () => {
                  await merlin.disconnectPlatform(platform, document.getElementById('brand-select')?.value || '');
                  loadConnections();
                },
              });
            }},
          ]);
        });
        connectedSection.appendChild(clone);
        tile.style.display = 'none';
      }
    });
  }).catch((err) => { console.warn('[connections]', err); });
}

// Auto-refresh connections when tokens change (e.g., OAuth completed in background)
merlin.onConnectionsChanged(() => loadConnections());

document.getElementById('magic-btn').addEventListener('click', () => {
  document.getElementById('archive-panel').classList.add('hidden');
  document.getElementById('wisdom-overlay').classList.add('hidden');
  closeAgencyOverlay();
  const panel = document.getElementById('magic-panel');
  panel.classList.toggle('hidden');
  // Load brands first (sets vertical filter), then connections (hides connected from available)
  if (!panel.classList.contains('hidden')) {
    loadBrands().then(() => loadConnections());
    loadSpells();
    loadReferralInfo();
    const creditBrand = document.getElementById('brand-select')?.value || '';
    merlin.getCredits(creditBrand).then((credits) => {
      if (!credits) return;
      // Show credits as tooltip on hover, not inline text
      document.querySelectorAll('.magic-tile').forEach(tile => {
        const platform = tile.dataset.platform;
        const existing = tile.querySelector('.tile-credits');
        if (existing) existing.remove();
        if (credits[platform]) {
          tile.setAttribute('data-tip', `${tile.querySelector('.tile-name')?.textContent || platform} · ${credits[platform]}`);
        }
      });
    }).catch((err) => { console.warn('[credits]', err); });
  }
});
document.getElementById('magic-close').addEventListener('click', () => {
  document.getElementById('magic-panel').classList.add('hidden');
});

// Close panel ONLY when clicking into the chat area (not overlays, previews, menus, perf bar)
document.addEventListener('click', (e) => {
  const panel = document.getElementById('magic-panel');
  const btn = document.getElementById('magic-btn');
  if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== btn) {
    // Only close if clicking in chat or input area — nowhere else
    if (!e.target.closest('#chat') && !e.target.closest('#input-bar')) return;
    panel.classList.add('hidden');
  }
});

// Connect platform tiles — ALL connections handled directly in UI, zero chat involvement
const OAUTH_PLATFORMS = new Set(['meta', 'tiktok', 'shopify', 'google', 'amazon', 'pinterest', 'klaviyo', 'slack', 'discord']);
const API_KEY_PLATFORMS = {
  fal:        { key: 'falApiKey', label: 'fal.ai', placeholder: 'fal-xxxx...', url: 'https://fal.ai/dashboard/keys' },
  elevenlabs: { key: 'elevenLabsApiKey', label: 'ElevenLabs', placeholder: 'xi_xxxx...', url: 'https://elevenlabs.io/app/settings/api-keys' },
  heygen:     { key: 'heygenApiKey', label: 'HeyGen', placeholder: 'your-api-key', url: 'https://app.heygen.com/settings?nav=API' },
  slack:      { key: 'slackWebhookUrl', label: 'Slack', placeholder: 'https://hooks.slack.com/services/...', url: null },
};

document.addEventListener('click', async (e) => {
  const tile = e.target.closest('.magic-tile');
  if (!tile) return;
  if (tile.dataset.stubbed === 'true') return;
  const platform = tile.dataset.platform;
  const activeBrand = document.getElementById('brand-select')?.value || '';
  const displayName = platform.charAt(0).toUpperCase() + platform.slice(1);

  if (OAUTH_PLATFORMS.has(platform)) {
    // Launch OAuth — don't dim the tile, let it complete in background
    merlin.runOAuth(platform, activeBrand).then(result => {
      if (result.error) {
        showModal({ title: 'Connection Failed', body: friendlyError(result.error, displayName), confirmLabel: 'OK', onConfirm: () => {} });
      } else {
        loadConnections();
      }
    }).catch(err => {
      showModal({ title: 'Connection Failed', body: friendlyError(err.message, displayName), confirmLabel: 'OK', onConfirm: () => {} });
    });
    return;
  }

  const apiDef = API_KEY_PLATFORMS[platform];
  if (apiDef) {
    // API key entry via modal — no chat
    // Build body as DOM nodes (safer than innerHTML interpolation, no escaping bugs)
    const bodyFrag = document.createDocumentFragment();
    if (apiDef.url) {
      bodyFrag.appendChild(document.createTextNode('Paste your API key below. '));
      const link = document.createElement('a');
      link.href = apiDef.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.color = 'var(--accent)';
      link.textContent = 'Get your key here';
      bodyFrag.appendChild(link);
    } else {
      bodyFrag.appendChild(document.createTextNode('Paste your API key or webhook URL below.'));
    }
    const wrapper = document.createElement('div');
    wrapper.appendChild(bodyFrag);

    showModal({
      title: `Connect ${apiDef.label}`,
      bodyHTML: wrapper.innerHTML,
      inputPlaceholder: apiDef.placeholder,
      confirmLabel: 'Save',
      cancelLabel: 'Cancel',
      onConfirm: async (value) => {
        if (!value || value.trim().length < 5) { showModalError('Key is too short'); return; }
        const result = await merlin.saveConfigField(apiDef.key, value.trim(), activeBrand);
        if (result.success) loadConnections();
        else showModal({ title: 'Error', body: result.error || 'Failed to save', confirmLabel: 'OK', onConfirm: () => {} });
      },
    });
    return;
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
  fetch('https://merlingotme.com/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'platform-request', text }),
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
  const activeBrand = document.getElementById('brand-select')?.value || '';
  try { spells = await merlin.listSpells(activeBrand); } catch { spells = []; }
  const list = document.getElementById('spellbook-list');
  const warning = document.getElementById('spellbook-warning');

  // Check if Claude Desktop is running
  if (spells && spells.length > 0) {
    try {
      const running = await merlin.checkClaudeRunning();
      warning.style.display = running ? 'none' : 'block';
    } catch { warning.style.display = 'none'; }
  } else {
    warning.style.display = 'none';
  }

  list.innerHTML = '';

  // Hide the old templates section — we merge everything into the unified list
  const oldTemplates = document.getElementById('spell-templates');
  if (oldTemplates) oldTemplates.style.display = 'none';
  const addBtn = document.getElementById('add-task-btn');
  if (addBtn) addBtn.style.display = 'none';

  // Build set of active spell IDs for deduplication
  const activeIds = new Set((spells || []).map(s => s.id));

  // Render active spells first (from disk)
  (spells || []).forEach(spell => {
    list.appendChild(buildSpellRow(spell, true));
  });

  // Then render available templates that aren't active yet (gray dots)
  // Agency-tier spell prompts with IVT, fatigue detection, and budget optimization rules
  const templateData = [
    { spell: 'daily-ads', cron: '0 9 * * 1-5', name: 'Daily Ads', desc: 'Fresh creatives with IVT testing', prompt:
      'Read .merlin-wisdom.json for collective trends (best hooks, formats, models). Read seasonal.json for timing strategy. ' +
      'IVT Protocol: Identify what to test today (rotate: Mon=hooks, Tue=angles, Wed=formats, Thu=scenes, Fri=audiences). ' +
      'Generate 3 variations changing ONLY the test variable. Hold everything else constant. ' +
      'Label each ad: "[Hook Test] Pain Point", "[Hook Test] Social Proof", etc. ' +
      'Use the best-performing hook style from Wisdom data. ' +
      'PREDICTIVE SCORING: Before publishing, check .merlin-wisdom.json for the avg ROAS of this creative\'s hook style and format. ' +
      'Report: "✦ Score: [hook style] averages [X]x ROAS across the network ([N] ads). [format] averages [Y]x." ' +
      'If the hook+format combo averages < 1.5x in Wisdom data, flag it and suggest using a higher-performing hook instead. ' +
      'Publish to Testing campaign at $5-10/day each. ' +
      'Show each image inline. Report: what variable tested, variations created, predicted score, test duration (48h).' },
    { spell: 'performance-check', cron: '0 14 * * 1-5', name: 'Performance Check', desc: 'Deterministic kill/scale rules', prompt:
      'Pull performance from all platforms using dashboard. Apply these DETERMINISTIC rules (no judgment calls):\n' +
      'FATIGUE DETECTION (use ONLY numbers from meta-insights output — never calculate trends yourself):\n' +
      '- If insights show CTR is below 60% of the highest CTR in the output → KILL\n' +
      '- If insights show frequency > 2.5 → WARNING\n' +
      '- If insights show frequency > 4.0 → KILL\n' +
      '- If insights show CPC is 1.5x+ the lowest CPC in the output → KILL\n' +
      'SCALING:\n' +
      '- ROAS > 3x for 3+ days → duplicate to Scaling, increase budget 20%\n' +
      '- ROAS > 2x for 5+ days → increase budget 20% (no duplicate)\n' +
      '- New ads: never kill before 48h unless CPM > 3x vertical average\n' +
      'BUDGET:\n' +
      '- Winners get budget doubled every 48h, max 20% daily increase\n' +
      '- Platform allocation: shift monthly toward highest blended ROAS\n' +
      'Report: killed (with reason), scaled, warnings, net budget change, platform allocation recommendation.' },
    { spell: 'morning-briefing', cron: '0 5 * * 1-5', name: 'Morning Briefing', desc: 'Overnight results at 5 AM', prompt:
      'Pull overnight results via dashboard. Read .merlin-wisdom.json for benchmarks. ' +
      'Save to .merlin-briefing.json: date, ads (winners/losers/fatigue signals), content (published), ' +
      'revenue (yesterday + week + MER trend), recommendation (one actionable sentence). ' +
      'Compare your CTR/ROAS to Wisdom collective averages — flag if above or below. Keep each field 2-4 lines. ' +
      'If slackBotToken exists in config, post a clean digest to the Slack channel using the Slack API (chat.postMessage with the bot token) in this exact format:\n' +
      '"✦ Morning Briefing — [Brand]\n' +
      '━━━━━━━━━━━━━━━\n' +
      '💰 Revenue: $X yesterday · $Xk this week · MER Xx\n' +
      '📈 Winners: [top ad name] at Xx ROAS\n' +
      '⚠️ Action: [one-line recommendation]\n' +
      '━━━━━━━━━━━━━━━"\n' +
      'Keep it to 4 lines max. No fluff. Just numbers and one action item. ' +
      'GEO CHECK (weekly, run on Mondays only): Use WebSearch to search for the brand\'s product category ' +
      '(e.g., "best streetwear brands", "best [vertical] [product]"). Check if the brand appears in AI-generated snippets ' +
      'or top results. Score: appeared in X/5 searches. Save to memory.md: `## GEO Score\n0407|3/5|"best streetwear" yes|"affordable hoodies" no`. ' +
      'If score drops vs last week, flag in briefing.' },
    { spell: 'weekly-digest', cron: '0 9 * * 1', name: 'Weekly Digest', desc: 'Monday strategy + benchmarks', prompt:
      'Pull 7-day performance. Compare to previous week AND Wisdom collective benchmarks. ' +
      'List: revenue, spend, MER trend, top 3 ads by ROAS, worst 3 killed, IVT test results (which variable won this week). ' +
      'Read seasonal.json for next week timing strategy. ' +
      'One strategic recommendation: what to test next week based on data.' },
    { spell: 'seo-blog', cron: '0 9 * * 2,4', name: 'SEO Blog Writer', desc: 'Publish posts Tue + Thu', prompt:
      'Run seo-keywords for trending topic. Write 600-word SEO post. Generate featured image. Publish to Shopify via blog-post. Report: title, keyword, URL.' },
    { spell: 'competitor-scan', cron: '0 9 * * 5', name: 'Competitor Watch', desc: 'Friday intel report', prompt:
      'Use competitor-scan for Meta Ad Library. Report: new ads this week, common hooks, themes, and one tactical counter-strategy. ' +
      'Compare their hook styles to Wisdom data — are they using what works or lagging? ' +
      'For each competitor ad found, save a screenshot or description to assets/brands/<brand>/competitor-swipes/ with metadata. ' +
      'Create/update swipes.json: [{"file":"competitor1.jpg","brand":"CompetitorName","hook":"ugc","platform":"meta","date":"2026-04-07","daysRunning":14}]. ' +
      'These appear in the Archive Swipes tab for the user to pair with their own creatives.' },
    { spell: 'email-flows', cron: '0 9 * * 3', name: 'Email Flows', desc: 'Build + optimize automations', prompt:
      'Run email-audit. Missing critical flows (welcome, abandoned cart, post-purchase, win-back)? Create them. ' +
      'Check open/click rates. Suggest subject line improvements based on top-performing hooks from Wisdom data. Report: flows active, created, top/bottom.' },
  ];

  // Merge active + templates into one list, collapse after 5
  const allRows = [];

  templateData.forEach(t => {
    if (activeIds.has(`merlin-${t.spell}`)) return;
    const row = document.createElement('div');
    row.className = 'spell-row spell-row-template';
    row.innerHTML = `
      <span class="spell-dot dot-pending"></span>
      <div class="spell-info">
        <div class="spell-name">${escapeHtml(t.name)}</div>
        <div class="spell-meta">${escapeHtml(t.desc)}</div>
      </div>
    `;
    row.addEventListener('click', () => activateSpell(t, row));
    allRows.push(row);
  });

  // Add "Create custom spell" row at the end
  const customRow = document.createElement('div');
  customRow.className = 'spell-row spell-row-template';
  customRow.innerHTML = `
    <span class="spell-dot" style="background:var(--accent);opacity:.5"></span>
    <div class="spell-info">
      <div class="spell-name">+ Custom spell</div>
      <div class="spell-meta">Create your own automation</div>
    </div>
  `;
  customRow.addEventListener('click', () => {
    document.getElementById('magic-panel').classList.add('hidden');
    addUserBubble('I want to create a custom scheduled task');
    showTypingIndicator();
    turnStartTime = Date.now();
    turnTokens = 0;
    sessionActive = true;
    startTickingTimer();
    merlin.sendMessage('I want to create a custom scheduled task. Ask me what I want to automate, what schedule I want, then create it using mcp__scheduled-tasks__create_scheduled_task.');
  });
  allRows.push(customRow);

  // Collapse: show first 5, hide rest behind "Show more"
  const totalInList = list.children.length; // active spells already added
  const visibleLimit = Math.max(0, 5 - totalInList); // how many template slots remain

  allRows.forEach((row, i) => {
    if (i >= visibleLimit) row.classList.add('spell-collapsed');
    list.appendChild(row);
  });

  if (allRows.length > visibleLimit && visibleLimit < allRows.length) {
    const hiddenCount = allRows.length - visibleLimit;
    const showMore = document.createElement('div');
    showMore.className = 'spell-show-more';
    showMore.textContent = `Show ${hiddenCount} more`;
    showMore.addEventListener('click', (e) => {
      e.stopPropagation();
      if (showMore.dataset.expanded === 'true') {
        // Collapse back
        allRows.forEach((row, i) => {
          if (i >= visibleLimit) row.classList.add('spell-collapsed');
        });
        showMore.textContent = `Show ${hiddenCount} more`;
        showMore.dataset.expanded = 'false';
      } else {
        // Expand
        list.querySelectorAll('.spell-collapsed').forEach(r => r.classList.remove('spell-collapsed'));
        showMore.textContent = 'Show less';
        showMore.dataset.expanded = 'true';
      }
    });
    list.appendChild(showMore);
  }
}

function buildSpellRow(spell, isActive) {
  const row = document.createElement('div');
  row.className = 'spell-row';
  row.dataset.id = spell.id;

  const dot = document.createElement('span');
  let dotClass = 'dot-pending';
  if (spell.enabled) {
    if (spell.consecutiveFailures >= 2) dotClass = 'dot-error';
    else if (spell.consecutiveFailures === 1) dotClass = 'dot-warning';
    else dotClass = 'dot-active';
  }
  dot.className = `spell-dot ${dotClass}`;
  if (spell.lastSummary && spell.lastStatus === 'failed') {
    dot.title = `Last failure: ${spell.lastSummary}`;
  } else if (spell.lastRun) {
    dot.title = `Last run: ${new Date(spell.lastRun).toLocaleString()} — ${spell.lastStatus || 'success'}`;
  }

  const info = document.createElement('div');
  info.className = 'spell-info';

  const nameRow = document.createElement('div');
  nameRow.className = 'spell-name';
  nameRow.textContent = spell.description || spell.name;

  const meta = document.createElement('div');
  meta.className = 'spell-meta';
  const parts = [];
  if (spell.cron) parts.push(formatCron(spell.cron));
  if (spell.lastRun) parts.push(`Last: ${formatTimeAgo(spell.lastRun)}`);
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

  // Show retry button for failed spells
  if (spell.consecutiveFailures >= 2 && spell.enabled) {
    const retry = document.createElement('button');
    retry.className = 'spell-retry';
    retry.textContent = 'Retry';
    retry.title = spell.lastSummary || 'Tap to retry now';
    retry.onclick = (e) => {
      e.stopPropagation();
      retry.textContent = '...';
      retry.disabled = true;
      // Reset failure count and trigger a run
      merlin.updateSpellMeta(spell.id, { consecutiveFailures: 0, lastStatus: 'running' });
      merlin.sendSilent(`Run the scheduled task "${spell.id}" now. It has been failing — diagnose and fix if possible.`);
      setTimeout(loadSpells, 2000);
    };
    row.appendChild(dot);
    row.appendChild(info);
    row.appendChild(retry);
    row.appendChild(toggle);
  } else {
    row.appendChild(dot);
    row.appendChild(info);
    row.appendChild(toggle);
  }
  return row;
}

function activateSpell(template, row) {
  // Optimistic: show creating state
  row.querySelector('.spell-dot').className = 'spell-dot dot-creating';
  row.querySelector('.spell-meta').textContent = 'Setting up...';
  row.style.pointerEvents = 'none';

  const spellBrand = document.getElementById('brand-select')?.value || '';
  merlin.createSpell(`merlin-${template.spell}`, template.cron, template.name, template.prompt, spellBrand).then(result => {
    if (result.success) {
      row.querySelector('.spell-dot').className = 'spell-dot dot-active';
      row.querySelector('.spell-meta').textContent = 'Active ✓';
      setTimeout(() => loadSpells(), 2000);

      // First-run confirmation: ask user if they want to run immediately
      showFirstRunPrompt(template, spellBrand);
    } else {
      row.querySelector('.spell-dot').className = 'spell-dot dot-error';
      row.querySelector('.spell-meta').textContent = `Failed — ${result.error || 'tap to retry'}`;
      row.style.pointerEvents = '';
      console.warn('[spell] Creation failed:', result.error);
    }
  }).catch(err => {
    row.querySelector('.spell-dot').className = 'spell-dot dot-error';
    row.querySelector('.spell-meta').textContent = 'Error — tap to retry';
    row.style.pointerEvents = '';
    console.error('[spell] Creation error:', err);
  });
}

// First-run: prompt user to run the spell immediately after activation
function showFirstRunPrompt(template, brand) {
  // Close the sidebar so the chat is visible
  document.getElementById('magic-panel').classList.add('hidden');

  // Build a confirmation card in chat
  const card = document.createElement('div');
  card.className = 'message assistant';
  const brandLabel = brand ? ` for ${brand}` : '';
  card.innerHTML = `
    <div class="bubble" style="border:1px solid var(--accent-dim);padding:16px">
      <strong>${escapeHtml(template.name)}</strong> is now scheduled${escapeHtml(brandLabel)}.<br>
      <span style="color:var(--text-dim);font-size:13px">Want to run it now so you can see the results?</span>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn-primary first-run-yes" style="flex:1;padding:8px 0">Run now</button>
        <button class="btn-secondary first-run-no" style="flex:1;padding:8px 0">I'll wait for the schedule</button>
      </div>
    </div>
  `;
  document.getElementById('chat').appendChild(card);
  card.scrollIntoView({ behavior: 'smooth' });

  card.querySelector('.first-run-yes').addEventListener('click', () => {
    // Replace buttons with "Running..." state
    card.querySelector('.bubble div:last-child').innerHTML = '<span style="color:var(--accent)">Running now...</span>';

    // Send the spell prompt as a chat message so user sees it execute live
    const firstRunPrompt = `This is the FIRST RUN of "${template.name}"${brandLabel}. The user just activated this automation and wants to see it in action.\n\n` +
      `IMPORTANT — First run rules:\n` +
      `1. Use the best quality settings available\n` +
      `2. Show your work: narrate each step as you do it\n` +
      `3. Present results visually — show images inline, show metrics in a clear summary\n` +
      `4. End with: what you did, what to expect next time, and when the next scheduled run is\n\n` +
      `Now execute: ${template.prompt}`;

    addUserBubble(`Run "${template.name}" now`);
    showTypingIndicator();
    turnStartTime = Date.now();
    turnTokens = 0;
    sessionActive = true;
    startTickingTimer();
    merlin.sendMessage(firstRunPrompt);
  });

  card.querySelector('.first-run-no').addEventListener('click', () => {
    // Replace with confirmation
    const cronDesc = describeCron(template.cron);
    card.querySelector('.bubble div:last-child').innerHTML =
      `<span style="color:var(--text-dim);font-size:13px">Got it. Next run: ${escapeHtml(cronDesc)}</span>`;
  });
}

// Human-readable cron description
function describeCron(cron) {
  if (!cron) return 'on schedule';
  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;
  const [min, hour, , , dow] = parts;
  const h = parseInt(hour);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const time = `${h12}:${min.padStart(2, '0')} ${ampm}`;
  const days = { '1-5': 'Weekdays', '0,6': 'Weekends', '*': 'Daily', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday', '4': 'Thursday', '5': 'Friday', '6': 'Saturday', '0': 'Sunday', '2,4': 'Tue + Thu' };
  return `${days[dow] || dow} at ${time}`;
}

// Real-time spell updates
merlin.onSpellActivity(() => {
  const panel = document.getElementById('magic-panel');
  if (panel && !panel.classList.contains('hidden')) setTimeout(loadSpells, 1000);
});
merlin.onSpellCompleted(({ taskId, status, summary, timestamp }) => {
  // Config already updated by main.js — just refresh UI
  const panel = document.getElementById('magic-panel');
  if (panel && !panel.classList.contains('hidden')) loadSpells();

  // Toast notification
  const name = (taskId || '').replace('merlin-', '').replace(/-/g, ' ');
  // Only toast on failures — success is shown by the green dot
  if (status === 'failed' || status === 'error') {
    showSpellToast(`⚠ ${name} failed`, summary, 'error');
  }
});

// Spell toast with stacking
let _toastCount = 0;
function showSpellToast(title, detail, type) {
  const offset = _toastCount * 56;
  _toastCount++;
  const toast = document.createElement('div');
  toast.className = `spell-toast spell-toast-${type}`;
  toast.style.bottom = `${80 + offset}px`;
  toast.innerHTML = `<strong>${escapeHtml(title)}</strong>`;
  if (detail) toast.innerHTML += `<br><span style="font-size:11px;opacity:.7">${escapeHtml(detail).slice(0, 80)}</span>`;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => { toast.remove(); _toastCount = Math.max(0, _toastCount - 1); }, 300);
  }, 5000);
}

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

// ── Status Label (persistent, debounced, no layout shift) ───
let _statusDebounce = null;
let _currentStatusLabel = '';

function setStatusLabel(label) {
  if (label === _currentStatusLabel) return; // no-op if same
  _currentStatusLabel = label;
  if (_statusDebounce) clearTimeout(_statusDebounce);
  _statusDebounce = setTimeout(() => {
    const status = document.getElementById('chat-status');
    const existing = status.querySelector('.chat-status-label');
    if (existing) {
      existing.textContent = label;
    } else {
      status.innerHTML = `<div class="chat-status-row"><span class="status-spinner">✦</span> <span class="chat-status-label">${escapeHtml(label)}</span></div>`;
    }
    _statusDebounce = null;
  }, 300); // 300ms debounce — prevents rapid flicker
}

// Reusable context menu
function showContextMenu(e, items) {
  document.querySelectorAll('.merlin-context-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'merlin-context-menu';
  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'context-menu-item';
    el.textContent = item.label;
    if (item.danger) el.style.color = '#ef4444';
    el.addEventListener('click', () => { menu.remove(); item.action(); });
    menu.appendChild(el);
  });
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  document.body.appendChild(menu);
  const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function closeAgencyOverlay() {
  const o = document.getElementById('agency-overlay');
  if (o) o.remove();
}

function clearStatusLabel() {
  if (_statusDebounce) { clearTimeout(_statusDebounce); _statusDebounce = null; }
  _currentStatusLabel = '';
  document.getElementById('chat-status').innerHTML = '';
}

// ── Typing Indicator ────────────────────────────────────────
function showTypingIndicator() {
  // Only set if nothing else is already showing
  if (!document.getElementById('chat-status').innerHTML) {
    setStatusLabel('Thinking');
  }
  // Auto-clear after 2 minutes to prevent stuck status
  if (typingStuckTimeout) clearTimeout(typingStuckTimeout);
  typingStuckTimeout = setTimeout(() => {
    clearStatusLabel();
    typingStuckTimeout = null;
  }, 120000);
}

function removeTypingIndicator() {
  if (typingStuckTimeout) { clearTimeout(typingStuckTimeout); typingStuckTimeout = null; }
  // Don't clear status — let tool status take over. Only clear on session end.
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
  _lastUserMessage = text;
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

let _lastUserMessage = '';

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  // Escape to stop generation
  if (e.key === 'Escape' && (isStreaming || sessionActive)) {
    e.preventDefault();
    merlin.stopGeneration();
    finalizeBubble();
    removeTypingIndicator();
    stopTickingTimer();
    sessionActive = false;
    isStreaming = false;
    setInputDisabled(false);
    input.focus();
  }
  // Up arrow in empty input to recall last message
  if (e.key === 'ArrowUp' && input.value === '' && _lastUserMessage) {
    e.preventDefault();
    input.value = _lastUserMessage;
    autoResize();
    // Put cursor at end
    input.selectionStart = input.selectionEnd = input.value.length;
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
  lbImg.dataset.file = img.src.replace('merlin://', '');
  lb.appendChild(lbImg);
  document.body.appendChild(lb);
  const escHandler = (ev) => { if (ev.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', escHandler); } };
  lb.addEventListener('click', (ev) => { if (ev.target === lb) { lb.remove(); document.removeEventListener('keydown', escHandler); } });
  document.addEventListener('keydown', escHandler);
});

// ── Copy Toast ──────────────────────────────────────────────
function showCopyToast(text) {
  const toast = document.createElement('div');
  toast.className = 'copy-toast';
  toast.textContent = text;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 1500);
}

// ── Media Context Menu (right-click: copy, save, open folder, delete) ──
let _ctxMenu = null;

function closeCtxMenu() {
  if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
}

// Single persistent listeners — no accumulation
document.addEventListener('click', (e) => {
  if (_ctxMenu && !_ctxMenu.contains(e.target)) closeCtxMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _ctxMenu) closeCtxMenu();
});

document.addEventListener('contextmenu', (e) => {
  // Skip if this is a Live tab ad card (has its own context menu)
  if (e.target.closest('.archive-card') && document.querySelector('.archive-filter[data-filter="live"].active')) {
    return; // Let the Live tab's own contextmenu handler handle it
  }

  const media = e.target.closest('.video-wrap')
    || e.target.closest('img[src^="merlin://"]')
    || e.target.closest('video[src^="merlin://"]')
    || e.target.closest('.archive-preview img, .archive-preview video')
    || e.target.closest('.lightbox img')
    || e.target.closest('.archive-card');
  if (!media) { closeCtxMenu(); return; }
  e.preventDefault();
  closeCtxMenu();

  const mediaEl = media.matches('img, video') ? media
    : media.querySelector('img[src^="merlin://"], video[src^="merlin://"]');
  const archiveCard = media.closest('.archive-card');
  const src = media.dataset?.file || mediaEl?.dataset?.file || mediaEl?.src?.replace('merlin://', '') || '';
  const filePath = src;
  const folderPath = filePath ? filePath.split('/').slice(0, -1).join('/') : (archiveCard?.dataset?.folder || '');
  const isVideo = mediaEl?.tagName === 'VIDEO'
    || media.closest('.video-wrap')
    || archiveCard?.dataset?.type === 'video'
    || archiveCard?.querySelector('.badge-video');

  let menuItems = '';
  if (!isVideo && filePath) menuItems += '<button data-action="copy">Copy Image</button>';
  if (filePath) menuItems += '<button data-action="save">Save As...</button>';
  if (folderPath) menuItems += '<button data-action="folder">Open Folder</button>';
  if (folderPath) menuItems += '<div class="img-context-divider"></div><button data-action="delete" class="img-context-danger">Delete</button>';
  if (!menuItems) return;

  _ctxMenu = document.createElement('div');
  _ctxMenu.className = 'img-context-menu';
  _ctxMenu.innerHTML = menuItems;
  _ctxMenu.style.left = e.clientX + 'px';
  _ctxMenu.style.top = e.clientY + 'px';
  document.body.appendChild(_ctxMenu);

  const rect = _ctxMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) _ctxMenu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) _ctxMenu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  _ctxMenu.addEventListener('click', async (ev) => {
    const action = ev.target.dataset.action;
    if (!action) return;
    if (action === 'copy') {
      const result = await merlin.copyImage(filePath);
      closeCtxMenu();
      showCopyToast(result?.success ? 'Copied!' : 'Copy failed');
    } else if (action === 'save') {
      const a = document.createElement('a');
      a.href = mediaEl?.src || `merlin://${filePath}`;
      a.download = filePath.split('/').pop();
      a.click();
      closeCtxMenu();
    } else if (action === 'folder') {
      merlin.openFolder(folderPath);
      closeCtxMenu();
    } else if (action === 'delete') {
      const result = await merlin.deleteFile(folderPath);
      closeCtxMenu();
      if (result?.success) {
        showCopyToast('Deleted');
        const card = media.closest('.archive-card');
        if (card) { card.style.opacity = '0'; setTimeout(() => card.remove(), 300); }
        const preview = media.closest('.archive-preview');
        if (preview) { preview.remove(); document.getElementById('archive-panel').classList.remove('hidden'); loadArchive(); }
      } else {
        showCopyToast('Delete failed');
      }
    }
  });
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
    const tipText = el.getAttribute('data-tip');
    tip.innerHTML = escapeHtml(tipText).replace(/\n/g, '<br>');
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

// ── Performance Status Bar (always visible) ─────────────────
// ── Perf bar state machine ─────────────────────────────────
const perfState = {
  currentBrand: '',
  currentPeriod: 7,
  cache: {},    // { [brand]: { [days]: summaryData } }
};

function renderPerfBar(perf) {
  const text = document.getElementById('perf-text');
  if (!perf || (!perf.revenue && !perf.spend)) {
    text.innerHTML = 'No data yet — connect an ad platform to start tracking';
    return;
  }
  const rev = perf.revenue > 0 ? `<strong>${fmtMoney(perf.revenue)}</strong> revenue` : '';
  const spend = perf.spend > 0 ? `${fmtMoney(perf.spend)} spent` : '';
  const mer = perf.mer > 0 ? `<strong>${perf.mer.toFixed(1)}x</strong> MER` : '';
  const parts = [rev, spend, mer].filter(Boolean).join(' · ');

  let trendHtml = '';
  if (perf.trend !== null && perf.trend !== undefined) {
    const cls = perf.trend >= 0 ? 'perf-trend-up' : 'perf-trend-down';
    const arrow = perf.trend >= 0 ? '▲' : '▼';
    trendHtml = ` · <span class="${cls}">${arrow} ${Math.abs(perf.trend)}%</span>`;
  }

  let budgetHtml = '';
  if (perf.dailyBudget > 0) {
    budgetHtml = ` · <span id="budget-indicator" class="budget-indicator">Daily Budget: $${perf.dailyBudget}/day</span>`;
  }

  let updatedHtml = '';
  if (perf.generatedAt) {
    const ago = Date.now() - new Date(perf.generatedAt).getTime();
    const mins = Math.floor(ago / 60000);
    let agoStr;
    if (mins < 1) agoStr = 'just now';
    else if (mins < 60) agoStr = `${mins}m ago`;
    else if (mins < 1440) agoStr = `${Math.floor(mins / 60)}h ago`;
    else agoStr = `${Math.floor(mins / 1440)}d ago`;
    updatedHtml = ` · <span class="perf-updated">Updated ${agoStr}</span>`;
  }

  text.innerHTML = parts + trendHtml + budgetHtml + updatedHtml;

  // Platform spend hover dropdown
  if (perf.platformBreakdown && perf.platformBreakdown.length > 0) {
    setTimeout(() => {
      const indicator = document.getElementById('budget-indicator');
      if (!indicator) return;
      indicator.addEventListener('mouseenter', () => {
        let existing = document.getElementById('platform-dropdown');
        if (existing) existing.remove();
        const dd = document.createElement('div');
        dd.id = 'platform-dropdown';
        dd.className = 'platform-dropdown';
        dd.innerHTML = `<div class="platform-dd-header">Spend by Platform</div>${perf.platformBreakdown.map(p =>
          `<div class="platform-dd-row"><span class="platform-badge platform-${p.name.split(' ')[0].toLowerCase()}">${p.name}</span><span>$${Math.round(p.spend)}</span><span>${p.roas > 0 ? p.roas.toFixed(1) + 'x' : '—'}</span></div>`
        ).join('')}`;
        const rect = indicator.getBoundingClientRect();
        dd.style.top = (rect.bottom + 4) + 'px';
        dd.style.left = Math.max(4, rect.left - 40) + 'px';
        document.body.appendChild(dd);
        indicator.addEventListener('mouseleave', () => {
          setTimeout(() => { const el = document.getElementById('platform-dropdown'); if (el && !el.matches(':hover')) el.remove(); }, 200);
        }, { once: true });
        dd.addEventListener('mouseleave', () => dd.remove());
      });
    }, 100);
  }
}

function renderPerfBarSkeleton() {
  document.getElementById('perf-text').innerHTML = '<span class="perf-shimmer"></span>';
}

async function fetchPerfData(days, brand) {
  const perf = await merlin.getPerfSummary(days, brand);
  if (perf && (perf.revenue || perf.spend)) {
    if (!perfState.cache[brand]) perfState.cache[brand] = {};
    perfState.cache[brand][days] = perf;
  }
  return perf;
}

async function loadPerfBar(days, brandOverride) {
  const brand = brandOverride !== undefined ? brandOverride : (document.getElementById('brand-select')?.value || '');
  perfState.currentPeriod = days;
  perfState.currentBrand = brand;

  // Instant render from cache if available
  const cached = perfState.cache[brand]?.[days];
  if (cached) {
    renderPerfBar(cached);
  }

  // Fetch fresh data in background
  try {
    const perf = await fetchPerfData(days, brand);
    // Race guard: only render if still on the same brand+period
    if (perfState.currentBrand !== brand || perfState.currentPeriod !== days) return;
    if (perf && (perf.revenue || perf.spend)) {
      renderPerfBar(perf);
    } else if (!cached) {
      // No cached data AND no fresh data — show empty state or skeleton
      renderPerfBar(null);
    }
    // If cached exists but fresh is null, keep showing cached (don't blank)
  } catch {
    if (!cached) renderPerfBar(null);
  }
}

// Listen for push invalidation from main process
if (merlin.onPerfDataChanged) {
  merlin.onPerfDataChanged(({ brand }) => {
    // Invalidate renderer cache for this brand
    delete perfState.cache[brand || ''];
    // Re-fetch if currently viewing this brand
    if (perfState.currentBrand === (brand || '')) {
      loadPerfBar(perfState.currentPeriod, perfState.currentBrand);
    }
  });
}

// Load on startup — preload everything so sidebar opens instantly
loadBrands().then(() => { loadConnections(); loadSpells(); });
loadPerfBar(7);

// Background perf refresh — pull fresh data on launch + every 4 hours
(async function refreshPerfOnLaunch() {
  try {
    const lastUpdate = await merlin.getPerfUpdated();
    const stale = !lastUpdate || (Date.now() - new Date(lastUpdate).getTime() > 4 * 60 * 60 * 1000);
    if (stale) {
      const activeBrand = document.getElementById('brand-select')?.value || '';
      await merlin.refreshPerf(activeBrand);
      const activePeriod = document.querySelector('.perf-period-btn.active')?.dataset.days || '7';
      loadPerfBar(parseInt(activePeriod));
    }
  } catch {}
})();
setInterval(async () => {
  try {
    const activeBrand = document.getElementById('brand-select')?.value || '';
    await merlin.refreshPerf(activeBrand);
    const activePeriod = document.querySelector('.perf-period-btn.active')?.dataset.days || '7';
    loadPerfBar(parseInt(activePeriod));
  } catch {}
}, 4 * 60 * 60 * 1000); // every 4 hours

// Period selector buttons
document.querySelectorAll('.perf-period-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't trigger the bar click (revenue overlay)
    document.querySelectorAll('.perf-period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadPerfBar(parseInt(btn.dataset.days));
  });
});

// Agency Report
document.getElementById('agency-report-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  // Toggle — if already open, just close
  if (document.getElementById('agency-overlay')) { closeAgencyOverlay(); return; }
  // Close other panels
  document.getElementById('magic-panel').classList.add('hidden');
  document.getElementById('archive-panel').classList.add('hidden');
  document.getElementById('wisdom-overlay').classList.add('hidden');

  // Get brands
  let brands = [];
  try { brands = await merlin.getBrands(); } catch {}

  const period = document.querySelector('.perf-period-btn.active')?.dataset.days || '7';
  const periodLabel = { '7': 'Last 7 Days', '30': 'Last 30 Days', '90': 'Last 90 Days', '365': 'Last 12 Months' }[period] || `Last ${period} Days`;

  // Remove any existing overlay first (prevents stacking)
  closeAgencyOverlay();

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.id = 'agency-overlay';
  overlay.innerHTML = `
    <div class="setup-card" style="max-width:420px;text-align:left">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <h2 style="font-size:18px;font-weight:700;color:var(--text);margin:0">Agency Report</h2>
        <button class="agency-x magic-close">&times;</button>
      </div>
      <p style="font-size:12px;color:var(--text-dim);margin-bottom:16px">${periodLabel} — select brands to include</p>

      <div id="agency-brands" style="margin-bottom:16px">
        ${brands.map(b => `
          <label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;font-size:13px;color:var(--text-muted)">
            <input type="checkbox" checked data-brand="${b.name.replace(/"/g, '&quot;')}" style="accent-color:var(--accent)">
            ${escapeHtml(b.displayName || b.name)}
          </label>
        `).join('')}
        ${brands.length === 0 ? '<p style="color:var(--text-dim);font-size:12px">No brands found</p>' : ''}
      </div>

      <button class="agency-gen btn-primary" style="width:100%">Generate Report</button>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => closeAgencyOverlay();

  // Close: X button, backdrop click, Escape key — all paths clean up the escape handler
  const escHandler = (e) => { if (e.key === 'Escape') cleanup(); };
  const cleanup = () => { close(); document.removeEventListener('keydown', escHandler); };
  overlay.querySelector('.agency-x').addEventListener('click', cleanup);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
  document.addEventListener('keydown', escHandler);

  overlay.querySelector('.agency-gen').addEventListener('click', async () => {
    const selectedBrands = [...overlay.querySelectorAll('#agency-brands input:checked')].map(cb => cb.dataset.brand);
    if (selectedBrands.length === 0) return;

    const btn = overlay.querySelector('.agency-gen');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    try {
      const perf = await merlin.getPerfSummary(parseInt(period));
      const reportHtml = buildAgencyReport(selectedBrands, perf, periodLabel, brands);
      const reportWindow = window.open('', 'Agency Report', 'width=800,height=1000');
      if (reportWindow) {
        reportWindow.document.write(reportHtml);
        reportWindow.document.close();
      }
    } catch (err) {
      console.error('[report]', err);
    }
    close();
  });
});

function buildAgencyReport(selectedBrands, perf, periodLabel, allBrands) {
  const revenue = perf?.revenue || 0;
  const spend = perf?.spend || 0;
  const mer = perf?.mer || 0;

  let brandPages = selectedBrands.map(brandName => {
    const brand = allBrands.find(b => b.name === brandName) || { name: brandName, displayName: brandName };
    const displayName = brand.displayName || brand.name.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    return `
      <div class="page-break">
        <h2>${escapeHtml(displayName)}</h2>
        <p class="subtitle">${escapeHtml(periodLabel)}</p>
        <div class="kpi-grid">
          <div class="kpi"><span class="kpi-value">--</span><span class="kpi-label">Revenue</span></div>
          <div class="kpi"><span class="kpi-value">--</span><span class="kpi-label">Ad Spend</span></div>
          <div class="kpi"><span class="kpi-value">--</span><span class="kpi-label">ROAS</span></div>
          <div class="kpi"><span class="kpi-value">--</span><span class="kpi-label">New Customers</span></div>
        </div>
        <p class="note">Detailed per-brand metrics require running "dashboard" for this brand.</p>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html><head><title>Performance Report — ${periodLabel}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; padding: 40px; max-width: 800px; margin: 0 auto; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
  h2 { font-size: 20px; font-weight: 700; margin-bottom: 4px; border-bottom: 2px solid #e5e5e5; padding-bottom: 8px; }
  .subtitle { font-size: 13px; color: #888; margin-bottom: 24px; }
  .summary { background: #f8f8f8; border-radius: 12px; padding: 24px; margin-bottom: 32px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 20px 0; }
  .kpi { text-align: center; }
  .kpi-value { display: block; font-size: 24px; font-weight: 700; color: #1a1a1a; }
  .kpi-label { display: block; font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: .05em; margin-top: 4px; }
  .page-break { page-break-before: always; margin-top: 40px; }
  .page-break:first-of-type { page-break-before: auto; }
  .note { font-size: 12px; color: #aaa; margin-top: 16px; font-style: italic; }
  .footer { margin-top: 40px; text-align: center; font-size: 11px; color: #ccc; }
  @media print { .no-print { display: none; } body { padding: 20px; } }
</style></head><body>
  <div class="no-print" style="margin-bottom:20px;text-align:right">
    <button onclick="window.print()" style="padding:8px 16px;border-radius:6px;border:1px solid #ddd;background:#fff;cursor:pointer;font-size:13px">Print / Save as PDF</button>
  </div>

  <h1>Performance Report</h1>
  <p class="subtitle">${periodLabel} — Generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>

  <div class="summary">
    <h2 style="border:none;padding:0;margin-bottom:16px">Summary — All Brands</h2>
    <div class="kpi-grid">
      <div class="kpi"><span class="kpi-value">$${revenue.toLocaleString()}</span><span class="kpi-label">Revenue</span></div>
      <div class="kpi"><span class="kpi-value">$${Math.round(spend).toLocaleString()}</span><span class="kpi-label">Total Spend</span></div>
      <div class="kpi"><span class="kpi-value">${mer > 0 ? mer.toFixed(1) + 'x' : '--'}</span><span class="kpi-label">MER</span></div>
      <div class="kpi"><span class="kpi-value">${selectedBrands.length}</span><span class="kpi-label">Active Brands</span></div>
    </div>
  </div>

  ${brandPages}

  <div class="footer">Generated ${new Date().toISOString().slice(0, 10)}</div>
</body></html>`;
}

// Click bar to open revenue tracker (load brands first if needed)
document.getElementById('perf-bar').addEventListener('click', async (e) => {
  if (e.target.closest('.perf-period-group') || e.target.closest('#agency-report-btn') || e.target.closest('#brand-select') || e.target.id === 'brand-select') return;
  const overlay = document.getElementById('stats-overlay');
  if (!overlay) return;

  // Ensure we have a brand loaded
  let brand = document.getElementById('brand-select').value;
  if (!brand) {
    try {
      const brands = await merlin.getBrands();
      if (brands && brands.length > 0) brand = brands[0].name;
    } catch {}
  }

  if (brand) {
    const cleanBrand = brand.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    document.getElementById('stats-brand-name').textContent = cleanBrand;
  }

  overlay.classList.remove('hidden');
  // Use perf state cache (same source as perf bar) — unified data
  try {
    const brand = document.getElementById('brand-select')?.value || '';
    const days = perfState.currentPeriod || 7;
    let perf = perfState.cache[brand]?.[days];
    if (!perf) perf = await fetchPerfData(days, brand);
    if (perf) {
      const rev = perf.revenue > 0 ? perf.revenue : 0;
      const spend = perf.spend > 0 ? perf.spend : 0;
      const mer = perf.mer > 0 ? perf.mer : (spend > 0 ? rev / spend : 0);

      document.getElementById('stats-revenue').textContent = rev > 0 ? fmtMoney(rev) : '--';
      document.getElementById('stats-spend').textContent = spend > 0 ? fmtMoney(spend) : '--';
      document.getElementById('stats-roas').textContent = mer > 0 ? mer.toFixed(1) + 'x return' : '--';
      const periodLabels = { 1: 'Today', 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last 12 months' };
      document.getElementById('stats-period').textContent = periodLabels[days] || `Last ${days} days`;
      updateStatsBarAndStory(rev, spend, mer);
    } else {
      // Fallback to stats cache for legacy compat
      const cache = await merlin.getStatsCache();
      populateStatsCard(cache);
    }
  } catch {}
});

// ── Activity Feed (full panel view, toggled via Activity button) ──
let _archiveView = 'grid'; // 'grid' or 'activity'

function showArchiveView() {
  _archiveView = 'grid';
  document.getElementById('activity-btn').textContent = 'Activity';
  document.querySelector('.archive-filters').style.display = '';
  document.getElementById('archive-grid').style.display = '';
  document.getElementById('archive-empty').style.display = 'none';
  const feed = document.getElementById('activity-feed-section');
  if (feed) feed.remove();
  loadArchive();
}

function showActivityView() {
  _archiveView = 'activity';
  document.getElementById('activity-btn').textContent = 'Gallery';
  document.querySelector('.archive-filters').style.display = 'none';
  document.getElementById('archive-grid').style.display = 'none';
  document.getElementById('archive-empty').style.display = 'none';
  document.getElementById('archive-loading').style.display = 'none';
  loadActivityFeed();
}

document.getElementById('activity-btn').addEventListener('click', () => {
  if (_archiveView === 'grid') showActivityView();
  else showArchiveView();
});

async function loadActivityFeed() {
  const panel = document.getElementById('archive-panel');
  const existing = document.getElementById('activity-feed-section');
  if (existing) existing.remove();

  try {
    const activityBrand = document.getElementById('brand-select')?.value || null;
    let items = await merlin.getActivityFeed(activityBrand, 50);
    if (!Array.isArray(items)) items = [];

    const section = document.createElement('div');
    section.id = 'activity-feed-section';
    section.className = 'activity-section';

    if (!items || items.length === 0) {
      section.innerHTML = '<div class="activity-section-label">Activity</div><div style="color:var(--text-dim);padding:20px 0;text-align:center;font-size:12px"><div style="font-size:24px;opacity:.4;margin-bottom:6px">✦</div>No activity yet<br><span style="opacity:.7">Actions appear here as you create ads and run campaigns</span></div>';
      const grid = document.getElementById('archive-grid');
      grid.parentNode.insertBefore(section, grid);
      return;
    }

    let lastDate = '';
    items.forEach(item => {
      const d = item.ts ? new Date(item.ts) : new Date();
      const dateStr = formatArchiveDate(d);
      if (dateStr !== lastDate) {
        const header = document.createElement('div');
        header.className = 'activity-section-label';
        header.textContent = dateStr;
        section.appendChild(header);
        lastDate = dateStr;
      }

      const div = document.createElement('div');
      div.className = 'activity-item';

      const validTypes = ['create', 'optimize', 'publish', 'report', 'error'];
      const safeType = validTypes.includes(item.type) ? item.type : 'create';
      const dotClass = `activity-dot activity-dot-${safeType}`;
      const action = item.action || '';
      const detail = item.detail || '';
      const product = item.product ? ` · ${item.product}` : '';

      let desc = '';
      switch (action) {
        case 'video': desc = `New video${product}`; break;
        case 'image': desc = `New ad image${product}`; break;
        case 'blog': desc = `Blog post published`; break;
        case 'kill': desc = `Ad paused${detail ? ' — ' + detail : ''}`; break;
        case 'scale': desc = `Winner scaled${detail ? ' — ' + detail : ''}`; break;
        case 'meta-push': desc = `Ad live on Meta`; break;
        case 'dashboard': desc = `Performance check`; break;
        default:
          // Clean up technical strings for non-technical users
          if (action.startsWith('spell-')) {
            const spellName = action.replace('spell-', '').replace(/-/g, ' ');
            desc = detail?.includes('failed') ? `⚠ ${spellName} failed` : `✓ ${spellName} completed`;
          } else {
            desc = action.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          }
      }

      const time = item.ts ? new Date(item.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
      div.innerHTML = `<span class="${dotClass}"></span><span>${escapeHtml(desc)}</span><span class="activity-time">${time}</span>`;
      section.appendChild(div);
    });

    const grid = document.getElementById('archive-grid');
    grid.parentNode.insertBefore(section, grid);
  } catch (err) { console.warn('[activity]', err); }
}

// ── Archive Panel ──────────────────────────────────────────
document.getElementById('archive-btn').addEventListener('click', () => {
  document.getElementById('magic-panel').classList.add('hidden');
  document.getElementById('wisdom-overlay').classList.add('hidden');
  closeAgencyOverlay();
  const panel = document.getElementById('archive-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) { showArchiveView(); }
});
document.getElementById('archive-close').addEventListener('click', () => {
  const panel = document.getElementById('archive-panel');
  panel.classList.remove('expanded');
  document.getElementById('archive-expand').textContent = '←';
  panel.classList.add('hidden');
});

// Expand/collapse archive to full width
document.getElementById('archive-expand').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = document.getElementById('archive-panel');
  const btn = document.getElementById('archive-expand');
  panel.classList.toggle('expanded');
  btn.textContent = panel.classList.contains('expanded') ? '→' : '←';
});

// Archive filter buttons
document.querySelectorAll('.archive-filter').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.archive-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadArchive();
  });
});

// Archive search (debounced)
let _archiveSearchTimeout;
document.getElementById('archive-search').addEventListener('input', () => {
  clearTimeout(_archiveSearchTimeout);
  _archiveSearchTimeout = setTimeout(() => loadArchive(), 300);
});

async function loadArchive() {
  const grid = document.getElementById('archive-grid');
  const empty = document.getElementById('archive-empty');
  const loading = document.getElementById('archive-loading');

  loading.style.display = 'block';
  grid.innerHTML = '';
  empty.style.display = 'none';

  const typeFilter = document.querySelector('.archive-filter.active')?.dataset.filter || 'all';
  const search = document.getElementById('archive-search').value.trim();

  // Clear multi-select on tab switch
  window._archiveSelected = [];
  const existingMerge = document.getElementById('merge-btn');
  if (existingMerge) existingMerge.style.display = 'none';

  if (typeFilter === 'swipes') {
    // Show competitor swipe files
    const brand = document.getElementById('brand-select')?.value || '';
    loading.style.display = 'none';

    let swipes = [];
    try {
      swipes = await merlin.getSwipes(brand);
    } catch {}

    if (!swipes || swipes.length === 0) {
      empty.querySelector('p').textContent = 'No swipes yet';
      empty.querySelector('.archive-empty-sub').textContent = 'Run a competitor scan to collect ad swipes';
      empty.style.display = 'block';
      return;
    }

    swipes.forEach(swipe => {
      const card = document.createElement('div');
      card.className = 'archive-card swipe-card';
      card.dataset.path = swipe.path || '';
      card.dataset.id = swipe.id || '';
      const thumb = swipe.thumbnail ? `<img src="merlin://${swipe.thumbnail}" alt="" loading="lazy">` : '<div class="archive-card-placeholder">✦</div>';
      card.innerHTML = `
        ${thumb}
        <div class="archive-card-info">
          <div class="archive-card-title">${escapeHtml(swipe.brand || 'Competitor')}</div>
          <div class="archive-card-meta">${escapeHtml(swipe.hook || '')} ${swipe.platform ? '· ' + escapeHtml(swipe.platform) : ''}</div>
        </div>
      `;
      // Click to select for pairing
      card.addEventListener('click', () => toggleArchiveSelect(card, swipe));
      grid.appendChild(card);
    });

    // Show merge button if selections exist
    updateMergeButton();
    return;
  }

  if (typeFilter === 'live') {
    // Show live ads instead of archive items
    const brand = document.getElementById('brand-select')?.value;
    const activeBrand = brand || null;
    const ads = await merlin.getLiveAds(activeBrand);
    loading.style.display = 'none';

    if (!ads || ads.length === 0) {
      empty.querySelector('p').textContent = 'No live ads';
      empty.querySelector('.archive-empty-sub').textContent = 'Publish an ad to see it here';
      empty.style.display = 'block';
      return;
    }

    ads.forEach(ad => {
      const card = document.createElement('div');
      card.className = 'archive-card';

      const statusClass = ad.status === 'live' ? 'status-live' : ad.status === 'paused' ? 'status-paused' : 'status-pending';
      const statusText = ad.status === 'live' ? '● Live' : ad.status === 'paused' ? '○ Paused' : '◐ Pending';
      const roasText = ad.lastRoas ? `${ad.lastRoas.toFixed(1)}x` : 'Collecting...';
      const budgetText = ad.budget ? `$${ad.budget}/day` : '';

      if (ad.creativePath) {
        card.innerHTML = `<img class="archive-card-thumb" src="merlin://${ad.creativePath}" alt="" loading="lazy">`;
      } else {
        card.innerHTML = `<div class="archive-card-thumb" style="display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--text-dim)">📢</div>`;
      }

      card.innerHTML += `
        <div class="archive-card-info">
          <div class="archive-card-title">${escapeHtml(ad.product || ad.platform || 'Ad')}</div>
          <div class="archive-card-meta">
            <span class="archive-card-badge ${statusClass}">${statusText}</span>
            <span>${budgetText}</span>
          </div>
          <div class="archive-card-meta" style="margin-top:1px">
            <span class="platform-badge platform-${(ad.platform || '').toLowerCase()}">${escapeHtml(ad.platform || '')}</span>
            <span>${roasText}</span>
          </div>
        </div>`;

      // Left click: preview the creative
      card.addEventListener('click', () => {
        if (ad.creativePath) {
          openArchivePreview({ type: 'image', thumbnail: ad.creativePath, folder: '', files: [] });
        }
      });
      card.style.cursor = 'pointer';

      // Right click: context menu with Pause option
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        // Remove any existing context menu
        document.querySelectorAll('.merlin-context-menu').forEach(m => m.remove());

        const menu = document.createElement('div');
        menu.className = 'merlin-context-menu';
        // Clamp to viewport
        requestAnimationFrame(() => {
          const mw = menu.offsetWidth || 180;
          const mh = menu.offsetHeight || 200;
          menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
          menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';
        });
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';

        if (ad.status === 'live') {
          const pauseItem = document.createElement('div');
          pauseItem.className = 'context-menu-item';
          pauseItem.textContent = '⏸ Pause this ad';
          pauseItem.addEventListener('click', () => {
            menu.remove();
            document.getElementById('archive-panel').classList.add('hidden');
            addUserBubble(`Pause ${ad.product || 'ad'} on ${ad.platform}`);
            showTypingIndicator();
            turnStartTime = Date.now();
            turnTokens = 0;
            sessionActive = true;
            startTickingTimer();
            merlin.sendMessage(`Pause the ad "${ad.product || 'ad'}" on ${ad.platform} (Ad ID: ${ad.adId}). Use meta-kill with adId "${ad.adId}".`);
          });
          menu.appendChild(pauseItem);
        }

        if (ad.status === 'paused') {
          const resumeItem = document.createElement('div');
          resumeItem.className = 'context-menu-item';
          resumeItem.textContent = '▶ Resume this ad';
          resumeItem.addEventListener('click', () => {
            menu.remove();
            document.getElementById('archive-panel').classList.add('hidden');
            addUserBubble(`Resume ${ad.product || 'ad'} on ${ad.platform}`);
            showTypingIndicator();
            turnStartTime = Date.now();
            turnTokens = 0;
            sessionActive = true;
            startTickingTimer();
            merlin.sendMessage(`Resume the paused ad "${ad.product || 'ad'}" on ${ad.platform} (Ad ID: ${ad.adId}). Re-enable it with the same budget.`);
          });
          menu.appendChild(resumeItem);
        }

        // Cross-platform duplicate submenu
        if (ad.status === 'live') {
          const platforms = ['Meta', 'TikTok', 'Google', 'Amazon'].filter(p => p.toLowerCase() !== ad.platform?.toLowerCase());
          const copyItem = document.createElement('div');
          copyItem.className = 'context-menu-item';
          copyItem.textContent = '🚀 Copy to...';
          copyItem.style.position = 'relative';
          copyItem.addEventListener('mouseenter', () => {
            let sub = copyItem.querySelector('.context-submenu');
            if (sub) return;
            sub = document.createElement('div');
            sub.className = 'context-submenu';
            // Position after appending so we can measure
            const positionSub = () => {
              const r = copyItem.getBoundingClientRect();
              const sw = sub.offsetWidth || 140;
              const sh = sub.offsetHeight || 200;
              let left = r.right + 4;
              if (left + sw > window.innerWidth) left = r.left - sw - 4;
              let top = r.top;
              if (top + sh > window.innerHeight) top = window.innerHeight - sh - 4;
              sub.style.left = Math.max(4, left) + 'px';
              sub.style.top = Math.max(4, top) + 'px';
            };
            // "All" option at top
            const allOpt = document.createElement('div');
            allOpt.className = 'context-menu-item';
            allOpt.textContent = 'All platforms';
            allOpt.addEventListener('click', () => {
              menu.remove();
              addUserBubble(`Copy "${ad.product}" ad to all platforms`);
              showTypingIndicator(); turnStartTime = Date.now(); sessionActive = true; startTickingTimer();
              merlin.sendMessage(`Duplicate the winning ad "${ad.product}" (Ad ID: ${ad.adId}, platform: ${ad.platform}) to ALL other connected platforms. Use the same creative and budget. Report what was created.`);
            });
            sub.appendChild(allOpt);
            platforms.forEach(p => {
              const opt = document.createElement('div');
              opt.className = 'context-menu-item';
              opt.textContent = p;
              opt.addEventListener('click', () => {
                menu.remove();
                addUserBubble(`Copy "${ad.product}" ad to ${p}`);
                showTypingIndicator(); turnStartTime = Date.now(); sessionActive = true; startTickingTimer();
                merlin.sendMessage(`Duplicate the winning ad "${ad.product}" (Ad ID: ${ad.adId}, platform: ${ad.platform}) to ${p}. Use the same creative and budget.`);
              });
              sub.appendChild(opt);
            });
            document.body.appendChild(sub);
            requestAnimationFrame(positionSub);
          });
          menu.appendChild(copyItem);
        }

        const detailsItem = document.createElement('div');
        detailsItem.className = 'context-menu-item';
        detailsItem.textContent = '📋 View details';
        detailsItem.addEventListener('click', () => {
          menu.remove();
          if (ad.creativePath) openArchivePreview({ type: 'image', thumbnail: ad.creativePath, folder: '', files: [] });
        });
        menu.appendChild(detailsItem);

        document.body.appendChild(menu);
        // Close on click outside (or Escape)
        setTimeout(() => {
          const dismiss = (ev) => {
            if (!menu.contains(ev.target) && !ev.target.closest('.context-submenu')) {
              menu.remove();
              document.querySelectorAll('.context-submenu').forEach(s => s.remove());
              document.removeEventListener('click', dismiss);
              document.removeEventListener('contextmenu', dismiss);
              document.removeEventListener('keydown', escDismiss);
            }
          };
          const escDismiss = (ev) => {
            if (ev.key === 'Escape') {
              menu.remove();
              document.removeEventListener('click', dismiss);
              document.removeEventListener('contextmenu', dismiss);
              document.removeEventListener('keydown', escDismiss);
            }
          };
          document.addEventListener('click', dismiss);
          document.addEventListener('contextmenu', dismiss);
          document.addEventListener('keydown', escDismiss);
        }, 10);
      });

      grid.appendChild(card);
    });
    return;
  }

  try {
    const items = await merlin.getArchiveItems({
      type: typeFilter === 'all' ? '' : typeFilter,
      search,
    });
    loading.style.display = 'none';

    if (!items || items.length === 0) {
      empty.style.display = 'block';
      return;
    }

    let lastDate = '';
    items.forEach(item => {
      const d = new Date(item.timestamp);
      const dateStr = formatArchiveDate(d);
      if (dateStr !== lastDate) {
        const header = document.createElement('div');
        header.className = 'archive-date-header';
        header.textContent = dateStr;
        grid.appendChild(header);
        lastDate = dateStr;
      }
      grid.appendChild(createArchiveCard(item));
    });
  } catch (err) {
    console.warn('[archive]', err);
    loading.style.display = 'none';
    empty.style.display = 'block';
  }
}

function formatArchiveDate(d) {
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekAgo = new Date(todayStart); weekAgo.setDate(weekAgo.getDate() - 6);

  if (d >= todayStart) return 'Today';
  if (d >= yesterdayStart) return 'Yesterday';
  if (d >= weekAgo) return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function createArchiveCard(item) {
  const card = document.createElement('div');
  card.className = 'archive-card';
  card.dataset.folder = item.folder || '';
  card.dataset.type = item.type || 'image';

  const isVideo = item.type === 'video';
  const badgeClass = isVideo ? 'badge-video' : 'badge-image';
  const badgeText = isVideo ? 'Video' : 'Image';
  // Human-readable title: prefer product > brand > model > friendly type
  let title = '';
  if (item.product) title = item.product.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  else if (item.brand) title = item.brand.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  else if (item.model) title = item.model.split('/').pop().split('(')[0].trim();
  else title = isVideo ? 'Video Ad' : 'Ad Image';
  const time = new Date(item.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  if (item.thumbnail) {
    card.innerHTML = `<img class="archive-card-thumb" src="merlin://${item.thumbnail}" alt="" loading="lazy">`;
  } else {
    card.innerHTML = `<div class="archive-card-thumb" style="display:flex;align-items:center;justify-content:center;font-size:24px;color:var(--text-dim)">${isVideo ? '▶' : '✦'}</div>`;
  }
  card.innerHTML += `
    <div class="archive-card-info">
      <div class="archive-card-title">${escapeHtml(title)}</div>
      <div class="archive-card-meta">
        <span class="archive-card-badge ${badgeClass}">${badgeText}</span>
        <span>${time}</span>
      </div>
    </div>`;

  card.addEventListener('click', () => openArchivePreview(item));
  return card;
}

// ── Multi-select + Merge for creative pairing ──────────────
function toggleArchiveSelect(card, item) {
  const sel = window._archiveSelected;
  const idx = sel.findIndex(s => s.card === card);
  if (idx >= 0) {
    sel.splice(idx, 1);
    card.classList.remove('archive-selected');
  } else {
    if (sel.length >= 2) {
      // Deselect the oldest
      sel[0].card.classList.remove('archive-selected');
      sel.shift();
    }
    sel.push({ card, item });
    card.classList.add('archive-selected');
  }
  updateMergeButton();
}

function updateMergeButton() {
  let btn = document.getElementById('merge-btn');
  const sel = window._archiveSelected || [];
  if (sel.length === 2) {
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'merge-btn';
      btn.className = 'btn-primary merge-btn';
      btn.addEventListener('click', mergeCreatives);
      const grid = document.getElementById('archive-grid');
      grid.parentNode.insertBefore(btn, grid);
    }
    btn.textContent = '✦ Generate in my style';
    btn.style.display = '';
  } else if (btn) {
    btn.style.display = 'none';
  }
}

function mergeCreatives() {
  const sel = window._archiveSelected || [];
  if (sel.length !== 2) return;

  const [a, b] = sel.map(s => s.item);
  // Determine which is competitor vs own (swipe-card = competitor)
  const competitor = a.brand ? a : b;
  const own = a.brand ? b : a;

  // Clear selection
  sel.forEach(s => s.card.classList.remove('archive-selected'));
  window._archiveSelected = [];
  updateMergeButton();

  // Close archive and send to chat
  document.getElementById('archive-panel').classList.add('hidden');

  const competitorDesc = competitor.hook ? `${competitor.brand} (${competitor.hook} hook, ${competitor.platform})` : (competitor.brand || 'competitor ad');
  const ownDesc = own.product || own.title || 'my creative';
  const competitorPath = competitor.thumbnail || competitor.path || '';
  const ownPath = own.thumbnail || own.folder || '';

  addUserBubble(`Merge: ${competitorDesc} + ${ownDesc}`);
  showTypingIndicator();
  turnStartTime = Date.now();
  turnTokens = 0;
  sessionActive = true;
  startTickingTimer();

  merlin.sendMessage(
    `I want to create a new ad inspired by a competitor's creative but in MY brand's style.\n\n` +
    `COMPETITOR REFERENCE: ${competitorPath ? competitorPath : competitorDesc}\n` +
    `- What to capture: their composition, hook style, layout, and what makes it work\n\n` +
    `MY BRAND REFERENCE: ${ownPath ? ownPath : ownDesc}\n` +
    `- Use MY brand colors, MY product, MY brand voice from brand.md\n\n` +
    `Generate a new ad creative that captures the competitor's winning pattern but looks 100% like our brand. ` +
    `Show the result inline. Score it against Wisdom data before suggesting we publish.`
  );
}

// Also enable multi-select on regular archive cards (All/Images/Videos tabs)
function enableArchiveMultiSelect() {
  document.querySelectorAll('.archive-card:not(.swipe-card)').forEach(card => {
    card.addEventListener('click', (e) => {
      // Only multi-select if Swipes tab has a selection (pairing mode)
      if ((window._archiveSelected || []).some(s => s.item.brand)) {
        e.stopPropagation();
        e.preventDefault();
        const item = card._archiveItem || {};
        toggleArchiveSelect(card, item);
      }
    });
  });
}

function openArchivePreview(item) {
  // Don't close the sidebar — just overlay on top

  const overlay = document.createElement('div');
  overlay.className = 'archive-preview';

  const isVideo = item.type === 'video';
  let mediaPath = '';

  if (isVideo) {
    const best = (item.files || []).find(f => f === 'captioned.mp4') || (item.files || []).find(f => f === 'final.mp4');
    if (best) mediaPath = `merlin://${item.folder}/${best}`;
  } else if (item.thumbnail) {
    // Use the same file as the thumbnail — single source of truth
    mediaPath = `merlin://${item.thumbnail}`;
  }

  // Build performance stats panel from metadata tags
  const tags = item.tags || {};
  let statsHtml = '';
  if (tags.verdict || tags.roas || tags.hook) {
    const verdictColor = tags.verdict === 'winner' ? '#22c55e' : tags.verdict === 'kill' ? '#ef4444' : 'var(--text-dim)';
    statsHtml = `<div class="preview-stats">
      ${tags.verdict ? `<div class="preview-stat"><span class="preview-stat-label">Verdict</span><span style="color:${verdictColor};font-weight:700;text-transform:uppercase">${escapeHtml(tags.verdict)}</span></div>` : ''}
      ${tags.roas ? `<div class="preview-stat"><span class="preview-stat-label">ROAS</span><span style="color:#22c55e;font-weight:700">${tags.roas}x</span></div>` : ''}
      ${tags.hook ? `<div class="preview-stat"><span class="preview-stat-label">Hook</span><span>${escapeHtml(tags.hook)}</span></div>` : ''}
      ${tags.scene ? `<div class="preview-stat"><span class="preview-stat-label">Style</span><span>${escapeHtml(tags.scene)}</span></div>` : ''}
      ${tags.platform ? `<div class="preview-stat"><span class="preview-stat-label">Platform</span><span>${escapeHtml(tags.platform)}</span></div>` : ''}
      ${tags.daysRunning ? `<div class="preview-stat"><span class="preview-stat-label">Running</span><span>${tags.daysRunning} days</span></div>` : ''}
    </div>`;
  }

  if (isVideo && mediaPath) {
    overlay.innerHTML = `<div class="preview-layout"><video src="${mediaPath}" controls autoplay playsinline></video>${statsHtml}</div>`;
  } else if (mediaPath) {
    overlay.innerHTML = `<div class="preview-layout"><img src="${mediaPath}" alt="" data-folder="${escapeHtml(item.folder)}" data-file="${escapeHtml(mediaPath.replace('merlin://', ''))}">${statsHtml}</div>`;
  } else {
    overlay.innerHTML = `<div style="color:var(--text-muted);font-size:14px">No preview available</div>`;
  }

  function closePreview() {
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
  }

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'archive-preview-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', closePreview);
  overlay.appendChild(closeBtn);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePreview(); });
  const escHandler = (e) => { if (e.key === 'Escape') closePreview(); };
  document.addEventListener('keydown', escHandler);
  document.body.appendChild(overlay);
}

// Close archive ONLY when clicking into the chat area (not overlays, previews, menus, perf bar)
document.addEventListener('click', (e) => {
  const panel = document.getElementById('archive-panel');
  const btn = document.getElementById('archive-btn');
  if (panel && !panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== btn && !e.target.closest('#archive-btn')) {
    // Only close if clicking in chat or input area — nowhere else
    if (!e.target.closest('#chat') && !e.target.closest('#input-bar')) return;
    panel.classList.add('hidden');
  }
});

// ── Trial Expired ──────────────────────────────────────────
merlin.onTrialExpired(() => {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.id = 'trial-overlay';
  overlay.innerHTML = `
    <div class="setup-card">
      <div class="setup-mascot">✦</div>
      <h1>Trial Ended</h1>
      <p class="setup-sub">Your free trial has expired</p>
      <p class="setup-explain">Subscribe to keep using Merlin. Your brands, products, and creative learnings are all saved and waiting.</p>
      <button class="btn-primary" id="trial-subscribe-btn">Subscribe</button>
      <button class="btn-secondary" id="trial-key-btn">I have a license key</button>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('trial-subscribe-btn').addEventListener('click', () => merlin.openSubscribe());
  document.getElementById('trial-key-btn').addEventListener('click', () => {
    overlay.remove();
    addUserBubble('I have a license key');
    merlin.sendMessage('I have a license key to activate');
  });
});

// ── Onboarding Progress Bar ──────────────────────────────────
async function updateProgressBar() {
  const bar = document.getElementById('progress-bar');
  if (!bar) return;
  try {
    const state = await merlin.loadState().catch(() => ({}));
    if (state.progressDismissed) { bar.classList.add('hidden'); return; }

    const brands = await merlin.getBrands().catch(() => null);
    const connected = await merlin.getConnectedPlatforms().catch(() => null);
    const spells = await merlin.listSpells().catch(() => null);

    // If data hasn't loaded yet, don't hide — wait for next call
    if (brands === null) return;

    const salesPlatforms = ['shopify']; // expand later: custom API, game platforms, etc.
    const hasSales = connected && connected.some(c => salesPlatforms.includes(c.platform));
    const hasAds = connected && connected.some(c => !salesPlatforms.includes(c.platform) && !['fal','elevenlabs','heygen','slack','discord'].includes(c.platform));

    const steps = [
      { key: 'brand', done: brands && brands.length > 0 },
      { key: 'products', done: brands && brands.some(b => b.productCount > 0) },
      { key: 'sales', done: hasSales },
      { key: 'platform', done: hasAds },
      { key: 'automation', done: spells && spells.length > 0 },
    ];
    const doneCount = steps.filter(s => s.done).length;
    const totalSteps = steps.length;

    // Hide only when ALL done
    if (doneCount === totalSteps) { bar.classList.add('hidden'); return; }
    // Show for any partial progress (including 0 — guides new users)
    bar.classList.remove('hidden');
    document.getElementById('progress-fill').style.width = `${(doneCount / totalSteps) * 100}%`;

    steps.forEach(s => {
      const el = bar.querySelector(`.progress-step[data-step="${s.key}"]`);
      if (el) el.className = `progress-step ${s.done ? 'done' : 'active'}`;
    });

    document.getElementById('progress-next').textContent = '';
  } catch {}
}

document.getElementById('progress-close')?.addEventListener('click', () => {
  document.getElementById('progress-bar').classList.add('hidden');
  merlin.saveState({ progressDismissed: true });
});

// ── Init (after ToS check) ─────────────────────────────────
(async function checkToS() {
  const accepted = await merlin.checkTosAccepted();
  if (accepted) {
    document.getElementById('tos-overlay').classList.add('hidden');
    init();
  } else {
    document.getElementById('tos-overlay').classList.remove('hidden');
    const cb = document.getElementById('tos-checkbox');
    const btn = document.getElementById('tos-accept-btn');
    cb.addEventListener('change', () => { btn.disabled = !cb.checked; });
    btn.addEventListener('click', async () => {
      await merlin.acceptTos();
      document.getElementById('tos-overlay').style.animation = 'fadeOut .3s ease forwards';
      setTimeout(() => {
        document.getElementById('tos-overlay').classList.add('hidden');
        document.getElementById('tos-overlay').style.animation = '';
        init();
      }, 300);
    });
  }
})();
