import {
  Calendar03Icon,
  Cursor02Icon,
  PlusSignIcon,
  Search01Icon,
  TimeScheduleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { Button } from "@qali/ui/components/button";
import { Spinner } from "@qali/ui/components/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@qali/ui/components/tooltip";
import { cn } from "@qali/ui/lib/utils";
import { useQuery } from "convex/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { EventCreate } from "@/components/calendar/event-create";
import { EventDetail } from "@/components/calendar/event-detail";
import { EventEdit } from "@/components/calendar/event-edit";
import {
  dockVariants,
  dockVariantsReduced,
  EASE_OUT_EXPO,
  SPRING_DOCK,
} from "@/components/calendar/motion";
import { useStableQuery } from "@/components/calendar/use-stable-query";
import { AccountPanel } from "./account-panel";
import { useAvailabilityEdit } from "./availability-edit-context";
import { AvailabilityPanel } from "./availability-panel";
import { BookingRequestPanel } from "./booking-request-panel";
import { useDock, type DockView } from "./dock-context";
import { UserAvatar } from "./user-avatar";
import { useSyncNow } from "./use-sync-now";

const MAX_TIMEOUT_MS = 2_147_000_000;
const AVAILABILITY_PREFETCH_GRACE_MS = 10_000;

/** Settings is the dock's heaviest panel by far, so it loads as its own chunk
 * instead of riding in the dock's synchronous module graph (the assistant
 * panel next door does the same). The dock warms it during idle time right
 * after mount, so by the time anyone reaches Settings — via the account panel
 * or the nav gear — the chunk is already resolved and Suspense never shows. */
const loadSettingsPanel = () =>
  import("./settings-panel").then((m) => ({ default: m.SettingsPanel }));

// Module scope so React keeps the resolved value across dock open/close.
const SettingsPanelLazy = lazy(loadSettingsPanel);

/** Each view gets its own width so the shell visibly adapts to what it holds.
 * Padding is deliberately not part of this — every panel shares one inset.
 *
 * The three event panels share one width on purpose: stepping detail → edit →
 * detail then animates height alone, and the shell never twitches sideways. */
function widthClass(view: DockView | null): string {
  if (!view) return "";
  if (view.kind === "account") return "w-[min(19rem,100%)]";
  // The availability panel carries a seven-row weekly grid, so it needs more
  // room than the event panels.
  if (view.kind === "availability") return "w-[min(30rem,100%)]";
  // Settings blooms widest: a sidebar beside a page-like content pane.
  if (view.kind === "settings") return "w-[min(52rem,100%)]";
  return "w-[min(27rem,100%)]";
}

/** The collapsed nav is a pill; the panels are cards, so they round less. */
function cornerRadius(view: DockView | null): number {
  return view ? 20 : 28;
}

/** Warm the settings panel's one cold query from the dock itself: the
 * subscription lives for as long as either panel is open, so the handoff
 * never depends on panel-swap animation overlap keeping a watcher mounted.
 * It renders nothing and lives outside the island's `layout` node so the
 * query resolving mid-open never re-measures the in-flight spring. */
function ConnectionsWarmup({ active }: { active: boolean }) {
  useStableQuery(
    api.domains.calendar.queries.listConnections,
    active ? {} : "skip",
  );
  return null;
}

export function BottomIsland() {
  const { view, viewId, direction, open, close, openCreate } = useDock();
  const { editing, setEditing, ready: availabilityEditReady } =
    useAvailabilityEdit();
  const reduce = useReducedMotion();

  // Warm the settings chunk once the page is idle so a cold open never
  // suspends. Fire-and-forget: a failed fetch just falls back to Suspense.
  useEffect(() => {
    const warm = () => void loadSettingsPanel().catch(() => {});
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm);
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 1_500);
    return () => window.clearTimeout(id);
  }, []);

  const availabilityOpen = view?.kind === "availability";
  const [availabilityIntentVersion, setAvailabilityIntentVersion] = useState(0);
  const [availabilityRequested, setAvailabilityRequested] = useState(false);
  const availabilityDataActive =
    availabilityOpen ||
    availabilityRequested ||
    availabilityIntentVersion > 0;
  // This stays live for the dock badge and incoming-request calendar blocks.
  const pendingBookings = useQuery(api.domains.booking.queries.listPendingBookings);
  // Warm settings on interaction intent so the dock knows its final content
  // height before its spring begins. Retain them briefly after close for a
  // smooth reopen, then release both subscriptions.
  const bookingPage = useStableQuery(
    api.domains.booking.queries.getMyBookingPage,
    availabilityDataActive ? {} : "skip",
  );
  const bookingDefaults = useStableQuery(
    api.domains.booking.queries.bookingPageDefaults,
    availabilityDataActive ? {} : "skip",
  );
  const availabilityReady =
    pendingBookings !== undefined &&
    bookingPage !== undefined &&
    (bookingPage !== null || bookingDefaults !== undefined);
  const [now, setNow] = useState(() => Date.now());
  const availabilityInstance = useRef(0);
  const activePendingBookings = pendingBookings?.filter(
    (booking) => booking.endMs > now,
  );
  const ref = useRef<HTMLElement>(null);
  const expanded = view !== null;

  const closeCurrent = close;

  useEffect(() => {
    if (
      availabilityOpen ||
      availabilityRequested ||
      availabilityIntentVersion === 0
    )
      return;
    const timeout = setTimeout(
      () => setAvailabilityIntentVersion(0),
      AVAILABILITY_PREFETCH_GRACE_MS,
    );
    return () => clearTimeout(timeout);
  }, [availabilityOpen, availabilityRequested, availabilityIntentVersion]);

  useEffect(() => {
    if (!availabilityRequested) return;
    if (view !== null) {
      setAvailabilityRequested(false);
      return;
    }
    if (!availabilityReady) return;
    setAvailabilityRequested(false);
    availabilityInstance.current += 1;
    open({ kind: "availability" });
  }, [availabilityRequested, availabilityReady, view, open]);

  const prepareAvailability = () => {
    setAvailabilityIntentVersion((version) => version + 1);
  };

  const requestAvailability = () => {
    prepareAvailability();
    if (availabilityReady) {
      availabilityInstance.current += 1;
      open({ kind: "availability" });
      return;
    }
    setAvailabilityRequested(true);
  };

  // Convex scheduled mutations remove new requests exactly at their deadline;
  // this timer gives pre-migration rows the same immediate UI behavior.
  const nextEndMs = activePendingBookings?.reduce<number | undefined>(
    (nearest, booking) =>
      nearest === undefined || booking.endMs < nearest ? booking.endMs : nearest,
    undefined,
  );
  useEffect(() => {
    if (nextEndMs === undefined) return;
    let timeout: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const remaining = nextEndMs - Date.now();
      if (remaining <= 0) {
        setNow(Date.now());
        return;
      }
      timeout = setTimeout(schedule, Math.min(remaining, MAX_TIMEOUT_MS));
    };
    schedule();
    return () => clearTimeout(timeout);
  }, [nextEndMs]);

  // No scrim, so dismissal is wired by hand: Escape, or a pointer outside the dock.
  useEffect(() => {
    if (!expanded && !editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // While painting, Escape leaves the mode (back to the panel) rather than
      // dismissing the dock outright.
      if (editing) setEditing(false);
      else closeCurrent();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return close();
      if (ref.current?.contains(target)) return;
      // Another event hands the dock straight over to its own onClick — closing
      // first would flash the nav row between the two details.
      if (target.closest("[data-event]")) return;
      // Popovers and menus opened from inside a panel (e.g. the availability
      // time picker's gooey dropdown) portal to the body, so a pointer in them
      // lands outside the dock's node. They are logically part of the dock —
      // don't dismiss on them.
      if (
        target.closest(
          "[data-slot='popover-content'],[data-slot='dropdown-menu-content'],[data-slot='goo-dropdown-content']",
        )
      )
        return;
      // Calendar chrome (the header's view switcher, prev/next, Today) runs a
      // view transition that snapshots the whole page. Dismissing here would
      // fire the dock's exit animation into that frozen frame — a choppy close.
      // Navigating the calendar leaves an open panel in place instead.
      if (target.closest("[data-dock-keep-open]")) return;
      // Do not steal focus back from the control the user clicked outside.
      close();
    };
    window.addEventListener("keydown", onKey);
    // A half-filled create/edit form is real work; only Escape or Cancel discards
    // it. While painting, the whole calendar is a valid target, so an outside
    // pointer must never dismiss the bar either.
    const frame =
      view?.kind === "create" || view?.kind === "edit" || editing
        ? null
        : // Next frame: the click that opened the dock must not immediately close it.
          requestAnimationFrame(() => {
            window.addEventListener("pointerdown", onPointerDown);
          });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [expanded, view?.kind, close, closeCurrent, editing, setEditing]);

  const variants = reduce ? dockVariantsReduced : dockVariants;

  return (
    <>
      <ConnectionsWarmup
        active={view?.kind === "account" || view?.kind === "settings"}
      />
      {/* Settings is the one view that dims the calendar behind it — a
          deliberate exception to the dock's no-scrim rule: the wide sheet
          covers enough of the grid that stray taps should dismiss, not act.
          A pointer on the scrim lands outside the dock node and closes it via
          the existing outside-pointer handler; no extra wiring. */}
      <AnimatePresence>
        {view?.kind === "settings" && (
          <motion.div
            key="settings-scrim"
            aria-hidden
            className="fixed inset-0 z-40 bg-background/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={
              reduce
                ? { duration: 0 }
                : { duration: 0.24, ease: EASE_OUT_EXPO }
            }
          />
        )}
      </AnimatePresence>
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <motion.nav
        ref={ref}
        layout
        transition={SPRING_DOCK}
        // Named as its own layer only while a calendar view transition runs, so
        // the fixed dock doesn't flicker with the root snapshot (see globals.css).
        data-dock-view-transition="bottom-island"
        // Plain style, not `animate` — `layout` rewrites borderRadius each frame
        // to correct for the box scaling, and an animated value fights that.
        style={{
          borderRadius: editing ? 28 : cornerRadius(view),
          willChange: "transform",
        }}
        className={cn(
          "pointer-events-auto overflow-hidden border border-black/20 bg-white shadow-lg dark:border-border dark:bg-popover",
          // The edit bar is a pill sized to its own content, like the nav row.
          // Settings carries its own inset so its two-tone sidebar can run
          // edge to edge (the panel restores the padding on small screens).
          editing
            ? "py-1.5 pr-1.5 pl-4"
            : view
              ? view.kind === "settings"
                ? "p-0"
                : "p-4"
              : "px-2 py-1.5",
          !editing && widthClass(view),
        )}
      >
        <motion.div layout="position">
          <AnimatePresence mode="popLayout" initial={false} custom={direction}>
            <motion.div
              key={editing ? "availability-edit" : (viewId ?? "nav")}
              custom={direction}
              variants={variants}
              initial="initial"
              animate="animate"
              exit="exit"
              style={{ willChange: "transform, filter" }}
            >
              {editing ? (
                <AvailabilityEditBar
                  ready={availabilityEditReady}
                  onDone={() => setEditing(false)}
                />
              ) : view?.kind === "event" ? (
                <EventDetail
                  event={view.event}
                  onClose={closeCurrent}
                  onEdit={() => open({ kind: "edit", event: view.event })}
                  onDuplicate={(prefill, startMs, endMs) =>
                    open({ kind: "create", startMs, endMs, prefill })
                  }
                />
              ) : view?.kind === "edit" ? (
                <EventEdit
                  event={view.event}
                  onCancel={() => open({ kind: "event", event: view.event })}
                  onSaved={() => open({ kind: "event", event: view.event })}
                />
              ) : view?.kind === "create" ? (
                <EventCreate
                  startMs={view.startMs}
                  endMs={view.endMs}
                  prefill={view.prefill}
                  // Spread the view rather than rebuilding it: reconstructing
                  // the kind would drop a duplicate's prefill on the first
                  // wheel turn.
                  onChangeRange={(startMs, endMs) =>
                    open({ ...view, startMs, endMs })
                  }
                  onCancel={closeCurrent}
                  onCreated={closeCurrent}
                />
              ) : view?.kind === "account" ? (
                <AccountPanel
                  onClose={closeCurrent}
                  onOpenSettings={() => open({ kind: "settings" })}
                />
              ) : view?.kind === "settings" ? (
                <Suspense
                  fallback={
                    <div className="flex h-96 items-center justify-center">
                      <Spinner className="size-5" />
                    </div>
                  }
                >
                  <SettingsPanelLazy
                    initialSection={view.section}
                    onClose={closeCurrent}
                  />
                </Suspense>
              ) : view?.kind === "availability" ? (
                <AvailabilityPanel
                  key={availabilityInstance.current}
                  pendingBookings={activePendingBookings}
                  page={bookingPage}
                  defaults={bookingDefaults}
                  onClose={closeCurrent}
                />
              ) : view?.kind === "booking" ? (
                <BookingRequestPanel
                  booking={view.booking}
                  onClose={closeCurrent}
                />
              ) : (
                <NavRow
                  pendingCount={activePendingBookings?.length ?? 0}
                  onOpenAccount={() => open({ kind: "account" })}
                  onCreate={openCreate}
                  availabilityLoading={availabilityRequested}
                  onPrepareAvailability={prepareAvailability}
                  onOpenAvailability={requestAvailability}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </motion.div>
      </motion.nav>
      </div>
    </>
  );
}

/** The dock's face while painting availability: the same island, morphed into a
 * heads-up bar. Done leaves the mode, and the booking-link panel underneath
 * takes the dock back. */
function AvailabilityEditBar({
  ready,
  onDone,
}: {
  ready: boolean;
  onDone: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5 whitespace-nowrap">
      {ready ? (
        <HugeiconsIcon
          icon={Cursor02Icon}
          strokeWidth={2}
          className="size-4 shrink-0 text-chart-2"
        />
      ) : (
        <Spinner />
      )}
      <p className="text-sm">
        <span className="font-medium">
          {ready ? "Setting availability" : "Loading availability"}
        </span>
        {ready && (
          <span className="hidden text-muted-foreground sm:inline">
            {" · "}drag a day to add, click a block to remove
          </span>
        )}
      </p>
      <Button
        type="button"
        size="sm"
        className="rounded-full"
        onClick={onDone}
      >
        Done
      </Button>
    </div>
  );
}

function NavRow({
  pendingCount,
  availabilityLoading,
  onOpenAccount,
  onCreate,
  onPrepareAvailability,
  onOpenAvailability,
}: {
  pendingCount: number;
  availabilityLoading: boolean;
  onOpenAccount: () => void;
  onCreate: () => void;
  onPrepareAvailability: () => void;
  onOpenAvailability: () => void;
}) {
  const { sync, isSyncing } = useSyncNow();

  return (
    <div className="flex items-center gap-1">
      <NavButton
        icon={Calendar03Icon}
        label={isSyncing ? "Syncing calendar" : "Sync calendar"}
        active
        busy={isSyncing}
        onClick={sync}
      />
      <NavButton icon={Search01Icon} label="Search" />
      <NavButton icon={PlusSignIcon} label="Create" onClick={onCreate} />
      <NavButton
        icon={TimeScheduleIcon}
        label={
          pendingCount > 0
            ? `Booking link · ${pendingCount} pending`
            : "Booking link"
        }
        badge={pendingCount}
        busy={availabilityLoading}
        onIntent={onPrepareAvailability}
        onClick={onOpenAvailability}
      />

      <div className="mx-1 h-6 w-px bg-border" />

      <button
        type="button"
        aria-label="Account"
        onClick={onOpenAccount}
        className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <UserAvatar className="size-8" />
      </button>
    </div>
  );
}

function NavButton({
  icon,
  label,
  active,
  busy,
  badge,
  onIntent,
  onClick,
}: {
  icon: IconSvgElement;
  label: string;
  active?: boolean;
  busy?: boolean;
  /** A count worth interrupting for, shown as a dot on the icon. 0 hides it. */
  badge?: number;
  onIntent?: () => void;
  onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        aria-current={active ? "page" : undefined}
        aria-busy={busy || undefined}
        disabled={busy}
        onPointerEnter={onIntent}
        onPointerDown={onIntent}
        onFocus={onIntent}
        onClick={onClick}
        className={cn(
          "relative flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground",
          active && "rounded-l-2xl rounded-r-lg bg-accent text-foreground",
        )}
      >
        {busy ? (
          <Spinner className="size-5" />
        ) : (
          <HugeiconsIcon icon={icon} strokeWidth={2} className="size-5" />
        )}
        {badge ? (
          <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] leading-none font-medium text-primary-foreground">
            {badge > 9 ? "9+" : badge}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
