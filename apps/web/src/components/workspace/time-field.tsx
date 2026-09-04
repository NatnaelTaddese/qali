import { GooDropdown } from "@qali/ui/components/ui/goo-dropdown";
import { WheelPicker } from "@qali/ui/components/motion/wheel-picker";
import { cn } from "@qali/ui/lib/utils";

import { usePreferences } from "./preferences-context";

/** Wheel options. Hours follow the user's clock preference; minutes step by 15
 * so open hours land on the quarters bookers actually pick. */
const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const HOURS_24 = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTE_STEP = 15;
const MINUTES = Array.from({ length: 60 / MINUTE_STEP }, (_, i) =>
  String(i * MINUTE_STEP).padStart(2, "0"),
);
const MERIDIEM = ["AM", "PM"];

/** Midnight at the *end* of the day — a legal `endMin` bound the wheels show as
 * `12:00 AM` and must round-trip without collapsing to `00:00`. */
const END_OF_DAY = 24 * 60;

type Mode = "start" | "end";

interface TimeParts {
  hour: string;
  minute: string;
  /** Unused on a 24-hour clock; the meridiem wheel isn't rendered then. */
  meridiem: string;
}

/** Minutes-since-midnight → wheel values, rounding off-grid minutes onto the
 * step so a stray value can't fall through to row 0. End-of-day (1440) reads as
 * `12:00 AM` (`00:00` in 24-hour) rather than being clamped to `11:45 PM`. */
function minutesToParts(minutes: number, use24h: boolean): TimeParts {
  if (minutes >= END_OF_DAY) {
    return { hour: use24h ? "00" : "12", minute: "00", meridiem: "AM" };
  }
  const clamped = Math.max(0, minutes);
  const h24 = Math.floor(clamped / 60);
  const minute = Math.min(
    Math.round((clamped % 60) / MINUTE_STEP) * MINUTE_STEP,
    60 - MINUTE_STEP,
  );
  const meridiem = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return {
    hour: use24h ? String(h24).padStart(2, "0") : String(h12),
    minute: String(minute).padStart(2, "0"),
    meridiem,
  };
}

/** Wheel values → minutes-since-midnight. In an end field, exactly midnight
 * (12:00 AM / 00:00) means the end of the day (1440), not 00:00 — so the
 * interval stays valid and midnight is reachable as an end bound. Only the
 * :00 minute maps up: 00:15 stays 15, so sub-hour past-midnight end bounds
 * remain expressible. */
function partsToMinutes(parts: TimeParts, mode: Mode, use24h: boolean): number {
  const atMidnight =
    parts.minute === "00" &&
    (use24h
      ? parts.hour === "00"
      : parts.hour === "12" && parts.meridiem === "AM");
  if (mode === "end" && atMidnight) return END_OF_DAY;
  if (use24h) return Number(parts.hour) * 60 + Number(parts.minute);
  const h12 = Number(parts.hour) % 12;
  const h24 = parts.meridiem === "PM" ? h12 + 12 : h12;
  return h24 * 60 + Number(parts.minute);
}

/** The chip label, e.g. `9:00 AM` or `09:00`. */
function formatLabel(minutes: number, use24h: boolean): string {
  const { hour, minute, meridiem } = minutesToParts(minutes, use24h);
  return use24h ? `${hour}:${minute}` : `${hour}:${minute} ${meridiem}`;
}

/** Wheels blend into the gooey panel: no card fill or border, just the columns
 * and the centre band. */
const WHEEL_CLASS = "w-14 border-transparent bg-transparent";

/**
 * A tap-to-open time picker built on the same gooey dropdown as the recurring
 * "Save" control: the pill chip morphs into a panel holding the hour / minute /
 * AM-PM wheels. Works in minutes-since-midnight so it drops straight into the
 * availability rows.
 */
export function TimeField({
  value,
  onChange,
  mode = "start",
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: number;
  onChange: (minutes: number) => void;
  /** `end` treats 12 AM as end-of-day (1440) instead of 00:00. */
  mode?: Mode;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const { use24h } = usePreferences();
  const parts = minutesToParts(value, use24h);
  const setPart = (key: keyof TimeParts, part: string) =>
    onChange(partsToMinutes({ ...parts, [key]: part }, mode, use24h));

  const wheels = (
    <div className="flex items-center justify-center gap-1 py-0.5">
      <WheelPicker
        options={use24h ? HOURS_24 : HOURS}
        value={parts.hour}
        onValueChange={(v) => setPart("hour", v)}
        visibleCount={5}
        itemHeight={32}
        sound
        className={WHEEL_CLASS}
        aria-label="Hour"
      />
      <WheelPicker
        options={MINUTES}
        value={parts.minute}
        onValueChange={(v) => setPart("minute", v)}
        visibleCount={5}
        itemHeight={32}
        sound
        className={WHEEL_CLASS}
        aria-label="Minute"
      />
      {!use24h && (
        <WheelPicker
          options={MERIDIEM}
          value={parts.meridiem}
          onValueChange={(v) => setPart("meridiem", v)}
          visibleCount={5}
          itemHeight={32}
          sound
          className={WHEEL_CLASS}
          aria-label="AM or PM"
        />
      )}
    </div>
  );

  return (
    <GooDropdown
      trigger={formatLabel(value, use24h)}
      triggerLabel={ariaLabel}
      panelContent={wheels}
      triggerSound={false}
      disabled={disabled}
      menuLabel={ariaLabel ?? "Select a time"}
      side="top"
      align="start"
      gap={8}
      // Two drums need less panel than three.
      width={use24h ? 148 : 196}
      buttonRadius={16}
      panelRadius={20}
      fill="color-mix(in oklch, var(--foreground) 7%, var(--popover))"
      foreground="var(--foreground)"
      hoverFill="var(--accent)"
      triggerClassName="w-full tabular-nums"
      className={cn("flex-1", disabled && "pointer-events-none opacity-50", className)}
    />
  );
}
