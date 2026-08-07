"use client";

import { useLayoutEffect, useRef, useState } from "react";

/* ─────────────────────────────────────────────────────────
 * THINKING — the assistant's live tool-activity trace.
 *
 * One collapsible line ("Working…" → "Did N things") over the
 * ordered tool calls of a turn. Each row spins while its call
 * is in flight and settles to a check when its result lands.
 * Auto-expands while working, collapses when the turn settles,
 * and stays clickable either way.
 *
 * Driven entirely by props — the panel builds `rows` from the
 * turn's tool_call / tool_result blocks. There is no reasoning
 * text to show (the model runs with thinking disabled), so the
 * honest trace is what the assistant actually did.
 * ───────────────────────────────────────────────────────── */

export type ThinkingRow = {
  /** Human label for the tool, e.g. "Checking your calendar". */
  primary: string;
  /** The raw tool name, shown muted and monospaced. */
  secondary?: string;
  /** True once the tool's result has landed. */
  done: boolean;
  /** True if the tool result was an error. */
  error?: boolean;
};

export default function ThinkingTrace({
  rows,
  working,
  activeLabel = "Working",
  doneLabel,
}: {
  rows: ThinkingRow[];
  /** The turn is still streaming. */
  working: boolean;
  activeLabel?: string;
  doneLabel?: string;
}) {
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? working;
  const traceRef = useRef<HTMLDivElement>(null);
  const [lineHeight, setLineHeight] = useState(0);
  useLayoutEffect(() => {
    if (traceRef.current) setLineHeight(traceRef.current.offsetHeight);
  }, [rows.length, expanded, working]);

  const settledLabel =
    doneLabel ??
    `Did ${rows.length} ${rows.length === 1 ? "thing" : "things"}`;

  return (
    <div className="flex w-full flex-col">
      {/* header */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setManualExpanded((current) => !(current ?? working))}
        className="-mx-1.5 flex w-fit items-center gap-2 rounded-lg px-1.5 py-1
          transition-colors duration-100 hover:bg-accent"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill={working ? "var(--foreground)" : "var(--muted-foreground)"}
        >
          <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
        </svg>
        {working ? (
          <span
            className="bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent"
            style={{
              backgroundImage:
                "linear-gradient(90deg, var(--muted-foreground) 35%, var(--foreground) 50%, var(--muted-foreground) 65%)",
              backgroundSize: "200% 100%",
              animation: "shimmer-text 1.4s linear infinite",
            }}
          >
            {activeLabel}
          </span>
        ) : (
          <span
            className="text-[13px] font-medium whitespace-nowrap text-foreground/70"
            style={{ animation: "fade-in 350ms ease-out both" }}
          >
            {settledLabel}
          </span>
        )}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--muted-foreground)"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transition-transform duration-300"
          style={{ transform: expanded ? "rotate(180deg)" : "rotate(0)" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* expandable trace */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-400"
        style={{
          gridTemplateRows: expanded ? "1fr" : "0fr",
          opacity: expanded ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
        }}
      >
        <div className="overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            <span
              aria-hidden
              className="absolute left-[3px] w-px bg-border"
              style={{
                top: -8,
                height: lineHeight ? lineHeight - 2 : 0,
                transition: "height 500ms cubic-bezier(0.23,1,0.32,1)",
              }}
            />
            <div ref={traceRef} className="flex flex-col gap-1 py-1">
              {rows.map((row, i) => (
                <div
                  key={`${row.primary}-${i}`}
                  className="flex min-h-7 w-full items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-left"
                  style={{
                    animation: `fade-up 320ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both`,
                  }}
                >
                  {row.done ? (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke={
                        row.error
                          ? "var(--destructive)"
                          : "var(--muted-foreground)"
                      }
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="shrink-0"
                    >
                      {row.error ? (
                        <path d="M18 6L6 18M6 6l12 12" />
                      ) : (
                        <path d="M20 6L9 17l-5-5" />
                      )}
                    </svg>
                  ) : (
                    <span
                      className="size-3 shrink-0 rounded-full border-[1.5px] border-input border-t-foreground/70"
                      style={{ animation: "spin 700ms linear infinite" }}
                    />
                  )}
                  <span className="min-w-0 truncate text-[12.5px] font-medium text-foreground">
                    {row.primary}
                  </span>
                  {row.secondary && (
                    <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
                      {row.secondary}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
