// Browser-only preview harness: stubs the Electron contextBridge so renderer.js
// can run to completion under `npx serve`. Not shipped; gated to preview-harness.html.
//
// Strategy: Proxy all missing methods to a universal no-op so renderer.js can call
// any `merlin.*` or `merlin.onX(...)` without throwing, even ones we haven't listed.
(function installMerlinStub() {
  const noop = () => {};
  const asyncUndef = () => Promise.resolve();

  // Explicit overrides for calls whose return shape matters for renderer boot
  const overrides = {
    platform: 'win32',
    __previewHarness: true,

    // Subscription / licensing
    getSubscription: async () => ({ status: 'active', tier: 'pro', trialDaysLeft: 7 }),
    activateKey: async () => ({ success: true }),
    triggerClaudeLogin: async () => ({ success: false }),

    // Version + updates
    getVersion: async () => ({ version: '1.0.5-preview' }),
    checkForUpdates: async () => ({ hasUpdate: false }),

    // Brands / config
    getBrands: async () => [
      { name: 'acme', vertical: 'saas', productName: 'Acme SaaS' },
      { name: 'riverbed', vertical: 'ecommerce', productName: 'Riverbed Tees' },
      { name: 'pixel-forge', vertical: 'games', productName: 'Pixel Forge' },
    ],
    getBrand: async (name) => ({ name, vertical: 'saas' }),
    saveConfigField: async (field, value, brand) => {
      console.log('[preview-stub] saveConfigField', { field, value, brand });
      return { ok: true };
    },

    // State + briefing + setup
    loadState: async () => ({ activeBrand: 'acme' }),
    saveState: async () => ({}),
    getBriefing: async () => null,
    dismissBriefing: noop,
    checkSetup: async () => ({ needsSetup: false, completed: true }),
    startSession: noop,

    // Mobile QR pairing — brand-purple modules on a transparent bg so the
    // preview matches the real app's output (see app/qr.js generateQRDataUri).
    // Hand-built QR-shaped SVG; only the visual style needs to match reality.
    getMobileQR: async () => ({
      qrDataUri: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 25 25"><g fill="#a78bfa"><path d="M1 1h7v7h-7zM3 3h3v3h-3z" fill-rule="evenodd"/><path d="M17 1h7v7h-7zM19 3h3v3h-3z" fill-rule="evenodd"/><path d="M1 17h7v7h-7zM3 19h3v3h-3z" fill-rule="evenodd"/><rect x="10" y="1" width="1" height="1"/><rect x="12" y="1" width="1" height="1"/><rect x="14" y="2" width="1" height="1"/><rect x="10" y="3" width="1" height="1"/><rect x="13" y="4" width="1" height="1"/><rect x="11" y="5" width="1" height="1"/><rect x="14" y="5" width="1" height="1"/><rect x="1" y="10" width="1" height="1"/><rect x="3" y="11" width="1" height="1"/><rect x="5" y="10" width="1" height="1"/><rect x="7" y="11" width="1" height="1"/><rect x="10" y="10" width="2" height="2"/><rect x="13" y="11" width="1" height="1"/><rect x="15" y="10" width="1" height="1"/><rect x="17" y="11" width="1" height="1"/><rect x="19" y="10" width="1" height="1"/><rect x="21" y="11" width="1" height="1"/><rect x="23" y="10" width="1" height="1"/><rect x="10" y="14" width="1" height="1"/><rect x="12" y="13" width="2" height="2"/><rect x="15" y="14" width="1" height="1"/><rect x="17" y="13" width="2" height="2"/><rect x="20" y="14" width="1" height="1"/><rect x="22" y="13" width="2" height="2"/><rect x="10" y="17" width="1" height="1"/><rect x="12" y="17" width="1" height="1"/><rect x="14" y="18" width="1" height="1"/><rect x="16" y="17" width="1" height="1"/><rect x="19" y="17" width="1" height="1"/><rect x="21" y="18" width="1" height="1"/><rect x="23" y="17" width="1" height="1"/><rect x="11" y="20" width="1" height="1"/><rect x="13" y="21" width="1" height="1"/><rect x="15" y="20" width="1" height="1"/><rect x="17" y="21" width="2" height="2"/><rect x="20" y="20" width="1" height="1"/><rect x="22" y="21" width="1" height="1"/></g></svg>'),
      pwaUrl: 'https://relay.merlingotme.com/p/preview-abc123',
    }),

    // Connection status — light up many tiles so filtering is visible
    getConnectionStatus: async () => ({
      meta: true, tiktok: true, google: true, amazon: true, reddit: true,
      shopify: true, stripe: true, klaviyo: true, slack: true, discord: true,
      linkedin: false, etsy: true, pinterest: false, snapchat: false,
    }),
  };

  // Universal handler: any `onX(cb)` registration returns an unsubscribe fn.
  // Any other unknown method resolves to undefined (async) or no-op (sync) —
  // the shape rarely matters for boot.
  const handler = {
    get(target, prop) {
      if (prop in target) return target[prop];
      const name = String(prop);
      if (name.startsWith('on') && name.length > 2 && name[2] >= 'A' && name[2] <= 'Z') {
        return () => noop; // event registration → unsubscribe
      }
      return asyncUndef;
    },
  };

  window.merlin = new Proxy(overrides, handler);
})();
