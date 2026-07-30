import {
  AlertCircleIcon,
  Clock01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { Button } from "@qali/ui/components/button";
import { Spinner } from "@qali/ui/components/spinner";
import { useQuery } from "convex/react";
import { format } from "date-fns";

import { visitorZoneLabel } from "./slot-picker";

/**
 * What the requester sees after asking for a time, and the only place they ever
 * learn the answer — we send no email of our own, and Google's invitation only
 * goes out once the host confirms.
 *
 * The token in the URL is the authorization, and this is a live subscription, so
 * a decision made while the tab is open lands here immediately.
 */
export function BookingConfirmation({
  token,
  onStartOver,
}: {
  token: string;
  onStartOver: () => void;
}) {
  const booking = useQuery(api.booking.getBookingByToken, { token });

  if (booking === undefined) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  if (booking === null) {
    return (
      <div className="space-y-3 py-6 text-center">
        <p className="text-sm text-muted-foreground">
          We couldn't find that request.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onStartOver}>
          Pick a time
        </Button>
      </div>
    );
  }

  const when = `${format(booking.startMs, "EEEE, MMMM d")} at ${format(
    booking.startMs,
    "HH:mm",
  )}`;

  const state =
    booking.status === "accepted"
      ? {
          icon: Tick02Icon,
          tone: "text-primary",
          heading: "You're confirmed",
          body: `${booking.hostName} accepted ${when}. The calendar invitation is on its way by email.`,
        }
      : booking.status === "rejected"
        ? {
            icon: AlertCircleIcon,
            tone: "text-destructive",
            heading: "Not this time",
            body: `${booking.hostName} declined ${when}. You're welcome to pick another time.`,
          }
        : {
            icon: Clock01Icon,
            tone: "text-muted-foreground",
            heading: "Request sent",
            body: `Waiting for ${booking.hostName} to confirm ${when}. Keep this page — it updates as soon as they answer.`,
          };

  return (
    <div className="space-y-4 py-2">
      <div className="flex items-start gap-3">
        <HugeiconsIcon
          icon={state.icon}
          strokeWidth={2}
          className={`mt-0.5 size-5 shrink-0 ${state.tone}`}
        />
        <div className="space-y-1">
          <p className="text-sm font-medium">{state.heading}</p>
          <p className="text-sm text-muted-foreground">{state.body}</p>
          <p className="text-xs text-muted-foreground">
            Times shown in {visitorZoneLabel()}.
          </p>
        </div>
      </div>
      {booking.status !== "pending" && (
        <Button type="button" variant="outline" size="sm" onClick={onStartOver}>
          Pick another time
        </Button>
      )}
    </div>
  );
}
