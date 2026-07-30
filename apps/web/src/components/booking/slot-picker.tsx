import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Calendar03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SlotOption } from "@qali/backend/convex/lib/availability";
import { Button } from "@qali/ui/components/button";
import { cn } from "@qali/ui/lib/utils";
import { format } from "date-fns";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { press } from "@/components/calendar/motion";

import { formatTime } from "./time-format";

/** The zone the visitor is reading times in. Slots arrive as instants, so this
 * only affects how they are *shown* — the same read the calendar grid makes. */
export const VISITOR_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function visitorZoneLabel(): string {
  return VISITOR_TIME_ZONE.split("/").pop()?.replace(/_/g, " ") ?? "local time";
}

type TimeOfDay = "morning" | "afternoon" | "evening";

/** Which third of the day a slot falls in, read in the visitor's local zone so
 * it matches the `HH:mm` labels (date-fns `format` reads local too). */
export function timeOfDay(startMs: number): TimeOfDay {
  const hour = new Date(startMs).getHours();
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

const TIME_SECTIONS: { key: TimeOfDay; label: string }[] = [
  { key: "morning", label: "Morning" },
  { key: "afternoon", label: "Afternoon" },
  { key: "evening", label: "Evening" },
];

/** Split a single day's slots into Morning/Afternoon/Evening, dropping any
 * section with nothing in it and keeping the natural time order within each. */
export function groupByTimeOfDay(
  slots: SlotOption[],
): { key: TimeOfDay; label: string; slots: SlotOption[] }[] {
  return TIME_SECTIONS.map((section) => ({
    ...section,
    slots: slots.filter((s) => timeOfDay(s.startMs) === section.key),
  })).filter((section) => section.slots.length > 0);
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
  use24Hour,
  onToggleTimeFormat,
}: {
  slots: SlotOption[];
  slotMinutes: number;
  selectedSlot: number | null;
  onSelect: (slot: number | null) => void;
  use24Hour: boolean;
  onToggleTimeFormat: () => void;
}) {
  const reduceMotion = useReducedMotion();
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
  const sections = useMemo(
    () => (active ? groupByTimeOfDay(active.slots) : []),
    [active],
  );
  const pressProps = reduceMotion ? {} : press;

  // The day strip pages with the arrows rather than a visible scrollbar, so the
  // arrows have to know what's still reachable in each direction. Re-measured on
  // scroll, on a change to the set of days, and whenever the strip resizes.
  const [scroll, setScroll] = useState({ left: false, right: false });
  const measureScroll = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setScroll((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right },
    );
  }, []);

  useEffect(() => {
    measureScroll();
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureScroll);
    observer.observe(el);
    return () => observer.disconnect();
  }, [days, measureScroll]);

  const pageStrip = (direction: 1 | -1) => {
    const el = stripRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" });
  };

  const canPage = scroll.left || scroll.right;

  // A soft fade on whichever edge still has days hidden past it, so the strip
  // reads as scrollable without a scrollbar. Each side collapses to a zero-width
  // stop when nothing is hidden that way, leaving that edge crisp.
  const fadeMask = `linear-gradient(to right, transparent 0, #000 ${
    scroll.left ? "24px" : "0"
  }, #000 ${scroll.right ? "calc(100% - 24px)" : "100%"}, transparent 100%)`;

  if (days.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <HugeiconsIcon
          icon={Calendar03Icon}
          strokeWidth={2}
          className="size-6 text-muted-foreground"
        />
        <p className="text-sm text-muted-foreground">
          No times are open in the next few weeks.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        {canPage && (
          <div className="mb-1.5 flex justify-end">
            <div className="inline-flex items-center rounded-full border border-border bg-background">
              <button
                type="button"
                aria-label="Earlier days"
                disabled={!scroll.left}
                onClick={() => pageStrip(-1)}
                className="flex size-8 items-center justify-center rounded-l-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
              >
                <HugeiconsIcon
                  icon={ArrowLeft01Icon}
                  strokeWidth={2}
                  className="size-4"
                />
              </button>
              <div className="h-4 w-px bg-border" />
              <button
                type="button"
                aria-label="Later days"
                disabled={!scroll.right}
                onClick={() => pageStrip(1)}
                className="flex size-8 items-center justify-center rounded-r-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
              >
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  className="size-4"
                />
              </button>
            </div>
          </div>
        )}
        <div
          ref={stripRef}
          role="tablist"
          aria-label="Available days"
          onScroll={measureScroll}
          style={{ maskImage: fadeMask, WebkitMaskImage: fadeMask }}
          className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {days.map((day) => {
          const isActive = day.dateKey === activeDateKey;
          const openCount = day.slots.filter((s) => s.available).length;
          return (
            <motion.button
              key={day.dateKey}
              type="button"
              role="tab"
              aria-selected={isActive}
              {...pressProps}
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
              <span
                className={cn(
                  "mt-0.5 text-[10px] tabular-nums",
                  isActive ? "text-foreground/70" : "text-muted-foreground/70",
                )}
              >
                {openCount} open
              </span>
            </motion.button>
          );
        })}
        </div>
      </div>

      {active && (
        <div>
          <div className="flex items-center justify-between gap-2 pb-1.5">
            <p className="min-w-0 truncate text-xs text-muted-foreground">
              {format(active.slots[0].startMs, "EEEE, MMMM d")} · {slotMinutes} min
            </p>
            <TimeFormatToggle use24Hour={use24Hour} onToggle={onToggleTimeFormat} />
          </div>
          <div className="max-h-64 space-y-3 overflow-y-auto pr-0.5">
            {sections.map((section) => (
              <div key={section.key} className="space-y-1.5">
                <p className="text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">
                  {section.label}
                </p>
                <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                  {section.slots.map((slot) => {
                    const label = formatTime(slot.startMs, use24Hour);
                    const isSelected = selectedSlot === slot.startMs;
                    return (
                      <motion.div
                        key={slot.startMs}
                        {...(slot.available ? pressProps : {})}
                        className="flex"
                      >
                        <Button
                          type="button"
                          variant={isSelected ? "default" : "outline"}
                          size="sm"
                          disabled={!slot.available}
                          // A disabled button takes no pointer events, so the
                          // reason has to be in the name, not a hover title.
                          aria-label={
                            slot.available ? label : `${label} — already booked`
                          }
                          aria-pressed={isSelected}
                          onClick={() => {
                            if (!slot.available) return;
                            onSelect(isSelected ? null : slot.startMs);
                          }}
                          // `disabled:opacity-50` comes from the button itself;
                          // the rule re-enables pointer events only so the
                          // cursor can say why.
                          className={cn(
                            "w-full",
                            !slot.available &&
                              "line-through disabled:pointer-events-auto disabled:cursor-not-allowed",
                          )}
                        >
                          {label}
                        </Button>
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Two-segment switch between 24-hour and AM/PM clock labels. */
function TimeFormatToggle({
  use24Hour,
  onToggle,
}: {
  use24Hour: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Time format"
      className="inline-flex shrink-0 items-center rounded-full border border-border p-0.5 text-[11px] font-medium"
    >
      <button
        type="button"
        aria-pressed={use24Hour}
        onClick={() => {
          if (!use24Hour) onToggle();
        }}
        className={cn(
          "rounded-full px-2 py-0.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          use24Hour
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        24h
      </button>
      <button
        type="button"
        aria-pressed={!use24Hour}
        onClick={() => {
          if (use24Hour) onToggle();
        }}
        className={cn(
          "rounded-full px-2 py-0.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          !use24Hour
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        AM/PM
      </button>
    </div>
  );
}
