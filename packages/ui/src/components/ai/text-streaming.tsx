"use client";

import { type Ref, useEffect, useLayoutEffect, useRef, useState } from "react";

/* ─────────────────────────────────────────────────────────
 * STREAMING TEXT
 *
 * Two small pieces the assistant panel drives with real data:
 *
 *   StreamingText — assistant prose while a turn is still
 *     streaming. The server flushes the reply in fast ~250ms bursts, so
 *     rather than dumping each burst we meter the text out ourselves: a
 *     few words per tick (word-snapped so nothing splits mid-word),
 *     pacing that catches up only when a backlog builds. Each new chunk
 *     mounts with the `.chroma-stream` class, so a chroma band sweeps
 *     across it and settles on the foreground colour. Already-revealed
 *     chunks stay static; only the newest one animates. A zero-width
 *     caret glides to the live end (FLIP) as each chunk lands, instead
 *     of teleporting. Once the turn settles the panel swaps this for the
 *     markdown renderer.
 *
 *   FollowUps — suggested next prompts under a settled turn.
 *     Rendered only when the backend actually produced some.
 * ───────────────────────────────────────────────────────── */

function StreamingCaret({ ref }: { ref?: Ref<HTMLSpanElement> }) {
  // A zero-width, line-height-tall box that exactly overlays the current line
  // box (align-top + h-5 to match `leading-5`), with the bar flex-centred inside
  // it — so the caret sits centred on the text rather than riding above the
  // baseline. The wrapper carries the horizontal FLIP transform; the inner bar
  // owns the vertical placement, so the two never fight.
  return (
    <span
      ref={ref}
      aria-hidden
      className="relative inline-flex h-5 w-0 items-center overflow-visible align-top"
    >
      <span className="pointer-events-none h-[1.05em] w-0.5 rounded-full bg-foreground motion-safe:animate-pulse" />
    </span>
  );
}

type Segment = { id: number; text: string };

// Reveal pacing. The server delivers text in fast ~250ms bursts (or all at once
// for a short reply), so we meter it out ourselves: a few words per tick with a
// gentle gap between ticks, and catch up — shorter gaps, bigger chunks — only
// when a backlog builds, so each chroma sweep stays visible without lagging far
// behind a long reply.
const REVEAL_MS = 150; // base gap between chunk reveals
const REVEAL_MIN_MS = 55; // floor when catching up on a big backlog
const BASE_CHUNK_WORDS = 2; // words revealed per chunk at rest
const MAX_CHUNK_WORDS = 8; // cap when catching up

// Grab up to `maxWords` whitespace-terminated words from the front of `pending`.
// A trailing partial word (no whitespace after it yet) is left behind so nothing
// splits mid-word. Returns "" when no whole word is available yet.
function takeChunk(pending: string, maxWords: number): string {
  const re = /\S+\s+/g;
  let end = 0;
  let words = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pending)) !== null) {
    end = match.index + match[0].length;
    if (++words >= maxWords) break;
  }
  return pending.slice(0, end);
}

export function StreamingText({ text }: { text: string }) {
  // `text` always arrives as the whole reply so far. We meter it into small
  // word-snapped chunks (see below) so each one can chroma-sweep in on its own.
  const [segments, setSegments] = useState<Segment[]>([]);
  const revealedRef = useRef(0);
  const idRef = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const caretRef = useRef<HTMLSpanElement | null>(null);
  const caretPrevRef = useRef<{ left: number; top: number } | null>(null);

  // Slide the caret from where it was to the new live end (FLIP) whenever a
  // chunk commits, so the cursor tracks the reveal instead of jumping. Only
  // glide along a line; on a wrap (line change) or with reduced motion, let it
  // land directly.
  useLayoutEffect(() => {
    const el = caretRef.current;
    if (!el) {
      caretPrevRef.current = null;
      return;
    }
    const rect = el.getBoundingClientRect();
    const prev = caretPrevRef.current;
    caretPrevRef.current = { left: rect.left, top: rect.top };
    if (!prev) return;
    const dx = prev.left - rect.left;
    if (dx === 0 || Math.abs(prev.top - rect.top) > 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Paint at the old spot (this layout effect runs before paint), then
    // release on the next frame so the transition carries it to the new end.
    el.style.transition = "none";
    el.style.transform = `translateX(${dx}px)`;
    void el.offsetWidth;
    requestAnimationFrame(() => {
      el.style.transition = "transform 360ms cubic-bezier(0.22,1,0.36,1)";
      el.style.transform = "";
    });
  }, [segments]);

  // Metered reveal loop. Runs once for the component's life, reading the latest
  // `text` from a ref, and commits one word-snapped chunk per tick. Pace and
  // chunk size scale with the backlog so a fast/long reply catches up while a
  // short one still gets a visible, unhurried sweep. Reduced motion drains the
  // whole backlog immediately.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const tick = (now: number) => {
      const full = textRef.current;
      // New turn / regeneration: the accumulated text restarted. Start over.
      if (full.length < revealedRef.current) {
        revealedRef.current = 0;
        idRef.current = 0;
        setSegments([]);
      }

      const pending = full.slice(revealedRef.current);
      if (pending) {
        const backlogWords = pending.match(/\S+/g)?.length ?? 0;
        const interval = reduced
          ? 0
          : Math.max(REVEAL_MIN_MS, REVEAL_MS - backlogWords * 4);
        if (now - last >= interval) {
          const words = reduced
            ? backlogWords
            : Math.min(
                MAX_CHUNK_WORDS,
                BASE_CHUNK_WORDS + Math.floor(backlogWords / 10),
              );
          const commit = takeChunk(pending, words);
          if (commit) {
            revealedRef.current += commit.length;
            const id = idRef.current++;
            setSegments((prev) => [...prev, { id, text: commit }]);
            last = now;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <p className="text-sm leading-5 whitespace-pre-wrap text-foreground">
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {segments.length === 0 && <StreamingCaret />}
        {segments.map((segment, index) => {
          // Only the newest chunk sweeps; earlier chunks have settled to plain
          // foreground. Keying by id remounts each new chunk so its 0.6s chroma
          // sweep runs exactly once.
          const isNewest = index === segments.length - 1;
          return (
            <span key={segment.id} className={isNewest ? "chroma-stream" : undefined}>
              {segment.text}
            </span>
          );
        })}
        {segments.length > 0 && <StreamingCaret ref={caretRef} />}
      </span>
    </p>
  );
}

export function FollowUps({
  suggestions,
  onSelect,
}: {
  suggestions: string[];
  onSelect: (text: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mt-1 w-full">
      <p className="text-[12px] font-medium text-foreground/70">Follow-ups</p>
      <div className="mt-0.5 flex flex-col">
        {suggestions.map((text, i) => (
          <button
            key={text}
            type="button"
            onClick={() => onSelect(text)}
            // No negative margin here: the panel's scroll area has almost no
            // horizontal padding to bleed into, so a bleed just overflows the
            // parent and adds a stray horizontal scrollbar.
            className="flex w-full items-center gap-2 rounded-md border-b border-border
              px-1.5 py-1.5 text-left text-[12.5px] text-foreground transition-colors
              duration-100 in-data-[palette-settled=false]:transition-none last:border-b-0
              hover:bg-accent"
            style={{
              animation: `fade-up 350ms cubic-bezier(0.23,1,0.32,1) ${i * 90}ms both`,
            }}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--muted-foreground)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0"
            >
              <path d="M9 10l-5 5 5 5" />
              <path d="M20 4v7a4 4 0 0 1-4 4H4" />
            </svg>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
