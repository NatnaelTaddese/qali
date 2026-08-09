import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { env } from "@qali/env/web";
import { waitForFraunces } from "@qali/ui/lib/wait-for-fraunces";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";
import ReactDOM from "react-dom/client";

import { authClient } from "@/lib/auth-client";

import Loader from "./components/loader";
import { routeTree } from "./routeTree.gen";
const convex = new ConvexReactClient(env.VITE_CONVEX_URL);

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  defaultPendingComponent: () => <Loader />,
  context: {},
  Wrap: function WrapComponent({ children }: { children: React.ReactNode }) {
    return (
      <ConvexBetterAuthProvider client={convex} authClient={authClient}>
        {children}
      </ConvexBetterAuthProvider>
    );
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Root element not found");
}

// Block the first render until the Fraunces display font is ready, so nothing —
// including the loading screen's "Q" — ever paints in a fallback serif.
async function bootstrap() {
  await waitForFraunces();

  if (!rootElement!.innerHTML) {
    const root = ReactDOM.createRoot(rootElement!);
    root.render(<RouterProvider router={router} />);
  }
}

void bootstrap();
