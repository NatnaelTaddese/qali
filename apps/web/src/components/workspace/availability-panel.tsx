import {
  Cancel01Icon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { normalizeSlug } from "@qali/backend/convex/lib/slug";
import { Button } from "@qali/ui/components/button";
import { Input } from "@qali/ui/components/input";
import { Switch } from "@qali/ui/components/switch";
import { Spinner } from "@qali/ui/components/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@qali/ui/components/tooltip";
import { cn } from "@qali/ui/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { SPRING_DOCK } from "@/components/calendar/motion";
import {
  PendingRequestsDeck,
  type Booking,
} from "./booking-request-panel";
import { TimeField } from "./time-field";

/** Weekdays in display order, matching the grid's Monday-first week. */
const WEEKDAYS = [
  { weekday: 1, label: "Mon" },
  { weekday: 2, label: "Tue" },
  { weekday: 3, label: "Wed" },
  { weekday: 4, label: "Thu" },
  { weekday: 5, label: "Fri" },
  { weekday: 6, label: "Sat" },
  { weekday: 0, label: "Sun" },
];

const SLOT_CHOICES = [15, 30, 45, 60];

/** One editable row per weekday. The schema allows several openings a day; this
 * panel edits a single span per day, which is the shape it also writes. */
interface DayRow {
  enabled: boolean;
  startMin: number;
  endMin: number;
}

const DEFAULT_ROW: DayRow = { enabled: false, startMin: 9 * 60, endMin: 17 * 60 };

function rowsFromRules(
  rules: { weekday: number; startMin: number; endMin: number }[],
): Record<number, DayRow> {
  const rows: Record<number, DayRow> = {};
  for (const { weekday } of WEEKDAYS) {
    const rule = rules.find((r) => r.weekday === weekday);
    rows[weekday] = rule
      ? { enabled: true, startMin: rule.startMin, endMin: rule.endMin }
      : { ...DEFAULT_ROW };
  }
  return rows;
}

/**
 * The host's side of the booking link: the slug it lives at, the weekly hours it
 * offers, and how those hours are cut into slots.
 *
 * Everything is one local draft saved by an explicit Save, rather than a field
 * at a time — half-entered hours would otherwise be live on a public page.
 */
export function AvailabilityPanel({
  pendingBookings,
  onClose,
  onOpenRequest,
}: {
  pendingBookings: Booking[] | undefined;
  onClose: () => void;
  onOpenRequest: (booking: Booking) => void;
}) {
  const page = useQuery(api.booking.getMyBookingPage);
  const defaults = useQuery(api.booking.bookingPageDefaults);
  const upsert = useMutation(api.booking.upsertBookingPage);
  const reduce = useReducedMotion();

  const [slug, setSlug] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<Record<number, DayRow> | null>(null);
  const [slotMinutes, setSlotMinutes] = useState(30);
  const [noticeHours, setNoticeHours] = useState(2);
  const [horizonDays, setHorizonDays] = useState(60);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  // Seed the draft once the server answers. `slug === null` is the "not seeded
  // yet" marker, so a saved page reopening the panel doesn't reset edits.
  useEffect(() => {
    if (slug !== null) return;
    if (page) {
      setSlug(page.slug);
      setTitle(page.title ?? "");
      setRows(rowsFromRules(page.rules));
      setSlotMinutes(page.slotMinutes);
      setNoticeHours(Math.round(page.minNoticeMinutes / 60));
      setHorizonDays(page.horizonDays);
      setEnabled(page.enabled);
      return;
    }
    // `page === null` means the host has no page yet; wait for the defaults.
    if (page === null && defaults) {
      setSlug(defaults.suggestedSlug);
      setRows(rowsFromRules(defaults.rules));
      setSlotMinutes(defaults.slotMinutes);
      setNoticeHours(Math.round(defaults.minNoticeMinutes / 60));
      setHorizonDays(defaults.horizonDays);
    }
  }, [page, defaults, slug]);

  const normalized = slug === null ? "" : normalizeSlug(slug);
  // Skip the round trip until there is something worth checking.
  const check = useQuery(
    api.booking.checkSlugAvailable,
    normalized.length >= 3 ? { slug: normalized } : "skip",
  );

  const rules = useMemo(
    () =>
      rows
        ? WEEKDAYS.filter(({ weekday }) => rows[weekday]?.enabled)
            .map(({ weekday }) => ({
              weekday,
              startMin: rows[weekday].startMin,
              endMin: rows[weekday].endMin,
            }))
            .filter((rule) => rule.endMin > rule.startMin)
        : [],
    [rows],
  );

  const openDayCount = rows
    ? WEEKDAYS.filter(({ weekday }) => rows[weekday]?.enabled).length
    : 0;
  const slugReady = normalized.length >= 3 && check?.available === true;
  const canSave = slugReady && rules.length > 0 && !saving;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const publicUrl = `${origin}/${normalized}`;

  const patchRow = (weekday: number, patch: Partial<DayRow>) => {
    setRows((prev) =>
      prev ? { ...prev, [weekday]: { ...prev[weekday], ...patch } } : prev,
    );
  };

  // Copy one day's hours onto every other open day, so setting hours once is
  // enough for a typical week.
  const copyRowToAll = (weekday: number) => {
    setRows((prev) => {
      if (!prev) return prev;
      const { startMin, endMin } = prev[weekday];
      const next: Record<number, DayRow> = { ...prev };
      for (const { weekday: wd } of WEEKDAYS) {
        if (wd !== weekday && next[wd].enabled) {
          next[wd] = { ...next[wd], startMin, endMin };
        }
      }
      return next;
    });
    toast.success("Hours copied to all open days");
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await upsert({
        slug: normalized,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        title: title.trim() || undefined,
        rules,
        slotMinutes,
        bufferMinutes: 0,
        minNoticeMinutes: Math.max(0, Math.round(noticeHours * 60)),
        horizonDays,
        enabled,
      });
      toast.success(enabled ? "Booking link is live" : "Booking link saved");
    } catch (error: unknown) {
      toast.error("Couldn't save your booking link", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  if (!rows || slug === null || pendingBookings === undefined) {
    return (
      <motion.div
        initial={false}
        animate={{ height: 160 }}
        transition={reduce ? { duration: 0 } : SPRING_DOCK}
        className="flex items-center justify-center overflow-hidden"
      >
        <Spinner />
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={false}
      animate={{ height: "auto" }}
      transition={reduce ? { duration: 0 } : SPRING_DOCK}
      className="flex flex-col gap-3 overflow-hidden"
    >
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Booking link</p>
          <p className="truncate text-xs text-muted-foreground">
            Share it and people can request a time
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
        </button>
      </div>

      <PendingRequestsDeck pending={pendingBookings} onOpen={onOpenRequest} />

      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <div className="flex h-9 min-w-0 flex-1 items-center gap-0 rounded-3xl bg-input/50 pl-3 focus-within:ring-3 focus-within:ring-ring/30">
            <span className="shrink-0 truncate text-sm text-muted-foreground">
              {origin.replace(/^https?:\/\//, "")}/
            </span>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="your-name"
              aria-label="Booking link name"
              spellCheck={false}
              autoCapitalize="none"
              className="h-9 flex-1 bg-transparent pl-0.5 focus-visible:border-transparent focus-visible:ring-0"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Copy booking link"
            disabled={!slugReady}
            onClick={copyLink}
          >
            <HugeiconsIcon
              icon={copied ? Tick02Icon : Copy01Icon}
              strokeWidth={2}
              className="size-4"
            />
          </Button>
        </div>
        {normalized.length >= 3 && check && !check.available && (
          <p className="px-3 text-xs text-destructive">{check.reason}</p>
        )}
      </div>

      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What the meeting is called"
        aria-label="Meeting title"
      />

      <div className="space-y-1.5">
        <p className="px-2 text-xs font-medium text-muted-foreground">
          Weekly hours
        </p>
        <div className="space-y-0.5">
          {WEEKDAYS.map(({ weekday, label }) => {
            const row = rows[weekday];
            return (
              <div
                key={weekday}
                className="group flex items-center gap-2.5 rounded-2xl px-1 py-1"
              >
                <Switch
                  checked={row.enabled}
                  onCheckedChange={(checked) =>
                    patchRow(weekday, { enabled: checked })
                  }
                  aria-label={`${label} available`}
                />
                <span
                  className={cn(
                    "w-9 shrink-0 text-sm font-medium transition-colors",
                    !row.enabled && "text-muted-foreground/60",
                  )}
                >
                  {label}
                </span>
                <div className="flex flex-1 items-center gap-1.5">
                  <TimeField
                    value={row.startMin}
                    onChange={(minutes) => patchRow(weekday, { startMin: minutes })}
                    disabled={!row.enabled}
                    aria-label={`${label} start`}
                    className="flex-1"
                  />
                  <span
                    className={cn(
                      "text-xs transition-colors",
                      row.enabled
                        ? "text-muted-foreground"
                        : "text-muted-foreground/50",
                    )}
                  >
                    to
                  </span>
                  <TimeField
                    value={row.endMin}
                    onChange={(minutes) => patchRow(weekday, { endMin: minutes })}
                    disabled={!row.enabled}
                    aria-label={`${label} end`}
                    className="flex-1"
                  />
                </div>
                {/* Fixed-width slot keeps every row's chips the same size whether
                    or not the copy affordance is present. */}
                <div className="flex size-6 shrink-0 items-center justify-center">
                  {row.enabled && openDayCount > 1 && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Copy to all open days"
                            onClick={() => copyRowToAll(weekday)}
                            className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                          >
                            <HugeiconsIcon
                              icon={Copy01Icon}
                              strokeWidth={2}
                              className="size-4"
                            />
                          </Button>
                        }
                      />
                      <TooltipContent>Copy to all open days</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {rows && rules.length === 0 && (
          <p className="px-2 text-xs text-destructive">
            Open at least one day
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="px-2 text-xs font-medium text-muted-foreground">
          Slot length
        </p>
        <div
          role="group"
          aria-label="Slot length"
          className="grid grid-cols-4 gap-1 rounded-2xl bg-muted p-1"
        >
          {SLOT_CHOICES.map((minutes) => (
            <Button
              key={minutes}
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={slotMinutes === minutes}
              className="rounded-xl px-2 text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm hover:bg-background/60 dark:hover:bg-background/40 aria-pressed:dark:border-white/5"
              onClick={() => setSlotMinutes(minutes)}
            >
              {minutes}m
            </Button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <label className="flex-1 space-y-1">
          <span className="px-2 text-xs font-medium text-muted-foreground">
            Notice (hours)
          </span>
          <Input
            type="number"
            min={0}
            max={720}
            value={noticeHours}
            onChange={(e) => setNoticeHours(Math.max(0, Number(e.target.value)))}
            className="h-8 text-center"
          />
        </label>
        <label className="flex-1 space-y-1">
          <span className="px-2 text-xs font-medium text-muted-foreground">
            Days ahead
          </span>
          <Input
            type="number"
            min={1}
            max={365}
            value={horizonDays}
            onChange={(e) =>
              setHorizonDays(Math.min(365, Math.max(1, Number(e.target.value))))
            }
            className="h-8 text-center"
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <label className="flex flex-1 items-center gap-2.5">
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label="Link is live"
          />
          <span className="text-sm font-normal text-muted-foreground">
            Link is live
          </span>
        </label>
        <Button
          type="button"
          size="sm"
          disabled={!canSave}
          className={cn(saving && "opacity-80")}
          onClick={save}
        >
          {saving && <Spinner />}
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </motion.div>
  );
}
