import { Calendar03Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Id } from "@qali/backend/convex/_generated/dataModel";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@qali/ui/components/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@qali/ui/components/tooltip";
import { cn } from "@qali/ui/lib/utils";

import { calendarColorVar, EVENT_COLOR_CHOICES } from "./colors";
import {
  calendarDisplayName,
  isWritableCalendar,
  type CalendarListItem,
} from "./lib";

/** Primary first, then alphabetical — the same order as the header's picker. */
function sortCalendars(calendars: CalendarListItem[]): CalendarListItem[] {
  return [...calendars].sort((a, b) => {
    if (a.primary !== b.primary) return (a.primary ? -1 : 1);
    return calendarDisplayName(a).localeCompare(calendarDisplayName(b));
  });
}

export const buttonClass =
  "flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** Inert but still legible: the swatch and the calendar name are worth reading
 * even when neither can be changed. */
const disabledClass = "opacity-50 hover:bg-transparent hover:text-muted-foreground";

export interface EventControlsProps {
  calendars: CalendarListItem[];
  /** Provider palette key; undefined means the calendar's own colour. */
  color?: string;
  onColorChange: (color?: string) => void;
  calendarId?: Id<"calendars">;
  onCalendarChange: (calendarId: Id<"calendars">) => void;
  /** The whole cluster is inert — the event can't be edited at all. */
  disabled?: boolean;
  /** Whether the calendar may be *changed*, as opposed to merely shown. Moving
   * an existing event to another calendar needs Google's `move` endpoint, which
   * we don't implement, so only the create panel passes this. */
  canChangeCalendar?: boolean;
}

/** Colour and calendar for the event being created or edited. */
export function EventControls({
  calendars,
  color,
  onColorChange,
  calendarId,
  onCalendarChange,
  disabled = false,
  canChangeCalendar = false,
}: EventControlsProps) {
  const writable = sortCalendars(calendars.filter(isWritableCalendar));
  // An event can sit on a calendar we can't write to; still name it.
  const selected =
    writable.find((c) => c._id === calendarId) ??
    calendars.find((c) => c._id === calendarId);
  // With no colour of its own the event inherits its calendar's, so the swatch
  // previews what the grid will actually draw.
  const swatchVar =
    EVENT_COLOR_CHOICES.find((c) => c.color === color)?.colorVar ??
    (selected ? calendarColorVar(selected) : "--event-neutral");

  return (
    <div className="flex items-center gap-1">
      <Popover>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                aria-label="Event colour"
                disabled={disabled}
                className={cn(buttonClass, disabled && disabledClass)}
              />
            }
          >
            <span
              className="size-4 rounded-full"
              style={{ backgroundColor: `var(${swatchVar})` }}
            />
          </TooltipTrigger>
          <TooltipContent side="top">Colour</TooltipContent>
        </Tooltip>
        <PopoverContent side="top" align="start" className="w-auto p-2">
          <div className="grid grid-cols-5 gap-1.5">
            {/* Leads the grid as a plain circle in the calendar's own colour —
                which is exactly what choosing it does. */}
            <Swatch
              colorVar={selected ? calendarColorVar(selected) : "--event-neutral"}
              label="Calendar default"
              selected={color === undefined}
              onSelect={() => onColorChange(undefined)}
            />
            {EVENT_COLOR_CHOICES.map((choice) => (
              <Swatch
                key={choice.color}
                colorVar={choice.colorVar}
                label={`Colour ${choice.color}`}
                selected={color === choice.color}
                onSelect={() => onColorChange(choice.color)}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                aria-label="Calendar"
                // Showing which calendar an event is on is still useful when it
                // can't be moved, so the trigger stays but stops opening.
                disabled={disabled || !canChangeCalendar}
                className={cn(
                  buttonClass,
                  (disabled || !canChangeCalendar) && disabledClass,
                )}
              />
            }
          >
            <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} className="size-4.5" />
          </TooltipTrigger>
          <TooltipContent side="top">
            {selected ? calendarDisplayName(selected) : "Calendar"}
          </TooltipContent>
        </Tooltip>
        <PopoverContent side="top" align="start" className="w-64 p-2">
          <div className="flex flex-col gap-0.5">
            {writable.map((cal) => (
              <button
                key={cal._id}
                type="button"
                onClick={() => onCalendarChange(cal._id)}
                className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span
                  className="size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: `var(${calendarColorVar(cal)})` }}
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {calendarDisplayName(cal)}
                </span>
                {cal._id === calendarId && (
                  <HugeiconsIcon icon={Tick02Icon} strokeWidth={2.5} className="size-4" />
                )}
              </button>
            ))}
            {writable.length === 0 && (
              <p className="px-1.5 py-1 text-sm text-muted-foreground">
                No calendars you can write to.
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function Swatch({
  colorVar,
  label,
  selected,
  onSelect,
}: {
  colorVar: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "size-7 rounded-full outline-none ring-offset-2 ring-offset-popover focus-visible:ring-2 focus-visible:ring-ring",
        selected && "ring-2 ring-foreground focus-visible:ring-foreground",
      )}
      style={{ backgroundColor: `var(${colorVar})` }}
    />
  );
}
