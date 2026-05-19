// Service worker mínimo para que la app sea instalable como PWA.
// Política deliberada: NO cachear nada dinámico. Cada navegación va a la red
// y el navegador maneja el HTTP cache normalmente. Esto evita el problema
// clásico de "deployé pero el usuario sigue viendo la versión vieja".
//
// Bump el `CACHE_VERSION` cada vez que cambie esta lógica de SW para forzar
// activate + limpieza de caches viejos en todos los clientes.

const CACHE_VERSION = "p4a-v3";
const OFFLINE_SHELL = "/login";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.add(OFFLINE_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // API calls: passthrough, nunca cachear.
  if (url.pathname.startsWith("/api/")) return;

  // Navegaciones (HTML): network-only con fallback al shell si está offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match(OFFLINE_SHELL))
    );
    return;
  }

  // Resto (JS/CSS/imágenes): que el HTTP cache del navegador haga su trabajo.
  // Las URLs de Next tienen hash, así que se invalidan en cada deploy solas.
});
