import { api } from "@qali/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { useCallback, useMemo } from "react";

import type { CalendarEvent } from "./lib";

/**
 * Google's event colors are a fixed palette of 11 (`color` "1".."11"), and
 * calendars carry an arbitrary `backgroundColor` hex. Rather than render those
 * saturated defaults, each source hex is converted to oklch and snapped to the
 * nearest hue in the app's `--event-*` palette (defined in globals.css), which
 * shares one lightness/chroma band so the grid reads as a single system.
 */

/** Google Calendar's stable event-color hexes, keyed by the provider palette
 * key stored in `event.color`. */
const GOOGLE_EVENT_COLORS: Record<string, string> = {
  "1": "#7986cb", // Lavender
  "2": "#33b679", // Sage
  "3": "#8e24aa", // Grape
  "4": "#e67c73", // Flamingo
  "5": "#f6c026", // Banana
  "6": "#f5511d", // Tangerine
  "7": "#039be5", // Peacock
  "8": "#616161", // Graphite
  "9": "#3f51b5", // Blueberry
  "10": "#0b8043", // Basil
  "11": "#d60000", // Tomato
};

/** App palette hues, in the same order as the `--event-N` custom properties. */
const PALETTE_HUES = [20, 50, 90, 150, 195, 240, 285, 325];

/** Below this oklch chroma a source color reads as gray, not as a hue. */
const NEUTRAL_CHROMA = 0.03;

const NEUTRAL_VAR = "--event-neutral";

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Chroma and hue (degrees) of a `#rrggbb` color in oklch. Lightness is
 * discarded — the palette fixes it. */
function hexToChromaHue(hex: string): { chroma: number; hue: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const int = Number.parseInt(m[1], 16);
  const r = srgbToLinear(((int >> 16) & 0xff) / 255);
  const g = srgbToLinear(((int >> 8) & 0xff) / 255);
  const b = srgbToLinear((int & 0xff) / 255);

  // Linear sRGB -> LMS -> Oklab (Björn Ottosson's matrices).
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m2 = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const labA = 1.9779984951 * l - 2.428592205 * m2 + 0.4505937099 * s;
  const labB = 0.0259040371 * l + 0.7827717662 * m2 - 0.808675766 * s;

  return {
    chroma: Math.hypot(labA, labB),
    hue: (Math.atan2(labB, labA) * (180 / Math.PI) + 360) % 360,
  };
}

/** Shortest distance between two hues on the 360° circle. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const snapCache = new Map<string, string>();

/** The `--event-*` variable whose hue is closest to `hex`. */
export function snapToPalette(hex: string): string {
  const cached = snapCache.get(hex);
  if (cached) return cached;

  const oklch = hexToChromaHue(hex);
  let result = NEUTRAL_VAR;
  if (oklch && oklch.chroma >= NEUTRAL_CHROMA) {
    let best = 0;
    for (let i = 1; i < PALETTE_HUES.length; i++) {
      if (hueDistance(oklch.hue, PALETTE_HUES[i]) < hueDistance(oklch.hue, PALETTE_HUES[best])) {
        best = i;
      }
    }
    result = `--event-${best + 1}`;
  }
  snapCache.set(hex, result);
  return result;
}

/**
 * The colours the create panel can offer, one Google `color` key per palette
 * hue it can actually produce. Derived by inverting `snapToPalette` over
 * Google's palette rather than listing `--event-*` directly: several Google
 * colours snap to the same hue (first wins), and at least one app hue has no
 * Google colour at all — offering it would save a colour that renders as its
 * neighbour.
 */
export const EVENT_COLOR_CHOICES: { color: string; colorVar: string }[] =
  (() => {
    const byVar = new Map<string, string>();
    for (const [color, hex] of Object.entries(GOOGLE_EVENT_COLORS)) {
      const colorVar = snapToPalette(hex);
      if (!byVar.has(colorVar)) byVar.set(colorVar, color);
    }
    const order = [...PALETTE_HUES.map((_, i) => `--event-${i + 1}`), NEUTRAL_VAR];
    return order
      .filter((colorVar) => byVar.has(colorVar))
      .map((colorVar) => ({ colorVar, color: byVar.get(colorVar) as string }));
  })();

/** Deterministic palette entry for an id, used when the provider gave us no
 * color at all (e.g. an event created locally before its calendar synced). */
function hashedVar(id: string): string {
  let hash = 0;
  for (const ch of id) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  return `--event-${(Math.abs(hash) % PALETTE_HUES.length) + 1}`;
}

/**
 * Resolve an event to a palette variable: its own `color` first, then its
 * calendar's color, then a hash of the calendar id. The color map is keyed by
 * the local calendar `_id` — provider calendar strings collide across
 * connections.
 */
export function eventColorVar(
  event: CalendarEvent,
  calendarColors?: Map<string, string | undefined>,
): string {
  const own = event.color ? GOOGLE_EVENT_COLORS[event.color] : undefined;
  const hex =
    own ??
    (event.localCalendarId ? calendarColors?.get(event.localCalendarId) : undefined);
  return hex ? snapToPalette(hex) : hashedVar(event.localCalendarId ?? event._id);
}

/**
 * `(event) => "--event-N"`, with the user's calendar colors loaded. Convex
 * dedupes the underlying subscription, so several components may call this.
 */
export function useEventColor(): (event: CalendarEvent) => string {
  const calendars = useQuery(api.domains.calendar.queries.listCalendars);
  const colors = useMemo(
    () =>
      new Map<string, string | undefined>(
        calendars?.map((c) => [c._id, c.backgroundColor]) ?? [],
      ),
    [calendars],
  );
  return useCallback((event: CalendarEvent) => eventColorVar(event, colors), [colors]);
}

/** Palette variable for a calendar itself (dots and toggles in the header). */
export function calendarColorVar(calendar: {
  _id: string;
  backgroundColor?: string;
}): string {
  return calendar.backgroundColor
    ? snapToPalette(calendar.backgroundColor)
    : hashedVar(calendar._id);
}
