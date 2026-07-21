import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@qali/ui/components/popover";
import { cn } from "@qali/ui/lib/utils";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { type ReactElement, useState } from "react";

import { WEEK_STARTS_ON } from "./lib";

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

interface DayPickerProps {
  /** The currently selected day (any instant within it). */
  selectedMs: number;
  /** Called with local midnight of the chosen day. */
  onSelect: (dayMs: number) => void;
  /** Days before this (local midnight) are disabled; e.g. a recurrence end. */
  minMs?: number;
  side?: "top" | "bottom";
  children: ReactElement<Record<string, unknown>>;
}

/** A single-day calendar picker in a popover. Mirrors `MonthPicker`'s look but
 * selects one day rather than snapping to a week. */
export function DayPicker({
  selectedMs,
  onSelect,
  minMs,
  side = "bottom",
  children,
}: DayPickerProps) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() =>
    startOfMonth(new Date(selectedMs)),
  );

  const gridStart = startOfWeek(startOfMonth(viewMonth), {
    weekStartsOn: WEEK_STARTS_ON,
  });
  const gridEnd = endOfWeek(endOfMonth(viewMonth), {
    weekStartsOn: WEEK_STARTS_ON,
  });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });
  const selectedDate = new Date(selectedMs);

  const select = (day: Date) => {
    onSelect(day.getTime());
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setViewMonth(startOfMonth(new Date(selectedMs)));
      }}
    >
      <PopoverTrigger render={children} />
      <PopoverContent
        align="start"
        side={side}
        sideOffset={8}
        className="w-auto rounded-2xl p-3"
      >
        <div className="mb-2 flex items-center justify-between gap-4 px-1">
          <span className="text-sm font-semibold">
            {format(viewMonth, "MMMM yyyy")}
          </span>
          <div className="flex items-center gap-1">
            <MonthNav
              icon={ArrowUp01Icon}
              label="Previous month"
              onClick={() => setViewMonth((m) => addMonths(m, -1))}
            />
            <MonthNav
              icon={ArrowDown01Icon}
              label="Next month"
              onClick={() => setViewMonth((m) => addMonths(m, 1))}
            />
          </div>
        </div>
        <div className="grid grid-cols-7 gap-y-1">
          {WEEKDAYS.map((label, i) => (
            <span
              key={i}
              className="flex size-8 items-center justify-center text-xs font-medium text-muted-foreground"
            >
              {label}
            </span>
          ))}
          {days.map((day) => {
            const inMonth = isSameMonth(day, viewMonth);
            const today = isToday(day);
            const selected = isSameDay(day, selectedDate);
            const disabled = minMs !== undefined && day.getTime() < minMs;
            return (
              <button
                key={day.getTime()}
                type="button"
                disabled={disabled}
                onClick={() => select(day)}
                className={cn(
                  "flex size-8 items-center justify-center rounded-md text-sm tabular-nums hover:bg-accent",
                  inMonth ? "text-foreground" : "text-muted-foreground/40",
                  today && !selected && "font-semibold text-primary",
                  selected &&
                    "bg-primary text-primary-foreground hover:bg-primary",
                  disabled && "pointer-events-none opacity-30",
                )}
              >
                {format(day, "d")}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MonthNav({
  icon,
  label,
  onClick,
}: {
  icon: typeof ArrowUp01Icon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <HugeiconsIcon icon={icon} strokeWidth={2} className="size-4" />
    </button>
  );
}
