// sw.js - uygulama kabuğunu ve kütüphaneyi çevrimdışı açılabilir tutar.
// Model ağırlıklarını WebLLM kendi önbelleğinde saklar; burada ellenmez.
const SURUM = "asistan-v1";
const KABUK = ["./", "./index.html", "./style.css", "./app.js", "./core.js", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png"];
const CDN = ["esm.run", "cdn.jsdelivr.net"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SURUM).then((c) => c.addAll(KABUK)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((k) => Promise.all(k.filter((x) => x.startsWith("asistan-") && x !== SURUM).map((x) => caches.delete(x))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin === self.location.origin) {
    // Önce ağ (güncelleme hemen görünsün), olmazsa önbellek
    e.respondWith(
      fetch(r).then((res) => {
        const kopya = res.clone();
        caches.open(SURUM).then((c) => c.put(r, kopya));
        return res;
      }).catch(() => caches.match(r).then((m) => m || caches.match("./index.html")))
    );
  } else if (CDN.includes(u.hostname)) {
    // Kütüphane: önbellekten ver, arkada tazele
    e.respondWith(
      caches.open(SURUM).then((c) => c.match(r).then((m) => {
        const ag = fetch(r).then((res) => { if (res.ok) c.put(r, res.clone()); return res; }).catch(() => m);
        return m || ag;
      }))
    );
  }
});
