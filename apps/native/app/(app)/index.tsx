import { api } from "@qali/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { Avatar } from "heroui-native";
import { View } from "react-native";

import { Button } from "@/components/button";
import { Container } from "@/components/container";
import { Text } from "@/components/text";
import { ThemeToggle } from "@/components/theme-toggle";
import { authClient } from "@/lib/auth-client";

export default function HomeScreen() {
  const { data: session } = authClient.useSession();
  const healthCheck = useQuery(api.healthCheck.get);
  // An authenticated query: proves the Convex JWT path works, not just the
  // Better Auth session cookie.
  const preferences = useQuery(api.domains.preferences.queries.getMyPreferences);

  const user = session?.user;
  const initial = user?.name?.trim().charAt(0).toUpperCase() || "?";

  return (
    <Container className="gap-4 px-4 pt-16">
      <View className="flex-row items-center justify-between px-2">
        <Text className="font-display text-3xl font-bold leading-none tracking-tight">Qali</Text>
        <ThemeToggle />
      </View>

      {/* Web Card: rounded-4xl bg-card ring-1 ring-foreground/5 (dark /10). */}
      <Card className="flex-row items-center gap-3">
        <Avatar size="md" alt={user?.name ?? "Signed-in user"} className="bg-secondary">
          {user?.image ? <Avatar.Image source={{ uri: user.image }} /> : null}
          <Avatar.Fallback className="font-sans text-secondary-foreground">
            {initial}
          </Avatar.Fallback>
        </Avatar>
        <View className="flex-1">
          <Text className="font-heading text-base font-medium" numberOfLines={1}>
            {user?.name}
          </Text>
          <Text className="text-sm text-muted-foreground" numberOfLines={1}>
            {user?.email}
          </Text>
        </View>
        <Button variant="danger-soft" size="sm" onPress={() => void authClient.signOut()}>
          <Button.Label className="font-sans">Sign out</Button.Label>
        </Button>
      </Card>

      <Card className="gap-2">
        <Text className="font-heading text-base font-medium">Backend</Text>
        <StatusRow label="API" ok={healthCheck === "OK"} pending={healthCheck === undefined} />
        <StatusRow
          label="Authenticated query"
          ok={preferences !== undefined}
          pending={preferences === undefined}
        />
      </Card>
    </Container>
  );
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <View
      className={`rounded-4xl border border-foreground/5 bg-card p-6 dark:border-foreground/10 ${className ?? ""}`}
    >
      {children}
    </View>
  );
}

function StatusRow({ label, ok, pending }: { label: string; ok: boolean; pending: boolean }) {
  const dot = pending ? "bg-muted-foreground" : ok ? "bg-success" : "bg-destructive";
  const text = pending ? "Checking…" : ok ? "Connected" : "Unavailable";
  return (
    <View className="flex-row items-center gap-2">
      <View className={`h-2 w-2 rounded-full ${dot}`} />
      <Text className="text-sm text-muted-foreground">
        {label}: {text}
      </Text>
    </View>
  );
}
