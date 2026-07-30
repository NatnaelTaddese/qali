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

/** Group slot instants by the calendar day they fall on for the visitor. Two
 * hosts' 09:00 can land on different days for the same visitor, so the grouping
 * has to happen after the instants arrive rather than on the server. */
function groupByLocalDay(slots: number[]): { dateKey: string; slots: number[] }[] {
  const days = new Map<string, number[]>();
  for (const slot of slots) {
    const dateKey = format(slot, "yyyy-MM-dd");
    const existing = days.get(dateKey);
    if (existing) existing.push(slot);
    else days.set(dateKey, [slot]);
  }
  return [...days.entries()]
    .map(([dateKey, daySlots]) => ({ dateKey, slots: daySlots }))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

/**
 * Day strip plus the chosen day's times. Only days that actually have openings
 * appear, so a visitor never lands on an empty day and has to guess which way to
 * page.
 */
export function SlotPicker({
  slots,
  slotMinutes,
  selectedSlot,
  onSelect,
}: {
  slots: number[];
  slotMinutes: number;
  selectedSlot: number | null;
  onSelect: (slot: number | null) => void;
}) {
  const days = useMemo(() => groupByLocalDay(slots), [slots]);
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
                {format(day.slots[0], "EEE")}
              </span>
              <span className="text-lg leading-tight font-medium">
                {format(day.slots[0], "d")}
              </span>
              <span className="text-[11px]">{format(day.slots[0], "MMM")}</span>
            </button>
          );
        })}
      </div>

      {active && (
        <div>
          <p className="pb-1.5 text-xs text-muted-foreground">
            {format(active.slots[0], "EEEE, MMMM d")} · {slotMinutes} min ·
            times in {visitorZoneLabel()}
          </p>
          <div className="grid max-h-64 grid-cols-3 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-4">
            {active.slots.map((slot) => (
              <Button
                key={slot}
                type="button"
                variant={selectedSlot === slot ? "default" : "outline"}
                size="sm"
                aria-pressed={selectedSlot === slot}
                onClick={() => onSelect(selectedSlot === slot ? null : slot)}
              >
                {format(slot, "HH:mm")}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
