/* Service worker do painel.
   Estrategia: rede primeiro, cache como reserva.
   O painel mostra operacao em tempo real — nao queremos servir dado velho
   achando que e atual. Se a rede falhar, avisamos em vez de mentir. */

const CACHE = "binarias-ia-v1";
const ESSENCIAIS = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ESSENCIAIS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // dados de operacao NUNCA ficam em cache
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(req).catch(() => new Response(
      JSON.stringify({ erro: "sem_conexao" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    )));
    return;
  }

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copia));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("/")))
  );
});