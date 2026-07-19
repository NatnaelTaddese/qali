import { api } from "@qali/backend/convex/_generated/api";
import { createFileRoute } from "@tanstack/react-router";
import { useAction } from "convex/react";
import { useEffect, useRef } from "react";

import { CalendarWeekView } from "@/components/calendar/calendar";

export const Route = createFileRoute("/_workspace/")({
  component: HomeComponent,
});

function HomeComponent() {
  const syncNow = useAction(api.googleSync.syncNow);

  // Register the user for background sync and pull an initial snapshot of their
  // Google calendar + contacts on first load.
  const didSeed = useRef(false);
  useEffect(() => {
    if (didSeed.current) return;
    didSeed.current = true;
    void syncNow();
  }, [syncNow]);

  return <CalendarWeekView />;
}
