import { Button } from "@qali/ui/components/button";
import { cn } from "@qali/ui/lib/utils";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_auth/login")({
  component: LoginComponent,
});

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
      />
    </svg>
  );
}

// Grid cell size — must match the background-image `backgroundSize` below. The
// vertical lines are anchored to screen center (50vw), so a two-column card
// centered on screen lands exactly on the lines that bracket the center.
const COL = 200; // px, one "day" column
const ROW = 64; // px, one "hour" row
const CELL_GAP = 4; // px inset so a ghost sits inside its cell, not on the lines

/** Faint, non-interactive events snapped to the calendar grid behind the login
 * card, so the sign-in screen previews the calendar it gates. Each reuses the
 * real event-card recipe (tinted fill + left accent pill) at reduced opacity.
 * Positions are in grid units: `col` is the column offset from screen center
 * (negative = left), `row` is the row from the top; spans are cell counts. */
const GHOST_EVENTS: {
  hue: string;
  title: string;
  time: string;
  col: number;
  colSpan: number;
  row: number;
  rowSpan: number;
}[] = [
  { hue: "--event-4", title: "Standup", time: "9:00 – 9:15 AM", col: -1, colSpan: 1, row: 1, rowSpan: 1 },
  { hue: "--event-6", title: "Deep work", time: "10:00 – 12:00 PM", col: -3, colSpan: 1, row: 5, rowSpan: 2 },
  { hue: "--event-5", title: "1:1", time: "4:00 – 4:30 PM", col: -2, colSpan: 1, row: 10, rowSpan: 1 },
  { hue: "--event-8", title: "Lunch", time: "12:30 – 1:30 PM", col: 2, colSpan: 1, row: 2, rowSpan: 1 },
  { hue: "--event-2", title: "Design review", time: "2:00 – 3:00 PM", col: 2, colSpan: 1, row: 7, rowSpan: 2 },
];

function GhostEvent({
  hue,
  title,
  time,
  col,
  colSpan,
  row,
  rowSpan,
}: (typeof GHOST_EVENTS)[number]) {
  return (
    <div
      className="absolute hidden overflow-hidden rounded-lg opacity-55 shadow-sm ring-1 ring-border/60 inset-ring inset-ring-black/10 sm:block dark:inset-ring-white/10"
      style={{
        left: `calc(50vw + ${col * COL + CELL_GAP}px)`,
        top: row * ROW + CELL_GAP,
        width: colSpan * COL - 2 * CELL_GAP,
        height: rowSpan * ROW - 2 * CELL_GAP,
        backgroundColor: `color-mix(in oklab, var(${hue}) 22%, var(--card))`,
      }}
    >
      <span
        className="absolute top-1 bottom-1 left-1 w-[3px] rounded-full"
        style={{ backgroundColor: `var(${hue})` }}
      />
      <div className="flex h-full flex-col justify-start py-1 pr-2 pl-3">
        <p className="text-sm font-medium leading-tight">{title}</p>
        <p className="truncate text-xs leading-tight text-muted-foreground">
          {time}
        </p>
      </div>
    </div>
  );
}

function LoginComponent() {
  const [isLoading, setIsLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    await authClient.signIn.social(
      {
        provider: "google",
        callbackURL: "/",
        errorCallbackURL: "/login",
      },
      {
        onError: (error) => {
          setIsLoading(false);
          toast.error(error.error.message || error.error.statusText);
        },
      },
    );
  };

  return (
    <div className="relative min-h-svh overflow-hidden bg-background">
      {/* Calendar time grid: horizontal hour lines + vertical day dividers,
          matching the real calendar's line color, fading toward the edges. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(to bottom, color-mix(in oklab, var(--border) 55%, transparent) 0 1px, transparent 1px)," +
            "linear-gradient(to right, color-mix(in oklab, var(--border) 55%, transparent) 0 1px, transparent 1px)",
          backgroundSize: "100% 64px, 200px 100%",
          // Hour lines run from the top; day lines are anchored to screen
          // center so a two-column card centered on screen lands on the grid.
          backgroundPosition: "0 0, 50vw 0",
          maskImage:
            "radial-gradient(120% 100% at 50% 45%, black 35%, transparent 92%)",
          WebkitMaskImage:
            "radial-gradient(120% 100% at 50% 45%, black 35%, transparent 92%)",
        }}
      />
      {/* Faint sample events sitting on the grid, behind the card. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {GHOST_EVENTS.map((ghost) => (
          <GhostEvent key={ghost.title} {...ghost} />
        ))}
      </div>

      <div className="relative z-10 flex min-h-svh items-center justify-center px-4">
        <div
          className={cn(
            "relative w-full max-w-[400px] overflow-hidden rounded-xl shadow-lg",
            "ring-1 ring-border/60 inset-ring inset-ring-black/10 dark:inset-ring-white/10",
          )}
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--event-6) 22%, var(--card))",
          }}
        >
          <span
            aria-hidden
            className="absolute top-2 bottom-2 left-2 w-[3px] rounded-full"
            style={{ backgroundColor: "var(--event-6)" }}
          />
          <div className="flex flex-col gap-10 pt-6 pr-5 pb-5 pl-6">
            <div>
              <p className="font-display text-2xl font-bold leading-tight">
                Welcome to Qali
              </p>
              <p className="text-xs leading-tight text-muted-foreground">
                Sign in with Google to continue
              </p>
            </div>
            <Button
              variant="default"
              size="lg"
              className="w-full rounded-xl"
              disabled={isLoading}
              onClick={handleGoogleSignIn}
            >
              <GoogleIcon />
              {isLoading ? "Redirecting…" : "Continue with Google"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
