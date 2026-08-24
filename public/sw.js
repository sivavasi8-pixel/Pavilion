// Minimal service worker — mainly here so the browser considers this app
// installable. It caches the app shell (index.html) so it opens instantly
// even on a slow connection; it does NOT cache Firestore data, so votes,
// payments, and logs always come from the live database, never stale.
const CACHE_NAME = "pavilion-shell-v2";
const SHELL_FILES = ["/", "/index.html"];

// Push notifications: this is the SAME service worker as the app-shell
// caching below, not a separate firebase-messaging-sw.js — a page can only
// really have one active service worker at the root scope, so background
// FCM handling is merged in here rather than fighting over that scope.
// firebaseConfig below is not secret (identical to the one already public
// in index.html), and this file only ever displays a notification — it
// never sends one, so no credential capable of sending anything lives here.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyB031BX7NGHGoSR8JsGseNHgXZniwpMD_o",
  authDomain: "cricket-nets-tracker.firebaseapp.com",
  projectId: "cricket-nets-tracker",
  storageBucket: "cricket-nets-tracker.firebasestorage.app",
  messagingSenderId: "81044885705",
  appId: "1:81044885705:web:329709ad243fb2ef2a7d18",
});

// Only fires while Pavilion isn't the focused tab (or is closed entirely)
// — a foreground push is handled by the page itself (index.html's own
// onMessage listener), not this one.
//
// Reads from payload.data, not payload.notification — the Worker sends
// data-only messages on purpose. A message with a top-level `notification`
// field makes the browser's push service auto-display its own system
// notification, on top of whatever this handler builds — sending data-only
// keeps this the single place a notification actually gets shown.
const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const title = (payload.data && payload.data.title) || "Pavilion";
  const body = (payload.data && payload.data.body) || "";
  self.registration.showNotification(title, {
    body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
  });
});

// Tapping the notification focuses an already-open Pavilion tab if one
// exists, otherwise opens a new one — without this, a data-only
// notification (unlike FCM's auto-displayed ones) has no click behavior
// at all.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("/");
    })
  );
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for the app shell so updates show up on next load;
// falls back to cache only if the network is unavailable.
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/index.html"))
    );
  }
});
