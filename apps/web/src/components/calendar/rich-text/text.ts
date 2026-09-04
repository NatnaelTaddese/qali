function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Normalize a stored/synced description into the block-per-line HTML the editor
 * expects. Google descriptions arrive either as plain text with newlines or as a
 * single paragraph joined by `<br>`; both leave every "line" inside one block, so
 * a list toggle would wrap the whole description instead of the current line.
 * Promoting each line to its own `<p>` makes list/blockquote toggles act per line
 * and preserves plain-text newlines (which TipTap would otherwise collapse). */
export function toEditorHtml(input: string): string {
  if (!input) return "";
  const hasTags = /<[a-z][\s\S]*>/i.test(input);
  if (!hasTags) {
    return input
      .split(/\r?\n/)
      .map((line) => (line.trim() === "" ? "<p></p>" : `<p>${escapeHtml(line)}</p>`))
      .join("");
  }
  // Hard breaks become paragraph breaks; the DOM parser in setContent re-nests
  // anything this leaves slightly malformed (e.g. a `<br>` inside a list item).
  return input.replace(/<br\s*\/?>/gi, "</p><p>");
}

/** Collapse description HTML to a single line of plain text, for one-line
 * previews (the create dock's "Add description" button). Decodes entities and
 * squashes whitespace.
 *
 * The HTML is untrusted — it is whatever the event's author put in a Google
 * description — so it must never touch the live document. Assigning it to a
 * created element's `innerHTML` is not safe even when that element is never
 * attached: the parser instantiates real nodes, an `<img>` starts loading the
 * moment `src` is set, and its `onerror` runs with the app's session. Parse it
 * in an inert document instead, where nothing loads and no handler fires. */
export function htmlToPreviewText(html: string): string {
  if (!html) return "";
  if (typeof DOMParser === "undefined") {
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}
