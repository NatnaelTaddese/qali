import {
  Cancel01Icon,
  Clock01Icon,
  LinkSquare02Icon,
  Location01Icon,
  TextAlignLeft01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { format, isSameDay } from "date-fns";
import type { ReactNode } from "react";

import { useEventColor } from "./colors";
import type { CalendarEvent } from "./lib";

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
}: {
  event: CalendarEvent;
  onClose: () => void;
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
          <span className="line-clamp-4 whitespace-pre-wrap">{event.description}</span>
        </DetailRow>
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
