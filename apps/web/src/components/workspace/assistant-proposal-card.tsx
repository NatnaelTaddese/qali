import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import type { Doc } from "@qali/backend/convex/_generated/dataModel";
import { Button } from "@qali/ui/components/button";
import { Spinner } from "@qali/ui/components/spinner";
import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { revealTargetForAction } from "./assistant-interactions";
import { useDock } from "./dock-context";

export type AssistantAction = Doc<"assistantActions">;

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
  const confirmAction = useAction(api.assistant.confirmAction);
  const { reveal } = useDock();
  const [busy, setBusy] = useState<"confirm" | "discard" | null>(null);

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
      className="rounded-2xl border border-border bg-muted/50 px-3 py-2.5"
    >
      <p className="text-sm leading-5">{action.preview}</p>

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
