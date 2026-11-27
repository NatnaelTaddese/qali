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
        title: "qali — one place to plan your time",
      },
      {
        name: "description",
        content:
          "qali brings your Google calendars, booking links, reminders and time zones into one planner, on the web and on your Mac.",
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
