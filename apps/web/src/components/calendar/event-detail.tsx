import {
  ArrowLeft01Icon,
  Cancel01Icon,
  Clock01Icon,
  Copy01Icon,
  Link01Icon,
  LinkSquare02Icon,
  Location01Icon,
  PencilEdit02Icon,
  RepeatIcon,
  SquareLock01Icon,
  TextAlignLeft01Icon,
  UserMultiple02Icon,
  Video01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { Button } from "@qali/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@qali/ui/components/tooltip";
import { cn } from "@qali/ui/lib/utils";
import { useAction, useQuery } from "convex/react";
import { format, formatDistanceToNowStrict, isSameDay } from "date-fns";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Avatar } from "./avatar";
import { calendarColorVar, useEventColor } from "./colors";
import { buttonClass } from "./event-controls";
import type { EventPrefill } from "./event-create";
import {
  GuestRow,
  groupGuests,
  rsvpColorVar,
  rsvpSummary,
  type Guest,
} from "./guest-picker";
import { calendarDisplayName, type CalendarEvent } from "./lib";
import { dockVariants, dockVariantsReduced, press, SPRING_DOCK } from "./motion";
import { useEventCapabilities } from "./permissions";
import { RichTextView } from "./rich-text/rich-text-view";
import { htmlToPreviewText } from "./rich-text/text";

/** How many avatars to show before collapsing the rest into a "+N" bubble. */
const MAX_AVATARS = 6;

/** How long the delete button waits for its second click before reverting. */
const CONFIRM_TIMEOUT_MS = 3000;

const RSVP_CHOICES = [
  { status: "accepted", label: "Going" },
  { status: "tentative", label: "Maybe" },
  { status: "declined", label: "No" },
] as const;

function timeText(event: CalendarEvent): string {
  if (event.allDay) {
    // Google all-day endMs is exclusive midnight.
    const lastDay = event.endMs - 1;
    return isSameDay(event.startMs, lastDay)
      ? format(event.startMs, "EEE d MMM")
      : `${format(event.startMs, "EEE d MMM")} – ${format(lastDay, "EEE d MMM")}`;
  }
  const end = format(
    event.endMs,
    isSameDay(event.startMs, event.endMs) ? "h:mm a" : "EEE d MMM, h:mm a",
  );
  return `${format(event.startMs, "EEE d MMM, h:mm a")} – ${end}`;
}

function DetailRow({
  icon,
  children,
}: {
  icon: IconSvgElement;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 text-sm text-muted-foreground">
      <HugeiconsIcon
        icon={icon}
        strokeWidth={2}
        className="mt-0.5 size-4.5 shrink-0"
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** A tooltipped icon button, matching the colour/calendar controls in the form
 * so the two panels' footers read as one row of the same thing. */
function IconAction({
  icon,
  label,
  onClick,
  href,
}: {
  icon: IconSvgElement;
  label: string;
  onClick?: () => void;
  href?: string;
}) {
  const content = <HugeiconsIcon icon={icon} strokeWidth={2} className="size-4.5" />;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          href ? (
            <a href={href} target="_blank" rel="noreferrer" aria-label={label} className={buttonClass} />
          ) : (
            <button type="button" onClick={onClick} aria-label={label} className={buttonClass} />
          )
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Guests as an overlapping avatar stack that expands into the same rows the
 * guest picker uses. Each avatar carries a dot in its answer's colour, so the
 * shape of the RSVPs is readable without expanding anything. */
function GuestSection({
  guests,
  hidden,
}: {
  guests: Guest[];
  hidden: boolean;
}) {
  const reduce = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const contacts = useQuery(api.contacts.listContacts) ?? [];

  // Attendees carry no photo, so fill them in from synced contacts by email.
  const enriched = useMemo(() => {
    const photos = new Map<string, string>();
    for (const c of contacts) {
      if (!c.photoUrl) continue;
      for (const email of c.emails) photos.set(email.toLowerCase(), c.photoUrl);
    }
    return guests.map((g) => ({
      ...g,
      photoUrl: g.photoUrl ?? photos.get(g.email.toLowerCase()),
    }));
  }, [guests, contacts]);

  if (hidden) {
    return (
      <DetailRow icon={UserMultiple02Icon}>
        Guest list hidden by the organiser
      </DetailRow>
    );
  }

  const shown = enriched.slice(0, MAX_AVATARS);
  const overflow = enriched.length - shown.length;

  return (
    <DetailRow icon={UserMultiple02Icon}>
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          className="flex flex-col items-start gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex items-center">
            {shown.map((g) => (
              <span
                key={g.email}
                className="relative -ml-1.5 rounded-full ring-2 ring-popover first:ml-0"
              >
                <Avatar
                  email={g.email}
                  name={g.displayName}
                  photoUrl={g.photoUrl}
                  className="size-6"
                />
                <span
                  className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-popover"
                  style={{ backgroundColor: `var(${rsvpColorVar(g)})` }}
                />
              </span>
            ))}
            {overflow > 0 && (
              <span className="-ml-1.5 flex size-6 items-center justify-center rounded-full bg-muted text-[0.625rem] font-semibold text-muted-foreground ring-2 ring-popover">
                +{overflow}
              </span>
            )}
          </span>
          <span className="text-xs">{rsvpSummary(enriched)}</span>
        </button>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="guests"
              initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={SPRING_DOCK}
              className="overflow-hidden"
            >
              <div className="flex max-h-56 flex-col gap-3 overflow-y-auto pt-1">
                {groupGuests(enriched).map((group) => (
                  <div key={group.label} className="flex flex-col gap-0.5">
                    <p className="px-1 text-xs font-medium">
                      {group.guests.length} {group.label}
                    </p>
                    {group.guests.map((g) => (
                      <GuestRow key={g.email} guest={g} />
                    ))}
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </DetailRow>
  );
}

/** Answer an invitation. Deliberately the same segmented control as the form's
 * Starts/Ends tabs — when you're a guest this is the panel's primary action. */
function RsvpControl({
  event,
  current,
}: {
  event: CalendarEvent;
  current?: string;
}) {
  const respond = useAction(api.calendar.respondToEvent);
  // Held only until the synced row catches up, so the segment moves on click
  // rather than after the round trip to Google.
  const [optimistic, setOptimistic] = useState<string>();
  const active = optimistic ?? current;

  // Once the live row agrees, drop the override — otherwise it would outrank a
  // later answer made elsewhere, and this panel would show a stale one forever.
  useEffect(() => {
    if (optimistic !== undefined && current === optimistic) {
      setOptimistic(undefined);
    }
  }, [current, optimistic]);

  const choose = (status: (typeof RSVP_CHOICES)[number]["status"]) => {
    if (status === active) return;
    setOptimistic(status);
    respond({ eventId: event._id, responseStatus: status }).catch(
      (error: unknown) => {
        setOptimistic(undefined);
        toast.error("Couldn't send your reply", {
          description: error instanceof Error ? error.message : undefined,
        });
      },
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted-foreground">Are you going?</p>
      <div className="flex gap-1 rounded-xl bg-muted p-1">
        {RSVP_CHOICES.map((choice) => (
          <motion.button
            key={choice.status}
            type="button"
            aria-pressed={active === choice.status}
            onClick={() => choose(choice.status)}
            {...press}
            className={cn(
              "flex-1 rounded-lg px-3 py-1.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active === choice.status
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {choice.label}
          </motion.button>
        ))}
      </div>
    </div>
  );
}

/** Two-step delete. There is no dialog primitive here and the dock has no modal
 * layer, so the button confirms on itself: the first click arms it, and it
 * disarms on its own if the second never comes. */
function DeleteButton({
  label,
  destructive,
  onConfirm,
}: {
  label: string;
  destructive: boolean;
  /** Resolves when the delete lands; rejects so the button can re-arm. */
  onConfirm: () => Promise<unknown>;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <Button
      type="button"
      size="sm"
      variant={armed && destructive ? "destructive" : "ghost"}
      disabled={busy}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setBusy(true);
        // A refused delete has to leave a usable button behind.
        onConfirm().catch(() => {
          setBusy(false);
          setArmed(false);
        });
      }}
    >
      {armed ? "Confirm?" : label}
    </Button>
  );
}

export function EventDetail({
  event: snapshot,
  onClose,
  onEdit,
  onDuplicate,
}: {
  event: CalendarEvent;
  onClose: () => void;
  onEdit: () => void;
  onDuplicate: (prefill: EventPrefill, startMs: number, endMs: number) => void;
}) {
  const reduce = useReducedMotion();
  const deleteEvent = useAction(api.calendar.deleteEvent);
  const calendars = useQuery(api.calendar.listCalendars) ?? [];
  // The dock hands us the row as it was when the event was opened. Subscribing
  // to it means an edit or an RSVP lands in the open panel; the snapshot only
  // covers the first frame, before the query resolves.
  const live = useQuery(api.calendar.getEventById, { eventId: snapshot._id });
  const event = live ?? snapshot;

  const colorVar = useEventColor()(event);
  const capabilities = useEventCapabilities()(event);
  const calendar = calendars.find(
    (c) => c.googleCalendarId === event.calendarId,
  );

  const [screen, setScreen] = useState<"main" | "description">("main");
  const mainRef = useRef<HTMLDivElement>(null);
  const [mainHeight, setMainHeight] = useState<number>();

  const guests: Guest[] = (event.attendees ?? []).map((a) => ({
    email: a.email,
    displayName: a.displayName,
    responseStatus: a.responseStatus,
    organizer: a.organizer,
  }));

  const remove = () =>
    deleteEvent({ eventId: event._id })
      .then(onClose)
      .catch((error: unknown) => {
        toast.error("Couldn't remove event", {
          description: error instanceof Error ? error.message : undefined,
        });
        throw error;
      });

  const duplicate = () => {
    onDuplicate(
      {
        summary: event.summary ?? "",
        description: event.description ?? "",
        location: event.location ?? "",
        allDay: event.allDay,
        isPrivate: event.visibility === "private",
        busy: event.transparency !== "transparent",
        colorId: event.colorId,
        calendarId: event.calendarId,
        // A copy's invitees start unasked — carrying answers across would claim
        // replies to an event that doesn't exist yet.
        guests: guests.map((g) => ({
          email: g.email,
          displayName: g.displayName,
        })),
      },
      event.startMs,
      event.endMs,
    );
  };

  const copyLink = () => {
    if (!event.htmlLink) return;
    navigator.clipboard
      .writeText(event.htmlLink)
      .then(() => toast.success("Link copied"))
      .catch(() => toast.error("Couldn't copy the link"));
  };

  const copyMeetLink = () => {
    if (!event.hangoutLink) return;
    navigator.clipboard
      .writeText(event.hangoutLink)
      .then(() => toast.success("Meet link copied"))
      .catch(() => toast.error("Couldn't copy the link"));
  };

  const variants = reduce ? dockVariantsReduced : dockVariants;

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
            {event.summary ?? "(No title)"}
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto text-sm">
            <RichTextView html={event.description ?? ""} />
          </div>
        </motion.div>
      ) : (
        <motion.div
          key="main"
          ref={mainRef}
          custom={-1}
          variants={variants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="flex flex-col gap-3"
        >
          <div className="flex items-start gap-3">
            {/* A color strip on the left, matching the event cards on the grid
                (event-card.tsx) rather than a lone dot. */}
            <span
              aria-hidden
              className="w-[3px] shrink-0 self-stretch rounded-full"
              style={{ backgroundColor: `var(${colorVar})` }}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="line-clamp-2 text-base font-semibold leading-tight">
                {event.summary ?? "(No title)"}
              </p>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {calendar && (
                  <>
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: `var(${calendarColorVar(calendar)})`,
                      }}
                    />
                    <span className="truncate">
                      {calendarDisplayName(calendar)}
                    </span>
                    <span aria-hidden>·</span>
                  </>
                )}
                <span>
                  {event.transparency === "transparent" ? "Free" : "Busy"}
                </span>
                {event.visibility === "private" && (
                  <HugeiconsIcon
                    icon={SquareLock01Icon}
                    strokeWidth={2}
                    className="size-3.5 shrink-0"
                  />
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mt-0.5 -mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
            </button>
          </div>

          <DetailRow icon={Clock01Icon}>
            <p className="text-sm font-medium text-foreground">
              {timeText(event)}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatDistanceToNowStrict(event.startMs, { addSuffix: true })}
            </p>
          </DetailRow>

          {event.recurringEventId && (
            <DetailRow icon={RepeatIcon}>Part of a repeating series</DetailRow>
          )}

          {event.hangoutLink && (
            <div className="flex items-center gap-3">
              <HugeiconsIcon
                icon={Video01Icon}
                strokeWidth={2}
                className="mt-0.5 size-4.5 shrink-0 self-start text-emerald-600 dark:text-emerald-400"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  Google Meet
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {event.hangoutLink.replace(/^https?:\/\//, "")}
                </p>
              </div>
              <IconAction
                icon={Copy01Icon}
                label="Copy Meet link"
                onClick={copyMeetLink}
              />
              <Button
                size="sm"
                render={
                  <a
                    href={event.hangoutLink}
                    target="_blank"
                    rel="noreferrer"
                  />
                }
                className="bg-emerald-600 text-white hover:bg-emerald-600/90 dark:bg-emerald-500 dark:hover:bg-emerald-500/90"
              >
                <HugeiconsIcon
                  icon={Video01Icon}
                  strokeWidth={2}
                  className="size-4"
                />
                Join
              </Button>
            </div>
          )}

          {event.location && (
            <DetailRow icon={Location01Icon}>
              <a
                href={
                  /^https?:\/\//i.test(event.location)
                    ? event.location
                    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`
                }
                target="_blank"
                rel="noreferrer"
                className="underline-offset-4 hover:underline"
              >
                {event.location}
              </a>
            </DetailRow>
          )}

          {guests.length > 0 && (
            <GuestSection guests={guests} hidden={!capabilities.canSeeGuests} />
          )}

          {event.description && (
            <DetailRow icon={TextAlignLeft01Icon}>
              <button
                type="button"
                onClick={() => {
                  setMainHeight(mainRef.current?.offsetHeight);
                  setScreen("description");
                }}
                className="-mx-1 line-clamp-4 rounded px-1 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {htmlToPreviewText(event.description)}
              </button>
            </DetailRow>
          )}

          {capabilities.canRespond && (
            <RsvpControl event={event} current={capabilities.selfResponse} />
          )}

          <div className="flex items-center justify-between gap-2 -mb-2">
            <div className="flex items-center gap-1 border-2 rounded-xl -ml-2">
              {event.htmlLink && (
                <IconAction icon={Link01Icon} label="Copy link" onClick={copyLink} />
              )}
              <IconAction icon={Copy01Icon} label="Duplicate" onClick={duplicate} />
              {event.htmlLink && (
                <IconAction
                  icon={LinkSquare02Icon}
                  label="Open in Google Calendar"
                  href={event.htmlLink}
                />
              )}
            </div>

            <div className="flex items-center gap-2 -mr-2">
              {(capabilities.canDelete || capabilities.canRemoveSelf) && (
                <DeleteButton
                  label={
                    capabilities.canDelete ? "Delete" : "Remove from my calendar"
                  }
                  destructive={capabilities.canDelete}
                  onConfirm={remove}
                />
              )}
              {capabilities.canEdit && (
                <Button type="button" size="sm" onClick={onEdit}>
                  <HugeiconsIcon
                    icon={PencilEdit02Icon}
                    strokeWidth={2}
                    className="size-4"
                  />
                  Edit
                </Button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
