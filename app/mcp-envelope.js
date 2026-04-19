// Merlin MCP — Universal Response Envelope
//
// Every tool returns the same envelope shape so the agent can branch on
// machine-readable fields instead of regex-parsing English prose.
//
// Legacy compat: the MCP SDK's `tool()` handler contract still requires
// `{content:[{type:'text',text:...}], isError?}`. We preserve that as the
// outer shell and embed the JSON envelope inside the text field. The agent
// parses it; older prompts that treated the whole text as a blob still see
// a human-readable summary on the first line.
//
// Envelope shape:
//   {
//     ok: true|false,
//     data: <tool-specific payload, never sensitive>,
//     cost: { usd_estimated?: number, api_calls?: number, duration_sec?: number },
//     progress: { jobId?: string, stage?: string, pct?: number, eta_sec?: number },
//     sideEffects: { persistedConfig?: {...}, filesWritten?: [...] },
//     nextSuggested: [toolName, ...],  // breadcrumbs for the agent
//     error: { code, message, next_action, retry_after_sec? } | null,
//     meta: { tool: string, brand?: string, durationMs: number, idempotent?: boolean }
//   }
//
// `error` is null on success, populated on failure. `ok` mirrors (error===null).
// Never put both data and error in a non-empty state simultaneously.

'use strict';

// First line of the text payload — human-readable summary the UI can show
// without parsing JSON. Keep terse. The JSON envelope follows after a blank line.
function summarize(envelope) {
  if (envelope.error) {
    return envelope.error.message || `Error: ${envelope.error.code}`;
  }
  if (envelope.progress && envelope.progress.jobId) {
    const stage = envelope.progress.stage || 'running';
    const pct = typeof envelope.progress.pct === 'number'
      ? ` (${Math.round(envelope.progress.pct * 100)}%)`
      : '';
    return `Job ${envelope.progress.jobId} ${stage}${pct}`;
  }
  if (envelope.data && typeof envelope.data === 'object') {
    if (typeof envelope.data.summary === 'string') return envelope.data.summary;
    if (typeof envelope.data.message === 'string') return envelope.data.message;
  }
  return 'Done.';
}

/**
 * Build a success envelope.
 * @param {object} opts
 * @param {*} opts.data - Tool-specific payload
 * @param {object} [opts.cost] - { usd_estimated, api_calls, duration_sec }
 * @param {object} [opts.progress] - { jobId, stage, pct, eta_sec }
 * @param {object} [opts.sideEffects] - { persistedConfig, filesWritten }
 * @param {string[]} [opts.nextSuggested] - Recommended follow-up tool names
 * @param {object} [opts.meta] - { tool, brand, durationMs, idempotent }
 */
function ok(opts = {}) {
  const envelope = {
    ok: true,
    data: opts.data === undefined ? null : opts.data,
    cost: opts.cost || null,
    progress: opts.progress || null,
    sideEffects: opts.sideEffects || null,
    nextSuggested: Array.isArray(opts.nextSuggested) ? opts.nextSuggested : null,
    error: null,
    meta: opts.meta || null,
  };
  return envelope;
}

/**
 * Build an error envelope.
 * @param {object} err - { code, message, next_action?, retry_after_sec? }
 * @param {object} [opts] - { data?, meta? }
 */
function fail(err, opts = {}) {
  if (!err || typeof err !== 'object' || typeof err.code !== 'string') {
    throw new TypeError('fail() requires an error object with a string `code`');
  }
  return {
    ok: false,
    data: opts.data === undefined ? null : opts.data,
    cost: null,
    progress: null,
    sideEffects: null,
    nextSuggested: null,
    error: {
      code: err.code,
      message: err.message || err.code,
      next_action: err.next_action || null,
      retry_after_sec: typeof err.retry_after_sec === 'number' ? err.retry_after_sec : null,
    },
    meta: opts.meta || null,
  };
}

/**
 * Render envelope to the MCP SDK's required `{content, isError}` shape.
 * Text field carries a human-readable first line + blank line + JSON envelope.
 */
function render(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new TypeError('render() requires an envelope object');
  }
  const summary = summarize(envelope);
  const json = JSON.stringify(envelope, null, 2);
  return {
    content: [{ type: 'text', text: `${summary}\n\n${json}` }],
    isError: !envelope.ok,
  };
}

/**
 * Parse a rendered envelope back into an envelope object. Used by tests and
 * by the legacy `meta_ads` wrapper when it needs to inspect the result.
 * Returns null if the text doesn't contain a valid envelope.
 */
function parse(rendered) {
  if (!rendered || !Array.isArray(rendered.content) || !rendered.content[0]) return null;
  const text = rendered.content[0].text || '';
  const braceIdx = text.indexOf('\n{');
  if (braceIdx < 0) return null;
  try {
    return JSON.parse(text.slice(braceIdx + 1));
  } catch {
    return null;
  }
}

module.exports = { ok, fail, render, parse, summarize };
