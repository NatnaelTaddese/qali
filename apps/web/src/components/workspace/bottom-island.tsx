import {
  Calendar03Icon,
  Menu01Icon,
  PlusSignIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@qali/ui/components/tooltip";
import { cn } from "@qali/ui/lib/utils";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

import { EventCreate } from "@/components/calendar/event-create";
import { EventDetail } from "@/components/calendar/event-detail";
import {
  dockVariants,
  dockVariantsReduced,
  SPRING_DOCK,
} from "@/components/calendar/motion";
import { authClient } from "@/lib/auth-client";
import { AccountPanel } from "./account-panel";
import { useDock, type DockView } from "./dock-context";

/** Each view gets its own width so the shell visibly adapts to what it holds. */
function widthClass(view: DockView | null): string {
  if (!view) return "px-2 py-1.5";
  if (view.kind === "account") return "w-[min(19rem,100%)] p-4";
  if (view.kind === "create") return "w-[min(22rem,100%)] p-4";
  return "w-[min(26rem,100%)] p-4";
}

export function BottomIsland() {
  const { view, viewId, direction, open, close } = useDock();
  const reduce = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const expanded = view !== null;

  // No scrim, so dismissal is wired by hand: Escape, or a pointer outside the dock.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return close();
      if (ref.current?.contains(target)) return;
      // Another event hands the dock straight over to its own onClick — closing
      // first would flash the nav row between the two details.
      if (target.closest("[data-event]")) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    // A half-filled create form is real work; only Escape or Cancel discards it.
    const frame =
      view?.kind === "create"
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
  }, [expanded, view?.kind, close]);

  const variants = reduce ? dockVariantsReduced : dockVariants;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <motion.nav
        ref={ref}
        layout
        transition={SPRING_DOCK}
        style={{ borderRadius: 28 }}
        className={cn(
          "pointer-events-auto overflow-hidden border border-border bg-popover/90 shadow-lg backdrop-blur",
          widthClass(view),
        )}
      >
        <motion.div layout="position">
          <AnimatePresence mode="popLayout" initial={false} custom={direction}>
            <motion.div
              key={viewId ?? "nav"}
              custom={direction}
              variants={variants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              {view?.kind === "event" ? (
                <EventDetail event={view.event} onClose={close} />
              ) : view?.kind === "create" ? (
                <EventCreate
                  startMs={view.startMs}
                  endMs={view.endMs}
                  onChangeRange={(startMs, endMs) =>
                    open({ kind: "create", startMs, endMs })
                  }
                  onCancel={close}
                  onCreated={close}
                />
              ) : view?.kind === "account" ? (
                <AccountPanel onClose={close} />
              ) : (
                <NavRow onOpenAccount={() => open({ kind: "account" })} />
              )}
            </motion.div>
          </AnimatePresence>
        </motion.div>
      </motion.nav>
    </div>
  );
}

function NavRow({ onOpenAccount }: { onOpenAccount: () => void }) {
  const { data: session } = authClient.useSession();
  const user = session?.user;
  const initial = (user?.name ?? user?.email ?? "?").charAt(0).toUpperCase();

  return (
    <div className="flex items-center gap-1">
      <NavButton icon={Calendar03Icon} label="Calendar" active />
      <NavButton icon={Menu01Icon} label="Agenda" />
      <NavButton icon={Search01Icon} label="Search" />
      <NavButton icon={PlusSignIcon} label="Create" />

      <div className="mx-1 h-6 w-px bg-border" />

      <button
        type="button"
        aria-label="Account"
        onClick={onOpenAccount}
        className="flex size-8 items-center justify-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground ring-1 ring-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {user?.image ? (
          <img src={user.image} alt="" className="size-full rounded-full object-cover" />
        ) : (
          initial
        )}
      </button>
    </div>
  );
}

function NavButton({
  icon,
  label,
  active,
}: {
  icon: IconSvgElement;
  label: string;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground",
          active && "bg-accent text-foreground",
        )}
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} className="size-5" />
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
