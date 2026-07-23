import { Toaster } from "@qali/ui/components/sonner";
import { TooltipProvider } from "@qali/ui/components/tooltip";
import { HeadContent, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useEffect } from "react";

import { ThemeProvider, useTheme } from "@/components/theme-provider";
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
        <DateFavicon />
        <TooltipProvider>
          <div className="grid grid-rows-[1fr] h-svh">
            <Outlet />
          </div>
        </TooltipProvider>
        <Toaster richColors />
      </ThemeProvider>
      <TanStackRouterDevtools position="bottom-left" />
    </>
  );
}
