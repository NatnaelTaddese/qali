import { usePreferences } from "@/components/workspace/preferences-context";
import { MS_PER_HOUR } from "./lib";

const HOURS = Array.from({ length: 23 }, (_, i) => i + 1);

interface TimeGutterProps {
  /** IANA timezone whose clock hours label this gutter. */
  timeZone: string;
  /** Midnight of the reference day, in the primary (grid) timezone. */
  dayStartMs: number;
}

/** Cached per zone/clock: Intl construction is costly and this renders on
 * every strip scroll/drag frame. */
const hourFormatters = new Map<string, Intl.DateTimeFormat>();

function hourFormatter(timeZone: string, use24h: boolean): Intl.DateTimeFormat {
  const key = `${timeZone}:${use24h}`;
  let fmt = hourFormatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      timeZone,
      hour12: !use24h,
    });
    hourFormatters.set(key, fmt);
  }
  return fmt;
}

export function TimeGutter({ timeZone, dayStartMs }: TimeGutterProps) {
  const { use24h } = usePreferences();
  const fmt = hourFormatter(timeZone, use24h);
  return (
    <div className="relative h-full">
      {HOURS.map((hour) => (
        <span
          key={hour}
          className="absolute right-1.5 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground"
          style={{ top: `${(hour / 24) * 100}%` }}
        >
          {fmt.format(dayStartMs + hour * MS_PER_HOUR).toLowerCase().replace(" ", "")}
        </span>
      ))}
    </div>
  );
}
