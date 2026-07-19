import { Navigate, Outlet, createFileRoute } from "@tanstack/react-router";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";

import { BottomIsland } from "@/components/workspace/bottom-island";

export const Route = createFileRoute("/_workspace")({
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  return (
    <>
      <Authenticated>
        <div className="relative h-full min-h-0">
          <main className="h-full min-w-0 overflow-auto">
            <Outlet />
          </main>
          <BottomIsland />
        </div>
      </Authenticated>
      <Unauthenticated>
        <Navigate to="/login" />
      </Unauthenticated>
      <AuthLoading>
        <div>Loading...</div>
      </AuthLoading>
    </>
  );
}
