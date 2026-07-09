import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_workspace/")({
  component: HomeComponent,
});

function HomeComponent() {
  return (
    <div className="container mx-auto max-w-3xl px-4 py-2">
      <h1 className="text-2xl font-bold">qali</h1>
    </div>
  );
}
