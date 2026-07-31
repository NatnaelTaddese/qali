import {
  AlertCircleIcon,
  Clock01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { Button } from "@qali/ui/components/button";
import { Spinner } from "@qali/ui/components/spinner";
import { cn } from "@qali/ui/lib/utils";
import { useQuery } from "convex/react";
import { format } from "date-fns";
import { motion, useReducedMotion } from "motion/react";
import { svg as appleSvg } from "thesvg/apple";
import { svg as googleCalendarSvg } from "thesvg/google-calendar";

import { buildGoogleUrl, downloadIcs } from "./calendar-links";
import { visitorZoneLabel } from "./slot-picker";
import { formatTime } from "./time-format";

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
  use24Hour,
  onStartOver,
}: {
  token: string;
  use24Hour: boolean;
  onStartOver: () => void;
}) {
  const reduceMotion = useReducedMotion();
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

  const when = `${format(booking.startMs, "EEEE, MMMM d")} at ${formatTime(
    booking.startMs,
    use24Hour,
  )}`;
  const expired =
    booking.status === "expired" ||
    (booking.status === "pending" && booking.endMs <= Date.now());

  const state =
    booking.status === "accepted"
      ? {
          icon: Tick02Icon,
          tokenClass: "bg-primary text-primary-foreground",
          heading: "You're confirmed",
          body: `${booking.hostName} accepted your time. The calendar invitation is on its way by email.`,
        }
      : booking.status === "rejected"
        ? {
            icon: AlertCircleIcon,
            tokenClass: "bg-destructive/10 text-destructive",
            heading: "Not this time",
            body: `${booking.hostName} declined this request. You're welcome to pick another time.`,
          }
        : expired
          ? {
              icon: AlertCircleIcon,
              tokenClass: "bg-muted text-muted-foreground",
              heading: "This time has passed",
              body: `${booking.hostName} didn't confirm before the requested time ended. You're welcome to pick another time.`,
            }
          : {
              icon: Clock01Icon,
              tokenClass: "bg-muted text-muted-foreground",
              heading: "Request sent",
              body: `Waiting for ${booking.hostName} to confirm. Keep this page — it updates the moment they answer.`,
            };

  const eventTitle =
    booking.title?.trim() || `Meeting with ${booking.hostName}`;

  return (
    <motion.div
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
      animate={{
        opacity: 1,
        y: 0,
        scale: 1,
        transition: reduceMotion
          ? { duration: 0.18 }
          : { type: "spring", stiffness: 380, damping: 30 },
      }}
      className="space-y-4 py-2"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <span
          className={cn(
            "flex size-12 items-center justify-center rounded-full",
            state.tokenClass,
          )}
        >
          <HugeiconsIcon icon={state.icon} strokeWidth={2.5} className="size-6" />
        </span>
        <div className="space-y-1">
          <p className="font-display text-xl leading-tight font-bold">
            {state.heading}
          </p>
          <p className="text-sm text-muted-foreground">{state.body}</p>
        </div>
      </div>

      <div className="rounded-2xl bg-muted/60 px-4 py-3 text-center">
        <p className="text-sm font-medium">{when}</p>
        <p className="text-xs text-muted-foreground">
          Times shown in {visitorZoneLabel()}.
        </p>
      </div>

      {booking.status === "accepted" && (
        <div className="space-y-2">
          <p className="text-center text-xs text-muted-foreground">
            Add it to your calendar
          </p>
          <div className="flex gap-2">
            <CalendarLinkButton
              glyph={<BrandGlyph markup={googleCalendarSvg} />}
              onClick={() =>
                window.open(
                  buildGoogleUrl({
                    title: eventTitle,
                    startMs: booking.startMs,
                    endMs: booking.endMs,
                    description: `Booked with ${booking.hostName} via qali.`,
                  }),
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              Google
            </CalendarLinkButton>
            <CalendarLinkButton
              glyph={<BrandGlyph markup={appleSvg} mono />}
              onClick={() =>
                downloadIcs({
                  title: eventTitle,
                  startMs: booking.startMs,
                  endMs: booking.endMs,
                  description: `Booked with ${booking.hostName} via qali.`,
                })
              }
            >
              Apple / .ics
            </CalendarLinkButton>
          </div>
        </div>
      )}

      {(booking.status !== "pending" || expired) && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onStartOver}
          >
            Pick another time
          </Button>
        </div>
      )}
    </motion.div>
  );
}

/** One of the two equal-width "add to calendar" buttons. */
function CalendarLinkButton({
  glyph,
  onClick,
  children,
}: {
  glyph: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="flex-1"
      onClick={onClick}
    >
      {glyph}
      {children}
    </Button>
  );
}

/** A brand logo from `thesvg`, inlined so a monochrome mark can take the button's
 * text colour. `mono` recolours a single-fill logo (e.g. Apple's white glyph) to
 * `currentColor` so it stays legible in both themes; multicolour logos (Google
 * Calendar) are left as-is. Height is fixed and width follows the aspect ratio. */
function BrandGlyph({ markup, mono }: { markup: string; mono?: boolean }) {
  const html = mono ? markup.replace(/fill="#fff"/gi, 'fill="currentColor"') : markup;
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 [&>svg]:h-4 [&>svg]:w-auto"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
