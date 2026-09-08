import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { reminderRulesFor, type ReminderRules } from "@qali/domain/reminders";
import { WheelPicker } from "@qali/ui/components/motion/wheel-picker";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@qali/ui/components/popover";
import { cn } from "@qali/ui/lib/utils";
import { useState } from "react";

import { usePreferences } from "@/components/workspace/preferences-context";
import { useBrowserNotifications } from "@/lib/use-browser-notifications";
import {
  CUSTOM_UNIT_MINUTES,
  MAX_REMINDERS_PER_EVENT,
  allDayMinutes,
  hasPopup,
  labelFor,
  summarizeReminders,
  togglePopup,
  type CustomUnit,
  type Reminder,
} from "./reminders";

const NUDGE_DISMISSED_KEY = "qali.reminder-nudge-dismissed";

// Same drum size as the form's time wheels, so the two read as one control.
const WHEEL_ROWS = 5;
const WHEEL_ROW_PX = 32;

// One wheel of amounts per unit, so the wheel never offers "0 weeks".
const AMOUNTS: Record<CustomUnit, string[]> = {
  min: Array.from({ length: 60 }, (_, i) => String(i)),
  hours: Array.from({ length: 23 }, (_, i) => String(i + 1)),
  days: Array.from({ length: 27 }, (_, i) => String(i + 1)),
  weeks: Array.from({ length: 4 }, (_, i) => String(i + 1)),
};
const UNITS: { label: string; value: CustomUnit }[] = [
  { label: "min", value: "min" },
  { label: "hours", value: "hours" },
  { label: "days", value: "days" },
  { label: "weeks", value: "weeks" },
];

const DAYS_BEFORE = Array.from({ length: 28 }, (_, i) => {
  const n = i + 1;
  return { label: n === 1 ? "1 day" : `${n} days`, value: String(n) };
});
const HOURS_12 = Array.from({ length: 12 }, (_, i) => String(i + 1));
const HOURS_24 = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const QUARTER_MINUTES = ["00", "15", "30", "45"];
const MERIDIEM = ["AM", "PM"];

function readNudgeDismissed(): boolean {
  try {
    return localStorage.getItem(NUDGE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The Reminder control: a trigger showing the current choice, opening a
 * compact popover — Default / None, the chosen reminders as removable chips,
 * and a wheel composer for adding one more. `null` means "the calendar's
 * default"; `[]` means none. The provider's rules shape it: one reminder on
 * Outlook, read-only on a subscribed feed.
 */
export function ReminderControl({
  value,
  allDay,
  provider,
  onChange,
}: {
  value: Reminder[] | null;
  allDay: boolean;
  provider: string | undefined;
  onChange: (reminders: Reminder[] | null) => void;
}) {
  const { use24h, raw } = usePreferences();
  const rules: ReminderRules = reminderRulesFor(provider ?? "google");
  const [open, setOpen] = useState(false);
  // "Custom" with nothing added yet is a UI state, not a value: the value
  // stays as it was until the first Add, but the composer is showing.
  const [composing, setComposing] = useState(false);
  const defaultMinutes = allDay
    ? raw.defaultAllDayReminderMinutes
    : raw.defaultReminderMinutes;
  const summary = summarizeReminders(value, allDay, use24h, defaultMinutes);

  if (!rules.write) {
    return (
      <span className="px-2 py-1 text-sm text-muted-foreground">{summary}</span>
    );
  }

  const cap = Math.min(rules.maxPerEvent, MAX_REMINDERS_PER_EVENT);
  const popups = (value ?? []).filter((r) => r.method === "popup");
  const full = popups.length >= cap;
  const mode: "default" | "none" | "custom" =
    popups.length > 0 || composing
      ? "custom"
      : value === null
        ? "default"
        : "none";

  const add = (minutes: number) => {
    // Adding from "default" starts from an empty list, never from the
    // default's contents: explicit and inherited never blend.
    const base = value ?? [];
    if (hasPopup(base, minutes)) return;
    if (cap === 1) {
      onChange([{ method: "popup", minutes }]);
      return;
    }
    if (full) return;
    onChange(togglePopup(base, minutes));
  };
  const remove = (minutes: number) => onChange(togglePopup(value ?? [], minutes));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex-1 truncate rounded-lg px-2 py-1 text-right text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        {summary}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[21rem] p-2">
        {/* Default / None — the two states that aren't a list. */}
        <div className="flex gap-1 rounded-xl bg-muted p-1">
          {rules.providerDefault && (
            <Segment
              active={mode === "default"}
              onClick={() => {
                setComposing(false);
                onChange(null);
              }}
            >
              Default
            </Segment>
          )}
          <Segment
            active={mode === "none"}
            onClick={() => {
              setComposing(false);
              onChange([]);
            }}
          >
            None
          </Segment>
          <Segment active={mode === "custom"} onClick={() => setComposing(true)}>
            {popups.length === 0
              ? "Custom"
              : popups.length === 1
                ? "1 reminder"
                : `${popups.length} reminders`}
          </Segment>
        </div>

        {popups.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {[...popups]
              .sort((a, b) => a.minutes - b.minutes)
              .map((r) => (
                <span
                  key={r.minutes}
                  className="flex h-7 items-center gap-1 rounded-full bg-accent pr-1 pl-2.5 text-xs font-medium"
                >
                  {labelFor(r.minutes, allDay, use24h)}
                  <button
                    type="button"
                    aria-label={`Remove ${labelFor(r.minutes, allDay, use24h)}`}
                    onClick={() => remove(r.minutes)}
                    className="flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3" />
                  </button>
                </span>
              ))}
          </div>
        )}

        {mode === "custom" && (
          <div className="mt-2 border-t pt-2">
            {allDay ? (
              <AllDayComposer
                use24h={use24h}
                disabled={full && cap > 1}
                onAdd={add}
              />
            ) : (
              <TimedComposer disabled={full && cap > 1} onAdd={add} />
            )}
            <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
              {cap > 1 && full
                ? `Up to ${cap} reminders`
                : cap === 1
                  ? "This calendar keeps one reminder per event"
                  : "Pick an offset and add it"}
            </p>
          </div>
        )}

        <NotificationsNudge />
      </PopoverContent>
    </Popover>
  );
}

/** Amount and unit wheels side by side, then Add. */
function TimedComposer({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (minutes: number) => void;
}) {
  const [amount, setAmount] = useState("10");
  const [unit, setUnit] = useState<CustomUnit>("min");
  const minutes = Number(amount) * CUSTOM_UNIT_MINUTES[unit];
  const setUnitKeepingAmount = (next: CustomUnit) => {
    setUnit(next);
    if (!AMOUNTS[next].includes(amount)) setAmount(AMOUNTS[next][0]!);
  };
  return (
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 gap-2">
        <WheelPicker
          options={AMOUNTS[unit]}
          value={amount}
          onValueChange={setAmount}
          visibleCount={WHEEL_ROWS}
          itemHeight={WHEEL_ROW_PX}
          sound
          className="flex-1"
          aria-label="Amount"
        />
        <WheelPicker
          options={UNITS}
          value={unit}
          onValueChange={(v) => setUnitKeepingAmount(v as CustomUnit)}
          visibleCount={WHEEL_ROWS}
          itemHeight={WHEEL_ROW_PX}
          sound
          className="flex-1"
          aria-label="Unit"
        />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <span className="text-xs text-muted-foreground">before</span>
        <AddButton
          disabled={disabled}
          label={labelFor(minutes, false, true)}
          onClick={() => onAdd(minutes)}
        />
      </div>
    </div>
  );
}

/** Days-before and a wall-clock time, then Add. */
function AllDayComposer({
  use24h,
  disabled,
  onAdd,
}: {
  use24h: boolean;
  disabled: boolean;
  onAdd: (minutes: number) => void;
}) {
  const [days, setDays] = useState("1");
  const [hour, setHour] = useState(use24h ? "09" : "9");
  const [minute, setMinute] = useState("00");
  const [meridiem, setMeridiem] = useState("AM");
  const hour24 = use24h
    ? Number(hour)
    : (Number(hour) % 12) + (meridiem === "PM" ? 12 : 0);
  const minutes = allDayMinutes(Number(days), hour24 * 60 + Number(minute));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <WheelPicker
          options={DAYS_BEFORE}
          value={days}
          onValueChange={setDays}
          visibleCount={WHEEL_ROWS}
          itemHeight={WHEEL_ROW_PX}
          sound
          className="flex-[1.3]"
          aria-label="Days before"
        />
        <span className="self-center text-sm text-muted-foreground">at</span>
        <WheelPicker
          options={use24h ? HOURS_24 : HOURS_12}
          value={hour}
          onValueChange={setHour}
          visibleCount={WHEEL_ROWS}
          itemHeight={WHEEL_ROW_PX}
          sound
          className="flex-1"
          aria-label="Hour"
        />
        <WheelPicker
          options={QUARTER_MINUTES}
          value={minute}
          onValueChange={setMinute}
          visibleCount={WHEEL_ROWS}
          itemHeight={WHEEL_ROW_PX}
          sound
          className="flex-1"
          aria-label="Minute"
        />
        {!use24h && (
          <WheelPicker
            options={MERIDIEM}
            value={meridiem}
            onValueChange={setMeridiem}
            visibleCount={WHEEL_ROWS}
            itemHeight={WHEEL_ROW_PX}
            sound
            className="flex-1"
            aria-label="AM or PM"
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {labelFor(minutes, true, use24h)}
        </span>
        <AddButton disabled={disabled} onClick={() => onAdd(minutes)} />
      </div>
    </div>
  );
}

function AddButton({
  disabled,
  label,
  onClick,
}: {
  disabled: boolean;
  /** What the button will add, as its tooltip. */
  label?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={label}
      onClick={onClick}
      className="h-8 shrink-0 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      Add
    </button>
  );
}

function Segment({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex-1 truncate rounded-lg px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-background font-medium shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** One line under the picker, until browser notifications are on or the
 * user waves it away. The Turn on button is the user gesture the permission
 * prompt needs. */
function NotificationsNudge() {
  const { status, busy, enable } = useBrowserNotifications();
  const [dismissed, setDismissed] = useState(readNudgeDismissed);
  if (dismissed || status === "on" || status === "unsupported") return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(NUDGE_DISMISSED_KEY, "1");
    } catch {
      // Private mode: the nudge just comes back next time.
    }
  };

  const text =
    status === "blocked"
      ? "Notifications are blocked for this site"
      : status === "ios-needs-install"
        ? "Add qali to your Home Screen for reminders when it's closed"
        : "Get reminders when qali is closed";

  return (
    <div className="mt-2 flex items-center gap-1 border-t pt-2 pl-1">
      <span className="flex-1 truncate text-[11px] text-muted-foreground">{text}</span>
      {status === "off" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void enable()}
          className="rounded-md px-1.5 py-0.5 text-[11px] font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Turn on
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="flex size-5 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3" />
      </button>
    </div>
  );
}
