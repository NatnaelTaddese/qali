import {
  type AuthClient,
  ConvexBetterAuthProvider,
} from "@convex-dev/better-auth/react";
import { env } from "@qali/env/web";
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
      <ConvexBetterAuthProvider
        client={convex}
        // @convex-dev/better-auth 0.12.5 was typed against better-auth
        // 1.6.15; against any later 1.6.x its `AuthClient` alias collapses
        // the session type to `never`, so the (runtime-compatible, peer-range
        // allowed) client fails to assign. Drop the cast once the plugin
        // ships types for the patched better-auth line.
        authClient={authClient as unknown as AuthClient}
      >
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

// Mount immediately so the branded loading screen (ChromaLoader) paints right
// away instead of a blank #app. The loader shows its background at once and
// waits internally for Fraunces before revealing the "Q" — so nothing ever
// flashes a fallback serif, and there's no blank gap while fonts load.
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(<RouterProvider router={router} />);
}
