// boot-pin.js — pin-sidebar FOUC prevention.
//
// Loaded in <head> via <script src="boot-pin.js"> BEFORE body paints.
// Reads merlin.sidebar-pin.* localStorage keys and sets a
// data-pinned-sidebar="<id>" attribute on <html> so the CSS chat-shrink
// rule (style.css: html[data-pinned-sidebar="..."] #chat { margin-right:
// 340px }) matches on the very first frame. Without this script, cold
// start would render unpinned (full-width chat) for the first frame
// and then snap to pinned (340px-shrunk) once renderer.js runs — a
// visible jank on every cold launch when the user has a sidebar pinned.
//
// Why this is an EXTERNAL file rather than inline in index.html:
//   index.html declares `script-src 'self'` in its meta CSP, with no
//   'unsafe-inline' directive. Inline <script>...</script> blocks are
//   silently blocked by Electron's CSP enforcement. External files
//   referenced via src= satisfy 'self'. (The pre-existing theme-restore
//   inline IIFE in index.html "works" only because renderer.js re-
//   applies the theme post-paint, masking the inline-script failure
//   as a small imperceptible flicker. Pin-sidebar's flicker is more
//   visible because the chat reflows by 340px.)
//
// Mutual exclusivity: only one sidebar can be pinned at a time
// (renderer.js's setSidebarPinned enforces this at runtime; here we
// honor the first non-empty stored flag and ignore the other).

(function () {
  try {
    var ids = ['magic', 'archive'];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (localStorage.getItem('merlin.sidebar-pin.' + id) === 'true') {
        document.documentElement.setAttribute('data-pinned-sidebar', id);
        break; // only one sidebar pinned at a time
      }
    }
  } catch (_) {
    // localStorage disabled (private mode, sandboxed iframe, etc.) —
    // start unpinned. The renderer.js restore loop runs the same logic
    // post-paint as a defense-in-depth (also catches the case where the
    // user pinned in a session that survived an Electron restart but
    // localStorage was wiped).
  }
})();
