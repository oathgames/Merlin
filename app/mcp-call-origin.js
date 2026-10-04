// Merlin MCP call origin: who is calling a tool, and where its approval lives.
//
// REGRESSION GUARD (2026-10-04, desktop-approval): operator decision from Ryan.
// Approval belongs on the surface the operator is using. When a tool call
// arrives from an authenticated external MCP client (Claude Desktop, Codex,
// Cursor, Cline: anything that reaches Merlin through merlin-mcp-shim.js and
// the token-authenticated IPC endpoint in mcp-ipc-endpoint.js), that client
// already shows its own per-tool permission prompt. Merlin must NOT pop an
// in-app approval card for that call, and must not make the call wait on one.
// The call is treated exactly as an in-app call is after the operator clicks
// Approve on the card: the `approved` flag the engine's requireApproval()
// gates check is set by the app (see mcp-define-tool.js wrapHandler).
//
// HOW ORIGIN IS DETERMINED (the security-relevant part):
//
//   * Origin is a property of the TRANSPORT, never of the tool input. The IPC
//     endpoint stamps the handler's second argument (`extra`) with a module-
//     private Symbol, and only does so AFTER the per-boot shim token passed
//     its constant-time check. The in-app Claude Agent SDK path passes its own
//     `extra` object, which never carries this Symbol.
//   * A Symbol-keyed property cannot be produced by JSON. Tool arguments are
//     JSON on every path (SDK tool_use input, NDJSON over the pipe), so no
//     argument value, key, `__proto__` trick, or string like "external" can
//     claim external origin. isExternalOrigin() never looks at args at all.
//   * Do NOT replace this with a string flag on args, a header, an env var,
//     or anything else the caller controls. That would let an in-app tool
//     call (prompt-injected by a scraped page, say) skip the in-app card.
//
// WHAT IS NOT WAIVED for external calls (only the prompt moves surfaces):
// budget validation on the final number (Hard-Won Rule 1, validateBudget in
// mcp-tools.js plus validateDailyBudget in the engine), BudgetAbsoluteCeiling
// and the cents detector as hard refusals, monthly caps, the master spend
// pause, platform rate-limit preflight, the pixel and page gates, the
// preview/confirm_token payload binding, and the hard-deny list. Rule 25's
// "high-magnitude spend always gets a human look" is satisfied by the MCP
// client's tool prompt, which shows the dailyBudget argument; the amount is
// also echoed in the result's meta.approval so it stays on the record.

'use strict';

// Module-private. Exported only so the IPC endpoint and tests can construct
// an external `extra`; nothing derived from tool input can ever equal it.
const EXTERNAL_MCP_ORIGIN = Symbol('merlin.mcpCallOrigin.external');

function externalOriginExtra(client) {
  const extra = {};
  Object.defineProperty(extra, EXTERNAL_MCP_ORIGIN, {
    value: Object.freeze({ client: typeof client === 'string' && client ? client : 'mcp-client' }),
    enumerable: false,
  });
  return Object.freeze(extra);
}

function isExternalOrigin(extra) {
  if (!extra || typeof extra !== 'object') return false;
  const marker = extra[EXTERNAL_MCP_ORIGIN];
  return !!(marker && typeof marker === 'object');
}

function externalClientLabel(extra) {
  if (!isExternalOrigin(extra)) return '';
  return extra[EXTERNAL_MCP_ORIGIN].client;
}

module.exports = {
  EXTERNAL_MCP_ORIGIN,
  externalOriginExtra,
  isExternalOrigin,
  externalClientLabel,
};
