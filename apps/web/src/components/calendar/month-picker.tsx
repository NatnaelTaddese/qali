import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { GooDropdown } from "@qali/ui/components/ui/goo-dropdown";
import { cn } from "@qali/ui/lib/utils";
import {
  addDays,
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { usePreferences } from "@/components/workspace/preferences-context";
import type { WeekStart } from "./lib";

/** Single-letter weekday headers, in the user's week order. */
function weekdayLetters(weekStartsOn: WeekStart): string[] {
  const ref = startOfWeek(new Date(), { weekStartsOn });
  return Array.from({ length: 7 }, (_, i) => format(addDays(ref, i), "EEEEE"));
}

interface MonthPickerProps {
  selectedWeekStart: Date;
  onSelect: (weekStart: Date) => void;
  children: ReactNode;
}

export function MonthPicker({ selectedWeekStart, onSelect, children }: MonthPickerProps) {
  const { weekStartsOn } = usePreferences();
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(selectedWeekStart));

  const gridStart = startOfWeek(startOfMonth(viewMonth), { weekStartsOn });
  const gridEnd = endOfWeek(endOfMonth(viewMonth), { weekStartsOn });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });
  const weekEnd = addDays(selectedWeekStart, 6);
  const weekdays = useMemo(() => weekdayLetters(weekStartsOn), [weekStartsOn]);

  const resetViewMonth = useCallback(
    (open: boolean) => {
      if (open) setViewMonth(startOfMonth(selectedWeekStart));
    },
    [selectedWeekStart],
  );

  const select = (day: Date, close: () => void) => {
    onSelect(startOfWeek(day, { weekStartsOn }));
    close();
  };

  return (
    <GooDropdown
      trigger={children}
      triggerLabel={`Choose week of ${format(selectedWeekStart, "MMMM d, yyyy")}`}
      menuLabel="Choose a calendar week"
      panelContent={(close) => (
        <div className="p-1.5">
          <div className="mb-2 flex items-center justify-between gap-4 px-1">
            <span className="text-sm font-semibold">{format(viewMonth, "MMMM yyyy")}</span>
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
            {weekdays.map((label, i) => (
              <span
                key={i}
                className="flex size-8 items-center justify-center text-xs font-medium opacity-55"
              >
                {label}
              </span>
            ))}
            {days.map((day) => {
              const inMonth = isSameMonth(day, viewMonth);
              const today = isToday(day);
              const inSelectedWeek = day >= selectedWeekStart && day <= weekEnd;
              return (
                <button
                  key={day.getTime()}
                  type="button"
                  aria-label={format(day, "EEEE, MMMM d, yyyy")}
                  aria-current={today ? "date" : undefined}
                  aria-pressed={inSelectedWeek}
                  onClick={() => select(day, close)}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-md text-sm tabular-nums outline-none transition-colors hover:bg-[var(--goo-hover-fill)] focus-visible:bg-[var(--goo-hover-fill)] focus-visible:ring-2 focus-visible:ring-primary-foreground/70",
                    !inMonth && "opacity-35",
                    inSelectedWeek && "bg-[var(--goo-hover-fill)]",
                    today &&
                      "bg-primary-foreground text-primary opacity-100 hover:bg-primary-foreground focus-visible:bg-primary-foreground",
                  )}
                >
                  {format(day, "d")}
                </button>
              );
            })}
          </div>
        </div>
      )}
      onOpenChange={resetViewMonth}
      triggerSound={false}
      align="start"
      side="bottom"
      gap={8}
      width={224}
      buttonRadius={10}
      panelRadius={18}
      fill="transparent"
      foreground="var(--foreground)"
      hoverFill="var(--accent)"
      activeFill="var(--primary)"
      activeForeground="var(--primary-foreground)"
      activeHoverFill="color-mix(in oklch, var(--primary-foreground) 14%, var(--primary))"
      className="h-7"
      triggerClassName="h-7 gap-2 !px-1 rounded-lg hover:bg-accent"
    />
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
      className="flex size-6 items-center justify-center rounded-md opacity-70 outline-none transition hover:bg-[var(--goo-hover-fill)] hover:opacity-100 focus-visible:bg-[var(--goo-hover-fill)] focus-visible:ring-2 focus-visible:ring-primary-foreground/70"
    >
      <HugeiconsIcon icon={icon} strokeWidth={2} className="size-4" />
    </button>
  );
}
