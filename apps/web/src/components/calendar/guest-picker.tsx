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
import { useMemo, useRef, useState } from "react";

import { authClient } from "@/lib/auth-client";

import { Avatar } from "./avatar";

export interface Guest {
  email: string;
  displayName?: string;
  /** Local only (for the chip avatar); not sent to the backend. */
  photoUrl?: string;
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

/** The "Add guests" affordance: a button that opens a "Select person" popover to
 * search synced contacts or invite any typed email. Added guests are listed below,
 * grouped by RSVP — the signed-in organizer under "Going", invitees under
 * "Awaiting" (nobody has responded yet at create time). */
export function GuestPicker({
  value,
  onChange,
}: {
  value: Guest[];
  onChange: (guests: Guest[]) => void;
}) {
  const contacts = useQuery(api.contacts.listContacts) ?? [];
  const { data: session } = authClient.useSession();
  const organizer = session?.user;
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
    for (const c of contacts) {
      for (const email of c.emails) {
        const key = email.toLowerCase();
        if (added.has(key) || seen.has(key)) continue;
        const hay = `${c.displayName ?? ""} ${email}`.toLowerCase();
        if (q && !hay.includes(q)) continue;
        seen.add(key);
        out.push({ email, displayName: c.displayName, photoUrl: c.photoUrl });
        if (out.length >= MAX_SUGGESTIONS) return out;
      }
    }
    return out;
  }, [contacts, query, added]);

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

  // The button's summary row: the organizer plus every invitee as an overlapping
  // avatar stack, and a "1 going, N awaiting" tally (nobody has responded yet).
  const stack = [
    ...(organizer
      ? [{ email: organizer.email, name: organizer.name, photoUrl: organizer.image ?? undefined }]
      : []),
    ...value.map((g) => ({ email: g.email, name: g.displayName, photoUrl: g.photoUrl })),
  ];
  const STACK_MAX = 5;
  const stackShown = stack.slice(0, STACK_MAX);
  const stackOverflow = stack.length - stackShown.length;
  const summary = [
    organizer && "1 going",
    `${value.length} awaiting`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="flex items-start gap-3">
      <HugeiconsIcon
        icon={UserMultiple02Icon}
        strokeWidth={2}
        className="mt-2 size-4.5 shrink-0 text-muted-foreground"
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
          <PopoverTrigger className="flex w-full flex-col gap-1.5 rounded-xl bg-muted px-3 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
            <span className="text-sm text-muted-foreground">Add guests</span>
            {value.length > 0 && (
              <span className="flex items-center gap-2">
                <span className="flex items-center">
                  {stackShown.map((p) => (
                    <span
                      key={p.email}
                      className="-ml-1.5 rounded-full ring-2 ring-muted first:ml-0"
                    >
                      <Avatar
                        email={p.email}
                        name={p.name}
                        photoUrl={p.photoUrl}
                        className="size-6"
                      />
                    </span>
                  ))}
                  {stackOverflow > 0 && (
                    <span className="-ml-1.5 flex size-6 items-center justify-center rounded-full bg-background text-[0.625rem] font-semibold text-muted-foreground ring-2 ring-muted">
                      +{stackOverflow}
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{summary}</span>
              </span>
            )}
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
            {value.length > 0 && (
              <div className="flex max-h-80 w-72 flex-col gap-3 overflow-y-auto border-l border-foreground/10 p-2">
                {organizer && (
                  <div className="flex flex-col gap-0.5">
                    <p className="px-1 text-xs font-medium text-muted-foreground">
                      1 Going
                    </p>
                    <div className="flex items-center gap-2 rounded-lg px-1 py-1">
                      <Avatar
                        email={organizer.email}
                        name={organizer.name}
                        photoUrl={organizer.image ?? undefined}
                        className="size-7"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-center gap-1 truncate text-sm">
                          <HugeiconsIcon
                            icon={Crown02Icon}
                            strokeWidth={2}
                            className="size-3.5 shrink-0 text-amber-500"
                          />
                          <span className="truncate">
                            {organizer.name || organizer.email}
                          </span>
                        </span>
                        {organizer.name && (
                          <span className="truncate text-xs text-muted-foreground">
                            {organizer.email}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-0.5">
                  <p className="px-1 text-xs font-medium text-muted-foreground">
                    {value.length} Awaiting
                  </p>
                  {value.map((g) => (
                    <div
                      key={g.email}
                      className="flex items-center gap-2 rounded-lg px-1 py-1"
                    >
                      <Avatar
                        email={g.email}
                        name={g.displayName}
                        photoUrl={g.photoUrl}
                        className="size-7"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">
                          {g.displayName ?? g.email}
                        </span>
                        {g.displayName && (
                          <span className="truncate text-xs text-muted-foreground">
                            {g.email}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${g.displayName ?? g.email}`}
                        onClick={() => removeGuest(g.email)}
                        className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2.5} className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
