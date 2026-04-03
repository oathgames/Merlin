// Merlin PWA — Cloudflare Worker
// Serves PWA files with edge caching

import HTML from './index.html';
import JS from './pwa.js';
import CSS from './style.css';
import MANIFEST from './manifest.json';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/pwa.js') {
      return new Response(JS, { headers: { 'Content-Type': 'application/javascript;charset=UTF-8', 'Cache-Control': 'public, max-age=3600' } });
    }
    if (path === '/style.css') {
      return new Response(CSS, { headers: { 'Content-Type': 'text/css;charset=UTF-8', 'Cache-Control': 'public, max-age=3600' } });
    }
    if (path === '/manifest.json') {
      return new Response(MANIFEST, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' } });
    }

    // Default: serve index.html (preserves query params for host/port/token)
    return new Response(HTML, { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=3600' } });
  },
};
