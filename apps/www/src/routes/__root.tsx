import { Toaster } from "@qali/ui/components/sonner";
import { TooltipProvider } from "@qali/ui/components/tooltip";
import { HeadContent, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { ThemeProvider } from "@/components/theme-provider";

import "../index.css";

export interface RouterAppContext {}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      {
        title: "qali — a fast, keyboard-friendly calendar",
      },
      {
        name: "description",
        content:
          "qali is a fast, keyboard-friendly calendar client for Google Calendar with a unified people directory and focused day and month views.",
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
        defaultTheme="dark"
        disableTransitionOnChange
        storageKey="vite-ui-theme"
      >
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
        <Toaster position="top-right" />
      </ThemeProvider>
      {import.meta.env.DEV && <TanStackRouterDevtools position="top-left" />}
    </>
  );
}
