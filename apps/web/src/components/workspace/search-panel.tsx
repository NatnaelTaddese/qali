import {
  Cancel01Icon,
  RepeatIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { SEARCH_QUERY_MAX_LENGTH } from "@qali/domain/search";
import { Spinner } from "@qali/ui/components/spinner";
import { cn } from "@qali/ui/lib/utils";
import { useQuery } from "convex/react";
import { addDays, format, isSameDay, isSameYear, startOfDay } from "date-fns";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useEventColor } from "@/components/calendar/colors";
import {
  calendarDisplayName,
  eventTimeParts,
  fromUtcMidnight,
  zoned,
  zonedNow,
  type CalendarEvent,
} from "@/components/calendar/lib";
import { useDock, type RevealInput } from "./dock-context";
import { usePreferences } from "./preferences-context";
import { stepActiveResult } from "./search-interactions";

/** How long typing pauses before the query goes to the server. Short enough
 * to feel live, long enough that a burst of keystrokes is one subscription. */
const SEARCH_DEBOUNCE_MS = 120;

/** The upcoming/past split is anchored to a minute, not the exact instant, so
 * one client's subscriptions can share the server's cache within that minute. */
const NOW_GRANULARITY_MS = 60_000;

function dayLabel(date: Date, now: Date): string {
  if (isSameDay(date, now)) return "Today";
  if (isSameDay(date, addDays(now, 1))) return "Tomorrow";
  if (isSameDay(date, addDays(now, -1))) return "Yesterday";
  return format(date, isSameYear(date, now) ? "EEE d MMM" : "EEE d MMM yyyy");
}

/** One line of when: "Tomorrow · 9:00 – 9:30 AM", "Fri 12 Dec · All day",
 * or a day span for a multi-day all-day event. The zone-correct bounds come
 * from the same helper the detail card composes its line from. */
function whenText(
  event: CalendarEvent,
  use24h: boolean,
  timeZone: string,
): string {
  const now = zonedNow(timeZone);
  const parts = eventTimeParts(event, use24h, timeZone);
  if (parts.allDay) {
    const { start, lastDay } = parts;
    return isSameDay(start, lastDay)
      ? `${dayLabel(start, now)} · All day`
      : `${dayLabel(start, now)} – ${dayLabel(lastDay, now)}`;
  }
  return `${dayLabel(parts.start, now)} · ${format(parts.start, parts.time)} – ${parts.endText}`;
}

/** Where the calendar should scroll for a result. A timed event lands on its
 * start; an all-day event lands on the top of its first day (in the working
 * zone), where the all-day band lives. */
function revealFor(event: CalendarEvent, timeZone: string): RevealInput {
  const startMs = event.allDay
    ? startOfDay(
        zoned(fromUtcMidnight(event.startMs, timeZone), timeZone),
      ).getTime()
    : event.startMs;
  return { startMs, flashId: event._id };
}

/** The dock's search face: a title search over the selected calendars. It
 * opens as the same card the create form does; the result list grows the
 * card as matches arrive and the shell's layout spring follows. Picking a
 * result swaps the dock to that event's detail and scrolls the calendar to
 * it, the way the notification feed reaches for a booking. */
export function SearchPanel({ onClose }: { onClose: () => void }) {
  const { open, reveal } = useDock();
  const { use24h, timeZone } = usePreferences();
  const colorFor = useEventColor();
  const calendars = useQuery(api.domains.calendar.queries.listCalendars);
  const calendarNames = useMemo(
    () =>
      new Map(
        calendars?.map((c) => [c._id, calendarDisplayName(c)] as const) ?? [],
      ),
    [calendars],
  );

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  // The last list to arrive, held while the next query loads so the card
  // never collapses to empty between two sets of results. Cleared when the
  // box is emptied: a fresh query starts from nothing, not from an old list.
  const lastResults = useRef<CalendarEvent[] | undefined>(undefined);
  useEffect(() => {
    const trimmed = query.trim();
    // An emptied box clears at once; only new text waits for the pause.
    if (!trimmed) {
      lastResults.current = undefined;
      setDebounced("");
      return;
    }
    const timeout = setTimeout(() => setDebounced(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [query]);

  // Anchored per query rather than per render, so the subscription's args
  // hold still while the results are on screen.
  const nowMs = useMemo(
    () => Math.floor(Date.now() / NOW_GRANULARITY_MS) * NOW_GRANULARITY_MS,
    [debounced],
  );
  const fresh = useQuery(
    api.domains.calendar.queries.searchEvents,
    debounced ? { query: debounced, nowMs } : "skip",
  );
  if (fresh !== undefined) lastResults.current = fresh;
  const loading = debounced !== "" && fresh === undefined;
  const results = debounced ? (fresh ?? lastResults.current) : undefined;

  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const count = results?.length ?? 0;
  // A live update can shrink the list under the highlight; clamp rather than
  // reset, so a background sync never yanks the selection back to the top.
  const activeIndex = Math.min(active, Math.max(count - 1, 0));
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const pick = (event: CalendarEvent) => {
    open({ kind: "event", event });
    reveal(revealFor(event, timeZone));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(
        stepActiveResult(activeIndex, count, e.key === "ArrowDown" ? 1 : -1),
      );
    } else if (e.key === "Enter") {
      // While a new query loads the rows on screen belong to the old one.
      const event = loading ? undefined : results?.[activeIndex];
      if (event) {
        e.preventDefault();
        pick(event);
      }
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2.5">
        <HugeiconsIcon
          icon={Search01Icon}
          strokeWidth={2}
          className="size-5 shrink-0 text-muted-foreground"
        />
        <input
          autoFocus
          type="text"
          value={query}
          maxLength={SEARCH_QUERY_MAX_LENGTH}
          onChange={(e) => {
            setQuery(e.target.value);
            // Typing restarts the highlight at the top of whatever arrives.
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search events"
          aria-label="Search events"
          role="combobox"
          aria-expanded={count > 0}
          aria-controls={listId}
          aria-activedescendant={
            count > 0 ? `${listId}-${activeIndex}` : undefined
          }
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-base font-semibold outline-none placeholder:text-muted-foreground"
        />
        {loading ? <Spinner className="shrink-0" /> : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
        </button>
      </div>

      {results && results.length > 0 ? (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Matching events"
          aria-busy={loading || undefined}
          className={cn(
            "-mx-2 mt-3 max-h-[min(24rem,55vh)] overflow-y-auto overscroll-contain",
            // The held list dims while its replacement loads.
            loading && "opacity-60",
          )}
        >
          {results.map((event, index) => {
            const colorVar = colorFor(event);
            const calendarName = event.localCalendarId
              ? calendarNames.get(event.localCalendarId)
              : undefined;
            return (
              <button
                type="button"
                key={event._id}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === activeIndex}
                tabIndex={-1}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(event)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left outline-none",
                  index === activeIndex && "bg-accent",
                )}
              >
                <span
                  aria-hidden
                  className="h-8 w-[3px] shrink-0 rounded-full"
                  style={{ backgroundColor: `var(${colorVar})` }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {event.summary || "(No title)"}
                    </span>
                    {event.providerSeriesId ? (
                      <HugeiconsIcon
                        icon={RepeatIcon}
                        strokeWidth={2}
                        aria-label="Repeats"
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {whenText(event, use24h, timeZone)}
                    {calendarName ? ` · ${calendarName}` : ""}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="mt-3 px-0.5 text-sm text-muted-foreground">
          {results && !loading
            ? `No events match “${debounced}”`
            : "Find an event by its title"}
        </p>
      )}
    </div>
  );
}
