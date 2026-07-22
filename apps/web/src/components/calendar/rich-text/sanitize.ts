import DOMPurify from "dompurify";

/** The single source of truth for the description HTML subset. Both the editor
 * (via its extension set) and the read renderer stay within this allowlist —
 * it mirrors what Google Calendar keeps in a description, so the value survives
 * the Google round-trip without surprises. */
const ALLOWED_TAGS = [
  "b",
  "strong",
  "i",
  "em",
  "u",
  "p",
  "br",
  "ul",
  "ol",
  "li",
  "a",
] as const;

const ALLOWED_ATTR = ["href", "target", "rel"] as const;

/** Sanitize stored/synced description HTML before it is rendered. Synced Google
 * descriptions are untrusted input, so this is the security boundary — scripts,
 * styles, images, iframes and inline handlers are all stripped. Links are forced
 * to open safely (see the hook below). */
export function sanitizeDescriptionHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    // Only allow http/https/mailto targets; everything else (javascript:, data:)
    // is dropped by DOMPurify's default URI policy, which we keep.
    ALLOW_DATA_ATTR: false,
  });
}

// Harden every surviving anchor: open in a new tab and cut the opener/referrer
// link so a description can never reach back into the app or leak the URL.
if (typeof window !== "undefined") {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noreferrer nofollow noopener");
    }
  });
}

/** True when editor HTML carries no real content — TipTap emits "<p></p>" for an
 * empty document, which should be stored as "no description" rather than markup. */
export function isEmptyDescriptionHtml(html: string): boolean {
  return html.replace(/<[^>]*>/g, "").trim().length === 0;
}
