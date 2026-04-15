// ── State ────────────────────────────────────────────────────
let currentBubble = null;
let isStreaming = false;
let textBuffer = '';
let rafPending = false;

const messages = document.getElementById('messages');
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
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
// Pass `body` for plain text (escaped) or `bodyHTML` for trusted HTML.
// Never pass user input through bodyHTML — it bypasses escaping.
// Modal queue prevents stacking — nested calls are deferred until the current modal closes.
let _modalQueue = [];
let _modalActive = false;
function showModal({ title, body, bodyHTML, inputPlaceholder, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  if (_modalActive) {
    _modalQueue.push({ title, body, bodyHTML, inputPlaceholder, confirmLabel, cancelLabel, onConfirm, onCancel });
    return;
  }
  _modalActive = true;
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
    _modalActive = false;
    if (_modalQueue.length > 0) setTimeout(() => showModal(_modalQueue.shift()), 100);
  }

  function escHandler(e) {
    if (e.key === 'Escape') { cleanup(); }
  }
  document.addEventListener('keydown', escHandler);

  confirmBtn.onclick = async () => {
    const value = inputPlaceholder !== undefined ? inputEl.value.trim() : true;
    // Run onConfirm BEFORE cleanup — validation may call showModalError()
    // which needs the modal visible. Only cleanup if onConfirm doesn't throw.
    if (onConfirm) {
      try {
        await onConfirm(value);
      } catch {
        return; // validation failed — modal stays open with error visible
      }
    }
    cleanup();
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
    const trialEl = document.getElementById('trial-text');
    const ctaEl = document.querySelector('.subscribe-cta');
    if (_trialExpired) {
      trialEl.textContent = 'Expired';
      ctaEl.textContent = 'Upgrade Now';
      btn.style.borderColor = 'rgba(239,68,68,.4)';
      btn.style.animation = 'none'; // stop any pulsing
    } else if (days <= 2) {
      const dayText = `${days}D Left`;
      trialEl.textContent = bonus > 0 ? `${dayText} (+${bonus})` : dayText;
      ctaEl.textContent = 'Get Pro';
      btn.style.borderColor = 'rgba(251,191,36,.4)';
    } else {
      const dayText = `${days}D Left`;
      trialEl.textContent = bonus > 0 ? `${dayText} (+${bonus})` : dayText;
    }
  }
})();

document.getElementById('subscribe-btn').addEventListener('click', async () => {
  // P1-7 recovery hook: before opening the subscribe modal, ask the
  // server whether this machine already has an active license. This
  // rescues users who paid on another device, whose local file was
  // wiped, or whose activation poller timed out before it detected
  // payment completion. If the server says we're active, refreshCheck
  // sends `subscription-activated` and the UI flips to Pro.
  let sub;
  if (merlin.checkSubscriptionStatus) {
    try { sub = await merlin.checkSubscriptionStatus(); }
    catch { sub = await merlin.getSubscription(); }
  } else {
    sub = await merlin.getSubscription();
  }
  if (sub?.subscribed) {
    // Server confirmed we're already Pro — reflect in UI and open billing.
    document.getElementById('trial-text').textContent = '✦ Pro';
    document.querySelector('.subscribe-cta').textContent = 'Manage';
    document.getElementById('subscribe-btn').classList.add('subscribed');
    _trialExpired = false;
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

// Auto-activate when Stripe payment completes (polled from main.js) OR
// when the launch-time reconcile restores Pro from the server.
merlin.onSubscriptionActivated(() => {
  // Flip the header button to "Manage Pro" state instead of hiding it —
  // the user still needs access to the billing portal.
  document.getElementById('trial-text').textContent = '✦ Pro';
  document.querySelector('.subscribe-cta').textContent = 'Manage';
  const btn = document.getElementById('subscribe-btn');
  btn.classList.remove('hidden-sub');
  btn.classList.add('subscribed');
  btn.style.borderColor = '';
  btn.style.animation = '';
  _trialExpired = false;
  const bubble = addClaudeBubble();
  textBuffer = '✦ Welcome to Merlin Pro — all features unlocked.';
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

  // Show chat immediately with a welcome message — no blank screen, no setup overlay
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

  // Don't start the SDK session here. The user sees the chat immediately and can
  // explore the UI freely. On their first send, main.js kicks off startSession() —
  // if Claude isn't connected, the SDK failure is translated into a friendly
  // "Please connect your Claude account to continue" bubble in the chat.
  // No polling, no setup overlay, no hard blockers.

  // When SDK sends first real message, DON'T remove the welcome —
  // let the conversation continue naturally below it
  window._welcomeShown = true;
}


// Setup overlay was deleted — no setup event handlers needed.
// Claude auth is now checked on message send (see main.js send-message handler).

// ── Message Rendering ───────────────────────────────────────
function addUserBubble(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.style.whiteSpace = 'pre-wrap';
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
      if (currentBubble && textBuffer.length !== lastRenderedLength) {
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

// ── Offline Detection ────────────────────────────────────────
const offlineBanner = document.getElementById('offline-banner');
function updateOnlineStatus() {
  if (navigator.onLine) {
    offlineBanner.classList.add('hidden');
  } else {
    offlineBanner.classList.remove('hidden');
  }
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

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
        // Don't show tip while a response is streaming — it would corrupt currentBubble/isStreaming state
        if (isStreaming || currentBubble) return;
        const sparkle = document.getElementById('magic-btn');
        sparkle.classList.add('sparkle-hint');
        // Build tip bubble directly — do NOT use addClaudeBubble()/finalizeBubble()
        // which are stateful and would corrupt any concurrent streaming response
        const wrapper = document.createElement('div');
        wrapper.className = 'msg msg-claude';
        const avatar = document.createElement('div');
        avatar.className = 'msg-avatar';
        avatar.textContent = '✦';
        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        bubble.innerHTML = renderMarkdown('✦ **Tip:** Your connections, spells, and brand settings live behind the ✦ button up top.');
        wrapper.appendChild(avatar);
        wrapper.appendChild(bubble);
        messages.appendChild(wrapper);
        scrollToBottom();
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
  // Show feedback quickly (300ms) so the user never feels abandoned.
  // Previous 2000ms delay created a dead zone where nothing appeared to happen.
  typingTimeout = setTimeout(() => {
    if (sessionActive && !currentBubble && !isStreaming) {
      showTypingIndicator();
    }
  }, 300);
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

// ── Markdown Renderer (marked.js) ────────────────────────────
// Configure marked with custom renderers for Merlin-specific features
const markedRenderer = new marked.Renderer();

// Custom image renderer — local paths use merlin:// protocol
markedRenderer.image = function({ href, title, text }) {
  const alt = text || title || 'Image';
  if (href && href.includes('/') && !href.startsWith('http') && !href.startsWith('data:')) {
    return `<img src="merlin://${href}" alt="${alt}" loading="lazy">`;
  }
  return `<img src="${href}" alt="${alt}" loading="lazy">`;
};

// Custom link renderer — external links open in new tab, local file links use merlin://
markedRenderer.link = function({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens);
  if (/^(https?:\/\/|mailto:)/i.test(href)) {
    return `<a href="${href}" target="_blank" rel="noopener noreferrer"${title ? ` title="${title}"` : ''}>${text}</a>`;
  }
  if (href && href.includes('/') && /\.(jpg|jpeg|png|gif|webp|pdf|mp4)$/i.test(href)) {
    return `<a href="merlin://${href}" target="_blank">${text}</a>`;
  }
  return `<a href="${href}"${title ? ` title="${title}"` : ''}>${text}</a>`;
};

// Custom code renderer — add copy button + language label for fenced blocks
markedRenderer.code = function({ text, lang }) {
  const langLabel = lang || 'text';
  const encoded = encodeURIComponent(text.replace(/\n$/, ''));
  return `<div class="code-block"><div class="code-block-header"><span>${langLabel}</span><button class="copy-btn" data-copy="${encoded}">Copy</button></div><pre><code class="lang-${langLabel}">${escapeHtml(text)}</code></pre></div>`;
};

// Custom inline code renderer — add copy button for long/actionable content
markedRenderer.codespan = function({ text }) {
  const decoded = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const isActionable = decoded.length > 20 || /^(https?:|\/|npm |curl |pip |brew |apt |git |cd |mkdir |xattr )/.test(decoded);
  if (isActionable) {
    return `<code>${text}</code><button class="copy-btn inline-copy" data-copy="${encodeURIComponent(decoded)}">⧉</button>`;
  }
  return `<code>${text}</code>`;
};

marked.setOptions({
  renderer: markedRenderer,
  breaks: true,
  gfm: true,
});

function renderMarkdown(text) {
  if (!text) return '';

  // Strip mascot prefix if Claude prepends it
  text = text.replace(/^\s*✦\s*/g, '');

  // Extract HTML artifacts (```html blocks → sandboxed iframes) before marked processes them
  const artifacts = [];
  text = text.replace(/```html\n([\s\S]*?)```/g, (_, code) => {
    artifacts.push(code);
    return `%%ARTIFACT_${artifacts.length - 1}%%`;
  });

  // Parse markdown with marked, then sanitize to prevent XSS
  let html = typeof DOMPurify !== 'undefined'
    ? DOMPurify.sanitize(marked.parse(text), { ADD_TAGS: ['video'], ADD_ATTR: ['data-path', 'data-file', 'loading', 'controls', 'playsinline', 'preload'], ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|merlin|data):)/i })
    : marked.parse(text);

  // Normalize Windows backslash paths to forward slashes
  html = html.replace(/([a-zA-Z0-9_\-\.]+)\\([a-zA-Z0-9_\-\.\\]+\.(?:jpg|jpeg|png|gif|webp|mp4|webm|mov))/gi, (m, a, b) => `${a}/${b.replace(/\\/g, '/')}`);

  // Bare image file paths (not already in <img> tags) → inline <img>
  html = html.replace(/(?<!src="|href="|">)(?:\.\/)?([a-zA-Z0-9_\-\.\/]+\.(?:jpg|jpeg|png|gif|webp))(?![^<]*<\/(?:img|a|code))/gi, (match, p1) => {
    if (p1.includes('/')) return `<img src="merlin://${p1}" alt="Image" loading="lazy">`;
    return match;
  });

  // Bare video file paths → inline <video>
  html = html.replace(/(?<!src="|href="|">)(?:\.\/)?([a-zA-Z0-9_\-\.\/]+\.(?:mp4|webm|mov))(?![^<]*<\/(?:video|a|code))/gi, (match, p1) => {
    if (p1.includes('/')) return `<div class="video-wrap" data-file="${p1}"><video src="merlin://${p1}" controls playsinline preload="metadata" style="max-width:100%;border-radius:10px"></video></div>`;
    return match;
  });

  // Restore HTML artifacts as sandboxed iframes with restrictive CSP
  // No network access (connect-src/fetch/XHR blocked), no sub-frames, no form submission.
  // Scripts allowed for interactive demos but sandboxed — cannot reach parent or network.
  const artifactCSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; img-src data: blob:; font-src data:; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\';">';
  artifacts.forEach((code, i) => {
    const encoded = encodeURIComponent(code);
    const safeSrc = (artifactCSP + code).replace(/"/g, '&amp;quot;').replace(/'/g, '&#39;');
    html = html.replace(`%%ARTIFACT_${i}%%`,
      `<div class="artifact"><div class="code-block-header"><span>preview</span><button class="copy-btn" data-copy="${encoded}">Copy HTML</button></div><iframe sandbox="allow-scripts" srcdoc="${safeSrc}" style="width:100%;min-height:200px;border:1px solid var(--border);border-radius:0 0 8px 8px;background:#fff"></iframe></div>`
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

// Build a safe merlin:// URL from a relative path. URL-encodes each path
// segment (so filenames with spaces, quotes, angle brackets, etc. are safely
// inert inside HTML attributes) while leaving '/' as the segment delimiter.
// Use this anywhere a filename derived from disk flows into `src=` or `href=`
// — the custom merlin:// protocol handler already handles decoding.
function merlinUrl(relPath) {
  if (relPath == null) return '';
  const clean = String(relPath).replace(/^merlin:\/\//, '');
  return 'merlin://' + clean.split('/').map(encodeURIComponent).join('/');
}

// Sanitize raw errors into user-friendly messages with actionable "Try:" guidance
function friendlyError(raw, platformName) {
  if (!raw) return `Could not connect to ${platformName || 'the platform'}.\nTry: Check your internet connection and try again.`;
  const s = String(raw);
  const sl = s.toLowerCase();

  // ── Platform-specific token expiration ──
  if (sl.includes('token') && (sl.includes('expir') || sl.includes('invalid'))) {
    if (sl.includes('meta') || sl.includes('facebook')) return 'Your Meta access token has expired (they last ~60 days).\nTry: Open the ✦ Magic panel and reconnect Meta Ads.';
    if (sl.includes('tiktok')) return 'Your TikTok access token has expired.\nTry: Open the ✦ Magic panel and reconnect TikTok Ads.';
    if (sl.includes('google')) return 'Your Google Ads token has expired.\nTry: Open the ✦ Magic panel and reconnect Google Ads.';
    if (sl.includes('shopify')) return 'Your Shopify connection has expired.\nTry: Open the ✦ Magic panel and reconnect your Shopify store.';
    if (sl.includes('etsy')) return 'Your Etsy access token has expired.\nTry: Open the ✦ Magic panel and reconnect Etsy.';
    return `Your ${platformName || 'platform'} token has expired.\nTry: Reconnect the platform in the ✦ Magic panel.`;
  }

  // ── Meta-specific errors ──
  if (sl.includes('1885183') || sl.includes('development mode')) return 'Meta app is in Development Mode — ad creatives are blocked by Meta.\nTry: This requires Meta App Review approval. Contact support.';
  if (sl.includes('ad account') && sl.includes('disabled')) return 'Your Meta ad account has been disabled by Facebook.\nTry: Check your Meta Business Manager for policy violations or appeals.';

  // ── Balance / billing errors ──
  if (sl.includes('exhausted balance') || sl.includes('top up') || sl.includes('insufficient') || sl.includes('billing')) {
    const src = sl.includes('fal.ai') ? 'fal.ai' : sl.includes('elevenlabs') ? 'ElevenLabs' : sl.includes('heygen') ? 'HeyGen' : (platformName || 'API');
    return `Your ${src} balance is empty.\nTry: Add credits at ${src === 'fal.ai' ? 'fal.ai/dashboard' : src === 'ElevenLabs' ? 'elevenlabs.io/subscription' : src === 'HeyGen' ? 'heygen.com/pricing' : 'your account dashboard'}.`;
  }
  if (sl.includes('rate limit') || sl.includes('too many requests') || sl.includes('429')) return 'Too many requests — Merlin is protecting your account.\nTry: Wait 30 seconds and try again. This is normal.';
  if (sl.includes('quota') || sl.includes('exceeded')) return `${platformName || 'API'} quota exceeded.\nTry: Check your plan limits or upgrade your ${platformName || 'API'} account.`;

  // ── Auth errors ──
  if (sl.includes('401') || sl.includes('unauthorized') || sl.includes('invalid.*key') || sl.includes('invalid.*token')) return `Authorization failed for ${platformName || 'the platform'}.\nTry: Open the ✦ Magic panel and reconnect your account.`;
  if (sl.includes('403') || sl.includes('forbidden') || sl.includes('locked')) return `Access denied on ${platformName || 'the platform'}.\nTry: Check that your account is active and has the right permissions.`;

  // ── Shopify-specific ──
  if (sl.includes('shopify') && (sl.includes('404') || sl.includes('not found'))) return 'Shopify resource not found.\nTry: Check that the product/order still exists in your Shopify admin.';
  if (sl.includes('shopify') && sl.includes('throttl')) return 'Shopify is rate-limiting requests.\nTry: Wait a moment — Merlin will auto-retry.';

  // ── Network errors ──
  if (sl.includes('enoent') || (sl.includes('not found') && sl.includes('spawn'))) return 'Merlin engine not found.\nTry: Type /update to reinstall, or restart the app.';
  if (sl.includes('etimedout') || sl.includes('timeout')) return 'Connection timed out.\nTry: Check your internet connection and try again.';
  if (sl.includes('econnrefused')) return `${platformName || 'Platform'} refused the connection.\nTry: The service may be down — wait a few minutes and retry.`;
  if (sl.includes('enotfound') || sl.includes('dns')) return `Can't reach ${platformName || 'the service'}.\nTry: Check your Wi-Fi or internet connection.`;
  if (sl.includes('econnreset') || sl.includes('socket hang up')) return `Connection was interrupted.\nTry: Check your internet connection and try again.`;

  // ── Command/binary errors — never show raw paths ──
  if (s.includes('Command failed') || s.includes('.exe') || s.includes('--cmd') || s.includes('--config')) {
    return `Something went wrong running that action.\nTry: Type /update to make sure you have the latest version, then try again.`;
  }

  // ── JSON / technical errors — strip and simplify ──
  if (s.includes('{"') || s.includes('[ERROR]') || s.includes('HTTP 4') || s.includes('HTTP 5')) {
    if (sl.includes('500') || sl.includes('internal server')) return `${platformName || 'Service'} is having issues.\nTry: Wait a few minutes and try again — this is on their end.`;
    if (sl.includes('404')) return `${platformName || 'Resource'} not found.\nTry: It may have been moved or deleted. Check your ${platformName || 'platform'} dashboard.`;
    if (sl.includes('400') || sl.includes('bad request')) return `${platformName || 'Platform'} didn't accept that request.\nTry: Check that all required fields are filled in and try again.`;
    return `Something went wrong with ${platformName || 'the service'}.\nTry: Wait a moment and try again.`;
  }

  // Truncate anything still long
  if (s.length > 150) return s.slice(0, 140) + '…';
  return s;
}

// REGRESSION GUARD (2026-04-14, adversarial review #6 fix):
// humanizeUpdateError sanitizes install/update errors before they hit the UI.
// Do NOT let raw EPERM/EBUSY/ENOSPC/ENOTFOUND strings leak into the toast.
function humanizeUpdateError(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Update couldn\'t install. Try again in a moment.';
  if (/EPERM|EBUSY|EACCES/i.test(s)) return 'Merlin needs to close before updating. Save your work and try again.';
  if (/ENOSPC/i.test(s)) return 'Not enough disk space for the update. Free up some space and try again.';
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|network/i.test(s)) return 'Can\'t reach the update server. Check your internet and try again.';
  if (/checksum|hash|integrity/i.test(s)) return 'The update file looks corrupted. Try again in a moment — we\'ll re-download it.';
  if (/signature|signed/i.test(s)) return 'The update couldn\'t be verified. Try again, and if it keeps failing, reinstall from merlingotme.com.';
  return 'Update couldn\'t install. Try again in a moment.';
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
            const mimeType = (block.source.media_type || 'image/png').replace(/[^a-z0-9/+-]/gi, '');
            imgBubble.innerHTML = `<img src="data:${mimeType};base64,${block.source.data}" alt="Image" style="max-width:100%;border-radius:10px">`;
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
      // Refresh brand dropdown after each turn — Claude may have created a
      // new brand, imported products, or changed connections during this turn.
      try { loadBrands().then(() => loadConnections()); } catch {}
      // Clean up empty response bubbles (session died before producing output)
      if (currentBubble && currentBubble.textContent.trim() === '' && currentBubble.innerHTML.trim() === '') {
        const wrapper = currentBubble.closest('.msg');
        if (wrapper) wrapper.remove();
      }
      // Show stats bar like Claude Desktop
      if (turnStartTime) {
        const duration = ((Date.now() - turnStartTime) / 1000).toFixed(0);
        // Don't show stats for empty/failed responses (0 tokens = session died)
        if (turnTokens > 0 || parseInt(duration) > 2) {
          const statsDiv = document.createElement('div');
          statsDiv.className = 'turn-stats';
          let statsText = `${duration}s`;
          if (turnTokens > 0) {
            const formatted = turnTokens >= 1000 ? (turnTokens / 1000).toFixed(1) + 'K' : String(turnTokens);
            statsText += ` \u00b7 ${formatted} tokens`;
          }
          statsText += ' \u00b7 Merlin can make mistakes';
          statsDiv.textContent = statsText;
          messages.appendChild(statsDiv);
          scrollToBottom();
        }
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

merlin.onApprovalRequest(({ toolUseID, label, cost, budget }) => {
  // Clear any previous countdown from a prior approval
  if (_approvalCountdown) { clearInterval(_approvalCountdown); _approvalCountdown = null; }

  document.getElementById('approval-label').textContent = label;
  const costEl = document.getElementById('approval-cost');
  const budgetEl = document.getElementById('approval-budget');
  costEl.textContent = cost ? `Cost: ${cost}` : '';
  costEl.style.color = cost && cost.includes('⚠') ? '#ef4444' : '';
  budgetEl.innerHTML = budget || '';

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
  const savedCost = cost;
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
      budgetEl.innerHTML = '';
      // Show toast so user knows it timed out
      const bubble = addClaudeBubble();
      textBuffer = `⏱ Approval timed out for: ${label}. Ask me again if you'd like to retry.`;
      finalizeBubble();
    }
  }, 1000);

  const clearApproval = () => {
    if (_approvalCountdown) { clearInterval(_approvalCountdown); _approvalCountdown = null; }
    approval.classList.add('hidden');
    costEl.style.color = '';
    budgetEl.innerHTML = '';
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
  console.error('[SDK Error]', err);

  // ── "Not logged in" — Claude Code credentials missing ──
  // On macOS, Claude Desktop and Claude Code use DIFFERENT credential stores
  // (Desktop: "Claude Safe Storage" Keychain, Code: "Claude Code-credentials"
  // Keychain). The user signed into Desktop, but Code has never been authed.
  //
  // Fix: trigger the bundled CLI's login flow automatically. This opens the
  // user's browser for a quick OAuth redirect (they're already signed in to
  // claude.ai so it's usually instant) and creates the CLI credential entry.
  // Then retry the session.
  if (errLower.includes('not logged in') || errLower.includes('please run /login') || errLower.includes('login required')) {
    const bubble = addClaudeBubble();
    textBuffer = 'Connecting to your Claude account...\n\nA browser window will open for a quick sign-in. This only happens once.';
    finalizeBubble();
    bubble.style.borderColor = 'rgba(251,191,36,.3)';

    // Auto-trigger the login flow — opens browser for OAuth
    (async () => {
      try {
        if (merlin.triggerClaudeLogin) {
          const result = await merlin.triggerClaudeLogin();
          if (result.success) {
            // Login succeeded — retry session immediately
            bubble.textContent = 'Signed in! Starting Merlin...';
            setTimeout(() => {
              _restartAttempts = 0;
              sessionActive = true;
              merlin.startSession();
            }, 1000);
            return;
          }
        }
      } catch (e) {
        console.error('[login-trigger]', e);
      }

      // Login failed or not available — show manual buttons
      bubble.textContent = 'Sign in to your Claude account to use Merlin.\n\nClick the button below to open the sign-in page in your browser.';

      // Create both buttons before assigning onclick handlers so closures
      // reference fully-initialized variables (no TDZ issues).
      const retryBtn = document.createElement('button');
      retryBtn.textContent = 'Retry';
      retryBtn.className = 'btn-action btn-deny-style';
      retryBtn.style.cssText = 'margin-top:12px;width:auto;padding:8px 20px;font-size:13px';
      retryBtn.onclick = () => {
        _restartAttempts = 0;
        sessionActive = true;
        merlin.startSession();
      };

      const loginBtn = document.createElement('button');
      loginBtn.textContent = 'Sign In to Claude';
      loginBtn.className = 'btn-action btn-approve-style';
      loginBtn.style.cssText = 'margin-top:12px;margin-right:8px;width:auto;padding:8px 20px;font-size:13px';
      loginBtn.onclick = async () => {
        loginBtn.textContent = 'Signing in...';
        loginBtn.disabled = true;
        try {
          if (merlin.triggerClaudeLogin) {
            const result = await merlin.triggerClaudeLogin();
            if (result.success) {
              // Dismiss paste dialog if it was open
              const authDialog = document.getElementById('auth-code-dialog');
              if (authDialog) authDialog.remove();
              _restartAttempts = 0;
              sessionActive = true;
              merlin.startSession();
              return;
            }
            // Login failed — re-enable button with error
            bubble.textContent = result.error || 'Sign-in failed. Click the button to try again.';
            loginBtn.textContent = 'Sign In to Claude';
            loginBtn.disabled = false;
            bubble.appendChild(loginBtn);
            bubble.appendChild(retryBtn);
            return;
          }
        } catch {}
        // triggerClaudeLogin not available — re-enable
        loginBtn.textContent = 'Sign In to Claude';
        loginBtn.disabled = false;
      };
      bubble.appendChild(loginBtn);
      bubble.appendChild(retryBtn);
    })();
    return;
  }

  // REGRESSION GUARD (2026-04-14, adversarial review #6 fix):
  // This error path used to concat raw err strings into the chat bubble
  // (`Error: ${(err||'').slice(0,200)}`). Paying users saw things like
  // "Error: POST https://queue.fal.run/... HTTP 402: exhausted balance".
  //
  // friendlyError() (defined at line 611 above) already classifies every
  // failure mode we care about — fal.ai balance, Shopify throttling, Meta
  // token expiry, DNS, ECONNREFUSED, HTTP 4xx/5xx, Claude spawn errors, etc.
  // The SDK error path MUST route through friendlyError() before rendering.
  //
  // Why: "UX so good a 5th grader can use it" (CLAUDE.md principle). Raw
  // stack traces and platform JSON errors break that contract instantly.
  //
  // How to apply: any future error-surfacing path added to renderer.js
  // (SDK errors, tool errors, update errors, OAuth errors) MUST pipe the
  // raw string through friendlyError(raw, platformName) BEFORE it enters
  // textBuffer or innerHTML. The helper is side-effect-free and idempotent.
  // If you find yourself writing `.slice(0, N)` on a raw error, stop — use
  // friendlyError() instead. DO NOT revert to raw-error concatenation.
  let userMsg = friendlyError(err, '') || 'Something went wrong.';
  const isClaudeNotFound = errLower.includes('enoent') && (errLower.includes('spawn') || errLower.includes('node'));
  const isAuthError = errLower.includes('401') || errLower.includes('unauthorized');

  const bubble = addClaudeBubble();

  if (_restartAttempts > MAX_RESTART_ATTEMPTS) {
    let reason;
    if (isClaudeNotFound) {
      reason = 'Claude CLI is not installed. Install it from claude.ai/download, then click Retry.';
    } else if (isAuthError) {
      reason = 'Please open Claude Desktop and make sure you\'re logged in, then click Retry.';
    } else {
      reason = 'Check your internet connection and click Retry when ready.';
    }
    textBuffer = `${userMsg}\n\nMerlin tried ${MAX_RESTART_ATTEMPTS} times but couldn't connect.\n\n${reason}`;
    finalizeBubble();
    bubble.style.borderColor = 'rgba(239,68,68,.3)';

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

  const delay = Math.min(2000 * Math.pow(2, _restartAttempts - 1), 8000);
  textBuffer = `${userMsg}\n\nRetrying in ${delay / 1000}s... (attempt ${_restartAttempts}/${MAX_RESTART_ATTEMPTS})`;
  finalizeBubble();
  bubble.style.borderColor = 'rgba(239,68,68,.3)';

  setTimeout(() => {
    sessionActive = true;
    merlin.startSession();
  }, delay);
});

// ── Inline System Messages ──────────────────────────────────
// Fired by main.js via sendInlineMessage() for non-SDK chat bubbles:
// auth prompts, engine download status, etc. Completely resets the
// UI turn state so the user can immediately try again without a
// stuck typing indicator or dangling session timer.
merlin.onInlineMessage(({ text, kind }) => {
  // Clear any in-flight turn state
  if (typingTimeout) { clearTimeout(typingTimeout); typingTimeout = null; }
  removeTypingIndicator();
  stopTickingTimer();
  finalizeBubble(); // commits any streaming bubble, then resets currentBubble/textBuffer
  sessionActive = false;
  isStreaming = false;
  setInputDisabled(false);

  // Render the inline bubble
  const bubble = addClaudeBubble();
  textBuffer = String(text || '');
  finalizeBubble();

  // Style auth prompts with a subtle amber accent so the user notices
  if (kind === 'auth') {
    bubble.style.borderColor = 'rgba(251,191,36,.3)';
  }

  input.focus();
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
          // REGRESSION GUARD (2026-04-14): never show raw r.error. Users
          // saw "Install failed: EPERM: operation not permitted, open
          // 'C:\\Program Files\\Merlin\\...'" and had no idea what to do.
          document.getElementById('update-text').textContent = humanizeUpdateError(r?.error);
          document.getElementById('update-btn').textContent = 'Retry';
          document.getElementById('update-btn').disabled = false;
          dismiss.classList.remove('hidden');
        }
        // On success, the app will quit shortly — no further UI needed
      } catch (e) {
        document.getElementById('update-text').textContent = humanizeUpdateError(e.message);
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
  // REGRESSION GUARD (2026-04-14): humanize raw update errors.
  document.getElementById('update-text').textContent = humanizeUpdateError(err);
  document.getElementById('update-btn').textContent = 'Retry';
  document.getElementById('update-btn').disabled = false;
  document.getElementById('update-btn').onclick = () => {
    document.getElementById('update-btn').textContent = 'Updating...';
    document.getElementById('update-btn').disabled = true;
    merlin.applyUpdate();
  };
  document.getElementById('update-dismiss').classList.remove('hidden');
});

// ── Auth Code Paste Dialog ─────────────────────────────────
// FALLBACK path only. The happy path is: the Claude Agent SDK opens the
// browser, the user signs in, Claude redirects to http://localhost:<port>/
// callback, and the SDK's own HTTP listener catches the code without any
// manual intervention. This dialog only appears when the SDK detects the
// localhost flow failed and it has to prompt for manual paste — which we
// detect from its stdout ("paste code here if prompted").
//
// CRITICAL: the exact paste format the SDK wants is `code#state` — a code
// string, a literal `#` separator, then the state string. Confirmed by
// inspecting node_modules/@anthropic-ai/claude-agent-sdk/cli.js: it calls
// `b.split("#")` and rejects input with "Invalid code. Please make sure
// the full code was copied" if either half is missing.
//
// The paste page at https://platform.claude.com/oauth/code/success shows
// the combined `code#state` string with a "Copy Code" button. Users who
// click the button get the right format automatically. Users who partial-
// select or type fragments get the format validation below.
if (merlin.onAuthCodePrompt) {
  merlin.onAuthCodePrompt(() => {
    if (document.getElementById('auth-code-dialog')) return;

    const dialog = document.createElement('div');
    dialog.id = 'auth-code-dialog';
    dialog.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10000;background:var(--bg-deep);border:1px solid var(--accent);border-radius:16px;padding:24px 32px;max-width:460px;width:90%;box-shadow:0 16px 48px rgba(0,0,0,.6);text-align:center';
    dialog.innerHTML = `
      <div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:8px">Paste your authentication code</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:16px;line-height:1.5">Your browser should have opened a Claude page. Click the <b>Copy Code</b> button on that page and paste the full string below. It looks like <code style="background:var(--surface);padding:1px 5px;border-radius:4px">xxxxxxxx#yyyyyyyy</code> — make sure you copy the part after the <code style="background:var(--surface);padding:1px 5px;border-radius:4px">#</code> too.</div>
      <input id="auth-code-input" type="text" placeholder="Paste the full code here..." style="width:100%;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-family:var(--font);font-size:13px;outline:none;margin-bottom:12px;text-align:center" autocomplete="off" spellcheck="false">
      <div style="display:flex;gap:8px">
        <button id="auth-code-submit-btn" style="flex:1;padding:10px 24px;border-radius:10px;border:none;background:var(--accent);color:#fff;font-weight:600;font-size:14px;cursor:pointer">Submit</button>
        <button id="auth-code-cancel-btn" style="padding:10px 16px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--text-muted);font-size:14px;cursor:pointer">Cancel</button>
      </div>
    `;
    document.body.appendChild(dialog);

    const inputEl = document.getElementById('auth-code-input');
    const btn = document.getElementById('auth-code-submit-btn');
    inputEl.focus();

    function showHint(text, color) {
      let hint = document.getElementById('auth-code-hint');
      if (!hint) {
        hint = document.createElement('div');
        hint.id = 'auth-code-hint';
        hint.style.cssText = 'font-size:11px;margin-bottom:8px;line-height:1.4';
        inputEl.parentNode.insertBefore(hint, inputEl.nextSibling);
      }
      hint.style.color = color || 'var(--text-muted)';
      hint.textContent = text;
    }

    async function submit() {
      const code = inputEl.value.trim();
      if (!code) {
        showHint('Paste the full code first.', '#ef4444');
        return;
      }
      // Client-side format validation: the CLI expects `code#state`. If the
      // user only pasted one half we can tell them immediately instead of
      // writing garbage to stdin and waiting for a silent rejection.
      if (!code.includes('#')) {
        showHint('That looks incomplete — the code should contain a # character. Copy it from Claude again using the Copy Code button.', '#ef4444');
        return;
      }
      const parts = code.split('#');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        showHint('That code is missing one half. Make sure you copy the entire string including everything after the #.', '#ef4444');
        return;
      }

      btn.textContent = 'Submitting...';
      btn.disabled = true;
      inputEl.disabled = true;

      // Use the invoke path so we get feedback on whether the paste actually
      // reached the CLI subprocess. The legacy fire-and-forget path silently
      // failed when child.stdin was closed, leaving users with no indication
      // why their click did nothing.
      let result = { ok: false, reason: 'no-handler' };
      if (merlin.submitAuthCodeWithResult) {
        try {
          result = await merlin.submitAuthCodeWithResult(code);
        } catch (e) {
          result = { ok: false, reason: e && e.message ? e.message : 'invoke-threw' };
        }
      } else if (merlin.submitAuthCode) {
        merlin.submitAuthCode(code);
        result = { ok: true };
      }

      if (!document.getElementById('auth-code-dialog')) return;

      if (result.ok) {
        showHint('Sent to Claude — waiting for the token exchange to complete...', 'var(--text-muted)');
        btn.textContent = 'Submit';
        btn.disabled = false;
        inputEl.disabled = false;
        inputEl.value = '';
        inputEl.focus();
      } else {
        const reason = result.reason === 'child-stdin-destroyed'
          ? 'The Claude login process already exited. Close this dialog and try again.'
          : result.reason === 'empty'
          ? 'Please paste the code first.'
          : 'Could not send the code (' + (result.reason || 'unknown') + '). Close and try again.';
        showHint(reason, '#ef4444');
        btn.textContent = 'Submit';
        btn.disabled = false;
        inputEl.disabled = false;
      }
    }

    // Cancel actually kills the subprocess — not just the UI (Codex P2 #7).
    async function dismissDialog() {
      const d = document.getElementById('auth-code-dialog');
      if (d) d.remove();
      if (merlin.cancelClaudeLogin) {
        try { await merlin.cancelClaudeLogin(); } catch {}
      }
    }

    btn.onclick = submit;
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    document.getElementById('auth-code-cancel-btn').onclick = dismissDialog;
    document.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape') {
        dismissDialog();
        document.removeEventListener('keydown', escHandler);
      }
    });
  });
}

// ── Auth Code Dismiss (CLI exited — dialog no longer needed) ──
// Fires when the Claude CLI subprocess closes (success or failure). Removes
// the paste dialog if it was open.
if (merlin.onAuthCodeDismiss) {
  merlin.onAuthCodeDismiss(() => {
    const d = document.getElementById('auth-code-dialog');
    if (d) d.remove();
  });
}

// ── Unified Auth-Required Handler ──────────────────────────────────────────
// Single source of truth for "user has no working Claude credentials". Fired
// by the main process from startSession() (missing creds) and from SDK auth
// errors. This handler:
//
//   1. Shows an inline bubble so the user knows what's happening
//   2. Auto-triggers triggerClaudeLogin() — no button click required
//   3. On success: re-sends the triggering user message, so the user's
//      original request completes as if nothing happened (Codex P1 #5)
//   4. On failure: shows a Sign In button so the user can retry manually,
//      and surfaces the real error from the CLI instead of a silent shrug
//
// If an auth-required event fires while a login is already in progress,
// we ignore the duplicate so we don't spawn a second subprocess.
let _authLoginInFlight = false;
if (merlin.onAuthRequired) {
  merlin.onAuthRequired(async (data) => {
    if (_authLoginInFlight) {
      console.log('[auth] onAuthRequired fired while login already in flight — ignoring duplicate');
      return;
    }
    _authLoginInFlight = true;

    // Capture the triggering message NOW (before any async ops) so we can
    // replay it even if _lastUserMessage gets overwritten by some other path
    // while login is running.
    const pendingMessage = _lastUserMessage;

    // Clear in-flight turn state — same cleanup onInlineMessage does
    if (typingTimeout) { clearTimeout(typingTimeout); typingTimeout = null; }
    removeTypingIndicator();
    stopTickingTimer();
    finalizeBubble();
    sessionActive = false;
    isStreaming = false;
    setInputDisabled(false);

    // Show a live status bubble that updates as auth progresses
    const bubble = addClaudeBubble();
    bubble.style.borderColor = 'rgba(251,191,36,.3)';
    const statusEl = bubble.querySelector('.bubble-text') || bubble;
    function setStatus(text) {
      if (statusEl === bubble) {
        textBuffer = text;
        finalizeBubble();
      } else {
        statusEl.textContent = text;
      }
    }
    setStatus('Opening Claude sign-in in your browser...');

    try {
      if (!merlin.triggerClaudeLogin) {
        setStatus('Claude sign-in is not available in this build. Please restart Merlin.');
        return;
      }
      const result = await merlin.triggerClaudeLogin();
      if (result && result.success) {
        // Token is verified by main (readCredentials retry loop). Replay.
        if (pendingMessage) {
          setStatus('Signed in — replaying your request...');
          // Small delay so the user sees the transition
          await new Promise(r => setTimeout(r, 250));
          _lastUserMessage = pendingMessage;
          addUserBubble(pendingMessage);
          showTypingIndicator();
          turnStartTime = Date.now();
          turnTokens = 0;
          sessionActive = true;
          startTickingTimer();
          merlin.sendMessage(pendingMessage);
        } else {
          setStatus('Signed in to Claude. Ask me anything.');
        }
      } else if (result && result.cancelled) {
        setStatus('Sign-in cancelled. Click the button below to try again.');
        addRetryButton(bubble);
      } else {
        const err = (result && result.error) || 'Sign-in failed.';
        setStatus(err);
        addRetryButton(bubble);
      }
    } catch (e) {
      console.error('[auth] triggerClaudeLogin threw:', e);
      setStatus('Sign-in failed unexpectedly. ' + (e && e.message ? e.message : ''));
      addRetryButton(bubble);
    } finally {
      _authLoginInFlight = false;
    }
  });
}

// addRetryButton appends a "Sign In to Claude" button to a bubble. Clicking
// it fires the auth-required flow again. Used when the first auto-triggered
// login attempt failed and we want the user to try manually.
function addRetryButton(bubble) {
  if (!bubble || bubble.querySelector('.auth-retry-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'auth-retry-btn';
  btn.textContent = 'Sign In to Claude';
  btn.style.cssText = 'margin-top:12px;padding:8px 20px;border-radius:10px;border:none;background:var(--accent);color:#fff;font-weight:600;font-size:13px;cursor:pointer';
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Opening...';
    if (!merlin.triggerClaudeLogin) return;
    try {
      const result = await merlin.triggerClaudeLogin();
      if (result && result.success && _lastUserMessage) {
        bubble.remove();
        addUserBubble(_lastUserMessage);
        showTypingIndicator();
        sessionActive = true;
        turnStartTime = Date.now();
        startTickingTimer();
        merlin.sendMessage(_lastUserMessage);
      } else if (result && !result.success) {
        btn.disabled = false;
        btn.textContent = 'Sign In to Claude';
      }
    } catch {
      btn.disabled = false;
      btn.textContent = 'Sign In to Claude';
    }
  };
  bubble.appendChild(btn);
}

// ── Engine Status (binary download progress) ─────────────────
// Renders the engine download status into a persistent toast at the bottom
// of the screen. The toast is reused across updates so progress appears to
// "tick" rather than spamming new bubbles. Auto-dismisses 4s after a
// "complete" / "ready" message.
let _engineToast = null;
let _engineToastTimer = null;
merlin.onEngineStatus((msg) => {
  console.log('[engine]', msg);
  if (!msg) return;

  if (!_engineToast) {
    _engineToast = document.createElement('div');
    _engineToast.id = 'engine-toast';
    _engineToast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(10px);max-width:420px;padding:10px 16px;background:rgba(20,20,24,0.96);border:1px solid rgba(167,139,250,0.4);border-radius:10px;color:#e4e4e7;font-size:12px;line-height:1.4;z-index:9998;box-shadow:0 8px 32px rgba(0,0,0,0.5);backdrop-filter:blur(12px);opacity:0;transition:all .3s ease';
    document.body.appendChild(_engineToast);
  }
  _engineToast.textContent = '✦ ' + msg;
  requestAnimationFrame(() => {
    _engineToast.style.opacity = '1';
    _engineToast.style.transform = 'translateX(-50%) translateY(0)';
  });

  // Auto-dismiss on terminal states
  if (_engineToastTimer) clearTimeout(_engineToastTimer);
  if (/ready|complete|done|failed/i.test(msg)) {
    _engineToastTimer = setTimeout(() => {
      if (!_engineToast) return;
      _engineToast.style.opacity = '0';
      _engineToast.style.transform = 'translateX(-50%) translateY(10px)';
      setTimeout(() => { _engineToast?.remove(); _engineToast = null; }, 300);
    }, 4000);
  }
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

  // Wisdom server schema (wisdom-api/worker.js:aggregate):
  //   hooks:     { [name]: {ctr, cpc, roas, win, cpa?, n} }
  //   formats?:  { [name]: {ctr, roas, win, n} }
  //   timing:    { days: [topDowIndexes], hours: [topHourIndexes] }
  //   platforms: { [name]: {ctr, roas?, n} }
  //   models?:   { [name]: {roas, win, n} }   (min 2 samples)
  //
  // Old client code read `w.patterns.top_hooks`, `f.avg_roas`, `m.win_rate`,
  // `timing.best_days`, etc. — NONE of those keys exist in the server
  // response, so every panel showed "Collecting..." even with server data
  // present (and the one partial render showed "undefinedx" / "0% wins").
  // Every field-name below matches the actual server shape.
  const hooksObj = (w.hooks && typeof w.hooks === 'object') ? w.hooks : {};
  const formatsObj = (w.formats && typeof w.formats === 'object') ? w.formats : {};
  const modelsObj = (w.models && typeof w.models === 'object') ? w.models : {};
  const timing = w.timing || {};

  // Object-keyed → sorted array by roas desc. Fall through defensively on
  // partial rows (e.g. server adds a new field later).
  const objToSortedArray = (obj, nameKey) => Object.entries(obj)
    .map(([name, v]) => ({ [nameKey]: name, ...(v || {}) }))
    .sort((a, b) => (b.roas || 0) - (a.roas || 0));

  const topHooks = objToSortedArray(hooksObj, 'hook').slice(0, 4);
  const formatList = objToSortedArray(formatsObj, 'name').slice(0, 4);

  // Server's `models` object isn't tagged by type (no image vs video). Use a
  // known-video-model list to split — anything not in the list is treated as
  // an image model. Covers the current fal.ai + Google + HeyGen + Arcads set
  // that Merlin supports for video generation.
  const VIDEO_MODELS = new Set([
    'veo', 'veo2', 'veo3', 'kling', 'seedance', 'seedance-2', 'minimax', 'hunyuan', 'wan', 'hailuo', 'luma', 'heygen', 'arcads',
  ]);
  const isVideoModel = (name) => {
    if (!name) return false;
    const lower = String(name).toLowerCase();
    if (VIDEO_MODELS.has(lower)) return true;
    // Substring check catches fal-style names like "fal-ai/veo3" and "veo-3.0-fast"
    for (const v of VIDEO_MODELS) if (lower.includes(v)) return true;
    return false;
  };
  const allModels = objToSortedArray(modelsObj, 'model');
  const imageModels = allModels.filter(m => !isVideoModel(m.model)).slice(0, 3);
  const videoModels = allModels.filter(m => isVideoModel(m.model)).slice(0, 3);

  // Top scenes / creative styles aren't currently produced by the server
  // aggregation (no `scene` dimension on ads yet). Keep the slot reserved so
  // a future server update lights it up automatically without another client
  // shipping, but for now it stays empty (legitimately "Collecting...").
  const topScenes = [];

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // topKeys in wisdom-api returns numeric day-of-week (0-6) / hour (0-23);
  // defensively coerce in case a stray string slips through.
  const bestDays = (Array.isArray(timing.days) ? timing.days : [])
    .map(i => dayNames[Number(i)] || String(i))
    .join(', ');
  const bestHours = (Array.isArray(timing.hours) ? timing.hours : [])
    .map(h => {
      const hh = Number(h);
      if (!Number.isFinite(hh)) return '';
      const ampm = hh >= 12 ? 'PM' : 'AM';
      return (hh === 0 ? 12 : hh > 12 ? hh - 12 : hh) + ampm;
    })
    .filter(Boolean)
    .join(', ');

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

  // Format helpers matching the server shape: `roas` (not avg_roas), `n`
  // (not sample), `win` in 0..1 ratio (not win_rate percentage).
  const fmtRoas = (r) => (Number(r) || 0).toFixed(2) + 'x';
  const fmtWinPct = (w) => Math.round((Number(w) || 0) * 100) + '% wins';

  const hookItems = topHooks.map(h => ({
    label: h.hook, display: fmtRoas(h.roas), sub: (h.n || 0) + ' ads', val: h.roas || 0,
  }));
  const sceneItems = topScenes.map(s => ({
    label: s.scene, display: fmtRoas(s.roas), sub: (s.n || 0) + ' ads', val: s.roas || 0,
  }));
  const imgItems = imageModels.map(m => ({
    label: m.model, display: fmtRoas(m.roas), sub: fmtWinPct(m.win) + ' · ' + (m.n || 0) + ' ads', val: m.roas || 0,
  }));
  const vidItems = videoModels.map(m => ({
    label: m.model, display: fmtRoas(m.roas), sub: fmtWinPct(m.win) + ' · ' + (m.n || 0) + ' ads', val: m.roas || 0,
  }));
  const fmtItems = formatList.map(f => ({
    label: f.name, display: fmtRoas(f.roas), sub: fmtWinPct(f.win), val: f.roas || 0,
  }));

  // Benchmark: compare user's brand to collective averages
  const brand = document.getElementById('brand-select')?.value || '';
  const userPerf = perfState.cache[brand]?.[7] || perfState.cache[brand]?.[perfState.currentPeriod];
  let benchmarkHtml = '';
  if (userPerf && topHooks.length > 0) {
    const avgROAS = topHooks.reduce((s, h) => s + (h.roas || 0), 0) / topHooks.length;
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
const OAUTH_PLATFORMS = new Set(['tiktok', 'shopify', 'google', 'amazon', 'pinterest', 'klaviyo', 'slack', 'discord', 'etsy', 'reddit']);
const API_KEY_PLATFORMS = {
  // Meta: manual token entry while app is in review. Users get their token
  // from developers.facebook.com → Graph API Explorer. Once App Review
  // passes, move meta back to OAUTH_PLATFORMS for one-click OAuth login.
  meta:       { key: 'metaAccessToken', label: 'Meta Ads', placeholder: 'EAAL...', url: 'https://developers.facebook.com/tools/explorer/' },
  fal:        { key: 'falApiKey', label: 'fal.ai', placeholder: 'fal-xxxx...', url: 'https://fal.ai/dashboard/keys' },
  elevenlabs: { key: 'elevenLabsApiKey', label: 'ElevenLabs', placeholder: 'xi_xxxx...', url: 'https://elevenlabs.io/app/settings/api-keys' },
  heygen:     { key: 'heygenApiKey', label: 'HeyGen', placeholder: 'your-api-key', url: 'https://app.heygen.com/settings?nav=API' },
  arcads:     { key: 'arcadsApiKey', label: 'Arcads', placeholder: 'your-api-key', url: 'https://app.arcads.ai/settings' },
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
        if (!value || value.trim().length < 5) { showModalError('Key is too short'); throw new Error('validation'); }
        const result = await merlin.saveConfigField(apiDef.key, value.trim(), activeBrand);
        if (result.success) {
          loadConnections();
          // Meta: after saving the access token, auto-discover the ad account,
          // page, and pixel IDs. Without these, meta-push fails with
          // "metaAdAccountId required". Run discover in the background.
          if (platform === 'meta') {
            try {
              merlin.sendMessage(`Run meta discover for ${activeBrand || 'this brand'} to find the ad account, page, and pixel. Save the discovered IDs to the brand config. Do this silently — don't ask the user anything.`, { silent: true });
            } catch {}
          }
        } else {
          showModal({ title: 'Error', body: result.error || 'Failed to save', confirmLabel: 'OK', onConfirm: () => {} });
          throw new Error('save-failed');
        }
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

    // R2-2: split registered vs subscribed counts so the user sees both
    // "3 friends installed" and "+21 bonus days locked in".
    const total = info.referralCount || 0;
    const subscribed = info.subscribedCount || 0;
    const bonus = info.trialExtensionDays || 0;
    if (total > 0) {
      const friendsLabel = `${total} friend${total !== 1 ? 's' : ''} installed`;
      const subLabel = subscribed > 0 ? ` · ${subscribed} subscribed` : '';
      const bonusLabel = ` · +${bonus} bonus day${bonus !== 1 ? 's' : ''}`;
      stats.textContent = friendsLabel + subLabel + bonusLabel;
    } else {
      stats.textContent = '';
    }

    // If the user has already applied a friend's code, hide the input and
    // show a confirmed state in the status line.
    const applyRow = document.getElementById('referral-apply-row');
    const applyStatus = document.getElementById('referral-apply-status');
    const applyInput = document.getElementById('referral-apply-input');
    const applyBtn = document.getElementById('referral-apply-btn');
    if (info.appliedReferralCode) {
      if (applyRow) applyRow.style.display = 'none';
      if (applyStatus) {
        applyStatus.textContent = `✦ Applied code ${info.appliedReferralCode} — your friend gets the bonus when you subscribe`;
        applyStatus.className = 'referral-apply-status success';
      }
      if (applyInput) applyInput.disabled = true;
      if (applyBtn) applyBtn.disabled = true;
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

// R1-1: Apply a friend's referral code. Calls main's apply-referral-code
// IPC (which hits /api/register-referral) and shows inline feedback.
(function setupReferralApply() {
  const input = document.getElementById('referral-apply-input');
  const btn = document.getElementById('referral-apply-btn');
  const status = document.getElementById('referral-apply-status');
  if (!input || !btn || !status) return;

  async function applyCode() {
    const code = (input.value || '').trim().toLowerCase();
    if (!code) {
      status.textContent = 'Enter the 8-character code your friend shared.';
      status.className = 'referral-apply-status error';
      return;
    }
    if (!/^[0-9a-f]{8}$/.test(code)) {
      status.textContent = 'Invalid format — should be 8 characters (0-9 and a-f).';
      status.className = 'referral-apply-status error';
      return;
    }
    btn.disabled = true;
    input.disabled = true;
    status.textContent = 'Applying...';
    status.className = 'referral-apply-status';
    try {
      const result = await merlin.applyReferralCode(code);
      if (result && result.success) {
        status.textContent = `✦ Applied! Your friend gets +7 trial days when you subscribe to Pro.`;
        status.className = 'referral-apply-status success';
        document.getElementById('referral-apply-row').style.display = 'none';
        await loadReferralInfo();
      } else {
        status.textContent = (result && result.error) || 'Could not apply code';
        status.className = 'referral-apply-status error';
        btn.disabled = false;
        input.disabled = false;
      }
    } catch (err) {
      status.textContent = 'Network error — try again.';
      status.className = 'referral-apply-status error';
      btn.disabled = false;
      input.disabled = false;
    }
  }

  btn.addEventListener('click', applyCode);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCode(); });
  // Strip invalid characters as the user types (hex only, 8 max).
  input.addEventListener('input', () => {
    const cleaned = input.value.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 8);
    if (cleaned !== input.value) input.value = cleaned;
  });
})();

// Subscription canceled (server told us via /api/check-license)
if (merlin.onSubscriptionCanceled) {
  merlin.onSubscriptionCanceled((data) => {
    const trialEl = document.getElementById('trial-text');
    const ctaEl = document.querySelector('.subscribe-cta');
    const btn = document.getElementById('subscribe-btn');
    if (btn) {
      btn.classList.remove('subscribed');
      btn.classList.remove('hidden-sub');
    }
    if (trialEl) trialEl.textContent = 'Expired';
    if (ctaEl) ctaEl.textContent = 'Upgrade Now';
    const bubble = addClaudeBubble();
    textBuffer = `✦ Your subscription was ${data && data.reason === 'refunded' ? 'refunded' : 'canceled'}. You can re-subscribe anytime from the button up top.`;
    finalizeBubble();
  });
}

// Activation poller gave up — give the user a manual-check path.
if (merlin.onActivationTimeout) {
  merlin.onActivationTimeout(() => {
    const bubble = addClaudeBubble();
    textBuffer = `✦ Still finishing up on Stripe? If you've already paid, click the trial button up top — we'll re-check with the server.`;
    finalizeBubble();
  });
}

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

// Deterministic minute offset per brand based on a simple 32-bit string hash.
// Returns a value in [0, 30) so spells for different brands are spread
// across the first half-hour of the trigger slot, avoiding thundering-herd
// API calls at 9:00 / 5:00 / 14:00 etc. 30 minutes is narrow enough that a
// "5 AM morning briefing" still fires during morning, wide enough that
// realistic brand counts don't collide (birthday-paradox ~50% collision at
// 6+ brands for 30 slots; acceptable for the staggering goal).
function brandHashMinuteOffset(brand) {
  let h = 0;
  for (let i = 0; i < brand.length; i++) {
    h = ((h << 5) - h + brand.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 30;
}

// Add a minute offset to a standard 5-field cron expression. Only the minute
// field is adjusted — the hour/day/month/dow fields are untouched. If the
// minute field is a wildcard ("*", "*/5", ranges, lists), the expression is
// returned unchanged because shifting a pattern like "*/5" by an offset
// would change its meaning.
function offsetCronMinutes(cron, offset) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const minField = parts[0];
  if (!/^\d+$/.test(minField)) return cron;
  const newMin = (parseInt(minField, 10) + ((offset % 60) + 60)) % 60;
  parts[0] = String(newMin);
  return parts.join(' ');
}

// Discover every brand the user has set up that has at least one ad platform
// connected. Enterprise default: scheduled tasks get created for all of them.
// Single-brand users get identical behavior to before since the array has
// one element.
async function discoverBrandsForSpellActivation() {
  const targets = [];
  try {
    const brands = await merlin.getBrands();
    for (const b of (brands || [])) {
      const name = b?.name;
      if (!name) continue;
      try {
        const conns = await merlin.getConnectedPlatforms(name);
        const hasAdPlatform = (conns || []).some(c => {
          // Ad platforms, not notification channels — scheduled reporting
          // only makes sense for brands where there's ad spend to report on.
          return ['meta', 'tiktok', 'google', 'amazon', 'linkedin', 'reddit', 'shopify', 'klaviyo'].includes(c.platform);
        });
        if (hasAdPlatform) targets.push(name);
      } catch {}
    }
  } catch {}
  return targets;
}

async function activateSpell(template, row) {
  // Optimistic: show creating state
  row.querySelector('.spell-dot').className = 'spell-dot dot-creating';
  row.querySelector('.spell-meta').textContent = 'Setting up...';
  row.style.pointerEvents = 'none';

  // Enterprise default: enable the spell for EVERY brand that has at least
  // one ad platform or shopify connected. That way the user gets portfolio-
  // wide reporting without having to re-activate per brand. The bug this
  // prevents is the one we just fixed — a single-brand spell silently
  // producing empty data because it was only wired to the currently-
  // selected brand in the dropdown while other brands went dark.
  let targetBrands = await discoverBrandsForSpellActivation();

  // Fallback: if discovery failed (no brands, IPC error) use whatever the
  // dropdown currently shows. This keeps a first-run single-brand user
  // working even before they've connected a platform — the spell gets
  // created, and the brand-lock in Part C ensures it routes correctly once
  // they connect one. Filter out reserved sentinel values so activating
  // with "+ New Brand" or the empty placeholder doesn't spawn a ghost spell.
  if (targetBrands.length === 0) {
    const selected = document.getElementById('brand-select')?.value || '';
    if (selected && selected !== '__add__' && /^[a-z0-9_-]+$/i.test(selected)) {
      targetBrands = [selected];
    }
  }

  if (targetBrands.length === 0) {
    row.querySelector('.spell-dot').className = 'spell-dot dot-error';
    row.querySelector('.spell-meta').textContent = 'No brands yet — set one up first';
    row.style.pointerEvents = '';
    return;
  }

  // Stagger cron minutes per brand so N spells don't all hit platform APIs
  // at exactly the same instant. Hash-based offset is deterministic so a
  // given brand always lands on the same minute — reruns/migrations don't
  // cause a spell to drift across the clock.
  const results = [];
  for (let i = 0; i < targetBrands.length; i++) {
    const brand = targetBrands[i];
    const staggeredCron = offsetCronMinutes(template.cron, brandHashMinuteOffset(brand));
    try {
      const r = await merlin.createSpell(`merlin-${template.spell}`, staggeredCron, template.name, template.prompt, brand);
      results.push({ brand, ok: r?.success === true, error: r?.error });
    } catch (err) {
      results.push({ brand, ok: false, error: err?.message || 'unknown' });
    }
  }

  const okCount = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);

  if (okCount === targetBrands.length) {
    row.querySelector('.spell-dot').className = 'spell-dot dot-active';
    row.querySelector('.spell-meta').textContent = okCount === 1 ? 'Active ✓' : `Active for ${okCount} brands ✓`;
    setTimeout(() => loadSpells(), 2000);

    // First-run confirmation uses the currently-selected brand as the
    // "primary" one to run immediately. Other brands will fire on schedule.
    const primaryBrand = document.getElementById('brand-select')?.value || targetBrands[0];
    showFirstRunPrompt(template, primaryBrand);
  } else if (okCount > 0) {
    // Partial success — show both counts so the user knows some worked
    row.querySelector('.spell-dot').className = 'spell-dot dot-warning';
    row.querySelector('.spell-meta').textContent = `Active for ${okCount} of ${targetBrands.length} — check errors`;
    row.style.pointerEvents = '';
    console.warn('[spell] Multi-brand creation partial failure:', failed);
    setTimeout(() => loadSpells(), 2000);
  } else {
    row.querySelector('.spell-dot').className = 'spell-dot dot-error';
    row.querySelector('.spell-meta').textContent = `Failed — ${failed[0]?.error || 'tap to retry'}`;
    row.style.pointerEvents = '';
    console.warn('[spell] All creations failed:', failed);
  }
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
  tickerEl.className = 'turn-stats ticker-live';
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

let _stuckTimer = null;
function setStatusLabel(label) {
  if (label === _currentStatusLabel) return; // no-op if same
  _currentStatusLabel = label;
  if (_statusDebounce) clearTimeout(_statusDebounce);
  if (_stuckTimer) clearTimeout(_stuckTimer);
  // Short debounce (50ms) to batch rapid status changes without creating a visible dead zone.
  // Previous 300ms delay combined with the 2s scheduleTypingIndicator delay left users
  // with no feedback for up to 2.3 seconds between responses.
  _statusDebounce = setTimeout(() => {
    const status = document.getElementById('chat-status');
    const existing = status.querySelector('.chat-status-label');
    if (existing) {
      existing.textContent = label;
    } else {
      status.innerHTML = `<div class="chat-status-row"><span class="status-spinner">✦</span> <span class="chat-status-label">${escapeHtml(label)}</span></div>`;
    }
    _statusDebounce = null;
  }, 50);

  // Stuck detection — if status doesn't change for 45s, show a hint
  _stuckTimer = setTimeout(() => {
    const statusEl = document.getElementById('chat-status');
    const labelEl = statusEl?.querySelector('.chat-status-label');
    if (labelEl && labelEl.textContent === label) {
      labelEl.textContent = label + ' — taking a while...';
    }
  }, 45000);
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
  if (_stuckTimer) { clearTimeout(_stuckTimer); _stuckTimer = null; }
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
  if (!text) return;

  // Offline gate — prevent sending when disconnected
  if (!navigator.onLine) {
    const bubble = addClaudeBubble();
    textBuffer = 'You\'re offline. Check your internet connection and try again.';
    finalizeBubble();
    return;
  }

  // Trial expiry gate — soft block, allow key activation
  if (_trialExpired) {
    showModal({
      title: 'Your Free Trial Has Ended',
      body: 'Your brands, products, and all creative learnings are saved and ready to go. Subscribe to pick up right where you left off, or enter a license key below.',
      inputPlaceholder: 'License key (e.g. XXXX-XXXX)',
      confirmLabel: 'Activate Key',
      cancelLabel: 'Subscribe',
      onConfirm: (key) => {
        if (key && key.length > 0) {
          merlin.activateKey(key).then((result) => {
            if (result.success) {
              // Flip to "Manage Pro" state — hiding the button leaves
              // the user with no path to the billing portal.
              const btn = document.getElementById('subscribe-btn');
              btn.classList.remove('hidden-sub');
              btn.classList.add('subscribed');
              btn.style.borderColor = '';
              btn.style.animation = '';
              document.getElementById('trial-text').textContent = '✦ Pro';
              document.querySelector('.subscribe-cta').textContent = 'Manage';
              _trialExpired = false;
              const bubble = addClaudeBubble();
              textBuffer = '✦ Welcome to Merlin Pro — all features unlocked.';
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

// ── Voice Input (streaming MediaRecorder → whisper.cpp) ──────
// Records mic audio in the renderer (webm/opus) with a 2.5s timeslice,
// so `ondataavailable` fires every ~2.5s with more audio. Each firing
// re-transcribes the cumulative blob via main.js (ffmpeg → whisper-cli)
// and updates the input with the latest text in desaturated gray
// (.voice-interim). On stop, the final transcription flips the color
// back to normal. Escape cancels and restores whatever was in the
// input before recording.
const micBtn = document.getElementById('mic-btn');
let mediaRecorder = null;
let audioStream = null;
let recordingChunks = [];
let isRecording = false;
let isCanceled = false;
let streamBusy = false;     // prevents overlapping whisper-cli calls
let voiceBaseText = '';     // text that was in input before recording started

async function transcribeCurrent(isInterim) {
  if (recordingChunks.length === 0) return;
  const blob = new Blob(recordingChunks, { type: 'audio/webm' });
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = Array.from(new Uint8Array(arrayBuffer));
  try {
    const result = await merlin.transcribeAudio(bytes);
    if (result && result.transcript && result.transcript.trim()) {
      const text = result.transcript.trim();
      input.value = (voiceBaseText + text).replace(/^\s+/, '');
      if (isInterim) input.classList.add('voice-interim');
      else input.classList.remove('voice-interim');
      autoResize();
    } else if (result && result.error && !isInterim) {
      showModal({
        title: 'Transcription failed',
        body: result.error,
        confirmLabel: 'OK',
      });
    }
  } catch (err) {
    // Interim failures are silent — next chunk will retry. Only surface
    // the error on the final (post-stop) transcription.
    if (!isInterim) {
      console.warn('transcribeAudio threw:', err);
      showModal({
        title: 'Transcription failed',
        body: String(err && err.message ? err.message : err),
        confirmLabel: 'OK',
      });
    }
  }
}

async function startRecording() {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch (err) {
    console.warn('getUserMedia failed:', err);
    showModal({
      title: 'Microphone blocked',
      body: 'Voice input needs microphone access. Check Windows mic permissions for Merlin and try again.',
      confirmLabel: 'OK',
    });
    return;
  }
  // Capture whatever was in the input so streaming updates append to it
  voiceBaseText = input.value ? input.value.trimEnd() + ' ' : '';
  recordingChunks = [];
  isCanceled = false;
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  mediaRecorder = new MediaRecorder(audioStream, { mimeType: mime });

  mediaRecorder.ondataavailable = async (e) => {
    if (e.data && e.data.size > 0) recordingChunks.push(e.data);
    // Interim streaming transcription (gray) — skip if a previous call
    // is still in flight; we'll catch up on the next chunk.
    if (isRecording && !isCanceled && !streamBusy && recordingChunks.length > 0) {
      streamBusy = true;
      try { await transcribeCurrent(true); }
      finally { streamBusy = false; }
    }
  };

  mediaRecorder.onstop = async () => {
    try { audioStream.getTracks().forEach(t => t.stop()); } catch {}
    audioStream = null;
    micBtn.classList.remove('recording');
    // Wait for any in-flight interim transcription to settle before final
    while (streamBusy) await new Promise(r => setTimeout(r, 50));

    if (isCanceled) {
      // Revert to whatever was in the input before recording
      input.value = voiceBaseText.trimEnd();
      input.classList.remove('voice-interim');
      autoResize();
      isCanceled = false;
      return;
    }
    if (recordingChunks.length === 0) return;

    micBtn.classList.add('transcribing');
    micBtn.disabled = true;
    try {
      await transcribeCurrent(false);  // final → strips gray class
      input.focus();
    } finally {
      micBtn.classList.remove('transcribing');
      micBtn.disabled = false;
    }
  };

  // 2500ms timeslice = ondataavailable fires every ~2.5s for streaming
  mediaRecorder.start(2500);
  isRecording = true;
  micBtn.classList.add('recording');
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    try { mediaRecorder.stop(); } catch (e) { console.warn('stop error', e); }
    isRecording = false;
  }
}

function cancelRecording() {
  if (mediaRecorder && isRecording) {
    isCanceled = true;
    try { mediaRecorder.stop(); } catch (e) { console.warn('cancel error', e); }
    isRecording = false;
  }
}

micBtn.addEventListener('click', () => {
  if (isRecording) stopRecording();
  else startRecording();
});

// Escape cancels recording entirely (restores pre-recording text)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isRecording) cancelRecording();
});

// Auto-resize textarea
function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}
input.addEventListener('input', autoResize);
// User typing over interim voice text commits it to normal color
input.addEventListener('input', () => {
  if (input.classList.contains('voice-interim')) input.classList.remove('voice-interim');
});

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
// Cooldown: once dismissed or shown, don't show again for 7 days
const NUDGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
let _nudgeShown = false;
let _errorCount = 0;
let _rapidMessageCount = 0;
let _lastMessageTime = 0;

// Check if nudge is in cooldown from a previous session
(function initNudgeCooldown() {
  try {
    const lastShown = parseInt(localStorage.getItem('merlin-nudge-last') || '0');
    if (Date.now() - lastShown < NUDGE_COOLDOWN_MS) _nudgeShown = true;
  } catch {}
})();

function checkFrustration(text) {
  if (_nudgeShown) return;

  const t = (text || '').toLowerCase();
  const now = Date.now();

  // Detect rapid repeated messages (5+ messages within 20 seconds — genuine frustration, not normal pace)
  if (now - _lastMessageTime < 20000) {
    _rapidMessageCount++;
  } else {
    _rapidMessageCount = 0;
  }
  _lastMessageTime = now;

  // Only trigger on strong frustration signals — not common words like "help" or "error"
  const frustrated =
    _rapidMessageCount >= 5 ||
    _errorCount >= 3 ||
    /\b(broken|not working|doesn'?t work|why won'?t|wtf|this is wrong|nothing happens|keeps failing)\b/i.test(t);

  if (frustrated) showHelpNudge();
}

function showHelpNudge() {
  if (_nudgeShown) return;
  _nudgeShown = true;
  try { localStorage.setItem('merlin-nudge-last', String(Date.now())); } catch {}
  const nudge = document.getElementById('help-nudge');
  nudge.classList.remove('hidden');
  // Auto-hide after 10 seconds
  setTimeout(() => nudge.classList.add('hidden'), 10000);
}

document.getElementById('help-nudge-close').addEventListener('click', () => {
  document.getElementById('help-nudge').classList.add('hidden');
  try { localStorage.setItem('merlin-nudge-last', String(Date.now())); } catch {}
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
  // Prefer data-file attributes (stored raw). Fall back to the element's src,
  // which IS URL-encoded (merlinUrl applies encodeURIComponent per segment for
  // XSS safety). Decode the src back to a raw filesystem path so IPC handlers
  // (copyImage, deleteFile, openFolder) receive a path that actually exists
  // on disk. `decodeURI` preserves the '/' separator.
  let filePath = '';
  if (media.dataset?.file) {
    filePath = media.dataset.file;
  } else if (mediaEl?.dataset?.file) {
    filePath = mediaEl.dataset.file;
  } else if (mediaEl?.src) {
    const raw = mediaEl.src.replace(/^merlin:\/\//, '');
    try { filePath = decodeURI(raw); } catch { filePath = raw; }
  }
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
      // Prefer the element's already-encoded src; fall back to encoding filePath
      a.href = mediaEl?.src || merlinUrl(filePath);
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

// Brand-scoped perf check is running right now — button debounce.
const perfRunInFlight = new Set();

function renderPerfBar(perf) {
  const text = document.getElementById('perf-text');
  if (!perf || !perf.generatedAt) {
    renderPerfBarEmpty(text);
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

// Render the empty-state message truthfully. The old copy ("connect an ad
// platform to start tracking") was a lie when a platform WAS connected but
// no dashboard had been pulled yet — which is the most common case on first
// launch. We differentiate via getConnectedPlatforms:
//
//   - No ad platforms connected → "Connect an ad platform..." (accurate)
//   - Ad platform connected, no data → "No performance data yet — run a
//     check now" with an inline button that kicks off refreshPerf for the
//     selected brand and period. One click to recovery.
async function renderPerfBarEmpty(text) {
  const brand = perfState.currentBrand;
  let hasAdPlatform = false;
  if (brand) {
    try {
      const conns = await merlin.getConnectedPlatforms(brand);
      hasAdPlatform = (conns || []).some(c => ['meta', 'tiktok', 'google', 'amazon', 'linkedin', 'reddit'].includes(c.platform));
    } catch {}
  }

  // Race guard: if the user switched brands during the getConnectedPlatforms
  // await, abandon this render — a newer call against the new brand will
  // already have taken over the shared perf-text element, and our delayed
  // innerHTML would stomp it with stale data.
  if (perfState.currentBrand !== brand) return;

  if (!hasAdPlatform) {
    text.innerHTML = 'Connect an ad platform to start tracking revenue';
    return;
  }

  // Button id includes brand so double-wiring across brand switches doesn't
  // leak listeners onto the wrong handler. Using inline styles to avoid
  // touching the stylesheet for this small affordance.
  const btnId = `perf-run-now-${brand || 'global'}`;
  text.innerHTML = `No performance data yet — <a href="#" id="${btnId}" style="color:var(--accent);text-decoration:underline;cursor:pointer">run a check now</a>`;

  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (perfRunInFlight.has(brand)) return; // debounce double-click
    perfRunInFlight.add(brand);
    btn.textContent = 'running...';
    btn.style.pointerEvents = 'none';

    // Clear the "already refreshed once this session" guard that loadPerfBar
    // uses — without this, a user who landed in the empty state due to a
    // first-launch failure would click the button and the refresh would be
    // skipped. The guard only exists to prevent infinite refresh loops on
    // brands with no connected platforms, which we already verified above.
    perfState._refreshedBrands?.delete(brand);

    try {
      const result = await merlin.refreshPerf(brand, perfState.currentPeriod || 7);

      // Race guard: if the user switched brands during the 30-60s refresh,
      // don't yank the UI back to this (now inactive) brand's data.
      if (perfState.currentBrand !== brand) return;

      // Surface backend errors (e.g. _binaryTooOld gate, binary missing,
      // stale config) so the user isn't left staring at a blank bar with
      // no explanation. The handler returns { error } on refusal.
      if (result && result.error) {
        text.innerHTML = escapeHtml(result.error);
        return;
      }

      // perf-data-changed event fires on success and reloads the bar
      // automatically. Also trigger loadPerfBar here so the render happens
      // even if the IPC notification was dropped.
      loadPerfBar(perfState.currentPeriod || 7, brand);
    } catch (err) {
      if (perfState.currentBrand !== brand) return;
      text.innerHTML = 'Couldn\'t reach the Merlin engine — try again in a moment';
      console.warn('[perf-bar] refresh failed:', err);
    } finally {
      perfRunInFlight.delete(brand);
    }
  });
}

async function fetchPerfData(days, brand) {
  const perf = await merlin.getPerfSummary(days, brand);
  // Cache if data exists (generatedAt proves a dashboard run happened, even if values are zero)
  if (perf && perf.generatedAt) {
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
    if (perf && perf.generatedAt) {
      // Data exists (even if revenue/spend are zero — that's a valid state, not "no data")
      renderPerfBar(perf);
    } else if (!cached && brand && !perfState._refreshedBrands?.has(brand)) {
      // No data for this brand AND we haven't already tried refreshing it.
      // Guard prevents infinite refresh loops for brands with no connected platforms.
      if (!perfState._refreshedBrands) perfState._refreshedBrands = new Set();
      perfState._refreshedBrands.add(brand);
      renderPerfBar(null);
      try {
        await merlin.refreshPerf(brand);
        // Re-check that user hasn't switched brands during the 30-60s refresh
        if (perfState.currentBrand !== brand || perfState.currentPeriod !== days) return;
        const retryPerf = await fetchPerfData(days, brand);
        if (perfState.currentBrand === brand && perfState.currentPeriod === days) {
          renderPerfBar(retryPerf);
        }
      } catch {}
    } else if (!cached) {
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

// Load on startup — wait for brands to load FIRST, then load perf bar with the active brand.
// Previous bug: loadPerfBar(7) ran before brands loaded, so it used empty brand → global data.
loadBrands().then(() => {
  loadConnections();
  loadSpells();
  const activeBrand = document.getElementById('brand-select')?.value || '';
  loadPerfBar(7, activeBrand);

  // Background perf refresh — pull fresh data on launch if brand data is stale
  (async function refreshPerfOnLaunch() {
    try {
      const lastUpdate = await merlin.getPerfUpdated(activeBrand);
      const stale = !lastUpdate || (Date.now() - new Date(lastUpdate).getTime() > 4 * 60 * 60 * 1000);
      if (stale) {
        await merlin.refreshPerf(activeBrand);
        // Re-read the current brand from DOM — user may have switched during the 30-60s refresh
        const currentBrand = document.getElementById('brand-select')?.value || '';
        if (currentBrand === activeBrand) {
          const activePeriod = document.querySelector('.perf-period-btn.active')?.dataset.days || '7';
          loadPerfBar(parseInt(activePeriod), activeBrand);
        }
        // If user switched brands, don't overwrite their selection
      }
    } catch {}
  })();
});

// Periodic refresh — every 4 hours, refresh the currently selected brand
setInterval(async () => {
  try {
    const activeBrand = document.getElementById('brand-select')?.value || '';
    await merlin.refreshPerf(activeBrand);
    const activePeriod = document.querySelector('.perf-period-btn.active')?.dataset.days || '7';
    loadPerfBar(parseInt(activePeriod), activeBrand);
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
  if (typeof updateArchiveRefreshVisibility === 'function') updateArchiveRefreshVisibility();
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

// Refresh button: only visible on the Live Ads tab. Click triggers a full
// platform sweep (Meta/TikTok/Google/Amazon/Reddit/LinkedIn) for the active
// brand — ads-live.json gets rewritten, then the panel auto-reloads via the
// live-ads-changed event.
(() => {
  const refreshBtn = document.getElementById('archive-refresh-btn');
  if (!refreshBtn) return;
  refreshBtn.style.display = 'none';
  refreshBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (refreshBtn.classList.contains('refreshing')) return;
    refreshBtn.classList.add('refreshing');
    const brand = document.getElementById('brand-select')?.value || '';
    try {
      await merlin.refreshLiveAds(brand || null);
    } catch (err) {
      console.warn('[archive] refresh failed', err);
    }
    // Reload the panel so users see the fresh data immediately.
    refreshBtn.classList.remove('refreshing');
    loadArchive();
  });
  if (merlin.onLiveAdsChanged) {
    merlin.onLiveAdsChanged(() => {
      // Only reload if the Live Ads tab is currently showing. Other tabs
      // render generated content or swipes, which don't care about ads-live.
      const active = document.querySelector('.archive-filter.active')?.dataset.filter;
      if (active === 'live') loadArchive();
    });
  }
})();

function updateArchiveRefreshVisibility() {
  const btn = document.getElementById('archive-refresh-btn');
  if (!btn) return;
  const active = document.querySelector('.archive-filter.active')?.dataset.filter;
  btn.style.display = active === 'live' ? '' : 'none';
}

// Archive filter buttons
document.querySelectorAll('.archive-filter').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.archive-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    updateArchiveRefreshVisibility();
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
      const thumb = swipe.thumbnail ? `<img src="${escapeHtml(merlinUrl(swipe.thumbnail))}" alt="" loading="lazy">` : '<div class="archive-card-placeholder">✦</div>';
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
      empty.querySelector('p').textContent = 'No live ads cached yet';
      empty.querySelector('.archive-empty-sub').textContent = 'Click ↻ to pull your current ads from Meta, TikTok, Google, Amazon, Reddit and LinkedIn';
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
        card.innerHTML = `<img class="archive-card-thumb" src="${escapeHtml(merlinUrl(ad.creativePath))}" alt="" loading="lazy">`;
      } else {
        card.innerHTML = `<div class="archive-card-thumb" style="display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--text-dim)">📢</div>`;
      }

      const brandLabel = ad.brand ? ad.brand.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';
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
          ${brandLabel ? `<div class="archive-card-meta" style="margin-top:1px"><span>${escapeHtml(brandLabel)}</span></div>` : ''}
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
    const activeBrand = document.getElementById('brand-select')?.value || '';
    const items = await merlin.getArchiveItems({
      type: typeFilter === 'all' ? '' : typeFilter,
      search,
      brand: activeBrand,
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
    card.innerHTML = `<img class="archive-card-thumb" src="${escapeHtml(merlinUrl(item.thumbnail))}" alt="" loading="lazy">`;
  } else {
    card.innerHTML = `<div class="archive-card-thumb" style="display:flex;align-items:center;justify-content:center;font-size:24px;color:var(--text-dim)">${isVideo ? '▶' : '✦'}</div>`;
  }

  // Extra badges: QA status (when explicitly known) and "loose" marker for
  // orphan files that weren't produced by the standard pipeline. The loose
  // marker is subtle — it just signals that metadata.json wasn't found, so
  // fields like model/product are inferred from the filename.
  let extraBadges = '';
  if (item.qaPassed === false) extraBadges += `<span class="archive-card-badge badge-qa-fail" title="Quality gate failed">✗ QA</span>`;
  else if (item.qaPassed === true) extraBadges += `<span class="archive-card-badge badge-qa-pass" title="Quality gate passed">✓ QA</span>`;
  if (item.source === 'loose') extraBadges += `<span class="archive-card-badge badge-source-loose" title="Loose file — no metadata">legacy</span>`;

  card.innerHTML += `
    <div class="archive-card-info">
      <div class="archive-card-title">${escapeHtml(title)}</div>
      <div class="archive-card-meta">
        <span class="archive-card-badge ${badgeClass}">${badgeText}</span>
        <span>${time}</span>
      </div>
      ${extraBadges ? `<div class="archive-card-meta" style="margin-top:2px;gap:4px">${extraBadges}</div>` : ''}
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
    const files = item.files || [];
    // Prefer the canonical pipeline outputs, then fall back to ANY video file
    // in the folder so loose files (seedance_xxx.mp4, veo3_xxx.mp4, etc.) can
    // still be previewed — before this fallback, loose videos showed "No
    // preview available" in the overlay.
    const best =
      files.find(f => f === 'captioned.mp4') ||
      files.find(f => f === 'final.mp4') ||
      files.find(f => /\.(mp4|mov|webm|m4v)$/i.test(f));
    if (best) mediaPath = merlinUrl((item.folder ? item.folder + '/' : '') + best);
  } else if (item.thumbnail) {
    // Use the same file as the thumbnail — single source of truth
    mediaPath = merlinUrl(item.thumbnail);
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
    overlay.innerHTML = `<div class="preview-layout"><video src="${escapeHtml(mediaPath)}" controls autoplay playsinline></video>${statsHtml}</div>`;
  } else if (mediaPath) {
    overlay.innerHTML = `<div class="preview-layout"><img src="${escapeHtml(mediaPath)}" alt="" data-folder="${escapeHtml(item.folder || '')}" data-file="${escapeHtml(decodeURIComponent(mediaPath.replace('merlin://', '')))}">${statsHtml}</div>`;
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
  _trialExpired = true;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.id = 'trial-overlay';
  overlay.innerHTML = `
    <div class="setup-card">
      <div class="setup-mascot">✦</div>
      <h1>Your Free Trial Has Ended</h1>
      <p class="setup-sub">Everything you've built is saved and waiting</p>
      <p class="setup-explain">Your brands, products, ad creatives, and performance learnings are all intact. Subscribe to unlock Merlin and keep scaling, or enter a license key if you have one.</p>
      <button class="btn-primary" id="trial-subscribe-btn">Subscribe to Merlin Pro</button>
      <button class="btn-secondary" id="trial-key-btn">I have a license key</button>
      <p style="font-size:11px;color:var(--text-dim);margin-top:12px">Invite 3 friends with your referral link for up to 21 extra free days.</p>
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

    // R1-3: first-run referral prompt. Because the landing page can't
    // carry the ?ref= code through the installer, the user must paste
    // it once. This is the only moment their intent is fresh, so we
    // ask here rather than burying it in a side panel.
    const refCheckbox = document.getElementById('tos-has-referral');
    const refWrap = document.getElementById('tos-referral-wrap');
    const refInput = document.getElementById('tos-referral-input');
    const refStatus = document.getElementById('tos-referral-status');
    if (refCheckbox && refWrap && refInput) {
      refCheckbox.addEventListener('change', () => {
        refWrap.classList.toggle('hidden', !refCheckbox.checked);
        if (refCheckbox.checked) setTimeout(() => refInput.focus(), 50);
      });
      refInput.addEventListener('input', () => {
        const cleaned = refInput.value.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 8);
        if (cleaned !== refInput.value) refInput.value = cleaned;
      });
    }

    btn.addEventListener('click', async () => {
      const emailOptIn = document.getElementById('email-optin-checkbox').checked;
      await merlin.acceptTos({ emailOptIn });

      // Try to apply the referral code if the user provided one. We don't
      // block the ToS flow on failure — just surface the error inline and
      // still proceed into the app.
      if (refCheckbox && refCheckbox.checked && refInput) {
        const code = (refInput.value || '').trim().toLowerCase();
        if (/^[0-9a-f]{8}$/.test(code)) {
          try {
            const result = await merlin.applyReferralCode(code);
            if (result && result.success && refStatus) {
              refStatus.textContent = `✦ Applied — your friend gets the bonus when you subscribe`;
              refStatus.className = 'referral-apply-status success';
            } else if (refStatus) {
              refStatus.textContent = (result && result.error) || 'Could not apply code — you can retry in the Share Merlin panel';
              refStatus.className = 'referral-apply-status error';
              // Hold the modal briefly so the user can read the error
              await new Promise(r => setTimeout(r, 800));
            }
          } catch {
            if (refStatus) {
              refStatus.textContent = 'Network error — retry later from the Share Merlin panel';
              refStatus.className = 'referral-apply-status error';
            }
          }
        } else if (refStatus && code) {
          refStatus.textContent = 'Invalid format — retry later from the Share Merlin panel';
          refStatus.className = 'referral-apply-status error';
          await new Promise(r => setTimeout(r, 600));
        }
      }

      document.getElementById('tos-overlay').style.animation = 'fadeOut .3s ease forwards';
      setTimeout(() => {
        document.getElementById('tos-overlay').classList.add('hidden');
        document.getElementById('tos-overlay').style.animation = '';
        init();
      }, 300);
    });
  }
})();
