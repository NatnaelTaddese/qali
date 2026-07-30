import type { SlotOption } from "@qali/backend/convex/lib/availability";
import { Button } from "@qali/ui/components/button";
import { cn } from "@qali/ui/lib/utils";
import { format } from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";

/** The zone the visitor is reading times in. Slots arrive as instants, so this
 * only affects how they are *shown* — the same read the calendar grid makes. */
export const VISITOR_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function visitorZoneLabel(): string {
  return VISITOR_TIME_ZONE.split("/").pop()?.replace(/_/g, " ") ?? "local time";
}

/** Group slots by the calendar day they fall on for the visitor. Two hosts'
 * 09:00 can land on different days for the same visitor, so the grouping has to
 * happen after the instants arrive rather than on the server. */
function groupByLocalDay(
  slots: SlotOption[],
): { dateKey: string; slots: SlotOption[] }[] {
  const days = new Map<string, SlotOption[]>();
  for (const slot of slots) {
    const dateKey = format(slot.startMs, "yyyy-MM-dd");
    const existing = days.get(dateKey);
    if (existing) existing.push(slot);
    else days.set(dateKey, [slot]);
  }
  return [...days.entries()]
    .map(([dateKey, daySlots]) => ({ dateKey, slots: daySlots }))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

/**
 * Day strip plus the chosen day's times. Only days with something still open
 * appear, so a visitor never lands on a day they can't book anything on and has
 * to guess which way to page — but inside a day every slot is listed, with the
 * taken ones disabled rather than missing. A visible dead 10:00 tells the visitor
 * why they can't have it; a closed-up gap just looks like the host doesn't work
 * then, and invites them to hunt for the time they wanted.
 */
export function SlotPicker({
  slots,
  slotMinutes,
  selectedSlot,
  onSelect,
}: {
  slots: SlotOption[];
  slotMinutes: number;
  selectedSlot: number | null;
  onSelect: (slot: number | null) => void;
}) {
  const days = useMemo(
    () => groupByLocalDay(slots).filter((d) => d.slots.some((s) => s.available)),
    [slots],
  );
  const [activeDateKey, setActiveDateKey] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // Follow the data: default to the first open day, and re-point if the day the
  // visitor is looking at fills up while they read it.
  useEffect(() => {
    if (days.length === 0) {
      if (activeDateKey !== null) setActiveDateKey(null);
      return;
    }
    if (!activeDateKey || !days.some((d) => d.dateKey === activeDateKey)) {
      setActiveDateKey(days[0].dateKey);
    }
  }, [days, activeDateKey]);

  const active = days.find((d) => d.dateKey === activeDateKey);

  if (days.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No times are open in the next few weeks.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Available days"
        className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
      >
        {days.map((day) => {
          const isActive = day.dateKey === activeDateKey;
          return (
            <button
              key={day.dateKey}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => {
                setActiveDateKey(day.dateKey);
                onSelect(null);
              }}
              className={cn(
                "flex w-16 shrink-0 flex-col items-center rounded-2xl border px-2 py-2 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                isActive
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <span className="text-[11px] uppercase">
                {format(day.slots[0].startMs, "EEE")}
              </span>
              <span className="text-lg leading-tight font-medium">
                {format(day.slots[0].startMs, "d")}
              </span>
              <span className="text-[11px]">
                {format(day.slots[0].startMs, "MMM")}
              </span>
            </button>
          );
        })}
      </div>

      {active && (
        <div>
          <p className="pb-1.5 text-xs text-muted-foreground">
            {format(active.slots[0].startMs, "EEEE, MMMM d")} · {slotMinutes} min
            · times in {visitorZoneLabel()}
          </p>
          <div className="grid max-h-64 grid-cols-3 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-4">
            {active.slots.map((slot) => {
              const label = format(slot.startMs, "HH:mm");
              const isSelected = selectedSlot === slot.startMs;
              return (
                <Button
                  key={slot.startMs}
                  type="button"
                  variant={isSelected ? "default" : "outline"}
                  size="sm"
                  disabled={!slot.available}
                  // A disabled button takes no pointer events, so the reason has
                  // to be in the name rather than a hover title.
                  aria-label={
                    slot.available ? label : `${label} — already booked`
                  }
                  aria-pressed={isSelected}
                  onClick={() => {
                    if (!slot.available) return;
                    onSelect(isSelected ? null : slot.startMs);
                  }}
                  // `disabled:opacity-50` comes from the button itself; the rule
                  // re-enables pointer events only so the cursor can say why.
                  className={cn(
                    !slot.available &&
                      "line-through disabled:pointer-events-auto disabled:cursor-not-allowed",
                  )}
                >
                  {label}
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
