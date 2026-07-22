import { useMemo } from "react";

import { cn } from "@qali/ui/lib/utils";

import { sanitizeDescriptionHtml } from "./sanitize";

/** Read-only render of a stored description. The HTML is always sanitized first
 * (see sanitize.ts) — descriptions synced from Google are untrusted — then the
 * scoped prose styles below give lists and links their shape. */
export function RichTextView({
  html,
  className,
}: {
  html: string;
  className?: string;
}) {
  const clean = useMemo(() => sanitizeDescriptionHtml(html), [html]);
  if (!clean) return null;
  return (
    <div
      className={cn(
        "text-sm text-muted-foreground",
        "[&_p]:my-0 [&_p+p]:mt-1",
        "[&_a]:font-medium [&_a]:text-link [&_a]:underline [&_a]:decoration-link/40 [&_a]:underline-offset-2 [&_a]:hover:decoration-link",
        "[&_u]:text-foreground [&_u]:decoration-foreground/60",
        "[&_ul]:my-0.5 [&_ul]:list-disc [&_ul]:pl-4",
        "[&_ol]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-4",
        "[&_li]:my-0.5",
        className,
      )}
      // Content is sanitized above; the allowlist is the security boundary.
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
