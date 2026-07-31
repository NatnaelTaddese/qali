import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@qali/ui/components/popover";
import { WheelPicker } from "@qali/ui/components/motion/wheel-picker";
import { cn } from "@qali/ui/lib/utils";

/** Wheel options. Hours are 12-hour (1–12); minutes step by 15 so open hours
 * land on the quarters bookers actually pick, and each wheel stays short. */
const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTE_STEP = 15;
const MINUTES = Array.from({ length: 60 / MINUTE_STEP }, (_, i) =>
  String(i * MINUTE_STEP).padStart(2, "0"),
);
const MERIDIEM = ["AM", "PM"];

interface TimeParts {
  hour: string;
  minute: string;
  meridiem: string;
}

/** Minutes-since-midnight → wheel values. Off-grid minutes round onto the step
 * so a stray value can't fall through to row 0. */
function minutesToParts(minutes: number): TimeParts {
  const clamped = Math.max(0, Math.min(minutes, 24 * 60 - 1));
  const h24 = Math.floor(clamped / 60);
  const rawMin = clamped % 60;
  const minute = Math.min(
    Math.round(rawMin / MINUTE_STEP) * MINUTE_STEP,
    60 - MINUTE_STEP,
  );
  const meridiem = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return {
    hour: String(h12),
    minute: String(minute).padStart(2, "0"),
    meridiem,
  };
}

/** Wheel values → minutes-since-midnight. */
function partsToMinutes(parts: TimeParts): number {
  const h12 = Number(parts.hour) % 12;
  const h24 = parts.meridiem === "PM" ? h12 + 12 : h12;
  return h24 * 60 + Number(parts.minute);
}

/** The chip label, e.g. `9:00 AM`. */
function formatLabel(minutes: number): string {
  const { hour, minute, meridiem } = minutesToParts(minutes);
  return `${hour}:${minute} ${meridiem}`;
}

/**
 * A tap-to-open time picker: a pill chip showing the time, opening a popover of
 * three spinning wheels (hour / minute / AM-PM). Works in minutes-since-midnight
 * so it drops straight into the availability rows.
 */
export function TimeField({
  value,
  onChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: number;
  onChange: (minutes: number) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const parts = minutesToParts(value);

  const setPart = (key: keyof TimeParts, part: string) => {
    onChange(partsToMinutes({ ...parts, [key]: part }));
  };

  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
          "flex h-8 items-center justify-center whitespace-nowrap rounded-2xl bg-input/50 px-2 text-sm tabular-nums outline-none transition-shadow hover:bg-input/70 focus-visible:ring-3 focus-visible:ring-ring/30 data-[popup-open]:ring-3 data-[popup-open]:ring-ring/30 disabled:opacity-50",
          className,
        )}
      >
        {formatLabel(value)}
      </PopoverTrigger>
      <PopoverContent align="center" className="w-auto p-2">
        <div className="flex gap-2">
          <WheelPicker
            options={HOURS}
            value={parts.hour}
            onValueChange={(v) => setPart("hour", v)}
            visibleCount={5}
            itemHeight={32}
            sound
            className="w-14"
            aria-label="Hour"
          />
          <WheelPicker
            options={MINUTES}
            value={parts.minute}
            onValueChange={(v) => setPart("minute", v)}
            visibleCount={5}
            itemHeight={32}
            sound
            className="w-14"
            aria-label="Minute"
          />
          <WheelPicker
            options={MERIDIEM}
            value={parts.meridiem}
            onValueChange={(v) => setPart("meridiem", v)}
            visibleCount={5}
            itemHeight={32}
            sound
            className="w-14"
            aria-label="AM or PM"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
