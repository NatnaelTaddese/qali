import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";

import { env } from "@qali/env/server";

import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

const siteUrl = env.SITE_URL;

export const authComponent = createClient<DataModel>(components.betterAuth);

function createAuth(ctx: GenericCtx<DataModel>) {
  return betterAuth({
    baseURL: env.CONVEX_SITE_URL,
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    // Login is OAuth-only, so there is no cheap way to re-prove freshness;
    // without this, unlink-account (used by disconnect) rejects any session
    // older than Better Auth's default freshness window.
    session: { freshAge: 0 },
    account: {
      accountLinking: {
        enabled: true,
        // A second Google account is by definition a different email; the
        // linked grant still lands on the signed-in user, never a lookup by
        // email, so this doesn't open account-takeover-by-email.
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
