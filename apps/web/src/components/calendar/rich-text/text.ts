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
 * squashes whitespace; not a security boundary — never render this as HTML. */
export function htmlToPreviewText(html: string): string {
  if (!html) return "";
  if (typeof document === "undefined") {
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  const el = document.createElement("div");
  el.innerHTML = html;
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}
