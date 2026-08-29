import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Calendar03Icon,
  Cancel01Icon,
  CheckmarkBadge01Icon,
  Link01Icon,
  PencilEdit01Icon,
  RefreshIcon,
  SlidersHorizontalIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Google, MicrosoftOutlook } from "@thesvg/react";
import { api } from "@qali/backend/convex/_generated/api";
import type { Id } from "@qali/backend/convex/_generated/dataModel";
import { Button } from "@qali/ui/components/button";
import { Checkbox } from "@qali/ui/components/checkbox";
import { Input } from "@qali/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@qali/ui/components/popover";
import { Skeleton } from "@qali/ui/components/skeleton";
import { Spinner } from "@qali/ui/components/spinner";
import { Switch } from "@qali/ui/components/switch";
import { cn } from "@qali/ui/lib/utils";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { formatDistanceToNow } from "date-fns";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import {
  calendarDisplayName,
  type CalendarListItem,
} from "@/components/calendar/lib";
import { calendarColorVar } from "@/components/calendar/colors";
import {
  dockVariants,
  dockVariantsReduced,
  SPRING_DOCK,
} from "@/components/calendar/motion";
import { useStableQuery } from "@/components/calendar/use-stable-query";
import { authClient } from "@/lib/auth-client";
import { UserAvatar } from "./user-avatar";
import { useSyncNow } from "./use-sync-now";

export type SettingsSection = "accounts" | "calendars" | "preferences";

const SECTIONS: {
  id: SettingsSection;
  label: string;
  description: string;
  icon: IconSvgElement;
}[] = [
  {
    id: "accounts",
    label: "Accounts",
    description: "Connections and sync",
    icon: Link01Icon,
  },
  {
    id: "calendars",
    label: "Calendars",
    description: "Grouped by account",
    icon: Calendar03Icon,
  },
  {
    id: "preferences",
    label: "Preferences",
    description: "Time and display",
    icon: SlidersHorizontalIcon,
  },
];

/** The panel goes two-column at the same point Tailwind's `sm:` would. */
const DESKTOP_QUERY = "(min-width: 640px)";

function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(DESKTOP_QUERY);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

/** Surface a failed settings write; the reactive query snaps the control back. */
function reportSaveError(message: string) {
  return (error: unknown) =>
    toast.error(message, {
      description: error instanceof Error ? error.message : undefined,
    });
}

/**
 * The full-bloom settings sheet: a sidebar of sections beside a page-like
 * content pane (serif heading over a card of rows) on desktop, and a
 * nav-list-then-slide stack on small screens. Every control writes
 * immediately — nothing here is a draft with a Save.
 */
export function SettingsPanel({
  initialSection,
  onClose,
}: {
  initialSection?: SettingsSection;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const isDesktop = useIsDesktop();
  const [section, setSection] = useState<SettingsSection>(
    initialSection ?? "accounts",
  );
  // Small screens show the section list first unless a section was requested.
  const [mobileScreen, setMobileScreen] = useState<"nav" | "section">(
    initialSection ? "section" : "nav",
  );
  const [direction, setDirection] = useState<-1 | 0 | 1>(0);
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();

  // The dock shell animates to whatever the active content measures, exactly
  // like the availability panel's screen swap.
  useEffect(() => {
    const element = innerRef.current;
    if (!element) return;
    const measure = () => setHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const variants = reduce ? dockVariantsReduced : dockVariants;

  const goTo = (next: SettingsSection) => {
    const from = SECTIONS.findIndex((s) => s.id === section);
    const to = SECTIONS.findIndex((s) => s.id === next);
    setDirection(to === from ? 0 : to > from ? 1 : -1);
    setSection(next);
    setMobileScreen("section");
  };

  const backToNav = () => {
    setDirection(-1);
    setMobileScreen("nav");
  };

  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  const sectionContent =
    section === "accounts" ? (
      <AccountsSection />
    ) : section === "calendars" ? (
      <CalendarsSection />
    ) : (
      <PreferencesSection />
    );

  return (
    <motion.div
      initial={false}
      animate={{ height: height ?? "auto" }}
      transition={reduce ? { duration: 0 } : SPRING_DOCK}
      className="overflow-hidden"
    >
      <div ref={innerRef}>
        {isDesktop ? (
          // The island drops its own inset for settings, so the sidebar's tint
          // runs corner to corner — the two-tone split. The height is fixed
          // (viewport-capped) so switching sections never resizes the sheet;
          // a section taller than the pane scrolls inside it instead.
          <div className="grid h-[min(34rem,78dvh)] grid-cols-[12.5rem_minmax(0,1fr)]">
            <nav
              aria-label="Settings sections"
              className="flex flex-col gap-1 border-r border-border bg-muted/40 p-3"
            >
              <p className="px-3 pt-1.5 pb-2.5 text-[11px] font-medium tracking-widest text-muted-foreground uppercase">
                Settings
              </p>
              {SECTIONS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-current={entry.id === section || undefined}
                  onClick={() => goTo(entry.id)}
                  className={cn(
                    // Rounded like the header's day/week/month toggle, not a pill.
                    "group flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    entry.id === section
                      ? "bg-background shadow-sm dark:border dark:border-white/5"
                      : "hover:bg-background/60 dark:hover:bg-background/40",
                  )}
                >
                  <HugeiconsIcon
                    icon={entry.icon}
                    strokeWidth={2}
                    className={cn(
                      "size-4 shrink-0",
                      entry.id === section
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  />
                  <span
                    className={cn(
                      "text-sm",
                      entry.id === section
                        ? "font-medium"
                        : "text-muted-foreground",
                    )}
                  >
                    {entry.label}
                  </span>
                </button>
              ))}
            </nav>
            <div className="relative flex h-full min-h-0 flex-col p-5 pl-6">
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="absolute top-4 right-4 z-10 flex size-7 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  strokeWidth={2}
                  className="size-4"
                />
              </button>
              <AnimatePresence mode="popLayout" initial={false} custom={direction}>
                <motion.div
                  key={section}
                  custom={direction}
                  variants={variants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <h2 className="font-display shrink-0 pr-9 text-2xl font-bold">
                    {active.label}
                  </h2>
                  <div className="scroll-fade-y -mr-2 mt-4 min-h-0 flex-1 overflow-y-auto pr-2 pb-1 [scrollbar-width:thin]">
                    {sectionContent}
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        ) : (
          // Small screens are single-tone; restore the inset the island ceded.
          <div className="p-4">
          <AnimatePresence mode="popLayout" initial={false} custom={direction}>
            {mobileScreen === "nav" ? (
              <motion.div
                key="nav"
                custom={direction}
                variants={variants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="flex flex-col gap-3"
              >
                <div className="flex items-center gap-2.5">
                  <h2 className="font-display min-w-0 flex-1 text-2xl font-bold">
                    Settings
                  </h2>
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
                <div className="flex flex-col gap-1.5">
                  {SECTIONS.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => goTo(entry.id)}
                      className="group flex items-center gap-3 rounded-2xl bg-muted/60 px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <HugeiconsIcon
                        icon={entry.icon}
                        strokeWidth={2}
                        className="size-5 shrink-0 text-muted-foreground"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm font-medium">{entry.label}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {entry.description}
                        </span>
                      </span>
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        strokeWidth={2}
                        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                      />
                    </button>
                  ))}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key={section}
                custom={direction}
                variants={variants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="flex flex-col gap-3"
              >
                <button
                  type="button"
                  onClick={backToNav}
                  className="-ml-1 flex items-center gap-1 self-start rounded-lg px-1 py-0.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <HugeiconsIcon
                    icon={ArrowLeft01Icon}
                    strokeWidth={2}
                    className="size-4 text-muted-foreground"
                  />
                  Settings
                </button>
                <h2 className="font-display text-2xl font-bold">
                  {active.label}
                </h2>
                {sectionContent}
              </motion.div>
            )}
          </AnimatePresence>
          </div>
        )}
      </div>
    </motion.div>
  );
}

/** The screenshot-style card: rows separated by hairlines on a soft surface. */
function SettingCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-3xl bg-muted/50 px-4", className)}>
      {children}
    </div>
  );
}

/** One card row: title and description on the left, a control on the right. */
function SettingRow({
  title,
  description,
  destructiveDescription,
  control,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Style the description as an error (e.g. a connection's lastError). */
  destructiveDescription?: boolean;
  control?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 border-b border-border py-3.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {description && (
          <p
            className={cn(
              "mt-0.5 text-xs",
              destructiveDescription
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {description}
          </p>
        )}
      </div>
      {control && <div className="flex shrink-0 items-center">{control}</div>}
    </div>
  );
}

function SectionSkeleton() {
  return (
    <SettingCard>
      <div className="space-y-3 py-4">
        <Skeleton className="h-10 rounded-2xl" />
        <Skeleton className="h-10 rounded-2xl" />
        <Skeleton className="h-10 rounded-2xl" />
      </div>
    </SettingCard>
  );
}

type Connection = FunctionReturnType<
  typeof api.domains.calendar.queries.listConnections
>[number];

function AccountsSection() {
  // Stable so a reopen paints the retained list instead of a skeleton.
  const connections = useStableQuery(
    api.domains.calendar.queries.listConnections,
  );

  if (connections === undefined) return <SectionSkeleton />;
  if (connections.length === 0) {
    return (
      <SettingCard>
        <p className="py-8 text-center text-xs text-muted-foreground">
          No connected accounts yet — they appear after your first sync.
        </p>
      </SettingCard>
    );
  }
  return (
    <div className="space-y-3">
      {connections.map((connection) => (
        <ConnectionCard key={connection._id} connection={connection} />
      ))}
    </div>
  );
}

function ConnectionCard({ connection }: { connection: Connection }) {
  const { data: session } = authClient.useSession();
  const setStatus = useMutation(
    api.domains.calendar.mutations.setConnectionStatus,
  );
  const setContacts = useMutation(
    api.domains.calendar.mutations.setConnectionContacts,
  );
  const { sync, isSyncing } = useSyncNow();
  const reduce = useReducedMotion();

  const paused = connection.status === "paused";
  const errored = connection.status === "error";
  // v1's connection is the login grant, so the session's identity is this
  // account's identity — and it learns providerAccountId lazily.
  const accountLabel =
    connection.providerAccountId ?? session?.user?.email ?? "";
  const ProviderLogo =
    connection.provider === "google" ? Google : MicrosoftOutlook;
  const intervalMin = Math.max(
    1,
    Math.round((connection.syncIntervalMs ?? 15 * 60 * 1000) / 60_000),
  );

  const toggle = (nextActive: boolean) =>
    void setStatus({
      connectionId: connection._id,
      status: nextActive ? "active" : "paused",
    }).catch(reportSaveError("Couldn't update the connection"));

  const syncDescription = errored
    ? (connection.lastError ?? "Needs attention")
    : paused
      ? "Paused — not syncing"
      : `${
          connection.lastSyncAt
            ? `Synced ${formatDistanceToNow(connection.lastSyncAt, {
                addSuffix: true,
              })}`
            : "Not synced yet"
        } · checks every ${intervalMin} min`;

  return (
    <div className="overflow-hidden rounded-3xl bg-muted/50">
      {/* Identity band: who this account is, tinted apart from its toggles. */}
      <div className="flex items-center gap-3 border-b border-border bg-muted/60 px-4 py-3">
        <span className="relative shrink-0">
          <UserAvatar className="size-9" />
          <span className="absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full bg-background shadow-sm">
            <ProviderLogo aria-hidden className="size-2.5" />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          {session?.user?.name && (
            <p className="truncate text-sm font-medium">{session.user.name}</p>
          )}
          <p className="truncate text-xs text-muted-foreground">
            {accountLabel}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-link">
          <HugeiconsIcon
            icon={CheckmarkBadge01Icon}
            strokeWidth={2}
            className="size-3.5"
          />
          Primary
        </span>
      </div>

      <div className="px-4">
        <SettingRow
          title="Calendar"
          description="View, create, and update events"
          control={
            <Switch
              checked={!paused}
              onCheckedChange={toggle}
              aria-label={
                paused ? "Calendar sync is paused" : "Calendar sync is on"
              }
            />
          }
        />
        <SettingRow
          title="Contacts"
          description="Suggests and ranks the people you invite"
          control={
            <Switch
              checked={connection.contactsEnabled}
              onCheckedChange={(checked) =>
                void setContacts({
                  connectionId: connection._id,
                  contacts: checked === true,
                }).catch(reportSaveError("Couldn't update contacts sync"))
              }
              aria-label={
                connection.contactsEnabled
                  ? "Contacts sync is on"
                  : "Contacts sync is off"
              }
            />
          }
        />
        <SettingRow
          title={
            <span className="flex items-center gap-1.5">
              Sync
              <span className="relative flex size-2 items-center justify-center">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    errored
                      ? "bg-destructive"
                      : paused
                        ? "bg-muted-foreground/40"
                        : "bg-chart-2",
                  )}
                />
                {!paused && !errored && !reduce && (
                  <span className="absolute size-2 animate-ping rounded-full bg-chart-2 opacity-60" />
                )}
              </span>
            </span>
          }
          description={syncDescription}
          destructiveDescription={errored}
          control={
            errored ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => toggle(true)}
              >
                Resume
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={paused || isSyncing}
                aria-busy={isSyncing}
                onClick={() => void sync()}
              >
                {isSyncing ? (
                  <Spinner />
                ) : (
                  <HugeiconsIcon
                    icon={RefreshIcon}
                    strokeWidth={2}
                    className="size-4"
                  />
                )}
                {isSyncing ? "Syncing…" : "Sync now"}
              </Button>
            )
          }
        />
      </div>
    </div>
  );
}

const WRITABLE_ACCESS_ROLES = new Set(["owner", "writer"]);

function isWritable(calendar: CalendarListItem): boolean {
  return (
    !calendar.isShared &&
    WRITABLE_ACCESS_ROLES.has(calendar.accessRole ?? "")
  );
}

function sortCalendars(calendars: CalendarListItem[]): CalendarListItem[] {
  // Primary first, then alphabetical — same order as the header picker.
  return [...calendars].sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return calendarDisplayName(a).localeCompare(calendarDisplayName(b));
  });
}

/** Shared column template so the header row and calendar rows line up. */
const CALENDAR_GRID =
  "grid grid-cols-[minmax(0,1fr)_3.5rem_5.5rem] items-center gap-3";

function CalendarsSection() {
  const connections = useStableQuery(
    api.domains.calendar.queries.listConnections,
  );
  const calendars = useQuery(api.domains.calendar.queries.listCalendars);
  const { data: session } = authClient.useSession();

  if (connections === undefined || calendars === undefined) {
    return <SectionSkeleton />;
  }
  if (calendars.length === 0) {
    return (
      <SettingCard>
        <p className="py-8 text-center text-xs text-muted-foreground">
          No calendars yet — they appear after your first sync.
        </p>
      </SettingCard>
    );
  }
  return (
    <div className="space-y-4">
      {connections.map((connection) => {
        const rows = sortCalendars(
          calendars.filter((c) => c.connectionId === connection._id),
        );
        if (rows.length === 0) return null;
        return (
          <div key={connection._id} className="space-y-1.5">
            <p className="truncate px-1 text-xs font-medium text-muted-foreground">
              {connection.providerAccountId ??
                session?.user?.email ??
                "Connected account"}
            </p>
            <SettingCard>
              <div
                aria-hidden
                className={cn(
                  CALENDAR_GRID,
                  "border-b border-border py-2.5 text-xs font-medium text-muted-foreground",
                )}
              >
                <span>Calendar</span>
                <span>Color</span>
                <span>Type</span>
              </div>
              {rows.map((calendar) => (
                <CalendarTableRow key={calendar._id} calendar={calendar} />
              ))}
            </SettingCard>
          </div>
        );
      })}
    </div>
  );
}

function calendarType(calendar: CalendarListItem): string {
  if (calendar.primary) return "Primary";
  if (calendar.isShared) return "Shared";
  if (!isWritable(calendar)) return "Read-only";
  return "Regular";
}

function CalendarTableRow({ calendar }: { calendar: CalendarListItem }) {
  const setSelected = useMutation(
    api.domains.calendar.mutations.setCalendarSelected,
  );
  const rename = useMutation(
    api.domains.calendar.mutations.setCalendarSummaryOverride,
  );
  const [editing, setEditing] = useState(false);
  const name = calendarDisplayName(calendar);
  const colorVar = calendarColorVar(calendar);

  const commit = (value: string) => {
    setEditing(false);
    const trimmed = value.trim();
    // Committing the provider's own name (or nothing) clears the override.
    if (trimmed === name) return;
    void rename({
      calendarId: calendar._id as Id<"calendars">,
      summaryOverride:
        trimmed === "" || trimmed === calendar.summary ? undefined : trimmed,
    }).catch(reportSaveError("Couldn't rename the calendar"));
  };

  return (
    <div
      className={cn(
        CALENDAR_GRID,
        "group border-b border-border py-3 last:border-b-0",
      )}
      style={{ "--cal-color": `var(${colorVar})` } as CSSProperties}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Checkbox
          checked={calendar.selected}
          onCheckedChange={(checked) =>
            void setSelected({
              calendarId: calendar._id as Id<"calendars">,
              selected: checked === true,
            }).catch(reportSaveError("Couldn't update the calendar"))
          }
          aria-label={`Show ${name}`}
          // The base checkbox restates its checked fill under `dark:`, so the
          // calendar tint must too — an unprefixed override loses in dark mode.
          className="size-5 rounded-md border-(--cal-color) transition-colors data-checked:border-(--cal-color) data-checked:bg-(--cal-color) data-checked:text-white dark:data-checked:bg-(--cal-color)"
        />
        {editing ? (
          <Input
            autoFocus
            defaultValue={name}
            aria-label={`Rename ${name}`}
            className="h-7 flex-1 rounded-md bg-background px-2 text-sm"
            onFocus={(event) => event.target.select()}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              // The dock closes on Escape; while renaming it should only cancel.
              if (event.key === "Escape") {
                event.stopPropagation();
                setEditing(false);
              }
              if (event.key === "Enter") commit(event.currentTarget.value);
            }}
          />
        ) : (
          // Same height as the rename input, so entering/leaving edit mode
          // never changes the row height.
          <span className="h-7 min-w-0 flex-1 truncate text-sm leading-7 font-medium">
            {name}
            {calendar.summaryOverride && calendar.summary && (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                · was {calendar.summary}
              </span>
            )}
          </span>
        )}
        {!editing && !calendar.isShared && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Rename ${name}`}
            onClick={() => setEditing(true)}
            className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <HugeiconsIcon
              icon={PencilEdit01Icon}
              strokeWidth={2}
              className="size-3.5"
            />
          </Button>
        )}
      </div>
      <span
        className="h-3.5 w-7 rounded-full"
        style={{ backgroundColor: `var(${colorVar})` }}
      />
      <span className="truncate text-sm text-muted-foreground">
        {calendarType(calendar)}
      </span>
    </div>
  );
}

const WEEK_START_OPTIONS = [
  { label: "Mon", value: 1 },
  { label: "Sun", value: 0 },
  { label: "Sat", value: 6 },
] as const;

const TIME_FORMAT_OPTIONS = [
  { label: "Auto", value: null },
  { label: "12h", value: "12h" },
  { label: "24h", value: "24h" },
] as const;

const DEFAULT_VIEW_OPTIONS = [
  { label: "Day", value: "day" },
  { label: "Week", value: "week" },
  { label: "Month", value: "month" },
] as const;

function PreferencesSection() {
  const prefs = useQuery(api.domains.preferences.queries.getMyPreferences);
  const calendars = useQuery(api.domains.calendar.queries.listCalendars);
  const updatePrefs = useMutation(
    api.domains.preferences.mutations.updatePreferences,
  );
  const browserZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    [],
  );

  if (prefs === undefined || prefs === null || calendars === undefined) {
    return <SectionSkeleton />;
  }

  const writable = sortCalendars(calendars).filter(isWritable);
  const defaultCalendar =
    writable.find((c) => c._id === prefs.defaultCalendarId) ?? null;

  const save = (patch: Parameters<typeof updatePrefs>[0]) =>
    void updatePrefs(patch).catch(
      reportSaveError("Couldn't save the preference"),
    );

  return (
    <SettingCard>
      <SettingRow
        title="Week starts on"
        description="First day of the calendar week"
        control={
          <Segmented
            label="Week starts on"
            options={WEEK_START_OPTIONS}
            value={prefs.weekStartsOn ?? 1}
            onChange={(value) => save({ weekStartsOn: value })}
          />
        }
      />
      <SettingRow
        title="Time format"
        description="Auto follows the 12-hour clock"
        control={
          <Segmented
            label="Time format"
            options={TIME_FORMAT_OPTIONS}
            value={prefs.timeFormat ?? null}
            onChange={(value) =>
              value === null
                ? save({ reset: ["timeFormat"] })
                : save({ timeFormat: value })
            }
          />
        }
      />
      <SettingRow
        title="Default view"
        description="What the calendar opens to"
        control={
          <Segmented
            label="Default view"
            options={DEFAULT_VIEW_OPTIONS}
            value={prefs.defaultView ?? "week"}
            onChange={(value) => save({ defaultView: value })}
          />
        }
      />
      {writable.length > 0 && (
        <SettingRow
          title="Default calendar"
          description="Where new events land unless you pick one"
          control={
            <PickerRow
              label={
                defaultCalendar
                  ? calendarDisplayName(defaultCalendar)
                  : "Automatic"
              }
              swatchVar={
                defaultCalendar ? calendarColorVar(defaultCalendar) : undefined
              }
              ariaLabel="Default calendar for new events"
            >
              {(close) => (
                <div className="flex flex-col gap-0.5">
                  <PickerOption
                    label="Automatic · primary calendar"
                    selected={!defaultCalendar}
                    onSelect={() => {
                      close();
                      save({ reset: ["defaultCalendarId"] });
                    }}
                  />
                  {writable.map((calendar) => (
                    <PickerOption
                      key={calendar._id}
                      label={calendarDisplayName(calendar)}
                      swatchVar={calendarColorVar(calendar)}
                      selected={calendar._id === defaultCalendar?._id}
                      onSelect={() => {
                        close();
                        save({ defaultCalendarId: calendar._id });
                      }}
                    />
                  ))}
                </div>
              )}
            </PickerRow>
          }
        />
      )}
      <SettingRow
        title="Time zone"
        description="Used for new events and your booking page"
        control={
          <TimeZonePicker
            value={prefs.timeZone}
            browserZone={browserZone}
            onSelect={(zone) =>
              zone === null
                ? save({ reset: ["timeZone"] })
                : save({ timeZone: zone })
            }
          />
        }
      />
    </SettingCard>
  );
}

/** A compact in-row segmented control, in the account panel's theme style. */
function Segmented<T>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { label: string; value: T }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid gap-1 rounded-2xl bg-background p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
    >
      {options.map((option) => (
        <Button
          key={option.label}
          type="button"
          variant="ghost"
          size="xs"
          aria-pressed={value === option.value}
          className="rounded-xl px-2.5 text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground aria-pressed:shadow-sm hover:bg-muted/60"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/** A row control that opens a popover of options — shared by the default
 * calendar and time zone pickers. Children receive a close callback. */
function PickerRow({
  label,
  swatchVar,
  ariaLabel,
  children,
}: {
  label: string;
  swatchVar?: string;
  ariaLabel: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={ariaLabel}
        className="flex h-8 max-w-52 items-center gap-2 rounded-2xl bg-background px-3 text-left outline-none transition-colors hover:bg-background/70 focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        {swatchVar && (
          <span
            className="size-3 shrink-0 rounded-full"
            style={{ backgroundColor: `var(${swatchVar})` }}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={2}
          className="size-4 shrink-0 rotate-90 text-muted-foreground"
        />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1.5">
        {children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

function PickerOption({
  label,
  swatchVar,
  selected,
  onSelect,
}: {
  label: string;
  swatchVar?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-2xl px-2.5 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-muted/60",
      )}
    >
      {swatchVar && (
        <span
          className="size-3 shrink-0 rounded-full"
          style={{ backgroundColor: `var(${swatchVar})` }}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && (
        <HugeiconsIcon
          icon={Tick02Icon}
          strokeWidth={2}
          className="size-4 shrink-0"
        />
      )}
    </button>
  );
}

const ZONE_LIST_LIMIT = 8;

function TimeZonePicker({
  value,
  browserZone,
  onSelect,
}: {
  value: string | undefined;
  browserZone: string;
  onSelect: (zone: string | null) => void;
}) {
  const [filter, setFilter] = useState("");
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  const needle = filter.trim().toLowerCase().replace(/\s+/g, "_");
  const matches = needle
    ? zones.filter((zone) => zone.toLowerCase().includes(needle))
    : zones;

  return (
    <PickerRow
      label={value ?? `Automatic · ${browserZone.replace(/_/g, " ")}`}
      ariaLabel="Time zone"
    >
      {(close) => (
        <div className="flex flex-col gap-1">
          <Input
            autoFocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search time zones"
            aria-label="Search time zones"
            className="h-8 rounded-2xl"
          />
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto [scrollbar-width:thin]">
            {!needle && (
              <PickerOption
                label={`Automatic · ${browserZone.replace(/_/g, " ")}`}
                selected={value === undefined}
                onSelect={() => {
                  close();
                  setFilter("");
                  onSelect(null);
                }}
              />
            )}
            {matches.slice(0, needle ? 50 : ZONE_LIST_LIMIT).map((zone) => (
              <PickerOption
                key={zone}
                label={zone.replace(/_/g, " ")}
                selected={zone === value}
                onSelect={() => {
                  close();
                  setFilter("");
                  onSelect(zone);
                }}
              />
            ))}
            {matches.length === 0 && (
              <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">
                No matching time zones
              </p>
            )}
          </div>
        </div>
      )}
    </PickerRow>
  );
}
