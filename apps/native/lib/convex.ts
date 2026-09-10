import { env } from "@qali/env/native";
import { ConvexReactClient } from "convex/react";

// `expectAuth` is deliberately off: it would hold the socket until a token
// exists and stall the sign-in screen's unauthenticated queries. There is no
// `beforeunload` on native, so the unsaved-changes warning is noise.
export const convex = new ConvexReactClient(env.EXPO_PUBLIC_CONVEX_URL, {
  unsavedChangesWarning: false,
});
