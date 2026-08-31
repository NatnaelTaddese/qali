/** The linking side of the connection model: turning the Google grants Better
 * Auth holds for a user into `calendarConnections` rows. Registration is
 * canonical here, under `api.domains.calendar.connectionService.*`. */

import { v } from "convex/values";

import { internal } from "../../_generated/api";
import { action, type ActionCtx } from "../../_generated/server";
import { authComponent, createAuth } from "../../auth";

/** Diff Better Auth's Google grants against the user's connection rows and
 * create what's missing. The account email is deliberately not fetched here:
 * the first sync stamps it from the primary calendar id (reconcileCalendars),
 * and any provider call that could fetch it sooner shares the same failure
 * domain as that sync anyway. */
export async function reconcileLinkedAccountsForUser(
  ctx: ActionCtx,
  userId: string,
): Promise<number> {
  const auth = createAuth(ctx);
  const headers = await authComponent.getHeaders(ctx);
  const accounts = (await auth.api.listUserAccounts({ headers }))
    .filter((account) => account.providerId === "google")
    .map((account) => ({
      credentialRef: account.accountId,
      createdAt: new Date(account.createdAt).getTime(),
    }));
  if (accounts.length === 0) return 0;
  const result: { created: number } = await ctx.runMutation(
    internal.domains.calendar.mutations.reconcileLinkedAccounts,
    { userId, accounts },
  );
  return result.created;
}

/** Called when the app returns from a `linkSocial` redirect. The link callback
 * only writes Better Auth's account row, so this is what materializes the
 * connection and starts its first sync. */
export const connectLinkedAccounts = action({
  args: {},
  returns: v.object({ created: v.number() }),
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const created = await reconcileLinkedAccountsForUser(ctx, user._id);
    if (created > 0) {
      await ctx.scheduler.runAfter(0, internal.domains.sync.engine.syncUser, {
        userId: user._id,
      });
    }
    return { created };
  },
});
