// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { isEmptyDescriptionHtml, sanitizeDescriptionHtml } from "./sanitize";

describe("sanitizeDescriptionHtml", () => {
  test("keeps the description subset", () => {
    expect(
      sanitizeDescriptionHtml("<p>Hi <b>there</b><br><ul><li>one</li></ul></p>"),
    ).toContain("<b>there</b>");
  });

  test("drops scripts, handlers, and non-http link targets", () => {
    const dirty = [
      '<img src="x" onerror="alert(1)">',
      "<script>alert(1)</script>",
      '<a href="javascript:alert(1)">j</a>',
      '<a href="java\tscript:alert(1)">t</a>',
      '<a href="javascript&colon;alert(1)">c</a>',
      '<a href="data:text/html,x">d</a>',
      "<svg><script>alert(1)</script></svg>",
      "<style>body{display:none}</style>",
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<form><input name="x"></form>',
      "<p onclick=\"alert(1)\">p</p>",
    ].join("");
    const clean = sanitizeDescriptionHtml(dirty);
    expect(clean).not.toMatch(/<(img|script|svg|style|iframe|form|input)/i);
    expect(clean).not.toMatch(/on[a-z]+=/i);
    expect(clean).not.toMatch(/javascript|data:/i);
    expect(clean).toContain("<p>p</p>");
  });

  test("forces surviving links to open safely", () => {
    const clean = sanitizeDescriptionHtml('<a href="https://example.com">x</a>');
    expect(clean).toContain('target="_blank"');
    expect(clean).toContain('rel="noreferrer nofollow noopener"');
  });
});

describe("isEmptyDescriptionHtml", () => {
  test("treats markup-only content as empty", () => {
    expect(isEmptyDescriptionHtml("<p></p>")).toBe(true);
    expect(isEmptyDescriptionHtml("<p>x</p>")).toBe(false);
  });
});
