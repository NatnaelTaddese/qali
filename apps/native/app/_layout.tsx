import "@/global.css";
import { type AuthClient, ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { useConvexAuth } from "convex/react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { HeroUINativeProvider } from "heroui-native";
import { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";

import { AppThemeProvider } from "@/contexts/app-theme-context";
import { authClient } from "@/lib/auth-client";
import { convex } from "@/lib/convex";

// Hold the native splash until Convex knows whether a session exists, so the
// app never flashes the sign-in screen at a signed-in user.
void SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  // Latched: once the navigator has mounted it must stay mounted, or a later
  // token refresh would tear down the whole route tree.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isLoading || ready) return;
    setReady(true);
    void SplashScreen.hideAsync();
  }, [isLoading, ready]);

  if (!ready) return null;

  // The guards pick the initial route and redirect whenever auth flips:
  // sign-in lands on (app), sign-out lands on (auth).
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={isAuthenticated}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={!isAuthenticated}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
  );
}

// heroui-native text (Button.Label, Avatar.Fallback, …) does not inherit a
// font; screens pass `font-sans` to those labels explicitly.
const heroUIConfig = { devInfo: { stylingPrinciples: false } } as const;

export default function Layout() {
  return (
    <ConvexBetterAuthProvider
      client={convex}
      // Same cast as apps/web/src/main.tsx: @convex-dev/better-auth 0.12.5's
      // AuthClient alias was typed against better-auth 1.6.15 and collapses
      // to `never` against 1.6.30.
      authClient={authClient as unknown as AuthClient}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardProvider>
          <AppThemeProvider>
            <HeroUINativeProvider config={heroUIConfig}>
              <RootNavigator />
            </HeroUINativeProvider>
          </AppThemeProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </ConvexBetterAuthProvider>
  );
}
