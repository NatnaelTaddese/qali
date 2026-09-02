import { cn } from "@qali/ui/lib/utils";

import { useWeekDays, WEEKDAY_LABELS } from "./lib";
import { CheckIcon } from "./parts";
import { useLoop } from "./use-loop";

/**
 * A miniature of the public booking page: the host's header, a strip of open
 * days, and the day's slots grouped Morning / Afternoon the way `SlotPicker`
 * does. The loop picks a day, picks a time, and sends the request.
 */
const STEPS = [2400, 1000, 1400, 2400] as const;

const MORNING = ["9:00", "9:30", "10:00"];
const AFTERNOON = ["1:30", "2:00", "2:30"];

/** Which day and slot the visitor has chosen at each step. */
function selectionAt(step: number) {
  if (step === 0) return { day: 0, slot: "10:00", period: "AM" };
  if (step === 1) return { day: 1, slot: null, period: "" };
  return { day: 1, slot: "2:30", period: "PM" };
}

export function BookingScene({ playing }: { playing: boolean }) {
  const { step } = useLoop(STEPS, playing);
  const { days } = useWeekDays();
  const sel = selectionAt(step);
  const sent = step === 3;

  return (
    <div className="flex w-full max-w-sm flex-col gap-3 rounded-2xl bg-background p-3.5 ring-1 ring-border sm:p-4">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          N
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">Book time with Nat</p>
          <p className="truncate text-xs text-muted-foreground">
            30 min · shown in your time zone
          </p>
        </div>
      </div>

      <div className="flex gap-1.5">
        {[1, 2, 3].map((dayIndex, i) => {
          const active = sel.day === i;
          return (
            <div
              key={dayIndex}
              className={cn(
                "flex w-12 flex-col items-center rounded-2xl py-1.5 ring-1 transition-colors duration-300 motion-reduce:transition-none",
                active ? "bg-primary/10 ring-primary" : "ring-border",
              )}
            >
              <span className="text-[0.6rem] font-medium uppercase text-muted-foreground">
                {WEEKDAY_LABELS[dayIndex]}
              </span>
              <span className="text-sm font-semibold">
                {days[dayIndex]?.getDate()}
              </span>
              <span className="text-[0.6rem] text-muted-foreground">3 open</span>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <SlotGroup label="Morning" slots={MORNING} selected={sel.slot} />
        <SlotGroup label="Afternoon" slots={AFTERNOON} selected={sel.slot} />
      </div>

      <div
        className={cn(
          "flex h-8 items-center justify-center rounded-4xl text-xs font-medium transition-[background-color,color,transform] duration-300 motion-reduce:transition-none",
          sel.slot
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground",
          sent && "scale-[0.97]",
        )}
      >
        <span
          key={sent ? "sent" : (sel.slot ?? "none")}
          className="feature-line-in flex items-center gap-1.5"
        >
          {sent ? (
            <>
              <CheckIcon className="size-3.5" />
              Request sent
            </>
          ) : sel.slot ? (
            `Request ${sel.slot} ${sel.period}`
          ) : (
            "Pick a time"
          )}
        </span>
      </div>
    </div>
  );
}

function SlotGroup({
  label,
  slots,
  selected,
}: {
  label: string;
  slots: string[];
  selected: string | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.6rem] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="grid grid-cols-3 gap-1.5">
        {slots.map((slot) => {
          const active = slot === selected;
          return (
            <span
              key={slot}
              className={cn(
                "rounded-4xl py-1 text-center text-xs font-medium ring ring-border transition-colors duration-300 motion-reduce:transition-none",
                active
                  ? "bg-primary text-primary-foreground ring-primary"
                  : "bg-card text-foreground",
              )}
            >
              {slot}
            </span>
          );
        })}
      </div>
    </div>
  );
}
