import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { Button } from "@qali/ui/components/button";
import { Spinner } from "@qali/ui/components/spinner";
import { useAction, useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import {
  EventForm,
  formValueFromEvent,
  isEventFormValid,
  toEventTimes,
  type EventFormValue,
} from "./event-form";
import type { CalendarEvent } from "./lib";
import { SPRING_DOCK } from "./motion";
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
    updateEvent({ eventId: event._id, ...patch, scope })
      .then(onSaved)
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

/** How far a recurring-event edit reaches. Mirrors `updateEvent`'s `scope`. */
type SaveScope = "thisEvent" | "thisAndFollowing" | "allEvents";

const SAVE_SCOPES: { scope: SaveScope; label: string }[] = [
  { scope: "thisEvent", label: "This event" },
  { scope: "thisAndFollowing", label: "This and following events" },
  { scope: "allEvents", label: "All events" },
];

/**
 * The recurring-event footer. Clicking Save doesn't save outright — a chooser of
 * how far the edit should reach floats out of the button, morphing in with the
 * dock's own spring (`SPRING_DOCK`) and blur so it reads like the dock opening a
 * panel. It's portalled to the body and positioned as an overlay rather than
 * placed in flow, so the dock keeps its height (its shell is `overflow-hidden`,
 * which would otherwise clip a panel and force the container to grow). Picking a
 * scope saves under it.
 */
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
  const rowRef = useRef<HTMLDivElement>(null);
  // Anchor the overlay to the button's edge, captured on open. `null` = closed.
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(
    null,
  );

  const open = () => {
    const rect = rowRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.top + 8,
    });
  };

  // Escape closes just the chooser. Capture-phase + stopImmediatePropagation so
  // the dock's own Escape handler doesn't also tear the whole panel down.
  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setAnchor(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [anchor]);

  return (
    <div ref={rowRef} className="flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={!valid || saving}
        onClick={open}
      >
        {saving && <Spinner />}
        {saving ? "Saving…" : "Save"}
      </Button>

      {createPortal(
        <AnimatePresence>
          {anchor && (
            <>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                onClick={() => setAnchor(null)}
                className="fixed inset-0 z-50 cursor-default"
              />
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 8, filter: "blur(4px)" }}
                animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, scale: 0.97, y: 6, filter: "blur(4px)" }}
                transition={SPRING_DOCK}
                style={{
                  position: "fixed",
                  right: anchor.right,
                  bottom: anchor.bottom,
                  transformOrigin: "bottom right",
                }}
                className="z-50 flex w-56 flex-col gap-0.5 rounded-3xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
              >
                {SAVE_SCOPES.map((option) => (
                  <button
                    key={option.scope}
                    type="button"
                    onClick={() => {
                      setAnchor(null);
                      onSelect(option.scope);
                    }}
                    className="flex items-center rounded-2xl px-3 py-2 text-left text-sm font-medium text-popover-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                  >
                    {option.label}
                  </button>
                ))}
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
