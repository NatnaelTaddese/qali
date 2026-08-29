import {
  ArrowLeft01Icon,
  Calendar03Icon,
  Location01Icon,
  RepeatIcon,
  SquareLock01Icon,
  SquareUnlock01Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { Id } from "@qali/backend/convex/_generated/dataModel";
import type { EventCapabilities } from "@qali/domain/permissions";
import { WheelPicker } from "@qali/ui/components/motion/wheel-picker";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@qali/ui/components/tooltip";
import { cn } from "@qali/ui/lib/utils";
import { format, startOfDay } from "date-fns";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRef, useState, type ReactNode } from "react";

import { DayPicker } from "./day-picker";
import { EventControls } from "./event-controls";
import { FreeBusyToggle } from "./free-busy-toggle";
import { GuestPicker, type Guest } from "./guest-picker";
import { GoogleMeetIcon } from "./google-meet-icon";
import { usePreferences } from "@/components/workspace/preferences-context";
import {
  type CalendarEvent,
  type CalendarListItem,
  MS_PER_DAY,
  SNAP_MS,
  timePattern,
} from "./lib";
import {
  dockVariants,
  dockVariantsReduced,
  press,
  SPRING_DOCK,
} from "./motion";
import { RepeatControl } from "./repeat-control";
import { RichTextEditor } from "./rich-text/rich-text-editor";
import { RichTextView } from "./rich-text/rich-text-view";
import { htmlToPreviewText } from "./rich-text/text";
import type { Recurrence } from "./rrule";

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

/** Move `baseMs` onto `dayMs`'s calendar day, keeping its time of day. */
function withDay(baseMs: number, dayMs: number): number {
  const day = new Date(dayMs);
  const d = new Date(baseMs);
  d.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
  return d.getTime();
}

/** UTC midnight of a timestamp's local calendar day — the instant Google's
 * all-day date strings map to (see mapGoogleEvent / toGoogleTime on the
 * backend). All-day events are stored and sent as these UTC-midnight instants. */
function toUtcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The inverse: a local-time instant on the same calendar date, so the day
 * pickers show the day Google meant. Noon, so no DST shift can tip it into a
 * neighbouring day. */
function fromUtcMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    12,
  ).getTime();
}

/** Everything the form edits. Times are always *working* values — local and
 * timed even for an all-day event — so the editors and the grid ghost keep
 * working; `toEventTimes` converts them at submit. */
export interface EventFormValue {
  summary: string;
  /** HTML, in the subset Google keeps. */
  description: string;
  location: string;
  /** Whether the event has (or should get) a Google Meet. The "Where" row is a
   * switch: `false` shows the location input, `true` swaps it for the Meet chip.
   * On create this is the intent to mint a link; on edit it toggles one on/off. */
  meet: boolean;
  /** An already-minted conference URL, for display. Only set on an existing
   * event. */
  conferenceUrl?: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  isPrivate: boolean;
  /** Whether the event blocks the user's time. */
  busy: boolean;
  color?: string;
  /** Local calendar identity used for create targeting. */
  calendarId?: Id<"calendars">;
  guests: Guest[];
  /** null = does not repeat. */
  recurrence: Recurrence | null;
}

export function isEventFormValid(value: EventFormValue): boolean {
  return value.endMs > value.startMs;
}

/** The instants to send to Google. All-day events are date-only: UTC midnight
 * of the first day, and the exclusive UTC midnight *after* the last one. */
export function toEventTimes(value: EventFormValue): {
  startMs: number;
  endMs: number;
} {
  if (!value.allDay) {
    return { startMs: value.startMs, endMs: value.endMs };
  }
  return {
    startMs: toUtcMidnight(value.startMs),
    endMs: toUtcMidnight(value.endMs) + MS_PER_DAY,
  };
}

/** Seed the form from a synced event. Undoes the all-day conversion above, so
 * the end tab shows the last day of the event rather than the exclusive one
 * after it. */
export function formValueFromEvent(event: CalendarEvent): EventFormValue {
  return {
    summary: event.summary ?? "",
    description: event.description ?? "",
    location: event.location ?? "",
    meet: event.conferenceType === "hangoutsMeet",
    conferenceUrl: event.conferenceUrl,
    startMs: event.allDay ? fromUtcMidnight(event.startMs) : event.startMs,
    endMs: event.allDay
      ? fromUtcMidnight(event.endMs - MS_PER_DAY)
      : event.endMs,
    allDay: event.allDay,
    isPrivate: event.visibility === "private",
    // An unset busy means busy; only an explicit false is free.
    busy: event.busy !== false,
    color: event.color,
    calendarId: event.localCalendarId,
    guests: (event.attendees ?? []).map((a) => ({
      email: a.email,
      displayName: a.displayName,
      responseStatus: a.responseStatus,
      organizer: a.organizer,
    })),
    // We sync expanded instances, so an event never carries its own rule.
    // `canChangeRecurrence` is false whenever this matters.
    recurrence: null,
  };
}

export interface EventFormProps {
  value: EventFormValue;
  /** Patch any field but the times. */
  onChange: (patch: Partial<EventFormValue>) => void;
  /**
   * Report a time change. Separate from `onChange` because creating keeps the
   * range in the dock — that's what lets the ghost on the grid follow the
   * wheels live — while editing keeps it in local state.
   */
  onChangeRange: (startMs: number, endMs: number) => void;
  onSubmit: (event: React.FormEvent) => void;
  capabilities: EventCapabilities;
  calendars: CalendarListItem[];
  /** Rendered above the title row; editing puts its back button here. */
  header?: ReactNode;
  /** The bottom-right button cluster. */
  footer: ReactNode;
  /** A muted line above the footer, e.g. the recurring-instance warning. */
  notice?: ReactNode;
  /** Moving an event between calendars needs Google's `move` endpoint, which we
   * don't implement — so editing shows the calendar without offering to change
   * it, and only creating passes this. */
  canChangeCalendar?: boolean;
  titlePlaceholder?: string;
  autoFocusTitle?: boolean;
}

/**
 * The event editor, shared by the create and edit panels.
 *
 * It owns both screens — the main form and the description drill-down — rather
 * than just the fields, because the measured-height cross-fade between them is
 * subtle enough that two copies would drift apart.
 *
 * Nothing here is stateful except which end of the range is being edited and
 * which screen is showing; the value lives with the caller.
 */
export function EventForm({
  value,
  onChange,
  onChangeRange,
  onSubmit,
  capabilities,
  calendars,
  header,
  footer,
  notice,
  canChangeCalendar = false,
  titlePlaceholder = "New event",
  autoFocusTitle = false,
}: EventFormProps) {
  const reduce = useReducedMotion();
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

  const { canEdit } = capabilities;
  const valid = isEventFormValid(value);
  const activeMs = editing === "start" ? value.startMs : value.endMs;
  const parts = partsOf(activeMs);

  const setPart = (key: keyof TimeParts, part: string) => {
    const next = withParts(activeMs, { ...parts, [key]: part });
    if (editing === "start") {
      // Drag the end along so the duration survives a later start.
      onChangeRange(next, Math.max(value.endMs, next + SNAP_MS));
    } else {
      onChangeRange(value.startMs, next);
    }
  };

  // Move the active side onto a chosen day, keeping its time of day. The end can
  // never land before the start; the start drags the end along to hold duration.
  const setDay = (dayMs: number) => {
    const next = withDay(activeMs, dayMs);
    if (editing === "start") {
      onChangeRange(next, Math.max(value.endMs, next + SNAP_MS));
    } else {
      onChangeRange(value.startMs, Math.max(next, value.startMs + SNAP_MS));
    }
  };

  // `custom` is the travel direction of the drill-down: the entering screen
  // declares its own, the exiting one reads it off the AnimatePresence.
  const variants = reduce ? dockVariantsReduced : dockVariants;
  const dayLabel = format(activeMs, "EEE, MMM d, yyyy");

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
            {value.summary.trim() || titlePlaceholder}
          </button>

          {canEdit ? (
            <RichTextEditor
              autoFocus
              value={value.description}
              onChange={(description) => onChange({ description })}
              placeholder="Add description"
              className="min-h-0 flex-1"
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto text-sm">
              {value.description ? (
                <RichTextView html={value.description} />
              ) : (
                <p className="text-muted-foreground">No description</p>
              )}
            </div>
          )}
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
          onSubmit={onSubmit}
          className="flex flex-col gap-3"
        >
          {header}

          <div className="flex items-start gap-3">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    role="switch"
                    aria-checked={value.isPrivate}
                    aria-label={value.isPrivate ? "Private" : "Visible to others"}
                    disabled={!canEdit}
                    onClick={() => onChange({ isPrivate: !value.isPrivate })}
                    className={cn(
                      "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      value.isPrivate
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      !canEdit && "opacity-50 hover:bg-transparent",
                    )}
                  />
                }
              >
                <HugeiconsIcon
                  icon={value.isPrivate ? SquareLock01Icon : SquareUnlock01Icon}
                  strokeWidth={2}
                  className="size-4.5"
                />
              </TooltipTrigger>
              <TooltipContent side="top">
                {value.isPrivate ? "Private" : "Visible to others"}
              </TooltipContent>
            </Tooltip>

            <div className="flex min-w-0 flex-1 flex-col">
              {/* readOnly rather than disabled: a title you can't change is
                  still a title you want to read and copy. */}
              <input
                autoFocus={autoFocusTitle}
                value={value.summary}
                readOnly={!canEdit}
                onChange={(e) => onChange({ summary: e.target.value })}
                placeholder={titlePlaceholder}
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
                {htmlToPreviewText(value.description) ||
                  (canEdit ? "Add description" : "No description")}
              </button>
            </div>
          </div>

          <div className="flex flex-col">
            <div className="flex flex-col gap-2">
              <div className="flex gap-1 rounded-xl bg-muted p-1">
                <TimeTab
                  label="Starts"
                  ms={value.startMs}
                  allDay={value.allDay}
                  active={editing === "start"}
                  onSelect={() => setEditing("start")}
                />
                <TimeTab
                  label="Ends"
                  ms={value.endMs}
                  allDay={value.allDay}
                  active={editing === "end"}
                  onSelect={() => setEditing("end")}
                />
              </div>

              <SettingRow
                icon={Calendar03Icon}
                label={editing === "start" ? "Starts on" : "Ends on"}
              >
                {canEdit ? (
                  <DayPicker
                    selectedMs={activeMs}
                    onSelect={setDay}
                    side="top"
                    minMs={
                      editing === "end"
                        ? startOfDay(value.startMs).getTime()
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      className="rounded-lg px-2 py-1 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {dayLabel}
                    </button>
                  </DayPicker>
                ) : (
                  // A plain span, not a disabled button: nothing should look
                  // pressable when there is nothing to press.
                  <span className="px-2 py-1 text-sm font-medium">
                    {dayLabel}
                  </span>
                )}
              </SettingRow>
            </div>

            <AnimatePresence initial={false}>
              {!value.allDay && (
                <motion.div
                  key="time-picker"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  transition={SPRING_DOCK}
                  className="overflow-hidden"
                >
                  <div className="flex gap-2 pt-2">
                    <WheelPicker
                      options={HOURS}
                      value={parts.hour}
                      onValueChange={(v) => setPart("hour", v)}
                      visibleCount={5}
                      itemHeight={32}
                      sound
                      disabled={!canEdit}
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
                      disabled={!canEdit}
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
                      disabled={!canEdit}
                      className="flex-1"
                      aria-label="AM or PM"
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <SettingRow icon={Sun03Icon} label="All day">
            <ToggleSwitch
              checked={value.allDay}
              disabled={!canEdit}
              onChange={(allDay) => onChange({ allDay })}
              label="All day"
            />
          </SettingRow>



          <SettingRow icon={RepeatIcon} label="Repeat">
            {capabilities.canChangeRecurrence ? (
              <RepeatControl
                startMs={value.startMs}
                value={value.recurrence}
                onChange={(recurrence) => onChange({ recurrence })}
              />
            ) : (
              <span className="px-2 py-1 text-sm text-muted-foreground">
                {/* We sync with singleEvents=true, so we hold an expanded
                    instance and never the rule that produced it. */}
                {value.recurrence === null && capabilities.canEdit
                  ? "Part of a repeating series"
                  : "Does not repeat"}
              </span>
            )}
            </SettingRow>

            <WhereRow
              location={value.location}
              meet={value.meet}
              conferenceUrl={value.conferenceUrl}
              canEdit={canEdit}
              onLocationChange={(location) => onChange({ location })}
              onMeetChange={(meet) => onChange({ meet })}
            />

          <GuestPicker
            value={value.guests}
            onChange={(guests) => onChange({ guests })}
            readOnly={!capabilities.canInviteOthers}
            readOnlyReason={capabilities.readOnlyReason}
            hidden={!capabilities.canSeeGuests}
          />

          {!valid && (
            <p className="text-xs text-destructive">
              End time must be after the start.
            </p>
          )}

            {notice}


          <div className="flex items-center justify-between gap-2 -mb-2">
            <div className="flex items-center gap-1 border-2 rounded-xl -ml-2">
              <EventControls
                calendars={calendars}
                color={value.color}
                onColorChange={(color) => onChange({ color })}
                calendarId={value.calendarId}
                onCalendarChange={(calendarId) => onChange({ calendarId })}
                disabled={!canEdit}
                canChangeCalendar={canChangeCalendar}
              />
              <FreeBusyToggle
                busy={value.busy}
                disabled={!canEdit}
                onChange={(busy) => onChange({ busy })}
              />
            </div>
            <div className="flex gap-2 -mr-2">{footer}</div>
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
  allDay,
  active,
  onSelect,
}: {
  label: string;
  ms: number;
  allDay: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  const { use24h } = usePreferences();
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
        {allDay ? "All day" : format(ms, timePattern(use24h))}
      </span>
    </motion.button>
  );
}

/** A labeled settings row: leading icon, label, and a right-aligned control. */
function SettingRow({
  icon,
  label,
  children,
}: {
  icon: IconSvgElement;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <HugeiconsIcon
        icon={icon}
        strokeWidth={2}
        className="size-4.5 shrink-0 text-muted-foreground"
      />
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="ml-auto flex min-w-0 items-center">{children}</div>
    </div>
  );
}

/** The "where" of the event: a physical location *or* a video call, on one line
 * instead of two rows. A caller adding a Meet isn't usually also typing an
 * address, so the two are mutually exclusive modes of the same row — the switch
 * follows the leading icon and flips the trailing control between the location
 * input and the Google Meet chip. */
function WhereRow({
  location,
  meet,
  conferenceUrl,
  canEdit,
  onLocationChange,
  onMeetChange,
}: {
  location: string;
  meet: boolean;
  conferenceUrl?: string;
  canEdit: boolean;
  onLocationChange: (location: string) => void;
  onMeetChange: (meet: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      {meet ? (
        <GoogleMeetIcon className="size-4.5 shrink-0" />
      ) : (
        <HugeiconsIcon
          icon={Location01Icon}
          strokeWidth={2}
          className="size-4.5 shrink-0 text-muted-foreground"
        />
      )}
      {/* -ml-2 cancels the child's px-2 so its text lines up with the plain
          labels on the other rows, while the padding still gives the hover
          background breathing room. */}
      <div className="-ml-2 flex min-w-0 flex-1 items-center">
        {meet ? (
          conferenceUrl ? (
            <a
              href={conferenceUrl}
              target="_blank"
              rel="noreferrer"
              className="truncate rounded-lg px-2 py-1 text-sm font-medium text-emerald-600 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring dark:text-emerald-400"
            >
              Google Meet
            </a>
          ) : (
            <span className="px-2 py-1 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              Google Meet
            </span>
          )
        ) : (
          <input
            value={location}
            readOnly={!canEdit}
            onChange={(e) => onLocationChange(e.target.value)}
            placeholder={canEdit ? "Add location" : "None"}
            aria-label="Location"
            className="w-full min-w-0 rounded-lg bg-transparent px-2 py-1 text-sm font-medium outline-none placeholder:font-normal placeholder:text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring read-only:hover:bg-transparent"
          />
        )}
      </div>
      {canEdit && (
        <div className="flex shrink-0 gap-1 rounded-lg bg-muted p-0.5">
          <WhereTab
            label="In person"
            active={!meet}
            onSelect={() => onMeetChange(false)}
          />
          <WhereTab
            label="Video"
            active={meet}
            accent
            onSelect={() => onMeetChange(true)}
          />
        </div>
      )}
    </div>
  );
}

/** One segment of the "Where" switch. Mirrors the Starts/Ends time tabs so the
 * two segmented controls in the form read as the same kind of thing. */
function WhereTab({
  label,
  active,
  accent,
  onSelect,
}: {
  label: string;
  active: boolean;
  /** Tint the label green while active — used for the "Video" segment. */
  accent?: boolean;
  onSelect: () => void;
}) {
  return (
    <motion.button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      {...press}
      className={cn(
        "rounded-md px-3 py-0.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? accent
            ? "bg-background text-emerald-600 shadow-sm dark:text-emerald-400"
            : "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </motion.button>
  );
}

/** A pill switch — there is no Switch primitive in @qali/ui yet. */
function ToggleSwitch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-10 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        checked ? "bg-primary" : "bg-muted-foreground/30",
        disabled && "opacity-50",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-5 rounded-full bg-background shadow-sm transition-transform",
          checked && "translate-x-4",
        )}
      />
    </button>
  );
}
