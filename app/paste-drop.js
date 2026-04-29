// paste-drop.js — pure helpers for the renderer-side paste/drop chip flow.
//
// CONTEXT: v1.19.2 retired the dedicated "Bulk upload" Magic-panel tile and
// replaced it with window-level paste / drag-drop into the chat composer.
// Pasted clipboard images materialize to assets/brands/<brand>/inbox/ via
// the new `materialize-pasted-blob` IPC; OS-path files (Finder/Explorer
// drag, copy-as-file) skip materialization and chip directly.
//
// This file is the pure logic the renderer's chip system uses — no DOM, no
// IPC, no Electron — extracted so the test suite verifies the validators
// without booting Electron. See bulk-upload.js for the same pattern on the
// IPC backend side.
//
// What lives here:
//   - MIME → extension mapping (mirrors the main-process allowlist)
//   - byte-size cap for pasted clipboard blobs (RAM-bounded)
//   - the file-extension allowlist (drag-drop accepts media only)
//   - human-readable size formatter for chip labels
//   - filename truncation that preserves the extension (24-char chip cap)
//   - attachment-list dedup by absolute path
//   - "Attached files:" message formatter — the canonical way the chip
//     paths flow into the outgoing user message
//
// SHA prefix length is owned by bulk-upload.js (BULK_SHA_PREFIX_LEN = 16)
// and re-imported here ONLY so a test can assert the two sides agree.
// Mismatch silently breaks the inbox dedup index — REGRESSION GUARD
// 2026-04-28 in bulk-upload.js documents the original 8→16 incident.

'use strict';

const path = require('node:path');
const { SHA_PREFIX_LEN: BULK_SHA_PREFIX_LEN } = require('./bulk-upload');

// PASTED_BLOB_MAX_BYTES — clipboard is RAM. A 25 MB cap covers any
// reasonable screenshot at high-DPI without letting a giant render lock
// the renderer thread during base64 encode + IPC marshal. Mirror of the
// main-process MATERIALIZE_PASTED_BLOB_MAX_BYTES — both must be ≤ the
// preload assertObj boundary (which currently has no per-field length
// guard for objects, so the main-process value is the authoritative cap).
const PASTED_BLOB_MAX_BYTES = 25 * 1024 * 1024;

// ATTACHMENT_MAX_BYTES_PER_FILE — drag-drop handlers reject files larger
// than this BEFORE attaching a chip. Mirrors the bulk-upload
// MAX_FILE_BYTES (500 MB) cap so the chip flow and the IPC backend agree
// on what "too large" means.
const ATTACHMENT_MAX_BYTES_PER_FILE = 500 * 1024 * 1024;

// MEDIA_EXT_RE — drag-drop allowlist for file extensions. This MUST be a
// subset of the bulk-upload MEDIA_EXT_ALLOWLIST (otherwise the IPC backend
// rejects something the chip already accepted, surfacing a confusing
// reject after the user already saw it land). The two are kept in sync
// by the test below.
const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|heic|heif|mp4|mov|webm|m4v|avi)$/i;

// PASTE_MIME_TO_EXT — clipboard image MIMEs we accept on paste. Subset of
// the main-process MATERIALIZE_MIME_ALLOWLIST. We deliberately do NOT
// accept image/gif on paste (clipboards rarely produce GIF, and the
// gnarly animated-frame validator is best left to the upstream
// pasted-media.js path which has REGRESSION GUARD coverage).
const PASTE_MIME_TO_EXT = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',  // some clipboards report this non-canonical MIME
  'image/webp': 'webp',
};

function pasteMimeToExt(mimeType) {
  if (typeof mimeType !== 'string') return null;
  return PASTE_MIME_TO_EXT[mimeType.toLowerCase()] || null;
}

function hasMediaExt(name) {
  return typeof name === 'string' && MEDIA_EXT_RE.test(name);
}

// formatBytes — chip-friendly size label. Below 1 KB shows raw bytes;
// otherwise rounds to KB / MB / GB with one decimal where useful.
function formatBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// truncateName — clip the visible name to `max` chars while preserving
// the extension. A 60-char "campaign_overview_final_v3.png" becomes
// "...final_v3.png" rather than "...final" — the latter loses the .png
// signal that distinguishes image chips from video/HEIC chips visually.
function truncateName(name, max = 24) {
  if (typeof name !== 'string') return '';
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot > name.length - 8) {
    const ext = name.slice(dot);
    const stemBudget = Math.max(1, max - ext.length - 1);
    return name.slice(0, stemBudget) + '…' + ext;
  }
  return name.slice(0, max - 1) + '…';
}

// dedupAttachmentsByPath — given an existing attachment list and a new
// candidate, returns the candidate iff its `path` is not already present.
// The chip system calls this on every addAttachment so a user dropping
// the same file twice in one composition doesn't double-feed the LLM.
function shouldAddAttachment(existing, candidate) {
  if (!candidate || typeof candidate.path !== 'string' || !candidate.path) return false;
  for (const att of existing) {
    if (att && att.path === candidate.path) return false;
  }
  return true;
}

// formatAttachmentsForMessage — append the "Attached file:" / "Attached
// files:" block to the user's typed text. Plain text (not markdown) so
// the SDK passes the paths through unchanged; Claude's Read tool prefers
// raw absolute paths to markdown image embeds.
//
// Behavior:
//   - empty attachments → text unchanged (including the empty-string case)
//   - attachments-only (no text) → return only the block
//   - both → text + "\n\n" + block
function formatAttachmentsForMessage(text, attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return text || '';
  const header = list.length === 1 ? 'Attached file:' : 'Attached files:';
  const lines = list.map((a) => `- ${a && a.path ? a.path : ''}`);
  const block = `${header}\n${lines.join('\n')}`;
  if (!text || !text.trim()) return block;
  return `${text}\n\n${block}`;
}

module.exports = {
  PASTED_BLOB_MAX_BYTES,
  ATTACHMENT_MAX_BYTES_PER_FILE,
  MEDIA_EXT_RE,
  PASTE_MIME_TO_EXT,
  BULK_SHA_PREFIX_LEN,
  pasteMimeToExt,
  hasMediaExt,
  formatBytes,
  truncateName,
  shouldAddAttachment,
  formatAttachmentsForMessage,
};
