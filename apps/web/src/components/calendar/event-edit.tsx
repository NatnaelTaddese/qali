import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { Button } from "@qali/ui/components/button";
import { useAction, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";

import {
  EventForm,
  formValueFromEvent,
  isEventFormValid,
  toEventTimes,
  type EventFormValue,
} from "./event-form";
import type { CalendarEvent } from "./lib";
import { useEventCapabilities } from "./permissions";

/** Args for `updateEvent`, minus the id — built by diffing the form against
 * what the event started as. */
type EventPatch = Omit<
  Parameters<ReturnType<typeof useAction<typeof api.calendar.updateEvent>>>[0],
  "eventId"
>;

/**
 * Build the patch for a save: only the fields the user actually touched.
 *
 * The distinction matters because Google reads an omitted field as "leave this
 * alone" and only clears one when it is sent as an explicit `null`. Diffing
 * gives us both for free — untouched fields never appear, and a field the user
 * emptied appears as `null` rather than as `""`.
 */
function diffEvent(
  initial: EventFormValue,
  next: EventFormValue,
  event: CalendarEvent,
): EventPatch {
  const patch: EventPatch = {};

  if (next.summary !== initial.summary) {
    patch.summary = next.summary.trim() || "(No title)";
  }
  if (next.description !== initial.description) {
    patch.description = next.description || null;
  }
  if (next.location !== initial.location) {
    patch.location = next.location.trim() || null;
  }
  if (next.colorId !== initial.colorId) {
    patch.colorId = next.colorId ?? null;
  }
  if (next.isPrivate !== initial.isPrivate) {
    patch.visibility = next.isPrivate ? "private" : null;
  }
  if (next.busy !== initial.busy) {
    patch.transparency = next.busy ? "opaque" : "transparent";
  }

  // Times travel together: the backend needs both ends to render either, and
  // all-day changes how both are written.
  const times = toEventTimes(next);
  const initialTimes = toEventTimes(initial);
  if (
    times.startMs !== initialTimes.startMs ||
    times.endMs !== initialTimes.endMs ||
    next.allDay !== initial.allDay
  ) {
    patch.startMs = times.startMs;
    patch.endMs = times.endMs;
    patch.allDay = next.allDay;
    patch.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  const guestsChanged =
    next.guests.length !== initial.guests.length ||
    next.guests.some((g, i) => g.email !== initial.guests[i]?.email);
  if (guestsChanged) {
    // Patching attendees replaces the list wholesale, so carry each existing
    // guest's answer across — otherwise saving an unrelated field would reset
    // everyone's RSVP to "needs action".
    const answered = new Map(
      (event.attendees ?? []).map((a) => [a.email.toLowerCase(), a]),
    );
    patch.attendees = next.guests.map((g) => {
      const existing = answered.get(g.email.toLowerCase());
      return {
        email: g.email,
        displayName: g.displayName,
        responseStatus: existing?.responseStatus,
        optional: existing?.optional,
      };
    });
  }

  return patch;
}

/** Edit an existing event. The form is the same one used to create — what
 * differs is that the fields start populated, the save sends only what changed,
 * and what the user may change at all depends on the event. */
export function EventEdit({
  event,
  onCancel,
  onSaved,
}: {
  event: CalendarEvent;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const updateEvent = useAction(api.calendar.updateEvent);
  const calendars = useQuery(api.calendar.listCalendars) ?? [];
  const capabilities = useEventCapabilities()(event);
  // Captured once: the baseline every save diffs against. Re-seeding it from
  // `event` would erase edits in progress each time a sync lands.
  const [initial] = useState(() => formValueFromEvent(event));
  const [value, setValue] = useState<EventFormValue>(initial);
  const [saving, setSaving] = useState(false);

  const valid = isEventFormValid(value);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    const patch = diffEvent(initial, value, event);
    if (Object.keys(patch).length === 0) {
      onSaved();
      return;
    }
    setSaving(true);
    updateEvent({ eventId: event._id, ...patch })
      .then(onSaved)
      .catch((error: unknown) => {
        setSaving(false);
        toast.error("Couldn't save event", {
          description: error instanceof Error ? error.message : undefined,
        });
      });
  };

  return (
    <EventForm
      value={value}
      onChange={(patch) => setValue((prev) => ({ ...prev, ...patch }))}
      onChangeRange={(startMs, endMs) =>
        setValue((prev) => ({ ...prev, startMs, endMs }))
      }
      onSubmit={save}
      capabilities={capabilities}
      calendars={calendars}
      titlePlaceholder="(No title)"
      header={
        <button
          type="button"
          onClick={onCancel}
          className="-ml-1 flex items-center gap-1 self-start rounded-lg px-1 py-0.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HugeiconsIcon
            icon={ArrowLeft01Icon}
            strokeWidth={2}
            className="size-4 text-muted-foreground"
          />
          Edit event
        </button>
      }
      notice={
        event.recurringEventId ? (
          // Patching an expanded instance makes Google record a per-occurrence
          // exception, where its own UI would have asked about the series.
          <p className="text-xs text-muted-foreground">
            Changes apply to this event only.
          </p>
        ) : undefined
      }
      footer={
        <>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          {capabilities.canEdit && (
            <Button type="submit" size="sm" disabled={!valid || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
        </>
      }
    />
  );
}
