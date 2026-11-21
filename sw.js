// Family-app – Service Worker
// IMPORTANT : incrémenter CACHE_NAME à chaque livraison (ex. shell-v1.12.3-mobile-header).
// Cette version permet au navigateur de supprimer l'ancien cache et d'activer
// immédiatement le nouveau service worker.

const CACHE_NAME = "shell-v1.13.7-family-unread-calendar";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./app-core.js",
  "./manifest.webmanifest",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", event => {
  // Prépare le shell de cette version, puis demande son activation immédiate.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .catch(error => {
        // L'installation du SW ne doit pas échouer si un asset facultatif
        // n'est pas encore disponible au moment du déploiement.
        console.warn("Family-app : préchargement du shell incomplet", error);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith("shell-") && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Application conçue pour être utilisée en ligne : réseau prioritaire.
// Le cache sert uniquement de secours technique si une ressource a déjà été
// téléchargée. Les appels API Supabase ne sont jamais mis en cache.
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Ne jamais intercepter les éventuels endpoints API.
  if (url.pathname.includes("/rest/") || url.pathname.includes("/auth/") ||
      url.pathname.includes("/functions/")) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then(cached => {
        if (cached) return cached;
        if (request.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      }))
  );
});

// Réception des notifications Web Push (envoi serveur pas encore configuré).
self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) {}
  const title = payload.title || "Family-app";
  const options = {
    body: payload.body || "Une nouveauté dans votre espace familial.",
    icon: payload.icon || "./icon-192.png",
    badge: payload.badge || "./icon-192.png",
    data: { url: payload.url || "./" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const rawTarget = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : "https://ybagaini-sys.github.io/family-app/?view=tasks";

  let targetUrl;
  try {
    targetUrl = new URL(rawTarget, "https://ybagaini-sys.github.io/family-app/");
  } catch (_) {
    targetUrl = new URL("https://ybagaini-sys.github.io/family-app/?view=tasks");
  }

  // GitHub Pages publie l'application sous /family-app/, jamais à la racine.
  if (targetUrl.origin === "https://ybagaini-sys.github.io" &&
      !targetUrl.pathname.startsWith("/family-app/")) {
    targetUrl.pathname = "/family-app/" + targetUrl.pathname.replace(/^\/+/, "");
  }
  const target = targetUrl.href;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});

// Permet au bouton « Actualiser » de demander l'activation immédiate du worker en attente.
self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
