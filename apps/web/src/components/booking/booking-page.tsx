import { Clock01Icon, GlobalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { Button } from "@qali/ui/components/button";
import { Input } from "@qali/ui/components/input";
import { Spinner } from "@qali/ui/components/spinner";
import { Textarea } from "@qali/ui/components/textarea";
import { cn } from "@qali/ui/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { format } from "date-fns";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Avatar } from "@/components/calendar/avatar";
import { EASE_OUT_EXPO, SPRING_DOCK } from "@/components/calendar/motion";

import { BookingConfirmation } from "./booking-confirmation";
import { CalendarBackdrop } from "./calendar-backdrop";
import { bookingRequestErrorMessage } from "./request-error";
import { SlotPicker, VISITOR_TIME_ZONE, visitorZoneLabel } from "./slot-picker";
import { formatTime, storeUse24Hour, storedUse24Hour } from "./time-format";

const MS_PER_HOUR = 60 * 60 * 1000;
/** How far ahead the picker asks for. The server clamps at 35 days and applies
 * the host's own horizon, so this is only how much we render at once. */
const WINDOW_DAYS = 28;

/**
 * The public booking page at `/<slug>`. Reachable with no account: the two
 * queries behind it are anonymous, and they hand back the host's display name
 * and a list of open instants — never anything about what fills the rest of
 * their calendar.
 */
export function BookingPage({
  slug,
  token,
  onTokenChange,
}: {
  slug: string;
  /** Set once a request exists, so a refresh returns to the confirmation. */
  token: string | null;
  onTokenChange: (token: string | null) => void;
}) {
  const page = useQuery(api.domains.booking.queries.getPublicPage, { slug });
  const [nowMs, setNowMs] = useState(Date.now);
  // Refresh min-notice/horizon filtering without creating a millisecond-level
  // stream of query arguments. One minute is tighter than the smallest slot.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const fromMs = Math.floor(nowMs / MS_PER_HOUR) * MS_PER_HOUR;
  const availability = useQuery(
    api.domains.booking.queries.listSlots,
    page
      ? {
          slug,
          fromMs,
          toMs: fromMs + WINDOW_DAYS * 24 * MS_PER_HOUR,
          nowMs,
        }
      : "skip",
  );
  const requestBooking = useMutation(api.domains.booking.mutations.requestBooking);

  const reduceMotion = useReducedMotion();
  const [use24Hour, setUse24Hour] = useState(storedUse24Hour);
  const toggleTimeFormat = () =>
    setUse24Hour((prev) => {
      const next = !prev;
      storeUse24Hour(next);
      return next;
    });
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // The slot list is a live subscription, so a slot the visitor has already
  // picked can be taken by someone else — or by the host's own calendar — while
  // they are still typing their name. Drop the selection when that happens
  // instead of letting them submit into a refusal.
  useEffect(() => {
    if (selectedSlot === null || submitting || token) return;
    if (!availability) return;
    const slot = availability.slots.find((s) => s.startMs === selectedSlot);
    if (slot?.available) return;
    setSelectedSlot(null);
    toast.info("That time was just taken", {
      description: "Please pick another one.",
    });
  }, [availability, selectedSlot, submitting, token]);

  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canSubmit =
    selectedSlot !== null &&
    name.trim().length > 0 &&
    emailLooksValid &&
    !submitting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || selectedSlot === null) return;
    setSubmitting(true);
    try {
      const { token: newToken } = await requestBooking({
        slug,
        startMs: selectedSlot,
        name: name.trim(),
        email: email.trim(),
        note: note.trim() || undefined,
        timeZone: VISITOR_TIME_ZONE,
      });
      // Stay in the submitting state through the hand-off to the confirmation.
      // The booking just made this slot unavailable, and the token prop that
      // swaps the form for the confirmation arrives a render later than the
      // live availability update — resetting `submitting` here would briefly
      // re-arm the stolen-slot guard against the slot we ourselves booked and
      // fire a false "just taken" toast.
      onTokenChange(newToken);
    } catch (error: unknown) {
      setSubmitting(false);
      const message = bookingRequestErrorMessage(error);
      toast.error(message.title, { description: message.description });
    }
  };

  if (page === undefined) {
    return (
      <Shell>
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      </Shell>
    );
  }

  if (page === null) {
    return (
      <Shell>
        <div className="space-y-1 py-10 text-center">
          <p className="font-display text-xl font-bold">Nothing here</p>
          <p className="text-sm text-muted-foreground">
            This booking link doesn't exist, or it isn't taking requests.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center gap-3.5">
        <Avatar
          // The public page never sees the host's email; their display name is
          // the stable key the palette hashes on.
          email={page.displayName}
          name={page.displayName}
          photoUrl={page.imageUrl}
          className="size-14"
        />
        <div className="min-w-0">
          <p className="truncate text-sm text-muted-foreground">
            {page.displayName}
          </p>
          <p className="font-display truncate text-2xl leading-tight font-bold">
            {page.title?.trim() || `${page.slotMinutes} minute meeting`}
          </p>
        </div>
      </div>

      {page.description && (
        <p className="text-sm text-muted-foreground">{page.description}</p>
      )}

      <div className="flex flex-wrap gap-1.5">
        <MetaChip icon={Clock01Icon}>{page.slotMinutes} min</MetaChip>
        <MetaChip icon={GlobalIcon}>{visitorZoneLabel()}</MetaChip>
      </div>

      {token ? (
        <BookingConfirmation
          token={token}
          use24Hour={use24Hour}
          onStartOver={() => {
            onTokenChange(null);
            setSelectedSlot(null);
            setNote("");
            setSubmitting(false);
          }}
        />
      ) : availability === undefined ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <SlotPicker
            slots={availability.slots}
            slotMinutes={availability.slotMinutes}
            selectedSlot={selectedSlot}
            onSelect={setSelectedSlot}
            use24Hour={use24Hour}
            onToggleTimeFormat={toggleTimeFormat}
          />

          <AnimatePresence initial={false}>
            {selectedSlot !== null && (
              <motion.div
                key="details"
                variants={reduceMotion ? revealReduced : reveal}
                initial="initial"
                animate="animate"
                exit="exit"
                className="space-y-2 border-t border-border pt-4"
              >
                <p className="text-sm font-medium">
                  {format(selectedSlot, "EEEE, MMMM d")} at{" "}
                  {formatTime(selectedSlot, use24Hour)}
                </p>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  aria-label="Your name"
                  autoComplete="name"
                  required
                />
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  aria-label="Your email"
                  autoComplete="email"
                  required
                />
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What's it about? (optional)"
                  aria-label="Message"
                  rows={3}
                />
                <Button
                  type="submit"
                  size="lg"
                  className={cn("w-full", submitting && "opacity-80")}
                  disabled={!canSubmit}
                >
                  {submitting && <Spinner />}
                  {submitting ? "Sending…" : "Request this time"}
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  {page.displayName} confirms each request. You'll get the
                  invitation by email once they do.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </form>
      )}
    </Shell>
  );
}

/** The name/email/note block sliding in once a slot is chosen — a small echo of
 * the dock's blur+slide content swap (see calendar/motion.ts). */
const reveal = {
  initial: { opacity: 0, y: 8, filter: "blur(4px)" },
  animate: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.24, ease: EASE_OUT_EXPO },
  },
  exit: {
    opacity: 0,
    y: -8,
    filter: "blur(4px)",
    transition: { duration: 0.16, ease: EASE_OUT_EXPO },
  },
} as const;

const revealReduced = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.18, ease: EASE_OUT_EXPO } },
  exit: { opacity: 0, transition: { duration: 0.14, ease: EASE_OUT_EXPO } },
} as const;

/** A small pill of meeting metadata (duration, timezone) under the title. */
function MetaChip({
  icon,
  children,
}: {
  icon: IconSvgElement;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
      <HugeiconsIcon icon={icon} strokeWidth={2} className="size-3.5" />
      {children}
    </span>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const reduceMotion = useReducedMotion();
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const updateHeight = () => {
      const nextHeight = content.getBoundingClientRect().height;
      setHeight((current) => (current === nextHeight ? current : nextHeight));
    };

    if (typeof ResizeObserver === "undefined") return;

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="relative min-h-svh overflow-x-hidden overflow-y-auto bg-background">
      <CalendarBackdrop ghosts={false} />
      <div className="relative z-10 flex min-h-svh flex-col items-center justify-center gap-3 px-4 py-10">
        <motion.div
          initial={false}
          animate={height === null ? undefined : { height }}
          transition={reduceMotion ? { duration: 0 } : SPRING_DOCK}
          className="w-full max-w-md overflow-hidden rounded-4xl bg-card shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
        >
          <div ref={contentRef} className="space-y-4 p-6">
            {children}
          </div>
        </motion.div>
        <a
          href="https://calendar.myqali.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground transition-colors hover:text-link"
        >
          Powered by <span className="font-display font-bold">qali</span>
        </a>
      </div>
    </div>
  );
}
