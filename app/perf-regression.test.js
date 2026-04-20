// Source-scan regression tests for performance-sensitive code paths.
//
// Like app/ws-server.test.js, this test never boots the runtime — it scans
// renderer.js and main.js source and fails if a previous performance fix
// has been reverted. Each assertion maps to a concrete incident class:
//
//   1. Scroll handler is rAF-throttled. Reverting to a raw handler burns
//      ~8 ms of main-thread budget per 120 Hz scroll tick on trackpads
//      (reads scrollHeight/scrollTop/clientHeight on every event → layout).
//
//   2. The prompt input has exactly one `input` listener. Previously two
//      listeners (autoResize + voice-interim cleanup) both read
//      input.scrollHeight on every keystroke — two synchronous layout
//      passes per character.
//
//   3. The three markdown render regexes are module-scope constants, not
//      inline in renderMarkdown. A 200-token streaming response re-compiles
//      each inline regex once per token — measurable CPU waste.
//
//   4. main.js tracks _updateCheckFirstTimeout + _updateCheckInterval as
//      module-locals AND clears them in before-quit. A raw `setInterval(...)`
//      with no stored handle leaks a 30-min timer through quit and races
//      with HTTPS teardown (observable as EPIPE in logs).
//
//   5. whisper-cli is invoked with `-bs 1 -t 4` — greedy decoding caps
//      inference at ~1x the single-pass time (beam default = 5 ⇒ ~3x),
//      and the 4-thread cap avoids oversubscription on high-core laptops.
//      Also asserts -nt / -np / -l en survive (regression guard from
//      transcribeAudioImpl's comment block).
//
// Run: node --test app/perf-regression.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8').replace(/\r\n/g, '\n');

test('renderer scroll handler is rAF-coalesced', () => {
  // The handler body must consult `_scrollRafPending` as the early-out,
  // call requestAnimationFrame, and read distFromBottom inside the rAF
  // callback — not in the scroll callback's synchronous path.
  const scrollBlock = rendererSrc.match(/chat\.addEventListener\('scroll',[\s\S]*?\},\s*\{\s*passive:\s*true\s*\}\)/);
  assert.ok(scrollBlock, 'chat scroll handler missing or no longer passes { passive: true }');
  const body = scrollBlock[0];
  assert.match(body, /_scrollRafPending/, 'scroll handler must gate on _scrollRafPending');
  assert.match(body, /requestAnimationFrame/, 'scroll handler must defer reads to requestAnimationFrame');
});

test('prompt input has a single merged listener', () => {
  // Count module-scope `input.addEventListener('input', ...)` occurrences
  // — i.e. lines starting at column 0. Indented matches belong to IIFEs
  // with a shadowed `input` local (e.g. the license-code input on ~line
  // 3892). The *prompt* textarea uses the module-level `input` binding,
  // and it must have exactly one listener on the 'input' event. Two
  // listeners means the voice-interim + autoResize split has been
  // reintroduced, which triggers two layout passes per keystroke.
  const moduleScopedRe = /^input\.addEventListener\('input',/gm;
  const matches = rendererSrc.match(moduleScopedRe) || [];
  assert.equal(matches.length, 1, `expected exactly 1 module-scope input listener on the prompt, found ${matches.length}`);
});

test('markdown render regexes are hoisted to module scope', () => {
  for (const name of ['BACKSLASH_PATH_RE', 'BARE_IMG_PATH_RE', 'BARE_VIDEO_PATH_RE', 'HTML_ARTIFACT_FENCE_RE']) {
    const re = new RegExp(`const ${name}\\s*=`);
    assert.match(rendererSrc, re, `${name} must be a module-scope constant (see PERF comment near markedRenderer)`);
  }
  // And renderMarkdown must consume the hoisted names, not inline regex literals.
  const renderFn = rendererSrc.match(/function renderMarkdown\([\s\S]*?\n\}\n/);
  assert.ok(renderFn, 'renderMarkdown not found');
  assert.match(renderFn[0], /BACKSLASH_PATH_RE/);
  assert.match(renderFn[0], /BARE_IMG_PATH_RE/);
  assert.match(renderFn[0], /BARE_VIDEO_PATH_RE/);
  assert.match(renderFn[0], /HTML_ARTIFACT_FENCE_RE/);
});

test('update-check timers are tracked and cleared in before-quit', () => {
  assert.match(mainSrc, /let _updateCheckFirstTimeout\s*=\s*null;/, '_updateCheckFirstTimeout module-local missing');
  assert.match(mainSrc, /let _updateCheckInterval\s*=\s*null;/, '_updateCheckInterval module-local missing');
  assert.match(mainSrc, /_updateCheckFirstTimeout\s*=\s*setTimeout\(checkForUpdates/, 'setTimeout assignment to _updateCheckFirstTimeout missing');
  assert.match(mainSrc, /_updateCheckInterval\s*=\s*setInterval\(checkForUpdates/, 'setInterval assignment to _updateCheckInterval missing');

  const beforeQuit = mainSrc.match(/app\.on\('before-quit',[\s\S]*?\n\s{0,4}\}\);/);
  assert.ok(beforeQuit, 'before-quit handler not found');
  assert.match(beforeQuit[0], /clearTimeout\(_updateCheckFirstTimeout\)/, 'before-quit must clear _updateCheckFirstTimeout');
  assert.match(beforeQuit[0], /clearInterval\(_updateCheckInterval\)/,  'before-quit must clear _updateCheckInterval');
});

test('whisper-cli invocation pins perf and correctness flags', () => {
  // Find the whisper spawn args line.
  const argsLine = mainSrc.match(/const args = \['-m', modelPath, '-f', wavPath[^\]]*\];/);
  assert.ok(argsLine, 'whisper spawn args line not found — the transcribe path may have moved');
  const s = argsLine[0];

  // Correctness flags (regression guard — comment at call site documents why).
  assert.match(s, /'-nt'/, '-nt (no timestamps) must remain');
  assert.match(s, /'-np'/, '-np (no progress) must remain');
  assert.match(s, /'-l', 'en'/, "-l en must remain (skips language auto-detect)");

  // Perf flags.
  assert.match(s, /'-bs', '1'/, "-bs 1 (greedy decode) missing — whisper will fall back to 5-beam search");
  assert.match(s, /'-t', '4'/, "-t 4 (thread cap) missing — risks oversubscription on high-core CPUs");
});
