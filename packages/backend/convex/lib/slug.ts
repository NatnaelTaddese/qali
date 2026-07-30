/**
 * Booking-page slug rules. Import-free, like ./permissions.ts and
 * ./availability.ts, so the claim form can normalize and validate as the host
 * types against exactly the rules the mutation enforces.
 */

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 30;

/** Paths the SPA already owns, plus names a future route would want back. The
 * public page lives at the site root, so a slug that collides with one of these
 * would either shadow a real route or be shadowed by it. */
const RESERVED_SLUGS = new Set([
  "about",
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "billing",
  "book",
  "booking",
  "bookings",
  "calendar",
  "contact",
  "dashboard",
  "docs",
  "help",
  "home",
  "login",
  "logout",
  "new",
  "pricing",
  "privacy",
  "public",
  "qali",
  "root",
  "settings",
  "signin",
  "signup",
  "static",
  "support",
  "terms",
  "user",
  "users",
]);

/**
 * Coerce free-typed text toward a legal slug: lower-cased, spaces and
 * underscores folded to hyphens, everything else dropped, runs of hyphens
 * collapsed. Length is deliberately *not* enforced here — trimming as someone
 * types would fight the input — so always follow with `slugError`.
 */
export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, SLUG_MAX_LENGTH);
}

/** Why this slug can't be used, or null when it is fine. The message is shown
 * to the host verbatim, so it names the rule rather than restating the input. */
export function slugError(slug: string): string | null {
  if (slug.length < SLUG_MIN_LENGTH) {
    return `Use at least ${SLUG_MIN_LENGTH} characters`;
  }
  if (slug.length > SLUG_MAX_LENGTH) {
    return `Use at most ${SLUG_MAX_LENGTH} characters`;
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return "Use lowercase letters, numbers and hyphens only";
  }
  if (slug.startsWith("-") || slug.endsWith("-")) {
    return "Can't start or end with a hyphen";
  }
  if (RESERVED_SLUGS.has(slug)) {
    return "That name is reserved";
  }
  return null;
}
