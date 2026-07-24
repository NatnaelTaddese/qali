import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { Button } from "@qali/ui/components/button";
import { useAction } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";

import { FreeBusyToggle } from "./free-busy-toggle";
import type { CalendarEvent } from "./lib";
import { RichTextEditor } from "./rich-text/rich-text-editor";

/** Edit an existing event's title and description. Patches Google via the
 * `updateEvent` action, then hands back to the caller (which reopens the detail
 * view; the optimistic upsert and next sync refresh the row). */
export function EventEdit({
  event,
  onCancel,
  onSaved,
}: {
  event: CalendarEvent;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const updateEvent = useAction(api.calendar.updateEvent);
  const [summary, setSummary] = useState(event.summary ?? "");
  const [description, setDescription] = useState(event.description ?? "");
  // Google defaults an unset transparency to busy, so only "transparent" is free.
  const [busy, setBusy] = useState(event.transparency !== "transparent");
  const [saving, setSaving] = useState(false);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    updateEvent({
      eventId: event._id,
      summary: summary.trim() || "(No title)",
      // Empty string clears the description on Google's side.
      description,
      // Explicit value: a patch only sends fields present, so send both states
      // so switching back to Busy actually patches Google.
      transparency: busy ? "opaque" : "transparent",
    })
      .then(onSaved)
      .catch((error: unknown) => {
        setSaving(false);
        toast.error("Couldn't save event", {
          description: error instanceof Error ? error.message : undefined,
        });
      });
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onCancel}
        className="-ml-1 flex items-center gap-1 self-start rounded-lg px-1 py-0.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <HugeiconsIcon
          icon={ArrowLeft01Icon}
          strokeWidth={2}
          className="size-4 text-muted-foreground"
        />
        Edit event
      </button>

      <div className="flex items-center gap-3">
        <input
          autoFocus
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Title"
          aria-label="Title"
          className="min-w-0 flex-1 bg-transparent text-base font-semibold outline-none placeholder:text-muted-foreground"
        />
        <div className="shrink-0">
          <FreeBusyToggle busy={busy} onChange={setBusy} />
        </div>
      </div>

      <RichTextEditor
        value={description}
        onChange={setDescription}
        placeholder="Add description"
      />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
