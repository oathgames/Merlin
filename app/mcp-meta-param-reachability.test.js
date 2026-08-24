// REGRESSION GUARD (2026-07-25): Meta bulk-push param reachability.
//
// Incident: the Go engine has shipped `createCampaignIfMissing`, `sharedAdSet`,
// `adSetName` and per-ad `name` on the meta-bulk-push path for months, but none
// of them were declared in the MCP zod schemas. Zod strips unknown keys, so the
// SDK dropped them before the handler ever ran: the capability was shipped and
// unreachable. Confirmed live on 2026-07-25: a bulk-push with campaignName
// "OrganicBoost" failed twice with
//   campaign "OrganicBoost" not found in ad account act_100000000000001 —
//   pass the existing campaignId, omit campaignName to auto-create the
//   Testing campaign, or set createCampaignIfMissing
// with no way whatsoever to set the flag the error told the caller to set.
//
// What this file locks:
//   1. Every Command/BulkAd JSON tag the bulk-push path reads is DECLARED in
//      both Meta surfaces (legacy meta_ads multiplexer + the meta_launch_test_batch
//      intent tool, which routes to the same 'meta-bulk-push' action).
//   2. The declared key SPELLING matches the Go `json:"..."` tag exactly.
//      runBinary copies MCP arg keys onto the Command object verbatim, so a
//      rename on either side silently breaks the wire with no type error.
//   3. End-to-end: an arg that survives the schema actually lands in the
//      --cmd JSON handed to the engine, including nested ads[].name.
//   4. `status` is refused on every non-import action instead of being a
//      silent no-op (it is a read filter, never a launch-status control).
//
// CI runs these with no `npm install` (see .github/workflows/app-unit-tests.yml),
// so everything here is Node stdlib plus in-file stubs: no real zod. Real-zod
// strip behaviour is the SDK's contract, not ours to re-test; what we can and
// must test is that the key is declared at all, and that a declared key reaches
// the binary.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ── execFile capture ─────────────────────────────────────────────────
//
// Patch child_process.execFile BEFORE requiring mcp-tools: the module
// destructures `const { execFile } = require('child_process')` at load time,
// so the stub has to be installed first. node:test gives each test file its
// own process, so this never leaks into another suite.
const childProcess = require('child_process');
const execFileCalls = [];
childProcess.execFile = function fakeExecFile(file, args, options, callback) {
  execFileCalls.push({ file, args, options });
  const child = {
    stdin: { on() {}, write() {}, end() {} },
    kill() {},
  };
  // Defer so the caller finishes wiring stdin before we resolve.
  setImmediate(() => callback(null, 'ok', ''));
  return child;
};

const { buildTools, runBinary } = require('./mcp-tools');

// ── Shape-recording zod stub ─────────────────────────────────────────
//
// The stub in mcp-tools.test.js throws away nested shapes, which is exactly
// why the missing ads[].name went unnoticed. This one records them so the
// assertions below can reach into `ads` array items.
function makeRecordingZ() {
  const node = (extra = {}) => {
    const self = {
      ...extra,
      optional: () => node(extra),
      describe: () => node(extra),
      default: () => node(extra),
      regex: () => node(extra),
      int: () => node(extra),
    };
    return self;
  };
  return {
    string: () => node(), number: () => node(), boolean: () => node({ __kind: 'boolean' }),
    any: () => node(), enum: (vals) => node({ __enum: vals }),
    coerce: { number: () => node() },
    array: (item) => node({ __item: item }),
    object: (shape) => node({ __shape: shape }),
    record: () => node(),
  };
}

function makeCtx(overrides = {}) {
  return {
    getConnections: () => [],
    readConfig: () => ({ metaAccessToken: 'x' }),
    readBrandConfig: () => ({ metaAccessToken: 'x' }),
    buildStrictBrandConfig: () => ({ metaAccessToken: 'x' }),
    writeConfig: () => {},
    writeBrandTokens: () => {},
    // Any real, existing path works: execFile is stubbed, nothing is spawned.
    getBinaryPath: () => __filename,
    appRoot: path.join(__dirname, '..'),
    isBinaryTooOld: () => false,
    awaitStartupChecks: async () => {},
    activeChildProcesses: new Set(),
    ...overrides,
  };
}

function registry() {
  const entries = [];
  const tool = (name, description, schema, handler, options) => {
    entries.push({ name, description, schema, handler, options });
    return { name };
  };
  buildTools(tool, makeRecordingZ(), makeCtx());
  return entries;
}

const TOOLS = registry();
const byName = (n) => {
  const t = TOOLS.find((e) => e.name === n);
  assert.ok(t, `tool ${n} must be registered`);
  return t;
};

// ── 1. The Go wire contract ──────────────────────────────────────────
//
// Source of truth: autocmo-core/main.go: the Command struct's `json:"..."`
// tags (SharedAdSet, AdSetName, CreateCampaignIfMissing) and the BulkAd
// struct's Name tag. These are cross-repo literals on purpose: autoCMO CI
// cannot see the Go source, so the contract is asserted as spelled strings on
// both sides. If you rename a tag in main.go, this test will NOT catch it.
// Update both, and see meta_mcp_wire_contract_test.go in autocmo-core for the
// Go half of the same pact.
//
// `adDescription` / `ads[].description` were added on 2026-08-07 after the same
// class of bug bit a second time: Meta's link ad has THREE copy slots (message,
// title, description) and Merlin declared two. The engine had read
// Command.AdDescription since the placement path shipped, but no MCP surface
// declared it, and BulkAd had no per-ad Description field at all. Eight
// NORTHWIND ads went out with the headline duplicated into the description slot
// and an approved offer ("Free Garden Candle ($56 value) with $120 purchase")
// silently discarded.
const BULK_PUSH_COMMAND_KEYS = ['createCampaignIfMissing', 'sharedAdSet', 'adSetName', 'adDescription'];
const BULK_AD_KEYS = ['imagePath', 'videoPath', 'headline', 'body', 'description', 'link', 'dailyBudget', 'hookStyle', 'postId', 'name'];

// Both surfaces reach the identical 'meta-bulk-push' engine action, so both
// must declare the identical param set. meta_ads is the legacy multiplexer;
// meta_launch_test_batch is the intent tool new agent code is steered to.
const BULK_PUSH_SURFACES = ['meta_ads', 'meta_launch_test_batch'];

for (const toolName of BULK_PUSH_SURFACES) {
  test(`${toolName} declares every bulk-push Command param the engine reads`, () => {
    const schema = byName(toolName).schema;
    for (const key of BULK_PUSH_COMMAND_KEYS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(schema, key),
        `${toolName} input schema is missing "${key}": zod strips undeclared keys, so the engine can never receive it. See Command in autocmo-core/main.go.`,
      );
    }
  });

  test(`${toolName} declares every BulkAd field on ads[] items`, () => {
    const ads = byName(toolName).schema.ads;
    assert.ok(ads && ads.__item && ads.__item.__shape, `${toolName}.ads must be an array of objects`);
    const shape = ads.__item.__shape;
    for (const key of BULK_AD_KEYS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(shape, key),
        `${toolName}.ads[].${key} is missing: per-ad "${key}" is stripped before it reaches BulkAd in autocmo-core/main.go.`,
      );
    }
  });
}

// meta_launch_test_ad routes to 'meta-push', which reads Command.AdDescription
// on both the image and the video branch. It is not a bulk surface, so it needs
// its own assertion.
test('meta_launch_test_ad declares adDescription', () => {
  const schema = byName('meta_launch_test_ad').schema;
  assert.ok(
    Object.prototype.hasOwnProperty.call(schema, 'adDescription'),
    'meta_launch_test_ad is missing "adDescription": zod strips it, so a single-ad push can never set the third copy slot.',
  );
});

test('createCampaignIfMissing and sharedAdSet are declared as booleans', () => {
  // A string schema here would let "false" through as a truthy Go bool and
  // silently mint campaigns. Both surfaces, both flags.
  for (const toolName of BULK_PUSH_SURFACES) {
    const schema = byName(toolName).schema;
    for (const key of ['createCampaignIfMissing', 'sharedAdSet']) {
      assert.equal(
        schema[key].__kind, 'boolean',
        `${toolName}.${key} must be z.boolean(): a string schema would pass "false" through as Go true.`,
      );
    }
  }
});

// ── 2. End-to-end: declared params reach the engine's --cmd JSON ─────

function lastCmd() {
  const call = execFileCalls[execFileCalls.length - 1];
  assert.ok(call, 'execFile must have been invoked');
  const i = call.args.indexOf('--cmd');
  assert.ok(i >= 0, '--cmd must be passed to the binary');
  return JSON.parse(call.args[i + 1]);
}

test('bulk-push params survive runBinary into the --cmd JSON', async () => {
  execFileCalls.length = 0;
  await runBinary(makeCtx(), 'meta-bulk-push', {
    brand: 'acme',
    campaignName: 'OrganicBoost',
    createCampaignIfMissing: true,
    sharedAdSet: true,
    adSetName: 'Cold_Creative_Test',
    ads: [{ imagePath: '/tmp/a.jpg', name: 'Vinny_Video04', dailyBudget: 10 }],
  });

  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-bulk-push');
  assert.equal(cmd.createCampaignIfMissing, true, 'createCampaignIfMissing must reach the engine');
  assert.equal(cmd.sharedAdSet, true, 'sharedAdSet must reach the engine');
  assert.equal(cmd.adSetName, 'Cold_Creative_Test', 'adSetName must reach the engine');
  assert.equal(cmd.campaignName, 'OrganicBoost');
  assert.equal(cmd.ads[0].name, 'Vinny_Video04', 'per-ad name must reach BulkAd.Name');
});

// REGRESSION GUARD (2026-08-24, Hard-Won Rule 23): meta-attribution-compare
// gained explicit startDate/endDate in the engine on 2026-08-16, and the
// meta_audit zod schema was not updated in the same change, so the capability
// shipped unreachable. defineTool's strict check refuses undeclared keys, so a
// weekly-deck pull asking for an exact Sun-Sat window came back INVALID_INPUT
// naming two params the engine already supported. Declaring them is only half
// the fix: assert they land in the --cmd JSON, not merely that a key exists.
test('attribution-compare start/end dates survive runBinary into the --cmd JSON', async () => {
  execFileCalls.length = 0;
  await runBinary(makeCtx(), 'meta-attribution-compare', {
    brand: 'ripit',
    startDate: '2026-08-16',
    endDate: '2026-08-22',
  });

  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-attribution-compare');
  assert.equal(cmd.startDate, '2026-08-16', 'startDate must reach the engine');
  assert.equal(cmd.endDate, '2026-08-22', 'endDate must reach the engine');
});

test('meta_audit declares startDate and endDate for attribution-compare', () => {
  const schema = byName('meta_audit').schema;
  for (const key of ['startDate', 'endDate']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(schema, key),
      `meta_audit.${key} must be declared: the engine reads it and zod strips what is not declared.`,
    );
  }
});

// REGRESSION GUARD (2026-08-07): the third copy slot has to survive the whole
// boundary — batch-wide AND per-ad — or an approved offer never reaches the ad
// and nothing in the output says so.
test('the description copy slot reaches the engine at both levels', async () => {
  execFileCalls.length = 0;
  await runBinary(makeCtx(), 'meta-bulk-push', {
    brand: 'northwind',
    sharedAdSet: true,
    adDescription: 'Made in Brooklyn, NY',
    ads: [
      { imagePath: '/tmp/a.jpg', headline: 'NORTHWIND Charcoal', description: 'Free Garden Candle ($56 value) with $120 purchase' },
      { imagePath: '/tmp/b.jpg', headline: 'NORTHWIND Cedar' },
    ],
  });

  const cmd = lastCmd();
  assert.equal(
    cmd.adDescription, 'Made in Brooklyn, NY',
    'batch-wide adDescription must reach Command.AdDescription — it is the default for every ad in the batch',
  );
  assert.equal(
    cmd.ads[0].description, 'Free Garden Candle ($56 value) with $120 purchase',
    'per-ad description must reach BulkAd.Description — dropping it discards an approved offer silently',
  );
  assert.ok(
    !('description' in cmd.ads[1]),
    'an ad with no description must not gain one: the engine falls back per creative shape, the boundary must not invent copy',
  );
  // The headline must NOT be copied into the description slot at the boundary.
  // That substitution is exactly the bug; the engine owns the fallback.
  assert.notEqual(cmd.ads[1].description, 'NORTHWIND Cedar');
});

test('meta_launch_test_ad carries adDescription to the single-push path', async () => {
  execFileCalls.length = 0;
  await runBinary(makeCtx(), 'meta-push', {
    brand: 'northwind',
    adImagePath: '/tmp/a.jpg',
    adHeadline: 'NORTHWIND Charcoal',
    adBody: 'body copy',
    adDescription: '10.5 oz, 60-70 hour burn',
    adLink: 'https://example-store.com',
    dailyBudget: 25,
  });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-push');
  assert.equal(cmd.adDescription, '10.5 oz, 60-70 hour burn', 'single-ad push must reach Command.AdDescription too');
});

test('createCampaignIfMissing:false is transmitted, not dropped', async () => {
  // runBinary filters undefined/null/'': `false` must NOT be swallowed by a
  // future falsy check, or an explicit opt-out becomes indistinguishable from
  // "unset" at the boundary.
  execFileCalls.length = 0;
  await runBinary(makeCtx(), 'meta-bulk-push', {
    brand: 'acme', createCampaignIfMissing: false, sharedAdSet: false, ads: [{ imagePath: '/tmp/a.jpg' }],
  });
  const cmd = lastCmd();
  assert.equal(cmd.createCampaignIfMissing, false);
  assert.equal(cmd.sharedAdSet, false);
});

// ── 3. `status` is a read filter, never a launch-status control ──────
//
// The engine reads cmd.Status only in runMetaImport (an effective_status read
// filter). On push/bulk-push it was silently ignored, so a caller passing
// status:"PAUSED" expecting staged ads got LIVE ads spending real money,
// because launch status actually comes from cfg.getMetaLaunchStatus(), driven by the
// brand config key metaLaunchStatus. Refusing loudly is strictly safer than
// the silent no-op, and breaks nothing that worked before.

async function callMetaAds(args) {
  return byName('meta_ads').handler(args);
}

// The envelope nests a JSON blob inside a text block, so quotes arrive
// backslash-escaped. Strip them before matching so assertions read plainly.
function envelopeText(env) {
  return JSON.stringify(env).replace(/\\+"/g, '"');
}

test('meta_ads refuses status on spend-firing actions instead of ignoring it', async () => {
  for (const action of ['push', 'bulk-push', 'duplicate', 'retarget']) {
    const res = await callMetaAds({ action, brand: 'acme', status: 'PAUSED' });
    const text = envelopeText(res);
    assert.match(
      text, /read filter for action:"import" only/,
      `meta_ads({action:"${action}", status:"PAUSED"}) must be refused: silently ignoring it launches live ads the caller believed were paused.`,
    );
    assert.match(text, /metaLaunchStatus/, 'the refusal must name the config key that actually controls launch status');
  }
});

test('meta_ads still accepts status on import', async () => {
  execFileCalls.length = 0;
  await callMetaAds({ action: 'import', brand: 'acme', status: 'all' });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-import');
  assert.equal(cmd.status, 'all', 'import must keep its effective_status read filter');
});

test('meta_ads without status is unaffected', async () => {
  execFileCalls.length = 0;
  await callMetaAds({ action: 'insights', brand: 'acme', batchCount: 7 });
  const cmd = lastCmd();
  assert.equal(cmd.action, 'meta-insights');
  assert.ok(!('status' in cmd));
});

test('meta_ads status description does not advertise launch-status control', () => {
  const schema = byName('meta_ads').schema;
  // The stub records .describe() calls as no-ops, so assert on source instead;
  // the wording is the user-facing half of this guard.
  const src = require('node:fs').readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');
  assert.ok(schema.status, 'meta_ads must still expose status for import');
  assert.match(
    src, /READ FILTER for action:"import" ONLY/,
    'the status describe() must state plainly that it is an import-only read filter',
  );
});
