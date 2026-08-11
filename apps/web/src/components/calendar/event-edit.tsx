import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { Button } from "@qali/ui/components/button";
import { GooDropdown } from "@qali/ui/components/ui/goo-dropdown";
import { Spinner } from "@qali/ui/components/spinner";
import { useAction, useQuery } from "convex/react";
import { useRef, useState } from "react";
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
import { toRRule } from "./rrule";

/** Args for `updateEvent`, minus the id — built by diffing the form against
 * what the event started as. */
type EventPatch = Omit<
  Parameters<ReturnType<typeof useAction<typeof api.calendar.updateEvent>>>[0],
  "eventId"
>;

/** How far a recurring-event edit reaches. Mirrors `updateEvent`'s `scope`. */
export type SaveScope = "thisEvent" | "thisAndFollowing" | "allEvents";

/**
 * Build the patch for a save: only the fields the user actually touched.
 *
 * The distinction matters because Google reads an omitted field as "leave this
 * alone" and only clears one when it is sent as an explicit `null`. Diffing
 * gives us both for free — untouched fields never appear, and a field the user
 * emptied appears as `null` rather than as `""`.
 */
export function diffEvent(
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
  if (next.meet !== initial.meet) {
    // "meet" asks Google to mint a link; null clears the existing one.
    patch.conference = next.meet ? "meet" : null;
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

  if (
    next.recurrence !== null &&
    JSON.stringify(next.recurrence) !== JSON.stringify(initial.recurrence)
  ) {
    patch.recurrence = toRRule(next.recurrence);
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

export function finalizeEventPatch(
  patch: EventPatch,
  scope: SaveScope,
  timeZone: string,
): EventPatch {
  return scope !== "thisEvent" || patch.recurrence !== undefined
    ? { timeZone, ...patch }
    : patch;
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
  // Idempotency key for this save intent, reused across retries so a
  // `thisAndFollowing` split (which creates a new tail series) can't duplicate it
  // on a re-submit. Cleared on success. See updateEvent.
  const operationIdRef = useRef<string | null>(null);

  const valid = isEventFormValid(value);
  // A recurring row is one expanded instance; saving it asks how far the edit
  // should reach across the series. A plain event has only itself to change.
  const isRecurring = Boolean(event.recurringEventId);

  const save = (scope: SaveScope) => {
    if (!valid || saving) return;
    const patch = diffEvent(initial, value, event);
    if (Object.keys(patch).length === 0) {
      onSaved();
      return;
    }
    setSaving(true);
    // A series-wide scope may re-create the series server-side, and Google
    // requires a time zone on a recurring event. `diffEvent` only sets one when
    // the times change, so guarantee a zone here; an explicitly-diffed one still
    // wins since `patch` is spread last.
    const finalPatch = finalizeEventPatch(
      patch,
      scope,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    if (!operationIdRef.current) {
      operationIdRef.current = crypto.randomUUID();
    }
    updateEvent({
      eventId: event._id,
      ...finalPatch,
      scope,
      operationId: operationIdRef.current,
    })
      .then(() => {
        operationIdRef.current = null;
        onSaved();
      })
      .catch((error: unknown) => {
        setSaving(false);
        toast.error("Couldn't save event", {
          description: error instanceof Error ? error.message : undefined,
        });
      });
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // A recurring event picks its scope through the save control, so Enter here
    // must not save silently under an assumed scope.
    if (!isRecurring) save("thisEvent");
  };

  return (
    <EventForm
      value={value}
      onChange={(patch) => setValue((prev) => ({ ...prev, ...patch }))}
      onChangeRange={(startMs, endMs) =>
        setValue((prev) => ({ ...prev, startMs, endMs }))
      }
      onSubmit={onSubmit}
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
      footer={
        capabilities.canEdit && isRecurring ? (
          <RecurringSaveControl
            valid={valid}
            saving={saving}
            onCancel={onCancel}
            onSelect={save}
          />
        ) : (
          <>
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            {capabilities.canEdit && (
              <Button type="submit" size="sm" disabled={!valid || saving}>
                {saving && <Spinner />}
                {saving ? "Saving…" : "Save"}
              </Button>
            )}
          </>
        )
      }
    />
  );
}

const SAVE_SCOPES: { scope: SaveScope; label: string }[] = [
  { scope: "thisEvent", label: "This event" },
  { scope: "thisAndFollowing", label: "This and following events" },
  { scope: "allEvents", label: "All events" },
];

/** The recurring-event footer asks how far the edit should reach before saving. */
function RecurringSaveControl({
  valid,
  saving,
  onCancel,
  onSelect,
}: {
  valid: boolean;
  saving: boolean;
  onCancel: () => void;
  onSelect: (scope: SaveScope) => void;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <GooDropdown
        trigger={
          <>
            {saving && <Spinner />}
            {saving ? "Saving…" : "Save"}
          </>
        }
        disabled={!valid || saving}
        side="top"
        gap={8}
        width={224}
        buttonRadius={16}
        fill="var(--primary)"
        foreground="var(--primary-foreground)"
        hoverFill="color-mix(in oklch, var(--primary-foreground) 12%, transparent)"
        menuLabel="Apply changes to recurring event"
        items={SAVE_SCOPES.map((option) => ({
          label: option.label,
          onClick: () => onSelect(option.scope),
        }))}
      />
    </div>
  );
}
