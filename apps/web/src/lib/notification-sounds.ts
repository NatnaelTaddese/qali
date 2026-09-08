import { play, type SoundName } from "cuelume";
import { useSyncExternalStore } from "react";

/** Notification sounds, synthesized by cuelume. This is the only module that
 * imports the library; everything else goes through `playNotificationSound`.
 *
 * The on/off preference is per device (localStorage), like the theme, and is
 * deliberately separate from `@qali/ui`'s `sound-muted` flag: that one silences
 * UI interaction ticks and has the inverted polarity. */

export type NotificationSoundKind =
  | "reminder"
  | "booking"
  | "success"
  | "error"
  | "sync";

/** Which cuelume sound each notification kind plays. Exported for tests. */
export const SOUND_FOR_KIND: Record<NotificationSoundKind, SoundName> = {
  // "Something is due."
  reminder: "chime",
  // "Someone showed up" — distinct from a reminder so the ear can tell.
  booking: "arrival",
  success: "success",
  error: "error",
  // A quiet "done" that won't be confused with a success toast.
  sync: "ready",
};

const STORAGE_KEY = "notification-sounds";
const DEFAULT_ENABLED = true;

let enabled = DEFAULT_ENABLED;
if (typeof window !== "undefined") {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "0") enabled = false;
    else if (stored === "1") enabled = true;
  } catch {
    // A private-mode localStorage throw keeps the default.
  }
}

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function isNotificationSoundsEnabled(): boolean {
  return enabled;
}

export function setNotificationSoundsEnabled(value: boolean): void {
  enabled = value;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
    } catch {
      // Still applies for this page load.
    }
  }
  notify();
}

/** Notifies on changes from this tab and, via `storage`, from other tabs. */
export function subscribeNotificationSounds(callback: () => void): () => void {
  listeners.add(callback);
  if (typeof window === "undefined") {
    return () => {
      listeners.delete(callback);
    };
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    enabled = event.newValue === null ? DEFAULT_ENABLED : event.newValue !== "0";
    callback();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", onStorage);
  };
}

export function useNotificationSoundsEnabled(): boolean {
  return useSyncExternalStore(
    subscribeNotificationSounds,
    isNotificationSoundsEnabled,
    () => DEFAULT_ENABLED,
  );
}

/** Plays the sound for a notification kind. Best effort: silent when sounds
 * are off, before the page has had a user gesture, or when Web Audio is
 * unavailable. */
export function playNotificationSound(kind: NotificationSoundKind): void {
  if (typeof window === "undefined" || !enabled) return;
  try {
    play(SOUND_FOR_KIND[kind]);
  } catch {
    // Audio is never worth an error.
  }
}

// cuelume refuses a volume of exactly 0, so priming plays at the quietest
// level it accepts — inaudible under the recipes' own gains.
const PRIME_VOLUME = 0.001;

/** Creates and unlocks cuelume's AudioContext inside the first user gesture,
 * so a timer-driven reminder that fires later isn't blocked by the browser's
 * autoplay policy. Idempotent; a no-op when sounds are off. */
export function primeNotificationSounds(): () => void {
  if (typeof window === "undefined" || !enabled) return () => {};
  const unlock = () => {
    remove();
    try {
      play("tick", { volume: PRIME_VOLUME });
    } catch {
      // Nothing to do; the next real play will try again.
    }
  };
  const remove = () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock, { passive: true });
  return remove;
}
