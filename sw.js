// Keeps the app itself available offline. Audio is cached separately by the app (IndexedDB).
// Bump VERSION whenever you change app files, so phones pick up the new version.
const VERSION = "gre-v2";
const SHELL = ["./", "index.html", "styles.css", "app.js", "config.js", "stories.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];
const CDN = ["https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL).then(() => c.addAll(CDN).catch(() => {}))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.hostname.endsWith("supabase.co")) return; // data and audio always go to the network
  const isShell = url.origin === location.origin;
  const isStatic = isShell || url.hostname.includes("jsdelivr.net") || url.hostname.includes("cdnjs.cloudflare.com") || url.hostname.includes("fonts.g");
  if (!isStatic) return;
  // network first for the app's own files (so updates show up), cache as fallback offline
  if (isShell) {
    e.respondWith(fetch(req, { cache: "no-cache" }).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
    return;
  }
  // cache first for libraries and fonts
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })));
});
