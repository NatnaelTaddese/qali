import { useEffect, useRef } from "react";
import { useSonner } from "sonner";

import { playNotificationSound } from "@/lib/notification-sounds";

/** Plays the success or error sound for each new toast, from the host side:
 * every `toast.success` / `toast.error` in the app is covered without a
 * wrapper, so no call site can drift. Renders nothing; mounted beside the
 * Toaster. Updates, dismissals and auto-closes reuse an id and stay silent. */
export function ToastSounds() {
  const { toasts } = useSonner();
  const seen = useRef(new Set<string | number>());
  useEffect(() => {
    const live = new Set<string | number>();
    for (const t of toasts) {
      live.add(t.id);
      if (seen.current.has(t.id)) continue;
      seen.current.add(t.id);
      if (t.type === "success") playNotificationSound("success");
      else if (t.type === "error") playNotificationSound("error");
    }
    for (const id of seen.current) if (!live.has(id)) seen.current.delete(id);
  }, [toasts]);
  return null;
}
