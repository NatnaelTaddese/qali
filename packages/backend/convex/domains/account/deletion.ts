/** Account deletion: the in-app "Delete account" action and the internal
 * variant an operator runs to honour an emailed deletion request. Both go
 * through `deleteAccountForUser`, so the two paths can't drift apart.
 * Registered under `api.domains.account.deletion.*` /
 * `internal.domains.account.deletion.*`. */

import { v } from "convex/values";

import { internal } from "../../_generated/api";
import {
  action,
  internalAction,
  internalMutation,
  type ActionCtx,
} from "../../_generated/server";
import { authComponent, createAuth } from "../../auth";
import {
  accessTokenForRevoke,
  revokeGoogleGrant,
} from "../calendar/connectionService";

/**
 * Erase a user end to end. Ordered so that a failure at any step leaves
 * something a retry can finish, never data without an account to reach it:
 *
 * 1. Read a live access token for every Google grant while the Better Auth
 *    account rows (which the credential broker needs) still exist.
 * 2. Pause every connection, taking the user out of the sync fan-out so no
 *    background sync writes rows behind the purge.
 * 3. Revoke each grant at Google. Revoking an access token ends the whole
 *    grant, refresh token included.
 * 4. Purge every user-keyed app table (first batch inline, the rest
 *    self-rescheduled), plus the waitlist row for the account email.
 * 5. Delete the Better Auth user, its account rows (the stored OAuth tokens)
 *    and its sessions. Last, because once the user row is gone the in-app
 *    action can no longer be retried — the admin variant still can.
 *
 * Idempotent: re-running it for a half-deleted user skips grants that are
 * already dead and drains whatever the purge hadn't reached.
 */
async function deleteAccountForUser(
  ctx: ActionCtx,
  userId: string,
  fallbackEmail?: string,
): Promise<{ revokedGrants: number }> {
  const auth = createAuth(ctx);
  const { internalAdapter } = await auth.$context;
  const user = await internalAdapter.findUserById(userId);
  const accounts = await internalAdapter.findAccounts(userId);

  const tokens: string[] = [];
  for (const account of accounts) {
    if (account.providerId !== "google") continue;
    const token = await accessTokenForRevoke(ctx, userId, account.accountId);
    if (token) tokens.push(token);
  }

  await ctx.runMutation(
    internal.domains.account.deletion.pauseConnectionsForDeletion,
    { userId },
  );

  for (const token of tokens) {
    await revokeGoogleGrant(token);
  }

  await ctx.runMutation(internal.jobs.maintenance.purgeUserData, {
    userId,
    email: user?.email ?? fallbackEmail,
  });

  // Accounts, sessions and the user row in one call: this is what Better
  // Auth's own /delete-user endpoint runs, minus the HTTP session plumbing.
  // That endpoint stays disabled (user.deleteUser is off) so a client can't
  // delete the auth rows while skipping the revoke and purge above.
  if (user || accounts.length > 0) {
    await internalAdapter.deleteUser(userId);
  }
  return { revokedGrants: tokens.length };
}

/** Take every one of the user's connections out of the sync fan-out. */
export const pauseConnectionsForDeletion = internalMutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const connections = await ctx.db
      .query("calendarConnections")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(100);
    const now = Date.now();
    for (const connection of connections) {
      if (connection.status !== "paused") {
        await ctx.db.patch(connection._id, { status: "paused", updatedAt: now });
      }
    }
    return null;
  },
});

/** The signed-in user deletes their own account. The client signs out
 * afterwards; its session row is already gone by then. */
export const deleteAccount = action({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) throw new Error("Not authenticated");
    await deleteAccountForUser(ctx, user._id);
    return null;
  },
});

/**
 * Operator path for a deletion request that arrives by email. Find the
 * Better Auth user id for the address (the `user` table of the betterAuth
 * component in the dashboard), then run:
 *
 *   bunx convex run --prod domains/account/deletion:deleteUserAccount \
 *     '{"userId":"<id>","email":"<address>"}'
 *
 * `email` is only needed if the auth user row is already gone (a retry after
 * a partial deletion); otherwise the account's own address is used to clear
 * its waitlist row.
 */
export const deleteUserAccount = internalAction({
  args: { userId: v.string(), email: v.optional(v.string()) },
  returns: v.object({ revokedGrants: v.number() }),
  handler: async (ctx, args): Promise<{ revokedGrants: number }> =>
    await deleteAccountForUser(ctx, args.userId, args.email),
});
