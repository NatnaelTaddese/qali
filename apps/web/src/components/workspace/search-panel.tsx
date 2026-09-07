import {
  Cancel01Icon,
  RepeatIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import { Spinner } from "@qali/ui/components/spinner";
import { cn } from "@qali/ui/lib/utils";
import { useQuery } from "convex/react";
import { addDays, format, isSameDay, isSameYear, startOfDay } from "date-fns";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useEventColor } from "@/components/calendar/colors";
import { fromUtcMidnight } from "@/components/calendar/event-form";
import {
  calendarDisplayName,
  MS_PER_DAY,
  timePattern,
  zoned,
  zonedNow,
  type CalendarEvent,
} from "@/components/calendar/lib";
import { useStableQuery } from "@/components/calendar/use-stable-query";
import { useDock, type RevealInput } from "./dock-context";
import { usePreferences } from "./preferences-context";
import { stepActiveResult } from "./search-interactions";

/** How long typing pauses before the query goes to the server. Short enough
 * to feel live, long enough that a burst of keystrokes is one subscription. */
const SEARCH_DEBOUNCE_MS = 120;

/** Mirrors the server's cap so the input can't outrun it. */
const SEARCH_QUERY_MAX_LENGTH = 120;

function dayLabel(date: Date, now: Date): string {
  if (isSameDay(date, now)) return "Today";
  if (isSameDay(date, addDays(now, 1))) return "Tomorrow";
  if (isSameDay(date, addDays(now, -1))) return "Yesterday";
  return format(date, isSameYear(date, now) ? "EEE d MMM" : "EEE d MMM yyyy");
}

/** One line of when: "Tomorrow · 9:00 – 9:30 AM", "Fri 12 Dec · All day",
 * or a day span for a multi-day all-day event. Same zone handling as the
 * detail panel: all-day bounds are UTC midnights read back through
 * fromUtcMidnight so the working zone can't shift the day. */
function whenText(
  event: CalendarEvent,
  use24h: boolean,
  timeZone: string,
): string {
  const now = zonedNow(timeZone);
  if (event.allDay) {
    const start = zoned(fromUtcMidnight(event.startMs, timeZone), timeZone);
    const lastDay = zoned(
      fromUtcMidnight(event.endMs - MS_PER_DAY, timeZone),
      timeZone,
    );
    return isSameDay(start, lastDay)
      ? `${dayLabel(start, now)} · All day`
      : `${dayLabel(start, now)} – ${dayLabel(lastDay, now)}`;
  }
  const start = zoned(event.startMs, timeZone);
  const end = zoned(event.endMs, timeZone);
  const time = timePattern(use24h);
  const endText = format(
    end,
    isSameDay(start, end) ? time : `EEE d MMM, ${time}`,
  );
  return `${dayLabel(start, now)} · ${format(start, time)} – ${endText}`;
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
  useEffect(() => {
    const trimmed = query.trim();
    // An emptied box clears at once; only new text waits for the pause.
    if (!trimmed) {
      setDebounced("");
      return;
    }
    const timeout = setTimeout(() => setDebounced(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [query]);

  // Stable across keystrokes: the last list stays up while the next loads, so
  // the card never collapses to empty between two sets of results.
  const stored = useStableQuery(
    api.domains.calendar.queries.searchEvents,
    debounced ? { query: debounced } : "skip",
  );
  const results = debounced ? stored : undefined;
  const loading = debounced !== "" && stored === undefined;
  // The list still shows the previous query's matches until the new ones
  // land, so the empty state must key off what was actually searched for.
  const [searchedFor, setSearchedFor] = useState("");
  useEffect(() => {
    if (debounced && stored !== undefined) setSearchedFor(debounced);
  }, [debounced, stored]);

  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const count = results?.length ?? 0;
  // A fresh result set restarts the highlight at the top.
  useEffect(() => setActive(0), [results]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (event: CalendarEvent) => {
    open({ kind: "event", event });
    reveal(revealFor(event, timeZone));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => stepActiveResult(i, count, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      const event = results?.[active];
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
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search events"
          aria-label="Search events"
          role="combobox"
          aria-expanded={count > 0}
          aria-controls={listId}
          aria-activedescendant={count > 0 ? `${listId}-${active}` : undefined}
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
          className="-mx-2 mt-3 max-h-[min(24rem,55vh)] overflow-y-auto overscroll-contain"
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
                aria-selected={index === active}
                tabIndex={-1}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(event)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left outline-none",
                  index === active && "bg-accent",
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
          {results && searchedFor
            ? `No events match “${searchedFor}”`
            : "Find an event by its title"}
        </p>
      )}
    </div>
  );
}
