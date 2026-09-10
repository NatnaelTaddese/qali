import { Stack } from "expo-router";

import { useSyncBootstrap } from "@/hooks/use-sync-bootstrap";

export default function AppLayout() {
  useSyncBootstrap();
  return <Stack screenOptions={{ headerShown: false }} />;
}
