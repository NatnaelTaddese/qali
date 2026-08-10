// @ts-expect-error Bun supplies its test module at runtime; the marketing app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Mascot,
  clamp,
  mascotPointerTarget,
  type MascotBounds,
} from "./mascot";

const bounds: MascotBounds = {
  left: 100,
  top: 100,
  right: 300,
  bottom: 280,
  width: 200,
  height: 180,
};

describe("mascot pointer geometry", () => {
  test("clamps values to the requested range", () => {
    expect(clamp(-3, -1, 1)).toBe(-1);
    expect(clamp(0.25, -1, 1)).toBe(0.25);
    expect(clamp(4, -1, 1)).toBe(1);
  });

  test("returns normalized movement inside the mascot", () => {
    expect(mascotPointerTarget(200, 190, bounds, 160)).toEqual({
      x: 0,
      y: 0,
      strength: 1,
    });

    const target = mascotPointerTarget(300, 190, bounds, 160);
    expect(target?.strength).toBe(1);
    expect(target?.x).toBeCloseTo(100 / 260);
    expect(target?.y).toBe(0);
  });

  test("fades through the proximity halo and stops outside it", () => {
    const halfway = mascotPointerTarget(380, 190, bounds, 160);
    expect(halfway?.strength).toBeCloseTo(0.5);
    expect(mascotPointerTarget(461, 190, bounds, 160)).toBeNull();
  });
});

describe("mascot SVG", () => {
  test("namespaces SVG resources for every instance", () => {
    const markup = renderToStaticMarkup(
      <div>
        <Mascot />
        <Mascot />
      </div>,
    );
    const ids = [...markup.matchAll(/id="(mascot-[^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
