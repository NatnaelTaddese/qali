import { api } from "@qali/backend/convex/_generated/api";
import { useAction } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";

/** Manual "sync now", shared by the dock's nav row and the settings panel.
 * Each caller gets its own in-flight flag; the action itself is idempotent. */
export function useSyncNow() {
  const syncNow = useAction(api.domains.sync.engine.syncNow);
  const [isSyncing, setIsSyncing] = useState(false);

  const sync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      await syncNow();
    } catch (error: unknown) {
      toast.error("Couldn't sync calendar", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsSyncing(false);
    }
  };

  return { sync, isSyncing };
}
