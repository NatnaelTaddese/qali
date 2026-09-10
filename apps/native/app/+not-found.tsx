import { useConvexAuth } from "convex/react";
import { Link, Stack } from "expo-router";
import { Surface } from "heroui-native";
import { View } from "react-native";

import { Button } from "@/components/button";
import { Container } from "@/components/container";
import { Text } from "@/components/text";

export default function NotFoundScreen() {
  // "/" lives in the guarded (app) group, so a signed-out user must be sent to
  // sign-in instead; navigating to a guarded route is a no-op.
  const { isAuthenticated } = useConvexAuth();
  return (
    <>
      <Stack.Screen options={{ title: "Not Found" }} />
      <Container>
        <View className="flex-1 justify-center items-center p-4">
          <Surface variant="secondary" className="items-center p-6 max-w-sm rounded-4xl">
            <Text className="text-4xl mb-3">🤔</Text>
            <Text className="font-heading text-lg font-medium mb-1">Page Not Found</Text>
            <Text className="text-sm text-muted-foreground text-center mb-4">
              The page you're looking for doesn't exist.
            </Text>
            <Link href={isAuthenticated ? "/" : "/sign-in"} asChild>
              <Button size="sm">
                <Button.Label className="font-sans">Go Home</Button.Label>
              </Button>
            </Link>
          </Surface>
        </View>
      </Container>
    </>
  );
}
