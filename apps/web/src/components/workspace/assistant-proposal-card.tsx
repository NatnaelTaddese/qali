import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import type { Doc, Id } from "@qali/backend/convex/_generated/dataModel";
import { Button } from "@qali/ui/components/button";
import { Spinner } from "@qali/ui/components/spinner";
import { useAction, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useEventColor } from "../calendar/colors";
import { revealTargetForAction } from "./assistant-interactions";
import { useDock } from "./dock-context";

export type AssistantAction = Doc<"assistantActions">;

/** The Convex event id a proposal acts on, when it targets an existing event
 * (update / move / delete). create_event has no id yet, so it returns null and
 * the card falls back to the neutral accent. */
function targetEventId(action: AssistantAction): Id<"events"> | null {
  const input = parsedInput(action);
  if (input && "eventId" in input) {
    const id = input.eventId;
    if (typeof id === "string") return id as Id<"events">;
  }
  return null;
}

function parsedInput(action: AssistantAction): Record<string, unknown> | null {
  try {
    const input: unknown = JSON.parse(action.input);
    return input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The parts of a proposal the one-line preview can't carry in full. The
 * preview clips long descriptions and locations, and a guest list has to be
 * read address by address — the confirm button approves every one of them,
 * and Google emails each the moment it's pressed. Everything the model put in
 * the proposal is shown here verbatim, so nothing a stranger slipped into a
 * booking note or an event title can ride through unseen.
 */
function proposalDetails(
  action: AssistantAction,
): { label: string; value: string }[] {
  const input = parsedInput(action);
  if (!input) return [];
  const rows: { label: string; value: string }[] = [];
  const guests = input.guestEmails;
  if (Array.isArray(guests) && guests.length > 0) {
    rows.push({
      label: `Guests (${guests.length})`,
      value: guests.filter((g) => typeof g === "string").join("\n"),
    });
  }
  if (typeof input.description === "string" && input.description) {
    rows.push({ label: "Description", value: input.description });
  }
  if (typeof input.location === "string" && input.location) {
    rows.push({ label: "Location", value: input.location });
  }
  return rows;
}

function ProposalDetails({ action }: { action: AssistantAction }) {
  const rows = proposalDetails(action);
  if (rows.length === 0) return null;
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        Details
      </summary>
      <dl className="mt-1.5 flex flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="font-medium text-muted-foreground">{row.label}</dt>
            <dd className="max-h-40 overflow-y-auto break-words whitespace-pre-wrap">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * The gate between the assistant and the user's calendar.
 *
 * Every write the assistant wants to make stops here. `preview` is written on
 * the server at propose time, so what the user reads is the change itself
 * rather than a re-description of it assembled in the browser — the button and
 * the sentence above it can't drift apart.
 *
 * The card renders from the live `assistantActions` row, so once a decision is
 * made this becomes the record of it without any local state to keep in sync.
 */
export function AssistantProposalCard({ action }: { action: AssistantAction }) {
  const confirmAction = useAction(api.domains.assistant.loop.confirmAction);
  const { reveal } = useDock();
  const [busy, setBusy] = useState<"confirm" | "discard" | null>(null);

  // Tint the card to the event it touches, so a proposal reads as a preview of
  // that card on the grid. Existing events resolve through the same color logic
  // the calendar uses; a create (or an id we can't load yet) stays neutral.
  const eventId = targetEventId(action);
  const targetEvent = useQuery(
    api.domains.calendar.queries.getEventById,
    eventId ? { eventId } : "skip",
  );
  const colorFor = useEventColor();
  const colorVar = targetEvent ? colorFor(targetEvent) : "--event-neutral";

  // When the change lands, reach for what it touched on the grid. Only on the
  // fresh pending→applied transition, so reopening a thread with an already-
  // applied proposal doesn't yank the calendar. The event may still be syncing
  // back from Google — the scroll uses the proposal's own start time, and the
  // pulse plays when the synced card mounts.
  const prevStatusRef = useRef(action.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = action.status;
    if (action.status !== "applied" || prev === "applied") return;
    const target = revealTargetForAction(action);
    if (target) reveal(target);
  }, [action, reveal]);

  const decide = async (decision: "confirm" | "discard") => {
    if (busy) return;
    setBusy(decision);
    try {
      await confirmAction({ actionId: action._id, decision });
    } catch (error: unknown) {
      toast.error(
        decision === "confirm"
          ? "Couldn't make that change"
          : "Couldn't discard that",
        { description: error instanceof Error ? error.message : undefined },
      );
    } finally {
      setBusy(null);
    }
  };

  const pending = action.status === "pending";
  const applying =
    action.status === "applying" ||
    (action.status === "pending" && busy !== null);

  return (
    <article
      aria-label="Proposed calendar change"
      className="relative overflow-hidden rounded-lg py-2.5 pr-3 pl-4 shadow-sm ring-1 ring-border/60 inset-ring inset-ring-black/10 dark:inset-ring-white/10"
      style={{
        backgroundColor: `color-mix(in oklab, var(${colorVar}) 22%, var(--card))`,
      }}
    >
      <span
        aria-hidden
        className="absolute top-1.5 bottom-1.5 left-1.5 w-[3px] rounded-full"
        style={{ backgroundColor: `var(${colorVar})` }}
      />
      <p className="text-sm leading-5">{action.preview}</p>
      {pending && <ProposalDetails action={action} />}

      {pending && !applying && (
        <div
          role="group"
          aria-label="Proposal controls"
          className="mt-2.5 flex items-center gap-1.5"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="flex-1"
            aria-label="Discard proposed change"
            onClick={() => decide("discard")}
          >
            Discard
          </Button>
          <Button
            type="button"
            size="sm"
            className="flex-1"
            aria-label="Confirm proposed change"
            onClick={() => decide("confirm")}
          >
            Confirm
          </Button>
        </div>
      )}

      {applying && (
        <p
          role="status"
          aria-live="polite"
          className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Spinner className="size-3.5" />
          {busy === "discard" ? "Discarding proposal…" : "Making the change…"}
        </p>
      )}

      {action.status === "applied" && (
        <p
          role="status"
          className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            strokeWidth={2}
            className="size-3.5 shrink-0"
          />
          {action.resultSummary ?? "Done."}
        </p>
      )}

      {action.status === "rejected" && (
        <p
          role="status"
          className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <HugeiconsIcon
            icon={Cancel01Icon}
            strokeWidth={2}
            className="size-3.5 shrink-0"
          />
          Discarded.
        </p>
      )}

      {action.status === "failed" && (
        <p
          role="alert"
          className="mt-2 flex items-start gap-1.5 text-xs text-destructive"
        >
          <HugeiconsIcon
            icon={Alert02Icon}
            strokeWidth={2}
            className="size-3.5 shrink-0 translate-y-px"
          />
          <span>{action.resultSummary ?? "That didn't work."}</span>
        </p>
      )}
    </article>
  );
}
