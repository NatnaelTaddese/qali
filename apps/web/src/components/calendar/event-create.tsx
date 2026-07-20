import { api } from "@qali/backend/convex/_generated/api";
import { Button } from "@qali/ui/components/button";
import { Input } from "@qali/ui/components/input";
import { useAction } from "convex/react";
import { format } from "date-fns";
import { useState } from "react";
import { toast } from "sonner";

import { SNAP_MS } from "./lib";

function timeValue(ms: number): string {
  return format(ms, "HH:mm");
}

/** Rebuild a timestamp from an `<input type="time">` value, keeping its day. */
function withTime(baseMs: number, value: string): number | null {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const d = new Date(baseMs);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function EventCreate({
  startMs,
  endMs,
  onChangeRange,
  onCancel,
  onCreated,
}: {
  startMs: number;
  endMs: number;
  /** Lifts edited times back to the dock so the ghost on the grid follows along. */
  onChangeRange: (startMs: number, endMs: number) => void;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const createEvent = useAction(api.calendar.createEvent);
  const [summary, setSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const valid = endMs > startMs;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    createEvent({ summary: summary.trim() || "New event", startMs, endMs })
      .then(onCreated)
      .catch((error: unknown) => {
        setSubmitting(false);
        toast.error("Couldn't create event", {
          description: error instanceof Error ? error.message : undefined,
        });
      });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">New event</p>
        <p className="text-xs text-muted-foreground">{format(startMs, "EEE d MMM")}</p>
      </div>

      <Input
        autoFocus
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder="Add a title"
        aria-label="Title"
      />

      <div className="flex items-end gap-2">
        <Field label="Starts">
          <Input
            type="time"
            value={timeValue(startMs)}
            onChange={(e) => {
              const next = withTime(startMs, e.target.value);
              // Drag the end along so the duration survives an earlier start.
              if (next !== null) onChangeRange(next, Math.max(endMs, next + SNAP_MS));
            }}
          />
        </Field>
        <Field label="Ends">
          <Input
            type="time"
            value={timeValue(endMs)}
            onChange={(e) => {
              const next = withTime(endMs, e.target.value);
              if (next !== null) onChangeRange(startMs, next);
            }}
          />
        </Field>
      </div>

      {!valid && (
        <p className="text-xs text-destructive">End time must be after the start.</p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!valid || submitting}>
          {submitting ? "Creating…" : "Create"}
        </Button>
      </div>
    </form>
  );
}
