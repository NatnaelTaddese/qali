import {
  Calendar03Icon,
  SquareLock01Icon,
  SquareUnlock01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { Doc } from "@qali/backend/convex/_generated/dataModel";
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

/** Access roles that let us create events on a calendar. */
const WRITABLE = new Set(["owner", "writer"]);

/** Primary first, then alphabetical — the same order as the header's picker. */
function sortCalendars(calendars: Doc<"calendars">[]): Doc<"calendars">[] {
  return [...calendars].sort((a, b) => {
    if (a.primary !== b.primary) return (a.primary ? -1 : 1);
    return (a.summary ?? "").localeCompare(b.summary ?? "");
  });
}

const buttonClass =
  "flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

export interface EventControlsProps {
  calendars: Doc<"calendars">[];
  /** Google `colorId`; undefined means the calendar's own colour. */
  colorId?: string;
  onColorChange: (colorId?: string) => void;
  calendarId?: string;
  onCalendarChange: (calendarId: string) => void;
  isPrivate: boolean;
  onPrivateChange: (isPrivate: boolean) => void;
}

/** Colour, calendar and visibility for the event being created. */
export function EventControls({
  calendars,
  colorId,
  onColorChange,
  calendarId,
  onCalendarChange,
  isPrivate,
  onPrivateChange,
}: EventControlsProps) {
  const writable = sortCalendars(calendars.filter((c) => WRITABLE.has(c.accessRole ?? "")));
  const selected = writable.find((c) => c.googleCalendarId === calendarId);
  // With no colour of its own the event inherits its calendar's, so the swatch
  // previews what the grid will actually draw.
  const swatchVar =
    EVENT_COLOR_CHOICES.find((c) => c.colorId === colorId)?.colorVar ??
    (selected ? calendarColorVar(selected) : "--event-neutral");

  return (
    <div className="flex items-center gap-1">
      <Popover>
        <Tooltip>
          <TooltipTrigger
            render={<PopoverTrigger aria-label="Event colour" className={buttonClass} />}
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
              selected={colorId === undefined}
              onSelect={() => onColorChange(undefined)}
            />
            {EVENT_COLOR_CHOICES.map((choice) => (
              <Swatch
                key={choice.colorId}
                colorVar={choice.colorVar}
                label={`Colour ${choice.colorId}`}
                selected={colorId === choice.colorId}
                onSelect={() => onColorChange(choice.colorId)}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <Tooltip>
          <TooltipTrigger
            render={<PopoverTrigger aria-label="Calendar" className={buttonClass} />}
          >
            <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} className="size-4.5" />
          </TooltipTrigger>
          <TooltipContent side="top">
            {selected?.summary ?? selected?.googleCalendarId ?? "Calendar"}
          </TooltipContent>
        </Tooltip>
        <PopoverContent side="top" align="start" className="w-64 p-2">
          <div className="flex flex-col gap-0.5">
            {writable.map((cal) => (
              <button
                key={cal._id}
                type="button"
                onClick={() => onCalendarChange(cal.googleCalendarId)}
                className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span
                  className="size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: `var(${calendarColorVar(cal)})` }}
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {cal.summary ?? cal.googleCalendarId}
                </span>
                {cal.googleCalendarId === calendarId && (
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

      <IconToggle
        icon={isPrivate ? SquareLock01Icon : SquareUnlock01Icon}
        label={isPrivate ? "Private" : "Visible to others"}
        pressed={isPrivate}
        onToggle={() => onPrivateChange(!isPrivate)}
      />
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

function IconToggle({
  icon,
  label,
  pressed,
  onToggle,
}: {
  icon: IconSvgElement;
  label: string;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        aria-pressed={pressed}
        onClick={onToggle}
        className={cn(buttonClass, pressed && "bg-accent text-foreground")}
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} className="size-4.5" />
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
