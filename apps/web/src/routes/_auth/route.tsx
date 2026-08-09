import { ChromaLoader } from "@qali/ui/components/chroma-loader";
import { Navigate, Outlet, createFileRoute } from "@tanstack/react-router";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";

export const Route = createFileRoute("/_auth")({
  component: AuthLayout,
});

function AuthLayout() {
  return (
    <>
      <Authenticated>
        <Navigate to="/" />
      </Authenticated>
      <Unauthenticated>
        <Outlet />
      </Unauthenticated>
      <AuthLoading>
        <ChromaLoader />
      </AuthLoading>
    </>
  );
}
