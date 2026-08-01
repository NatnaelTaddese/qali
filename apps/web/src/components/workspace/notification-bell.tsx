import {
  Cancel01Icon,
  Notification01Icon,
  TickDouble01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import type { Doc, Id } from "@qali/backend/convex/_generated/dataModel";
import { GooDropdown } from "@qali/ui/components/ui/goo-dropdown";
import { cn } from "@qali/ui/lib/utils";
import { useMutation } from "convex/react";
import { formatDistanceToNowStrict } from "date-fns";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";

import { useStableQuery } from "@/components/calendar/use-stable-query";
import type { Booking } from "@/components/workspace/booking-request-panel";
import { useDock } from "@/components/workspace/dock-context";

type NotificationRow = Doc<"notifications"> & { booking: Booking | null };

// Panel geometry. The panel body is sized at open time from the current list, so
// a short feed opens compact and a long one caps and scrolls.
const PANEL_WIDTH = 360;
const HEADER_HEIGHT = 40;
const ITEM_HEIGHT = 76;
const EMPTY_HEIGHT = 92;
const MAX_VISIBLE = 4;

function panelBodyHeight(count: number): number {
  const listHeight =
    count === 0 ? EMPTY_HEIGHT : Math.min(count, MAX_VISIBLE) * ITEM_HEIGHT;
  return HEADER_HEIGHT + listHeight;
}

export function NotificationBell() {
  const notifications =
    (useStableQuery(api.notifications.list) as NotificationRow[] | undefined) ??
    [];
  const unread = useStableQuery(api.notifications.unreadCount) ?? 0;

  const markRead = useMutation(api.notifications.markRead);
  const markAllRead = useMutation(api.notifications.markAllRead);
  const dismiss = useMutation(api.notifications.dismiss);
  const clearAll = useMutation(api.notifications.clearAll);
  const { open } = useDock();
  // The badge lives outside the morphing panel's clip region, so it only renders
  // while the dropdown is closed — where it can't be cut off (and where a
  // primary-on-primary badge wouldn't be legible anyway).
  const [menuOpen, setMenuOpen] = useState(false);
  const reduce = useReducedMotion();

  const badge = unread > 9 ? "9+" : String(unread);

  const trigger = (
    <span className="relative flex size-5 items-center justify-center">
      <HugeiconsIcon icon={Notification01Icon} strokeWidth={2} className="size-5" />
      <AnimatePresence>
        {unread > 0 && !menuOpen && (
          <motion.span
            key="badge"
            // Anchored bottom-left so it springs out of the corner that meets
            // the bell, and retracts back into it.
            initial={reduce ? { opacity: 0 } : { scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { scale: 0, opacity: 0 }}
            transition={
              reduce
                ? { duration: 0.15 }
                : { type: "spring", stiffness: 520, damping: 24 }
            }
            style={{ transformOrigin: "bottom left" }}
            className="absolute -top-2 -right-2 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] leading-none font-medium text-primary-foreground"
          >
            {badge}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );

  const onOpenItem = (notification: NotificationRow, close: () => void) => {
    if (!notification.read) void markRead({ notificationId: notification._id });
    const booking = notification.booking;
    // A resolved request has nothing left to act on — leave it in the feed but
    // don't yank the dock open onto a stale panel.
    if (booking && booking.status === "pending") {
      close();
      open({ kind: "booking", booking });
    }
  };

  const onDismiss = (id: Id<"notifications">) => {
    void dismiss({ notificationId: id });
  };

  const panelContent = (close: () => void) => (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="text-sm font-semibold">Notifications</span>
        {notifications.length > 0 && (
          <div className="flex items-center gap-0.5">
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs opacity-70 transition hover:bg-[var(--goo-hover-fill)] hover:opacity-100"
              >
                <HugeiconsIcon
                  icon={TickDouble01Icon}
                  strokeWidth={2}
                  className="size-3.5"
                />
                Mark all read
              </button>
            )}
            <button
              type="button"
              onClick={() => void clearAll()}
              className="rounded-md px-1.5 py-1 text-xs opacity-70 transition hover:bg-[var(--goo-hover-fill)] hover:opacity-100"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {notifications.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
          <HugeiconsIcon
            icon={Notification01Icon}
            strokeWidth={2}
            className="size-5 opacity-40"
          />
          <p className="text-sm opacity-60">You&rsquo;re all caught up</p>
        </div>
      ) : (
        <div
          className="flex-1 overflow-y-auto"
          style={{ scrollbarWidth: "thin" }}
        >
          <AnimatePresence initial={false}>
            {notifications.map((notification) => (
              <NotificationItem
                key={notification._id}
                notification={notification}
                onOpen={() => onOpenItem(notification, close)}
                onDismiss={() => onDismiss(notification._id)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );

  return (
    <GooDropdown
      trigger={trigger}
      triggerLabel={
        unread > 0 ? `Notifications, ${unread} unread` : "Notifications"
      }
      menuLabel="Notifications"
      panelContent={panelContent}
      contentHeight={panelBodyHeight(notifications.length)}
      onOpenChange={setMenuOpen}
      triggerSound={false}
      align="end"
      side="bottom"
      gap={4}
      width={PANEL_WIDTH}
      buttonRadius={10}
      panelRadius={18}
      fill="transparent"
      foreground="var(--muted-foreground)"
      hoverFill="var(--accent)"
      activeFill="var(--primary)"
      activeForeground="var(--primary-foreground)"
      activeHoverFill="color-mix(in oklch, var(--primary-foreground) 14%, var(--primary))"
      triggerClassName="w-8 !px-0 rounded-lg hover:bg-accent"
    />
  );
}

function NotificationItem({
  notification,
  onOpen,
  onDismiss,
}: {
  notification: NotificationRow;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const reduce = useReducedMotion();
  const actionable =
    notification.booking != null && notification.booking.status === "pending";
  return (
    <motion.div
      layout
      // Collapse the row's height as it leaves and slide it out to the right, so
      // the list closes the gap instead of the item just vanishing.
      initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, height: ITEM_HEIGHT }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0, x: 28 }}
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
      style={{ overflow: "hidden" }}
    >
      <div
        className={cn(
          "group relative flex gap-2.5 rounded-[12px] px-2 py-2 transition-colors hover:bg-[var(--goo-hover-fill)]",
          actionable && "cursor-pointer",
        )}
        style={{ height: ITEM_HEIGHT }}
        onClick={actionable ? onOpen : undefined}
        role={actionable ? "button" : undefined}
        tabIndex={actionable ? 0 : undefined}
        onKeyDown={
          actionable
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpen();
                }
              }
            : undefined
        }
      >
        <span
          className={cn(
            "mt-1.5 size-2 shrink-0 rounded-full",
            notification.read ? "bg-transparent" : "bg-current",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{notification.title}</p>
          {notification.body && (
            <p className="truncate text-xs opacity-70">{notification.body}</p>
          )}
          <p className="mt-0.5 text-[11px] opacity-50">
            {formatDistanceToNowStrict(notification.createdAt, {
              addSuffix: true,
            })}
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
          className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-0 transition hover:bg-[var(--goo-hover-fill)] focus-visible:opacity-100 group-hover:opacity-70 hover:!opacity-100"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
        </button>
      </div>
    </motion.div>
  );
}
