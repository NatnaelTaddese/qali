import { toast as sonner } from "sonner";

import { playNotificationSound } from "./notification-sounds";

/** The app's toast. Import this instead of `sonner` so success and error
 * toasts carry their notification sound; the neutral call, `info`, `warning`,
 * `loading`, `dismiss` and friends pass straight through, silent.
 *
 * `toast.promise` is also passed through untouched: sonner resolves it to a
 * success or error state internally without calling these wrappers, so a
 * future caller wanting a sound there should play it in its own `then`. */
type Toast = typeof sonner;

const success: Toast["success"] = (...args) => {
  playNotificationSound("success");
  return sonner.success(...args);
};

const error: Toast["error"] = (...args) => {
  playNotificationSound("error");
  return sonner.error(...args);
};

export const toast: Toast = Object.assign(
  ((...args: Parameters<Toast>) => sonner(...args)) as Toast,
  sonner,
  { success, error },
);
