import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const convexUrlSchema = (exampleHost: string) =>
  z.url().refine((url) => new URL(url).hostname !== exampleHost, {
    message: `Replace the ${exampleHost} placeholder before running the app`,
  });

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
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
