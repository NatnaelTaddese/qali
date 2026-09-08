import { api } from "@qali/backend/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  getPushSubscription,
  pushSupport,
  subscribeToPush,
  subscriptionInput,
  unsubscribeFromPush,
} from "./push";

export type BrowserNotificationStatus =
  | "unsupported"
  | "ios-needs-install"
  | "blocked"
  | "off"
  | "on";

function permissionStatus(): BrowserNotificationStatus {
  const support = pushSupport();
  if (support !== "supported") return support;
  if (Notification.permission === "denied") return "blocked";
  return "off";
}

/**
 * The one place the permission prompt is asked for. `enable` must run from
 * a click: browsers ignore `requestPermission()` outside a user gesture.
 * Status is derived, never stored: support → permission → whether a push
 * subscription exists for this browser.
 */
export function useBrowserNotifications() {
  const vapidPublicKey = useQuery(api.domains.push.queries.vapidPublicKey);
  const subscribe = useMutation(api.domains.push.mutations.subscribe);
  const unsubscribe = useMutation(api.domains.push.mutations.unsubscribe);
  const [status, setStatus] = useState<BrowserNotificationStatus>(permissionStatus);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getPushSubscription().then((subscription) => {
      if (cancelled || !subscription) return;
      setStatus((prev) => (prev === "off" ? "on" : prev));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    if (!vapidPublicKey) {
      toast.error("Push notifications aren't configured yet");
      return;
    }
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "blocked" : "off");
        return;
      }
      const subscription = await subscribeToPush(vapidPublicKey);
      await subscribe(subscriptionInput(subscription));
      setStatus("on");
    } catch (error) {
      toast.error("Couldn't turn on notifications", {
        description: error instanceof Error ? error.message : undefined,
      });
      setStatus(permissionStatus());
    } finally {
      setBusy(false);
    }
  }, [subscribe, vapidPublicKey]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const endpoint = await unsubscribeFromPush();
      if (endpoint) await unsubscribe({ endpoint });
      setStatus(permissionStatus());
    } catch (error) {
      toast.error("Couldn't turn off notifications", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }, [unsubscribe]);

  return {
    status,
    busy,
    /** `false` while the deployment has no VAPID key: hide the toggle. */
    configured: vapidPublicKey !== null && vapidPublicKey !== undefined,
    enable,
    disable,
  };
}
