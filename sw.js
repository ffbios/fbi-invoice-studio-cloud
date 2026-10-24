const CACHE = "fbi-invoice-studio-pwa-v13";
const PUSH_STORE = "fbi-push-key"; // holds this device's notification key; kept across app updates
const APP_SHELL = ["/", "/calendar.js", "/manifest.json", "/assets/fbi-brand-logo.svg", "/assets/fbi-logo.png", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png"];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(async cache => {
      await Promise.all(APP_SHELL.map(async url => {
        try { await cache.add(url); } catch (err) { console.warn("PWA cache skipped", url, err); }
      }));
    })
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE && key !== PUSH_STORE).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/momo-link")) return; // app download page, never cached as the app

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req, { cache: "no-store" })
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put("/", copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match("/") || Response.error())
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req);
    })
  );
});

// ---- Phone notifications ----
// The push itself carries nothing; the waiting messages are collected with this device's own key.
async function pushKey() {
  try { const r = await (await caches.open(PUSH_STORE)).match("/__push_key"); return r ? (await r.json()).key : null; } catch (e) { return null; }
}
self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let messages = [];
    const key = await pushKey();
    if (key) {
      try {
        const r = await fetch("/api/push/pending", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }), cache: "no-store" });
        const j = await r.json();
        if (j && Array.isArray(j.messages)) messages = j.messages;
      } catch (e) {}
    }
    // Android requires something to be shown for every push.
    if (!messages.length) messages = [{ title: "Invoice Studio", body: "You have a new update. Tap to open.", url: "/", tag: "fbi-update" }];
    await Promise.all(messages.map(m => self.registration.showNotification(m.title || "Invoice Studio", {
      body: m.body || "", tag: m.tag || undefined, data: { url: m.url || "/" },
      icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", renotify: !!m.tag
    })));
  })());
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) { await w.focus(); try { w.postMessage({ fbiOpen: target }); } catch (e) {} return; }
    }
    await self.clients.openWindow(target);
  })());
});
