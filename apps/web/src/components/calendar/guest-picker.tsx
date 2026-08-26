import { Cancel01Icon, Crown02Icon, UserMultiple02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@qali/ui/components/popover";
import { cn } from "@qali/ui/lib/utils";
import { useQuery } from "convex/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo, useRef, useState, type ReactNode } from "react";

import { authClient } from "@/lib/auth-client";

import { Avatar } from "./avatar";
import { SPRING_DOCK } from "./motion";

export interface Guest {
  email: string;
  displayName?: string;
  /** Local only (for the chip avatar); not sent to the backend. */
  photoUrl?: string;
  /** "needsAction" | "declined" | "tentative" | "accepted". Absent while
   * creating — nobody has been asked yet. */
  responseStatus?: string;
  organizer?: boolean;
}

/** A contact flattened to one suggestion per email address. */
interface Suggestion {
  email: string;
  displayName?: string;
  photoUrl?: string;
}

/** Deliberately loose — Google validates for real; this only gates the "add
 * what I typed" affordance so we never submit obvious non-emails. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_SUGGESTIONS = 6;

/** RSVP buckets, in the order Google itself lists them. Each carries the
 * palette variable its status dot uses, so a guest reads the same in the
 * picker's list and on the detail view's avatar stack. */
const RSVP_GROUPS = [
  { key: "accepted", label: "Going", colorVar: "--event-4" },
  { key: "tentative", label: "Maybe", colorVar: "--event-3" },
  { key: "declined", label: "Not going", colorVar: "--destructive" },
  { key: "needsAction", label: "Awaiting", colorVar: "--muted-foreground" },
] as const;

/** Anything unset or unrecognised counts as not having answered yet. */
function bucketOf(guest: Guest): string {
  return guest.responseStatus === "accepted" ||
    guest.responseStatus === "tentative" ||
    guest.responseStatus === "declined"
    ? guest.responseStatus
    : "needsAction";
}

export interface GuestGroup {
  label: string;
  colorVar: string;
  guests: Guest[];
}

/** Split guests into their RSVP buckets, dropping the empty ones. */
export function groupGuests(guests: Guest[]): GuestGroup[] {
  return RSVP_GROUPS.map(({ key, label, colorVar }) => ({
    label,
    colorVar,
    guests: guests.filter((g) => bucketOf(g) === key),
  })).filter((group) => group.guests.length > 0);
}

/** The palette variable for one guest's answer. */
export function rsvpColorVar(guest: Guest): string {
  const bucket = bucketOf(guest);
  return (
    RSVP_GROUPS.find((g) => g.key === bucket)?.colorVar ?? "--muted-foreground"
  );
}

/** A one-line tally, e.g. "5 going, 2 not going, 3 awaiting". */
export function rsvpSummary(guests: Guest[]): string {
  return groupGuests(guests)
    .map((g) => `${g.guests.length} ${g.label.toLowerCase()}`)
    .join(", ");
}

/** One person in a guest list: avatar, name over email, a crown if they own the
 * event, and whatever the caller wants on the right — the picker puts a remove
 * button there, the detail view puts their answer. */
export function GuestRow({
  guest,
  trailing,
}: {
  guest: Guest;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg px-1 py-1">
      <Avatar
        email={guest.email}
        name={guest.displayName}
        photoUrl={guest.photoUrl}
        className="size-7"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1 truncate text-sm">
          {guest.organizer && (
            <HugeiconsIcon
              icon={Crown02Icon}
              strokeWidth={2}
              className="size-3.5 shrink-0 text-amber-500"
            />
          )}
          <span className="truncate">{guest.displayName || guest.email}</span>
        </span>
        {guest.displayName && (
          <span className="truncate text-xs text-muted-foreground">
            {guest.email}
          </span>
        )}
      </span>
      {trailing}
    </div>
  );
}

/** The "Add guests" affordance: a button that opens a "Select person" popover to
 * search synced contacts or invite any typed email. Added guests are listed below,
 * grouped by RSVP — the signed-in organizer under "Going", invitees under
 * "Awaiting" (nobody has responded yet at create time). */
export function GuestPicker({
  value,
  onChange,
  readOnly = false,
  readOnlyReason,
  hidden = false,
}: {
  value: Guest[];
  onChange: (guests: Guest[]) => void;
  /** The list still shows; only adding and removing are off. */
  readOnly?: boolean;
  /** Explains the above, in a tooltip on the trigger. */
  readOnlyReason?: string;
  /** The organiser hid the guest list from other guests. */
  hidden?: boolean;
}) {
  const people = useQuery(api.domains.people.queries.listPeople) ?? [];
  const { data: session } = authClient.useSession();
  const organizer = session?.user;
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const added = useMemo(
    () => new Set(value.map((g) => g.email.toLowerCase())),
    [value],
  );

  // One suggestion per email, excluding already-added guests, ranked with
  // matches on the current query. An empty query surfaces the first contacts.
  const suggestions = useMemo<Suggestion[]>(() => {
    const q = query.trim().toLowerCase();
    const out: Suggestion[] = [];
    const seen = new Set<string>();
    for (const p of people) {
      const key = p.email.toLowerCase();
      if (added.has(key) || seen.has(key)) continue;
      const hay = `${p.displayName ?? ""} ${p.email}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      seen.add(key);
      out.push({ email: p.email, displayName: p.displayName, photoUrl: p.photoUrl });
      if (out.length >= MAX_SUGGESTIONS) return out;
    }
    return out;
  }, [people, query, added]);

  const typed = query.trim();
  // Offer to add a raw email only when it's plausible and not already a guest or
  // an exact suggestion the list already shows.
  const canAddTyped =
    EMAIL_RE.test(typed) &&
    !added.has(typed.toLowerCase()) &&
    !suggestions.some((s) => s.email.toLowerCase() === typed.toLowerCase());

  const addGuest = (guest: Guest) => {
    if (added.has(guest.email.toLowerCase())) return;
    onChange([...value, guest]);
    setQuery("");
    setActive(0);
    // Keep the popover open so several guests can be added in a row.
    inputRef.current?.focus();
  };

  const removeGuest = (email: string) => {
    onChange(value.filter((g) => g.email !== email));
  };

  // The dropdown rows: contact suggestions, then the "add typed email" row.
  const rowCount = suggestions.length + (canAddTyped ? 1 : 0);

  const commitActive = () => {
    if (active < suggestions.length) {
      const s = suggestions[active];
      addGuest({ email: s.email, displayName: s.displayName, photoUrl: s.photoUrl });
    } else if (canAddTyped) {
      addGuest({ email: typed });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (rowCount > 0) {
        e.preventDefault();
        commitActive();
      }
      return;
    }
    if (e.key === "ArrowDown" && rowCount > 0) {
      e.preventDefault();
      setActive((i) => (i + 1) % rowCount);
    } else if (e.key === "ArrowUp" && rowCount > 0) {
      e.preventDefault();
      setActive((i) => (i - 1 + rowCount) % rowCount);
    }
  };

  // An existing event's guest list carries everyone's RSVP, the organizer
  // included; a list being built carries nobody's. Synthesising the signed-in
  // user as an accepted organizer in the second case lets one grouped render
  // serve both — "1 Going / N Awaiting" falls out of the same code that shows
  // a real tally.
  const hasResponses = value.some((g) => g.responseStatus !== undefined);
  const party: Guest[] = hasResponses
    ? value
    : [
        ...(organizer
          ? [
              {
                email: organizer.email,
                displayName: organizer.name,
                photoUrl: organizer.image ?? undefined,
                organizer: true,
                responseStatus: "accepted",
              },
            ]
          : []),
        ...value,
      ];

  const groups = groupGuests(party);

  const STACK_MAX = 5;
  const stackShown = party.slice(0, STACK_MAX);
  const stackOverflow = party.length - stackShown.length;
  const summary = rsvpSummary(party);

  if (hidden) {
    return (
      <div className="flex items-start gap-3">
        <HugeiconsIcon
          icon={UserMultiple02Icon}
          strokeWidth={2}
          className="mt-0.5 size-4.5 shrink-0 text-muted-foreground"
        />
        <p className="text-sm text-muted-foreground">
          Guest list hidden by the organiser
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <HugeiconsIcon
        icon={UserMultiple02Icon}
        strokeWidth={2}
        className="mt-0.5 size-4.5 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) {
              setQuery("");
              setActive(0);
            }
          }}
        >
          <PopoverTrigger
            disabled={readOnly}
            title={readOnly ? readOnlyReason : undefined}
            className="group flex w-full flex-col items-start gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={cn(
                "text-sm text-muted-foreground transition-colors",
                !readOnly && "group-hover:text-foreground",
              )}
            >
              {readOnly ? (value.length > 0 ? "Guests" : "No guests") : "Add guests"}
            </span>
            <AnimatePresence initial={false}>
              {value.length > 0 && (
                <motion.span
                  key="summary"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  transition={SPRING_DOCK}
                  className="flex items-center gap-2 overflow-hidden"
                >
                  <span className="flex items-center">
                    <AnimatePresence initial={false}>
                      {stackShown.map((p) => (
                        <motion.span
                          key={p.email}
                          layout={!reduce}
                          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0 }}
                          transition={SPRING_DOCK}
                          className="-ml-1.5 rounded-full ring-2 ring-muted first:ml-0"
                        >
                          <Avatar
                            email={p.email}
                            name={p.displayName}
                            photoUrl={p.photoUrl}
                            className="size-6"
                          />
                        </motion.span>
                      ))}
                    </AnimatePresence>
                    {stackOverflow > 0 && (
                      <span className="-ml-1.5 flex size-6 items-center justify-center rounded-full bg-background text-[0.625rem] font-semibold text-muted-foreground ring-2 ring-muted">
                        +{stackOverflow}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">{summary}</span>
                </motion.span>
              )}
            </AnimatePresence>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            initialFocus={inputRef}
            className="flex w-auto max-w-[calc(100vw-2rem)] overflow-hidden p-0"
          >
            {/* Left column: contact suggestions above, search box at the bottom.
                Sink content to the bottom so the search aligns with the popover's
                lower edge even when the members list makes it taller. */}
            <div className="flex w-72 flex-col justify-end p-2">
              {rowCount > 0 ? (
                <ul className="max-h-56 overflow-y-auto">
                  {suggestions.map((s, i) => (
                    <li key={s.email}>
                      <button
                        type="button"
                        onMouseEnter={() => setActive(i)}
                        onClick={() => addGuest(s)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none",
                          active === i && "bg-accent",
                        )}
                      >
                        <Avatar
                          email={s.email}
                          name={s.displayName}
                          photoUrl={s.photoUrl}
                          className="size-7"
                        />
                        <span className="flex min-w-0 flex-col">
                          {s.displayName && (
                            <span className="truncate text-sm">{s.displayName}</span>
                          )}
                          <span className="truncate text-xs text-muted-foreground">
                            {s.email}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                  {canAddTyped && (
                    <li>
                      <button
                        type="button"
                        onMouseEnter={() => setActive(suggestions.length)}
                        onClick={() => addGuest({ email: typed })}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none",
                          active === suggestions.length && "bg-accent",
                        )}
                      >
                        <Avatar email={typed} className="size-7" />
                        <span className="min-w-0 truncate text-sm">
                          Invite <span className="font-medium">{typed}</span>
                        </span>
                      </button>
                    </li>
                  )}
                </ul>
              ) : (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {query.trim()
                    ? "No matches — type a full email to invite"
                    : "Search contacts or type an email"}
                </p>
              )}
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="Search or type an email"
                aria-label="Search people"
                className="mt-1 w-full rounded-xl bg-muted px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-ring"
              />
            </div>

            {/* Right column: the invited-members list, grouped by RSVP. */}
            <AnimatePresence initial={false}>
              {value.length > 0 && (
                <motion.div
                  key="members"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, width: 0 }}
                  animate={reduce ? { opacity: 1 } : { opacity: 1, width: "18rem" }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, width: 0 }}
                  transition={SPRING_DOCK}
                  className="overflow-hidden border-l border-foreground/10"
                >
                  <div className="flex max-h-80 w-72 flex-col gap-3 overflow-y-auto p-2">
                {groups.map((group) => (
                  <div key={group.label} className="flex flex-col gap-0.5">
                    <p className="px-1 text-xs font-medium text-muted-foreground">
                      {group.guests.length} {group.label}
                    </p>
                    <AnimatePresence initial={false}>
                      {group.guests.map((g) => (
                        <motion.div
                          key={g.email}
                          initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                          transition={SPRING_DOCK}
                          className="overflow-hidden"
                        >
                          <GuestRow
                            guest={g}
                            trailing={
                              // The organiser can't be uninvited from their own
                              // event, and nobody can when read-only.
                              !readOnly && !g.organizer ? (
                                <button
                                  type="button"
                                  aria-label={`Remove ${g.displayName ?? g.email}`}
                                  onClick={() => removeGuest(g.email)}
                                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2.5} className="size-3.5" />
                                </button>
                              ) : undefined
                            }
                          />
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                ))}
                </div>
              </motion.div>
            )}
            </AnimatePresence>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
