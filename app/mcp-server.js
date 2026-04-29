// Merlin MCP Server — In-Process Tool Registration
//
// Creates an MCP server using the Claude Agent SDK's createSdkMcpServer().
// Runs inside Electron's main process — no separate child process, no cloud.
// All tool handlers have direct access to the vault, config, and binary via
// the injected context object.
//
// Security guarantee: credentials are read from the vault INSIDE this
// process and passed to the binary via ephemeral temp configs. Claude
// only sees sanitized tool results — never raw tokens.

'use strict';

const path = require('path');
const { buildTools } = require('./mcp-tools');
const { JobStore } = require('./mcp-jobs');

// Resolve the SDK module. Prefers the already-imported module passed in via
// ctx.sdkModule (from main.js's importClaudeAgentSdk(), which correctly
// handles the app.asar.unpacked path on all platforms). Falls back to a
// local import that mirrors main.js's platform-aware path resolution.
let _sdkModule = null;
async function importSdk(ctx) {
  if (_sdkModule) return _sdkModule;

  // Best path: reuse the module main.js already loaded. This guarantees
  // the MCP server and query() use the exact same SDK instance — no dual-
  // package hazard, no asar resolution issues.
  if (ctx && ctx.sdkModule) {
    _sdkModule = ctx.sdkModule;
    return _sdkModule;
  }

  // Fallback: import ourselves, using the same platform-aware path as
  // importClaudeAgentSdk() in main.js.
  try {
    _sdkModule = await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    const path = require('path');
    const app = require('electron').app;
    // Mac:   exe is at Contents/MacOS/Merlin → resources at Contents/Resources/
    // Win:   exe is at root → resources at root/resources/
    const resourcesDir = process.platform === 'darwin'
      ? path.join(path.dirname(app.getPath('exe')), '..', 'Resources')
      : path.join(path.dirname(app.getPath('exe')), 'resources');
    const unpacked = path.join(
      resourcesDir, 'app.asar.unpacked', 'node_modules',
      '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'
    );
    // ESM import() requires a file:// URL on all platforms
    _sdkModule = await import('file://' + unpacked.replace(/\\/g, '/'));
  }
  return _sdkModule;
}

/**
 * Create the Merlin MCP server instance.
 *
 * @param {object} ctx - Dependency-injected context from main.js:
 *   - getBinaryPath(): string
 *   - readConfig(): object
 *   - readBrandConfig(brand): object
 *   - vaultGet(brand, key): string|null
 *   - vaultPut(brand, key, value): void
 *   - writeBrandTokens(brand, tokens): void
 *   - runOAuthFlow(platform, brand, extra): Promise<{success?, error?}>
 *   - getConnections(brand): [{platform, status}]
 *   - appRoot: string
 *   - activeChildProcesses: Set
 *   - appendAudit(event, details): void
 *   - sdkModule: object (optional — pre-imported SDK module from importClaudeAgentSdk())
 *
 * @returns {Promise<McpSdkServerConfigWithInstance>} — pass to query options.mcpServers
 */
async function createMerlinMcpServer(ctx) {
  const sdk = await importSdk(ctx);
  const { createSdkMcpServer, tool } = sdk;

  // Zod is a peer dependency of the SDK — both the SDK and Merlin resolve
  // to the same copy in node_modules/zod. The tool() function accepts
  // ZodRawShape objects for input schema validation.
  const z = require('zod');

  // Shared JobStore for long-running tools (bulk push, catalog sync,
  // full-site SEO audits). Lives under the Electron userData dir via
  // ctx.getJobsDir(), falling back to ctx.appRoot/.merlin-jobs.
  // Callers may override by pre-populating ctx.jobStore.
  if (!ctx.jobStore) {
    const jobsDir = typeof ctx.getJobsDir === 'function'
      ? ctx.getJobsDir()
      : path.join(ctx.appRoot || process.cwd(), '.merlin-jobs');
    try {
      ctx.jobStore = new JobStore({ dir: jobsDir });
    } catch (e) {
      console.warn('[mcp] JobStore init failed — long-running tools will report INTERNAL_ERROR:', e.message);
    }
  }

  const allTools = buildTools(tool, z, ctx);

  // §4.6 — stabilize MCP tool-block bytes across releases so Anthropic's
  // prompt cache keeps hitting on the tool-definitions prefix.
  //
  // The Claude Agent SDK auto-applies `cache_control: { type: 'ephemeral' }`
  // on the system + tools block; the breakpoint lives between `tools` and
  // the first user turn. Any byte that changes in the tools block
  // invalidates the cached prefix, so the first message of every session
  // after a release would re-tokenize the full tool schema (~15-20k
  // tokens across our ~20 MCP tools — that's a ~1-2s latency hit + a few
  // cents per user on every first turn).
  //
  // Server name is ALREADY stable ('merlin' → tools surface as
  // `mcp__merlin__<name>` in the schema). What we previously burned
  // cache on was `version: require('../package.json').version` — a
  // version bump nudged the tools-block bytes and nuked the prefix.
  //
  // Pin to a stable sentinel. The SDK only uses `version` for MCP
  // introspection responses (`initialize`, `ping`) — it's NOT
  // load-bearing for tool dispatch or for the agent's prompt. The app
  // version we actually care about (shipped to users, displayed in
  // About) lives in package.json and is unaffected.
  //
  // If you ever BUMP this sentinel, expect one cache-miss latency spike
  // per user on the first message of the release and plan comms
  // accordingly. Do not make it a computed value.
  const MCP_TOOL_SCHEMA_VERSION = '1.0.0';

  const server = createSdkMcpServer({
    name: 'merlin',
    version: MCP_TOOL_SCHEMA_VERSION,
    tools: allTools,
  });

  console.log(`[mcp] Merlin server registered with ${allTools.length} tools (schema v${MCP_TOOL_SCHEMA_VERSION})`);
  // Stash the wrapped tools array on the server config so the IPC
  // sidecar endpoint (mcp-ipc-endpoint.js, used by Claude Desktop via
  // merlin-mcp-shim.js) can dispatch against the SAME registry the
  // in-app SDK uses. We keep a single tool array; both consumers
  // call the same handlers; redaction + concurrency + idempotency
  // pipelines apply uniformly. The field name is namespaced so the
  // SDK never collides with it (the SDK only reads `name`, `version`,
  // `instance`, `tools`, `type`).
  server._merlinTools = allTools;
  return server;
}

module.exports = { createMerlinMcpServer };
