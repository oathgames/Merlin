// Merlin MCP — Tool Definition Wrapper
//
// Every tool is registered via `defineTool({...})` instead of raw `tool(...)`.
// The wrapper:
//   1. Enforces a minimum annotation set (destructive / idempotent /
//      cost_impact / brandRequired).
//   2. Auto-enriches the input schema with `preview`, `confirm_token`,
//      `idempotencyKey` fields when the tool opts into them.
//   3. Wraps the handler so every call flows through the same pipeline:
//        brand-check → idempotency-check → preview-gate → concurrency-slot
//        → handler → envelope → idempotency-store
//   4. Produces the legacy `{content, isError}` shape the SDK expects, with
//      the structured envelope embedded in the text.
//
// A CI test (see test/validate-mcp-annotations.js) scans every defineTool
// call and fails the build if required fields are missing.

'use strict';

const envelope = require('./mcp-envelope');
const errors = require('./mcp-errors');
const concurrency = require('./mcp-concurrency');
const preview = require('./mcp-preview');

// ── Validation ────────────────────────────────────────────────

const VALID_COST_IMPACTS = new Set(['none', 'api', 'spend', 'generation']);

function validateDefinition(def) {
  if (!def || typeof def !== 'object') {
    throw new TypeError('defineTool requires an object');
  }
  if (!def.name || typeof def.name !== 'string') {
    throw new TypeError('defineTool: name is required');
  }
  if (!/^[a-z][a-z0-9_]*$/.test(def.name)) {
    throw new TypeError(`defineTool: name must be lowercase snake_case, got "${def.name}"`);
  }
  if (!def.description || typeof def.description !== 'string') {
    throw new TypeError(`defineTool(${def.name}): description is required`);
  }
  if (typeof def.handler !== 'function') {
    throw new TypeError(`defineTool(${def.name}): handler is required`);
  }
  if (typeof def.destructive !== 'boolean') {
    throw new TypeError(`defineTool(${def.name}): destructive: boolean is required`);
  }
  if (typeof def.idempotent !== 'boolean') {
    throw new TypeError(`defineTool(${def.name}): idempotent: boolean is required`);
  }
  if (!VALID_COST_IMPACTS.has(def.costImpact)) {
    throw new TypeError(`defineTool(${def.name}): costImpact must be one of ${[...VALID_COST_IMPACTS].join(', ')}`);
  }
  if (typeof def.brandRequired !== 'boolean') {
    throw new TypeError(`defineTool(${def.name}): brandRequired: boolean is required`);
  }
  // REGRESSION GUARD (2026-05-06, Gitar review on PR #224):
  // The legacy rule here was "destructive tools must also be idempotent"
  // — required `idempotent: true` on every destructive tool. That baked
  // in a falsehood for inherently non-idempotent operations: a Reddit
  // comment post, a Klaviyo single-send campaign, an SMS blast — every
  // call mutates a unique public-facing artifact, and a retry creates
  // a duplicate, not the same outcome. Marking those `idempotent: true`
  // would be a lie that the framework's idempotency cache then trusts
  // (it caches the result of the FIRST call and silently returns it
  // for subsequent calls with the same key — the exact failure mode
  // Gitar flagged on PR #224's reddit_organic split).
  //
  // The legacy rule is REMOVED. `idempotent: boolean` is already
  // required for every tool by the typecheck above (line ~48), so an
  // author can no longer "forget" to make a choice — but EITHER value
  // is now valid for destructive tools. The framework's idempotency
  // cache (lines ~193 + ~326) gates on `idempotent && args.idempotencyKey`,
  // so `idempotent: false` simply disables caching — which is the
  // correct behavior for genuinely non-idempotent operations.
  // Destructive tools SHOULD support preview. We warn (not error) because
  // some destructive tools are too small to warrant a preview step.
  if (def.destructive && def.preview === undefined) {
    console.warn(`[defineTool] ${def.name} is destructive without explicit preview: true|false — defaulting to false`);
  }
  if (def.concurrency !== undefined) {
    // REGRESSION GUARD (2026-05-06, codex API audit P2 #2):
    // concurrency.platform may now be EITHER a string (most tools have a
    // fixed platform — meta_ads → 'meta', klaviyo → 'klaviyo', …) OR a
    // function (args) => string for tools whose backing platform varies
    // by argument shape. The video + voice tools span multiple providers
    // (fal/veo/arcads/heygen for video; elevenlabs/heygen for voice) and
    // need per-call resolution so LLM auto-mode can't saturate the wrong
    // provider's queue. The function form is invoked once per call with
    // the parsed args (see wrapHandler below); a string return type is
    // required and validated at call time.
    if (!def.concurrency) {
      throw new TypeError(`defineTool(${def.name}): concurrency must be an object with a platform field`);
    }
    const p = def.concurrency.platform;
    if (typeof p !== 'string' && typeof p !== 'function') {
      throw new TypeError(`defineTool(${def.name}): concurrency.platform must be a string or a function returning a string`);
    }
  }
}

// ── Schema enrichment ─────────────────────────────────────────
// Adds standard fields that every tool of a given shape should accept.

function enrichSchema(z, def, userShape) {
  const shape = Object.assign({}, userShape || {});

  if (def.brandRequired) {
    // Keep brand required in the schema — Zod gives a clean error if missing.
    // Some tools (e.g. connection_status) let brand be optional; those set
    // brandRequired: false and the runtime skips the enforcement too.
    if (!shape.brand) {
      shape.brand = z.string().describe('Brand name (required)');
    }
  } else if (!shape.brand) {
    shape.brand = z.string().optional().describe('Brand name (optional)');
  }

  if (def.idempotent) {
    shape.idempotencyKey = z.string().optional().describe(
      'Caller-supplied key for retry safety. Same key + same inputs = same result (24h cache). Strongly recommended for any auto-mode retry loop.'
    );
  }

  if (def.preview) {
    shape.preview = z.boolean().optional().describe(
      'If true, return the exact payload that would be sent without executing. Returns a confirm_token you can pass on a follow-up call to actually execute.'
    );
    shape.confirm_token = z.string().optional().describe(
      'A confirm_token returned by a prior preview call. Required for blast-radius operations.'
    );
  }

  return shape;
}

// ── Handler wrapping ──────────────────────────────────────────

function wrapHandler(def, ctx) {
  const {
    brandRequired,
    idempotent,
    preview: supportsPreview,
    concurrency: concurrencyOpts,
    blastRadius,
  } = def;

  // REGRESSION GUARD (2026-05-02, RSI Session 3 D2.4 fix): build the
  // allowed-key set ONCE per registration so the runtime check is O(K)
  // per call. Pre-fix the SDK's zod construction silently dropped unknown
  // fields — an attacker (or a confused agent) could pass extra args that
  // were stripped without surfacing an error, breaking caller assumptions
  // and obscuring bugs. The check fail-closes with a structured envelope
  // pointing at the unknown key — same shape Zod's strict mode would emit.
  //
  // Skipped when def.input is empty/undefined — there's nothing to be strict
  // about against an unspecified schema. Production tools all declare their
  // inputs explicitly; the skip exists for unit-test fixtures that use the
  // recording-tool helper with no input schema.
  const declaredInputKeys = Object.keys(def.input || {});
  const strictModeActive = declaredInputKeys.length > 0;
  const allowedKeys = new Set();
  for (const k of declaredInputKeys) allowedKeys.add(k);
  // Auto-added keys from enrichSchema:
  allowedKeys.add('brand');
  if (idempotent) allowedKeys.add('idempotencyKey');
  if (def.preview) {
    allowedKeys.add('preview');
    allowedKeys.add('confirm_token');
  }

  return async (args) => {
    const startedAt = Date.now();
    const brand = args && args.brand;
    const toolName = def.name;

    // ── 0. Unknown-key check (D2.4 strict-mode equivalent) ────
    if (strictModeActive && args && typeof args === 'object') {
      const unknownKeys = [];
      for (const k of Object.keys(args)) {
        if (!allowedKeys.has(k)) unknownKeys.push(k);
      }
      if (unknownKeys.length > 0) {
        const err = errors.makeError('INVALID_INPUT', {
          message: `Refusing ${toolName}: unknown field(s) ${JSON.stringify(unknownKeys)} not declared in the input schema. Re-check the tool's parameters — typos are silently dropped without this guard.`,
          retryable: false,
        });
        return envelope.render(envelope.fail(err, {
          meta: { tool: toolName, durationMs: Date.now() - startedAt },
        }));
      }
    }

    // ── 1. Brand check ────────────────────────────────────────
    if (brandRequired) {
      if (!brand || typeof brand !== 'string' || !brand.trim()) {
        const err = errors.makeError('BRAND_MISSING', {
          message: `Refusing ${toolName}: no brand specified. Retry with an explicit brand.`,
        });
        return envelope.render(envelope.fail(err, {
          meta: { tool: toolName, durationMs: Date.now() - startedAt },
        }));
      }
    }

    // ── 2. Idempotency lookup ────────────────────────────────
    if (idempotent && args && args.idempotencyKey && ctx.idempotencyStore) {
      const cached = ctx.idempotencyStore.get(brand || '', toolName, args.idempotencyKey);
      if (cached && cached.result) {
        // Cached result — return as-is. Do NOT re-run handler.
        // Wrap with a meta flag so the caller knows it was cached.
        const result = cached.result;
        if (result && result.ok && result.meta) {
          result.meta = Object.assign({}, result.meta, { idempotent: true, cacheHit: true });
        }
        return envelope.render(result);
      }
    }

    // ── 3. Preview gate ──────────────────────────────────────
    let previewContext = null;
    if (supportsPreview && blastRadius) {
      const radius = blastRadius(args || {}, ctx);
      if (radius && radius.required) {
        // Caller didn't provide confirm_token → must preview first.
        if (!args || !args.confirm_token) {
          if (!args || !args.preview) {
            // Not a preview call and no token → refuse.
            const err = errors.makeError('CONFIRM_REQUIRED', {
              message: `${toolName}: ${radius.reason || 'This action needs a confirmation step'}. Call first with {preview: true}, then pass the returned confirm_token.`,
            });
            return envelope.render(envelope.fail(err, {
              data: { blast_radius: radius },
              meta: { tool: toolName, durationMs: Date.now() - startedAt },
            }));
          }
          // Preview mode: build a dry-run envelope and mint a token.
          const minted = preview.mint({
            tool: toolName,
            brand: brand || '',
            payload: args,
            blastRadius: radius,
          });
          return envelope.render(envelope.ok({
            data: {
              summary: `Preview: ${radius.reason || 'This action needs confirmation'}`,
              blast_radius: radius,
              would_send: args,
              confirm_token: minted.confirm_token,
              expires_at: minted.expires_at,
            },
            meta: { tool: toolName, durationMs: Date.now() - startedAt, preview: true },
          }));
        }
        // Token provided → validate.
        const check = preview.consume(args.confirm_token, {
          tool: toolName,
          brand: brand || '',
          payload: args,
        });
        if (!check.ok) {
          const err = errors.makeError('CONFIRM_REQUIRED', {
            message: `Invalid or expired confirm_token (${check.reason}). Re-run with {preview: true} to get a fresh token.`,
          });
          return envelope.render(envelope.fail(err, {
            meta: { tool: toolName, durationMs: Date.now() - startedAt },
          }));
        }
        previewContext = { confirmed: true, blastRadius: check.blastRadius };
      }
    }

    // ── 4. Concurrency slot ──────────────────────────────────
    const runHandler = async () => {
      try {
        const result = await def.handler(args || {}, {
          ctx,
          brand: brand || '',
          previewContext,
          toolName,
        });

        // Handler may return an envelope directly or a plain value.
        let env;
        if (result && typeof result === 'object' && typeof result.ok === 'boolean' && 'error' in result) {
          env = result;
        } else {
          env = envelope.ok({ data: result });
        }

        // Attach meta
        env.meta = Object.assign({}, env.meta || {}, {
          tool: toolName,
          brand: brand || '',
          durationMs: Date.now() - startedAt,
        });

        return env;
      } catch (e) {
        const err = errors.classifyOrFallback(e && e.message, e && e.message);
        return envelope.fail(err, {
          meta: { tool: toolName, brand: brand || '', durationMs: Date.now() - startedAt },
        });
      }
    };

    let resultEnvelope;
    if (concurrencyOpts && concurrencyOpts.platform) {
      // Resolve the platform name. Static-string tools pass through; the
      // function form (codex API audit P2 #2 fix) gets called with args
      // so it can branch on provider/action.
      //
      // REGRESSION GUARD (2026-05-06, Gitar review on PR #224 — fail-OPEN
      // bug): a broken resolver (throws OR returns non-string) used to
      // route the call via runHandler with NO slot acquired. That's
      // fail-OPEN — a persistently broken resolver would let unlimited
      // concurrent calls through, bypassing the JS-layer concurrency
      // budget for that tool entirely. Fix: route via the '_default'
      // platform on resolver failure so the call is STILL metered (the
      // _default cap in mcp-concurrency.js is intentionally low — 2 —
      // exactly so unknown/broken cases don't fan out wide).
      let platformName = concurrencyOpts.platform;
      if (typeof platformName === 'function') {
        try {
          platformName = platformName(args);
        } catch (e) {
          console.warn('[defineTool]', toolName, 'concurrency resolver threw:', e && e.message);
          platformName = '_default';
        }
        if (typeof platformName !== 'string' || !platformName) {
          console.warn('[defineTool]', toolName, 'concurrency resolver returned non-string; falling back to _default cap:', platformName);
          platformName = '_default';
        }
      }
      // Always claim a slot — fail-closed. Static-string platforms hit
      // their declared slot; broken resolvers fall through to '_default'
      // so the call is still rate-limited.
      resultEnvelope = await concurrency.withSlot(platformName, runHandler);
    } else {
      resultEnvelope = await runHandler();
    }

    // ── 5. Idempotency store ─────────────────────────────────
    // Only cache successful results. A failed call should be retried without
    // being poisoned by a cache entry for the failure. Rate-limit errors
    // should NEVER be cached — they're explicitly transient.
    if (idempotent && args && args.idempotencyKey && ctx.idempotencyStore && resultEnvelope.ok) {
      ctx.idempotencyStore.put(brand || '', toolName, args.idempotencyKey, resultEnvelope);
    }

    return envelope.render(resultEnvelope);
  };
}

// ── Public API ────────────────────────────────────────────────

/**
 * Build a tool registration from a structured definition.
 *
 * @param {object} def - Tool definition (see top-of-file comment)
 * @param {function} tool - SDK's tool() factory
 * @param {object} z - Zod module
 * @param {object} ctx - Shared context from main.js
 * @returns The registered tool handle
 */
function defineTool(def, tool, z, ctx) {
  validateDefinition(def);
  const shape = enrichSchema(z, def, def.input || {});
  const wrapped = wrapHandler(def, ctx);
  const annotations = {
    destructive: def.destructive,
    idempotent: def.idempotent,
    costImpact: def.costImpact,
    brandRequired: def.brandRequired,
  };
  if (def.concurrency) annotations.concurrency = def.concurrency;
  if (def.longRunning) annotations.longRunning = true;
  // Surface preview as a boolean when it was explicitly set — the CI
  // annotation validator needs to distinguish "preview was considered and
  // opted out" (preview: false) from "preview was forgotten entirely"
  // (key missing). Omitting this distinction silently lets a destructive
  // tool ship without blast-radius gating.
  if (def.preview === true) annotations.preview = true;
  else if (def.preview === false) annotations.preview = false;
  // Expose blastRadius callback on annotations so tests + renderer can
  // introspect the per-action contract (e.g. google_analytics has 6 read
  // actions that skip the approval card and 7 writes that require it).
  // wrapHandler still reads the function directly from `def`, so this is
  // a pure introspection surface — it does not change runtime behavior.
  if (typeof def.blastRadius === 'function') annotations.blastRadius = def.blastRadius;

  const registered = tool(def.name, def.description, shape, wrapped, { annotations });
  return registered;
}

module.exports = {
  defineTool,
  validateDefinition,
  enrichSchema,
  wrapHandler,
  VALID_COST_IMPACTS,
};
