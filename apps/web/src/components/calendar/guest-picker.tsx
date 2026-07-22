import { Cancel01Icon, UserMultiple02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { cn } from "@qali/ui/lib/utils";
import { useQuery } from "convex/react";
import { useMemo, useRef, useState } from "react";

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

/** The "Add guests" row: type an email to invite anyone, or search the user's
 * synced contacts and click to add. Selected guests show as removable chips. */
export function GuestPicker({
  value,
  onChange,
}: {
  value: Guest[];
  onChange: (guests: Guest[]) => void;
}) {
  const contacts = useQuery(api.contacts.listContacts) ?? [];
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
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

  const open = focused && (suggestions.length > 0 || canAddTyped);

  const addGuest = (guest: Guest) => {
    if (added.has(guest.email.toLowerCase())) return;
    onChange([...value, guest]);
    setQuery("");
    setActive(0);
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
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setFocused(false);
    } else if (e.key === "Backspace" && query === "" && value.length > 0) {
      removeGuest(value[value.length - 1].email);
    }
  };

  return (
    <div className="flex items-start gap-3">
      <HugeiconsIcon
        icon={UserMultiple02Icon}
        strokeWidth={2}
        className="mt-2 size-4.5 shrink-0 text-muted-foreground"
      />
      <div className="relative min-w-0 flex-1">
        <div
          className="flex flex-wrap items-center gap-1.5 rounded-xl bg-muted px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring"
          onClick={() => inputRef.current?.focus()}
        >
          {value.map((g) => (
            <span
              key={g.email}
              className="flex items-center gap-1 rounded-full bg-background py-0.5 pr-1 pl-0.5 text-sm shadow-sm"
            >
              <Avatar
                email={g.email}
                name={g.displayName}
                photoUrl={g.photoUrl}
                className="size-5 text-[0.625rem]"
              />
              <span className="max-w-40 truncate">{g.displayName ?? g.email}</span>
              <button
                type="button"
                aria-label={`Remove ${g.displayName ?? g.email}`}
                onClick={(e) => {
                  e.stopPropagation();
                  removeGuest(g.email);
                }}
                className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2.5} className="size-3" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onFocus={() => setFocused(true)}
            // Delay so a click on a suggestion registers before the list closes.
            onBlur={() => setTimeout(() => setFocused(false), 120)}
            onKeyDown={onKeyDown}
            placeholder={value.length === 0 ? "Add guests" : undefined}
            aria-label="Add guests"
            className="min-w-24 flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        {open && (
          <ul className="absolute bottom-full right-0 left-0 z-50 mb-1 max-h-56 overflow-y-auto rounded-xl bg-popover p-1 shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10">
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
        )}
      </div>
    </div>
  );
}
