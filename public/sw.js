// Service worker: guarda a tela do painel para abrir rápido; os dados sempre vêm da rede.
const V = "ligacoes-v4";
const BASE = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(BASE))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  if (u.pathname.startsWith("/api") || u.pathname.startsWith("/evento") || u.pathname.endsWith(".csv")) return; // dados: sempre na rede
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(V).then((ch) => ch.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request).then((m) => m || caches.match("/"))));
});
