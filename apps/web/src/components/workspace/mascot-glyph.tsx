import { useId } from "react";

import { cn } from "@qali/ui/lib/utils";

/**
 * A monotone glyph of the landing-page mascot (see apps/www mascot.tsx): the
 * plump, two-curl-tailed ghost body, in `currentColor` so it inverts cleanly
 * when the assistant dock morphs from its resting neutral surface to the active
 * primary one.
 *
 * State is driven by CSS in globals.css (`.mascot-glyph`):
 *  - resting: an outlined ghost with solid eyes;
 *  - hover / keyboard focus: the same outline, with the hero's `--chroma-*`
 *    foil band sweeping across the silhouette on a loop;
 *  - toggled open (`active`): a solid inverted silhouette.
 * The eyes blink on the hero's exact cadence; the blink freezes under
 * `prefers-reduced-motion`.
 */
const BODY_PATH =
  "M40 118 C36 66 74 30 122 32 C172 34 202 74 196 122 C193 147 181 158 176 176 C171 195 176 214 156 216 C141 217 137 201 128 199 C119 197 113 208 101 209 C86 210 80 197 73 180 C67 165 51 158 45 141 C41 129 40 124 40 118 Z";

export function MascotGlyph({
  className,
  active = false,
}: {
  className?: string;
  active?: boolean;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const maskId = `mascot-glyph-eyes-${uid}`;
  const holoId = `mascot-glyph-holo-${uid}`;
  const clipId = `mascot-glyph-clip-${uid}`;

  return (
    <svg
      viewBox="0 0 236 236"
      fill="none"
      role="presentation"
      focusable="false"
      data-active={active ? "true" : "false"}
      className={cn("mascot-glyph", className)}
    >
      <defs>
        <mask id={maskId}>
          <rect width="236" height="236" fill="white" />
          <g className="mascot-glyph__eyes">
            <rect x="80" y="88" width="28" height="54" rx="14" fill="black" />
            <rect x="128" y="92" width="28" height="54" rx="14" fill="black" />
          </g>
        </mask>
        <clipPath id={clipId}>
          <path d={BODY_PATH} />
        </clipPath>
        {/* The hero's foil band: a translucent rainbow with a bright specular
            core, swept across the body on hover (see mascot.tsx holo). */}
        <linearGradient id={holoId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--chroma-5)" stopOpacity="0" />
          <stop offset="0.18" stopColor="var(--chroma-5)" stopOpacity="0.75" />
          <stop offset="0.34" stopColor="var(--chroma-1)" stopOpacity="0.8" />
          <stop offset="0.5" stopColor="white" stopOpacity="0.95" />
          <stop offset="0.66" stopColor="var(--chroma-3)" stopOpacity="0.8" />
          <stop offset="0.82" stopColor="var(--chroma-2)" stopOpacity="0.75" />
          <stop offset="1" stopColor="var(--chroma-2)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Solid inverted silhouette, eyes knocked out — the toggled-open state. */}
      <path
        className="mascot-glyph__fill"
        d={BODY_PATH}
        fill="currentColor"
        mask={`url(#${maskId})`}
      />

      {/* Outlined ghost with solid eyes — the resting (and hover) base. */}
      <g className="mascot-glyph__outline">
        <path
          d={BODY_PATH}
          fill="none"
          stroke="currentColor"
          strokeWidth="13"
          strokeLinejoin="round"
        />
        <g className="mascot-glyph__eyes" fill="currentColor">
          <rect x="80" y="88" width="28" height="54" rx="14" />
          <rect x="128" y="92" width="28" height="54" rx="14" />
        </g>
      </g>

      {/* Foil sweep, clipped to the body — hidden until hover, then it passes
          across the silhouette on a loop. */}
      <g clipPath={`url(#${clipId})`}>
        <rect
          className="mascot-glyph__sweep"
          x="-40"
          y="-30"
          width="150"
          height="300"
          fill={`url(#${holoId})`}
        />
      </g>
    </svg>
  );
}
