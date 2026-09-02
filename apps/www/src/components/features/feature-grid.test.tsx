// @ts-expect-error Bun supplies its test module at runtime; the marketing app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AssistantScene } from "./assistant-scene";
import { FeatureGrid } from "./feature-grid";

describe("FeatureGrid", () => {
  const html = renderToStaticMarkup(<FeatureGrid />);

  test("renders one section heading and five feature cells", () => {
    expect(html.match(/<h2/g)?.length).toBe(1);
    expect(html.match(/<h3/g)?.length).toBe(5);
    expect(html.match(/<article/g)?.length).toBe(5);
  });

  test("lays the cells out as a ten-column bento on large screens", () => {
    expect(html).toContain("lg:grid-cols-10");
    expect(html).toContain("lg:col-span-6 lg:col-start-1 lg:row-start-1");
    expect(html).toContain("lg:col-span-4 lg:col-start-7 lg:row-start-1");
    expect(html).toContain("lg:col-span-10 lg:col-start-1 lg:row-start-2");
    expect(html).toContain("lg:col-span-4 lg:col-start-1 lg:row-start-3");
    expect(html).toContain("lg:col-span-6 lg:col-start-5 lg:row-start-3");
  });

  test("keeps the assistant's prompt chips live and the rest decorative", () => {
    // Three prompt chips; the Reset button only appears after a click.
    expect(html.match(/<button/g)?.length).toBe(3);
    expect(html).toContain("Move Focus block to the morning");
    // Each cell's scene wrapper is its article's first child. The assistant's
    // (first in DOM order) stays in the accessibility tree; the other four are
    // decorative.
    const wrappers = [...html.matchAll(/<article[^>]*>\s*<div([^>]*)>/g)].map(
      (m) => m[1],
    );
    expect(wrappers).toHaveLength(5);
    expect(wrappers[0]).not.toContain("aria-hidden");
    for (const attrs of wrappers.slice(1)) {
      expect(attrs).toContain('aria-hidden="true"');
    }
  });

  test("rests the assistant on its fully applied week when still", () => {
    const still = renderToStaticMarkup(
      <AssistantScene playing={false} still />,
    );
    expect(still).toContain("Cleared Friday afternoon");
    expect(still).toContain("Suggested");
  });

  test("rests on a complete still frame", () => {
    // Step 0 of every scene is its richest state: the proposal is pending,
    // a slot is chosen, all availability is painted, both accounts linked.
    expect(html).toContain("Confirm");
    expect(html).toContain("Request 10:00 AM");
    expect(html).toContain("9:00 AM – 12:00 PM");
    expect(html).toContain("nat.t@gmail.com");
    expect(html).not.toContain("<canvas");
  });
});
