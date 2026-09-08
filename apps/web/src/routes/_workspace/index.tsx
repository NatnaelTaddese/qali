import { api } from "@qali/backend/convex/_generated/api";
import { createFileRoute } from "@tanstack/react-router";
import { useAction, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { CalendarWeekView } from "@/components/calendar/calendar";
import { useDock } from "@/components/workspace/dock-context";

type LinkReturnSearch = {
  linked?: string;
  linkError?: string;
  error?: string;
  /** `/?event=<id>`: open this event (a reminder notification was clicked). */
  event?: string;
};

export const Route = createFileRoute("/_workspace/")({
  // The Better Auth link flow returns here with `?linked=google`, or with
  // `?linkError=google&error=<code>` when the callback rejected the link.
  validateSearch: (search: Record<string, unknown>): LinkReturnSearch => {
    const out: LinkReturnSearch = {};
    if (typeof search.linked === "string") out.linked = search.linked;
    if (typeof search.linkError === "string") out.linkError = search.linkError;
    if (typeof search.error === "string") out.error = search.error;
    if (typeof search.event === "string") out.event = search.event;
    return out;
  },
  component: HomeComponent,
});

function linkErrorMessage(code: string | undefined): string {
  if (code === "account_already_linked_to_different_user") {
    return "That Google account is already connected to a different user.";
  }
  if (code === "link_session_mismatch") {
    return "Sign in again, then connect the account from Settings.";
  }
  return "Couldn't connect the account. Please try again.";
}

function HomeComponent() {
  const syncNow = useAction(api.domains.sync.engine.syncNow);
  const connectLinkedAccounts = useAction(
    api.domains.calendar.connectionService.connectLinkedAccounts,
  );
  const { linked, linkError, error, event: eventParam } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { open, reveal } = useDock();

  // Register the user for background sync and pull an initial snapshot of their
  // Google calendar + contacts on first load.
  const didSeed = useRef(false);
  useEffect(() => {
    if (didSeed.current) return;
    didSeed.current = true;
    // The seed shares the manual "sync now" budget. A reload streak that
    // exhausts it is not worth a toast: the background schedule carries on,
    // and the buttons explain the limit when the user presses them.
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

  // Landing back from a linkSocial redirect: materialize the new grant as a
  // connection, show the accounts panel, and clean the URL.
  const didHandleLink = useRef(false);
  useEffect(() => {
    if (didHandleLink.current || (!linked && !linkError)) return;
    didHandleLink.current = true;
    if (linked) {
      open({ kind: "settings", section: "accounts" });
      void connectLinkedAccounts()
        .then(({ created }) => {
          if (created > 0) {
            toast.success("Account connected — syncing its calendars…");
          }
        })
        .catch(() => {
          toast.error("Couldn't finish connecting the account.");
        });
    } else {
      toast.error(linkErrorMessage(error));
    }
    void navigate({ search: {}, replace: true });
  }, [linked, linkError, error, open, connectLinkedAccounts, navigate]);

  // A reminder notification (OS or in-app toast) lands here with the event
  // to open: show it in the dock, scroll the grid to it, and clean the URL.
  const deepLinked = useQuery(
    api.domains.calendar.queries.findEventForDeepLink,
    eventParam ? { id: eventParam } : "skip",
  );
  const handledEvent = useRef<string | null>(null);
  useEffect(() => {
    // Once the URL is clean the guard resets, so the same event can be
    // opened again by its next reminder.
    if (!eventParam) {
      handledEvent.current = null;
      return;
    }
    if (deepLinked === undefined) return;
    if (handledEvent.current === eventParam) return;
    handledEvent.current = eventParam;
    if (deepLinked) {
      open({ kind: "event", event: deepLinked });
      reveal({ startMs: deepLinked.startMs, flashId: deepLinked._id });
    } else {
      toast.error("That event is no longer on your calendar.");
    }
    void navigate({ search: {}, replace: true });
  }, [eventParam, deepLinked, open, reveal, navigate]);

  return <CalendarWeekView />;
}
