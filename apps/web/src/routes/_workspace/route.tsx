import { Navigate, Outlet, createFileRoute } from "@tanstack/react-router";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";

import { BottomIsland } from "@/components/workspace/bottom-island";
import { DockProvider } from "@/components/workspace/dock-context";
import { WorkspaceSkeleton } from "@/components/workspace/workspace-skeleton";

export const Route = createFileRoute("/_workspace")({
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  return (
    <>
      <Authenticated>
        <DockProvider>
          <div className="relative h-full min-h-0">
            <main className="h-full min-w-0 overflow-auto">
              <Outlet />
            </main>
            <BottomIsland />
          </div>
        </DockProvider>
      </Authenticated>
      <Unauthenticated>
        <Navigate to="/login" />
      </Unauthenticated>
      <AuthLoading>
        <WorkspaceSkeleton />
      </AuthLoading>
    </>
  );
}
