// Markdown/emoji → speakable-text cleanup for Kokoro TTS.
//
// Kokoro phonemises whatever string we hand it, so `**bold**` becomes
// "asterisk asterisk bold asterisk asterisk", `✨` becomes "sparkles" (or
// garbled nothing), and `https://merlingotme.com` becomes a five-second
// URL read-aloud. None of that is fluid conversational speech.
//
// This helper is applied at TTS ingress — ONE-SHOT (speakMessage) and
// STREAMING (per-sentence append + drained tail) — so the rendered markdown
// in the chat bubble stays untouched while the audio stays conversational.
//
// Design notes:
//   * Applied per-sentence, not across the full buffer. The sentence
//     splitter works on the raw cleaned text (punctuation is identical in
//     raw vs cleaned) and we clean each sentence just before handing it to
//     the worker. This avoids the non-monotonic-index problem that would
//     arise from cleaning the full streaming buffer (where `**bo` → `**bo`
//     but `**bold**` → `bold`, shifting every downstream cursor).
//   * The regexes are deliberately conservative: we strip the *syntax*
//     around a word, never the word itself. Lossy by design — the user
//     never hears asterisks, but "bold" still gets spoken.
//   * Emoji removal uses `\p{Extended_Pictographic}` (ES2018+). Electron
//     ships Chromium ≥ v90; all targets support this.
//
// Dual-module shim: loaded as a global (window.MerlinSpeechCleanup) in the
// renderer, and as a CommonJS module in the node-based test harness.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MerlinSpeechCleanup = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // Order matters: fenced code blocks and raw HTML go first, then inline
  // markers, then whitespace collapsing.
  const FENCED_CODE_RE  = /```[\s\S]*?```/g;
  const INLINE_CODE_RE  = /`([^`]+)`/g;
  const HTML_TAG_RE     = /<\/?[a-zA-Z][^>]*>/g;
  const IMAGE_RE        = /!\[([^\]]*)\]\([^)]*\)/g;
  const LINK_RE         = /\[([^\]]+)\]\([^)]*\)/g;
  const AUTOLINK_RE     = /<(https?:\/\/[^>]+)>/g;
  const URL_RE          = /\bhttps?:\/\/\S+/g;
  const BOLD_STAR_RE    = /\*\*([^*]+)\*\*/g;
  const BOLD_UND_RE     = /__([^_]+)__/g;
  const ITALIC_STAR_RE  = /(^|[^*])\*([^*\n]+)\*/g;
  const ITALIC_UND_RE   = /(^|[^_\w])_([^_\n]+)_/g;
  const STRIKE_RE       = /~~([^~]+)~~/g;
  const HEADER_RE       = /^\s{0,3}#{1,6}\s+/gm;
  const BLOCKQUOTE_RE   = /^\s{0,3}>\s?/gm;
  const HR_RE           = /^\s*(?:[-*_]\s?){3,}\s*$/gm;
  const LIST_BULLET_RE  = /^\s*[-*+]\s+/gm;
  const LIST_NUMBER_RE  = /^\s*\d+\.\s+/gm;
  const TABLE_PIPE_RE   = /\s*\|\s*/g;
  const TABLE_SEP_RE    = /^\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*$/gm;
  const EMOJI_RE        = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;
  const STRAY_STAR_RE   = /[*_~`]+/g;
  const WHITESPACE_RE   = /[ \t]{2,}/g;
  const NEWLINE_RE      = /\n{2,}/g;

  // Converts markdown-rendered text into a form Kokoro can speak fluidly.
  // Safe on already-clean text: no regex is destructive when its pattern
  // doesn't match, so this is idempotent.
  function cleanTextForSpeech(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw;

    s = s.replace(FENCED_CODE_RE, ' ');
    s = s.replace(TABLE_SEP_RE, ' ');
    s = s.replace(HR_RE, ' ');
    s = s.replace(HTML_TAG_RE, ' ');

    s = s.replace(IMAGE_RE, '$1');
    s = s.replace(LINK_RE, '$1');
    s = s.replace(AUTOLINK_RE, ' ');
    s = s.replace(URL_RE, ' ');

    s = s.replace(INLINE_CODE_RE, '$1');
    s = s.replace(BOLD_STAR_RE, '$1');
    s = s.replace(BOLD_UND_RE, '$1');
    s = s.replace(ITALIC_STAR_RE, '$1$2');
    s = s.replace(ITALIC_UND_RE, '$1$2');
    s = s.replace(STRIKE_RE, '$1');

    s = s.replace(HEADER_RE, '');
    s = s.replace(BLOCKQUOTE_RE, '');
    s = s.replace(LIST_BULLET_RE, '');
    s = s.replace(LIST_NUMBER_RE, '');
    s = s.replace(TABLE_PIPE_RE, ', ');

    s = s.replace(EMOJI_RE, '');
    s = s.replace(STRAY_STAR_RE, '');

    s = s.replace(WHITESPACE_RE, ' ');
    s = s.replace(NEWLINE_RE, '. ');
    s = s.replace(/\s+\./g, '.');
    s = s.replace(/\.{2,}/g, '.');

    return s.trim();
  }

  return { cleanTextForSpeech };
}));
