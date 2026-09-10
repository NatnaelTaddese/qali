import * as WebBrowser from "expo-web-browser";
import { Spinner } from "heroui-native";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Container } from "@/components/container";
import { Button } from "@/components/button";
import { GoogleIcon } from "@/components/google-icon";
import { Text } from "@/components/text";
import { authClient } from "@/lib/auth-client";

const MARKETING_URL = "https://myqali.com";

export default function SignInScreen() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    setError(null);
    // The Expo client opens the consent screen in a system browser session
    // and resolves only once it closes — after success, cancel, or failure.
    // Success flips the root navigator's guard, so nothing to navigate here.
    const result = await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
      errorCallbackURL: "/sign-in",
    });
    if (result.error) {
      setError(result.error.message || result.error.statusText || "Couldn't start sign-in.");
    }
    setIsLoading(false);
  };

  const openLegal = (path: string) => {
    void WebBrowser.openBrowserAsync(`${MARKETING_URL}${path}`);
  };

  return (
    <Container isScrollable={false}>
      <View
        className="flex-1 items-center justify-center gap-3 px-4"
        style={{ paddingTop: insets.top }}
      >
        {/* Mirrors apps/web/src/routes/_auth/login.tsx: an event-6 tinted card
            with the 3px colour rail. */}
        <View className="relative w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-[color-mix(in_oklab,var(--event-6)_22%,var(--card))]">
          <View className="absolute top-2 bottom-2 left-2 w-[3px] rounded-full bg-event-6" />
          <View className="gap-10 pt-6 pr-5 pb-5 pl-6">
            <View>
              <Text className="font-display text-2xl font-bold leading-tight">Welcome to Qali</Text>
              <Text className="text-xs leading-tight text-muted-foreground">
                Sign in with Google to continue
              </Text>
            </View>
            <View className="gap-3">
              <Button
                size="lg"
                radius={14}
                className="rounded-xl"
                isDisabled={isLoading}
                onPress={handleGoogleSignIn}
              >
                {isLoading ? <Spinner size="sm" color="default" /> : <GoogleIcon />}
                <Button.Label className="font-sans text-primary-foreground">
                  {isLoading ? "Waiting for Google…" : "Continue with Google"}
                </Button.Label>
              </Button>
              {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
            </View>
          </View>
        </View>
        <Text className="max-w-[400px] text-center text-xs leading-snug text-muted-foreground">
          By signing in, you agree to our{" "}
          <Text
            className="text-xs underline text-muted-foreground"
            onPress={() => openLegal("/terms")}
          >
            Terms of Service
          </Text>{" "}
          and{" "}
          <Text
            className="text-xs underline text-muted-foreground"
            onPress={() => openLegal("/privacy")}
          >
            Privacy Policy
          </Text>
          .
        </Text>
      </View>
    </Container>
  );
}
