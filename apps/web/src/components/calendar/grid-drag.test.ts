// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import {
  advance,
  beginSession,
  commitRange,
  GRID_DRAG_THRESHOLD_PX,
  type GridDragMode,
  ownsPointer,
} from "./grid-drag";
import { MS_PER_DAY, SNAP_MS } from "./lib";

/** A 960px-tall column starting at viewport y=100 — 40px an hour, so a minute
 * is comfortably above the snap floor and offsets stay easy to read. */
const COLUMN_TOP = 100;
const COLUMN_HEIGHT = 960;
const DAY_START_MS = new Date(2026, 7, 28).getTime();

/** Viewport y for a given hour of the day on the column above. */
function yAt(hour: number): number {
  return COLUMN_TOP + (hour / 24) * COLUMN_HEIGHT;
}

function session(mode: GridDragMode = "create", atHour = 9) {
  return beginSession({
    pointerId: 1,
    mode,
    dayStartMs: DAY_START_MS,
    columnTop: COLUMN_TOP,
    columnHeight: COLUMN_HEIGHT,
    clientX: 50,
    clientY: yAt(atHour),
  });
}

describe("beginSession", () => {
  test("anchors on the snapped press and seeds one snap step", () => {
    const s = session("create", 9);
    expect(s.anchorMs).toBe(DAY_START_MS + 9 * 60 * 60 * 1000);
    expect(s.startMs).toBe(s.anchorMs);
    expect(s.endMs).toBe(s.anchorMs + SNAP_MS);
    expect(s.moved).toBe(false);
  });

  test("holds the anchor a snap step clear of midnight", () => {
    const s = session("paint", 24);
    expect(s.anchorMs).toBe(DAY_START_MS + MS_PER_DAY - SNAP_MS);
  });

  test("a zero-height column does not divide by zero", () => {
    const s = beginSession({
      pointerId: 1,
      mode: "create",
      dayStartMs: DAY_START_MS,
      columnTop: COLUMN_TOP,
      columnHeight: 0,
      clientX: 50,
      clientY: yAt(9),
    });
    expect(Number.isFinite(s.anchorMs)).toBe(true);
    expect(s.anchorMs).toBeGreaterThanOrEqual(DAY_START_MS);
    expect(s.anchorMs).toBeLessThanOrEqual(DAY_START_MS + MS_PER_DAY);
  });
});

describe("advance", () => {
  test("stays a press below the threshold on either axis", () => {
    const s = session();
    expect(advance(s, 50, yAt(9) + GRID_DRAG_THRESHOLD_PX - 1)).toBeNull();
    expect(advance(s, 50 + GRID_DRAG_THRESHOLD_PX - 1, yAt(9))).toBeNull();
    expect(s.moved).toBe(false);
  });

  test("horizontal travel alone promotes the press", () => {
    const s = session();
    expect(advance(s, 50 + GRID_DRAG_THRESHOLD_PX, yAt(9))).not.toBeNull();
    expect(s.moved).toBe(true);
  });

  test("sweeping down grows the range from the anchor", () => {
    const s = session("create", 9);
    const range = advance(s, 50, yAt(11));
    expect(range).toEqual({
      startMs: DAY_START_MS + 9 * 60 * 60 * 1000,
      endMs: DAY_START_MS + 11 * 60 * 60 * 1000,
    });
  });

  test("sweeping up past the anchor keeps the range ordered", () => {
    const s = session("create", 12);
    const range = advance(s, 50, yAt(9));
    expect(range).toEqual({
      startMs: DAY_START_MS + 9 * 60 * 60 * 1000,
      endMs: DAY_START_MS + 12 * 60 * 60 * 1000,
    });
  });

  test("never collapses below one snap step", () => {
    const s = session("create", 9);
    // Cross the threshold horizontally, so the pointer is still on the anchor row.
    const range = advance(s, 50 + GRID_DRAG_THRESHOLD_PX, yAt(9));
    expect(range?.endMs).toBe((range?.startMs ?? 0) + SNAP_MS);
  });

  test("clamps the end at midnight", () => {
    const s = session("paint", 23);
    const range = advance(s, 50, yAt(9999));
    expect(range?.endMs).toBe(DAY_START_MS + MS_PER_DAY);
  });

  test("maps against the geometry captured at pointerdown, not a live rect", () => {
    // Two sessions on the same day, one opened while the column sat 200px
    // higher. The same viewport y must resolve to different times — that is the
    // "measure once" contract that keeps a mid-drag scroll from shifting the
    // selection under the pointer.
    const settled = session("paint", 9);
    const scrolled = beginSession({
      pointerId: 1,
      mode: "paint",
      dayStartMs: DAY_START_MS,
      columnTop: COLUMN_TOP - 200,
      columnHeight: COLUMN_HEIGHT,
      clientX: 50,
      clientY: yAt(9),
    });
    const a = advance(settled, 50, yAt(11));
    const b = advance(scrolled, 50, yAt(11));
    expect(a?.endMs).toBe(DAY_START_MS + 11 * 60 * 60 * 1000);
    expect(b?.endMs).toBeGreaterThan(a?.endMs ?? 0);
  });
});

describe("commitRange", () => {
  test("a press that never moved commits nothing", () => {
    const s = session();
    advance(s, 50, yAt(9) + 1);
    expect(commitRange(s)).toBeNull();
  });

  test("a moved session commits its range", () => {
    const s = session("paint", 9);
    advance(s, 50, yAt(11));
    expect(commitRange(s)).toEqual({
      startMs: DAY_START_MS + 9 * 60 * 60 * 1000,
      endMs: DAY_START_MS + 11 * 60 * 60 * 1000,
    });
  });

  test("the mode is latched at the start and survives the whole gesture", () => {
    const s = session("paint", 9);
    advance(s, 50, yAt(11));
    expect(s.mode).toBe("paint");
  });
});

describe("ownsPointer", () => {
  test("only the pointer that opened the session steers it", () => {
    const s = session();
    expect(ownsPointer(s, 1)).toBe(true);
    expect(ownsPointer(s, 2)).toBe(false);
    expect(ownsPointer(null, 1)).toBe(false);
  });
});
