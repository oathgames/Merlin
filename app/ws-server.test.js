// Source-scan regression test for ws-server.js + every other app/*.js that
// opens a listening socket. We do NOT boot ws-server here — the goal is to
// lock the bind address in source, the same way stripe_readonly_test.go
// locks Stripe writes out of the source tree.
//
// Why this matters: an earlier TODO in ws-server.js proposed widening the
// LAN listener from 127.0.0.1 to 0.0.0.0 "when the PWA goes live." The PWA
// went live via the merlin-relay Worker (outbound-only WSS), so the TODO
// became obsolete — but the comment survived. Flipping it would trigger a
// Windows Firewall / macOS firewall prompt on every first launch for every
// paying user, with zero product benefit, because the phone reaches the
// desktop through the relay regardless of network. This test is the
// tripwire: if a future edit adds a wide bind anywhere in app/, CI fails.
//
// Run with: node app/ws-server.test.js
//
// Scan rules (all must hold for every .js file in app/):
//   1. Every .listen(..., host, ...) call that names a host must use
//      '127.0.0.1', 'localhost', or 'loopback' — never '0.0.0.0', '::',
//      '0', '', or a variable. (String literal only; variables get flagged
//      as "unverifiable" which also fails.)
//   2. No .listen(port, callback) form — the two-arg signature without a
//      host defaults to all interfaces. If you see a listen call with
//      exactly two args and the second arg isn't a host string, it's
//      ambiguous and fails.
//   3. ws-server.js must contain the REGRESSION GUARD comment block naming
//      this rule — the comment is the contract with humans, the test is
//      the contract with CI. If someone deletes the comment, the test
//      fails and they have to read this file to figure out why.

const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.log('  ✗', name);
    console.log('   ', err.message);
    failed++;
  }
}

// Strip // line comments and /* block */ comments so we don't flag TODO
// comments or example strings in docstrings. Same trick as
// stripe_readonly_test.go. Very light — it handles the common cases
// (no regex literals containing `//`, no strings containing `/*`).
// If it ever misclassifies, tighten the file it scans rather than
// weakening the regex.
function stripComments(src) {
  // Block comments first (non-greedy, across lines).
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Then line comments. Skip lines that start with an obvious string
  // quote so we don't chop URL literals — the files we scan don't put
  // `//` inside string literals, but be conservative.
  out = out.split('\n').map((line) => {
    const idx = line.indexOf('//');
    if (idx < 0) return line;
    // Crude: if there's an odd number of quotes before `//`, we're inside
    // a string — leave it alone.
    const before = line.slice(0, idx);
    const sq = (before.match(/'/g) || []).length;
    const dq = (before.match(/"/g) || []).length;
    const bt = (before.match(/`/g) || []).length;
    if (sq % 2 === 1 || dq % 2 === 1 || bt % 2 === 1) return line;
    return before;
  }).join('\n');
  return out;
}

function listJsFiles(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map((f) => path.join(dir, f));
}

test('ws-server.js exists and keeps the REGRESSION GUARD comment', () => {
  const p = path.join(APP_DIR, 'ws-server.js');
  if (!fs.existsSync(p)) throw new Error('ws-server.js missing');
  const src = fs.readFileSync(p, 'utf8');
  // The exact marker + one memorable phrase from the guard body.
  if (!src.includes('REGRESSION GUARD (2026-04-18)')) {
    throw new Error('ws-server.js lost its REGRESSION GUARD (2026-04-18) marker. Do not delete it — restore the block or add a new dated guard explaining why the rule changed.');
  }
  if (!src.includes('merlin-relay')) {
    throw new Error('ws-server.js guard no longer references merlin-relay — the rationale for loopback-only binding lives in that comment. Restore or replace it.');
  }
});

test('ws-server.js binds its LAN listener to 127.0.0.1', () => {
  const p = path.join(APP_DIR, 'ws-server.js');
  const src = stripComments(fs.readFileSync(p, 'utf8'));
  // Exactly one listen(...) call in this file; grep for it.
  const m = src.match(/httpServer\.listen\s*\(([^)]*)\)/);
  if (!m) throw new Error('no httpServer.listen(...) call found in ws-server.js');
  const args = m[1];
  // Expect the second positional arg to be '127.0.0.1' (string literal).
  if (!/['"]127\.0\.0\.1['"]/.test(args)) {
    throw new Error('httpServer.listen() in ws-server.js does not bind to \'127.0.0.1\'. Widening this bind triggers a Windows/macOS firewall prompt for every user — see REGRESSION GUARD in ws-server.js. Actual args: ' + args.trim());
  }
  // Refuse wildcards even if 127.0.0.1 is also somehow present.
  if (/['"]0\.0\.0\.0['"]|['"]::['"]|['"]::\/0['"]/.test(args)) {
    throw new Error('ws-server.js listen() mentions a wildcard bind (0.0.0.0 / ::). Remove it.');
  }
});

test('no app/*.js file binds a listener to 0.0.0.0, ::, or an unnamed host', () => {
  const files = listJsFiles(APP_DIR);
  const violations = [];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    // Find every `.listen(...)` call and inspect its args.
    // We use a forgiving regex — it's fine if we occasionally match something
    // that isn't actually a net listener, because the violation check only
    // fires on specific wildcard strings.
    const re = /\.listen\s*\(([^()]*(?:\([^)]*\)[^()]*)*)\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const args = m[1];
      // Skip EventEmitter-style `.on('listen', ...)` — those never start
      // with a number / 'port' / a call that returns a port.
      if (/^\s*['"`]/.test(args) && !/^\s*['"`][\d.:]+['"`]/.test(args)) continue;
      // Wildcard literals are always a fail.
      if (/['"]0\.0\.0\.0['"]/.test(args) || /['"]::['"]/.test(args)) {
        violations.push(`${path.basename(f)}: wildcard bind — .listen(${args.trim()})`);
        continue;
      }
    }
  }
  if (violations.length) {
    throw new Error('Wildcard listen bind detected:\n  - ' + violations.join('\n  - '));
  }
});

test('no app/*.js file uses a bare numeric .listen(port) without a host', () => {
  // Covers the `.listen(PORT)` → binds-to-all-interfaces default footgun.
  // We accept: .listen(0, '127.0.0.1', ...) / .listen(port, 'localhost', ...)
  // We reject: .listen(0) / .listen(PORT) / .listen(0, callback)
  // The check is targeted at files that we know open a server; if a future
  // file adds one, this still catches it because we scan every .js.
  const files = listJsFiles(APP_DIR);
  const violations = [];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    // Find listen( immediately preceded by something that looks like an
    // http/https/net/ws server (httpServer, srv, server, wss, httpsServer,
    // etc). This is intentionally narrow — we don't want to flag
    // EventEmitter.on('listen', ...) or array.listen.
    const re = /\b(?:httpServer|httpsServer|server|srv|wss|io|app|expressApp)\.listen\s*\(([^()]*(?:\([^)]*\)[^()]*)*)\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const args = m[1].trim();
      // Split on top-level commas. Parens-depth aware.
      const parts = [];
      let depth = 0, buf = '';
      for (const ch of args) {
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; }
        else buf += ch;
      }
      if (buf.trim()) parts.push(buf.trim());
      if (parts.length === 0) continue; // `.listen()` with no args — not useful but not unsafe either
      if (parts.length === 1) {
        // .listen(port) — all-interfaces default. Fail.
        violations.push(`${path.basename(f)}: single-arg .listen(${parts[0]}) binds all interfaces by default`);
        continue;
      }
      // 2+ args: second arg must be a host literal '127.0.0.1' / 'localhost',
      // OR it must be a callback (function). If it's a bare identifier we
      // can't verify — fail closed.
      const second = parts[1];
      const isCallback = /^\(.*\)\s*=>/.test(second) || /^function\b/.test(second) || /^async\b/.test(second);
      const isLoopbackLiteral = /^['"](127\.0\.0\.1|localhost|::1)['"]$/.test(second);
      if (isCallback) {
        // .listen(port, callback) also defaults to all interfaces. Fail.
        violations.push(`${path.basename(f)}: .listen(port, callback) form — binds all interfaces; add '127.0.0.1' as the second arg`);
        continue;
      }
      if (!isLoopbackLiteral) {
        // Could be a variable holding a hostname — unverifiable. Fail closed.
        violations.push(`${path.basename(f)}: .listen(..., ${second}, ...) — host is not a loopback string literal (unverifiable)`);
      }
    }
  }
  if (violations.length) {
    throw new Error('Unsafe .listen() form detected:\n  - ' + violations.join('\n  - '));
  }
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
