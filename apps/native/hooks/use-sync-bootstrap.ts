import { api } from "@qali/backend/convex/_generated/api";
import { useAction } from "convex/react";
import { ConvexError } from "convex/values";
import { useEffect, useRef } from "react";

/**
 * Mirrors the web workspace route (apps/web/src/routes/_workspace/index.tsx):
 * once per signed-in session, register the user for background sync and pull
 * an initial snapshot. This is also what turns a brand-new Google grant into
 * the user's first calendar connection, so a user who only ever signs in on
 * mobile still gets one.
 */
export function useSyncBootstrap() {
  const syncNow = useAction(api.domains.sync.engine.syncNow);
  const didSeed = useRef(false);

  useEffect(() => {
    if (didSeed.current) return;
    didSeed.current = true;
    // The seed shares the manual "sync now" budget; exhausting it on a
    // relaunch streak is expected and the background schedule carries on.
    void syncNow().catch((error: unknown) => {
      if (
        error instanceof ConvexError &&
        (error.data as { code?: string } | undefined)?.code === "SYNC_RATE_LIMIT"
      ) {
        return;
      }
      console.warn("Initial sync failed:", error);
    });
  }, [syncNow]);
}
