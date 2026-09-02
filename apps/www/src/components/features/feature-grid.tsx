import { cn } from "@qali/ui/lib/utils";
import { useId, type ReactNode } from "react";

import { AccountsScene } from "./accounts-scene";
import { AssistantScene } from "./assistant-scene";
import { BookingScene } from "./booking-scene";
import { useInViewOnce, useReducedMotion } from "./lib";
import { PaintScene } from "./paint-scene";
import { ProposalScene } from "./proposal-scene";
import { useVisible } from "./use-loop";

/**
 * The landing page's feature section: a hairline bento of five cells, each a
 * looping miniature of one part of the product with its heading and one line
 * of copy pinned to the bottom. Scenes only run while their cell is on screen
 * and motion is allowed; otherwise each rests on its richest frame.
 *
 * The grid is ten columns wide on `lg` (6+4 / 10 / 4+6), two on `sm`, one on
 * phones. Placement is explicit so DOM order (which is also the mobile order)
 * can differ from where a cell lands on the wide layout.
 */
export function FeatureGrid() {
  const title = useInViewOnce<HTMLHeadingElement>();

  return (
    <section className="relative bg-background px-6 pb-14 pt-10 sm:pb-20 sm:pt-14">
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 text-center">
        <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground ring ring-black/10">
          Your week, on autopilot
        </span>
        <h2
          ref={title.ref}
          className={cn(
            "chroma-text font-display text-3xl font-medium tracking-tight text-balance pb-[0.12em] -mb-[0.12em] sm:text-5xl",
            title.inView && "chroma-text-reveal",
          )}
        >
          Everything a calendar should do
        </h2>
        <p className="max-w-lg text-lg text-muted-foreground text-balance">
          Ask for changes in plain words, share one link to get booked, and
          keep every account in one place.
        </p>
      </div>

      <div className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-px overflow-hidden rounded-3xl bg-border ring-1 ring-border sm:grid-cols-2 lg:grid-cols-10">
        <FeatureCell
          title="Just tell it what you need"
          blurb="Qali reads your whole week and makes the change for you."
          interactive
          className="sm:col-span-2 lg:col-span-6 lg:col-start-1 lg:row-start-1"
        >
          {(playing) => <AssistantScene playing={playing} />}
        </FeatureCell>

        <FeatureCell
          title="Nothing changes without a yes"
          blurb="Every edit arrives as a proposal you confirm before it touches Google Calendar."
          className="lg:col-span-4 lg:col-start-7 lg:row-start-1"
        >
          {(playing) => <ProposalScene playing={playing} />}
        </FeatureCell>

        <FeatureCell
          title="Every Google account, one calendar"
          blurb="Link work and personal accounts and see them side by side."
          className="lg:col-span-4 lg:col-start-1 lg:row-start-3"
        >
          {(playing) => <AccountsScene playing={playing} />}
        </FeatureCell>

        <FeatureCell
          title="Paint when you're free"
          blurb="Draw availability straight onto the grid for the days that need it."
          className="sm:col-span-2 lg:col-span-10 lg:col-start-1 lg:row-start-2"
        >
          {(playing) => <PaintScene playing={playing} />}
        </FeatureCell>

        <FeatureCell
          title="Share a link, get booked"
          blurb="Guests pick a slot in their own time zone and the request lands in your inbox."
          className="sm:col-span-2 lg:col-span-6 lg:col-start-5 lg:row-start-3"
        >
          {(playing) => <BookingScene playing={playing} />}
        </FeatureCell>
      </div>
    </section>
  );
}

function FeatureCell({
  title,
  blurb,
  className,
  interactive = false,
  children,
}: {
  title: string;
  blurb: string;
  className?: string;
  /** The scene has real controls; keep it in the accessibility tree. */
  interactive?: boolean;
  children: (playing: boolean) => ReactNode;
}) {
  const id = useId();
  const { ref, visible } = useVisible<HTMLDivElement>();
  const reduce = useReducedMotion();
  const playing = visible && !reduce;

  return (
    <article
      aria-labelledby={id}
      className={cn("flex h-full flex-col bg-card", className)}
    >
      <div
        ref={ref}
        aria-hidden={interactive ? undefined : true}
        className="relative flex min-h-40 flex-1 items-center justify-center overflow-hidden px-4 pt-5 pb-3 select-none sm:px-6 sm:pt-6 sm:pb-4"
      >
        {children(playing)}
      </div>
      <div className="mt-auto px-4 pb-5 sm:px-6 sm:pb-6">
        <h3
          id={id}
          className="font-heading text-lg font-medium tracking-tight sm:text-xl"
        >
          {title}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>
      </div>
    </article>
  );
}
