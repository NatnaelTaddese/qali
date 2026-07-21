import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@qali/ui/components/popover";
import { cn } from "@qali/ui/lib/utils";
import { addMonths } from "date-fns";
import { useState } from "react";

import { DayPicker } from "./day-picker";
import {
  defaultRecurrence,
  type Freq,
  type Recurrence,
  summarize,
  WEEKDAYS,
  type Weekday,
  weekdayOf,
} from "./rrule";

const WEEKDAY_INITIAL: Record<Weekday, string> = {
  MO: "M",
  TU: "T",
  WE: "W",
  TH: "T",
  FR: "F",
  SA: "S",
  SU: "S",
};

const FREQ_TABS: { freq: Freq; label: string; noun: string }[] = [
  { freq: "DAILY", label: "Day", noun: "day" },
  { freq: "WEEKLY", label: "Week", noun: "week" },
  { freq: "MONTHLY", label: "Month", noun: "month" },
  { freq: "YEARLY", label: "Year", noun: "year" },
];

const PRESETS = (startMs: number): { label: string; value: Recurrence | null }[] => [
  { label: "Does not repeat", value: null },
  { label: "Daily", value: { freq: "DAILY", interval: 1, end: { kind: "never" } } },
  {
    label: "Weekly",
    value: {
      freq: "WEEKLY",
      interval: 1,
      byWeekday: [weekdayOf(startMs)],
      end: { kind: "never" },
    },
  },
  {
    label: "Every weekday",
    value: {
      freq: "WEEKLY",
      interval: 1,
      byWeekday: ["MO", "TU", "WE", "TH", "FR"],
      end: { kind: "never" },
    },
  },
  { label: "Monthly", value: { freq: "MONTHLY", interval: 1, end: { kind: "never" } } },
  { label: "Annually", value: { freq: "YEARLY", interval: 1, end: { kind: "never" } } },
];

/** The Repeat control: a trigger showing the current rule, opening a popover
 * with presets plus a full custom RRULE editor. `null` means no recurrence. */
export function RepeatControl({
  startMs,
  value,
  onChange,
}: {
  startMs: number;
  value: Recurrence | null;
  onChange: (r: Recurrence | null) => void;
}) {
  const [open, setOpen] = useState(false);
  // The custom editor always works against a concrete rule; when nothing is set
  // yet it seeds from a sensible default so any edit turns repetition on.
  const draft = value ?? defaultRecurrence(startMs);
  const patch = (next: Partial<Recurrence>) => onChange({ ...draft, ...next });

  const endKind = value?.end.kind ?? "never";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex-1 truncate rounded-lg px-2 py-1 text-right text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        {value ? summarize(value) : "Does not repeat"}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[22rem] p-2">
        <div className="flex flex-col gap-1">
          {PRESETS(startMs).map((preset) => {
            const active = presetMatches(preset.value, value);
            return (
              <button
                key={preset.label}
                type="button"
                onClick={() => onChange(preset.value)}
                className={cn(
                  "rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  active && "bg-accent font-medium",
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <div className="mt-2 border-t pt-2">
          <p className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">
            Custom
          </p>

          {/* Interval + frequency */}
          <div className="flex items-center gap-2 px-2">
            <span className="text-sm text-muted-foreground">Every</span>
            <input
              type="number"
              min={1}
              value={draft.interval}
              onChange={(e) =>
                patch({ interval: Math.max(1, Number(e.target.value) || 1) })
              }
              aria-label="Repeat interval"
              className="h-8 w-14 rounded-lg bg-input/50 px-2 text-center text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex flex-1 gap-1 rounded-xl bg-muted p-1">
              {FREQ_TABS.map((tab) => (
                <Segment
                  key={tab.freq}
                  active={draft.freq === tab.freq}
                  onClick={() =>
                    patch({
                      freq: tab.freq,
                      byWeekday:
                        tab.freq === "WEEKLY"
                          ? (draft.byWeekday ?? [weekdayOf(startMs)])
                          : undefined,
                    })
                  }
                >
                  {tab.label}
                </Segment>
              ))}
            </div>
          </div>

          {/* Weekday picker (weekly only) */}
          {draft.freq === "WEEKLY" && (
            <div className="mt-2 flex justify-between gap-1 px-2">
              {WEEKDAYS.map((day) => {
                const on = draft.byWeekday?.includes(day) ?? false;
                return (
                  <button
                    key={day}
                    type="button"
                    aria-label={day}
                    aria-pressed={on}
                    onClick={() => patch({ byWeekday: toggleWeekday(draft.byWeekday, day) })}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-full text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {WEEKDAY_INITIAL[day]}
                  </button>
                );
              })}
            </div>
          )}

          {/* End condition */}
          <div className="mt-2 px-2">
            <div className="flex gap-1 rounded-xl bg-muted p-1">
              <Segment active={endKind === "never"} onClick={() => patch({ end: { kind: "never" } })}>
                Never
              </Segment>
              <Segment
                active={endKind === "onDate"}
                onClick={() =>
                  patch({
                    end: {
                      kind: "onDate",
                      dateMs: addMonths(new Date(startMs), 1).getTime(),
                    },
                  })
                }
              >
                On date
              </Segment>
              <Segment
                active={endKind === "count"}
                onClick={() => patch({ end: { kind: "count", count: 5 } })}
              >
                After
              </Segment>
            </div>

            {value?.end.kind === "onDate" && (
              <div className="mt-2 flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Ends on</span>
                <DayPicker
                  selectedMs={value.end.dateMs}
                  minMs={startMs}
                  side="top"
                  onSelect={(dateMs) => patch({ end: { kind: "onDate", dateMs } })}
                >
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {new Date(value.end.dateMs).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </button>
                </DayPicker>
              </div>
            )}

            {value?.end.kind === "count" && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm text-muted-foreground">After</span>
                <input
                  type="number"
                  min={1}
                  value={value.end.count}
                  onChange={(e) =>
                    patch({
                      end: { kind: "count", count: Math.max(1, Number(e.target.value) || 1) },
                    })
                  }
                  aria-label="Number of occurrences"
                  className="h-8 w-16 rounded-lg bg-input/50 px-2 text-center text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <span className="text-sm text-muted-foreground">occurrences</span>
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Segment({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex-1 rounded-lg px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-background font-medium shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function toggleWeekday(days: Weekday[] | undefined, day: Weekday): Weekday[] {
  const set = new Set(days ?? []);
  if (set.has(day)) {
    set.delete(day);
  } else {
    set.add(day);
  }
  // Never leave the weekly rule with no days — fall back to the toggled one.
  return set.size === 0 ? [day] : [...set];
}

/** Whether a preset exactly describes the current value (for highlighting). */
function presetMatches(preset: Recurrence | null, value: Recurrence | null): boolean {
  if (preset === null || value === null) return preset === value;
  return (
    preset.freq === value.freq &&
    preset.interval === value.interval &&
    value.end.kind === "never" &&
    sameWeekdays(preset.byWeekday, value.byWeekday)
  );
}

function sameWeekdays(a?: Weekday[], b?: Weekday[]): boolean {
  const sa = new Set(a ?? []);
  const sb = new Set(b ?? []);
  if (sa.size !== sb.size) return false;
  for (const d of sa) if (!sb.has(d)) return false;
  return true;
}
