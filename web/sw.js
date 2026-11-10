/* Service worker: deixa o app instalável e abrindo mesmo sem internet.
   Arquivos do próprio site: tenta a rede primeiro e usa a cópia guardada se falhar.
   Chamadas ao Supabase (outro domínio) nunca passam por aqui. */
const V = "ligacoes-v1";
const ASSETS = [
  "./", "index.html", "dashboard.html", "style.css", "common.js", "config.js",
  "supabase.min.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(V)
      .then((c) => Promise.all(ASSETS.map((a) => c.add(a).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  if (new URL(r.url).origin !== location.origin) return;
  e.respondWith(
    fetch(r)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(V).then((c) => c.put(r, copy)); }
        return res;
      })
      .catch(() => caches.match(r).then((m) => m || caches.match("index.html")))
  );
});
