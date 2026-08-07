"use client";

import { useEffect, useRef, useState } from "react";

/* ─────────────────────────────────────────────────────────
 * STREAMING TEXT
 *
 * Two small pieces the assistant panel drives with real data:
 *
 *   StreamingText — assistant prose while a turn is still
 *     streaming. The server flushes the reply in ~250ms bursts,
 *     so revealing exactly what has arrived looks chunky. Received
 *     words reserve their final wrapping immediately, then enter one
 *     at a time with a soft fade and rise. That avoids reflow on every
 *     character while preserving a continuous stream. A zero-width
 *     caret trails the visible end. Once the turn settles the panel
 *     swaps this for the markdown renderer.
 *
 *   FollowUps — suggested next prompts under a settled turn.
 *     Rendered only when the backend actually produced some.
 * ───────────────────────────────────────────────────────── */

const SLOW_REVEAL_MS = 58;
const FAST_REVEAL_MS = 26;

function StreamingCaret() {
  return (
    <span
      aria-hidden
      className="relative inline-block size-0 overflow-visible align-baseline leading-none"
    >
      <span className="pointer-events-none absolute bottom-[0.08em] left-0 h-[1.05em] w-0.5 rounded-full bg-foreground motion-safe:animate-pulse" />
    </span>
  );
}

export function StreamingText({ text }: { text: string }) {
  const tokens = text.match(/\s+|[^\s]+/g) ?? [];
  const wordCount = tokens.reduce(
    (count, token) => count + (token.trim() ? 1 : 0),
    0,
  );
  const [shownWords, setShownWords] = useState(0);
  const shownWordsRef = useRef(0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (wordCount < shownWordsRef.current) {
      shownWordsRef.current = 0;
      setShownWords(0);
    }

    let previous = performance.now();
    const tick = (now: number) => {
      const remaining = wordCount - shownWordsRef.current;
      if (remaining <= 0) {
        frameRef.current = null;
        return;
      }
      // Catch up gently after a large server chunk without dumping a whole
      // sentence into one frame. Nearby words arrive at a more relaxed pace.
      const interval = Math.max(
        FAST_REVEAL_MS,
        SLOW_REVEAL_MS - remaining * 2,
      );
      if (now - previous >= interval) {
        shownWordsRef.current += 1;
        setShownWords(shownWordsRef.current);
        previous = now;
      }
      frameRef.current = requestAnimationFrame(tick);
    };

    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(tick);
    }
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [wordCount]);

  let wordIndex = -1;

  return (
    <p className="text-sm leading-5 whitespace-pre-wrap text-foreground">
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {shownWords === 0 && <StreamingCaret />}
        {tokens.map((token, index) => {
          if (!token.trim()) return <span key={index}>{token}</span>;
          wordIndex += 1;
          const visible = wordIndex < shownWords;
          return (
            <span
              key={index}
              className={
                visible
                  ? "inline-block opacity-100 motion-safe:animate-[stream-word-in_260ms_cubic-bezier(0.16,1,0.3,1)_both]"
                  : "inline-block opacity-0"
              }
            >
              {token}
              {wordIndex === shownWords - 1 && <StreamingCaret />}
            </span>
          );
        })}
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
