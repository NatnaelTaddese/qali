import { Toaster } from "@qali/ui/components/sonner";
import { TooltipProvider } from "@qali/ui/components/tooltip";
import { HeadContent, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { PostHogErrorBoundary, PostHogProvider, usePostHog } from "posthog-js/react";
import { type ReactNode, useEffect } from "react";

import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { authClient } from "@/lib/auth-client";
import { renderDateFavicon } from "@/lib/date-favicon";

import "../index.css";

export interface RouterAppContext {}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      {
        title: "qali",
      },
      {
        name: "description",
        content: "qali is a web application",
      },
    ],
  }),
});

function DateFavicon() {
  // `resolvedTheme` maps "system" to an actual "light" | "dark" value; the
  // favicon util reads theme colors from CSS vars, so re-render when it flips.
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    renderDateFavicon();

    // Re-render at the next local midnight so the day number stays current.
    const now = new Date();
    const nextMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    );
    const timer = window.setTimeout(
      () => renderDateFavicon(),
      nextMidnight.getTime() - now.getTime(),
    );
    return () => window.clearTimeout(timer);
  }, [resolvedTheme]);

  return null;
}

function AnalyticsIdentity() {
  const { data: session } = authClient.useSession();
  const posthog = usePostHog();
  const user = session?.user;

  useEffect(() => {
    if (!user?.id) return;

    posthog.identify(user.id, {
      ...(user.email ? { email: user.email } : {}),
      ...(user.name ? { name: user.name } : {}),
    });
  }, [posthog, user?.email, user?.id, user?.name]);

  return null;
}

function AnalyticsProvider({ children }: { children: ReactNode }) {
  const apiKey = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;
  const apiHost = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;

  if (!apiKey || !apiHost) {
    if (import.meta.env.DEV) {
      const missingVariable = !apiKey
        ? "VITE_PUBLIC_POSTHOG_PROJECT_TOKEN"
        : "VITE_PUBLIC_POSTHOG_HOST";
      throw new Error(
        `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`,
      );
    }

    return children;
  }

  return (
    <PostHogProvider
      apiKey={apiKey}
      options={{
        api_host: apiHost,
        defaults: "2026-01-30",
        capture_exceptions: true,
        debug: import.meta.env.DEV,
      }}
    >
      <AnalyticsIdentity />
      <PostHogErrorBoundary>{children}</PostHogErrorBoundary>
    </PostHogProvider>
  );
}

function RootComponent() {
  return (
    <AnalyticsProvider>
      <HeadContent />
      <ThemeProvider
        attribute="class"
        defaultTheme="light"
        disableTransitionOnChange
        storageKey="vite-ui-theme"
      >
        <DateFavicon />
        <TooltipProvider>
          <div className="grid grid-rows-[1fr] h-svh">
            <Outlet />
          </div>
        </TooltipProvider>
        <Toaster position="top-right" />
      </ThemeProvider>
      {/* Dev only: the booking page is public, and the devtools panel has no
          business rendering on a link a host hands to someone else. */}
      {import.meta.env.DEV && <TanStackRouterDevtools position="top-left" />}
    </AnalyticsProvider>
  );
}
