import { MS_PER_HOUR } from "./lib";

const HOURS = Array.from({ length: 23 }, (_, i) => i + 1);

interface TimeGutterProps {
  /** IANA timezone whose clock hours label this gutter. */
  timeZone: string;
  /** Midnight of the reference day, in the primary (grid) timezone. */
  dayStartMs: number;
}

export function TimeGutter({ timeZone, dayStartMs }: TimeGutterProps) {
  const fmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone });
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
