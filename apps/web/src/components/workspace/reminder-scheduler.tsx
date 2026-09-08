import { AlarmClockIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import type { Id } from "@qali/backend/convex/_generated/dataModel";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { format } from "date-fns";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { timePattern, zoned } from "@/components/calendar/lib";
import {
  getPushRegistration,
  getPushSubscription,
  subscribeToPush,
  subscriptionInput,
} from "@/lib/push";
import { usePreferences } from "./preferences-context";
import {
  BUCKET_MS,
  HORIZON_MS,
  bucketNow,
  diffReminders,
  dueState,
  reminderKey,
  type UpcomingReminder,
} from "./reminder-schedule";

/** setTimeout overflows past this; a 24h horizon never reaches it, but the
 * clamp keeps a bad clock from scheduling something for right now. */
const MAX_TIMEOUT_MS = 2_147_000_000;
const TOAST_MS = 30_000;

/** What the service worker posts when a push arrives while a tab is visible
 * (it hands the reminder over rather than showing an OS notification), and
 * when a notification is clicked. */
type WorkerMessage =
  | {
      type: "reminder";
      payload: {
        eventId: string;
        title: string;
        body: string;
        startMs: number;
        allDay: boolean;
        minutes: number;
      };
    }
  | { type: "open-event"; eventId: string };

/**
 * Fires reminders in an open tab. Subscribes to the ledger's pending rows for
 * the next day, keeps one timer per row, and on fire claims the row with
 * `markFired` before showing anything — the server's sweep is the other
 * claimant, so whichever gets there first delivers and the other stays quiet.
 * Renders nothing; mounted once in the workspace shell.
 */
export function ReminderScheduler() {
  const { timeZone, use24h } = usePreferences();
  const navigate = useNavigate();
  const markFired = useMutation(api.domains.reminders.mutations.markFired);
  const resubscribe = useMutation(api.domains.push.mutations.subscribe);
  const vapidPublicKey = useQuery(api.domains.push.queries.vapidPublicKey);

  // The query key advances every few minutes so the window keeps sliding;
  // Convex re-runs queries on writes, not on the clock.
  const [fromMs, setFromMs] = useState(() => bucketNow(Date.now()));
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
    const tick = () => setFromMs(bucketNow(Date.now()));
    const schedule = () => {
      clearTimers();
      timeout = setTimeout(
        () => {
          tick();
          interval = setInterval(tick, BUCKET_MS);
        },
        BUCKET_MS - (Date.now() % BUCKET_MS),
      );
    };
    const refresh = () => {
      tick();
      schedule();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    schedule();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearTimers();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const upcoming = useQuery(api.domains.reminders.queries.upcoming, {
    fromMs,
    horizonMs: HORIZON_MS,
  });

  // key → timer, and key → the fireAt it was scheduled for (for the diff).
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const scheduledAt = useRef(new Map<string, number>());
  const byKey = useRef(new Map<string, UpcomingReminder>());
  // Session-local guard so a timer and a focus sweep can't both fire one row
  // before the query drops it.
  const fired = useRef(new Set<string>());

  const openEvent = useCallback(
    (eventId: string) => {
      void navigate({ to: "/", search: { event: eventId } });
    },
    [navigate],
  );

  const show = useCallback(
    async (r: UpcomingReminder) => {
      const title = r.summary?.trim() || "(No title)";
      const body = r.allDay
        ? "All day"
        : `Starts at ${format(zoned(r.startMs, timeZone), timePattern(use24h))}`;
      const visible = document.visibilityState === "visible";
      if (!visible && "Notification" in window && Notification.permission === "granted") {
        const tag = `reminder:${r.eventId}:${r.minutes}`;
        const options: NotificationOptions = {
          body,
          tag,
          icon: "/icon-192.png",
          data: { url: `/?event=${r.eventId}`, eventId: r.eventId },
        };
        try {
          const registration = await getPushRegistration();
          if (registration) {
            // Same tag as the push path, so a rare double fire replaces
            // rather than stacks; also the only form Android Chrome allows.
            await registration.showNotification(title, options);
            return;
          }
          const notification = new Notification(title, options);
          notification.onclick = () => {
            window.focus();
            openEvent(r.eventId);
            notification.close();
          };
          return;
        } catch {
          // Android Chrome rejects the page-level constructor; the row is
          // already claimed, so the toast below is the reminder now.
        }
      }
      toast(title, {
        description: body,
        duration: TOAST_MS,
        icon: <HugeiconsIcon icon={AlarmClockIcon} strokeWidth={2} className="size-4" />,
        action: { label: "Open", onClick: () => openEvent(r.eventId) },
      });
    },
    [openEvent, timeZone, use24h],
  );

  const fire = useCallback(
    async (r: UpcomingReminder, recorded: boolean) => {
      const key = reminderKey(r);
      if (fired.current.has(key)) return;
      fired.current.add(key);
      const timer = timers.current.get(key);
      if (timer) clearTimeout(timer);
      timers.current.delete(key);
      scheduledAt.current.delete(key);
      if (!recorded) {
        try {
          const result = await markFired({
            eventId: r.eventId as Id<"events">,
            minutes: r.minutes,
          });
          // The sweep got there first; its push carries the notification.
          if (!result.fired) return;
        } catch {
          // Offline or a blip: showing twice beats showing never, and the
          // OS tag collapses a duplicate.
        }
      }
      await show(r);
    },
    [markFired, show],
  );

  const schedule = useCallback(
    (r: UpcomingReminder) => {
      const key = reminderKey(r);
      byKey.current.set(key, r);
      const state = dueState(r.fireAtMs, Date.now());
      if (state === "stale") return;
      if (state === "due") {
        void fire(r, false);
        return;
      }
      const delay = Math.min(r.fireAtMs - Date.now(), MAX_TIMEOUT_MS);
      scheduledAt.current.set(key, r.fireAtMs);
      timers.current.set(
        key,
        setTimeout(() => void fire(r, false), delay),
      );
    },
    [fire],
  );

  // Re-diff on every result: cancel what's gone (fired elsewhere, moved,
  // deleted) and schedule what's new.
  useEffect(() => {
    if (!upcoming) return;
    const { added, removed } = diffReminders(scheduledAt.current, upcoming);
    for (const key of removed) {
      const timer = timers.current.get(key);
      if (timer) clearTimeout(timer);
      timers.current.delete(key);
      scheduledAt.current.delete(key);
      byKey.current.delete(key);
    }
    const present = new Set(upcoming.map(reminderKey));
    for (const key of [...fired.current]) {
      if (!present.has(key)) fired.current.delete(key);
    }
    for (const r of added) schedule(r);
  }, [upcoming, schedule]);

  // Background tabs get their timers throttled; on return, fire anything
  // that came due meanwhile.
  useEffect(() => {
    const sweep = () => {
      const now = Date.now();
      for (const [key, r] of byKey.current) {
        if (!timers.current.has(key)) continue;
        if (dueState(r.fireAtMs, now) !== "future") void fire(r, false);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") sweep();
    };
    window.addEventListener("focus", sweep);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", sweep);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fire]);

  // The service worker hands a push to a visible tab, and relays a
  // notification click.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "reminder") {
        const p = message.payload;
        void fire(
          {
            eventId: p.eventId,
            summary: p.title,
            startMs: p.startMs,
            allDay: p.allDay,
            fireAtMs: Date.now(),
            minutes: p.minutes,
          },
          true,
        );
      } else if (message.type === "open-event") {
        openEvent(message.eventId);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [fire, openEvent]);

  // A browser that already subscribed re-subscribes on load so the backend
  // row follows key rotations (a fresh subscription under the current key)
  // and account switches.
  const didResubscribe = useRef(false);
  useEffect(() => {
    if (didResubscribe.current || !vapidPublicKey) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    didResubscribe.current = true;
    void (async () => {
      try {
        if (!(await getPushSubscription())) return;
        const subscription = await subscribeToPush(vapidPublicKey);
        await resubscribe(subscriptionInput(subscription));
      } catch {
        // Best effort: the settings switch is the deliberate path.
      }
    })();
  }, [resubscribe, vapidPublicKey]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  return null;
}
