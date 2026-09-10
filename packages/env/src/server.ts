import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

import { convexUrlSchema } from "./shared";

export const env = createEnv({
  server: {
    SITE_URL: z.url(),
    CONVEX_SITE_URL: convexUrlSchema("example.convex.site"),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    // Optional on purpose. Without it the AI assistant is simply absent — the
    // rest of the app must keep working, so this can never be required here:
    // `auth.ts` imports this module, so a failed validation would take down
    // every backend function rather than just the assistant.
    DEEPSEEK_API_KEY: z.string().min(1).optional(),
    // Web Push (VAPID). Optional for the same reason: without them reminders
    // still fire in-app and in an open tab, and the push toggle stays hidden.
    // Generate once with `bunx web-push generate-vapid-keys`; the pair must
    // be set on every deployment that should push.
    VAPID_PUBLIC_KEY: z.string().min(1).optional(),
    VAPID_PRIVATE_KEY: z.string().min(1).optional(),
    VAPID_SUBJECT: z
      .string()
      .regex(/^(mailto:|https:)/, "VAPID_SUBJECT must be a mailto: or https: URL")
      .optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
