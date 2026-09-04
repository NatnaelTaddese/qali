import { api } from "@qali/backend/convex/_generated/api";
import { ConvexError } from "convex/values";
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
      if (
        error instanceof ConvexError &&
        (error.data as { code?: string } | undefined)?.code === "SYNC_RATE_LIMIT"
      ) {
        toast("Your calendar was synced very recently", {
          description: "It keeps syncing in the background — try again in a few minutes.",
        });
        return;
      }
      toast.error("Couldn't sync calendar", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsSyncing(false);
    }
  };

  return { sync, isSyncing };
}
