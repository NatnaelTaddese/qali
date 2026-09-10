import { createEnv } from "@t3-oss/env-core";

import { convexUrlSchema } from "./shared";

export const env = createEnv({
  isServer: false,
  clientPrefix: "EXPO_PUBLIC_",
  client: {
    EXPO_PUBLIC_CONVEX_URL: convexUrlSchema("example.convex.cloud"),
    EXPO_PUBLIC_CONVEX_SITE_URL: convexUrlSchema("example.convex.site"),
  },
  // Expo's babel plugin only rewrites literal `process.env.EXPO_PUBLIC_*`
  // member expressions, so every key must be spelled out here; passing
  // `process.env` itself would leave the object empty at runtime.
  runtimeEnv: {
    EXPO_PUBLIC_CONVEX_URL: process.env.EXPO_PUBLIC_CONVEX_URL,
    EXPO_PUBLIC_CONVEX_SITE_URL: process.env.EXPO_PUBLIC_CONVEX_SITE_URL,
  },
  emptyStringAsUndefined: true,
});
