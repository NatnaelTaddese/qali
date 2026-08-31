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
/** The account's OpenID profile (email, name, photo) for the settings card.
 * Fetched from the standard userinfo endpoint rather than decoded from a
 * stored ID token, which a refresh cycle may not have kept. Best-effort:
 * a non-OK response is null, never an error. */
export async function fetchGoogleUserProfile(accessToken: string): Promise<{
  email?: string;
  name?: string;
  picture?: string;
} | null> {
  const response = await fetch(
    "https://www.googleapis.com/oauth2/v3/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) return null;
  const data: unknown = await response.json();
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  return {
    email: typeof record.email === "string" ? record.email : undefined,
    name: typeof record.name === "string" ? record.name : undefined,
    picture: typeof record.picture === "string" ? record.picture : undefined,
  };
}

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
