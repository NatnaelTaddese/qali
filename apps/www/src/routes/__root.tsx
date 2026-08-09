import { Toaster } from "@qali/ui/components/sonner";
import { TooltipProvider } from "@qali/ui/components/tooltip";
import { HeadContent, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { LoadingScreen } from "@qali/ui/components/loading-screen";

import { ThemeProvider } from "@/components/theme-provider";

import "../index.css";

export interface RouterAppContext {}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      {
        title: "qali — the AI-native calendar",
      },
      {
        name: "description",
        content:
          "qali is an AI-native calendar for Google Calendar. Tell it what you need in plain language and it schedules, reschedules, and finds time for you.",
      },
    ],
  }),
});

function RootComponent() {
  return (
    <>
      <HeadContent />
      <ThemeProvider
        attribute="class"
        defaultTheme="light"
        disableTransitionOnChange
        storageKey="vite-ui-theme"
      >
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
        <LoadingScreen preloadImages={["/hero-halftone.png"]} />
        <Toaster position="top-right" />
      </ThemeProvider>
      {import.meta.env.DEV && <TanStackRouterDevtools position="top-left" />}
    </>
  );
}
