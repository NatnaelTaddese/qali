// qali's service worker: push only. There is deliberately no fetch handler,
// so the browser never routes navigations through here and the worst this
// file can do is fail to show a notification — it can never stop the app
// loading. Payloads come from the backend's reminder sweep (see
// domains/reminders/validators.ts for the shape).

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

async function windowClients() {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true });
}

async function visibleClient() {
  const windows = await windowClients();
  return windows.find((w) => w.visibilityState === "visible") ?? null;
}

self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  if (!data || data.kind !== "event_reminder") return;

  event.waitUntil(
    (async () => {
      // A tab the user is looking at shows the reminder itself (a toast), so
      // no OS notification competes with it. Chrome only insists on a visible
      // notification when no focused client exists — a hidden tab doesn't
      // count, and it may be frozen or on a route with no listener, so the
      // worker keeps showing the notification itself. Hidden tabs get a
      // lightweight nudge to play the app's chime, which a worker cannot.
      const tab = await visibleClient();
      if (tab) {
        console.log("[qali sw] push → visible tab", data.tag);
        tab.postMessage({ type: "reminder", payload: data });
        return;
      }
      for (const w of await windowClients()) w.postMessage({ type: "reminder-sound" });
      try {
        await self.registration.showNotification(data.title, {
          body: data.body,
          // The open tab uses the same tag when it fires locally, so a rare
          // double fire replaces rather than stacks.
          tag: data.tag,
          renotify: false,
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          timestamp: data.startMs,
          data: { url: data.url, eventId: data.eventId },
        });
        console.log("[qali sw] push → OS notification", data.tag);
      } catch (error) {
        // Shown nowhere yet: hand it to any open tab so a toast is waiting
        // when the user comes back.
        console.error("[qali sw] showNotification failed", error);
        for (const w of await windowClients()) {
          w.postMessage({ type: "reminder", payload: data });
        }
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { url, eventId } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = windows.find(
        (w) => new URL(w.url).origin === self.location.origin,
      );
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: "open-event", eventId });
        return;
      }
      await self.clients.openWindow(url || `/?event=${eventId}`);
    })(),
  );
});
