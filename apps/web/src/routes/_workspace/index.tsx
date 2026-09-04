import { api } from "@qali/backend/convex/_generated/api";
import { createFileRoute } from "@tanstack/react-router";
import { useAction } from "convex/react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { CalendarWeekView } from "@/components/calendar/calendar";
import { useDock } from "@/components/workspace/dock-context";

type LinkReturnSearch = {
  linked?: string;
  linkError?: string;
  error?: string;
};

export const Route = createFileRoute("/_workspace/")({
  // The Better Auth link flow returns here with `?linked=google`, or with
  // `?linkError=google&error=<code>` when the callback rejected the link.
  validateSearch: (search: Record<string, unknown>): LinkReturnSearch => {
    const out: LinkReturnSearch = {};
    if (typeof search.linked === "string") out.linked = search.linked;
    if (typeof search.linkError === "string") out.linkError = search.linkError;
    if (typeof search.error === "string") out.error = search.error;
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
  const { linked, linkError, error } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { open } = useDock();

  // Register the user for background sync and pull an initial snapshot of their
  // Google calendar + contacts on first load.
  const didSeed = useRef(false);
  useEffect(() => {
    if (didSeed.current) return;
    didSeed.current = true;
    void syncNow();
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

  return <CalendarWeekView />;
}
