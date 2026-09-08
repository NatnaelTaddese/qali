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

// A tab to hand the reminder to: one the user is looking at shows a toast;
// a background one shows the OS notification itself and plays the app's
// chime, which a worker cannot. Only with no tab at all does the worker show
// the notification.
async function reminderClient() {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  return (
    windows.find((w) => w.visibilityState === "visible") ?? windows[0] ?? null
  );
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
      // An open tab shows the reminder itself: a toast when visible, otherwise
      // an OS notification plus the app's chime. Chrome only insists on a
      // notification from the worker when no client exists at all.
      const tab = await reminderClient();
      if (tab) {
        console.log("[qali sw] push → tab", tab.visibilityState, data.tag);
        tab.postMessage({ type: "reminder", payload: data });
        return;
      }
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
        const windows = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        for (const w of windows) w.postMessage({ type: "reminder", payload: data });
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
