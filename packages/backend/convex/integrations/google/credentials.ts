import type { GenericCtx } from "@convex-dev/better-auth";

import type { DataModel } from "../../_generated/dataModel";
import { createAuth } from "../../auth";

/**
 * The credential broker: the single place a Google access token is resolved.
 *
 * Better Auth owns the OAuth refresh, so the token is always fetched at use time
 * rather than stored. Passing no `headers` makes Better Auth resolve by `userId`,
 * which is what lets this run from both authenticated actions (calendar writes,
 * booking acceptance) and session-less crons (background sync) through the same
 * function. `GenericCtx<DataModel>` is the broadest ctx every caller satisfies.
 *
 * This replaced three copy-pasted resolvers. It is deliberately the choke point
 * for provider credentials: when the connection model lands it becomes
 * connection-aware, and today connection == the user's Google login grant.
 */
export async function getGoogleAccessToken(
  ctx: GenericCtx<DataModel>,
  userId: string,
  credentialRef?: string,
): Promise<string> {
  const { accessToken } = await createAuth(ctx).api.getAccessToken({
    body: {
      providerId: "google",
      userId,
      accountId: credentialRef,
    },
  });
  if (!accessToken) {
    throw new Error("No Google access token available for user");
  }
  return accessToken;
}
