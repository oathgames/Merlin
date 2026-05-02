// Merlin PWA version — single source of truth for the service-worker cache
// name. Keep in lockstep with autoCMO/package.json:"version". When bumping
// a release, both files MUST move together; otherwise the SW will think it's
// already current and never trigger the install→activate cache rotation.
//
// Loaded via importScripts('version.js') in sw.js, and via a plain <script>
// tag from the PWA shell (pwa.js). Both consumers read
// self.MERLIN_PWA_VERSION.
//
// Shape: exactly one global assignment, no imports, no side effects.

self.MERLIN_PWA_VERSION = '1.13.1';
