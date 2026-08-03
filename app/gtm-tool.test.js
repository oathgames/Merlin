// Tests for the google_tag_manager MCP tool surface.
//
// Rule 23 (reachability) is the reason half of these exist: a capability that
// ships in the engine but has no declared MCP route, or a param declared in zod
// that never reaches the --cmd JSON, fails SILENTLY. Nothing errors, no compiler
// spans the two repos, and the only signal is a user asking for something the
// product cannot do.
//
// Run: node --test app/gtm-tool.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = __dirname;
const CORE = path.resolve(APP, '../../autocmo-core');
const toolsSrc = fs.readFileSync(path.join(APP, 'mcp-tools.js'), 'utf8');
const policy = require('./mcp-approval-policy');

// The six actions the tool declares, and the engine case each must route to.
const GTM_READ = ['discover', 'audit', 'list-versions'];
const GTM_WRITE = ['install-ga4', 'create-version', 'publish'];
const GTM_ACTIONS = [...GTM_READ, ...GTM_WRITE];

test('every declared GTM action has a matching case in the Go dispatcher', () => {
  const mainGo = fs.readFileSync(path.join(CORE, 'main.go'), 'utf8');
  for (const action of GTM_ACTIONS) {
    assert.ok(
      mainGo.includes(`case "gtm-${action}":`),
      `MCP declares action "${action}" but main.go has no case "gtm-${action}": — the call would return "unknown action" at runtime with nothing to catch it (Rule 23)`
    );
  }
});

test('every gtm- case in the Go dispatcher is reachable from MCP', () => {
  const mainGo = fs.readFileSync(path.join(CORE, 'main.go'), 'utf8');
  const cases = [...mainGo.matchAll(/case "gtm-([a-z0-9-]+)":/g)].map((m) => m[1]);
  assert.ok(cases.length >= GTM_ACTIONS.length, `found only ${cases.length} gtm- cases`);
  for (const c of cases) {
    assert.ok(
      GTM_ACTIONS.includes(c),
      `main.go routes gtm-${c} but no MCP action exposes it — shipped-but-unreachable (Rule 23)`
    );
  }
});

test('the tool declares every action in its zod enum', () => {
  const start = toolsSrc.indexOf("name: 'google_tag_manager'");
  assert.ok(start > 0, 'google_tag_manager tool not found');
  const block = toolsSrc.slice(start, start + 6000);
  for (const action of GTM_ACTIONS) {
    assert.ok(block.includes(`'${action}'`), `action ${action} missing from the tool block`);
  }
});

// A param declared in zod but absent from the Go Command struct is accepted by
// the tool and then silently dropped, which is the shape of the bulk-push bug
// that told callers to set a flag the app had no way to set.
test('every declared GTM param exists on the Go Command struct', () => {
  const mainGo = fs.readFileSync(path.join(CORE, 'main.go'), 'utf8');
  const params = [
    'gtmAccountId', 'gtmContainerId', 'gtmWorkspaceId',
    'gtmMeasurementId', 'versionName', 'versionId',
  ];
  for (const p of params) {
    assert.ok(
      mainGo.includes(`json:"${p},omitempty"`),
      `MCP declares param ${p} but the Go Command struct has no json:"${p}" field — runBinary copies it into --cmd and the binary drops it on the floor`
    );
  }
});

test('config fields the connector reads exist on the Go Config struct', () => {
  const mainGo = fs.readFileSync(path.join(CORE, 'main.go'), 'utf8');
  for (const f of ['gtmAccountId', 'gtmContainerId', 'gtmWorkspaceId']) {
    assert.ok(
      mainGo.includes(`json:"${f},omitempty"`),
      `Config is missing json:"${f}" — gtmResolveTarget would never find a saved container`
    );
  }
});

// Rule 19's lesson: without an explicit entry, a destructive non-spend action
// falls through to the catch-all auto-approve and fires with no card.
test('all three GTM writes are carded, none fall through to auto-approve', () => {
  for (const a of GTM_WRITE) {
    assert.ok(
      policy.CARDED_DESTRUCTIVE_ACTIONS.has(a),
      `${a} is not in CARDED_DESTRUCTIVE_ACTIONS — it would hit the catch-all auto-approve and change a live site with no confirmation`
    );
    assert.ok(!policy.READ_ONLY_ACTIONS.has(a), `${a} must not be treated as read-only`);
  }
});

test('GTM reads are read-only and never carded', () => {
  for (const a of GTM_READ) {
    assert.ok(policy.READ_ONLY_ACTIONS.has(a), `${a} should auto-approve as a read`);
    assert.ok(!policy.CARDED_DESTRUCTIVE_ACTIONS.has(a), `${a} must not require a card`);
  }
});

test('the tool blastRadius cards exactly the write actions', () => {
  const start = toolsSrc.indexOf("name: 'google_tag_manager'");
  const block = toolsSrc.slice(start, start + 6000);
  const brStart = block.indexOf('blastRadius:');
  assert.ok(brStart > 0, 'no blastRadius on google_tag_manager');
  const br = block.slice(brStart, block.indexOf('input:', brStart));
  for (const a of GTM_WRITE) {
    assert.ok(br.includes(`'${a}'`), `blastRadius does not name the write action ${a}`);
  }
  for (const a of GTM_READ) {
    assert.ok(!br.includes(`'${a}':`), `blastRadius should not card the read action ${a}`);
  }
});

// The card copy is the last thing between an agent and a live website, so it
// has to say what actually happens in words a non-engineer parses.
test('the publish card says it affects the live site', () => {
  const start = toolsSrc.indexOf("name: 'google_tag_manager'");
  const block = toolsSrc.slice(start, start + 6000);
  const line = block.split('\n').find((l) => l.includes("'publish':"));
  assert.ok(line, 'no publish reason string');
  assert.match(line, /live/i, 'the publish card must say the change goes live');
});

test('the staged actions say they are NOT live', () => {
  const start = toolsSrc.indexOf("name: 'google_tag_manager'");
  const block = toolsSrc.slice(start, start + 6000);
  for (const a of ['install-ga4', 'create-version']) {
    const line = block.split('\n').find((l) => l.includes(`'${a}':`));
    assert.ok(line, `no reason string for ${a}`);
    assert.match(line, /NOT live/i, `${a} card should make clear nothing is live yet`);
  }
});

// Handlers that set approved themselves defeat the entire gate.
test('the handler never sets approved itself', () => {
  const start = toolsSrc.indexOf("name: 'google_tag_manager'");
  const block = toolsSrc.slice(start, start + 6000);
  assert.ok(
    !/args\.approved\s*=/.test(block),
    'the handler assigns args.approved — that bypasses the approval card'
  );
});

test('the GTM API host is blocked from direct access by the hook', () => {
  const hook = fs.readFileSync(path.join(APP, '../.claude/hooks/block-api-bypass.js'), 'utf8');
  assert.ok(
    hook.includes('tagmanager.googleapis.com'),
    'tagmanager.googleapis.com is not in BANNED_HOSTS — Claude could curl it directly, bypassing both the project-wide rate limiter and the approval gate'
  );
});

test('the tool routes to a dedicated rate-limit platform bucket', () => {
  const start = toolsSrc.indexOf("name: 'google_tag_manager'");
  const block = toolsSrc.slice(start, start + 3000);
  assert.ok(
    block.includes("platform: 'google_tag_manager'"),
    'tool must declare its own concurrency platform so GTM calls do not share the Ads budget'
  );
  const rl = fs.readFileSync(path.join(CORE, 'ratelimit_preflight.go'), 'utf8');
  assert.ok(
    rl.includes('"google_tag_manager":'),
    'no google_tag_manager entry in platformLimits'
  );
});

test('the OAuth factory requests the tagmanager scopes', () => {
  const oauth = fs.readFileSync(path.join(CORE, 'oauth.go'), 'utf8');
  for (const scope of [
    'tagmanager.readonly',
    'tagmanager.edit.containers',
    'tagmanager.publish',
  ]) {
    assert.ok(oauth.includes(scope), `Google OAuth factory does not request ${scope}`);
  }
});

// Google silently strips scopes that are not configured in Cloud Console, which
// is exactly how analytics.edit shipped dead. The guard has to stay findable.
test('the scope addition carries its console-prerequisite guard', () => {
  const oauth = fs.readFileSync(path.join(CORE, 'oauth.go'), 'utf8');
  assert.ok(
    oauth.includes('gtm-scope-console-prereq'),
    'the REGRESSION GUARD naming the Cloud Console prerequisite is missing — without it the next reader will assume the scopes are live'
  );
});

test('the privacy policy discloses Tag Manager access', () => {
  const worker = fs.readFileSync(path.join(CORE, 'landing/worker.js'), 'utf8');
  assert.ok(
    worker.includes('tagmanager.readonly'),
    'section 8.1 must list the new Google scopes — required by the Google API Services User Data policy and by the existing scope-change checklist'
  );
});
