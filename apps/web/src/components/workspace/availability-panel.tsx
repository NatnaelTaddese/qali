import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
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
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  dockVariants,
  dockVariantsReduced,
  SPRING_DOCK,
} from "@/components/calendar/motion";
import {
  BookingRequestPanel,
  PendingRequestsList,
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

type BookingPage = FunctionReturnType<typeof api.booking.getMyBookingPage>;
type BookingDefaults = FunctionReturnType<
  typeof api.booking.bookingPageDefaults
>;

interface AvailabilityPanelProps {
  pendingBookings: Booking[] | undefined;
  page: BookingPage | undefined;
  defaults: BookingDefaults | undefined;
  onClose: () => void;
}

const DEFAULT_ROW: DayRow = {
  enabled: false,
  startMin: 9 * 60,
  endMin: 17 * 60,
};

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
  page,
  defaults,
  onClose,
}: AvailabilityPanelProps) {
  const reduce = useReducedMotion();

  if (
    page === undefined ||
    (page === null && defaults === undefined) ||
    pendingBookings === undefined
  ) {
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
    <AvailabilityForm
      pendingBookings={pendingBookings}
      page={page}
      defaults={defaults}
      onClose={onClose}
    />
  );
}

function AvailabilityForm({
  pendingBookings,
  page,
  defaults,
  onClose,
}: Omit<AvailabilityPanelProps, "pendingBookings" | "page"> & {
  pendingBookings: Booking[];
  page: BookingPage;
}) {
  const upsert = useMutation(api.booking.upsertBookingPage);
  const reduce = useReducedMotion();
  const initial = page ?? defaults;
  const lastInitial = useRef(initial);
  const dirty = useRef(false);
  const editVersion = useRef(0);
  const mainRef = useRef<HTMLDivElement>(null);

  const [slug, setSlug] = useState(
    () => page?.slug ?? defaults?.suggestedSlug ?? "",
  );
  const [title, setTitle] = useState(() => page?.title ?? "");
  const [rows, setRows] = useState<Record<number, DayRow>>(() =>
    rowsFromRules(initial?.rules ?? []),
  );
  const [slotMinutes, setSlotMinutes] = useState(
    () => initial?.slotMinutes ?? 30,
  );
  const [noticeHours, setNoticeHours] = useState(() =>
    Math.round((initial?.minNoticeMinutes ?? 120) / 60),
  );
  const [horizonDays, setHorizonDays] = useState(
    () => initial?.horizonDays ?? 60,
  );
  const [enabled, setEnabled] = useState(() => page?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [screen, setScreen] = useState<"main" | "requests" | "request">("main");
  const [direction, setDirection] = useState<-1 | 1>(1);
  const [mainHeight, setMainHeight] = useState<number>();
  const [selectedBooking, setSelectedBooking] = useState<Booking>();

  // A save may finish after the panel was closed and reopened. Reconcile that
  // late live result only while this fresh draft is still untouched.
  useEffect(() => {
    if (initial === lastInitial.current) return;
    lastInitial.current = initial;
    if (!initial || dirty.current) return;
    setSlug(page?.slug ?? defaults?.suggestedSlug ?? "");
    setTitle(page?.title ?? "");
    setRows(rowsFromRules(initial.rules));
    setSlotMinutes(initial.slotMinutes);
    setNoticeHours(Math.round(initial.minNoticeMinutes / 60));
    setHorizonDays(initial.horizonDays);
    setEnabled(page?.enabled ?? true);
  }, [initial, page, defaults]);

  const markDirty = () => {
    dirty.current = true;
    editVersion.current += 1;
  };

  const normalized = normalizeSlug(slug);
  const persistedSlug = page?.slug;
  const slugUnchanged =
    persistedSlug !== undefined && normalized === persistedSlug;
  // Skip the round trip until there is something worth checking.
  const check = useQuery(
    api.booking.checkSlugAvailable,
    normalized.length >= 3 && !slugUnchanged ? { slug: normalized } : "skip",
  );

  const rules = useMemo(
    () =>
      WEEKDAYS.filter(({ weekday }) => rows[weekday]?.enabled)
        .map(({ weekday }) => ({
          weekday,
          startMin: rows[weekday].startMin,
          endMin: rows[weekday].endMin,
        }))
        .filter((rule) => rule.endMin > rule.startMin),
    [rows],
  );

  const openDayCount = WEEKDAYS.filter(
    ({ weekday }) => rows[weekday]?.enabled,
  ).length;
  const slugReady =
    normalized.length >= 3 && (slugUnchanged || check?.available === true);
  const canSave = slugReady && rules.length > 0 && !saving;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const publicUrl = `${origin}/${normalized}`;
  const variants = reduce ? dockVariantsReduced : dockVariants;

  const openRequests = () => {
    setMainHeight(mainRef.current?.offsetHeight);
    setDirection(1);
    setScreen("requests");
  };

  const openRequest = (booking: Booking) => {
    setSelectedBooking(booking);
    setDirection(1);
    setScreen("request");
  };

  const returnToMain = () => {
    setDirection(-1);
    setScreen("main");
  };

  const returnToRequests = () => {
    setDirection(-1);
    setScreen("requests");
  };

  const finishRequest = () => {
    setDirection(-1);
    setScreen(pendingBookings.length > 1 ? "requests" : "main");
  };

  const patchRow = (weekday: number, patch: Partial<DayRow>) => {
    markDirty();
    setRows((prev) => ({
      ...prev,
      [weekday]: { ...prev[weekday], ...patch },
    }));
  };

  // Copy one day's hours onto every other open day, so setting hours once is
  // enough for a typical week.
  const copyRowToAll = (weekday: number) => {
    markDirty();
    setRows((prev) => {
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
    const savedVersion = editVersion.current;
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
      if (editVersion.current === savedVersion) {
        dirty.current = false;
      }
      toast.success(enabled ? "Booking link is live" : "Booking link saved");
    } catch (error: unknown) {
      toast.error("Couldn't save your booking link", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence mode="popLayout" initial={false} custom={direction}>
      {screen === "requests" ? (
        <motion.div
          key="requests"
          custom={direction}
          variants={variants}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{ height: mainHeight }}
          className="flex flex-col gap-3"
        >
          <button
            type="button"
            onClick={returnToMain}
            className="-ml-1 flex items-center gap-1 self-start rounded-lg px-1 py-0.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              strokeWidth={2}
              className="size-4 text-muted-foreground"
            />
            Booking link
          </button>
          <div>
            <p className="text-sm font-medium">Pending requests</p>
            <p className="text-xs text-muted-foreground">
              {pendingBookings.length === 1
                ? "1 person is waiting for a response"
                : `${pendingBookings.length} people are waiting for a response`}
            </p>
          </div>
          <PendingRequestsList pending={pendingBookings} onOpen={openRequest} />
        </motion.div>
      ) : screen === "request" && selectedBooking ? (
        <motion.div
          key={`request:${selectedBooking._id}`}
          custom={direction}
          variants={variants}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{ height: mainHeight }}
          className="overflow-y-auto"
        >
          <BookingRequestPanel
            booking={selectedBooking}
            onBack={returnToRequests}
            onDone={finishRequest}
          />
        </motion.div>
      ) : (
        <motion.div
          key="main"
          ref={mainRef}
          custom={direction}
          variants={variants}
          initial="initial"
          animate="animate"
          exit="exit"
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
              <HugeiconsIcon
                icon={Cancel01Icon}
                strokeWidth={2}
                className="size-4"
              />
            </button>
          </div>

          {pendingBookings.length > 0 && (
            <button
              type="button"
              onClick={openRequests}
              className="group flex items-center gap-3 rounded-2xl bg-muted/60 px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="text-sm font-medium">Pending requests</span>
                <span className="flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] leading-5 font-semibold text-primary-foreground">
                  {pendingBookings.length}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">Review</span>
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                strokeWidth={2}
                className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
              />
            </button>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <div className="flex h-9 min-w-0 flex-1 items-center gap-0 rounded-3xl bg-input/50 pl-3 focus-within:ring-3 focus-within:ring-ring/30">
                <span className="shrink-0 truncate text-sm text-muted-foreground">
                  {origin.replace(/^https?:\/\//, "")}/
                </span>
                <Input
                  value={slug}
                  onChange={(e) => {
                    markDirty();
                    setSlug(e.target.value);
                  }}
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
            onChange={(e) => {
              markDirty();
              setTitle(e.target.value);
            }}
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
                        onChange={(minutes) =>
                          patchRow(weekday, { startMin: minutes })
                        }
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
                        onChange={(minutes) =>
                          patchRow(weekday, { endMin: minutes })
                        }
                        mode="end"
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
            {rules.length === 0 && (
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
                  onClick={() => {
                    markDirty();
                    setSlotMinutes(minutes);
                  }}
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
                onChange={(e) => {
                  markDirty();
                  setNoticeHours(Math.max(0, Number(e.target.value)));
                }}
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
                onChange={(e) => {
                  markDirty();
                  setHorizonDays(
                    Math.min(365, Math.max(1, Number(e.target.value))),
                  );
                }}
                className="h-8 text-center"
              />
            </label>
          </div>

          <div className="flex items-center gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2.5">
              <Switch
                checked={enabled}
                onCheckedChange={(checked) => {
                  markDirty();
                  setEnabled(checked);
                }}
                aria-label={
                  enabled ? "Booking link is live" : "Booking link is paused"
                }
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <span className="relative flex size-2 items-center justify-center">
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        enabled ? "bg-chart-2" : "bg-muted-foreground/40",
                      )}
                    />
                    {enabled && !reduce && (
                      <span className="absolute size-2 animate-ping rounded-full bg-chart-2 opacity-60" />
                    )}
                  </span>
                  {enabled ? "Live" : "Paused"}
                </span>
                <span className="block truncate text-xs font-normal text-muted-foreground">
                  {enabled
                    ? "People can request a time"
                    : "Hidden — not taking requests"}
                </span>
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
      )}
    </AnimatePresence>
  );
}
