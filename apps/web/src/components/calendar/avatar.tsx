import { cn } from "@qali/ui/lib/utils";
import { useEffect, useState } from "react";

/** How many hues the `--event-*` palette offers (see globals.css / colors.ts). */
const PALETTE_SIZE = 8;

/** Deterministic `--event-N` palette variable for a key (e.g. an email), so a
 * given guest always gets the same colour across the picker and the detail view. */
export function avatarColorVar(key: string): string {
  let hash = 0;
  for (const ch of key.toLowerCase()) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  return `--event-${(Math.abs(hash) % PALETTE_SIZE) + 1}`;
}

/** First letter of a display name, falling back to the email's first letter. */
export function initial(nameOrEmail: string): string {
  const trimmed = nameOrEmail.trim();
  return (trimmed[0] ?? "?").toUpperCase();
}

/** A round guest avatar: the contact photo when we have one, otherwise a
 * colour-coded circle with the initial. The palette colours stay light in both
 * themes, so the dark initial always reads. Size comes from `className`.
 *
 * Google contact/profile photos (`lh3.googleusercontent.com`) 403 when the
 * browser sends a cross-origin referer, so we strip it with `referrerPolicy`;
 * anything that still fails falls back to the initial via `onError`. */
export function Avatar({
  email,
  name,
  photoUrl,
  className,
}: {
  email: string;
  name?: string;
  photoUrl?: string;
  className?: string;
}) {
  const label = name?.trim() || email;
  const [failed, setFailed] = useState(false);
  // Reset when the source changes so a new URL gets a fresh attempt.
  useEffect(() => setFailed(false), [photoUrl]);

  if (photoUrl && !failed) {
    return (
      <img
        src={photoUrl}
        alt={label}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn("size-7 rounded-full bg-muted object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-7 items-center justify-center rounded-full text-xs font-semibold text-black/75",
        className,
      )}
      style={{ backgroundColor: `var(${avatarColorVar(email)})` }}
    >
      {initial(label)}
    </span>
  );
}
