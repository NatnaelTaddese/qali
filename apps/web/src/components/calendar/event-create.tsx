import { ArrowLeft01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { Button } from "@qali/ui/components/button";
import { WheelPicker } from "@qali/ui/components/motion/wheel-picker";
import { Textarea } from "@qali/ui/components/textarea";
import { cn } from "@qali/ui/lib/utils";
import { useAction, useQuery } from "convex/react";
import { format } from "date-fns";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { EventControls } from "./event-controls";
import { SNAP_MS } from "./lib";
import { dockVariants, dockVariantsReduced, press } from "./motion";

/** Wheel rows. Module-level so their identity is stable across renders — the
 * picker re-derives its geometry and index whenever `options` changes. */
const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTE_STEP = 5;
const MINUTES = Array.from({ length: 60 / MINUTE_STEP }, (_, i) =>
  String(i * MINUTE_STEP).padStart(2, "0"),
);
const MERIDIEM = ["AM", "PM"];

interface TimeParts {
  hour: string;
  minute: string;
  meridiem: string;
}

/** Split a timestamp into the wheel values. The minute is rounded onto the
 * wheel's step so an off-grid time can never fall through to row 0. */
function partsOf(ms: number): TimeParts {
  const d = new Date(ms);
  const minute = Math.min(
    Math.round(d.getMinutes() / MINUTE_STEP) * MINUTE_STEP,
    60 - MINUTE_STEP,
  );
  return {
    hour: format(d, "h"),
    minute: String(minute).padStart(2, "0"),
    meridiem: format(d, "a").toUpperCase(),
  };
}

/** Rebuild a timestamp from wheel values, keeping `baseMs`'s calendar day. */
function withParts(baseMs: number, parts: TimeParts): number {
  const h12 = Number(parts.hour) % 12;
  const hour = parts.meridiem === "PM" ? h12 + 12 : h12;
  const d = new Date(baseMs);
  d.setHours(hour, Number(parts.minute), 0, 0);
  return d.getTime();
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
  const calendars = useQuery(api.calendar.listCalendars) ?? [];
  const reduce = useReducedMotion();
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  // Marks the entry as a task rather than a plain event. Local for now — the
  // backend has no task field yet, so nothing is sent.
  const [task, setTask] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // All three default to "whatever the calendar says": no colour override, the
  // primary calendar (resolved server-side when unset), and inherited visibility.
  const [colorId, setColorId] = useState<string>();
  const [calendarId, setCalendarId] = useState<string>();
  const [isPrivate, setIsPrivate] = useState(false);
  // The description gets the whole panel rather than a field crammed under the
  // wheels: `main` is the time/title screen, `description` the drill-down.
  const [screen, setScreen] = useState<"main" | "description">("main");
  // One wheel group serves both ends of the range — six drums would never fit
  // the dock's width, so the segmented toggle picks which time they drive.
  const [editing, setEditing] = useState<"start" | "end">("start");
  // The drill-down keeps the panel exactly as tall as the screen it replaced,
  // so the dock stays put and only its contents cross-fade. Measured on the way
  // in, because the main screen's height varies (the validation line).
  const mainRef = useRef<HTMLFormElement>(null);
  const [mainHeight, setMainHeight] = useState<number>();

  const valid = endMs > startMs;
  // Until the user picks one, the event goes to the primary calendar — named
  // here too so the controls can preview its colour.
  const activeCalendarId =
    calendarId ?? calendars.find((c) => c.primary)?.googleCalendarId;
  const activeMs = editing === "start" ? startMs : endMs;
  const parts = partsOf(activeMs);

  const setPart = (key: keyof TimeParts, value: string) => {
    const next = withParts(activeMs, { ...parts, [key]: value });
    if (editing === "start") {
      // Drag the end along so the duration survives a later start.
      onChangeRange(next, Math.max(endMs, next + SNAP_MS));
    } else {
      onChangeRange(startMs, next);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    createEvent({
      summary: summary.trim() || "New event",
      startMs,
      endMs,
      description: description.trim() || undefined,
      calendarId: activeCalendarId,
      colorId,
      visibility: isPrivate ? "private" : undefined,
    })
      .then(onCreated)
      .catch((error: unknown) => {
        setSubmitting(false);
        toast.error("Couldn't create event", {
          description: error instanceof Error ? error.message : undefined,
        });
      });
  };

  // `custom` is the travel direction of the drill-down: the entering screen
  // declares its own, the exiting one reads it off the AnimatePresence.
  const variants = reduce ? dockVariantsReduced : dockVariants;

  return (
    <AnimatePresence
      mode="popLayout"
      initial={false}
      custom={screen === "description" ? 1 : -1}
    >
      {screen === "description" ? (
        <motion.div
          key="description"
          custom={1}
          variants={variants}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{ height: mainHeight }}
          className="flex flex-col gap-3"
        >
          <button
            type="button"
            onClick={() => setScreen("main")}
            className="-ml-1 flex items-center gap-1 self-start rounded-lg px-1 py-0.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              strokeWidth={2}
              className="size-4 text-muted-foreground"
            />
            {summary.trim() || "New event"}
          </button>

          <Textarea
            autoFocus
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add description"
            aria-label="Description"
            className="min-h-0 flex-1 border-transparent bg-transparent px-0 text-base focus-visible:border-transparent focus-visible:ring-0"
          />
        </motion.div>
      ) : (
        <motion.form
          key="main"
          ref={mainRef}
          custom={-1}
          variants={variants}
          initial="initial"
          animate="animate"
          exit="exit"
          onSubmit={submit}
          className="flex flex-col gap-3"
        >
        <div className="flex items-start gap-3">
          <button
            type="button"
            role="checkbox"
            aria-checked={task}
            aria-label="Mark as task"
            onClick={() => setTask((t) => !t)}
            className={cn(
              "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              task
                ? "border-primary bg-primary text-primary-foreground"
                : "border-muted-foreground/50 text-transparent hover:border-muted-foreground",
            )}
          >
            <HugeiconsIcon icon={Tick02Icon} strokeWidth={3} className="size-3" />
          </button>

          <div className="flex min-w-0 flex-1 flex-col">
            <input
              autoFocus
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="New event"
              aria-label="Title"
              className="w-full bg-transparent text-base font-semibold outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={() => {
                setMainHeight(mainRef.current?.offsetHeight);
                setScreen("description");
              }}
              className="-mx-1 truncate rounded px-1 text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {description.trim() || "Add description"}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex gap-1 rounded-xl bg-muted p-1">
            <TimeTab
              label="Starts"
              ms={startMs}
              active={editing === "start"}
              onSelect={() => setEditing("start")}
            />
            <TimeTab
              label="Ends"
              ms={endMs}
              active={editing === "end"}
              onSelect={() => setEditing("end")}
            />
          </div>

          <div className="flex gap-2">
            <WheelPicker
              options={HOURS}
              value={parts.hour}
              onValueChange={(v) => setPart("hour", v)}
              visibleCount={5}
              itemHeight={32}
              sound
              className="flex-1"
              aria-label="Hour"
            />
            <WheelPicker
              options={MINUTES}
              value={parts.minute}
              onValueChange={(v) => setPart("minute", v)}
              visibleCount={5}
              itemHeight={32}
              sound
              className="flex-1"
              aria-label="Minute"
            />
            <WheelPicker
              options={MERIDIEM}
              value={parts.meridiem}
              onValueChange={(v) => setPart("meridiem", v)}
              visibleCount={5}
              itemHeight={32}
              sound
              className="flex-1"
              aria-label="AM or PM"
            />
          </div>
        </div>

        {!valid && (
          <p className="text-xs text-destructive">End time must be after the start.</p>
        )}

        <div className="flex items-center justify-between gap-2">
          <EventControls
            calendars={calendars}
            colorId={colorId}
            onColorChange={setColorId}
            calendarId={activeCalendarId}
            onCalendarChange={setCalendarId}
            isPrivate={isPrivate}
            onPrivateChange={setIsPrivate}
          />
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!valid || submitting}>
              {submitting ? "Creating…" : "Create"}
            </Button>
          </div>
        </div>
        </motion.form>
      )}
    </AnimatePresence>
  );
}

/** One half of the segmented toggle: names the end of the range and reads out
 * its current value, so both times stay visible while one is being edited. */
function TimeTab({
  label,
  ms,
  active,
  onSelect,
}: {
  label: string;
  ms: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <motion.button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      {...press}
      className={cn(
        "flex flex-1 flex-col items-start rounded-lg px-3 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-background shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <span className="truncate text-xs font-medium text-muted-foreground">
        {label} · {format(ms, "EEE d")}
      </span>
      <span className={cn("text-sm font-semibold", active && "text-foreground")}>
        {format(ms, "h:mm a")}
      </span>
    </motion.button>
  );
}
