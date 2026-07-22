import {
  Cancel01Icon,
  Clock01Icon,
  LinkSquare02Icon,
  Location01Icon,
  PencilEdit02Icon,
  TextAlignLeft01Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { format, isSameDay } from "date-fns";
import { useMemo, type ReactNode } from "react";

import { Avatar } from "./avatar";
import { useEventColor } from "./colors";
import type { CalendarEvent } from "./lib";
import { RichTextView } from "./rich-text/rich-text-view";

type Attendee = NonNullable<CalendarEvent["attendees"]>[number];

/** How many avatars to show before collapsing the rest into a "+N" bubble. */
const MAX_AVATARS = 6;

/** A one-line RSVP tally, e.g. "5 going, 2 not going, 3 awaiting". Zero buckets
 * are omitted; order matches Google's own summary. */
function rsvpSummary(attendees: Attendee[]): string {
  const counts = { accepted: 0, declined: 0, tentative: 0, awaiting: 0 };
  for (const a of attendees) {
    if (a.responseStatus === "accepted") counts.accepted++;
    else if (a.responseStatus === "declined") counts.declined++;
    else if (a.responseStatus === "tentative") counts.tentative++;
    else counts.awaiting++;
  }
  return (
    [
      [counts.accepted, "going"],
      [counts.declined, "not going"],
      [counts.tentative, "maybe"],
      [counts.awaiting, "awaiting"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(", ");
}

/** Overlapping guest avatars plus an RSVP tally, enriched with contact photos
 * where the attendee's email matches a synced contact. */
function GuestList({ attendees }: { attendees: Attendee[] }) {
  const contacts = useQuery(api.contacts.listContacts) ?? [];
  const photoByEmail = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contacts) {
      if (!c.photoUrl) continue;
      for (const email of c.emails) map.set(email.toLowerCase(), c.photoUrl);
    }
    return map;
  }, [contacts]);

  const shown = attendees.slice(0, MAX_AVATARS);
  const overflow = attendees.length - shown.length;

  return (
    <DetailRow icon={UserMultiple02Icon}>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center">
          {shown.map((a) => (
            <span key={a.email} className="-ml-1.5 first:ml-0 rounded-full ring-2 ring-popover">
              <Avatar
                email={a.email}
                name={a.displayName}
                photoUrl={photoByEmail.get(a.email.toLowerCase())}
                className="size-6"
              />
            </span>
          ))}
          {overflow > 0 && (
            <span className="-ml-1.5 flex size-6 items-center justify-center rounded-full bg-muted text-[0.625rem] font-semibold text-muted-foreground ring-2 ring-popover">
              +{overflow}
            </span>
          )}
        </div>
        <span>{rsvpSummary(attendees)}</span>
      </div>
    </DetailRow>
  );
}

function timeText(event: CalendarEvent): string {
  if (event.allDay) {
    // Google all-day endMs is exclusive midnight.
    const lastDay = event.endMs - 1;
    return isSameDay(event.startMs, lastDay)
      ? format(event.startMs, "EEE d MMM")
      : `${format(event.startMs, "EEE d MMM")} – ${format(lastDay, "EEE d MMM")}`;
  }
  const end = format(
    event.endMs,
    isSameDay(event.startMs, event.endMs) ? "h:mm a" : "EEE d MMM, h:mm a",
  );
  return `${format(event.startMs, "EEE d MMM, h:mm a")} – ${end}`;
}

function DetailRow({ icon, children }: { icon: IconSvgElement; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm text-muted-foreground">
      <HugeiconsIcon icon={icon} strokeWidth={2} className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function EventDetail({
  event,
  onClose,
  onEdit,
}: {
  event: CalendarEvent;
  onClose: () => void;
  onEdit: () => void;
}) {
  const colorVar = useEventColor()(event);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start gap-2">
        <span
          className="mt-1.5 size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: `var(${colorVar})` }}
        />
        <p className="min-w-0 flex-1 text-base font-semibold leading-tight">
          {event.summary ?? "(No title)"}
        </p>
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit"
          className="-mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} className="size-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mt-0.5 -mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
        </button>
      </div>
      <DetailRow icon={Clock01Icon}>{timeText(event)}</DetailRow>
      {event.location && <DetailRow icon={Location01Icon}>{event.location}</DetailRow>}
      {event.description && (
        <DetailRow icon={TextAlignLeft01Icon}>
          <RichTextView html={event.description} className="line-clamp-6" />
        </DetailRow>
      )}
      {event.attendees && event.attendees.length > 0 && (
        <GuestList attendees={event.attendees} />
      )}
      {event.htmlLink && (
        <a
          href={event.htmlLink}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
        >
          <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} className="size-3.5" />
          Open in Google Calendar
        </a>
      )}
    </div>
  );
}
