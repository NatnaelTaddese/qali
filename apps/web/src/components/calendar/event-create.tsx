import { api } from "@qali/backend/convex/_generated/api";
import type { EventCapabilities } from "@qali/domain/permissions";
import { Button } from "@qali/ui/components/button";
import { Spinner } from "@qali/ui/components/spinner";
import { useAction, useQuery } from "convex/react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import {
  EventForm,
  isEventFormValid,
  toEventTimes,
  type EventFormValue,
} from "./event-form";
import { toRRule } from "./rrule";

/** A new event has no owner to answer to yet, so every control is live. */
const FULL_CAPABILITIES: EventCapabilities = {
  canEdit: true,
  canInviteOthers: true,
  canSeeGuests: true,
  canDelete: true,
  canRemoveSelf: false,
  canRespond: false,
  canChangeRecurrence: true,
  isOrganizer: true,
};

/** Fields a duplicate carries over from the event it was copied from. The times
 * are not among them — those ride on the dock's create view, so the ghost on
 * the grid keeps following them. */
export type EventPrefill = Partial<
  Omit<EventFormValue, "startMs" | "endMs" | "recurrence">
>;

export function EventCreate({
  startMs,
  endMs,
  prefill,
  onChangeRange,
  onCancel,
  onCreated,
}: {
  startMs: number;
  endMs: number;
  prefill?: EventPrefill;
  /** Lifts edited times back to the dock so the ghost on the grid follows along. */
  onChangeRange: (startMs: number, endMs: number) => void;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const createEvent = useAction(api.calendar.createEvent);
  const calendars = useQuery(api.calendar.listCalendars) ?? [];
  const [submitting, setSubmitting] = useState(false);
  // Idempotency key for this create intent: minted once and reused across retries
  // (a lost response / re-submit) so the backend dedupes to one Google event
  // instead of creating a duplicate. Cleared only on success. See createEvent.
  const operationIdRef = useRef<string | null>(null);
  // Everything but the range. All three "inherit" defaults mean the same thing:
  // no colour override, the primary calendar (resolved server-side when unset),
  // and the calendar's own visibility.
  const [draft, setDraft] = useState<Omit<EventFormValue, "startMs" | "endMs">>({
    summary: "",
    description: "",
    location: "",
    meet: false,
    allDay: false,
    isPrivate: false,
    // Busy is Google's default, so the toggle starts there.
    busy: true,
    colorId: undefined,
    calendarId: undefined,
    guests: [],
    recurrence: null,
    ...prefill,
  });

  // Until the user picks one, the event goes to the primary calendar — resolved
  // here too so the controls can preview its colour.
  const activeCalendarId =
    draft.calendarId ?? calendars.find((c) => c.primary)?.googleCalendarId;
  const value: EventFormValue = {
    ...draft,
    calendarId: activeCalendarId,
    startMs,
    endMs,
  };
  const valid = isEventFormValid(value);

  const onChange = (patch: Partial<EventFormValue>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    const times = toEventTimes(value);
    if (!operationIdRef.current) {
      operationIdRef.current = crypto.randomUUID();
    }
    createEvent({
      operationId: operationIdRef.current,
      summary: value.summary.trim() || "New event",
      startMs: times.startMs,
      endMs: times.endMs,
      allDay: value.allDay,
      description: value.description || undefined,
      // A video call and a physical location are mutually exclusive modes of
      // the "Where" row, so a Meet event carries no location.
      location: value.meet ? undefined : value.location.trim() || undefined,
      addConference: value.meet || undefined,
      calendarId: activeCalendarId,
      colorId: value.colorId,
      visibility: value.isPrivate ? "private" : undefined,
      // Busy is Google's default; only send the override when Free.
      transparency: value.busy ? undefined : "transparent",
      recurrence: value.recurrence ? toRRule(value.recurrence) : undefined,
      attendees: value.guests.length
        ? value.guests.map((g) => ({
            email: g.email,
            displayName: g.displayName,
          }))
        : undefined,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
      .then(() => {
        operationIdRef.current = null;
        onCreated();
      })
      .catch((error: unknown) => {
        setSubmitting(false);
        toast.error("Couldn't create event", {
          description: error instanceof Error ? error.message : undefined,
        });
      });
  };

  return (
    <EventForm
      value={value}
      onChange={onChange}
      onChangeRange={onChangeRange}
      onSubmit={submit}
      capabilities={FULL_CAPABILITIES}
      calendars={calendars}
      canChangeCalendar
      autoFocusTitle
      footer={
        <>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!valid || submitting}>
            {submitting && <Spinner />}
            {submitting ? "Creating…" : "Create"}
          </Button>
        </>
      }
    />
  );
}
