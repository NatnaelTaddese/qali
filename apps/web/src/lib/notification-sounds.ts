import { play, type SoundName } from "cuelume";
import { useSyncExternalStore } from "react";

/** Notification sounds, synthesized by cuelume. This is the only module that
 * imports the library; everything else goes through `playNotificationSound`.
 *
 * The on/off preference is per device (localStorage), like the theme. The
 * settings switch also drives `@qali/ui`'s `sound-muted` flag so one control
 * covers notification chimes and UI interaction ticks alike. */

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

function readStored(value: string | null): boolean {
  if (value === "0") return false;
  if (value === "1") return true;
  return DEFAULT_ENABLED;
}

let enabled = DEFAULT_ENABLED;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  try {
    enabled = readStored(localStorage.getItem(STORAGE_KEY));
  } catch {
    // A private-mode localStorage throw keeps the default.
  }
  // One listener for the page's lifetime, so a change made in another tab
  // reaches this one whether or not anything is subscribed here.
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    enabled = readStored(event.newValue);
    notify();
  });
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

/** Notifies on changes from this tab and from other tabs. */
export function subscribeNotificationSounds(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function useNotificationSoundsEnabled(): boolean {
  return useSyncExternalStore(
    subscribeNotificationSounds,
    isNotificationSoundsEnabled,
    () => DEFAULT_ENABLED,
  );
}

// cuelume can't report whether audio actually rendered: its `play` returns
// nothing and swallows a refused `resume()`. The one thing we can know is that
// the context was created or resumed inside a user gesture on this page load,
// which is what browsers require; only then do we claim a sound played.
let unlocked = false;

/** Plays the sound for a notification kind and reports whether it can be
 * relied on to have sounded. Callers showing an OS notification use the
 * result to decide whether the OS should stay quiet: `false` means "let the
 * OS make its own sound", never "stay silent". */
export function playNotificationSound(kind: NotificationSoundKind): boolean {
  if (typeof window === "undefined" || !enabled) return false;
  if (!("AudioContext" in window)) return false;
  // Sticky activation: once the user has interacted with this page load,
  // audio may play from a background tab too. Before that, browsers block it.
  if (navigator.userActivation?.hasBeenActive === false) return false;
  try {
    play(SOUND_FOR_KIND[kind]);
  } catch {
    // Audio is never worth an error.
    return false;
  }
  // Inside a gesture right now (a click on the settings switch, say) the
  // context is unlocked by this very play.
  if (navigator.userActivation?.isActive === true) unlocked = true;
  return unlocked;
}

// cuelume refuses a volume of exactly 0, so priming plays at the quietest
// level it accepts — inaudible under the recipes' own gains.
const PRIME_VOLUME = 0.001;

/** Creates and unlocks cuelume's AudioContext inside the first user gesture,
 * so a timer-driven reminder that fires later isn't blocked by the browser's
 * autoplay policy. Returns a teardown; a no-op when sounds are off, so key
 * the caller on the preference to re-arm after it turns on. */
export function primeNotificationSounds(): () => void {
  if (typeof window === "undefined" || !enabled || unlocked) return () => {};
  const unlock = () => {
    remove();
    try {
      play("tick", { volume: PRIME_VOLUME });
      unlocked = true;
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
