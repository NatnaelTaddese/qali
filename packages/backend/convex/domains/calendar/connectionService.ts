/** The linking side of the connection model: turning the Google grants Better
 * Auth holds for a user into `calendarConnections` rows. Registration is
 * canonical here, under `api.domains.calendar.connectionService.*`. */

import { v } from "convex/values";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { action, type ActionCtx } from "../../_generated/server";
import { authComponent, createAuth } from "../../auth";
import {
  fetchGoogleUserProfile,
  getGoogleAccessToken,
} from "../../integrations/google/credentials";

/** Diff Better Auth's Google grants against the user's connection rows and
 * create what's missing, then stamp each unstamped connection's profile
 * (email, name, photo) from the grant's stored ID token. The profile is
 * cosmetic and best-effort: a failed fetch is only logged, and the first
 * sync still stamps the email from the primary calendar id
 * (reconcileCalendars) regardless. */
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
  const result: {
    created: number;
    pendingIdentity: {
      connectionId: Id<"calendarConnections">;
      credentialRef: string;
    }[];
  } = await ctx.runMutation(
    internal.domains.calendar.mutations.reconcileLinkedAccounts,
    { userId, accounts },
  );
  for (const pending of result.pendingIdentity) {
    let profile: Awaited<ReturnType<typeof fetchGoogleUserProfile>> = null;
    try {
      // The broker resolves (and refreshes) this grant's token; the userinfo
      // endpoint then works for every grant, unlike decoding a stored ID
      // token, which a refresh cycle may not have kept.
      const accessToken = await getGoogleAccessToken(
        ctx,
        userId,
        pending.credentialRef,
      );
      profile = await fetchGoogleUserProfile(accessToken);
    } catch (error) {
      console.warn(
        "Linked-account profile fetch failed:",
        error instanceof Error ? error.message : error,
      );
    }
    // Stamped even when the profile is missing: the mutation records the
    // attempt, which is what stops a revoked or nameless grant from being
    // refetched on every sync.
    await ctx.runMutation(
      internal.domains.calendar.mutations.stampConnectionIdentity,
      {
        userId,
        connectionId: pending.connectionId,
        providerAccountId: profile?.email,
        providerAccountName: profile?.name,
        providerAccountImageUrl: profile?.picture,
      },
    );
  }
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

/** Tell Google the grant is finished. Better Auth's unlink only deletes its
 * own row; without this the refresh token stays valid at Google until the
 * user finds it on their account page. Revoking the access token revokes the
 * whole grant. Best-effort: a failure here is logged, not fatal — the local
 * removal must go ahead regardless. */
async function revokeGoogleGrant(
  ctx: ActionCtx,
  userId: string,
  credentialRef: string,
): Promise<void> {
  try {
    const accessToken = await getGoogleAccessToken(ctx, userId, credentialRef);
    const response = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken }),
    });
    if (!response.ok) {
      console.warn(`Google grant revoke returned ${response.status}`);
    }
  } catch (error) {
    console.warn(
      "Google grant revoke failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

/** Remove a linked account: revoke the grant at Google, then the Better Auth
 * account row (so the reconcile safety net can't resurrect the connection),
 * take it out of the sync fan-out, and purge everything it synced in the
 * background. The sole remaining account can only be paused, never
 * disconnected — that would strand the user's login. */
export const disconnectAccount = action({
  args: { connectionId: v.id("calendarConnections") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const target: {
      connection: Doc<"calendarConnections">;
      providerConnectionCount: number;
    } | null = await ctx.runQuery(
      internal.domains.calendar.queries.getConnectionForRemoval,
      { connectionId: args.connectionId, userId: user._id },
    );
    if (!target) throw new Error("Connection not found");
    const { connection, providerConnectionCount } = target;
    if (providerConnectionCount < 2) {
      throw new Error(
        "Your only account can't be disconnected — pause it instead",
      );
    }
    if (!connection.credentialRef) {
      // Without a credentialRef there is no grant to target; the next sync's
      // reconcile stamps it, so this is transient.
      throw new Error(
        "This account hasn't finished connecting — try again after a sync",
      );
    }
    await revokeGoogleGrant(ctx, user._id, connection.credentialRef);
    const auth = createAuth(ctx);
    const headers = await authComponent.getHeaders(ctx);
    try {
      await auth.api.unlinkAccount({
        body: {
          providerId: connection.provider,
          accountId: connection.credentialRef,
        },
        headers,
      });
    } catch (error) {
      // A grant a previous partial disconnect already revoked is fine — the
      // point of this call is that it be gone. Anything else aborts before
      // any data is touched.
      const message = error instanceof Error ? error.message : String(error);
      if (!/account.*not.*found/i.test(message)) throw error;
    }
    await ctx.runMutation(
      internal.domains.calendar.mutations.pauseConnectionForRemoval,
      { connectionId: args.connectionId, userId: user._id },
    );
    await ctx.scheduler.runAfter(
      0,
      internal.jobs.maintenance.purgeConnectionData,
      { connectionId: args.connectionId, userId: user._id },
    );
    return null;
  },
});
