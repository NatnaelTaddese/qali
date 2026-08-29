/** Write side of the preferences domain. Registration is canonical here, under
 * `api.domains.preferences.mutations.*`. */

import { v, type Infer } from "convex/values";

import { mutation, type MutationCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import { preferenceFields } from "./tables";

const WRITABLE_ACCESS_ROLES = new Set(["owner", "writer"]);

const resettableField = v.union(
  v.literal("timeZone"),
  v.literal("weekStartsOn"),
  v.literal("timeFormat"),
  v.literal("defaultView"),
  v.literal("defaultCalendarId"),
);

const updateArgs = v.object({
  ...preferenceFields,
  // Fields to put back to "automatic". A reset wins over a set of the same
  // field in one call — resetting is the more deliberate gesture.
  reset: v.optional(v.array(resettableField)),
});

type UpdateArgs = Infer<typeof updateArgs>;

/** Upsert the user's single preferences row. Exported so itests can drive it
 * with an explicit userId via t.run (Better Auth isn't registered there). */
export async function updatePreferencesCore(
  ctx: MutationCtx,
  userId: string,
  args: UpdateArgs,
): Promise<null> {
  if (args.timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: args.timeZone });
    } catch {
      throw new Error("Unknown time zone");
    }
  }
  if (args.defaultCalendarId !== undefined) {
    const calendar = await ctx.db.get(args.defaultCalendarId);
    if (
      !calendar ||
      calendar.userId !== userId ||
      calendar.isShared ||
      !WRITABLE_ACCESS_ROLES.has(calendar.accessRole ?? "")
    ) {
      throw new Error("Calendar not found or read-only");
    }
  }

  const patch: Record<string, unknown> = {};
  for (const field of Object.keys(preferenceFields) as (keyof Omit<
    UpdateArgs,
    "reset"
  >)[]) {
    if (args[field] !== undefined) patch[field] = args[field];
  }
  // Patching a field to undefined removes it — "back to automatic".
  for (const field of args.reset ?? []) {
    patch[field] = undefined;
  }

  const existing = await ctx.db
    .query("userPreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, { ...patch, updatedAt: Date.now() });
  } else {
    await ctx.db.insert("userPreferences", {
      userId,
      ...patch,
      updatedAt: Date.now(),
    });
  }
  return null;
}

export const updatePreferences = mutation({
  args: updateArgs.fields,
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }
    return updatePreferencesCore(ctx, user._id, args);
  },
});
