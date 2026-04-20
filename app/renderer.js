// ── State ────────────────────────────────────────────────────
let currentBubble = null;
let isStreaming = false;
let textBuffer = '';
let rafPending = false;

// ── Fact-binding pipeline (DEFAULT OFF) ──────────────────────
// Wires facts-cache + verify-facts passes + TailQuarantine into the streaming
// text path. See FACT-BINDING-PLAN.md + facts/SPEC.md. The flag stays false
// in production until Phase 12 rollout-gate flips it; every helper below is
// a no-op when disabled so behavior is bit-identical to pre-fact-binding
// builds.
//
// Phase 12 rollout: `factBindingEnabled` is resolved at bundle-parse time
// from three sources in priority order:
//   1. `window.__merlinFactBindingForceOn` — set by main.js from version.json
//      feature-flag (`featureFlags.factBinding === true`). This is how we
//      turn it on for real users via a normal version-bump push.
//   2. `globalThis.MERLIN_FACT_BINDING === '1'` — env override for dev.
//      main.js reads `process.env.MERLIN_FACT_BINDING` and forwards it.
//   3. false — default.
// The flag is read ONCE at module-init; it cannot be flipped mid-session
// (facts-cache keyed to the initial session; toggling mid-session would
// corrupt the HMAC chain). This matches rule #12 (no runtime writes to
// `factBindingEnabled` in release builds).
const factBindingEnabled = (() => {
  try {
    if (typeof window !== 'undefined' && window.__merlinFactBindingForceOn === true) return true;
    if (typeof globalThis !== 'undefined' && globalThis.MERLIN_FACT_BINDING === '1') return true;
  } catch { /* isolation error — stay off */ }
  return false;
})();

// ── Bridge-based fact binding ─────────────────────────────────
//
// REGRESSION GUARD (2026-04-18): the renderer runs with
// `contextIsolation: true, nodeIntegration: false, sandbox: false`, so
// there is NO `require`, NO `Buffer`, NO `fs` in this scope. Earlier
// versions of this file did `require('./facts/facts-cache')` and
// `require('./facts/verify-facts')` at call time — both threw
// `ReferenceError: require is not defined`, caught silently by the
// try/catch, and fact-binding became a no-op for every production
// user despite the feature flag being ON.
//
// The facts modules now live in preload (Node context). This renderer
// holds opaque integer handles returned by `window.merlinFactBinding.*`
// calls; every bridge method resolves the handle to the real instance
// in preload. Do NOT reintroduce `require('./facts/…')` here — it will
// throw in production. If you need a new capability, add it to
// `app/preload.js`'s merlinFactBinding surface, not to renderer.js.
//
// `app/facts/renderer-bridge-runtime.test.js` locks the invariant with
// a vm harness that loads renderer.js under strict contextIsolation
// semantics (no require, no Buffer) and a mocked bridge.
const _factBridge = (typeof window !== 'undefined' && window.merlinFactBinding) ? window.merlinFactBinding : null;
let _factCacheHandle = 0;   // preload-side FactCache reference
let _factWatcherHandle = 0; // preload-side file-watcher reference
let _tailHandle = 0;        // per-bubble TailQuarantine reference

/**
 * initFactBinding({ sessionId, vaultKey, brand, toolsDir }) — wired by the
 * preload bridge (`window.merlinFactBinding.onInit(cb)` → this callback).
 * The preload bridge owns the FactCache instance and returns a handle.
 * `vaultKey` arrives as a Uint8Array (contextBridge structured clone of
 * the Buffer preload built from the hex). The renderer never touches the
 * raw bytes — it forwards the Uint8Array straight back to preload's
 * `createCache`, which normalises to Buffer internally.
 * Safe to call even when factBindingEnabled is false (returns 0).
 */
function initFactBinding({ sessionId, vaultKey, brand, toolsDir }) {
  if (!factBindingEnabled || !_factBridge) return 0;
  try {
    const h = _factBridge.createCache({ sessionId, vaultKey, brand });
    if (!h) return 0;
    _factCacheHandle = h;
    if (toolsDir && sessionId) {
      _factWatcherHandle = _factBridge.watchFactsFile({
        toolsDir, sessionId, pollMs: 120, cacheHandle: h,
      }) || 0;
    }
    return h;
  } catch (e) { console.error('[facts] init failed:', e); return 0; }
}
// Subscribe to the preload bridge. When main pushes the session-prelude
// result over `fact-binding:init`, preload converts the hex → Buffer in
// Node context and delivers it here. The hex never enters this JS world.
// When the bridge isn't present (factBinding flag off in preload, or
// test harness loading renderer.js outside Electron) this is a no-op.
try {
  if (_factBridge && typeof _factBridge.onInit === 'function') {
    _factBridge.onInit((cfg) => initFactBinding(cfg || {}));
  }
} catch { /* preload bridge missing — stay off */ }

function _factStreamStart() {
  if (!factBindingEnabled || !_factBridge) return;
  try { _tailHandle = _factBridge.createTailQuarantine({ absoluteMs: 2000 }) || 0; }
  catch (e) { console.warn('[facts] tail-quarantine start failed:', e && e.message); _tailHandle = 0; }
}
function _factStreamConsume(delta) {
  if (!factBindingEnabled || !_factBridge || !_tailHandle) return delta;
  try { return _factBridge.tailPush(_tailHandle, delta); }
  catch (e) { return delta; }
}
function _factStreamFinalize() {
  if (!factBindingEnabled || !_factBridge || !_tailHandle) return '';
  let rest = '';
  try { rest = _factBridge.tailFinalize(_tailHandle) || ''; }
  catch (e) { rest = ''; }
  _tailHandle = 0;
  return rest;
}
function _factApplyPasses(html) {
  if (!factBindingEnabled || !_factBridge || !_factCacheHandle) return html;
  try {
    const r = _factBridge.runAllPasses(html, _factCacheHandle);
    return (r && typeof r.html === 'string') ? r.html : html;
  } catch (e) { console.warn('[facts] passes failed:', e); return html; }
}
function _factMountCharts(rootEl) {
  // Kept for call-site compatibility: _factApplyPasses output now passes
  // through the bridge's mountCharts string transform before innerHTML
  // assignment (see the `currentBubble.innerHTML = ...` sites below).
  // This function is intentionally a no-op; the real work happens in
  // _factApplyAndMount. Left as a named function so existing call sites
  // and profiling tools keep their referents.
  void rootEl;
}
function _factApplyAndMount(html) {
  if (!factBindingEnabled || !_factBridge || !_factCacheHandle) return html;
  const passed = _factApplyPasses(html);
  try {
    const mounted = _factBridge.mountCharts(passed);
    return typeof mounted === 'string' ? mounted : passed;
  } catch (e) { return passed; }
}

const messages = document.getElementById('messages');
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const approval = document.getElementById('approval');

// Platform-specific UI adjustments
if (typeof merlin !== 'undefined' && merlin.platform === 'darwin') {
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
function showModal({ title, body, bodyHTML, bodyNode, inputPlaceholder, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  if (_modalActive) {
    _modalQueue.push({ title, body, bodyHTML, bodyNode, inputPlaceholder, confirmLabel, cancelLabel, onConfirm, onCancel });
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
  if (bodyNode instanceof Node) {
    // Prefer a real DOM node over innerHTML — avoids any interpolation foot-gun
    // for callers that want to embed dynamic content (e.g. links).
    bodyEl.replaceChildren(bodyNode);
  } else if (bodyHTML !== undefined) {
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

// ── Theme Toggle (sun/moon in titlebar) ─────────────────────
// Flips `data-theme` on <html>. The head-inline bootstrap script already
// applied the persisted choice before paint — this handler just flips and
// persists subsequent clicks.
document.getElementById('theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  if (next === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  try { localStorage.setItem('merlin.theme', next); } catch (_) { /* storage disabled */ }
});

// ── Setup Flow ──────────────────────────────────────────────
async function init() {
  // Warmup-perf: every IPC in this function used to be awaited serially before
  // the welcome bubble rendered, which left the chat blank for hundreds of ms
  // after the window painted. Fire version in the background (cosmetic titlebar
  // label), show the welcome immediately, then parallelize the main-process
  // reads that personalize it.
  const vLabel = document.getElementById('version-label');
  if (vLabel && merlin.getVersion) {
    merlin.getVersion().then((info) => {
      if (!info) return;
      const ver = typeof info === 'object' ? info.version : info;
      vLabel.textContent = 'v' + ver;
      const bullets = (typeof info === 'object' && info.whatsNew && info.whatsNew.length)
        ? info.whatsNew.slice(0, 3).map(b => '• ' + b).join('\n')
        : '• Up to date';
      vLabel.dataset.tip = '✦ What\'s New\n' + bullets + '\n\nClick to check for updates';
    }).catch(() => {});

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

  // Show chat immediately with a neutral welcome — no blank screen, no "loading…"
  // verbiage. The bubble paints on the very first frame after the window shows,
  // so the user's perception of "ready" lands immediately. Brand name + briefing
  // detail fills in as soon as the parallel IPCs below resolve (~100–300 ms),
  // and the SDK preflight's "✦ brand is ready — N products loaded" response
  // streams in as the definitive readiness signal.
  const welcomeBubble = addClaudeBubble();
  welcomeBubble.classList.remove('streaming');
  // Neutral initial text — "Welcome back." is wrong for a first-run user and
  // would flash visibly into "Hey — I'm Merlin…" once Promise.all resolves.
  // "Welcome." is accurate for both the returning and new-user branches below.
  welcomeBubble.innerHTML = 'Welcome.';

  // Fire the three main-process reads in parallel (previously awaited serially,
  // ~100 ms × 3 = up to ~300 ms of chained IPC latency during first paint).
  const [existingBrands, savedState, briefing] = await Promise.all([
    merlin.getBrands().catch(() => []),
    merlin.loadState().catch(() => ({})),
    merlin.getBriefing().catch(() => null),
  ]);
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
    // Look up the active brand's prior conversation. If we have one, skip
    // the "Welcome back — loading..." placeholder and paint the history
    // instead — the user resumes exactly where they left off per brand.
    const priorThread = activeBrand
      ? await merlin.getBrandThread(activeBrand).catch(() => ({ bubbles: [] }))
      : { bubbles: [] };
    const hasPriorThread = priorThread && Array.isArray(priorThread.bubbles) && priorThread.bubbles.length > 0;

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
      // No "Welcome back — loading…" filler bubble: the SDK preflight reply
      // ("✦ {brand} is ready — N products loaded") streams in on its own and
      // stands as the actual welcome. A second placeholder sparkle here was
      // pure duplication.
    } else if (!hasPriorThread) {
      // Reuse welcomeBubble as the streaming target for the SDK preflight
      // reply. Wiring `currentBubble` here makes content_block_start's
      // `if (!currentBubble) addClaudeBubble()` skip the new-bubble path,
      // so the reply replaces "Welcome." in place — one sparkle total,
      // no stray empty bubble above the ready message.
      welcomeBubble.classList.add('streaming');
      currentBubble = welcomeBubble;
      textBuffer = '';
    } else {
      // Prior thread will paint; drop the empty welcome bubble so the chat
      // doesn't start with a stray "..." above the restored history.
      // `welcomeBubble` is the inner .msg-bubble element; removing it alone
      // left the wrapper's ✦ avatar orphaned above the first real message.
      // Remove the whole `.msg` wrapper so the avatar goes with it.
      (welcomeBubble.closest('.msg') || welcomeBubble).remove();
      currentBubble = null;
      textBuffer = '';
    }

    // Paint prior conversation history (if any). Non-streaming, no TTS —
    // this is rehydration, not a new response.
    if (hasPriorThread) {
      for (const b of priorThread.bubbles) {
        if (!b || (b.role !== 'user' && b.role !== 'claude')) continue;
        if (typeof b.text !== 'string' || b.text.length === 0) continue;
        renderBubbleFromLog(b.role, b.text);
      }
      scrollToBottom(true);
    }

    // Native progress bar handles onboarding status — no duplicate in chat
  } else {
    // New user — clean welcome, native progress bar handles status
    welcomeBubble.innerHTML = 'Hey — I\'m Merlin, your AI marketing wizard.<br>Tell me your brand or website first, and I\'ll set everything up before we connect stores or ad accounts.';
    renderStarterChips(welcomeBubble, 'new');
  }

  window._welcomeShown = true;

  // Warmup-perf: pre-warm the SDK subprocess in the background so the first
  // user message doesn't pay for a cold spawn + OAuth inject + preflight
  // round-trip. For authenticated returning users the SDK spawns and runs
  // its silent /merlin preflight concurrently with the user reading the
  // welcome; any message they type during warmup queues into
  // pendingMessageQueue (main.js send-message handler) and drains right
  // after the preflight response, so no keystroke is ever lost. For
  // first-run users who aren't signed in, startSession triggers the unified
  // auth-required flow — same behavior as before, just fires proactively
  // instead of waiting for the user's first Enter to surface the missing
  // credentials.
  merlin.checkSetup(false).then(() => { merlin.startSession(); })
    .catch(() => { merlin.startSession(); });
}


// Starter chips under the first welcome bubble. Give new users a visible
// first-click instead of a blank input box. Each chip, when clicked,
// pre-fills the composer and sends it through the normal sendMessage()
// path so the bubble renders like a real user turn and SDK routing runs
// as if the user typed it. Chips vanish once any user message has been
// sent (handled by dismissStarterChips()).
function renderStarterChips(hostBubble, mode) {
  if (!hostBubble) return;
  const row = document.createElement('div');
  row.className = 'starter-chips';
  row.setAttribute('data-starter-chips', '1');
  const presets = mode === 'new'
    ? [
        { glyph: '✦', label: 'Set up my brand',       prompt: 'Help me set up a new brand. Ask me for my website and walk me through the rest.' },
        { glyph: '🎨', label: 'Make a sample ad',      prompt: 'Make a sample ad so I can see what Merlin can do.' },
        { glyph: '🎓', label: 'Show me how Merlin works', prompt: 'Give me a quick tour of what Merlin can do for my marketing.' },
      ]
    : [
        { glyph: '📈', label: 'How are my ads?',      prompt: 'How are my ads performing right now? Show me the cross-platform dashboard.' },
        { glyph: '🎨', label: 'Make an ad',            prompt: 'Make me a new ad. Ask me which product and which platform.' },
        { glyph: '🚀', label: 'Push to Meta',          prompt: 'Push my latest ad to Meta. Show me the preview and cost before anything runs.' },
        { glyph: '🔍', label: 'Audit my SEO',          prompt: 'Audit my SEO — find the highest-impact wins I can ship this week.' },
        { glyph: '📧', label: 'Plan an email',         prompt: 'Plan a Klaviyo email campaign. Ask me which flow (welcome / cart / win-back / etc.).' },
      ];
  presets.forEach(p => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'starter-chip';
    chip.innerHTML = `<span class="starter-chip-glyph">${p.glyph}</span><span class="starter-chip-label"></span>`;
    chip.querySelector('.starter-chip-label').textContent = p.label;
    chip.addEventListener('click', () => {
      if (!input) return;
      input.value = p.prompt;
      try { autoResize(); } catch {}
      dismissStarterChips();
      sendMessage();
    });
    row.appendChild(chip);
  });
  hostBubble.appendChild(row);
}

function dismissStarterChips() {
  document.querySelectorAll('[data-starter-chips]').forEach(el => el.remove());
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
  _factStreamStart(); // arms tail quarantine for this bubble; no-op when flag is off
  scrollToBottom();
  return bubble;
}

// Render a persisted bubble (no streaming, no scroll, no TTS, no sparkle).
// Used to rehydrate the chat from the per-brand thread store on startup
// and on brand switch. Kept isolated from addUserBubble/addClaudeBubble so
// live-streaming state (currentBubble, textBuffer) is never disturbed.
function renderBubbleFromLog(role, text) {
  if (role === 'user') {
    const div = document.createElement('div');
    div.className = 'msg msg-user';
    div.style.whiteSpace = 'pre-wrap';
    div.textContent = String(text);
    messages.appendChild(div);
    return div;
  }
  if (role === 'claude') {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-claude';
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = '✦';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.innerHTML = renderMarkdown(String(text));
    // Replay button so the user can still hear past responses aloud.
    if (typeof addReplayButton === 'function') {
      try { addReplayButton(bubble, String(text)); } catch {}
    }
    wrapper.appendChild(avatar);
    wrapper.appendChild(bubble);
    messages.appendChild(wrapper);
    return bubble;
  }
  return null;
}

// Visual divider inserted into the chat when the user switches brands. Makes
// the context boundary obvious — the prior conversation is still visible but
// clearly sits "above" the new brand's history.
function renderBrandDivider(label) {
  const div = document.createElement('div');
  div.className = 'msg-divider brand-divider';
  div.style.cssText = 'text-align:center;color:var(--muted,#888);font-size:12px;padding:12px 0;border-top:1px solid var(--border,#2a2a2a);border-bottom:1px solid var(--border,#2a2a2a);margin:12px 0;letter-spacing:0.05em;';
  div.textContent = `— now working in ${label} —`;
  messages.appendChild(div);
  return div;
}

// Replace the entire chat with a rehydrated thread. Finalizes any streaming
// bubble first so the old session's half-rendered turn doesn't orphan state.
function paintBrandThread(bubbles) {
  try { finalizeBubble(); } catch {}
  messages.innerHTML = '';
  currentBubble = null;
  textBuffer = '';
  isStreaming = false;
  if (!Array.isArray(bubbles) || bubbles.length === 0) return 0;
  for (const b of bubbles) {
    if (!b || (b.role !== 'user' && b.role !== 'claude')) continue;
    if (typeof b.text !== 'string' || b.text.length === 0) continue;
    renderBubbleFromLog(b.role, b.text);
  }
  scrollToBottom(true);
  return bubbles.length;
}

let lastRenderedLength = 0;

function appendText(text) {
  // Fact binding: pass the delta through the tail quarantine before it joins
  // the text buffer. When the flag is off this returns `text` unchanged, so
  // the streaming behavior is identical to before.
  const safeDelta = _factStreamConsume(text);
  textBuffer += safeDelta;
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      if (currentBubble && textBuffer.length !== lastRenderedLength) {
        // Strip leading <voice>speak|silent</voice> before render so the
        // UI metadata tag never flashes visibly during streaming.
        const { speak, cleaned, resolved } = stripVoiceTag(textBuffer);
        // Fact binding pass 1/2/3 + chart mount applies to the rendered
        // HTML. No-op when disabled or the cache is absent. Combined into
        // a single bridge round-trip (_factApplyAndMount) so we hit the
        // preload once per frame instead of twice.
        currentBubble.innerHTML = _factApplyAndMount(renderMarkdown(cleaned));
        _factMountCharts(currentBubble); // no-op shim; see helper comment
        lastRenderedLength = textBuffer.length;
        // Streaming TTS: feed complete sentences as they arrive so the
        // wizard starts speaking while Claude is still typing. Guarded on
        // resolved so we never synth the raw "<voice>speak</voice>" tag
        // before we know what Claude is opening with.
        if (voiceEnabled && speak && resolved && cleaned.length > 0) {
          _flushStreamingSpeakSentences(currentBubble, cleaned);
        }
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
    // Flush any bytes the tail quarantine was holding so the completed
    // bubble has the full text. No-op when fact binding is disabled.
    const tailRest = _factStreamFinalize();
    if (tailRest) textBuffer += tailRest;
    const { speak, cleaned } = stripVoiceTag(textBuffer);
    currentBubble.innerHTML = _factApplyAndMount(renderMarkdown(cleaned));
    _factMountCharts(currentBubble);
    // Assistant bubbles get a replay button + stored raw text so the user
    // can hear any past message even when the global toggle was off.
    if (cleaned && cleaned.trim().length > 0) {
      currentBubble.dataset.speakText = cleaned;
      addReplayButton(currentBubble, cleaned);
    }
    if (voiceEnabled && speak && cleaned && cleaned.trim().length > 0) {
      // If a streaming-speak session already fed sentences during the
      // stream, just close it — calling speakMessage here would re-synth
      // the entire response on top of already-playing audio.
      const handledByStream = _finishStreamingSpeak(currentBubble, cleaned);
      if (!handledByStream) speakMessage(cleaned, currentBubble);
    } else if (_streamSpeakState && _streamSpeakState.session.bubbleEl === currentBubble) {
      // Edge case: voice flipped off mid-response (toggle button or Escape
      // already called stopSpeaking, which clears state). If state somehow
      // survived — abandon it cleanly so no stray appends leak to worker.
      _finishStreamingSpeak(currentBubble, cleaned);
    }
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
//
// Idempotent (mirrors artifact-parser.js:toMerlinUrl): an already-encoded
// segment like `foo%20bar.png` MUST NOT become `foo%2520bar.png` when
// re-piped through this helper. Decode first to collapse prior encoding,
// then re-encode canonically; on a stray literal `%` (decode throws) fall
// back to direct encode so filenames like `5%off.png` still produce a
// valid URL.
function merlinUrl(relPath) {
  if (relPath == null) return '';
  const raw = String(relPath);
  // Pass absolute remote URLs through unchanged — used for platform-hosted
  // thumbnails like Meta CDN creative images that ship into ads-live.json
  // as `creativeUrl`. Encoding them through merlin:// would corrupt the
  // scheme and break the <img src>.
  if (/^https?:\/\//i.test(raw)) return raw;
  const clean = raw.replace(/^merlin:\/\//, '');
  return 'merlin://' + clean.split('/').map((seg) => {
    try {
      return encodeURIComponent(decodeURIComponent(seg));
    } catch {
      return encodeURIComponent(seg);
    }
  }).join('/');
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

  // ── Shopify scope-gap (stored token predates a newly-requested scope) ──
  // Sentinel `scope_gap` is emitted by shopifyRequestWithStatus / shopifyGraphQL
  // in autocmo-core when Shopify returns 403 "merchant approval for <scope>".
  // Must come BEFORE the generic 401/403 branches below — re-auth fixes this,
  // the generic "check permissions" message does not.
  if (sl.includes('scope_gap') || (sl.includes('shopify') && sl.includes('merchant approval'))) {
    return 'Your Shopify connection needs to be refreshed to unlock new features.\nTry: Open the ✦ Magic panel and reconnect your Shopify store — it takes 10 seconds.';
  }

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

// REGRESSION GUARD (2026-04-19, Transcription-failed-modal incident):
// transcription errors come back from main.js as classified codes
// (transcribe:empty / :corrupt / :ffmpeg / :whisper / :missing-tools /
// :too-large). The previous path piped raw ffmpeg stderr — including hex
// addresses and a cryptic exit code like 3199971767 — straight into a
// modal, violating the "every user-visible error passes through
// friendlyError()" rule. This helper is the single user-facing mapping;
// if you add a new error code in main.js, add a matching branch here.
// Keep copy short, actionable, and free of technical jargon — it lands
// in a modal right after the user tried to speak.
function humanizeTranscriptionError(code, detail) {
  const c = typeof code === 'string' ? code : '';
  if (c === 'transcribe:empty') return 'I didn\'t catch any audio — hold the mic button a little longer and try again.';
  if (c === 'transcribe:corrupt') return 'The recording got cut short. Try again — hold the mic until you\'re done speaking before releasing.';
  if (c === 'transcribe:too-large') return 'That recording is too long. Try a shorter clip.';
  if (c === 'transcribe:missing-tools') return detail || 'Voice input isn\'t installed. Reinstall Merlin to restore it.';
  if (c === 'transcribe:ffmpeg' || c === 'transcribe:whisper') return 'Something went wrong transcribing that. Try again — if it keeps failing, restart Merlin.';
  // Legacy / unclassified — strings from older main.js builds still land here.
  const s = String(detail || code || '').trim();
  if (!s) return 'Transcription failed. Try again.';
  if (/ebml|invalid data|header parsing/i.test(s)) return 'The recording got cut short. Try again — hold the mic until you\'re done speaking before releasing.';
  if (/ffmpeg exit|whisper exit/i.test(s)) return 'Something went wrong transcribing that. Try again — if it keeps failing, restart Merlin.';
  return 'Transcription failed. Try again.';
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
      // Surface any undo toasts now that the turn has fully ended.
      try { flushUndoQueue(); } catch {}
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
      const input = event.content_block.input || {};
      queueKillForUndo(toolName, input);
      const labels = {
        'Bash': 'Casting a spell', 'Read': 'Reading the scrolls', 'Write': 'Inscribing',
        'Edit': 'Refining the formula', 'Glob': 'Scanning the vault', 'Grep': 'Divining patterns',
        'WebSearch': 'Consulting the oracle', 'WebFetch': 'Summoning knowledge',
        'Agent': 'Dispatching a familiar', 'TodoWrite': 'Charting the course',
        'AskUserQuestion': 'Awaiting your wisdom',
      };
      // MCP Merlin tools — specific labels per action so users see what's happening
      // instead of the generic "Channeling" fallback. Image/video/voice runs can
      // take minutes; a precise label prevents "taking a while…" dead-air confusion.
      let label = labels[toolName];
      if (!label && typeof toolName === 'string' && toolName.indexOf('mcp__merlin__') === 0) {
        const tool = toolName.slice('mcp__merlin__'.length);
        const action = (input && typeof input.action === 'string') ? input.action : '';
        const count = (input && typeof input.count === 'number' && input.count > 0) ? input.count : 0;
        if (tool === 'image' || tool === 'content') {
          label = count > 1 ? ('Brewing ' + count + ' images') : 'Brewing an image';
        } else if (tool === 'video') {
          label = 'Rendering video (this can take a few minutes)';
        } else if (tool === 'voice') {
          label = action === 'clone' ? 'Cloning voice' : 'Synthesizing voice';
        } else if (tool === 'email') {
          label = 'Drafting email';
        } else if (tool === 'seo') {
          label = action === 'audit' ? 'Auditing site' : 'Researching keywords';
        } else if (tool === 'dashboard') {
          label = 'Reading performance';
        } else if (tool === 'meta_ads' || tool === 'tiktok_ads' || tool === 'google_ads' || tool === 'amazon_ads' || tool === 'reddit_ads') {
          const platform = tool.replace('_ads', '').replace(/^./, function (c) { return c.toUpperCase(); });
          if (action === 'push') label = 'Publishing ' + platform + ' ad';
          else if (action === 'kill') label = 'Pausing ' + platform + ' ad';
          else if (action === 'duplicate') label = 'Scaling ' + platform + ' ad';
          else if (action === 'insights') label = 'Reading ' + platform + ' insights';
          else if (action === 'setup') label = 'Setting up ' + platform + ' campaign';
          else label = 'Talking to ' + platform;
        } else if (tool === 'shopify') {
          label = 'Reading Shopify';
        } else if (tool === 'klaviyo') {
          label = 'Reading Klaviyo';
        } else if (tool === 'platform_login') {
          label = 'Connecting platform';
        } else if (tool === 'connection_status') {
          label = 'Checking connections';
        } else if (tool === 'config') {
          label = 'Updating config';
        } else {
          label = 'Channeling';
        }
      }
      if (!label) label = 'Channeling';
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
    // REGRESSION GUARD (2026-04-14, Codex P3 #6 — stale Desktop nudges):
    // Merlin no longer requires Claude Desktop — auth runs through the
    // in-app OAuth flow (triggerClaudeLogin above). These recovery
    // messages used to tell users to "open Claude Desktop and make
    // sure you're logged in", which was dead advice that pointed at
    // the wrong app. Phrase recoveries in terms of the in-app sign-in
    // the user has already seen.
    let reason;
    if (isClaudeNotFound) {
      reason = 'Merlin could not find its Claude connection. Please reinstall Merlin.';
    } else if (isAuthError) {
      reason = 'Your Claude session has expired. Click Retry to sign in again.';
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
        // REGRESSION GUARD (2026-04-14, Codex P1 #1 — duplicate replay):
        // Do NOT call addUserBubble() here. The original user bubble
        // is already in the DOM from the first sendMessage() call
        // (renderer.js line ~3071) — calling addUserBubble again
        // creates a visible duplicate of the same prompt.
        //
        // The renderer IS still responsible for replaying via
        // merlin.sendMessage(): there are two auth-failure scenarios
        // and they have different queue states.
        //
        //   A) Pre-session auth fail (no creds at startSession):
        //      message sits in pendingMessageQueue, frozen.
        //   B) Mid-session auth fail (SDK throws 401 while running):
        //      message was consumed via resolveNextMessage() and is
        //      NOT in the queue — nothing would replay without us.
        //
        // Main's send-message handler is the single source of truth
        // for de-duplication: when _queueFrozenForAuth is set, it
        // clears any stale belt-and-suspenders copy before pushing
        // the renderer's authoritative replay. So calling sendMessage
        // here is safe for BOTH scenarios and results in exactly one
        // delivery to Claude.
        //
        // Do NOT "simplify" this to call startSession() — that loses
        // scenario B (mid-session). Do NOT re-add addUserBubble —
        // that visibly duplicates scenario A.
        if (pendingMessage) {
          setStatus('Signed in — continuing your request...');
          // Small delay so the user sees the transition
          await new Promise(r => setTimeout(r, 250));
          bubble.remove(); // remove the "signing in" status bubble
          _lastUserMessage = pendingMessage;
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
        // REGRESSION GUARD (2026-04-14, Codex P1 #1): see the long
        // comment in the onAuthRequired handler above. DO NOT
        // addUserBubble — the original is still in the DOM and we'd
        // visibly duplicate it. sendMessage is still the right replay
        // path; main.js's send-message handler clears the stale
        // belt-and-suspenders queue copy (via the _queueFrozenForAuth
        // check) before pushing, so Claude receives the prompt exactly
        // once.
        bubble.remove();
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
function paintQrPayload(img, url, note, payload) {
  img.src = payload.qrDataUri;
  url.textContent = payload.pwaUrl;
  // Surface the fallback so a phone on cellular doesn't silently get a LAN
  // URL that only works on the same WiFi.
  if (payload.mode === 'lan') {
    note.textContent = payload.relayError
      ? `Roaming unavailable (${payload.relayError}) — same-WiFi fallback only.`
      : 'Roaming unavailable — same-WiFi fallback only.';
    note.classList.remove('hidden');
  } else {
    note.textContent = '';
    note.classList.add('hidden');
  }
}

document.getElementById('mobile-btn').addEventListener('click', async () => {
  const modal = document.getElementById('qr-modal');
  const img = document.getElementById('qr-image');
  const url = document.getElementById('qr-url');
  const note = document.getElementById('qr-mode-note');
  // Main pre-warms the QR at app start, so the IPC almost always returns a
  // cached payload in <5ms. Race that against a 60ms timer: if the cache is
  // warm we paint *before* showing the modal (no broken-image flash); if
  // it's cold we open the modal with a placeholder so the button still
  // feels responsive while the relay handshake completes.
  const ipc = merlin.getMobileQR();
  const fast = await Promise.race([
    ipc.then(p => ({ ok: true, payload: p }), e => ({ ok: false, err: e })),
    new Promise(resolve => setTimeout(() => resolve(null), 60)),
  ]);
  if (fast && fast.ok) {
    paintQrPayload(img, url, note, fast.payload);
    modal.classList.remove('hidden');
    return;
  }
  // Cold path — show neutral placeholder, then paint when IPC settles.
  // Either the 60ms timer beat the IPC (fast === null) or the IPC settled
  // with an error (fast.ok === false) and we surface it via catch.
  img.removeAttribute('src');
  url.textContent = 'Generating pairing QR…';
  note.textContent = '';
  note.classList.add('hidden');
  modal.classList.remove('hidden');
  try {
    if (fast && !fast.ok) throw fast.err;
    const payload = await ipc;
    paintQrPayload(img, url, note, payload);
  } catch (err) {
    // Rule 6: raw IPC errors must pass through friendlyError before surfacing
    // to the user — `err.message` can carry Go stack traces or relay details
    // we don't want leaking into the QR modal.
    url.textContent = friendlyError(String(err && err.message || err), 'Mobile');
  }
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
// Display names for the brand/platform tiles. Naive capitalize()
// mangles "Tiktok", "Linkedin", "Elevenlabs", "Heygen" — use the
// canonical brand casing instead. Falls back to capitalize() for
// platforms not listed here.
const PLATFORM_DISPLAY_NAMES = {
  meta: 'Meta', tiktok: 'TikTok', google: 'Google Ads', amazon: 'Amazon',
  reddit: 'Reddit', linkedin: 'LinkedIn', shopify: 'Shopify', etsy: 'Etsy',
  klaviyo: 'Klaviyo', pinterest: 'Pinterest', snapchat: 'Snapchat',
  twitter: 'X', slack: 'Slack', discord: 'Discord', stripe: 'Stripe',
  fal: 'fal.ai', elevenlabs: 'ElevenLabs', heygen: 'HeyGen', arcads: 'Arcads',
  foreplay: 'Foreplay',
};
function platformDisplayName(platform) {
  if (!platform) return '';
  if (PLATFORM_DISPLAY_NAMES[platform]) return PLATFORM_DISPLAY_NAMES[platform];
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

// ── Vertical Profiles (mirrors autocmo-core/vertical.go) ────────
// Canonical business-category registry. The Go binary's vertical.go is the
// single source of truth — every field/key here must match it exactly so
// the setup flow, dashboard defaults, and renderer stay in sync. When you
// add or rename a vertical: edit vertical.go first, then mirror the change
// here. Keep this in JS (rather than IPC'ing into the binary on every
// render) because context menus, tile filters, and offering-noun lookups
// all fire on user events — a 100-500ms binary roundtrip per event would
// be visibly sluggish.
//
// The visual-creative tools (fal/elevenlabs/heygen/arcads) and social
// plumbing (slack/discord) are applicable to every vertical that runs
// ads, so we append them from BASE_CREATIVE_TOOLS instead of re-listing
// in each row. Previously these were missing from SaaS / local and
// caused otherwise-connected tiles to hide.
const BASE_CREATIVE_TOOLS = ['fal','elevenlabs','heygen','arcads','slack','discord'];
const VERTICAL_PROFILES = {
  ecommerce: {
    key: 'ecommerce',
    label: 'eCommerce',
    offeringNoun: 'product',
    offeringNounPlural: 'products',
    audienceNoun: 'customers',
    primaryKPI: 'revenue',
    defaultRevenueConnector: 'shopify',
    hasShoppableCatalog: true,
    integrations: ['meta','tiktok','shopify','stripe','klaviyo','google','pinterest','amazon','reddit','etsy','snapchat','twitter','linkedin', ...BASE_CREATIVE_TOOLS],
  },
  saas: {
    key: 'saas',
    label: 'SaaS',
    offeringNoun: 'plan',
    offeringNounPlural: 'plans',
    audienceNoun: 'users',
    primaryKPI: 'MRR',
    defaultRevenueConnector: 'stripe',
    hasShoppableCatalog: false,
    integrations: ['meta','google','linkedin','stripe','klaviyo','reddit','twitter', ...BASE_CREATIVE_TOOLS],
  },
  games: {
    key: 'games',
    label: 'Games',
    offeringNoun: 'title',
    offeringNounPlural: 'titles',
    audienceNoun: 'players',
    primaryKPI: 'installs',
    defaultRevenueConnector: 'stripe',
    hasShoppableCatalog: false,
    integrations: ['meta','tiktok','google','stripe','reddit','snapchat','twitter', ...BASE_CREATIVE_TOOLS],
  },
  creator: {
    key: 'creator',
    label: 'Creator',
    offeringNoun: 'course',
    offeringNounPlural: 'courses',
    audienceNoun: 'students',
    primaryKPI: 'enrollments',
    defaultRevenueConnector: 'stripe',
    hasShoppableCatalog: false,
    integrations: ['meta','tiktok','google','twitter','reddit','klaviyo','stripe', ...BASE_CREATIVE_TOOLS],
  },
  local: {
    key: 'local',
    label: 'Local Services',
    offeringNoun: 'service',
    offeringNounPlural: 'services',
    audienceNoun: 'clients',
    primaryKPI: 'leads',
    defaultRevenueConnector: '',
    hasShoppableCatalog: false,
    integrations: ['meta','google','reddit', ...BASE_CREATIVE_TOOLS],
  },
  agency: {
    key: 'agency',
    label: 'Agency',
    offeringNoun: 'engagement',
    offeringNounPlural: 'engagements',
    audienceNoun: 'clients',
    primaryKPI: 'qualified leads',
    defaultRevenueConnector: 'stripe',
    hasShoppableCatalog: false,
    integrations: ['linkedin','meta','google','twitter','reddit','stripe','klaviyo', ...BASE_CREATIVE_TOOLS],
  },
  b2b: {
    key: 'b2b',
    label: 'B2B',
    offeringNoun: 'solution',
    offeringNounPlural: 'solutions',
    audienceNoun: 'accounts',
    primaryKPI: 'pipeline',
    defaultRevenueConnector: 'stripe',
    hasShoppableCatalog: false,
    integrations: ['linkedin','google','meta','twitter','reddit','stripe', ...BASE_CREATIVE_TOOLS],
  },
};

// Fallback profile for brands with an unrecognized or empty vertical.
// Never special-cases as ecommerce — if we don't know, we don't assume
// the user has products to push, which would surface Shopify/Etsy
// tiles to a SaaS owner.
const UNKNOWN_VERTICAL_PROFILE = {
  key: '',
  label: 'Unspecified',
  offeringNoun: 'offering',
  offeringNounPlural: 'offerings',
  audienceNoun: 'customers',
  primaryKPI: 'revenue',
  defaultRevenueConnector: '',
  hasShoppableCatalog: false,
  // When vertical is unknown we show every tile — better to reveal than
  // hide, because a mis-detected vertical shouldn't amputate the UI.
  integrations: null,
};

// Alias table — free-form user input → canonical key. Matches the
// NormalizeVertical function in autocmo-core/vertical.go. Keep the
// two in sync when adding verticals. "ecom" is the most common legacy
// alias in existing brand.md files; map it to the canonical "ecommerce".
const VERTICAL_ALIASES = {
  'ecom': 'ecommerce',
  'e-com': 'ecommerce',
  'e-commerce': 'ecommerce',
  'dtc': 'ecommerce',
  'd2c': 'ecommerce',
  'shopify': 'ecommerce',
  'retail': 'ecommerce',
  'apparel': 'ecommerce',
  'fashion': 'ecommerce',
  'skincare': 'ecommerce',
  'beauty': 'ecommerce',
  'cpg': 'ecommerce',
  'software': 'saas',
  'platform': 'saas',
  'game': 'games',
  'gaming': 'games',
  'info-product': 'creator',
  'course': 'creator',
  'coach': 'creator',
  'coaching': 'creator',
  'newsletter': 'creator',
  'services': 'local',
  'service': 'local',
  'consultancy': 'agency',
  'consultant': 'agency',
  'enterprise': 'b2b',
  'b-to-b': 'b2b',
};

function normalizeVertical(raw) {
  if (!raw) return '';
  const lower = String(raw).trim().toLowerCase();
  if (!lower) return '';
  if (VERTICAL_PROFILES[lower]) return lower;
  if (VERTICAL_ALIASES[lower]) return VERTICAL_ALIASES[lower];
  // Substring match for compound inputs ("game studio", "marketing agency").
  if (/\bb2b\b|business-to-business|enterprise/.test(lower)) return 'b2b';
  if (/\bgame/.test(lower)) return 'games';
  if (/agency|consultancy|studio/.test(lower)) return 'agency';
  if (/ecom|shopify|apparel|skincare|cpg|online store|retail/.test(lower)) return 'ecommerce';
  if (/saas|software|platform/.test(lower)) return 'saas';
  if (/creator|course|coach|newsletter|info.?product/.test(lower)) return 'creator';
  if (/local|service|plumber|dentist|clinic|hvac/.test(lower)) return 'local';
  return '';
}

function getVerticalProfile(raw) {
  const key = normalizeVertical(raw);
  return VERTICAL_PROFILES[key] || UNKNOWN_VERTICAL_PROFILE;
}

// currentVerticalProfile — module-level cache, refreshed on brand change.
// Kept in sync by updateVertical(). Consumers (kill dialog, tile filter,
// prompt bubbles) read from here instead of re-normalizing every time.
let currentVerticalProfile = UNKNOWN_VERTICAL_PROFILE;

async function loadBrands() {
  try {
    const brands = await merlin.getBrands();
    const select = document.getElementById('brand-select');
    const state = await merlin.loadState();
    select.innerHTML = '';
    const addBrandOption = () => {
      const addOpt = document.createElement('option');
      addOpt.value = '__add__';
      addOpt.textContent = '+ New Brand';
      select.appendChild(addOpt);
    };
    if (!brands || brands.length === 0) {
      select.innerHTML = '<option value="">No brand</option>';
      addBrandOption();
      select.value = '';
      select.dataset.lastValue = '';
      updateVertical('');
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
    addBrandOption();

    if (!savedBrand && brands[0]) select.querySelector('option').selected = true;
    select.dataset.lastValue = selectedBrand?.name || brands[0]?.name || '';
    if (selectedBrand?.vertical) updateVertical(selectedBrand.vertical);
  } catch (err) { console.warn('[brands]', err); }
}

function updateVertical(vertical) {
  const tag = document.getElementById('vertical-tag');
  const tiles = document.querySelectorAll('.magic-tile');
  const profile = getVerticalProfile(vertical);
  currentVerticalProfile = profile;

  if (tag) {
    // Read-only status pill: confirms what Merlin inferred at onboarding so
    // the user knows the tailoring is in effect. No click affordance — the
    // vertical follows the active brand. To re-classify, edit brand.md or
    // re-run /merlin setup for that brand.
    if (profile.key) {
      tag.textContent = profile.label;
      tag.title = `Category: ${profile.label} (set during setup)`;
      tag.style.display = '';
    } else if (vertical) {
      tag.textContent = vertical;
      tag.title = 'Category: unrecognized — re-run /merlin to re-classify';
      tag.style.display = '';
    } else {
      // Hide the chip entirely until onboarding writes a vertical.
      tag.textContent = '';
      tag.title = '';
      tag.style.display = 'none';
    }
    tag.style.cursor = 'default';
  }

  // Tile filter: only hide tiles when we recognize the vertical. Unknown
  // vertical → show everything (user hasn't picked yet, don't amputate
  // the UI based on a guess).
  if (profile.integrations) {
    tiles.forEach(tile => {
      tile.style.display = profile.integrations.includes(tile.dataset.platform) ? '' : 'none';
    });
  } else {
    tiles.forEach(t => { t.style.display = ''; });
  }
}

document.getElementById('brand-select').addEventListener('change', async (e) => {
  // Handle "+ New Brand" option
  if (e.target.value === '__add__') {
    // Reset to previous selection
    e.target.value = e.target.dataset.lastValue || '';
    startBrandSetupConversation();
    return;
  }

  const newBrand = e.target.value;
  const prevBrand = e.target.dataset.lastValue || '';
  // Do NOT update lastValue until we know the swap succeeded. Previously we
  // wrote newBrand here eagerly — on IPC rejection or a `success: false`
  // response, the dropdown was reverted to prevBrand but lastValue had
  // already advanced, so the NEXT change event computed the wrong prevBrand
  // and the rollback-on-failure logic revert-to-prevBrand reverted to a
  // brand the user was never actually working in. Symptom: "— now working
  // in MadChill —" divider sticks around after a failed switch to IvoryElla.

  // Brand context swap — the main process aborts the current SDK turn,
  // resumes the target brand's SDK session by ID, and returns that brand's
  // bubble log. We repaint the chat synchronously so the switch feels
  // immediate; the new SDK session boots in the background. Never inferred
  // from conversation content — only this explicit dropdown change fires.
  let swapResult = null;
  if (newBrand) {
    try {
      swapResult = await merlin.switchBrand(newBrand);
    } catch (err) {
      console.warn('[switch-brand]', err);
    }
  }

  if (swapResult && swapResult.success) {
    e.target.dataset.lastValue = newBrand || '';
    paintBrandThread(swapResult.bubbles);
    // Only show the divider if we actually switched between distinct
    // brands — selecting the same brand again shouldn't pollute the chat.
    if (prevBrand && prevBrand !== newBrand) {
      const label = (() => {
        try {
          const opt = e.target.querySelector(`option[value="${CSS.escape(newBrand)}"]`);
          return opt?.textContent?.trim() || newBrand;
        } catch { return newBrand; }
      })();
      renderBrandDivider(label);
    }
  } else {
    // Swap either rejected (IPC threw) or returned { success: false }.
    // In both cases the UI must revert to prevBrand so the dropdown matches
    // the brand whose SDK session is still live. Without the revert on a
    // thrown swap, the dropdown would advertise the new brand while the
    // session kept running as the old one.
    if (swapResult && !swapResult.success) {
      console.warn('[switch-brand] failed:', swapResult.error);
    }
    if (prevBrand) e.target.value = prevBrand;
    // lastValue already matches prevBrand (we didn't advance it above), so
    // no rollback needed here.
    return;
  }

  // Update peripheral UI (vertical, connections, spells, perf) for the new brand.
  merlin.getBrands().then((brands) => {
    const brand = brands.find(b => b.name === newBrand);
    if (brand?.vertical) updateVertical(brand.vertical);
    else updateVertical('');
  }).catch((err) => { console.warn('[brands]', err); });
  loadConnections();
  loadSpells();
  const activePeriod = document.querySelector('.perf-period-btn.active')?.dataset.days || '7';
  const cached = perfState.cache[newBrand]?.[parseInt(activePeriod)];
  if (cached) renderPerfBar(cached);
  else renderPerfBarSkeleton();
  loadPerfBar(parseInt(activePeriod), newBrand);
});

// add-brand-btn moved into brand dropdown as "+ New Brand" option

function startBrandSetupConversation(prompt = 'Set up a new brand for me') {
  addUserBubble(prompt);
  showTypingIndicator();
  turnStartTime = Date.now();
  turnTokens = 0;
  sessionActive = true;
  startTickingTimer();
  merlin.sendMessage(prompt);
}

function getActiveBrandSelection() {
  const value = document.getElementById('brand-select')?.value || '';
  return value && value !== '__add__' ? value : '';
}

function getBrandRequiredMessage(platform) {
  if (platform === 'shopify') {
    return 'Set up a brand with Merlin before connecting your store.';
  }
  return 'Set up a brand with Merlin before connecting this platform.';
}

function promptBrandSetupBeforeConnect(platform) {
  const body = platform === 'shopify'
    ? 'Set up a brand with Merlin before connecting your store. Merlin will grab the website, product context, and brand details first so Shopify lands in the right place.'
    : `Set up a brand with Merlin before connecting ${platformDisplayName(platform)}. Merlin needs a brand context first so this connection is saved to the right business.`;
  showModal({
    title: 'Set Up A Brand First',
    body,
    confirmLabel: 'Set Up Brand',
    cancelLabel: 'Not Now',
    onConfirm: () => startBrandSetupConversation(),
  });
}

// ── Revenue Tracker (Merlin Made Me) ────────────────────────
function fmtMoney(n) {
  if (n == null || isNaN(n)) return '--';
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return '$' + Math.round(n);
}

const STATS_PERIOD_LABELS = { 1: 'Yesterday', 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last 12 months' };

const PLATFORM_DISPLAY = {
  'Meta Ads': 'Meta', 'meta': 'Meta',
  'Google Ads': 'Google', 'google': 'Google',
  'TikTok Ads': 'TikTok', 'tiktok': 'TikTok',
  'Amazon Ads': 'Amazon', 'amazon': 'Amazon',
  'LinkedIn Ads': 'LinkedIn', 'linkedin': 'LinkedIn',
};
function platformShortName(p) { return PLATFORM_DISPLAY[p] || p || ''; }

function setStatsEmpty() {
  ['stats-revenue','stats-roas','stats-spend','stats-customers'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '--';
  });
  document.getElementById('stats-period').textContent = 'No data yet — run a performance check first';
  document.getElementById('stats-story').textContent = '';
  document.getElementById('stats-top-ad').textContent = '';
  document.getElementById('stats-bar-spend').style.width = '50%';
  document.getElementById('stats-bar-revenue').style.width = '50%';
  document.getElementById('stats-bar-spend').querySelector('.stats-bar-label').textContent = '';
  document.getElementById('stats-bar-revenue').querySelector('.stats-bar-label').textContent = '';
  const pill = document.getElementById('stats-trend-pill');
  if (pill) { pill.classList.add('hidden'); pill.textContent = ''; pill.classList.remove('up','down','flat'); }
  const label = document.getElementById('stats-revenue-label');
  if (label) label.textContent = 'revenue from Merlin\u2019s ads';
  setStatsPeriodActive(null);
}

function setStatsPeriodActive(days) {
  document.querySelectorAll('.stats-period-btn').forEach(btn => {
    const d = parseInt(btn.dataset.days, 10);
    if (days && d === days) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}

function updateStatsBarAndStory(rev, spend, mer) {
  const total = rev + spend;
  if (total > 0) {
    const spendPct = Math.max(10, Math.round((spend / total) * 100));
    const revPct = 100 - spendPct;
    document.getElementById('stats-bar-spend').style.width = spendPct + '%';
    document.getElementById('stats-bar-revenue').style.width = revPct + '%';
    document.getElementById('stats-bar-spend').querySelector('.stats-bar-label').textContent = fmtMoney(spend) + ' spent';
    document.getElementById('stats-bar-revenue').querySelector('.stats-bar-label').textContent = fmtMoney(rev) + ' back';
  } else {
    document.getElementById('stats-bar-spend').style.width = '50%';
    document.getElementById('stats-bar-revenue').style.width = '50%';
    document.getElementById('stats-bar-spend').querySelector('.stats-bar-label').textContent = '';
    document.getElementById('stats-bar-revenue').querySelector('.stats-bar-label').textContent = '';
  }
  if (mer > 0 && spend > 0) {
    document.getElementById('stats-story').textContent = '$1 in \u2192 $' + mer.toFixed(2) + ' out';
  } else if (rev > 0) {
    document.getElementById('stats-story').textContent = fmtMoney(rev) + ' in revenue tracked';
  } else {
    document.getElementById('stats-story').textContent = '';
  }
}

function renderStatsTrendPill(trend) {
  const pill = document.getElementById('stats-trend-pill');
  if (!pill) return;
  pill.classList.remove('up', 'down', 'flat');
  if (trend == null || isNaN(trend)) {
    pill.classList.add('hidden');
    pill.textContent = '';
    return;
  }
  const rounded = Math.round(trend);
  let arrow, cls;
  if (rounded > 0) { arrow = '\u2191'; cls = 'up'; }
  else if (rounded < 0) { arrow = '\u2193'; cls = 'down'; }
  else { arrow = '\u2192'; cls = 'flat'; }
  pill.classList.add(cls);
  pill.classList.remove('hidden');
  pill.textContent = `${arrow} ${Math.abs(rounded)}% vs prior`;
}

function renderStatsTopChannel(topChannel) {
  const el = document.getElementById('stats-top-ad');
  if (!el) return;
  if (!topChannel) { el.textContent = ''; return; }
  const name = platformShortName(topChannel.name);
  const parts = [];
  if (topChannel.revenue > 0 && topChannel.spend > 0) {
    parts.push(`${fmtMoney(topChannel.revenue)} from ${fmtMoney(topChannel.spend)}`);
  } else if (topChannel.spend > 0) {
    parts.push(`${fmtMoney(topChannel.spend)} spent`);
  }
  if (topChannel.roas > 0) parts.push(`${topChannel.roas.toFixed(1)}x return`);
  el.textContent = parts.length > 0 ? `\u2726 Top win: ${name} \u2014 ${parts.join(' \u00b7 ')}` : '';
}

// Paint the whole card from a perf object. Ad-attributed revenue is preferred
// for the hero number (honest — it excludes organic, direct, email, referrals
// that Merlin can't claim credit for). Falls back to total revenue if no ad
// platforms reported purchase value (fresh accounts, TikTok-only, etc.).
function renderStatsCard(perf, days) {
  const totalRev = perf.revenue > 0 ? perf.revenue : 0;
  const adRev = perf.adRevenue > 0 ? perf.adRevenue : 0;
  const spend = perf.spend > 0 ? perf.spend : 0;

  const heroVal = adRev > 0 ? adRev : totalRev;
  const heroIsAdRev = adRev > 0;
  const effMer = heroIsAdRev && spend > 0 ? (adRev / spend) : (perf.mer > 0 ? perf.mer : (spend > 0 ? totalRev / spend : 0));

  document.getElementById('stats-revenue').textContent = heroVal > 0 ? fmtMoney(heroVal) : '--';
  document.getElementById('stats-spend').textContent = spend > 0 ? fmtMoney(spend) : '--';
  document.getElementById('stats-roas').textContent = effMer > 0 ? effMer.toFixed(1) + 'x' : '--';
  document.getElementById('stats-customers').textContent = perf.newCustomers > 0 ? String(perf.newCustomers) : '--';

  const revLabel = document.getElementById('stats-revenue-label');
  if (revLabel) {
    revLabel.textContent = heroIsAdRev
      ? 'revenue from Merlin\u2019s ads'
      : (heroVal > 0 ? 'revenue tracked' : 'revenue from Merlin\u2019s ads');
  }

  document.getElementById('stats-period').textContent = STATS_PERIOD_LABELS[days] || `Last ${days} days`;
  setStatsPeriodActive(days);
  updateStatsBarAndStory(heroVal, spend, effMer);
  renderStatsTrendPill(perf.trend);
  renderStatsTopChannel(perf.topChannel);
}

// populateStatsCard was removed on 2026-04-15 alongside the action-keyed
// legacy fallback in the revenue overlay click handler. The perf bar is now
// the single source of truth for brand-scoped revenue/spend/ROAS, and the
// overlay reads perfState.cache directly. See the REGRESSION GUARD on the
// #perf-bar click handler (codex audit finding #3) before reintroducing any
// action-keyed aggregation on the renderer.

// brand-stats-btn removed — revenue tracker opens via perf bar click

document.getElementById('stats-close').addEventListener('click', () => {
  document.getElementById('stats-overlay').classList.add('hidden');
});

// ── Wisdom Overlay ─────────────────────────────────────────
//
// Wisdom server schema — the client reads BOTH the current and legacy
// shapes so it keeps working during a worker redeploy window.
//
// Current (autocmo-core/wisdom-api/worker.js:aggregate):
//   hooks:     { [name]: {ctr, cpc, roas, win, cpa?, n} }
//   formats?:  { [name]: {ctr, roas, win, n} }
//   timing:    { days: [topDowIndexes], hours: [topHourIndexes] }
//   platforms: { [name]: {ctr, roas?, n} }
//   models?:   { [name]: {roas, win, n} }   (min 2 samples)
//
// Legacy (pre-2026-04-14 worker):
//   timing:    { best_days: [...], best_hours: [...] }
//   platforms: { [name]: {avg_ctr, sample} }
//
// REGRESSION GUARD (2026-04-15, wisdom-collecting incident):
// Shipping a client that only understood the NEW keys made every panel show
// "Collecting..." even when the API returned real numbers. The normalizers
// below read the new key first and fall back to the legacy name so both
// worker versions render the same UI. Don't remove the fallbacks until the
// server redeploy has been verified live (curl the endpoint, confirm `days`
// not `best_days`, `n` not `sample`).

// Known video-generation models. Word-token matching (NOT substring) so a
// name like "taiwan-img" never matches "wan" and "stable-diffusion-luminous"
// never matches "luma". Versioned tokens like "veo3" / "seedance-2" still
// match by stripping trailing digits.
const WISDOM_VIDEO_MODELS = new Set([
  'veo', 'veo2', 'veo3', 'kling', 'seedance', 'minimax', 'hunyuan', 'wan',
  'hailuo', 'luma', 'heygen', 'arcads',
]);

function wisdomIsVideoModel(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  if (WISDOM_VIDEO_MODELS.has(lower)) return true;
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  for (const tok of tokens) {
    if (WISDOM_VIDEO_MODELS.has(tok)) return true;
    const stripped = tok.replace(/\d+$/, '');
    if (stripped && WISDOM_VIDEO_MODELS.has(stripped)) return true;
  }
  return false;
}

function wisdomNormalizeRow(row) {
  if (!row || typeof row !== 'object') return {};
  const out = { ...row };
  if (out.ctr === undefined && row.avg_ctr !== undefined) out.ctr = row.avg_ctr;
  if (out.cpc === undefined && row.avg_cpc !== undefined) out.cpc = row.avg_cpc;
  if (out.roas === undefined && row.avg_roas !== undefined) out.roas = row.avg_roas;
  if (out.win === undefined && row.win_rate !== undefined) out.win = row.win_rate;
  if (out.cpa === undefined && row.avg_cpa !== undefined) out.cpa = row.avg_cpa;
  if (out.n === undefined && row.sample !== undefined) out.n = row.sample;
  if (out.n === undefined && row.samples !== undefined) out.n = row.samples;
  return out;
}

// Server returns "YYYY-MM-DD HH:MM:SS" without a timezone — D1's
// datetime('now') is UTC, so re-attach 'Z' before parsing.
function wisdomRelTime(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const ms = Date.parse(iso.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return '';
  const ageMin = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (ageMin < 1) return 'just now';
  if (ageMin < 60) return `${ageMin}m ago`;
  const hr = Math.round(ageMin / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function wisdomEscHandler(e) {
  if (e.key !== 'Escape') return;
  const overlay = document.getElementById('wisdom-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;
  e.preventDefault();
  closeWisdom();
}

function closeWisdom() {
  document.getElementById('wisdom-overlay').classList.add('hidden');
  document.removeEventListener('keydown', wisdomEscHandler);
}

async function loadWisdom({ force = false } = {}) {
  const grid = document.getElementById('wisdom-grid');
  const sampleEl = document.getElementById('wisdom-sample');
  const refreshBtn = document.getElementById('wisdom-refresh-btn');

  grid.innerHTML = '<div class="wisdom-loading">Loading…</div>';
  if (refreshBtn) refreshBtn.classList.add('refreshing');

  let w = null;
  try { w = await merlin.getWisdom(undefined, { force }); } catch {}

  if (refreshBtn) refreshBtn.classList.remove('refreshing');

  if (!w) {
    sampleEl.textContent = '';
    grid.innerHTML = '<div class="wisdom-loading">No data yet — Wisdom grows as ads run.</div>';
    return;
  }

  await renderWisdom(w);
}

async function renderWisdom(w) {
  const grid = document.getElementById('wisdom-grid');
  const sampleEl = document.getElementById('wisdom-sample');

  const sample = Number(w.sample_size) || 0;
  const ageStr = wisdomRelTime(w.updated);
  if (sample > 0) {
    sampleEl.textContent = `From ${sample.toLocaleString()} anonymized ads${ageStr ? ' · updated ' + ageStr : ''}`;
  } else {
    sampleEl.textContent = 'Collecting data…';
  }

  // Object-shape guards — reject arrays and null masquerading as objects.
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const hooksObj = isPlainObject(w.hooks) ? w.hooks : {};
  const formatsObj = isPlainObject(w.formats) ? w.formats : {};
  const modelsObj = isPlainObject(w.models) ? w.models : {};
  const platformsObj = isPlainObject(w.platforms) ? w.platforms : {};
  const timing = isPlainObject(w.timing) ? w.timing : {};

  const objToSortedArray = (obj, nameKey) => Object.entries(obj)
    .map(([name, v]) => ({ [nameKey]: name, ...wisdomNormalizeRow(v) }))
    .sort((a, b) => (b.roas || 0) - (a.roas || 0));

  // "external" is the Go-side fallback label when inferHookFromName can't
  // parse a hook out of an ad name (see autocmo-core/wisdom.go). It's not a
  // real hook style — it just means "uncategorized externally-created ad" —
  // so it's meaningless at the top of a ranked list. Same story for any
  // empty / "unknown" buckets. Filter them out before ranking; the sample
  // still lives in the server-side aggregate for downstream consumers.
  const MEANINGLESS_HOOKS = new Set(['external', 'unknown', '', 'other', 'uncategorized']);
  const topHooks = objToSortedArray(hooksObj, 'hook')
    .filter(h => !MEANINGLESS_HOOKS.has(String(h.hook || '').toLowerCase()))
    .slice(0, 4);
  const formatList = objToSortedArray(formatsObj, 'name').slice(0, 4);
  const allModels = objToSortedArray(modelsObj, 'model');
  const imageModels = allModels.filter(m => !wisdomIsVideoModel(m.model)).slice(0, 3);
  const videoModels = allModels.filter(m => wisdomIsVideoModel(m.model)).slice(0, 3);
  const platformItems = objToSortedArray(platformsObj, 'platform').slice(0, 4);

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Validate dow ∈ [0,6] and hour ∈ [0,23] before display — server SHOULD
  // clamp these (sanitizeAds in worker.js), but a malformed/legacy row
  // shouldn't render "undefined" or stray indexes to users.
  const timingDaysRaw = Array.isArray(timing.days) ? timing.days
    : Array.isArray(timing.best_days) ? timing.best_days : [];
  const timingHoursRaw = Array.isArray(timing.hours) ? timing.hours
    : Array.isArray(timing.best_hours) ? timing.best_hours : [];
  const bestDays = timingDaysRaw
    .map(i => Number(i))
    .filter(i => Number.isInteger(i) && i >= 0 && i <= 6)
    .map(i => dayNames[i])
    .join(', ');
  const bestHours = timingHoursRaw
    .map(i => Number(i))
    .filter(i => Number.isInteger(i) && i >= 0 && i <= 23)
    .map(hh => {
      const ampm = hh >= 12 ? 'PM' : 'AM';
      return (hh === 0 ? 12 : hh > 12 ? hh - 12 : hh) + ampm;
    })
    .join(', ');

  // Empty-state copy depends on whether the server has ANY samples for
  // the vertical. With samples > 0 but no rows in a dimension, the truth
  // is "not enough variety" not "still collecting" — be honest.
  const emptyMsg = sample > 0
    ? '<div class="wisdom-empty">Not enough variety yet — needs more reports.</div>'
    : '<div class="wisdom-empty">Collecting…</div>';

  function rankRows(items, valFn, colorClass, maxVal) {
    if (!items.length) return emptyMsg;
    const safeMax = Math.max(Number(maxVal) || 0, 0.0001);
    return items.map(item => {
      const val = Math.max(0, Number(valFn(item)) || 0);
      const pct = Math.min(100, (val / safeMax) * 100);
      return `<div class="wisdom-rank">
        <div class="wisdom-rank-row">
          <span class="wisdom-rank-label">${escapeHtml(item.label)}</span>
          <span class="wisdom-rank-value ${colorClass}">${escapeHtml(item.display)}</span>
        </div>
        <div class="wisdom-bar"><div class="wisdom-bar-fill ${colorClass}" style="width:${pct.toFixed(2)}%"></div></div>
        ${item.sub ? `<div class="wisdom-rank-sub">${escapeHtml(item.sub)}</div>` : ''}
      </div>`;
    }).join('');
  }

  const fmtRoas = (r) => (Number(r) || 0).toFixed(2) + 'x';
  const fmtCtr = (c) => (Number(c) || 0).toFixed(2) + '% CTR';
  const fmtWinPct = (wn) => Math.round((Number(wn) || 0) * 100) + '% wins';

  const prettyPlatform = (p) => {
    if (!p) return '';
    const map = { meta: 'Meta', tiktok: 'TikTok', google: 'Google', amazon: 'Amazon', reddit: 'Reddit', linkedin: 'LinkedIn', shopify: 'Shopify', stripe: 'Stripe' };
    return map[String(p).toLowerCase()] || String(p).charAt(0).toUpperCase() + String(p).slice(1);
  };

  const hookItems = topHooks.map(h => ({
    label: h.hook, display: fmtRoas(h.roas), sub: (h.n || 0) + ' ads', val: h.roas || 0,
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

  // Platform card: prefer ROAS as the bar value when ANY platform reports it,
  // else fall back to CTR (legacy worker schema). Once the worker redeploy
  // lands, every platform row carries ROAS and the inconsistency closes.
  const platformHasRoas = platformItems.some(p => (p.roas || 0) > 0);
  const platItems = platformItems.map(p => {
    const ctrPart = p.ctr !== undefined ? fmtCtr(p.ctr) : '';
    const display = platformHasRoas ? fmtRoas(p.roas) : (ctrPart || '—');
    const subParts = [(p.n || 0) + ' ads'];
    if (platformHasRoas && ctrPart) subParts.push(ctrPart);
    return {
      label: prettyPlatform(p.platform),
      display,
      sub: subParts.join(' · '),
      val: platformHasRoas ? (p.roas || 0) : (Number(p.ctr) || 0),
    };
  });

  // Benchmark vs network. Limited to top hooks (4) — the 7-day brand MER is a
  // rough proxy; a precise benchmark would need server-side per-vertical
  // averages (tracked separately).
  const brand = document.getElementById('brand-select')?.value || '';
  const userPerf = perfState.cache[brand]?.[7] || perfState.cache[brand]?.[perfState.currentPeriod];
  let benchmarkHtml = '';
  if (userPerf && topHooks.length > 0) {
    const avgROAS = topHooks.reduce((s, h) => s + (Number(h.roas) || 0), 0) / topHooks.length;
    const userMER = Number(userPerf.mer) || 0;
    const above = userMER >= avgROAS;
    benchmarkHtml = `<div class="wisdom-benchmark">
      <div class="wisdom-card-title">Your Performance vs Network</div>
      <div class="wisdom-benchmark-row">
        <div>
          <span class="wisdom-benchmark-value ${above ? 'positive' : 'negative'}">${userMER > 0 ? userMER.toFixed(1) + 'x' : '—'}</span>
          <span class="wisdom-benchmark-sub">your MER vs ${avgROAS > 0 ? avgROAS.toFixed(1) + 'x' : '—'} top-hook avg</span>
        </div>
        <div class="wisdom-benchmark-sub">${above ? '✦ Above network top-hook average' : '↑ Room to improve — check top hooks'}</div>
      </div>
    </div>`;
  }

  let intelHtml = '';
  if (topHooks.length >= 2) {
    const best = topHooks[0];
    const worst = topHooks[topHooks.length - 1];
    const bestR = Number(best.roas) || 0;
    const worstR = Number(worst.roas) || 0;
    const diff = bestR > 0 && worstR > 0 ? Math.round(((bestR - worstR) / worstR) * 100) : 0;
    if (diff > 10) {
      intelHtml = `<div class="wisdom-callout intel">✦ <strong>${escapeHtml(best.hook)}</strong> hooks outperform <strong>${escapeHtml(worst.hook)}</strong> by ${diff}% in your vertical right now.</div>`;
    }
  }

  // Seasonal insight loaded via IPC from app root — fetch('seasonal.json')
  // resolved relative to app/index.html, which 404'd because the file lives
  // one directory above. IPC reads from app.getAppPath() so the file is
  // packaged in both dev and shipped builds.
  const month = String(new Date().getMonth() + 1);
  let seasonalHtml = '';
  try {
    const seasonal = await merlin.getSeasonal();
    if (seasonal && typeof seasonal === 'object' && typeof seasonal[month] === 'string') {
      seasonalHtml = `<div class="wisdom-callout seasonal">📅 ${escapeHtml(seasonal[month])}</div>`;
    }
  } catch {}

  // Layout: benchmark + callouts are full-width banners. Then two 3-card rows:
  //   Row 1: Top Hooks · Top Platforms · Best Formats   (what's winning)
  //   Row 2: Image Models · Video Models · Best Timing   (how/when)
  // Keeping Image + Video adjacent makes the "pick a model" comparison obvious.
  grid.innerHTML = `
    ${benchmarkHtml}
    ${intelHtml}
    ${seasonalHtml}
    <div class="wisdom-card">
      <div class="wisdom-card-title">Top Hooks <span class="wisdom-card-unit">avg ROAS</span></div>
      ${rankRows(hookItems, i => i.val, 'color-hooks', hookItems.length ? Math.max(...hookItems.map(i => i.val)) : 1)}
    </div>
    <div class="wisdom-card">
      <div class="wisdom-card-title">Top Platforms <span class="wisdom-card-unit">${platformHasRoas ? 'avg ROAS' : 'avg CTR'}</span></div>
      ${rankRows(platItems, i => i.val, 'color-platforms', platItems.length ? Math.max(...platItems.map(i => i.val)) : 1)}
    </div>
    <div class="wisdom-card">
      <div class="wisdom-card-title">Best Formats <span class="wisdom-card-unit">avg ROAS</span></div>
      ${rankRows(fmtItems, i => i.val, 'color-formats', fmtItems.length ? Math.max(...fmtItems.map(i => i.val)) : 1)}
    </div>
    <div class="wisdom-card">
      <div class="wisdom-card-title">Image Models <span class="wisdom-card-unit">avg ROAS</span></div>
      ${rankRows(imgItems, i => i.val, 'color-img', imgItems.length ? Math.max(...imgItems.map(i => i.val)) : 1)}
    </div>
    <div class="wisdom-card">
      <div class="wisdom-card-title">Video Models <span class="wisdom-card-unit">avg ROAS</span></div>
      ${rankRows(vidItems, i => i.val, 'color-vid', vidItems.length ? Math.max(...vidItems.map(i => i.val)) : 1)}
    </div>
    <div class="wisdom-card">
      <div class="wisdom-card-title">Best Timing</div>
      <div class="wisdom-timing-label">BEST DAYS</div>
      <div class="wisdom-timing-value">${escapeHtml(bestDays || (sample > 0 ? '—' : 'Collecting…'))}</div>
      <div class="wisdom-timing-label">BEST HOURS</div>
      <div class="wisdom-timing-value last">${escapeHtml(bestHours || (sample > 0 ? '—' : 'Collecting…'))}</div>
    </div>
  `;
}

document.getElementById('wisdom-header-btn').addEventListener('click', async () => {
  document.getElementById('magic-panel').classList.add('hidden');
  document.getElementById('archive-panel').classList.add('hidden');
  closeAgencyOverlay();
  const overlay = document.getElementById('wisdom-overlay');

  if (!overlay.classList.contains('hidden')) {
    closeWisdom();
    return;
  }

  overlay.classList.remove('hidden');
  document.addEventListener('keydown', wisdomEscHandler);
  await loadWisdom();
});

document.getElementById('wisdom-close').addEventListener('click', closeWisdom);

document.getElementById('wisdom-refresh-btn').addEventListener('click', () => {
  loadWisdom({ force: true });
});
document.getElementById('stats-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'stats-overlay') document.getElementById('stats-overlay').classList.add('hidden');
});

// Share — build a self-contained PNG card via the native Canvas API and drop
// it on the clipboard as image + text. Image is what people actually paste into
// IG Story / X / Discord; text is the fallback when ClipboardItem isn't
// available (older browsers, non-https contexts, privacy-restricted setups).
//
// No new npm dep — the renderer is hand-drawn so the output is identical on
// every machine and doesn't depend on the user's installed fonts or theme.
function drawStatsShareCard() {
  const W = 1080, H = 1350; // IG Story-ish aspect, safe for X/Discord too.
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0a0a0a');
  bg.addColorStop(1, '#141420');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W/2, H*0.35, 100, W/2, H*0.35, W*0.7);
  glow.addColorStop(0, 'rgba(167,139,250,0.15)');
  glow.addColorStop(1, 'rgba(167,139,250,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  const PAD = 80;
  const cardX = PAD, cardY = PAD, cardW = W - PAD*2, cardH = H - PAD*2;
  const r = 44;
  ctx.fillStyle = 'rgba(255,255,255,0.02)';
  ctx.strokeStyle = 'rgba(167,139,250,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cardX+r, cardY);
  ctx.lineTo(cardX+cardW-r, cardY); ctx.quadraticCurveTo(cardX+cardW, cardY, cardX+cardW, cardY+r);
  ctx.lineTo(cardX+cardW, cardY+cardH-r); ctx.quadraticCurveTo(cardX+cardW, cardY+cardH, cardX+cardW-r, cardY+cardH);
  ctx.lineTo(cardX+r, cardY+cardH); ctx.quadraticCurveTo(cardX, cardY+cardH, cardX, cardY+cardH-r);
  ctx.lineTo(cardX, cardY+r); ctx.quadraticCurveTo(cardX, cardY, cardX+r, cardY);
  ctx.closePath(); ctx.fill(); ctx.stroke();

  const brand = document.getElementById('stats-brand-name').textContent || 'Merlin';
  const period = document.getElementById('stats-period').textContent || '';
  const revText = document.getElementById('stats-revenue').textContent || '--';
  const revLabel = document.getElementById('stats-revenue-label').textContent || '';
  const story = document.getElementById('stats-story').textContent || '';
  const spend = document.getElementById('stats-spend').textContent || '--';
  const roas = document.getElementById('stats-roas').textContent || '--';
  const customers = document.getElementById('stats-customers').textContent || '--';
  const topLine = document.getElementById('stats-top-ad').textContent || '';
  const trendPill = document.getElementById('stats-trend-pill');
  const trendText = trendPill && !trendPill.classList.contains('hidden') ? trendPill.textContent : '';
  const trendUp = trendPill?.classList.contains('up');
  const trendDown = trendPill?.classList.contains('down');

  ctx.textAlign = 'center';
  const cx = W / 2;

  // Brand name leads — the old "MERLIN GOT ME" eyebrow was redundant
  // alongside the ✦ Merlin footer wordmark and made the card feel busy.
  let y = cardY + 130;
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 56px -apple-system, Segoe UI, system-ui, sans-serif';
  ctx.fillText(brand, cx, y);

  y += 42;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '500 22px -apple-system, Segoe UI, system-ui, sans-serif';
  ctx.fillText(period, cx, y);

  y += 150;
  const heroGrad = ctx.createLinearGradient(cx-300, y, cx+300, y);
  heroGrad.addColorStop(0, '#34d399');
  heroGrad.addColorStop(1, '#a78bfa');
  ctx.fillStyle = heroGrad;
  ctx.font = '800 160px -apple-system, Segoe UI, system-ui, sans-serif';
  ctx.fillText(revText, cx, y);

  y += 52;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '500 26px -apple-system, Segoe UI, system-ui, sans-serif';
  ctx.fillText(revLabel, cx, y);

  if (trendText) {
    y += 60;
    const pillW = 280, pillH = 54;
    const pillX = cx - pillW/2, pillY = y - pillH/2 + 8;
    ctx.fillStyle = trendUp ? 'rgba(52,211,153,0.15)' : trendDown ? 'rgba(248,113,113,0.15)' : 'rgba(255,255,255,0.08)';
    ctx.strokeStyle = trendUp ? 'rgba(52,211,153,0.5)' : trendDown ? 'rgba(248,113,113,0.5)' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const pr = pillH/2;
    ctx.moveTo(pillX+pr, pillY);
    ctx.lineTo(pillX+pillW-pr, pillY); ctx.quadraticCurveTo(pillX+pillW, pillY, pillX+pillW, pillY+pr);
    ctx.lineTo(pillX+pillW, pillY+pillH-pr); ctx.quadraticCurveTo(pillX+pillW, pillY+pillH, pillX+pillW-pr, pillY+pillH);
    ctx.lineTo(pillX+pr, pillY+pillH); ctx.quadraticCurveTo(pillX, pillY+pillH, pillX, pillY+pillH-pr);
    ctx.lineTo(pillX, pillY+pr); ctx.quadraticCurveTo(pillX, pillY, pillX+pr, pillY);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = trendUp ? '#34d399' : trendDown ? '#f87171' : '#ffffff';
    ctx.font = '700 22px -apple-system, Segoe UI, system-ui, sans-serif';
    ctx.fillText(trendText, cx, y + 19);
  }

  if (story) {
    y += 100;
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 34px -apple-system, Segoe UI, system-ui, sans-serif';
    ctx.fillText(story, cx, y);
  }

  y += 80;
  const cellH = 130, cellW = (cardW - 80) / 3, gap = 20;
  const gridX = cardX + 40;
  const cells = [
    { v: spend, l: 'AD SPEND' },
    { v: roas, l: 'RETURN' },
    { v: customers, l: 'NEW CUSTOMERS' },
  ];
  cells.forEach((c, i) => {
    const x = gridX + i * (cellW + gap) - (gap * (cells.length-1))/cells.length + (i * (gap/cells.length));
    const cellX = gridX + i * ((cardW - 80 - gap*2) / 3 + gap);
    const w = (cardW - 80 - gap*2) / 3;
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    const cr = 16;
    ctx.beginPath();
    ctx.moveTo(cellX+cr, y);
    ctx.lineTo(cellX+w-cr, y); ctx.quadraticCurveTo(cellX+w, y, cellX+w, y+cr);
    ctx.lineTo(cellX+w, y+cellH-cr); ctx.quadraticCurveTo(cellX+w, y+cellH, cellX+w-cr, y+cellH);
    ctx.lineTo(cellX+cr, y+cellH); ctx.quadraticCurveTo(cellX, y+cellH, cellX, y+cellH-cr);
    ctx.lineTo(cellX, y+cr); ctx.quadraticCurveTo(cellX, y, cellX+cr, y);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 42px -apple-system, Segoe UI, system-ui, sans-serif';
    ctx.fillText(c.v, cellX + w/2, y + 60);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '600 16px -apple-system, Segoe UI, system-ui, sans-serif';
    ctx.fillText(c.l, cellX + w/2, y + 100);
  });
  y += cellH;

  if (topLine) {
    y += 50;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = 'italic 500 26px -apple-system, Segoe UI, system-ui, sans-serif';
    const maxW = cardW - 80;
    let txt = topLine;
    while (ctx.measureText(txt).width > maxW && txt.length > 10) {
      txt = txt.slice(0, -4) + '\u2026';
    }
    ctx.fillText(txt, cx, y);
  }

  const footerY = cardY + cardH - 60;
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '600 20px -apple-system, Segoe UI, system-ui, sans-serif';
  ctx.fillText('\u2726 Merlin', cx, footerY);

  return canvas;
}

async function copyShareCardToClipboard() {
  const canvas = drawStatsShareCard();
  // Path 1 — browser ClipboardItem. Fast, zero round-trip. Fails in many
  // Electron window states (unfocused, file:// origin, strict perms).
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      if (blob) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return 'image';
      }
    }
  } catch { /* fall through to IPC */ }
  // Path 2 — Electron main-process clipboard. Bypasses browser sandbox
  // entirely. This is the reliable path; the ClipboardItem attempt above
  // is only there to stay fast when it happens to work.
  try {
    const dataUrl = canvas.toDataURL('image/png');
    const res = await merlin.copyImageDataUrl(dataUrl);
    if (res && res.success) return 'image';
  } catch { /* fall through to save */ }
  // Path 3 — save to disk and reveal. Still an image, never text.
  try {
    const dataUrl = canvas.toDataURL('image/png');
    const name = `merlin-share-${Date.now()}.png`;
    const res = await merlin.saveImageDataUrl(dataUrl, name);
    if (res && res.success) return 'saved';
  } catch { /* fall through */ }
  throw new Error('no-image-clipboard');
}

document.getElementById('stats-share').addEventListener('click', async () => {
  const btn = document.getElementById('stats-share');
  const orig = btn.innerHTML;
  let mode = 'failed';
  try {
    mode = await copyShareCardToClipboard();
  } catch { mode = 'failed'; }
  const label = mode === 'image' ? 'Image copied!'
              : mode === 'saved' ? 'Saved to Downloads'
              : 'Couldn\u2019t copy';
  btn.textContent = label;
  btn.style.background = mode === 'failed' ? '' : 'var(--success)';
  setTimeout(() => { btn.innerHTML = orig; btn.style.background = ''; }, 2000);
});

// Paint the Universal + Brand Specific tile groups with connection state.
//
// Previously the sidebar had separate "Connected" and "Available" sections
// and connected tiles were cloned into the Connected list while the original
// was hidden. The groups-by-scope layout keeps tiles in place — we just
// toggle a `.connected` class on each tile so the visual indicator (green
// accent) shows without re-parenting the DOM. Stubbed / unavailable tiles
// stay in their original position and render dark gray via `.unavailable`.
// Platforms that support a right-click "Use my API key" override — used
// to surface a hint in the tile tooltip so users know the escape hatch
// exists. The canonical list is MANUAL_KEY_HANDLERS (defined below); this
// Set must stay in sync. Kept as a Set for O(1) lookup in loadConnections.
const MANUAL_KEY_PLATFORMS = new Set(['meta', 'shopify']);

function loadConnections() {
  const brand = getActiveBrandSelection();
  merlin.getConnectedPlatforms(brand).then((connected) => {
    const allTiles = document.querySelectorAll('#universal-tiles .magic-tile, #brand-tiles .magic-tile');

    // Reset every tile to its default state first. Stubbed platforms get
    // `.unavailable` sticky-applied so they stay dark gray regardless of
    // connection state — you can't be "connected" to something that isn't
    // shipped yet.
    allTiles.forEach(t => {
      t.classList.remove('connected', 'expired', 'needs-brand');
      if (!t.dataset.baseTip && t.dataset.tip) t.dataset.baseTip = t.dataset.tip;
      if (t.dataset.stubbed === 'true') {
        t.classList.add('unavailable');
      } else {
        t.classList.remove('unavailable');
        t.dataset.tip = t.dataset.baseTip || t.dataset.tip;
        if (!brand && t.dataset.scope === 'brand') {
          t.classList.add('needs-brand');
          t.dataset.tip = getBrandRequiredMessage(t.dataset.platform);
        } else if (MANUAL_KEY_PLATFORMS.has(t.dataset.platform)) {
          // Surface the right-click escape hatch — otherwise users with an
          // existing access token have no affordance that it's available.
          t.dataset.tip = `${t.dataset.baseTip || t.dataset.tip} (right-click to paste a token)`;
        }
      }
    });

    if (!connected || connected.length === 0) return;

    // Build a lookup for quick access by platform name.
    const state = new Map();
    connected.forEach(conn => {
      const platform = typeof conn === 'string' ? conn : conn.platform;
      const status = typeof conn === 'string' ? 'connected' : (conn.status || 'connected');
      state.set(platform, status);
    });

    allTiles.forEach(tile => {
      const platform = tile.dataset.platform;
      if (!platform) return;
      if (tile.dataset.stubbed === 'true') return; // unavailable wins
      if (tile.classList.contains('needs-brand')) return;
      const status = state.get(platform);
      if (!status) return;
      tile.classList.add('connected');
      const name = tile.querySelector('.tile-name')?.textContent || platformDisplayName(platform);
      if (status === 'expired') {
        tile.classList.add('expired');
        tile.dataset.tip = `${name} · expired — click to reconnect`;
      } else {
        tile.dataset.tip = `${name} · connected (right-click to disconnect)`;
      }
    });

    // Re-attach (once) the right-click → disconnect handler. We use
    // event delegation so the handler stays attached across rerenders.
    const panel = document.getElementById('magic-panel');
    if (panel && !panel.dataset.disconnectHandlerAttached) {
      panel.dataset.disconnectHandlerAttached = '1';
      panel.addEventListener('contextmenu', (e) => {
        const tile = e.target.closest('.magic-tile');
        if (!tile || !tile.classList.contains('connected')) return;
        e.preventDefault();
        const platform = tile.dataset.platform;
        const name = tile.querySelector('.tile-name')?.textContent || platform;
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
    }
  }).catch((err) => { console.warn('[connections]', err); });
}

// Auto-refresh connections when tokens change (e.g., OAuth completed in background).
// Also seed the morning-briefing spell for any brand that just picked up its first
// ad platform — users shouldn't have to visit the Spellbook to get proactive reports.
merlin.onConnectionsChanged(() => {
  loadConnections();
  autoSeedMorningBriefing();
});

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
      // Show credits as tooltip on hover, not inline text.
      // Skip stubbed (`unavailable`) tiles so their "Coming soon" tooltip
      // survives — stubbed platforms never have credits anyway.
      document.querySelectorAll('.magic-tile').forEach(tile => {
        if (tile.dataset.stubbed === 'true') return;
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

// Escape closes the Magic panel when open and nothing more urgent (modal,
// streaming response, recording) is in-flight. Escape is already bound for
// stop-generation on the input; we only claim it here when the panel is the
// top-most dismissable surface.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const panel = document.getElementById('magic-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  // Don't steal Escape from an open modal, an active stream, or the recorder.
  const modalOpen = !document.getElementById('merlin-modal')?.classList.contains('hidden');
  if (modalOpen) return;
  if (typeof isStreaming !== 'undefined' && isStreaming) return;
  if (typeof sessionActive !== 'undefined' && sessionActive) return;
  if (typeof isRecording !== 'undefined' && isRecording) return;
  panel.classList.add('hidden');
});

// Close panel on any outside click (except on the Magic button itself,
// which toggles it, and except on the tile context menu which lives outside
// the panel DOM but is part of the panel UX).
document.addEventListener('click', (e) => {
  const panel = document.getElementById('magic-panel');
  const btn = document.getElementById('magic-btn');
  if (panel.classList.contains('hidden')) return;
  if (panel.contains(e.target)) return;
  if (e.target === btn || e.target.closest('#magic-btn')) return;
  // Don't close while an overlaid modal or the tile context menu is open —
  // the user is interacting with a child of the panel UX.
  if (e.target.closest('#merlin-modal')) return;
  if (e.target.closest('.tile-context-menu')) return;
  panel.classList.add('hidden');
});

// Connect platform tiles — ALL connections handled directly in UI, zero chat involvement
const OAUTH_PLATFORMS = new Set(['meta', 'tiktok', 'shopify', 'google', 'amazon', 'pinterest', 'klaviyo', 'slack', 'discord', 'etsy', 'reddit', 'stripe']);
const API_KEY_PLATFORMS = {
  fal:        { key: 'falApiKey', label: 'fal.ai', placeholder: 'fal-xxxx...', url: 'https://fal.ai/dashboard/keys' },
  elevenlabs: { key: 'elevenLabsApiKey', label: 'ElevenLabs', placeholder: 'xi_xxxx...', url: 'https://elevenlabs.io/app/settings/api-keys' },
  heygen:     { key: 'heygenApiKey', label: 'HeyGen', placeholder: 'your-api-key', url: 'https://app.heygen.com/settings?nav=API' },
  arcads:     { key: 'arcadsApiKey', label: 'Arcads', placeholder: 'your-api-key', url: 'https://app.arcads.ai/settings' },
  foreplay:   { key: 'foreplayApiKey', label: 'Foreplay', placeholder: 'fp_xxxx...', url: 'https://app.foreplay.co/settings/api' },
};

// Shopify-specific helpers — extracted so the context-menu "Use my API key"
// override can reuse the same OAuth retry and manual-credential paths.
function runShopifyOAuthWithStore(activeBrand, store) {
  const extra = store ? { store } : undefined;
  return merlin.runOAuth('shopify', activeBrand, extra).then(result => {
    if (result.error) {
      // "needs a website" — the brand has no URL set in brand.md. Prompt for
      // the store URL inline and retry. This is the flow Shopify reviewers
      // hit when they haven't gone through brand setup. Must land them on the
      // Merlin install page, not a dead-end error.
      if (/needs a website|set up a brand|Store name required/i.test(result.error)) {
        showModal({
          title: 'Connect Shopify',
          body: 'Enter your Shopify store URL to continue.',
          inputPlaceholder: 'your-store.myshopify.com',
          confirmLabel: 'Continue',
          onConfirm: async (value) => {
            if (!value || value.length < 3) { showModalError('Enter your store URL'); throw new Error('validation'); }
            const cleaned = value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
            // Fire-and-forget retry after modal closes — runOAuth opens a
            // browser and can take a few minutes, we shouldn't block the modal.
            setTimeout(() => runShopifyOAuthWithStore(activeBrand, cleaned), 0);
          },
        });
        return;
      }
      showModal({ title: 'Connection Failed', body: friendlyError(result.error, 'Shopify'), confirmLabel: 'OK', onConfirm: () => {} });
    } else {
      loadConnections();
    }
  }).catch(err => {
    showModal({ title: 'Connection Failed', body: friendlyError(err.message, 'Shopify'), confirmLabel: 'OK', onConfirm: () => {} });
  });
}

function showShopifyApiKeyModal(activeBrand) {
  // Two-step manual credential entry: store URL, then access token. This is
  // the "Use my API key" override for users who have a private app / custom
  // app token and want to skip the OAuth browser round-trip.
  showModal({
    title: 'Shopify — Store URL',
    body: 'Enter your Shopify store URL. (Step 1 of 2)',
    inputPlaceholder: 'your-store.myshopify.com',
    confirmLabel: 'Next',
    onConfirm: async (storeValue) => {
      if (!storeValue || storeValue.length < 3) { showModalError('Enter your store URL'); throw new Error('validation'); }
      const store = storeValue.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
      setTimeout(() => {
        showModal({
          title: 'Shopify — Access Token',
          body: 'Paste your Admin API access token (starts with shpat_). (Step 2 of 2)',
          inputPlaceholder: 'shpat_xxxxxxxxxxxxxxxx',
          confirmLabel: 'Save',
          onConfirm: async (tokenValue) => {
            if (!tokenValue || !tokenValue.trim().startsWith('shpat_')) {
              showModalError('Token must start with shpat_');
              throw new Error('validation');
            }
            const r1 = await merlin.saveConfigField('shopifyStore', store, activeBrand);
            if (!r1.success) { showModalError(r1.error || 'Failed to save store'); throw new Error('save'); }
            const r2 = await merlin.saveConfigField('shopifyAccessToken', tokenValue.trim(), activeBrand);
            if (!r2.success) { showModalError(r2.error || 'Failed to save token'); throw new Error('save'); }
            loadConnections();
          },
        });
      }, 0);
    },
  });
}

// In-flight guard — prevents a double-click from launching two OAuth
// browser windows for the same platform. Cleared when the OAuth promise
// settles (success, error, or rejection).
const _oauthInFlight = new Set();

document.addEventListener('click', async (e) => {
  const tile = e.target.closest('.magic-tile');
  if (!tile) return;
  if (tile.dataset.stubbed === 'true') return;
  const platform = tile.dataset.platform;
  const activeBrand = getActiveBrandSelection();
  const displayName = platformDisplayName(platform);

  if (tile.classList.contains('needs-brand')) {
    promptBrandSetupBeforeConnect(platform);
    return;
  }

  const inFlightKey = `${platform}:${activeBrand || ''}`;
  if (_oauthInFlight.has(inFlightKey)) return;

  if (platform === 'shopify') {
    _oauthInFlight.add(inFlightKey);
    Promise.resolve(runShopifyOAuthWithStore(activeBrand)).finally(() => {
      _oauthInFlight.delete(inFlightKey);
    });
    return;
  }

  if (OAUTH_PLATFORMS.has(platform)) {
    _oauthInFlight.add(inFlightKey);
    merlin.runOAuth(platform, activeBrand).then(result => {
      if (result.error) {
        showModal({ title: 'Connection Failed', body: friendlyError(result.error, displayName), confirmLabel: 'OK', onConfirm: () => {} });
      } else {
        loadConnections();
      }
    }).catch(err => {
      showModal({ title: 'Connection Failed', body: friendlyError(err.message, displayName), confirmLabel: 'OK', onConfirm: () => {} });
    }).finally(() => {
      _oauthInFlight.delete(inFlightKey);
    });
    return;
  }

  const apiDef = API_KEY_PLATFORMS[platform];
  if (apiDef) {
    // API key entry via modal — build body as real DOM nodes and pass the
    // wrapper directly via bodyNode. Prior version stringified to innerHTML,
    // which defeated the point.
    const wrapper = document.createElement('div');
    if (apiDef.url) {
      wrapper.appendChild(document.createTextNode('Paste your API key below. '));
      const link = document.createElement('a');
      link.href = apiDef.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.color = 'var(--accent)';
      link.textContent = 'Get your key here';
      wrapper.appendChild(link);
    } else {
      wrapper.appendChild(document.createTextNode('Paste your API key or webhook URL below.'));
    }

    showModal({
      title: `Connect ${apiDef.label}`,
      bodyNode: wrapper,
      inputPlaceholder: apiDef.placeholder,
      confirmLabel: 'Save',
      cancelLabel: 'Cancel',
      onConfirm: async (value) => {
        if (!value || value.trim().length < 5) { showModalError('Key is too short'); throw new Error('validation'); }
        const result = await merlin.saveConfigField(apiDef.key, value.trim(), activeBrand);
        if (result.success) {
          loadConnections();
        } else {
          showModal({ title: 'Error', body: result.error || 'Failed to save', confirmLabel: 'OK', onConfirm: () => {} });
          throw new Error('save-failed');
        }
      },
    });
    return;
  }
});

// Manual API key modal for Meta — escape hatch for users with a long-lived
// access token (e.g. from Graph API Explorer, System User, or a pre-existing
// business integration). Collects access token + ad account ID; Page/Pixel
// can be discovered later via `meta-discover`.
function showMetaApiKeyModal(activeBrand) {
  showModal({
    title: 'Meta — Access Token',
    body: 'Paste your Meta access token (from Graph API Explorer or a System User). (Step 1 of 2)',
    inputPlaceholder: 'EAAL...',
    confirmLabel: 'Next',
    onConfirm: async (tokenValue) => {
      if (!tokenValue || tokenValue.trim().length < 20) { showModalError('Token looks too short'); throw new Error('validation'); }
      const token = tokenValue.trim();
      setTimeout(() => {
        showModal({
          title: 'Meta — Ad Account ID',
          body: 'Enter your Meta Ad Account ID (starts with act_). (Step 2 of 2)',
          inputPlaceholder: 'act_1234567890',
          confirmLabel: 'Save',
          onConfirm: async (acctValue) => {
            let acct = (acctValue || '').trim();
            if (!acct) { showModalError('Ad account ID required'); throw new Error('validation'); }
            if (!acct.startsWith('act_')) acct = 'act_' + acct.replace(/^act_/, '');
            const r1 = await merlin.saveConfigField('metaAccessToken', token, activeBrand);
            if (!r1.success) { showModalError(r1.error || 'Failed to save token'); throw new Error('save'); }
            const r2 = await merlin.saveConfigField('metaAdAccountId', acct, activeBrand);
            if (!r2.success) { showModalError(r2.error || 'Failed to save ad account'); throw new Error('save'); }
            loadConnections();
          },
        });
      }, 0);
    },
  });
}

// Platforms that support a "Use my API key" right-click override. Each entry
// maps the platform data attribute to its manual-credential modal.
const MANUAL_KEY_HANDLERS = {
  shopify: showShopifyApiKeyModal,
  meta: showMetaApiKeyModal,
};

// Tile context menu — right-click to use a manual API key instead of OAuth.
// Review-friendly escape hatch for users with an existing access token.
let activeTileMenuCleanup = null;
function closeTileContextMenu() {
  if (activeTileMenuCleanup) {
    activeTileMenuCleanup();
    activeTileMenuCleanup = null;
  }
}
document.addEventListener('contextmenu', (e) => {
  const tile = e.target.closest('.magic-tile');
  if (!tile) return;
  if (tile.dataset.stubbed === 'true') return;
  const platform = tile.dataset.platform;
  const handler = MANUAL_KEY_HANDLERS[platform];
  if (!handler) return;
  e.preventDefault();
  const activeBrand = getActiveBrandSelection();
  closeTileContextMenu();
  const menu = document.createElement('div');
  menu.className = 'tile-context-menu';
  menu.style.cssText = 'position:fixed;z-index:400;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 6px 20px rgba(0,0,0,.4);font-size:13px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 60) + 'px';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  const btn = document.createElement('button');
  btn.textContent = 'Use my API key';
  btn.style.cssText = 'display:block;width:100%;padding:8px 14px;border:none;background:transparent;color:var(--text);text-align:left;cursor:pointer;border-radius:4px;font-size:13px';
  btn.onmouseenter = () => { btn.style.background = 'var(--accent-bg)'; };
  btn.onmouseleave = () => { btn.style.background = 'transparent'; };
  btn.onclick = () => {
    closeTileContextMenu();
    handler(activeBrand);
  };
  menu.appendChild(btn);
  document.body.appendChild(menu);
  const dismiss = (ev) => {
    if (menu.contains(ev.target)) return;
    closeTileContextMenu();
  };
  const timer = setTimeout(() => {
    document.addEventListener('click', dismiss);
    document.addEventListener('contextmenu', dismiss);
  }, 10);
  activeTileMenuCleanup = () => {
    clearTimeout(timer);
    document.removeEventListener('click', dismiss);
    document.removeEventListener('contextmenu', dismiss);
    menu.remove();
  };
});

// Request a platform
document.getElementById('request-toggle').addEventListener('click', () => {
  document.getElementById('request-form').classList.toggle('hidden');
});
async function sendPlatformRequest() {
  const input = document.getElementById('request-input');
  const sendBtn = document.getElementById('request-send');
  const thanks = document.getElementById('request-thanks');
  const text = input.value.trim();
  if (!text) return;
  sendBtn.disabled = true;
  const origLabel = sendBtn.textContent;
  sendBtn.textContent = 'Sending…';
  try {
    const res = await fetch('https://merlingotme.com/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'platform-request', text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    document.getElementById('request-form').classList.add('hidden');
    thanks.textContent = "✦ Sent! We'll look into it.";
    thanks.style.color = '';
    thanks.classList.remove('hidden');
    input.value = '';
    setTimeout(() => thanks.classList.add('hidden'), 3000);
  } catch {
    thanks.textContent = "Couldn't send — check your connection and try again.";
    thanks.style.color = '#f87171';
    thanks.classList.remove('hidden');
    setTimeout(() => { thanks.classList.add('hidden'); thanks.style.color = ''; }, 4000);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = origLabel;
  }
}
document.getElementById('request-send').addEventListener('click', sendPlatformRequest);
document.getElementById('request-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendPlatformRequest();
});

// ── Share Merlin (Referrals) ────────────────────────────────
async function loadReferralInfo() {
  const linkInput = document.getElementById('referral-link');
  const stats = document.getElementById('referral-stats');
  const copyBtn = document.getElementById('referral-copy');
  try {
    const info = await merlin.getReferralInfo();
    // Don't render a broken `?ref=` URL when the code hasn't loaded yet —
    // the copy button would paste an empty-reference link. Fall back to the
    // bare domain, and disable the copy button until a real code shows up.
    if (info.referralCode) {
      linkInput.value = `merlingotme.com?ref=${info.referralCode}`;
      if (copyBtn) copyBtn.disabled = false;
    } else {
      linkInput.value = 'merlingotme.com';
      if (copyBtn) copyBtn.disabled = true;
    }

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
  } catch (err) {
    // Surface an inline retry instead of leaving the input stuck at "loading…"
    if (linkInput) linkInput.value = 'Could not load — click to retry';
    if (stats) stats.textContent = '';
    if (copyBtn) copyBtn.disabled = true;
    if (linkInput && !linkInput.dataset.retryHooked) {
      linkInput.dataset.retryHooked = '1';
      linkInput.addEventListener('click', () => {
        if (linkInput.value === 'Could not load — click to retry') {
          linkInput.value = 'loading...';
          loadReferralInfo();
        }
      });
    }
    console.warn('[referral]', err);
  }
}

// First-launch auto-apply toast: main.js calls /api/claim-pending-ref on
// boot and fires this event if a pending referral was stashed by the
// landing page. Surfaces a dismissible toast so the user sees their
// friend got credit without ever having to type a code.
let _refAutoToastTimer = null;
merlin.onReferralAutoApplied(({ code, bonus }) => {
  let toast = document.getElementById('referral-auto-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'referral-auto-toast';
    toast.style.cssText = 'position:fixed;bottom:20px;right:20px;max-width:360px;padding:12px 16px;background:rgba(20,20,24,0.96);border:1px solid rgba(52,211,153,0.4);border-radius:12px;color:#e4e4e7;font-size:12px;line-height:1.4;z-index:9999;box-shadow:0 8px 32px rgba(0,0,0,0.5);backdrop-filter:blur(12px);opacity:0;transform:translateY(10px);transition:all .3s ease';
    toast.innerHTML = '<div style="font-weight:600;color:#34d399;margin-bottom:4px">✦ Referral applied</div><div id="referral-auto-toast-body" style="color:rgba(228,228,231,0.8)"></div>';
    document.body.appendChild(toast);
  }
  const safeCode = String(code || '').replace(/[^0-9a-f]/gi, '').slice(0, 8);
  const bonusDays = Math.max(0, Math.min(21, Number(bonus) || 0));
  const bonusLabel = bonusDays > 0 ? ` Your friend now has +${bonusDays} trial day${bonusDays !== 1 ? 's' : ''}.` : '';
  document.getElementById('referral-auto-toast-body').textContent =
    `Code ${safeCode} from your invite link was applied automatically.${bonusLabel}`;
  requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
  if (_refAutoToastTimer) clearTimeout(_refAutoToastTimer);
  _refAutoToastTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
  }, 8000);
  // Refresh the Share Merlin panel so its state reflects the applied code
  // without waiting for the user to reopen it.
  try { loadReferralInfo(); } catch {}
});

document.getElementById('referral-copy').addEventListener('click', () => {
  const linkInput = document.getElementById('referral-link');
  const btn = document.getElementById('referral-copy');
  // Guard against copying a placeholder value (loading / error / bare domain
  // without a ref code). The input-disabled / button-disabled state keeps this
  // reachable only as a defensive check.
  if (!linkInput.value || !linkInput.value.includes('?ref=')) return;
  navigator.clipboard.writeText('https://' + linkInput.value).then(() => {
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

// Morning-briefing preset + SPELLS template list now live in spellbook.js
// (loaded as a <script> tag before this file; attaches to window.MerlinSpellbook).
// Re-export the preset under the original name so downstream code that references
// MORNING_BRIEFING_PRESET continues to work unchanged.
const MORNING_BRIEFING_PRESET = (window.MerlinSpellbook && window.MerlinSpellbook.MORNING_BRIEFING_PRESET) || null;

// Silently seed the morning-briefing spell for any brand that has an ad
// platform connected but no spells yet. Fired from onConnectionsChanged so
// new users get proactive reporting the moment they connect their first
// platform — no manual Spellbook trip required. Idempotent: brands with
// any existing spell are skipped so users who intentionally disabled the
// briefing don't get it resurrected on the next OAuth.
let autoSeedInFlight = false;
async function autoSeedMorningBriefing() {
  if (autoSeedInFlight) return;
  autoSeedInFlight = true;
  try {
    const targets = await discoverBrandsForSpellActivation();
    for (const brand of targets) {
      try {
        const existing = await merlin.listSpells(brand).catch(() => []);
        if (existing && existing.length > 0) continue;
        const staggered = offsetCronMinutes(MORNING_BRIEFING_PRESET.cron, brandHashMinuteOffset(brand));
        await merlin.createSpell(
          `merlin-${MORNING_BRIEFING_PRESET.spell}`,
          staggered,
          MORNING_BRIEFING_PRESET.name,
          MORNING_BRIEFING_PRESET.prompt,
          brand,
        );
      } catch (err) { console.warn('[auto-seed]', brand, err?.message); }
    }
  } finally {
    autoSeedInFlight = false;
  }
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

  // Build set of active spell IDs for deduplication
  const activeIds = new Set((spells || []).map(s => s.id));

  // Render active spells first (from disk)
  (spells || []).forEach(spell => {
    list.appendChild(buildSpellRow(spell, true));
  });

  // Then render available templates that aren't active yet (gray dots).
  // Agency-tier spell prompts with IVT, fatigue detection, and budget
  // optimization rules — the canonical list lives in spellbook.js (loaded
  // via <script> tag before renderer.js; attached to window.MerlinSpellbook).
  const templateData = (window.MerlinSpellbook && window.MerlinSpellbook.SPELLS) || [];

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

  // Outcome summary from activity.jsonl — populated server-side in
  // list-spells by readSpellOutcomes(). Prefers DecisionFact counts
  // (kills/scales/generated) over free-form prose so the row reflects
  // what the binary actually *did*, not what the spell prompt said.
  // Empty (all zeros) → skip the second line; no signal is its own signal.
  const o = spell.outcomes;
  if (o && (o.kills || o.scales || o.generated || o.errors)) {
    const summary = document.createElement('div');
    summary.className = 'spell-meta spell-outcome';
    const bits = [];
    if (o.kills) bits.push(`${o.kills} killed`);
    if (o.scales) bits.push(`${o.scales} scaled`);
    if (o.generated) bits.push(`${o.generated} generated`);
    if (o.errors) bits.push(`${o.errors} error${o.errors === 1 ? '' : 's'}`);
    summary.textContent = bits.join(' · ');
    if (o.errors) summary.style.color = 'var(--danger, #c44)';
    info.appendChild(summary);
  }

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

// Undo toast — appears after a destructive turn (ad pause) and offers a
// one-click revert that re-routes through the SDK as a silent message.
// The SDK / skill layer is the source of truth for what was killed, so
// we just describe the intent ("reactivate the ad you just paused") and
// let Claude resolve the target from recent conversation context.
function showUndoToast({ title, detail, undoPrompt }) {
  const offset = _toastCount * 56;
  _toastCount++;
  const toast = document.createElement('div');
  toast.className = 'spell-toast spell-toast-undo';
  toast.style.bottom = `${80 + offset}px`;
  const body = document.createElement('div');
  body.style.flex = '1';
  body.innerHTML = `<strong>${escapeHtml(title)}</strong>`;
  if (detail) body.innerHTML += `<br><span style="font-size:11px;opacity:.7">${escapeHtml(detail).slice(0, 80)}</span>`;
  toast.appendChild(body);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'spell-toast-undo-btn';
  btn.textContent = 'Undo';
  let fired = false;
  const dismiss = () => {
    toast.style.opacity = '0';
    setTimeout(() => { toast.remove(); _toastCount = Math.max(0, _toastCount - 1); }, 300);
  };
  btn.addEventListener('click', () => {
    if (fired) return;
    fired = true;
    btn.textContent = 'Undoing…';
    btn.disabled = true;
    try { merlin.sendSilent(undoPrompt); } catch {}
    dismiss();
  });
  toast.appendChild(btn);
  document.body.appendChild(toast);
  setTimeout(() => { if (!fired) dismiss(); }, 6000);
}

// Queue of kill actions observed this turn. We wait until `result` (turn
// end) before surfacing the undo toast so the toast only appears after
// the model's response has printed — otherwise the toast overlaps the
// still-streaming "Pausing…" status row and feels like a glitch.
let _undoQueue = [];
function queueKillForUndo(toolName, input) {
  if (!toolName || typeof toolName !== 'string') return;
  if (!toolName.startsWith('mcp__merlin__')) return;
  if (!input || input.action !== 'kill') return;
  const tool = toolName.slice('mcp__merlin__'.length);
  const platformKey = tool.replace('_ads', '');
  const platformLabel = platformKey.charAt(0).toUpperCase() + platformKey.slice(1);
  const adRef = input.adId || input.ad_id || input.name || '';
  _undoQueue.push({
    platformKey,
    platformLabel,
    adRef,
  });
}
function flushUndoQueue() {
  if (!_undoQueue.length) return;
  // Collapse to one toast per platform — if Claude killed six ads in a
  // turn, surfacing six toasts would bury the rest of the UI. One toast
  // offering to "reactivate what you just paused on Meta" covers the
  // batch; Claude resolves the set from recent conversation context.
  const byPlatform = new Map();
  for (const k of _undoQueue) {
    if (!byPlatform.has(k.platformKey)) byPlatform.set(k.platformKey, k);
  }
  _undoQueue = [];
  for (const k of byPlatform.values()) {
    showUndoToast({
      title: `Paused ${k.platformLabel} ad${k.adRef ? '' : 's'}`,
      detail: k.adRef ? k.adRef : 'Tap Undo to reactivate.',
      undoPrompt: `Reactivate the ${k.platformLabel} ad${k.adRef ? ` (${k.adRef})` : 's'} you just paused. Use the activate action on ${k.platformKey}.`,
    });
  }
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
  // Position off-screen first so the menu can be measured, then clamp to
  // viewport so it never clips at the right or bottom edge (users right-click
  // anywhere, including on platform cards near the window edge — "Disconnect"
  // was being cut off when the card sat close to the right border).
  menu.style.left = '-9999px';
  menu.style.top = '-9999px';
  document.body.appendChild(menu);
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const left = Math.max(4, Math.min(e.clientX, window.innerWidth - mw - 8));
  const top = Math.max(4, Math.min(e.clientY, window.innerHeight - mh - 8));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function closeAgencyOverlay() {
  const o = document.getElementById('agency-overlay');
  if (!o) return;
  // Fire the teardown event so the Reports modal can unregister its
  // document-level Escape/Tab listeners before the element is removed.
  // The handler is registered with {once:true}, so the recursive call
  // from inside cleanup() won't re-fire it.
  o.dispatchEvent(new CustomEvent('report:cleanup'));
  const still = document.getElementById('agency-overlay');
  if (still) still.remove();
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
  // First real turn — clear the starter chips so they don't clutter the
  // thread once the conversation has begun.
  try { dismissStarterChips(); } catch {}
  // New turn cancels any in-flight TTS so the wizard never talks over itself.
  stopSpeaking();
  // Voice-output mode: play a short "thinking" filler to mask the gap between
  // send and the first streamed voice chunk (~500-2000 ms in practice). Fire-
  // and-forget; the first real speak chunk stops it via stopFiller() inside
  // _createSpeakPlayback.playNext. If the cache isn't ready yet, the helper
  // no-ops silently — no modal, no error.
  if (voiceEnabled) playFiller();
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
    stopSpeaking();
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
//
// S-tier PTT flow (v1.16 upgrade):
//   * One tap to start (unchanged), auto-stop on 700 ms of silence after
//     the user has spoken. No second tap required.
//   * A VAD (voice-activity-detector.js) polls the mic energy at 50 Hz,
//     calibrates the room baseline for ~300 ms, then fires
//     onSilenceDetected → stopRecording. If Web Audio isn't available,
//     recording falls back to fully manual (tap-again-to-stop).
//   * Final transcript flashes in the input for ~400 ms (.voice-preview)
//     before auto-send, giving the user a chance to Escape if Whisper
//     misheard something critical.
const micBtn = document.getElementById('mic-btn');
let mediaRecorder = null;
let audioStream = null;
let recordingChunks = [];
let isRecording = false;
let isCanceled = false;
let streamBusy = false;     // prevents overlapping whisper-cli calls
let voiceBaseText = '';     // text that was in input before recording started
let vadHandle = null;       // active voice-activity-detector handle (null when idle)
let previewTimer = null;    // pending transcription preview auto-send timer
// VOICE_PREVIEW_MS — how long the final transcript sits in the input before
// auto-send. 400 ms is long enough for a user to read a short sentence
// (~7 words) and hit Escape to cancel, short enough that it doesn't feel
// like the app stalled. Reduce if user feedback shows it's sluggish.
const VOICE_PREVIEW_MS = 400;

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
      // "empty" isn't really a failure — the user either didn't speak or
      // clicked too quickly. Silently drop it; no modal. Any other code
      // gets the humanized message.
      if (result.error === 'transcribe:empty') return;
      showModal({
        title: 'Transcription failed',
        body: humanizeTranscriptionError(result.error, result.errorDetail),
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
        body: humanizeTranscriptionError('', err && err.message ? err.message : String(err)),
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
        // All three browser processors ON. echoCancellation is critical for
        // barge-in — without it, Kokoro's own audio bleeds back into the mic
        // during a user interrupt and Whisper transcribes Merlin's voice as
        // user input. noiseSuppression keeps baseline RMS low for the VAD's
        // adaptive threshold. autoGainControl levels quiet speakers so the
        // VAD doesn't need to chase a moving target.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
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
    stopVAD();
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
      // S-tier flow: if the final transcript has content, flash it for a
      // short preview window then auto-send. Escape or any user keystroke
      // during the window cancels the send and leaves the text editable.
      // Skip preview if the input is empty (nothing to send — Whisper
      // likely returned [BLANK_AUDIO]).
      if (input.value && input.value.trim()) {
        schedulePreviewAutoSend();
      }
    } finally {
      micBtn.classList.remove('transcribing');
      micBtn.disabled = false;
    }
  };

  // 2500ms timeslice = ondataavailable fires every ~2.5s for streaming
  mediaRecorder.start(2500);
  isRecording = true;
  micBtn.classList.add('recording');

  // Attach the VAD last, after the MediaRecorder is running and bound to
  // the stream. A speech-start event is informational (no UI change beyond
  // the existing `.recording` class), but silence-end triggers the auto-
  // stop that closes the PTT turn. If Web Audio isn't available the
  // attachVAD stub no-ops and the user falls back to tap-again-to-stop.
  if (window.MerlinVAD && window.MerlinVAD.attachVAD) {
    try {
      vadHandle = window.MerlinVAD.attachVAD(audioStream, {
        onSilenceDetected: () => {
          if (isRecording && !isCanceled) stopRecording();
        },
        onMaxDuration: () => {
          if (isRecording && !isCanceled) stopRecording();
        },
      });
    } catch (err) {
      console.warn('[vad] attach failed, falling back to manual stop:', err);
      vadHandle = null;
    }
  }
}

// Tear down the VAD before MediaRecorder.stop fires the final
// `ondataavailable` — otherwise a stray tick between stop() and the
// handle.stop() call could kick off another transcribeCurrent pass after
// the user's turn is already over.
function stopVAD() {
  if (vadHandle) {
    try { vadHandle.stop(); } catch (_) {}
    vadHandle = null;
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    stopVAD();
    try { mediaRecorder.stop(); } catch (e) { console.warn('stop error', e); }
    isRecording = false;
  }
}

function cancelRecording() {
  if (mediaRecorder && isRecording) {
    stopVAD();
    isCanceled = true;
    try { mediaRecorder.stop(); } catch (e) { console.warn('cancel error', e); }
    isRecording = false;
  }
}

micBtn.addEventListener('click', () => {
  cancelPreviewAutoSend();
  // Barge-in: if Merlin is currently speaking, ramp Kokoro's volume to
  // zero over 150 ms before tearing down the playback session. Abrupt
  // stops click audibly; the ramp produces a clean "Merlin stops mid-
  // sentence because the user started talking" handoff. Runs in parallel
  // with startRecording so the mic is already open by the time the ramp
  // completes.
  if (currentAudio) rampDownAndStopSpeaking();
  if (isRecording) stopRecording();
  else startRecording();
});

// Escape cancels recording entirely (restores pre-recording text).
// Escape during the preview window cancels auto-send (keeps text editable).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isRecording) cancelRecording();
  if (e.key === 'Escape' && previewTimer != null) cancelPreviewAutoSend();
});

// Any non-Escape keystroke during the preview window also cancels auto-send
// — the user is starting to edit, so we should not yank the text out from
// under them. Modifiers (Ctrl/Cmd/Alt/Shift) alone don't count since the
// user might be about to press Ctrl+Enter to send.
input.addEventListener('keydown', (e) => {
  if (previewTimer == null) return;
  if (e.key === 'Escape') return;       // handled above
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
  cancelPreviewAutoSend();
});

function schedulePreviewAutoSend() {
  cancelPreviewAutoSend();
  input.classList.add('voice-preview');
  previewTimer = setTimeout(() => {
    previewTimer = null;
    input.classList.remove('voice-preview');
    // Send only if there's still text (user may have edited before timer).
    if (input.value && input.value.trim()) sendMessage();
  }, VOICE_PREVIEW_MS);
}

function cancelPreviewAutoSend() {
  if (previewTimer != null) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  input.classList.remove('voice-preview');
}

// Ctrl/Cmd+D toggles the microphone (mirrors mic-btn click).
// Ctrl/Cmd+S narrates the most recent assistant bubble (mirrors replay-btn click).
// Plain Ctrl/Cmd only — let Shift/Alt variants fall through to browser defaults.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  const k = (e.key || '').toLowerCase();
  if (k === 'd') {
    e.preventDefault();
    if (isRecording) stopRecording();
    else startRecording();
  } else if (k === 's') {
    e.preventDefault();
    const bubbles = document.querySelectorAll('.msg-bubble[data-speak-text]');
    const last = bubbles[bubbles.length - 1];
    if (!last) return;
    if (currentSpeakingBubble === last) stopSpeaking();
    else speakMessage(last.dataset.speakText, last);
  }
});

// ── Voice Output (Kokoro TTS → bm_george wizard voice) ──────
// Claude opts into speaking a response via a leading `<voice>speak</voice>`
// metadata tag. The tag is stripped before render (during streaming and on
// finalize) so the user never sees it. When the speaker is toggled on AND
// Claude opted in, the cleaned text is synthesized in main.js and played
// via Blob URL + HTMLAudioElement. Every assistant bubble also gets a
// replay button so the user can hear any past message on demand, even when
// the global toggle is off. Last-writer-wins: a new playback aborts the
// prior one, and any of (Escape, toggle off, new message send) stops audio.
const speakerBtn = document.getElementById('speaker-btn');
let voiceEnabled = localStorage.getItem('merlin.voiceOutput') === '1';
let currentAudio = null;
let currentSpeakingBubble = null;
let _speakReqSeq = 0;          // monotonic id per playback session — lets chunks from a stale request be ignored
let _activeSpeakReqId = null;  // only chunks tagged with this id are queued
// Streaming-speak session for the bubble currently being produced by Claude.
// Unlike one-shot speakMessage, this session is fed sentence-by-sentence as
// Claude's stream arrives so audio starts before the response finishes.
// See _ensureStreamingSpeak / _flushStreamingSpeakSentences below.
let _streamSpeakState = null;

function stripVoiceTag(raw) {
  if (!raw) return { speak: false, cleaned: '', resolved: true };
  const m = raw.match(/^<voice>(speak|silent)<\/voice>\s*\n?/);
  if (m) return { speak: m[1] === 'speak', cleaned: raw.slice(m[0].length), resolved: true };
  // Partial tag still streaming in — suppress the first line until we
  // know whether Claude is opening with a voice tag or real content.
  // The tag is at most 21 chars; beyond 30 we assume it was never there.
  if (raw.length < 30) {
    if ('<voice>speak</voice>'.startsWith(raw) || '<voice>silent</voice>'.startsWith(raw)) {
      return { speak: false, cleaned: '', resolved: false };
    }
  }
  return { speak: false, cleaned: raw, resolved: true };
}

function applySpeakerState() {
  if (!speakerBtn) return;
  if (voiceEnabled) speakerBtn.classList.add('on');
  else speakerBtn.classList.remove('on');
  speakerBtn.setAttribute('aria-pressed', voiceEnabled ? 'true' : 'false');
  speakerBtn.title = voiceEnabled
    ? 'Voice on — Merlin speaks insights aloud. Click to mute.'
    : 'Voice off — Click to let Merlin speak insights aloud.';
}
applySpeakerState();

if (speakerBtn) {
  speakerBtn.addEventListener('click', () => {
    voiceEnabled = !voiceEnabled;
    localStorage.setItem('merlin.voiceOutput', voiceEnabled ? '1' : '0');
    applySpeakerState();
    if (!voiceEnabled) stopSpeaking();
  });
}

function clearSpeakingIndicator(bubbleEl) {
  if (!bubbleEl) return;
  bubbleEl.classList.remove('speaking');
  const btn = bubbleEl.querySelector('.replay-btn');
  if (btn) btn.classList.remove('speaking');
}

// Ramp-and-stop for barge-in. Fades the currently-playing chunk from its
// present volume to 0 over BARGE_RAMP_MS, then calls stopSpeaking() to
// tear down the queue. Uses requestAnimationFrame so the ramp tracks the
// compositor rather than a fixed setInterval — feels smoother on
// high-refresh displays. If the audio element vanishes mid-ramp (e.g. a
// later stopSpeaking beats us to it), we exit quietly.
//
// Why not Web Audio GainNode: HTMLAudioElement.volume is a direct
// multiplier that takes effect on the next buffer pull, which is
// indistinguishable from a GainNode at this short a ramp. Avoiding the
// extra node keeps barge-in purely additive to the existing playback
// path — no risk of regressing normal playback.
const BARGE_RAMP_MS = 150;

// ── Filler phrase playback ────────────────────────────────────
// Masks the Claude-response TTFB. On every voice-enabled send we play a
// short pre-synthesized "thinking" phrase (Got it, one sec. / Okay, let me
// take a look. / ...). The first real streaming-speak chunk killfades it
// immediately via stopFiller() so the user never hears an overlap.
//
// State:
//   _fillerPlayback — { els: Array<{url, audio}>, idx, alive: bool } | null
//                     `alive` is the single flag every async callback
//                     checks before advancing/ending — that way stopFiller
//                     can interrupt in the middle of playNext without
//                     races.
let _fillerPlayback = null;

async function playFiller() {
  if (!voiceEnabled) return;
  if (!merlin.getFillerAudio) return;
  // Don't layer fillers — if one's already playing from a rapid double-send,
  // drop it and start fresh.
  stopFiller();
  let res;
  try { res = await merlin.getFillerAudio(); }
  catch { return; }
  // After await the user may have already cancelled voice, or real speech
  // may have started. Bail if so.
  if (!voiceEnabled) return;
  if (!res || !res.audio || !res.audio.length) return;
  const els = res.audio.map((bytes) => {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const blob = new Blob([u8], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    return { url, audio: new Audio(url) };
  });
  const play = { els, idx: 0, alive: true };
  _fillerPlayback = play;
  const playNext = () => {
    if (!play.alive) return;
    if (play.idx >= play.els.length) { _fillerPlayback = null; return; }
    const { url, audio } = play.els[play.idx++];
    const afterChunk = () => {
      try { URL.revokeObjectURL(url); } catch {}
      if (play.alive) playNext();
    };
    audio.onended = afterChunk;
    audio.onerror = afterChunk;
    audio.play().catch(afterChunk);
  };
  playNext();
}

function stopFiller() {
  if (!_fillerPlayback) return;
  const play = _fillerPlayback;
  _fillerPlayback = null;
  play.alive = false;
  for (const { url, audio } of play.els) {
    try { audio.pause(); } catch {}
    try { audio.src = ''; } catch {}
    try { URL.revokeObjectURL(url); } catch {}
  }
}

function rampDownAndStopSpeaking() {
  if (!currentAudio) { stopSpeaking(); return; }
  const target = currentAudio;
  const startVol = typeof target.volume === 'number' ? target.volume : 1;
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const step = () => {
    if (currentAudio !== target) return;   // superseded — another caller already stopped
    const dt = now() - t0;
    if (dt >= BARGE_RAMP_MS) {
      try { target.volume = 0; } catch (_) {}
      stopSpeaking();
      return;
    }
    const k = 1 - (dt / BARGE_RAMP_MS);
    try { target.volume = Math.max(0, startVol * k); } catch (_) {}
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
    else setTimeout(step, 16);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
  else setTimeout(step, 16);
}

function stopSpeaking() {
  // Kill any filler first — a lingering "thinking" clip after stop would be
  // bizarre. Cheap and idempotent.
  stopFiller();
  // Tear down any live streaming-speak session first. It owns a playback
  // session whose listener must unsubscribe synchronously — otherwise stray
  // chunks arriving after the abort leak blob URLs for the window's life.
  if (_streamSpeakState) {
    const state = _streamSpeakState;
    _streamSpeakState = null;
    try { state.session.abort(null); } catch {}
  }
  if (currentAudio) {
    try { currentAudio.pause(); } catch {}
    try {
      if (currentAudio.src && currentAudio.src.startsWith('blob:')) {
        URL.revokeObjectURL(currentAudio.src);
      }
    } catch {}
    currentAudio = null;
  }
  // Invalidate any in-flight streaming request — stray chunks that arrive
  // after this point will be rejected by the onVoiceOutputChunk guard.
  _activeSpeakReqId = null;
  if (currentSpeakingBubble) {
    clearSpeakingIndicator(currentSpeakingBubble);
    currentSpeakingBubble = null;
  }
  try { merlin.stopSpeaking && merlin.stopSpeaking(); } catch {}
}

// Convert a raw TTS error into something a non-technical user can act on.
// Voice-specific branches take priority; everything else falls through to
// the generic friendlyError. Hoisted out of the per-session closure so
// one-shot + streaming paths share one definition.
function _voiceFriendlyError(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('voice worker exited') || s.includes('uncaught')) {
    return 'Voice engine crashed. Restart Merlin and try again.';
  }
  if (s.includes('init timeout') || s.includes('ensuretts')) {
    return 'Voice model is still loading (first run downloads ~92 MB).\nTry again in a moment — or check your internet connection.';
  }
  if (s.includes('text too long')) {
    return 'That message is too long to read aloud (5000-char cap).';
  }
  return friendlyError(raw, 'voice');
}

// Creates a playback session bound to a fresh reqId. Subscribes to the
// voice-output-chunk IPC, filters for this session's reqId, decodes WAV
// blobs into <audio> elements, plays them in FIFO order, and cleans up
// blob URLs the moment each chunk finishes (or is abandoned).
//
// Returns:
//   reqId     — stamp this onto every IPC that feeds the session
//   bubbleEl  — the bubble the session is speaking for (identity key)
//   abort(e)  — synchronous teardown; drains queued blobs + surfaces error
//
// Invariants:
//   1. Exactly one session "owns" playback at a time. Ownership is held via
//      `_activeSpeakReqId`. Any other session's chunks are dropped (for
//      non-final) or used to unsubscribe + drain (for final).
//   2. Every Object URL created in the queue is revoked on one of: played
//      to completion, drainQueue() on abort/error, or finishIfDrained at
//      end-of-stream. No path leaks.
function _createSpeakPlayback(bubbleEl) {
  const reqId = ++_speakReqSeq;
  _activeSpeakReqId = reqId;
  currentSpeakingBubble = bubbleEl;
  if (bubbleEl) {
    bubbleEl.classList.add('speaking');
    const replayBtn = bubbleEl.querySelector('.replay-btn');
    if (replayBtn) replayBtn.classList.add('speaking');
  }

  const queue = [];          // FIFO of {url, audio} ready to play
  let playing = false;
  let streamDone = false;
  let unsubscribed = false;

  const drainQueue = () => {
    while (queue.length) {
      const { url } = queue.shift();
      try { URL.revokeObjectURL(url); } catch {}
    }
  };

  const releaseOwnership = () => {
    if (_activeSpeakReqId === reqId) _activeSpeakReqId = null;
    if (currentSpeakingBubble === bubbleEl) {
      clearSpeakingIndicator(bubbleEl);
      currentSpeakingBubble = null;
    }
  };

  const finishIfDrained = () => {
    if (!streamDone || playing || queue.length > 0) return;
    releaseOwnership();
  };

  const surfaceError = (raw) => {
    if (!raw) return;
    const msg = _voiceFriendlyError(raw);
    const [title, detail] = msg.split('\n', 2);
    showSpellToast(title || 'Voice output failed', detail || '', 'error');
  };

  const playNext = () => {
    if (playing) return;
    if (_activeSpeakReqId !== reqId) return;   // superseded
    if (queue.length === 0) { finishIfDrained(); return; }
    // Real speech is starting — kill any TTFB-masking filler so the user
    // doesn't hear the tail of "one sec." overlapping the actual reply.
    stopFiller();
    playing = true;
    const { url, audio } = queue.shift();
    currentAudio = audio;
    const afterChunk = () => {
      try { URL.revokeObjectURL(url); } catch {}
      if (currentAudio === audio) currentAudio = null;
      playing = false;
      playNext();
    };
    audio.onended = afterChunk;
    audio.onerror = afterChunk;
    audio.play().catch((err) => {
      console.warn('audio.play failed:', err);
      afterChunk();
    });
  };

  const rawUnsubscribe = merlin.onVoiceOutputChunk((payload) => {
    if (!payload) return;
    if (payload.requestId !== reqId) return;
    if (_activeSpeakReqId !== reqId) {
      // Session was superseded. Unsubscribe on final + drain queued blobs so
      // we don't hold Object URLs for audio the user will never hear.
      if (payload.final) { doUnsubscribe(); drainQueue(); }
      return;
    }
    if (payload.final) {
      streamDone = true;
      doUnsubscribe();
      if (payload.error) {
        surfaceError(payload.error);
        drainQueue();
      }
      playNext();
      return;
    }
    if (!payload.audio) return;
    const bytes = payload.audio instanceof Uint8Array
      ? payload.audio
      : new Uint8Array(payload.audio);
    const blob = new Blob([bytes], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    queue.push({ url, audio: new Audio(url) });
    playNext();
  });

  const doUnsubscribe = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    try { rawUnsubscribe(); } catch {}
  };

  return {
    reqId,
    bubbleEl,
    surfaceError,
    // Synchronous teardown. Idempotent. Drops the subscription, drains
    // queued blob URLs, and releases ownership so a subsequent session can
    // take over without waiting for the worker's final+aborted round-trip.
    abort(error) {
      doUnsubscribe();
      streamDone = true;
      drainQueue();
      if (error) surfaceError(error);
      if (!playing) releaseOwnership();
    },
  };
}

// speakMessage: one-shot synthesis of `text`. Used by the replay button and
// as a fallback when a streaming-speak session never started (speak=false,
// or the response was too short to produce a sentence boundary).
async function speakMessage(text, bubbleEl) {
  if (!text || !text.trim()) return;
  if (!merlin.speakText) return;
  stopSpeaking();  // last-writer-wins
  const session = _createSpeakPlayback(bubbleEl);

  let result;
  try {
    result = await merlin.speakText(text, undefined, session.reqId);
  } catch (err) {
    session.abort(err && err.message ? err.message : err);
    return;
  }
  // If main refused the request, fail fast without waiting for a final that
  // will never come. `aborted` isn't an error — it means a newer session
  // already superseded us, and that session's final will clean up playback.
  if (!result || !result.success) {
    if (result && result.error && !result.aborted) session.abort(result.error);
    else session.abort(null);
  }
}

// ── Streaming-speak session ─────────────────────────────────────
// Fed sentence-by-sentence from `appendText` as Claude's stream arrives.
// The first complete sentence kicks off synthesis while Claude is still
// generating — closing the gap between end-of-response and start-of-audio
// from ~2-3 s (old one-shot flow) to ~400-700 ms (first sentence + one
// Kokoro pass on a warm model).
//
// State shape:
//   session:      _createSpeakPlayback handle (reqId + abort + bubbleEl)
//   consumed:     char index into the bubble's `cleaned` text already sent
//   started:      true once speak-text-stream-start has been dispatched
//                 (lazy — we only open the worker session when the first
//                 real sentence is ready to send)
//   finalized:    true once we've sent the worker stream-end; guards
//                 against double-finalize and late appends after close

function _ensureStreamingSpeak(bubbleEl) {
  if (_streamSpeakState && _streamSpeakState.session.bubbleEl === bubbleEl) {
    return _streamSpeakState;
  }
  // Different bubble (or stale state) — tear down and start fresh.
  stopSpeaking();
  const session = _createSpeakPlayback(bubbleEl);
  _streamSpeakState = { session, consumed: 0, started: false, finalized: false };
  return _streamSpeakState;
}

async function _startStreamingSpeakWorker(state) {
  if (state.started || state.finalized) return;
  state.started = true;
  let res;
  try {
    res = await merlin.speakTextStreamStart(state.session.reqId);
  } catch (err) {
    state.session.abort(err && err.message ? err.message : err);
    if (_streamSpeakState === state) _streamSpeakState = null;
    return;
  }
  if (!res || res.error) {
    state.session.abort(res && res.error);
    if (_streamSpeakState === state) _streamSpeakState = null;
  }
}

// Called from appendText on every delta. Extracts any newly-complete
// sentences from `cleaned` and ships them to the worker. No-op if the
// streaming session has been torn down (e.g. user pressed Escape).
function _flushStreamingSpeakSentences(bubbleEl, cleaned) {
  const splitter = window.MerlinSentenceSplitter;
  if (!splitter) return;
  const state = _ensureStreamingSpeak(bubbleEl);
  if (!state || state.finalized) return;
  const { sentences, nextIdx } = splitter.extractCompleteSentences(cleaned, state.consumed);
  if (sentences.length === 0) return;
  state.consumed = nextIdx;
  // Lazily open the worker session on the first complete sentence. Avoids
  // reserving Kokoro for a speak=true response that turns out to be empty
  // or shorter than MIN_SENTENCE_CHARS.
  if (!state.started) _startStreamingSpeakWorker(state);
  for (const sentence of sentences) {
    // Fire-and-forget. A failed append just drops that sentence — earlier
    // sentences still play, and the worker's final will clean up regardless.
    try { merlin.speakTextStreamAppend(state.session.reqId, sentence).catch(() => {}); } catch {}
  }
}

// Called from finalizeBubble. If a streaming session is active for this
// bubble, flush any trailing partial sentence and close. Returns true if
// the streaming path handled this bubble (caller must NOT also fire the
// one-shot fallback — that would re-speak everything).
function _finishStreamingSpeak(bubbleEl, cleaned) {
  const state = _streamSpeakState;
  if (!state || state.session.bubbleEl !== bubbleEl) return false;
  _streamSpeakState = null;
  if (!state.started) {
    // No sentence ever completed — nothing was sent to the worker and no
    // playback session should be held open. Tear down and let the caller
    // fall back to one-shot speakMessage for the full text.
    state.session.abort(null);
    return false;
  }
  state.finalized = true;
  const splitter = window.MerlinSentenceSplitter;
  const tail = splitter ? splitter.drainRemaining(cleaned, state.consumed) : '';
  if (tail) {
    try { merlin.speakTextStreamAppend(state.session.reqId, tail).catch(() => {}); } catch {}
  }
  try { merlin.speakTextStreamEnd(state.session.reqId).catch(() => {}); } catch {}
  return true;
}

function addReplayButton(bubbleEl, text) {
  if (!bubbleEl || bubbleEl.querySelector('.replay-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'replay-btn';
  btn.type = 'button';
  btn.title = 'Play this message aloud';
  btn.setAttribute('aria-label', 'Play this message aloud');
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentSpeakingBubble === bubbleEl) {
      stopSpeaking();
      return;
    }
    const stored = bubbleEl.dataset.speakText || text;
    speakMessage(stored, bubbleEl);
  });
  bubbleEl.appendChild(btn);
}

if (merlin.onVoiceOutputProgress) {
  merlin.onVoiceOutputProgress((payload) => {
    if (!payload) return;
    const status = String(payload.status || '');
    const file = String(payload.file || '');
    const pct = typeof payload.progress === 'number' ? Math.round(payload.progress) : null;
    console.log('[kokoro]', status, file, pct !== null ? pct + '%' : '');
  });
}

// Escape stops speaking when nothing more urgent is in flight.
// Recording Escape and stream-stop Escape handlers run first and match
// their own conditions, so this only fires during standalone playback.
// Uses the same gain ramp as barge-in so Escape-to-silence feels smooth
// instead of clicking off mid-word.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && currentAudio && !isRecording && !isStreaming && !sessionActive) {
    rampDownAndStopSpeaking();
  }
});

// Auto-resize textarea.
//
// REGRESSION GUARD (2026-04-15, input-scrollbar incident):
// overflow-y stays `hidden` by default (see matching comment in
// style.css) and we flip it to `auto` only when the text is longer than
// the 120px cap. Chromium otherwise reserves a scrollbar track for
// single-line content, which paying users reported as a visible gray
// bar on the right edge of the input.
function autoResize() {
  input.style.height = 'auto';
  const MAX_INPUT_HEIGHT = 120;
  const contentHeight = input.scrollHeight;
  if (contentHeight > MAX_INPUT_HEIGHT) {
    input.style.height = MAX_INPUT_HEIGHT + 'px';
    input.style.overflowY = 'auto';
  } else {
    input.style.height = contentHeight + 'px';
    input.style.overflowY = 'hidden';
  }
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

  // Pick the correct delete targets based on the item's source.
  //
  // REGRESSION GUARD (2026-04-16, loose-delete data-loss incident): this
  // used to always pass `folderPath` (the parent directory) to delete-file.
  // For run items (`ad_YYYYMMDD_HHMMSS/`) that's the run folder itself and
  // deleting it is correct. For LOOSE files (seedance_*.mp4 dropped into a
  // brand folder shared with other clips), `folderPath` was the brand folder
  // — deleting it wiped every sibling clip the user never asked to remove.
  // Loose items now carry an explicit `data-files` JSON array of their own
  // file(s) so we delete exactly what was shown on the card.
  const cardSource = archiveCard?.dataset?.source || '';
  let deleteTargets = [];
  if (cardSource === 'loose' && archiveCard?.dataset?.files) {
    try {
      const parsed = JSON.parse(archiveCard.dataset.files);
      if (Array.isArray(parsed)) deleteTargets = parsed.filter(p => typeof p === 'string' && p);
    } catch {}
    if (deleteTargets.length === 0 && filePath) deleteTargets = [filePath];
  } else if (cardSource === 'run' && archiveCard?.dataset?.folder) {
    deleteTargets = [archiveCard.dataset.folder];
  } else if (folderPath) {
    // Fallback for non-card contexts (chat message images, preview overlay
    // before source is set): legacy behaviour — delete the folder.
    deleteTargets = [folderPath];
  }

  let menuItems = '';
  if (!isVideo && filePath) menuItems += '<button data-action="copy">Copy Image</button>';
  if (filePath) menuItems += '<button data-action="save">Save As...</button>';
  if (folderPath) menuItems += '<button data-action="folder">Open Folder</button>';
  if (deleteTargets.length > 0) menuItems += '<div class="img-context-divider"></div><button data-action="delete" class="img-context-danger">Delete</button>';
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
      // Pass the array form when we have multiple targets (loose items: the
      // clip + its paired thumbnail). Single-path call sites (chat message
      // images, legacy folder delete) still pass a string for backwards
      // compatibility with the main-process handler.
      const target = deleteTargets.length > 1 ? deleteTargets : (deleteTargets[0] || folderPath);
      const result = await merlin.deleteFile(target);
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
// REGRESSION GUARD (2026-04-18, tooltip-flicker incident): mouseover/mouseout
// fire for EVERY descendant transition (e.g. moving the cursor a pixel within
// an icon button walks between <svg>/<path> children). The previous impl
// remove()+createElement()'d the tooltip on each of those events, which showed
// up visually as rapid flicker whenever the mouse crossed child boundaries —
// notably when sliding from the mic button onto the spawned speaker button.
// Fix: track the owning [data-tip] element and (a) no-op mouseover when the
// same element is still active, (b) reuse the tooltip DOM node across element
// swaps (rewrite innerHTML + reposition, no remove/create), (c) use relatedTarget
// on mouseout to distinguish "leaving to a child" from "leaving the element".
(function() {
  let tip = null;
  let tipEl = null;

  function positionTip(el) {
    const rect = el.getBoundingClientRect();
    const pos = el.getAttribute('data-tip-pos');
    const tipW = tip.offsetWidth;
    let left = rect.left + rect.width / 2 - tipW / 2;
    if (left < 4) left = 4;
    if (left + tipW > window.innerWidth - 4) left = window.innerWidth - tipW - 4;

    const tipH = tip.offsetHeight;
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    const showBelow = pos === 'bottom' || (spaceAbove < tipH + 10 && spaceBelow > tipH + 10);
    tip.style.top = (showBelow ? rect.bottom + 6 : rect.top - tipH - 6) + 'px';
    tip.style.left = left + 'px';
  }

  function showTip(el) {
    if (tipEl === el) return;
    const tipText = el.getAttribute('data-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'merlin-tooltip';
      document.body.appendChild(tip);
    }
    tip.innerHTML = escapeHtml(tipText).replace(/\n/g, '<br>');
    tipEl = el;
    positionTip(el);
  }

  function hideTip() {
    if (tip) { tip.remove(); tip = null; }
    tipEl = null;
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    showTip(el);
  });
  document.addEventListener('mouseout', (e) => {
    if (!tipEl) return;
    const rel = e.relatedTarget;
    const relTipEl = rel && rel.nodeType === 1 ? rel.closest('[data-tip]') : null;
    if (relTipEl === tipEl) return; // moved to a child of the same tip owner
    if (!relTipEl) hideTip();
    // If moving to a different [data-tip], mouseover will swap content in place.
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
    } else if (!cached && brand) {
      // REGRESSION GUARD (2026-04-15, codex per-brand revenue audit — finding #1):
      // The refresh-loop guard is keyed by `${brand}:${days}`, not just
      // `brand`. Previously the key was brand-only, which meant a single
      // 7D refresh on launch "satisfied" the guard forever — so when the
      // user clicked 30D or 90D and the cache miss hit this branch,
      // loadPerfBar skipped the refresh and rendered empty. The UI
      // appeared to quietly lose longer windows. Key the guard by the
      // full (brand, period) pair so each period gets exactly one
      // refresh attempt per session, independently.
      const refreshKey = `${brand}:${days}`;
      if (!perfState._refreshedBrands) perfState._refreshedBrands = new Set();
      if (!perfState._refreshedBrands.has(refreshKey)) {
        perfState._refreshedBrands.add(refreshKey);
        renderPerfBar(null);
        try {
          // Pass `days` through — the binary writes the dashboard file with
          // period_days: <days>, and computePerfSummary will only surface
          // files whose period matches. Omitting this would default to a
          // 1-day refresh that the perf bar then couldn't read back.
          await merlin.refreshPerf(brand, days);
          // Re-check that user hasn't switched brands during the 30-60s refresh
          if (perfState.currentBrand !== brand || perfState.currentPeriod !== days) return;
          const retryPerf = await fetchPerfData(days, brand);
          if (perfState.currentBrand === brand && perfState.currentPeriod === days) {
            renderPerfBar(retryPerf);
          }
        } catch {}
      } else {
        renderPerfBar(null);
      }
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

  // Background perf refresh — pull fresh data on launch if brand data is stale.
  //
  // REGRESSION GUARD (2026-04-15, codex per-brand revenue audit — finding #1):
  // Pass the active period to refreshPerf. Previously this called
  // refreshPerf(activeBrand) with no days argument, which defaults to 1
  // in the main-process handler. The binary then wrote a 1-day dashboard
  // file, and computePerfSummary — which now filters by period_days —
  // would not surface it for the user's 7D/30D/90D selection. The
  // on-launch refresh must match the UI's active period so the file
  // landing on disk is actually consumable.
  (async function refreshPerfOnLaunch() {
    try {
      const lastUpdate = await merlin.getPerfUpdated(activeBrand);
      const stale = !lastUpdate || (Date.now() - new Date(lastUpdate).getTime() > 4 * 60 * 60 * 1000);
      if (stale) {
        const launchPeriodAttr = document.querySelector('.perf-period-btn.active')?.dataset.days;
        const launchPeriod = Number.isFinite(parseInt(launchPeriodAttr)) ? parseInt(launchPeriodAttr) : 7;
        await merlin.refreshPerf(activeBrand, launchPeriod);
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
// for the CURRENTLY selected period. See the REGRESSION GUARD above on
// refreshPerfOnLaunch for why days must flow through.
setInterval(async () => {
  try {
    const activeBrand = document.getElementById('brand-select')?.value || '';
    const activePeriod = document.querySelector('.perf-period-btn.active')?.dataset.days || '7';
    const days = parseInt(activePeriod) || 7;
    await merlin.refreshPerf(activeBrand, days);
    loadPerfBar(days, activeBrand);
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

// ── Reports (Agency-wide performance) ───────────────────────
// Aggregates each selected brand's latest dashboard JSON for the chosen
// period and renders a printable report. See main.js:get-agency-report
// REGRESSION GUARD for the per-brand sourcing rules.
const REPORT_PERIODS = [
  { days: 7, label: 'Last 7 Days' },
  { days: 30, label: 'Last 30 Days' },
  { days: 90, label: 'Last 90 Days' },
  { days: 365, label: 'Last 12 Months' },
];

function reportPeriodLabel(days) {
  return REPORT_PERIODS.find(p => p.days === days)?.label || `Last ${days} Days`;
}

document.getElementById('agency-report-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  // Toggle — if already open, close. closeAgencyOverlay() dispatches the
  // report:cleanup event before removing the element, so the modal's
  // Escape/Tab document listeners are torn down cleanly.
  if (document.getElementById('agency-overlay')) { closeAgencyOverlay(); return; }
  // Close sibling surfaces so they don't render behind the modal.
  document.getElementById('magic-panel').classList.add('hidden');
  document.getElementById('archive-panel').classList.add('hidden');
  document.getElementById('wisdom-overlay').classList.add('hidden');
  document.getElementById('stats-overlay')?.classList.add('hidden');

  let brands = [];
  try { brands = await merlin.getBrands(); } catch {}

  // Initial period pulls from the perf bar so the report matches what the
  // user was just looking at, but can be changed inside the overlay.
  const initialPeriod = parseInt(document.querySelector('.perf-period-btn.active')?.dataset.days, 10) || 7;
  let currentPeriod = initialPeriod;

  // Safety net — shouldn't stack since we return early above, but guards
  // against a prior overlay lingering from a DOM exception.
  closeAgencyOverlay();

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.id = 'agency-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'report-title');

  const periodButtons = REPORT_PERIODS.map(p => `
    <button type="button" class="report-period-btn" data-days="${p.days}"
      style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-dim);font-size:11px;font-weight:600;cursor:pointer;transition:all .15s">${escapeHtml(p.label)}</button>
  `).join('');

  const brandRows = brands.map(b => `
    <label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;font-size:13px;color:var(--text-muted)">
      <input type="checkbox" checked data-brand="${escapeHtml(b.name)}" style="accent-color:var(--accent)">
      ${escapeHtml(b.displayName || b.name)}
    </label>
  `).join('');

  overlay.innerHTML = `
    <div class="setup-card" style="max-width:460px;text-align:left">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <h2 id="report-title" style="font-size:18px;font-weight:700;color:var(--text);margin:0">Reports</h2>
        <button type="button" class="agency-x magic-close" aria-label="Close">&times;</button>
      </div>

      <div style="display:flex;gap:6px;margin-bottom:14px" role="group" aria-label="Report period">
        ${periodButtons}
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <p style="font-size:12px;color:var(--text-dim);margin:0">Select brands to include</p>
        ${brands.length > 1 ? `
          <div style="display:flex;gap:8px">
            <button type="button" class="agency-select-all" style="background:none;border:none;color:var(--accent);font-size:11px;font-weight:600;cursor:pointer;padding:2px 4px">All</button>
            <button type="button" class="agency-select-none" style="background:none;border:none;color:var(--text-dim);font-size:11px;font-weight:600;cursor:pointer;padding:2px 4px">None</button>
          </div>
        ` : ''}
      </div>

      <div id="agency-brands" style="margin-bottom:16px;max-height:240px;overflow-y:auto">
        ${brandRows}
        ${brands.length === 0 ? '<p style="color:var(--text-dim);font-size:12px;margin:6px 0">No brands found. Run onboarding to add a brand first.</p>' : ''}
      </div>

      <div class="agency-status" style="font-size:12px;color:var(--text-dim);margin-bottom:12px;min-height:16px" role="status" aria-live="polite"></div>

      <button type="button" class="agency-gen btn-primary" style="width:100%">Generate Report</button>
    </div>
  `;

  document.body.appendChild(overlay);

  // ── Close plumbing (single cleanup path, no listener leaks) ──
  const escHandler = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); cleanup(); } };
  const trapHandler = (ev) => {
    if (ev.key !== 'Tab') return;
    const focusables = overlay.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  };
  const cleanup = () => {
    document.removeEventListener('keydown', escHandler);
    document.removeEventListener('keydown', trapHandler);
    closeAgencyOverlay();
  };
  // {once:true} — closeAgencyOverlay() re-dispatches report:cleanup from
  // within cleanup() itself, so the listener must auto-remove after first
  // fire to avoid re-entry.
  overlay.addEventListener('report:cleanup', cleanup, { once: true });
  overlay.querySelector('.agency-x').addEventListener('click', cleanup);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) cleanup(); });
  document.addEventListener('keydown', escHandler);
  document.addEventListener('keydown', trapHandler);

  // ── State UI ──
  const statusEl = overlay.querySelector('.agency-status');
  const genBtn = overlay.querySelector('.agency-gen');
  const setStatus = (msg, tone) => {
    statusEl.textContent = msg || '';
    statusEl.style.color = tone === 'error' ? 'var(--danger, #ef4444)' : 'var(--text-dim)';
  };
  const updateGenState = () => {
    const hasBrands = brands.length > 0;
    const selectedCount = overlay.querySelectorAll('#agency-brands input:checked').length;
    genBtn.disabled = !hasBrands || selectedCount === 0;
    genBtn.style.opacity = genBtn.disabled ? '0.5' : '1';
    genBtn.style.cursor = genBtn.disabled ? 'not-allowed' : 'pointer';
    if (!hasBrands) {
      genBtn.textContent = 'No brands to report';
    } else if (selectedCount === 0) {
      genBtn.textContent = 'Select at least one brand';
    } else {
      genBtn.textContent = `Generate Report (${selectedCount})`;
    }
  };

  const setActivePeriodBtn = () => {
    overlay.querySelectorAll('.report-period-btn').forEach(b => {
      const active = parseInt(b.dataset.days, 10) === currentPeriod;
      b.style.background = active ? 'var(--accent-bg)' : 'transparent';
      b.style.color = active ? 'var(--accent)' : 'var(--text-dim)';
      b.style.borderColor = active ? 'var(--accent-border)' : 'var(--border)';
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  };
  setActivePeriodBtn();

  overlay.querySelectorAll('.report-period-btn').forEach(b => {
    b.addEventListener('click', () => {
      currentPeriod = parseInt(b.dataset.days, 10);
      setActivePeriodBtn();
    });
  });

  overlay.querySelector('.agency-select-all')?.addEventListener('click', () => {
    overlay.querySelectorAll('#agency-brands input[type="checkbox"]').forEach(cb => { cb.checked = true; });
    updateGenState();
  });
  overlay.querySelector('.agency-select-none')?.addEventListener('click', () => {
    overlay.querySelectorAll('#agency-brands input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    updateGenState();
  });
  overlay.querySelectorAll('#agency-brands input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', updateGenState);
  });
  updateGenState();

  // Move focus into the modal for keyboard users.
  setTimeout(() => {
    const firstFocusable = overlay.querySelector('.report-period-btn') || genBtn;
    firstFocusable?.focus();
  }, 0);

  // ── Generate ──
  genBtn.addEventListener('click', async () => {
    const selectedBrands = [...overlay.querySelectorAll('#agency-brands input:checked')].map(cb => cb.dataset.brand);
    if (selectedBrands.length === 0) return;

    genBtn.disabled = true;
    genBtn.style.opacity = '0.5';
    genBtn.textContent = 'Generating…';
    setStatus('Aggregating brand dashboards…');

    let report;
    try {
      report = await merlin.getAgencyReport(currentPeriod, selectedBrands);
    } catch (err) {
      console.error('[report]', err);
      setStatus(friendlyError(err?.message || String(err), 'report'), 'error');
      updateGenState();
      return;
    }

    if (!report || report.summary.brandsWithData === 0) {
      setStatus('No dashboard data found for the selected brands and period. Run "dashboard" for each brand first.', 'error');
      updateGenState();
      return;
    }

    const reportHtml = buildReportHtml(report, brands);
    // Unique window name per click so two reports can coexist instead of
    // clobbering each other.
    const windowName = `Merlin_Report_${Date.now()}`;
    const reportWindow = window.open('', windowName, 'width=900,height=1100,resizable=yes,scrollbars=yes');
    if (!reportWindow) {
      setStatus('Your popup blocker prevented the report from opening. Allow popups for Merlin and try again.', 'error');
      updateGenState();
      return;
    }
    try {
      reportWindow.document.open();
      reportWindow.document.write(reportHtml);
      reportWindow.document.close();
      // Belt-and-suspenders: sever opener so the popup can't navigate this
      // window. The HTML we wrote is ours, but this guards against a future
      // change adding user-controlled href content.
      try { reportWindow.opener = null; } catch {}
      reportWindow.focus?.();
    } catch (err) {
      console.error('[report]', err);
      try { reportWindow.close(); } catch {}
      setStatus(friendlyError(err?.message || String(err), 'report'), 'error');
      updateGenState();
      return;
    }

    cleanup();
  });
});

function buildReportHtml(report, allBrands) {
  const periodLabel = reportPeriodLabel(report.period);
  const s = report.summary;
  const fmtMoney = (n) => '$' + Math.round(n || 0).toLocaleString();
  const fmtMer = (n) => (n > 0 ? n.toFixed(2) + 'x' : '—');
  const fmtRoas = (n) => (n > 0 ? n.toFixed(2) + 'x' : '—');
  const fmtInt = (n) => Math.round(n || 0).toLocaleString();

  // Single consistent timestamp derived from the report's generatedAt.
  // Using one source avoids the "header local / footer UTC" mismatch the
  // prior version could hit near midnight.
  const genDate = report.generatedAt ? new Date(report.generatedAt) : new Date();
  const genLabel = genDate.toLocaleString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });

  const brandPages = report.perBrand.map(b => {
    const meta = allBrands.find(a => a.name === b.name);
    const displayName = meta?.displayName || b.name;
    if (!b.hasData || !b.data) {
      return `
        <section class="page-break">
          <h2>${escapeHtml(displayName)}</h2>
          <p class="subtitle">${escapeHtml(periodLabel)}</p>
          <div class="empty">No dashboard data for this period. Run "dashboard" for this brand to populate the report.</div>
        </section>
      `;
    }
    const d = b.data;
    const staleBadge = d.stale
      ? `<span class="stale" title="Data older than 48 hours">Stale</span>`
      : '';
    const brandGen = d.generatedAt
      ? new Date(d.generatedAt).toLocaleString(undefined, { year:'numeric', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
      : '—';
    return `
      <section class="page-break">
        <h2>${escapeHtml(displayName)} ${staleBadge}</h2>
        <p class="subtitle">${escapeHtml(periodLabel)} · Dashboard refreshed ${escapeHtml(brandGen)}</p>
        <div class="kpi-grid">
          <div class="kpi"><span class="kpi-value">${escapeHtml(fmtMoney(d.revenue))}</span><span class="kpi-label">Revenue</span></div>
          <div class="kpi"><span class="kpi-value">${escapeHtml(fmtMoney(d.spend))}</span><span class="kpi-label">Ad Spend</span></div>
          <div class="kpi"><span class="kpi-value">${escapeHtml(fmtRoas(d.roas))}</span><span class="kpi-label">ROAS</span></div>
          <div class="kpi"><span class="kpi-value">${escapeHtml(fmtInt(d.newCustomers))}</span><span class="kpi-label">New Customers</span></div>
        </div>
      </section>
    `;
  }).join('');

  const missingNote = s.brandsRequested > s.brandsWithData
    ? `<p class="note">${escapeHtml(String(s.brandsRequested - s.brandsWithData))} of ${escapeHtml(String(s.brandsRequested))} selected brands had no dashboard data for this period and appear as empty sections.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Merlin Performance Report — ${escapeHtml(periodLabel)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; background: #fff; padding: 40px; max-width: 820px; margin: 0 auto; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
  h2 { font-size: 20px; font-weight: 700; margin-bottom: 4px; border-bottom: 2px solid #e5e5e5; padding-bottom: 8px; display: flex; align-items: center; gap: 10px; }
  .subtitle { font-size: 13px; color: #888; margin-bottom: 20px; }
  .summary { background: #f8f8f8; border-radius: 12px; padding: 24px; margin-bottom: 32px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 20px 0; }
  .kpi { text-align: center; }
  .kpi-value { display: block; font-size: 22px; font-weight: 700; color: #1a1a1a; }
  .kpi-label { display: block; font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: .05em; margin-top: 4px; }
  .page-break { page-break-before: always; margin-top: 40px; }
  .page-break:first-of-type { page-break-before: auto; }
  .note { font-size: 12px; color: #777; margin-top: 16px; }
  .empty { font-size: 13px; color: #999; padding: 24px; background: #fafafa; border-radius: 8px; text-align: center; }
  .stale { display: inline-block; font-size: 10px; font-weight: 600; background: #fef3c7; color: #92400e; padding: 2px 6px; border-radius: 4px; border: 1px solid #fde68a; }
  .footer { margin-top: 48px; text-align: center; font-size: 11px; color: #aaa; }
  .toolbar { margin-bottom: 20px; text-align: right; }
  #print-btn { padding: 8px 16px; border-radius: 6px; border: 1px solid #ddd; background: #fff; cursor: pointer; font-size: 13px; font-family: inherit; color: #1a1a1a; }
  #print-btn:hover { background: #f5f5f5; }
  @media print { .no-print { display: none !important; } body { padding: 20px; } }
</style></head><body>
  <div class="toolbar no-print">
    <button id="print-btn" type="button">Print / Save as PDF</button>
  </div>

  <h1>Performance Report</h1>
  <p class="subtitle">${escapeHtml(periodLabel)} · Generated ${escapeHtml(genLabel)}</p>

  <div class="summary">
    <h2 style="border:none;padding:0;margin-bottom:16px">Summary — All Brands</h2>
    <div class="kpi-grid">
      <div class="kpi"><span class="kpi-value">${escapeHtml(fmtMoney(s.revenue))}</span><span class="kpi-label">Revenue</span></div>
      <div class="kpi"><span class="kpi-value">${escapeHtml(fmtMoney(s.spend))}</span><span class="kpi-label">Total Spend</span></div>
      <div class="kpi"><span class="kpi-value">${escapeHtml(fmtMer(s.mer))}</span><span class="kpi-label">Blended MER</span></div>
      <div class="kpi"><span class="kpi-value">${escapeHtml(String(s.activeBrandsCount))}</span><span class="kpi-label">Active Brands</span></div>
    </div>
    <div class="kpi-grid" style="grid-template-columns:repeat(2,1fr);margin-top:4px">
      <div class="kpi"><span class="kpi-value">${escapeHtml(fmtInt(s.newCustomers))}</span><span class="kpi-label">New Customers</span></div>
      <div class="kpi"><span class="kpi-value">${escapeHtml(String(s.brandsWithData))} / ${escapeHtml(String(s.brandsRequested))}</span><span class="kpi-label">Brands With Data</span></div>
    </div>
    ${missingNote}
  </div>

  ${brandPages}

  <div class="footer">Merlin · Generated ${escapeHtml(genLabel)}</div>

  <script>
    // No inline handlers — satisfies strict CSP if the popup ever inherits one.
    document.getElementById('print-btn').addEventListener('click', function () { window.print(); });
  </script>
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
  // REGRESSION GUARD (2026-04-15, codex per-brand revenue audit — findings #3 + #5):
  // Use perfState.cache as the SINGLE source of truth for this overlay.
  //
  // Previously, when the perf cache was empty this handler fell back to
  // `merlin.getStatsCache()` which is keyed only by action name — not
  // brand and not period. A cached "dashboard" entry from a different
  // brand would populate this overlay as if it belonged to the current
  // brand, and the loose heuristic in populateStatsCard would happily
  // pick the first revenue-looking field it saw from any action. That
  // stitched together Frankenstein metrics from unrelated brands.
  //
  // The overlay now shows `setStatsEmpty()` when there is no
  // brand-scoped perf data, which is accurate and honest. The revenue
  // bar in the header will trigger a targeted refresh for the selected
  // period, and the overlay reads whatever lands in perfState.cache.
  //
  // Also: `days === 1` is labeled "Yesterday", not "Today". Meta,
  // TikTok, Google, and Amazon all report yesterday's calendar data on
  // a days=1 request, so labeling the aggregate as "Today" was a lie —
  // it showed yesterday's spend next to yesterday's revenue, not a live
  // current-day number.
  try {
    const brand = document.getElementById('brand-select')?.value || '';
    const days = perfState.currentPeriod || 7;
    let perf = perfState.cache[brand]?.[days];
    if (!perf) perf = await fetchPerfData(days, brand);
    if (perf) {
      renderStatsCard(perf, days);
    } else {
      // No brand-scoped perf data available. DO NOT fall back to the
      // action-keyed stats cache — see the regression guard above.
      setStatsEmpty();
    }
  } catch {
    setStatsEmpty();
  }
});

// In-card period toggle — switch the overlay between 1D/7D/30D/90D/12M without
// having to close + click a different button on the perf bar. Pivoting inside
// the card matters for the share flow: users want to pick the most flattering
// period before screenshotting.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.stats-period-btn');
  if (!btn) return;
  e.stopPropagation();
  const days = parseInt(btn.dataset.days, 10);
  if (!days) return;
  const brand = document.getElementById('brand-select')?.value || '';
  setStatsPeriodActive(days);
  try {
    let perf = perfState.cache[brand]?.[days];
    if (!perf) perf = await fetchPerfData(days, brand);
    if (perf) renderStatsCard(perf, days);
    else setStatsEmpty();
  } catch {
    setStatsEmpty();
  }
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

// Activity view state — held in module scope so the toolbar filters,
// search box, and the fetched entries all stay in sync without having
// to thread them through every helper. Declared ahead of showActivityView
// because the activity-btn click handler can fire before later `let`
// declarations execute, and `let` is in the temporal dead zone until its
// declaration line runs.
let _activityState = { items: [], query: '', full: true };

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

async function loadActivityFeed(forceFull = false) {
  const existing = document.getElementById('activity-feed-section');
  if (existing) existing.remove();

  try {
    const activityBrand = document.getElementById('brand-select')?.value || null;
    const wantFull = forceFull || _activityState.full;
    let items = wantFull
      ? await merlin.getActivityFeedFull(activityBrand)
      : await merlin.getActivityFeed(activityBrand, 100);
    if (!Array.isArray(items)) items = [];
    _activityState.items = items;
    _activityState.full = wantFull;

    const section = document.createElement('div');
    section.id = 'activity-feed-section';
    section.className = 'activity-section';

    // Toolbar: search + type filter chips + export/copy-all. Always shown
    // even when the feed is empty — users connecting Merlin for the first
    // time still see the controls, not a dead panel.
    const toolbar = renderActivityToolbar();
    section.appendChild(toolbar);

    const body = document.createElement('div');
    body.id = 'activity-feed-body';
    section.appendChild(body);

    renderActivityBody(body);

    const grid = document.getElementById('archive-grid');
    grid.parentNode.insertBefore(section, grid);
  } catch (err) { console.warn('[activity]', err); }
}

function renderActivityToolbar() {
  const bar = document.createElement('div');
  bar.className = 'activity-toolbar';
  bar.innerHTML = `
    <input id="activity-search" type="text" placeholder="Search activity..." class="activity-search" value="${escapeHtml(_activityState.query)}">
    <button id="activity-export" class="activity-icon-btn" title="Export to JSON file" aria-label="Export to JSON file">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
  `;
  bar.querySelector('#activity-search').addEventListener('input', (e) => {
    _activityState.query = e.target.value.trim().toLowerCase();
    const body = document.getElementById('activity-feed-body');
    if (body) renderActivityBody(body);
  });
  bar.querySelector('#activity-export').addEventListener('click', () => {
    const filtered = filterActivity(_activityState.items);
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const brand = document.getElementById('brand-select')?.value || 'brand';
    a.href = url;
    a.download = `merlin-activity-${brand}-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const btn = bar.querySelector('#activity-export');
    if (btn) {
      btn.classList.add('flash');
      setTimeout(() => btn.classList.remove('flash'), 900);
    }
  });
  return bar;
}

function filterActivity(items) {
  const q = _activityState.query;
  return items.filter(item => {
    if (!q) return true;
    const hay = [item.action, item.detail, item.product, item.sessionId, item.type]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

// Unity-player-log style single-line format. Timestamps are UTC ISO so
// support tickets are unambiguous across time zones.
function formatActivityForCopy(item) {
  const ts = item.ts || '';
  const sev = (item.severity || item.type || 'info').toUpperCase().padEnd(5);
  const sid = item.sessionId ? `[${item.sessionId}] ` : '';
  const ver = item.version ? ` v${item.version}` : '';
  const prod = item.product ? ` {${item.product}}` : '';
  const action = item.action || '';
  const detail = item.detail || '';
  return `${ts} ${sev} ${sid}${action}${prod}${ver} — ${detail}`;
}

function renderActivityBody(body) {
  body.innerHTML = '';
  const items = filterActivity(_activityState.items);

  if (items.length === 0) {
    const hasAny = _activityState.items.length > 0;
    body.innerHTML = hasAny
      ? '<div class="activity-empty-filtered">No matches for your search.</div>'
      : '<div class="activity-empty"><div class="activity-empty-icon">✦</div>No activity yet<br><span class="activity-empty-sub">Actions appear here as you create ads and run campaigns</span></div>';
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
      body.appendChild(header);
      lastDate = dateStr;
    }
    body.appendChild(renderActivityItem(item));
  });
}

function renderActivityItem(item) {
  const div = document.createElement('div');
  div.className = 'activity-item';
  const severity = item.severity || (item.type === 'error' ? 'error' : 'info');
  if (severity === 'error') div.classList.add('activity-item--error');
  else if (severity === 'warn') div.classList.add('activity-item--warn');

  const validTypes = ['create', 'optimize', 'publish', 'report', 'error', 'auth', 'config', 'sync', 'launch', 'scan', 'manage', 'setup', 'info'];
  const safeType = validTypes.includes(item.type) ? item.type : 'info';
  const dotClass = `activity-dot activity-dot-${safeType}`;
  const action = item.action || '';
  const detail = item.detail || '';
  const product = item.product ? ` · ${item.product}` : '';

  // Convert the raw action + detail into a plain-English description.
  //
  // REGRESSION GUARD (2026-04-15, human-readable-activity incident):
  // Spell entries used to render as the raw UUID — "a5c5e05c3107f48c0
  // completed" — because the default case did
  // `spellName = action.replace('spell-','')` which for auto-created
  // spells (taskId is a 16-char hex hash) produces the hash itself,
  // not a name. The `detail` field ALREADY contains a human sentence
  // ("Check mad-chill product completeness") — we just weren't
  // reading it. Always prefer `detail` over action-derived labels.
  // If you add a new action, either extend this switch with a short
  // label OR make sure the binary writes a readable `detail` string
  // on the activity.jsonl entry.
  const cleanDetail = (s) => {
    if (!s || typeof s !== 'string') return '';
    const out = s.trim().replace(/^[\-\s·•]+/, '');
    return out.length > 120 ? out.slice(0, 117) + '…' : out;
  };
  const humanizeSpellId = (id) => {
    if (!id) return 'Spell';
    const stripped = id.replace(/^spell-/, '');
    if (/^[0-9a-f]{8,}$/i.test(stripped)) return 'Scheduled spell';
    const words = stripped.replace(/-/g, ' ').trim();
    if (!words) return 'Scheduled spell';
    return words.charAt(0).toUpperCase() + words.slice(1);
  };
  const prettyDetail = cleanDetail(detail);
  const isTechDetail = (s) => {
    if (!s) return true;
    if (/^[a-z0-9_:.\s-]+$/.test(s) && s.includes(':') && !/\s[A-Z]/.test(s)) return true;
    return false;
  };
  const friendlyDetail = isTechDetail(prettyDetail) ? '' : prettyDetail;

  let desc = '';
  switch (action) {
    case 'video': desc = friendlyDetail || `New video${product}`; break;
    case 'image': desc = friendlyDetail || `New ad image${product}`; break;
    case 'blog': desc = friendlyDetail || 'Blog post published'; break;
    case 'kill': desc = `Ad paused${friendlyDetail ? ' — ' + friendlyDetail : ''}`; break;
    case 'scale': desc = `Winner scaled${friendlyDetail ? ' — ' + friendlyDetail : ''}`; break;
    case 'meta-push': desc = friendlyDetail || 'Ad live on Meta'; break;
    case 'tiktok-push': desc = friendlyDetail || 'Ad live on TikTok'; break;
    case 'google-ads-push': desc = friendlyDetail || 'Ad live on Google'; break;
    case 'amazon-ads-push': desc = friendlyDetail || 'Ad live on Amazon'; break;
    case 'reddit-create-ad': desc = friendlyDetail || 'Ad live on Reddit'; break;
    case 'linkedin-push': desc = friendlyDetail || 'Ad live on LinkedIn'; break;
    case 'dashboard': desc = friendlyDetail || 'Performance check'; break;
    case 'report': desc = friendlyDetail || 'Report generated'; break;
    default:
      if (action && action.startsWith('spell-')) {
        const spellName = humanizeSpellId(action);
        const failed = prettyDetail.toLowerCase().includes('failed')
          || (item.type === 'error');
        if (prettyDetail && !prettyDetail.toLowerCase().endsWith('completed')
                         && !prettyDetail.toLowerCase().endsWith('failed')) {
          desc = failed ? `⚠ ${prettyDetail}` : `✓ ${prettyDetail}`;
        } else {
          desc = failed ? `⚠ ${spellName} failed` : `✓ ${spellName} completed`;
        }
      } else if (prettyDetail) {
        desc = prettyDetail;
      } else if (action) {
        desc = action.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      } else {
        desc = 'Activity';
      }
  }

  const time = item.ts ? new Date(item.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
  div.innerHTML = `
    <span class="${dotClass}"></span>
    <span class="activity-desc">${escapeHtml(desc)}</span>
    <span class="activity-time">${time}</span>
  `;

  // Click the row to reveal the raw JSON entry. This is the "Unity player
  // log" affordance — support asks "paste me the line", the user clicks,
  // hits copy, done. No export required for a single entry.
  div.addEventListener('click', (e) => {
    // Ignore clicks that land on the copy button inside an expanded panel.
    if (e.target.closest('.activity-raw-copy')) return;
    const next = div.nextElementSibling;
    if (next && next.classList.contains('activity-raw')) {
      next.remove();
      return;
    }
    const raw = document.createElement('div');
    raw.className = 'activity-raw';
    const pretty = JSON.stringify(item, null, 2);
    raw.innerHTML = `
      <button class="activity-raw-copy" title="Copy JSON">Copy</button>
      <pre>${escapeHtml(pretty)}</pre>
    `;
    raw.querySelector('.activity-raw-copy').addEventListener('click', (ev) => {
      ev.stopPropagation();
      navigator.clipboard.writeText(formatActivityForCopy(item) + '\n' + pretty).catch(() => {});
      const b = ev.currentTarget; const prev = b.textContent;
      b.textContent = 'Copied'; setTimeout(() => (b.textContent = prev), 900);
    });
    div.after(raw);
  });

  return div;
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

  // Progress feedback is conveyed entirely via the spinner + refresh button
  // aria-busy state. Inline status text was wrapping character-per-line in the
  // narrow (340px) Archive panel — spinner alone is cleaner. Failures surface
  // through the chat toast below.

  refreshBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (refreshBtn.classList.contains('refreshing')) return;
    refreshBtn.classList.add('refreshing');
    refreshBtn.setAttribute('aria-busy', 'true');
    const brand = document.getElementById('brand-select')?.value || '';
    let ok = false;
    try {
      await merlin.refreshLiveAds(brand || null);
      ok = true;
    } catch (err) {
      console.warn('[archive] refresh failed', err);
    }
    refreshBtn.classList.remove('refreshing');
    refreshBtn.removeAttribute('aria-busy');
    if (!ok && typeof showCopyToast === 'function') {
      showCopyToast('Refresh failed — check connections');
    }
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

  // Race guard: every call bumps a sequence token; async results from a
  // stale call (user rapidly switched tabs/brands) bail out instead of
  // appending cards into a grid that already belongs to a newer load.
  const mySeq = (window._archiveLoadSeq = (window._archiveLoadSeq || 0) + 1);
  const isStale = () => window._archiveLoadSeq !== mySeq;

  const typeFilter = document.querySelector('.archive-filter.active')?.dataset.filter || 'all';
  const search = document.getElementById('archive-search').value.trim().toLowerCase();
  const activeBrandRaw = document.getElementById('brand-select')?.value || '';
  const brandLabel = activeBrandRaw ? activeBrandRaw.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';

  // Clear multi-select on tab switch
  window._archiveSelected = [];
  const existingMerge = document.getElementById('merge-btn');
  if (existingMerge) existingMerge.style.display = 'none';

  if (typeFilter === 'swipes') {
    // Show competitor swipe files
    const brand = activeBrandRaw;
    loading.style.display = 'none';

    let swipes = [];
    try {
      swipes = await merlin.getSwipes(brand);
    } catch {}
    if (isStale()) return;

    // Client-side search filter — match brand, hook, or platform
    if (search) {
      swipes = swipes.filter(s => {
        const hay = `${s.brand || ''} ${s.hook || ''} ${s.platform || ''}`.toLowerCase();
        return hay.includes(search);
      });
    }

    if (!swipes || swipes.length === 0) {
      empty.querySelector('p').textContent = search ? 'No swipes match that search' : 'No swipes yet';
      empty.querySelector('.archive-empty-sub').textContent = search
        ? 'Try a different brand, hook, or platform name'
        : (brandLabel ? `Run a competitor scan for ${brandLabel} to collect ad swipes` : 'Run a competitor scan to collect ad swipes');
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
    const activeBrand = activeBrandRaw || null;
    let ads = await merlin.getLiveAds(activeBrand);
    if (isStale()) return;
    loading.style.display = 'none';

    // Client-side search filter — match product, ad name, brand, platform, or status
    if (search) {
      ads = (ads || []).filter(a => {
        const hay = `${a.product || ''} ${a.adName || ''} ${a.brand || ''} ${a.platform || ''} ${a.status || ''}`.toLowerCase();
        return hay.includes(search);
      });
    }

    if (!ads || ads.length === 0) {
      empty.querySelector('p').textContent = search ? 'No live ads match that search' : (brandLabel ? `No live ads cached for ${brandLabel}` : 'No live ads cached yet');
      empty.querySelector('.archive-empty-sub').textContent = search
        ? 'Try a different product, platform, or status'
        : 'Click ↻ to pull your current ads from Meta, TikTok, Google, Amazon, Reddit and LinkedIn';
      empty.style.display = 'block';
      return;
    }

    // Rank ads by decision-value so the Archive doesn't flood with dozens of
    // zero-impression shells. Order of priority:
    //   1. Paused ads stay visible but sink (so users see them last, not lost)
    //   2. Ads with spend > 0 sort by spend desc — these are the ones a CMO
    //      actually has to act on (kill/scale)
    //   3. Recently-updated ads come next
    //   4. Pure placeholder entries (zero impressions + zero spend) drop to
    //      the end and visually dim so they don't crowd the grid
    const adValue = (a) => {
      const spend = Number(a.spend) || 0;
      const imps = Number(a.impressions) || 0;
      const roas = Number(a.lastRoas) || 0;
      // Paused ads get a floor below any live ad so they sink — but still
      // within-group sorted by spend so high-spend paused ads surface first.
      const statusPenalty = a.status === 'paused' ? -1e9 : 0;
      // Strong signal: actual spend. Secondary: ROAS as a tiebreaker so two
      // equal-spend ads still surface the winner. Impressions as third-tier.
      return statusPenalty + spend * 1000 + roas * 100 + imps * 0.001;
    };
    ads = ads.slice().sort((a, b) => adValue(b) - adValue(a));

    ads.forEach(ad => {
      const card = document.createElement('div');
      card.className = 'archive-card';

      const statusClass = ad.status === 'live' ? 'status-live' : ad.status === 'paused' ? 'status-paused' : 'status-pending';
      const statusText = ad.status === 'live' ? '● Live' : ad.status === 'paused' ? '○ Paused' : '◐ Pending';
      const budgetText = ad.budget ? `$${ad.budget}/day` : '';

      // Format KPIs defensively — insights may not have run yet for a new ad
      const fmtMoney = (n) => n >= 1000 ? `$${(n/1000).toFixed(1)}k` : `$${n.toFixed(2)}`;
      const fmtInt = (n) => n >= 1000 ? `${(n/1000).toFixed(1)}k` : `${Math.round(n)}`;
      const roas = Number(ad.lastRoas) || 0;
      const spend = Number(ad.spend) || 0;
      const impressions = Number(ad.impressions) || 0;
      const ctr = Number(ad.ctr) || 0;
      const cpa = Number(ad.cpa) || 0;
      const hasMetrics = spend > 0 || impressions > 0;
      // A card is "dormant" (visually de-emphasized) only when there are no
      // metrics AND no image to show. Either a local creative path OR a remote
      // platform thumbnail counts as "has a visual", so externally-run Meta
      // ads with live impressions now render at full opacity.
      const hasThumb = !!(ad.creativePath || ad.creativeUrl);
      const isDormant = !hasMetrics && !hasThumb;

      // ROAS coloring: green >= 2x, amber 1-2x, red < 1x, dim for no data
      let roasClass = 'kpi-dim';
      if (roas >= 2) roasClass = 'kpi-good';
      else if (roas >= 1) roasClass = 'kpi-warn';
      else if (roas > 0) roasClass = 'kpi-bad';

      // Dim the whole card if it's a pure placeholder — still visible but
      // clearly deprioritized so users don't mistake it for a live winner.
      if (isDormant) card.classList.add('archive-card-dormant');

      // Prefer local creativePath (ads pushed through Merlin) since it's
      // permanent; fall back to creativeUrl (Meta CDN thumbnail) for ads the
      // user launched outside Merlin — those URLs are signed and expire in
      // ~24h but get re-fetched on every insights refresh.
      // Thumb and info render in a single innerHTML pass below so the image
      // element's error/load handlers (bound after insertion) survive — an
      // earlier "card.innerHTML = img; card.innerHTML += info" sequence
      // destroyed the img element during the += reparse and silently
      // discarded the fallback handlers, leaving broken CDN URLs to paint as
      // the browser's default broken-image glyph.
      const platformName = escapeHtml(ad.platform || '');
      const placeholderHTML = `<div class="archive-card-thumb archive-card-thumb-placeholder">
          <div class="placeholder-mark" aria-hidden="true">✦</div>
          ${platformName ? `<div class="placeholder-platform-chip">${platformName}</div>` : ''}
        </div>`;
      const altText = escapeHtml(ad.adName || ad.product || 'Ad creative');
      let thumbHtml;
      if (ad.creativePath) {
        thumbHtml = `<img class="archive-card-thumb" src="${escapeHtml(merlinUrl(ad.creativePath))}" alt="${altText}" loading="lazy">`;
      } else if (ad.creativeUrl) {
        thumbHtml = `<img class="archive-card-thumb" src="${escapeHtml(ad.creativeUrl)}" alt="${altText}" loading="lazy" referrerpolicy="no-referrer">`;
      } else {
        thumbHtml = placeholderHTML;
      }

      const brandLabel = ad.brand ? ad.brand.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';
      const displayTitle = ad.adName || ad.product || ad.platform || 'Ad';

      // KPI strip — show only what we actually have. Avoids "Collecting..."
      // soup that made every card look identical.
      const kpiChips = [];
      if (roas > 0) {
        kpiChips.push(`<span class="kpi-chip ${roasClass}" data-tip="Return on ad spend — revenue ÷ spend" data-tip-pos="top">${roas.toFixed(2)}x ROAS</span>`);
      }
      if (spend > 0) {
        kpiChips.push(`<span class="kpi-chip" data-tip="Total spend this window" data-tip-pos="top">${fmtMoney(spend)}</span>`);
      }
      if (ctr > 0) {
        const ctrClass = ctr >= 2 ? 'kpi-good' : ctr >= 1 ? 'kpi-warn' : 'kpi-bad';
        kpiChips.push(`<span class="kpi-chip ${ctrClass}" data-tip="Click-through rate — clicks ÷ impressions" data-tip-pos="top">${ctr.toFixed(2)}% CTR</span>`);
      }
      if (cpa > 0) {
        kpiChips.push(`<span class="kpi-chip" data-tip="Cost per acquisition" data-tip-pos="top">${fmtMoney(cpa)} CPA</span>`);
      }
      if (impressions > 0) {
        kpiChips.push(`<span class="kpi-chip kpi-dim" data-tip="Impressions this window" data-tip-pos="top">${fmtInt(impressions)} imp</span>`);
      }

      const infoHtml = `
        <div class="archive-card-info">
          <div class="archive-card-title" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</div>
          <div class="archive-card-meta">
            <span class="archive-card-badge ${statusClass}">${statusText}</span>
            <span class="platform-badge platform-${(ad.platform || '').toLowerCase()}">${escapeHtml(ad.platform || '')}</span>
            ${budgetText ? `<span>${budgetText}</span>` : ''}
          </div>
          ${kpiChips.length ? `<div class="archive-card-kpis">${kpiChips.join('')}</div>` :
            hasMetrics ? '' : `<div class="archive-card-meta archive-card-hint">0 impressions</div>`}
          ${brandLabel ? `<div class="archive-card-meta archive-card-brand">${escapeHtml(brandLabel)}</div>` : ''}
        </div>`;

      card.innerHTML = thumbHtml + infoHtml;

      // Bind error/load fallbacks AFTER the final innerHTML is parsed — an
      // earlier "innerHTML = img; innerHTML += info" sequence tore down the
      // img element during the += reparse and silently discarded these
      // handlers, which is why expired Meta CDN URLs were painting as the
      // browser's default broken-image glyph instead of our placeholder.
      // outerHTML replacement scopes the fallback to the thumb, leaving the
      // KPI strip + brand label untouched.
      // Cards that fall back to the placeholder (no image src OR image fails to
      // load) must NOT be clickable — opening a preview modal for an ad with
      // no renderable creative just shows another broken-image glyph, which
      // was the regression the user reported. Flag the card as "static" and
      // use it to gate both the click handler and the pointer cursor.
      //
      // REGRESSION GUARD (2026-04-20, archive-thumb-fix incident):
      // Do NOT gate the swap on naturalWidth — an earlier guard swapped any
      // image < 80px to the sparkle placeholder to hide Meta's generic DPA
      // silhouette, but Meta's `thumbnail_url` for LEGITIMATE image/video
      // creatives is also 64x64, so every externally-run ad in the Archive
      // rendered as a sparkle even though creativeUrl was populated. CSS
      // (`object-fit: cover`, `aspect-ratio: 1`) upscales small thumbnails
      // cleanly; DPA silhouettes upscale too but that's a far smaller UX hit
      // than hiding every real creative. Keep ONLY the error handler — it's
      // the reliable signal for expired/404 CDN URLs.
      let isStaticCard = !ad.creativePath && !ad.creativeUrl;
      const thumbImg = card.querySelector('img.archive-card-thumb');
      if (thumbImg) {
        thumbImg.addEventListener('error', () => {
          thumbImg.outerHTML = placeholderHTML;
          isStaticCard = true;
          card.classList.add('archive-card-static');
        }, { once: true });
      }
      if (isStaticCard) card.classList.add('archive-card-static');

      // Left click: preview the creative. Prefer local path over remote URL.
      card.addEventListener('click', () => {
        if (isStaticCard) return;
        const previewSrc = ad.creativePath || ad.creativeUrl;
        if (previewSrc) {
          openArchivePreview({ type: 'image', thumbnail: previewSrc, folder: '', files: [] });
        }
      });

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

        // Map a platform name to the Go binary's kill action. When we can't
        // match (new platform, typo, or missing `platform` field) we fall
        // back to a natural-language instruction — Claude can still route
        // it, but we prefer naming the exact action when we know it.
        const killActionByPlatform = {
          meta: 'meta-kill',
          facebook: 'meta-kill',
          instagram: 'meta-kill',
          tiktok: 'tiktok-kill',
          google: 'google-ads-kill',
          'google ads': 'google-ads-kill',
          amazon: 'amazon-ads-kill',
          'amazon ads': 'amazon-ads-kill',
          reddit: 'reddit-kill',
          linkedin: 'linkedin-kill',
        };
        const platformKey = (ad.platform || '').toLowerCase().trim();
        const killAction = killActionByPlatform[platformKey] || '';

        if (ad.status === 'live') {
          const pauseItem = document.createElement('div');
          pauseItem.className = 'context-menu-item';
          pauseItem.textContent = '⏸ Pause this ad';
          pauseItem.addEventListener('click', () => {
            menu.remove();
            document.querySelectorAll('.context-submenu').forEach(s => s.remove());
            document.getElementById('archive-panel').classList.add('hidden');
            // Vertical-aware fallback: when the ad has no resolvable "product"
            // (typical for SaaS/games/creator/services) use the vertical's
            // offeringNoun (plan/title/course/service) so the user bubble
            // and LLM prompt read naturally instead of saying "ad" twice.
            const label = ad.product || currentVerticalProfile.offeringNoun || 'ad';
            addUserBubble(`Pause ${label} on ${ad.platform}`);
            showTypingIndicator();
            turnStartTime = Date.now();
            turnTokens = 0;
            sessionActive = true;
            startTickingTimer();
            const killHint = killAction
              ? `Use ${killAction} with adId "${ad.adId}".`
              : `Use the appropriate pause action for ${ad.platform} with adId "${ad.adId}".`;
            merlin.sendMessage(`Pause the ad "${label}" on ${ad.platform} (Ad ID: ${ad.adId}). ${killHint}`);
          });
          menu.appendChild(pauseItem);
        }

        if (ad.status === 'paused') {
          const resumeItem = document.createElement('div');
          resumeItem.className = 'context-menu-item';
          resumeItem.textContent = '▶ Resume this ad';
          resumeItem.addEventListener('click', () => {
            menu.remove();
            document.querySelectorAll('.context-submenu').forEach(s => s.remove());
            document.getElementById('archive-panel').classList.add('hidden');
            const label = ad.product || currentVerticalProfile.offeringNoun || 'ad';
            addUserBubble(`Resume ${label} on ${ad.platform}`);
            showTypingIndicator();
            turnStartTime = Date.now();
            turnTokens = 0;
            sessionActive = true;
            startTickingTimer();
            merlin.sendMessage(`Resume the paused ad "${label}" on ${ad.platform} (Ad ID: ${ad.adId}). Re-enable it at the same budget using the appropriate resume/update action for ${ad.platform}.`);
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
          // Track the current submenu on the copy item so mouseleave, menu
          // close, and option-click all have a single source of truth to
          // remove from the document body. Before this, submenus leaked
          // after Copy→option clicks (menu removed, submenu orphaned).
          const removeSubmenu = () => {
            if (copyItem._submenu) {
              try { copyItem._submenu.remove(); } catch {}
              copyItem._submenu = null;
            }
          };
          copyItem.addEventListener('mouseenter', () => {
            if (copyItem._submenu) return;
            const sub = document.createElement('div');
            sub.className = 'context-submenu';
            copyItem._submenu = sub;
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
            const closeAll = () => { removeSubmenu(); menu.remove(); };
            // "All" option at top
            const allOpt = document.createElement('div');
            allOpt.className = 'context-menu-item';
            allOpt.textContent = 'All platforms';
            allOpt.addEventListener('click', () => {
              closeAll();
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
                closeAll();
                addUserBubble(`Copy "${ad.product}" ad to ${p}`);
                showTypingIndicator(); turnStartTime = Date.now(); sessionActive = true; startTickingTimer();
                merlin.sendMessage(`Duplicate the winning ad "${ad.product}" (Ad ID: ${ad.adId}, platform: ${ad.platform}) to ${p}. Use the same creative and budget.`);
              });
              sub.appendChild(opt);
            });
            document.body.appendChild(sub);
            requestAnimationFrame(positionSub);
          });
          // Hide the submenu when the pointer leaves BOTH the copy row
          // and the submenu itself — use relatedTarget so moving INTO
          // the submenu does not trigger a close.
          copyItem.addEventListener('mouseleave', (ev) => {
            const next = ev.relatedTarget;
            if (next && copyItem._submenu && copyItem._submenu.contains(next)) return;
            removeSubmenu();
          });
          menu.appendChild(copyItem);
        }

        const detailsItem = document.createElement('div');
        detailsItem.className = 'context-menu-item';
        detailsItem.textContent = '📋 View details';
        detailsItem.addEventListener('click', () => {
          menu.remove();
          document.querySelectorAll('.context-submenu').forEach(s => s.remove());
          const src = ad.creativePath || ad.creativeUrl;
          if (src) openArchivePreview({ type: 'image', thumbnail: src, folder: '', files: [] });
        });
        menu.appendChild(detailsItem);

        document.body.appendChild(menu);
        // Close on click outside (or Escape)
        setTimeout(() => {
          const cleanup = () => {
            try { menu.remove(); } catch {}
            document.querySelectorAll('.context-submenu').forEach(s => s.remove());
            document.removeEventListener('click', dismiss);
            document.removeEventListener('contextmenu', dismiss);
            document.removeEventListener('keydown', escDismiss);
          };
          const dismiss = (ev) => {
            if (!menu.contains(ev.target) && !ev.target.closest('.context-submenu')) {
              cleanup();
            }
          };
          const escDismiss = (ev) => {
            if (ev.key === 'Escape') cleanup();
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
      brand: activeBrandRaw,
    });
    if (isStale()) return;
    loading.style.display = 'none';

    if (!items || items.length === 0) {
      const p = empty.querySelector('p');
      const sub = empty.querySelector('.archive-empty-sub');
      if (search) {
        if (p) p.textContent = 'Nothing matches that search';
        if (sub) sub.textContent = 'Try a different product, brand, or model name';
      } else if (brandLabel) {
        if (p) p.textContent = `No ${typeFilter === 'all' ? 'creatives' : typeFilter + 's'} for ${brandLabel} yet`;
        if (sub) sub.textContent = `Generate an image or video for ${brandLabel} to see it here`;
      } else {
        if (p) p.textContent = 'Nothing here yet';
        if (sub) sub.textContent = 'Generated images and videos will appear here';
      }
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
    observeLazyVideos(grid);
  } catch (err) {
    console.warn('[archive]', err);
    if (isStale()) return;
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

// Human-readable model label for the Archive card subtitle.
// Examples: "fal/banana-pro-edit" → "Banana Pro Edit",
// "fal/seedance-2 (image-to-video)" → "Seedance 2",
// "heygen/video-agent" → "Video Agent", "arcads" → "Arcads".
// Takes the segment after the last '/' (model name, vendor-implicit), strips
// the trailing `(qualifier)` that the Go binary appends, humanizes hyphens,
// and preserves version tokens (v2, v4.5) + pure-digit tokens as-is.
function prettyModelName(model) {
  if (!model || typeof model !== 'string') return '';
  let s = model.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!s) return '';
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/[-_]+/g, ' ').trim();
  if (!s) return '';
  return s.split(/\s+/).map(w => {
    if (/^v\d+(\.\d+)*$/i.test(w)) return w.toLowerCase();
    if (/^\d+$/.test(w)) return w;
    if (/^(ii|iii|iv|vi|vii|viii|ix|xi|xii)$/i.test(w)) return w.toUpperCase();
    if (/^(hd|4k|8k|uhd|ai|hq|api|sdk|xl)$/i.test(w)) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

function createArchiveCard(item) {
  const card = document.createElement('div');
  card.className = 'archive-card';
  card.dataset.folder = item.folder || '';
  card.dataset.type = item.type || 'image';
  card.dataset.source = item.source || '';
  if (item.source === 'loose' && Array.isArray(item.files) && item.files.length) {
    try { card.dataset.files = JSON.stringify(item.files.filter(f => typeof f === 'string')); } catch {}
  }
  card._archiveItem = item;

  const isVideo = item.type === 'video';
  const badgeClass = isVideo ? 'badge-video' : 'badge-image';
  const badgeText = isVideo ? 'Video' : 'Image';
  // Human-readable title: prefer product > brand > model > friendly type
  let title = '';
  let titleFromModel = false;
  if (item.product) title = item.product.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  else if (item.brand) title = item.brand.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  else if (item.model) { title = item.model.split('/').pop().split('(')[0].trim(); titleFromModel = true; }
  else title = isVideo ? 'Video Ad' : 'Ad Image';
  const modelLabel = (!titleFromModel && item.model) ? prettyModelName(item.model) : '';
  const time = new Date(item.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  card.setAttribute('tabindex', '0');
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${title}, ${badgeText}, ${time}`);

  if (item.thumbnail) {
    card.innerHTML = `<img class="archive-card-thumb" src="${escapeHtml(merlinUrl(item.thumbnail))}" alt="" loading="lazy">`;
  } else if (isVideo) {
    // No sibling _thumbnail.{jpg,png,webp} exists — fall back to the video
    // file itself with preload="metadata" so Chromium paints the first frame.
    // Lazy-loaded via IntersectionObserver (observeLazyVideos) to keep
    // scroll/first-paint cheap when dozens of videos are on screen.
    const files = item.files || [];
    const best =
      files.find(f => f === 'captioned.mp4') ||
      files.find(f => f === 'final.mp4') ||
      files.find(f => /\.(mp4|mov|webm|m4v)$/i.test(f));
    if (best) {
      const videoPath = merlinUrl((item.folder ? item.folder + '/' : '') + best);
      card.innerHTML = `<video class="archive-card-thumb archive-card-thumb-lazy" data-lazy-src="${escapeHtml(videoPath)}" muted preload="none" playsinline></video>`;
    } else {
      card.innerHTML = `<div class="archive-card-thumb" style="display:flex;align-items:center;justify-content:center;font-size:24px;color:var(--text-dim)">▶</div>`;
    }
  } else {
    card.innerHTML = `<div class="archive-card-thumb" style="display:flex;align-items:center;justify-content:center;font-size:24px;color:var(--text-dim)">✦</div>`;
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
      ${modelLabel ? `<div class="archive-card-model" title="${escapeHtml(item.model)}">${escapeHtml(modelLabel)}</div>` : ''}
      <div class="archive-card-meta">
        <span class="archive-card-badge ${badgeClass}">${badgeText}</span>
        <span>${time}</span>
      </div>
      ${extraBadges ? `<div class="archive-card-meta" style="margin-top:2px;gap:4px">${extraBadges}</div>` : ''}
    </div>
    <button class="archive-card-delete" type="button" aria-label="Delete ${escapeHtml(title)}" data-tip="Delete" data-tip-pos="bottom">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        <path d="M10 11v6"/>
        <path d="M14 11v6"/>
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      </svg>
    </button>`;

  const deleteBtn = card.querySelector('.archive-card-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      requestArchiveCardDelete(card, item, title);
    });
    deleteBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); }
    });
  }

  const activate = (e) => {
    // Pairing mode: if at least one swipe-card (competitor) is already selected,
    // clicks on archive cards toggle multi-select instead of opening preview.
    const sel = window._archiveSelected || [];
    if (sel.some(s => s.item && s.item.brand)) {
      if (e) { e.stopPropagation(); e.preventDefault(); }
      toggleArchiveSelect(card, item);
      return;
    }
    openArchivePreview(item);
  };
  card.addEventListener('click', activate);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(e);
    }
  });
  return card;
}

// Resolve delete targets for an archive card using the same source-aware logic
// as the right-click context menu (see REGRESSION GUARD in the contextmenu
// handler): loose items delete their own file list, run items delete the run
// folder. Never widens to the brand folder.
function resolveArchiveDeleteTargets(card) {
  const source = card?.dataset?.source || '';
  if (source === 'loose' && card?.dataset?.files) {
    try {
      const parsed = JSON.parse(card.dataset.files);
      if (Array.isArray(parsed)) {
        const files = parsed.filter(p => typeof p === 'string' && p);
        if (files.length) return files;
      }
    } catch {}
  }
  if (source === 'run' && card?.dataset?.folder) return [card.dataset.folder];
  if (card?.dataset?.folder) return [card.dataset.folder];
  return [];
}

async function requestArchiveCardDelete(card, item, title) {
  const targets = resolveArchiveDeleteTargets(card);
  if (targets.length === 0) { showCopyToast('Nothing to delete'); return; }
  const isVideo = item?.type === 'video';
  const label = isVideo ? 'video' : 'image';
  const safeTitle = title || (isVideo ? 'Video Ad' : 'Ad Image');
  showModal({
    title: 'Delete this ' + label + '?',
    body: '"' + safeTitle + '" will be permanently removed from disk. This cannot be undone.',
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    onConfirm: async () => {
      const target = targets.length > 1 ? targets : targets[0];
      const result = await merlin.deleteFile(target);
      if (result?.success) {
        showCopyToast('Deleted');
        card.style.opacity = '0';
        setTimeout(() => card.remove(), 300);
      } else {
        showCopyToast('Delete failed');
      }
    }
  });
}

// Lazy-load video <source>s inside an archive grid. Hydrates `data-lazy-src`
// onto `src` only when the card scrolls near the viewport, which keeps the
// first paint cheap even with hundreds of video cards. IntersectionObserver
// disconnects once every card has hydrated — and any prior observer attached
// to the same root is disconnected first so rebuilds don't leak observers.
const lazyVideoObservers = new WeakMap();
function observeLazyVideos(root) {
  if (!root) return;
  const prior = lazyVideoObservers.get(root);
  if (prior) { prior.disconnect(); lazyVideoObservers.delete(root); }
  const videos = root.querySelectorAll('video.archive-card-thumb-lazy[data-lazy-src]');
  if (!videos.length) return;
  if (typeof IntersectionObserver === 'undefined') {
    videos.forEach(v => {
      const src = v.getAttribute('data-lazy-src');
      if (src) { v.src = src; v.preload = 'metadata'; v.removeAttribute('data-lazy-src'); v.classList.remove('archive-card-thumb-lazy'); }
    });
    return;
  }
  let remaining = videos.length;
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const v = entry.target;
      const src = v.getAttribute('data-lazy-src');
      if (src) {
        v.src = src;
        v.preload = 'metadata';
        v.removeAttribute('data-lazy-src');
        v.classList.remove('archive-card-thumb-lazy');
      }
      io.unobserve(v);
      remaining -= 1;
      if (remaining <= 0) {
        io.disconnect();
        lazyVideoObservers.delete(root);
      }
    }
  }, { root: root.closest('.archive-content') || null, rootMargin: '200px 0px', threshold: 0.01 });
  lazyVideoObservers.set(root, io);
  videos.forEach(v => io.observe(v));
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
      ${tags.roas ? `<div class="preview-stat"><span class="preview-stat-label">ROAS</span><span style="color:#22c55e;font-weight:700">${escapeHtml(String(tags.roas))}x</span></div>` : ''}
      ${tags.hook ? `<div class="preview-stat"><span class="preview-stat-label">Hook</span><span>${escapeHtml(tags.hook)}</span></div>` : ''}
      ${tags.scene ? `<div class="preview-stat"><span class="preview-stat-label">Style</span><span>${escapeHtml(tags.scene)}</span></div>` : ''}
      ${tags.platform ? `<div class="preview-stat"><span class="preview-stat-label">Platform</span><span>${escapeHtml(tags.platform)}</span></div>` : ''}
      ${tags.daysRunning ? `<div class="preview-stat"><span class="preview-stat-label">Running</span><span>${escapeHtml(String(tags.daysRunning))} days</span></div>` : ''}
    </div>`;
  }

  // Fallback panel shown when the src fails to load (expired Meta CDN URL,
  // missing local file). Without this, a failed <img> paints the browser's
  // default broken-image glyph as a tiny floating tile — confusing and ugly.
  const previewFallbackHtml = `<div class="preview-fallback">
      <div class="preview-fallback-mark" aria-hidden="true">✦</div>
      <div class="preview-fallback-text">Preview unavailable</div>
      <div class="preview-fallback-sub">The creative's thumbnail URL has expired or the file is no longer on disk.</div>
    </div>`;

  if (isVideo && mediaPath) {
    overlay.innerHTML = `<div class="preview-layout"><video src="${escapeHtml(mediaPath)}" controls autoplay playsinline></video>${statsHtml}</div>`;
  } else if (mediaPath) {
    overlay.innerHTML = `<div class="preview-layout"><img src="${escapeHtml(mediaPath)}" alt="" data-folder="${escapeHtml(item.folder || '')}" data-file="${escapeHtml(decodeURIComponent(mediaPath.replace('merlin://', '')))}">${statsHtml}</div>`;
    const previewImg = overlay.querySelector('img');
    if (previewImg) {
      const swap = () => {
        const layout = overlay.querySelector('.preview-layout');
        if (layout) layout.innerHTML = previewFallbackHtml + statsHtml;
      };
      previewImg.addEventListener('error', swap, { once: true });
      previewImg.addEventListener('load', () => {
        if (previewImg.naturalWidth > 0 && previewImg.naturalWidth < 80) swap();
      }, { once: true });
    }
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

// Close archive when clicking into the chat transcript. The input bar is
// intentionally excluded — users frequently reference a visible archive
// card while typing in chat, and clicking the textarea used to dismiss the
// panel before they could finish their thought.
document.addEventListener('click', (e) => {
  const panel = document.getElementById('archive-panel');
  const btn = document.getElementById('archive-btn');
  if (panel && !panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== btn && !e.target.closest('#archive-btn')) {
    // Only close if clicking in the chat transcript area.
    if (!e.target.closest('#chat')) return;
    panel.classList.add('hidden');
  }
});

// Escape key closes the archive panel when no modal/preview/context-menu is
// already intercepting the key. Previews and context menus register their
// own Escape handlers and call stopPropagation, so this only fires when the
// archive is the front-most dismissible surface.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const panel = document.getElementById('archive-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  if (document.querySelector('.archive-preview')) return;
  if (document.querySelector('.merlin-context-menu')) return;
  if (document.querySelector('.overlay:not(.hidden)')) return;
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && !panel.contains(active)) return;
  panel.classList.remove('expanded');
  const expandBtn = document.getElementById('archive-expand');
  if (expandBtn) expandBtn.textContent = '←';
  panel.classList.add('hidden');
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
    // Show the license-key input modal directly. Previously this removed
    // the overlay and called merlin.sendMessage(), which delegates to the
    // Claude SDK — on Mac the SDK isn't always ready right after trial
    // expiry, so the screen just went blank with no input field. The
    // modal flow below mirrors the gate in sendMessage() (line ~3324) so
    // the experience is identical whether the user clicks the button or
    // tries to type into the chat.
    showModal({
      title: 'Activate License Key',
      body: 'Enter your license key to unlock Merlin Pro.',
      inputPlaceholder: 'License key (e.g. XXXX-XXXX)',
      confirmLabel: 'Activate',
      cancelLabel: 'Cancel',
      onConfirm: (key) => {
        if (!key || key.length === 0) return;
        merlin.activateKey(key).then((result) => {
          if (result.success) {
            const btn = document.getElementById('subscribe-btn');
            btn.classList.remove('hidden-sub');
            btn.classList.add('subscribed');
            btn.style.borderColor = '';
            btn.style.animation = '';
            document.getElementById('trial-text').textContent = '✦ Pro';
            document.querySelector('.subscribe-cta').textContent = 'Manage';
            _trialExpired = false;
            overlay.remove();
            const bubble = addClaudeBubble();
            textBuffer = '✦ Welcome to Merlin Pro — all features unlocked.';
            finalizeBubble();
          } else {
            showModal({ title: 'Invalid Key', body: result.error || 'That key didn\'t work. Check for typos and try again.', confirmLabel: 'OK', onConfirm: () => {} });
          }
        });
      },
      onCancel: () => {},
    });
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

    const nextStep = steps.find(s => !s.done)?.key;
    const nextLabels = {
      brand: 'Next: Set up a brand with Merlin before connecting your store.',
      products: 'Next: add at least one product so Merlin can create creative.',
      sales: 'Next: connect your sales platform so Merlin can see store performance.',
      platform: 'Next: connect an ad platform like Meta, Google, or TikTok.',
      automation: 'Next: turn on your first automation.',
    };
    document.getElementById('progress-next').textContent = nextLabels[nextStep] || '';
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
