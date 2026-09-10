import { expoClient } from "@better-auth/expo/client";
import { convexClient, crossDomainClient } from "@convex-dev/better-auth/client/plugins";
import { env } from "@qali/env/native";
import { createAuthClient } from "better-auth/react";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// The deep-link scheme from app.json doubles as the SecureStore key prefix,
// so a scheme change also invalidates every cached session.
const scheme = Constants.expoConfig?.scheme as string;

export const authClient = createAuthClient({
  baseURL: env.EXPO_PUBLIC_CONVEX_SITE_URL,
  plugins: [
    convexClient(),
    // On native the Expo client owns the session cookie (SecureStore) and the
    // browser-based OAuth hand-off; the web build talks to Convex from a
    // different origin like apps/web does and needs the cross-domain client.
    Platform.OS === "web"
      ? crossDomainClient()
      : expoClient({
          scheme,
          storagePrefix: scheme,
          storage: SecureStore,
        }),
  ],
});
