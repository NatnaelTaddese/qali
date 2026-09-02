import { cn } from "@qali/ui/lib/utils";

import { GoogleMark } from "./parts";
import { useLoop } from "./use-loop";

/**
 * Two Google accounts in one calendar. The cards mirror the settings panel's
 * connection cards (identity band, Primary badge, sync toggle); the strip of
 * chips below is the merged week. The loop unlinks the second account, offers
 * to link it, and brings it — and its events — back.
 */
const STEPS = [2800, 900, 500, 2000] as const;

interface Chip {
  title: string;
  tint: string;
  account: 1 | 2;
}

const CHIPS: Chip[] = [
  { title: "Standup", tint: "--event-2", account: 1 },
  { title: "Dentist", tint: "--event-6", account: 2 },
  { title: "1:1 Sam", tint: "--event-2", account: 1 },
  { title: "Gym", tint: "--event-6", account: 2 },
  { title: "Roadmap", tint: "--event-2", account: 1 },
];

export function AccountsScene({ playing }: { playing: boolean }) {
  const { step } = useLoop(STEPS, playing);
  const linked = step === 0 || step === 3;
  const offering = step === 1 || step === 2;
  const pressed = step === 2;

  return (
    <div className="flex w-full max-w-xs flex-col gap-2">
      <AccountCard
        name="Nat Taddese"
        email="nat@myqali.com"
        tint="--event-2"
        primary
      />

      <div className="relative">
        <AccountCard
          name="Nat"
          email="nat.t@gmail.com"
          tint="--event-6"
          className={cn(
            "transition-[transform,opacity] duration-500 ease-out motion-reduce:transition-none",
            linked ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
          )}
        />
        <div
          className={cn(
            "absolute inset-0 flex items-center justify-center transition-opacity duration-300 motion-reduce:transition-none",
            offering ? "opacity-100" : "opacity-0",
          )}
        >
          <span
            className={cn(
              "rounded-4xl bg-background px-3 py-1.5 text-xs font-medium shadow-sm ring ring-black/10 transition-transform duration-200 motion-reduce:transition-none",
              pressed && "scale-95",
            )}
          >
            + Link another account
          </span>
        </div>
      </div>

      <div className="mt-1 flex gap-1">
        {CHIPS.map((chip, i) => {
          const hidden = chip.account === 2 && !linked;
          return (
            <span
              key={chip.title}
              className={cn(
                "h-6 flex-1 truncate rounded-md border-l-[3px] px-1.5 text-[0.6rem] leading-6 font-medium text-foreground transition-[transform,opacity] duration-500 ease-out motion-reduce:transition-none",
                hidden ? "scale-90 opacity-0" : "scale-100 opacity-100",
              )}
              style={{
                backgroundColor: `color-mix(in oklab, var(${chip.tint}) 22%, var(--card))`,
                borderLeftColor: `var(${chip.tint})`,
                transitionDelay: linked && chip.account === 2 ? `${i * 90}ms` : "0ms",
              }}
            >
              {chip.title}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function AccountCard({
  name,
  email,
  tint,
  primary = false,
  className,
}: {
  name: string;
  email: string;
  tint: string;
  primary?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-2xl bg-muted/60 px-3 py-2 ring-1 ring-border",
        className,
      )}
    >
      <span className="relative shrink-0">
        <span
          className="flex size-8 items-center justify-center rounded-full text-xs font-semibold text-foreground"
          style={{
            backgroundColor: `color-mix(in oklab, var(${tint}) 45%, var(--card))`,
          }}
        >
          {name.charAt(0)}
        </span>
        <span className="absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full bg-card text-foreground ring-1 ring-border">
          <GoogleMark className="size-2" />
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <span className="truncate">{name}</span>
          {primary && (
            <span className="shrink-0 text-[0.6rem] font-medium text-link">
              Primary
            </span>
          )}
        </p>
        <p className="truncate text-[0.7rem] text-muted-foreground">{email}</p>
      </div>
      <span
        aria-hidden
        className="relative h-4 w-7 shrink-0 rounded-full bg-primary"
      >
        <span className="absolute top-0.5 left-0.5 size-3 translate-x-3 rounded-full bg-primary-foreground" />
      </span>
    </div>
  );
}
