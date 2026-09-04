import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";

import { env } from "@qali/env/server";

import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

const siteUrl = env.SITE_URL;

export const authComponent = createClient<DataModel>(components.betterAuth);

function withErrorCode(url: string, code: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}error=${code}`;
}

/**
 * Bind an account-link OAuth callback to the session that started it.
 *
 * The cross-domain plugin stores OAuth state in the database and skips Better
 * Auth's state cookie check, so a `/callback/google` request is tied to the
 * `state` parameter alone. For a plain sign-in that is harmless; for a link
 * flow it is not: the state names the user the new grant will be attached to,
 * and Better Auth's link branch never checks that the browser finishing the
 * flow belongs to that user. With `allowDifferentEmails` on (a second Google
 * account is by definition a different email) nothing else stops an attacker
 * from minting a link URL for their own account, handing it to a victim, and
 * receiving the victim's calendar grant when the victim consents.
 *
 * This hook runs before the callback handler, while the state row still
 * exists: if the state carries a `link`, the request must present a session
 * for that same user or the link is refused and the state consumed.
 */
const bindLinkCallbackToSession = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/callback/:id") return;
  const state = ctx.query?.state;
  if (typeof state !== "string" || !state) return;
  const row = await ctx.context.internalAdapter.findVerificationValue(state);
  // A missing or malformed state is the handler's own error to report.
  if (!row) return;
  let link: { userId: string } | undefined;
  let errorURL: string | undefined;
  try {
    const data = JSON.parse(row.value) as {
      link?: { userId?: unknown };
      errorURL?: unknown;
    };
    if (typeof data.errorURL === "string") errorURL = data.errorURL;
    if (data.link && data.link.userId !== undefined) {
      link = { userId: String(data.link.userId) };
    }
  } catch {
    return;
  }
  if (!link) return;
  const session = await getSessionFromCtx(ctx);
  if (session?.user.id === link.userId) return;
  await ctx.context.internalAdapter.deleteVerificationByIdentifier(state);
  throw ctx.redirect(
    withErrorCode(errorURL ?? `${siteUrl}/`, "link_session_mismatch"),
  );
});

function createAuth(ctx: GenericCtx<DataModel>) {
  return betterAuth({
    baseURL: env.CONVEX_SITE_URL,
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    // Login is OAuth-only, so there is no cheap way to re-prove freshness;
    // without this, unlink-account (used by disconnect) rejects any session
    // older than Better Auth's default freshness window.
    session: { freshAge: 0 },
    // The browser never needs a raw Google token: every provider call goes
    // through the server-side credential broker (integrations/google/
    // credentials.ts), which calls `auth.api.getAccessToken` directly and is
    // unaffected by the HTTP router refusing these paths. Leaving them mounted
    // would let any script running in the app (or a stolen session token) turn
    // a session into a durable, session-independent Google refresh token.
    disabledPaths: ["/refresh-token", "/get-access-token", "/account-info"],
    hooks: { before: bindLinkCallbackToSession },
    account: {
      // Refresh tokens outlive sessions and are only revocable from Google's
      // side; encrypt them at rest so a dashboard view, snapshot export or
      // backup doesn't hand out live calendar access. Rows written before
      // this was enabled are read as-is and re-encrypted on their next refresh.
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        // A second Google account is by definition a different email. The
        // email check is Better Auth's only cross-user guard on the link
        // callback, so disabling it is what makes bindLinkCallbackToSession
        // above necessary.
        allowDifferentEmails: true,
        trustedProviders: ["google"],
      },
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Request a refresh token so the backend can call Google APIs later.
        accessType: "offline",
        // Force the consent screen so a refresh token is (re)issued each time.
        prompt: "select_account consent",
        // Appended to the default openid/email/profile identity scopes.
        scope: [
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/contacts.readonly",
          // Read auto-collected "Other contacts" — the source of avatars for
          // people the user has interacted with but never saved.
          "https://www.googleapis.com/auth/contacts.other.readonly",
        ],
      },
    },
    plugins: [
      crossDomain({ siteUrl }),
      convex({
        authConfig,
        jwksRotateOnTokenGenerationError: true,
      }),
    ],
  });
}

export { createAuth };
