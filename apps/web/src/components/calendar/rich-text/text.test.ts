// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { htmlToPreviewText, toEditorHtml } from "./text";

describe("htmlToPreviewText", () => {
  test("collapses markup to one line of text", () => {
    expect(htmlToPreviewText("<p>Hello</p><p>there &amp; <b>you</b></p>")).toBe(
      "Hellothere & you",
    );
    expect(htmlToPreviewText("  a \n\n b  ")).toBe("a b");
    expect(htmlToPreviewText("")).toBe("");
  });

  test("never instantiates untrusted markup in the live document", () => {
    const marker = "__preview_text_sink__";
    (globalThis as Record<string, unknown>)[marker] = false;
    const html =
      `<img src="x" onerror="globalThis['${marker}'] = true">` +
      `<svg onload="globalThis['${marker}'] = true"></svg>Booked`;
    const before = document.body.innerHTML;
    expect(htmlToPreviewText(html)).toBe("Booked");
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelector("img, svg")).toBeNull();
    expect((globalThis as Record<string, unknown>)[marker]).toBe(false);
  });
});

describe("toEditorHtml", () => {
  test("escapes plain text into paragraphs", () => {
    expect(toEditorHtml("a < b\n\nc")).toBe("<p>a &lt; b</p><p></p><p>c</p>");
  });
});
