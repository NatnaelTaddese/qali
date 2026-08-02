// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { completeMarkdown } from "./streaming-markdown";

describe("completeMarkdown", () => {
  test.each([
    "You have **three** meetings.",
    "You have **three",
    "Use ``code with ` inside`` safely.",
    "````ts\nconst fence = `value`;\n````",
    "~~~~md\n**literal markers**\n~~~~",
    String.raw`Escaped \** markers and **nested _emphasis_** stay intact.`,
    "~~outer **nested** marker~~",
    "```\nunfinished fence",
    "",
  ])("never rewrites streamed or completed markdown: %s", (markdown: string) => {
    expect(completeMarkdown(markdown)).toBe(markdown);
  });
});
