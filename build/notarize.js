const path = require('path');

exports.default = async function notarizeIfConfigured(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    if (process.env.CI) {
      throw new Error('[notarize] FATAL: Apple credentials missing in CI — APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID are all required');
    }
    console.log('[notarize] Skipping (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set).');
    return;
  }

  let notarize;
  try {
    ({ notarize } = require('@electron/notarize'));
  } catch (err) {
    if (process.env.CI) {
      throw new Error('[notarize] FATAL: @electron/notarize module missing in CI — run npm install');
    }
    console.warn('[notarize] @electron/notarize is unavailable; skipping notarization.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const appBundleId = context.packager.appInfo.id || 'com.merlin.desktop';

  await notarize({
    appBundleId,
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log(`[notarize] Completed for ${appPath}`);
};
