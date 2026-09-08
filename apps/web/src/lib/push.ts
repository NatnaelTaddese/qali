/**
 * Browser-side Web Push plumbing: feature detection, the service worker
 * registration, and the PushManager subscription. No React, no Convex — the
 * hook in `use-browser-notifications.ts` wires these to the backend.
 */

export type PushSupport = "unsupported" | "ios-needs-install" | "supported";

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}

/** Whether this browser can receive Web Push at all. iOS Safari only offers
 * it to a web app installed on the Home Screen. */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "unsupported";
  }
  const supported =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  if (supported) return "supported";
  return isIOS() && !isStandalone() ? "ios-needs-install" : "unsupported";
}

export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (pushSupport() !== "supported") return null;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function getPushRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  return (await navigator.serviceWorker.getRegistration("/")) ?? null;
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  const registration = await getPushRegistration();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number;
  userAgent?: string;
}

/** The shape the backend's `subscribe` mutation takes. */
export function subscriptionInput(subscription: PushSubscription): PushSubscriptionInput {
  const json = subscription.toJSON();
  const keys = json.keys ?? {};
  if (!json.endpoint || !keys.p256dh || !keys.auth) {
    throw new Error("Push subscription is missing its keys");
  }
  return {
    endpoint: json.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    expirationTime: json.expirationTime ?? undefined,
    userAgent: navigator.userAgent,
  };
}

/** Subscribe (or reuse the existing subscription) against the deployment's
 * VAPID public key. Must follow `Notification.requestPermission()` being
 * granted; the caller owns that user gesture. */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscription> {
  const registration = await registerPushServiceWorker();
  if (!registration) throw new Error("Push notifications are not supported here");
  await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    // A subscription made under a previous VAPID key would be signed with
    // the wrong private key from now on; replace it.
    if (sameServerKey(existing, vapidPublicKey)) return existing;
    await existing.unsubscribe();
  }
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
}

/** Whether a subscription was created for this VAPID public key. A
 * subscription that reports no key (older browsers) is trusted. */
export function sameServerKey(
  subscription: PushSubscription,
  vapidPublicKey: string,
): boolean {
  const key = subscription.options?.applicationServerKey;
  if (!key) return true;
  const actual = new Uint8Array(key);
  const expected = urlBase64ToUint8Array(vapidPublicKey);
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

/** Unsubscribe locally; returns the endpoint so the backend row can go too. */
export async function unsubscribeFromPush(): Promise<string | null> {
  const subscription = await getPushSubscription();
  if (!subscription) return null;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}

/** VAPID keys are URL-safe base64; PushManager wants raw bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
