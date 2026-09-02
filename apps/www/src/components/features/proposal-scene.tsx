import { cn } from "@qali/ui/lib/utils";

import { CheckIcon, MascotSpark, ThinkingDots } from "./parts";
import { useLoop } from "./use-loop";

/**
 * The proposal card: the gate between the assistant and the calendar. Built
 * like the app's `AssistantProposalCard` — tinted to the event it touches,
 * accent bar, the change spelled out, then Discard / Confirm — and looped
 * through pending → pressed → applying → applied.
 */
const STEPS = [2600, 400, 1000, 2600] as const;

export function ProposalScene({ playing }: { playing: boolean }) {
  const { step } = useLoop(STEPS, playing);
  const pending = step === 0;
  const pressed = step === 1;
  const applying = step === 2;
  const applied = step === 3;
  const controlsShown = pending || pressed;

  return (
    <div className="flex w-full max-w-xs flex-col gap-2.5">
      <p className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-primary px-3 py-1.5 text-xs leading-5 text-primary-foreground">
        Move design review to Thursday at 3
      </p>

      <div className="flex items-start gap-2">
        <MascotSpark className="mt-2 size-4 text-foreground" eye="var(--card)" />
        <div
          className="relative flex-1 overflow-hidden rounded-lg py-2.5 pr-3 pl-4 shadow-sm ring-1 ring-border/60 inset-ring inset-ring-black/10 dark:inset-ring-white/10"
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--event-6) 22%, var(--card))",
          }}
        >
          <span
            aria-hidden
            className="absolute top-1.5 bottom-1.5 left-1.5 w-[3px] rounded-full"
            style={{ backgroundColor: "var(--event-6)" }}
          />
          <p className="text-xs leading-5 sm:text-sm">
            Move <span className="font-medium">Design review</span> to Thu,
            3:00 – 4:00 PM
          </p>

          <div
            className={cn(
              "flex items-center gap-1.5 overflow-hidden transition-[height,margin,opacity] duration-500 ease-out motion-reduce:transition-none",
              controlsShown ? "mt-2.5 h-7 opacity-100" : "mt-0 h-0 opacity-0",
            )}
          >
            <span className="flex-1 rounded-4xl py-1 text-center text-xs font-medium text-muted-foreground">
              Discard
            </span>
            <span
              className={cn(
                "flex-1 rounded-4xl bg-primary py-1 text-center text-xs font-medium text-primary-foreground transition-transform duration-200 motion-reduce:transition-none",
                pressed && "scale-95",
              )}
            >
              Confirm
            </span>
          </div>

          <div
            className={cn(
              "overflow-hidden transition-[height,margin,opacity] duration-500 ease-out motion-reduce:transition-none",
              applying || applied ? "mt-2 h-5 opacity-100" : "mt-0 h-0 opacity-0",
            )}
          >
            <p
              key={applied ? "applied" : "applying"}
              className="feature-line-in flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              {applied ? (
                <>
                  <CheckIcon className="size-3.5" />
                  Moved Design review to 3:00 PM
                </>
              ) : (
                <>
                  Making the change…
                  <ThinkingDots />
                </>
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
