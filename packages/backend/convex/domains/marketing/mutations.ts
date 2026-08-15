/** Write handler for the marketing domain. Plain function; the root
 * `waitlist.ts` facade wraps it in a Convex `mutation`. */

import { ConvexError } from "convex/values";

import type { MutationCtx } from "../../_generated/server";
import { consumeRateLimit } from "../../infrastructure/rateLimit";

const RATE_WINDOW_MS = 60 * 60 * 1000;
// A hard hourly cap on total new signups across everyone. This is the real guard
// on an anonymous surface with no client IP: it bounds how many unique-email rows
// an attacker can create per hour (dedupe already collapses repeats of one
// address). Generous enough for a launch spike; tune down if abuse appears, or
// move to the sharded `@convex-dev/rate-limiter` if the single global key turns
// hot. See consumeRateLimit.
const MAX_JOINS_GLOBAL = 600;
// Per-address ceiling, mostly to serialize concurrent submits of the same new
// email so they can't slip past the dedupe check and create duplicate rows.
const MAX_JOINS_PER_EMAIL = 3;

/** Add an email to the waitlist. Idempotent by email: an address already on the
 * list is treated as success without inserting again, so double-submits and
 * retries stay harmless. Rate-limited: a global hourly cap bounds the anonymous
 * write surface, checked before any row (waitlist or counter) is created. */
export async function joinHandler(
  ctx: MutationCtx,
  args: { email: string; source?: string },
): Promise<null> {
  const email = args.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    throw new Error("Please enter a valid email address");
  }

  // Global cap FIRST, so a flood is throttled before it can create either a
  // waitlist row or a per-email counter row.
  if (
    !(await consumeRateLimit(
      ctx,
      "waitlist:global",
      MAX_JOINS_GLOBAL,
      RATE_WINDOW_MS,
    ))
  ) {
    throw new ConvexError({ code: "WAITLIST_RATE_LIMIT" });
  }

  const existing = await ctx.db
    .query("waitlist")
    .withIndex("by_email", (q) => q.eq("email", email))
    .unique();
  if (existing) {
    return null;
  }

  if (
    !(await consumeRateLimit(
      ctx,
      `waitlist:email:${email}`,
      MAX_JOINS_PER_EMAIL,
      RATE_WINDOW_MS,
    ))
  ) {
    throw new ConvexError({ code: "WAITLIST_RATE_LIMIT" });
  }

  await ctx.db.insert("waitlist", {
    email,
    source: args.source,
    createdAt: Date.now(),
  });
  return null;
}
