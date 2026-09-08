import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { reminderRulesFor, type ReminderRules } from "@qali/domain/reminders";
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
  ALL_DAY_PRESETS,
  CUSTOM_UNIT_MINUTES,
  MAX_REMINDERS_PER_EVENT,
  TIMED_PRESETS,
  allDayMinutes,
  daysBeforeLabel,
  hasPopup,
  labelFor,
  summarizeReminders,
  togglePopup,
  type CustomUnit,
  type Reminder,
} from "./reminders";

const NUDGE_DISMISSED_KEY = "qali.reminder-nudge-dismissed";

const ALL_DAY_TIMES: { label: string; minutes: number }[] = [
  { label: "09:00", minutes: 9 * 60 },
  { label: "12:00", minutes: 12 * 60 },
  { label: "18:00", minutes: 18 * 60 },
];

function readNudgeDismissed(): boolean {
  try {
    return localStorage.getItem(NUDGE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The Reminder control: a trigger showing the current choice, opening a
 * popover of presets (multi-select up to the provider's cap), a custom offset,
 * and — the first time — a nudge to turn on browser notifications. `null`
 * means "the calendar's default"; `[]` means none. The provider's rules shape
 * what is offered: one reminder on Outlook, read-only on a subscribed feed.
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
  const popupCount = value?.filter((r) => r.method === "popup").length ?? 0;
  const full = popupCount >= cap;
  const presets = allDay ? ALL_DAY_PRESETS : TIMED_PRESETS;

  const toggle = (minutes: number) => {
    // Toggling from "default" starts from an empty list, never from the
    // default's contents: explicit and inherited never blend.
    const base = value ?? [];
    if (cap === 1) {
      onChange(hasPopup(base, minutes) ? [] : [{ method: "popup", minutes }]);
      return;
    }
    if (!hasPopup(base, minutes) && full) return;
    onChange(togglePopup(base, minutes));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex-1 truncate rounded-lg px-2 py-1 text-right text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        {summary}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[22rem] p-2">
        <div className="flex flex-col gap-1">
          {rules.providerDefault && (
            <OptionRow active={value === null} onClick={() => onChange(null)}>
              {summarizeReminders(null, allDay, use24h, defaultMinutes)}
            </OptionRow>
          )}
          <OptionRow
            active={value !== null && popupCount === 0}
            onClick={() => onChange([])}
          >
            None
          </OptionRow>
          {presets.map((minutes) => {
            const on = hasPopup(value, minutes);
            return (
              <OptionRow
                key={minutes}
                active={on}
                pressed={on}
                disabled={!on && full && cap > 1}
                onClick={() => toggle(minutes)}
              >
                <span className="flex-1">{labelFor(minutes, allDay, use24h)}</span>
                {on && (
                  <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" />
                )}
              </OptionRow>
            );
          })}
          {cap > 1 && (
            <p className="px-2 pt-0.5 text-[11px] text-muted-foreground">
              Up to {cap} reminders
            </p>
          )}
        </div>

        <div className="mt-2 border-t pt-2">
          <p className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">
            Custom
          </p>
          {allDay ? (
            <AllDayCustom disabled={full && cap > 1} onAdd={toggle} />
          ) : (
            <TimedCustom disabled={full && cap > 1} onAdd={toggle} />
          )}
        </div>

        <NotificationsNudge />
      </PopoverContent>
    </Popover>
  );
}

function OptionRow({
  active,
  pressed,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-center rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:hover:bg-transparent",
        active && "bg-accent font-medium",
      )}
    >
      {children}
    </button>
  );
}

function TimedCustom({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (minutes: number) => void;
}) {
  const [amount, setAmount] = useState(45);
  const [unit, setUnit] = useState<CustomUnit>("min");
  const minutes = Math.max(0, Math.round(amount)) * CUSTOM_UNIT_MINUTES[unit];
  return (
    <div className="flex items-center gap-2 px-2">
      <input
        type="number"
        min={0}
        value={amount}
        onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))}
        aria-label="Reminder amount"
        className="h-8 w-14 rounded-lg bg-input/50 px-2 text-center text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex flex-1 gap-1 rounded-xl bg-muted p-1">
        {(["min", "hours", "days", "weeks"] as const).map((u) => (
          <Segment key={u} active={unit === u} onClick={() => setUnit(u)}>
            {u}
          </Segment>
        ))}
      </div>
      <AddButton disabled={disabled} onClick={() => onAdd(minutes)} />
    </div>
  );
}

function AllDayCustom({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (minutes: number) => void;
}) {
  const [days, setDays] = useState(1);
  const [timeOfDay, setTimeOfDay] = useState(9 * 60);
  return (
    <div className="flex flex-col gap-2 px-2">
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          max={28}
          value={days}
          onChange={(e) =>
            setDays(Math.min(28, Math.max(0, Number(e.target.value) || 0)))
          }
          aria-label="Days before"
          className="h-8 w-14 rounded-lg bg-input/50 px-2 text-center text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span className="flex-1 text-sm text-muted-foreground">
          {daysBeforeLabel(days).toLowerCase()} at
        </span>
        <AddButton
          disabled={disabled}
          onClick={() => onAdd(allDayMinutes(days, timeOfDay))}
        />
      </div>
      <div className="flex gap-1 rounded-xl bg-muted p-1">
        {ALL_DAY_TIMES.map((t) => (
          <Segment
            key={t.minutes}
            active={timeOfDay === t.minutes}
            onClick={() => setTimeOfDay(t.minutes)}
          >
            {t.label}
          </Segment>
        ))}
      </div>
    </div>
  );
}

function AddButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
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
        "flex-1 rounded-lg px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
        ? "Add qali to your Home Screen to get reminders when it's closed"
        : "Get reminders when qali is closed";

  return (
    <div className="mt-2 flex items-center gap-2 border-t pt-2 pl-2">
      <span className="flex-1 text-xs text-muted-foreground">{text}</span>
      {status === "off" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void enable()}
          className="rounded-lg px-2 py-1 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Turn on
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
      </button>
    </div>
  );
}
