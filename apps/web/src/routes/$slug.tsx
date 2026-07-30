import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { BookingPage } from "@/components/booking/booking-page";

/**
 * The public booking page — the app's only route that gates on neither
 * `<Authenticated>` nor `<Unauthenticated>`, so a visitor with no account (and
 * the signed-in host previewing their own link) both see the same thing.
 *
 * A dynamic segment at the root is deliberate: the link is `domain.com/<name>`.
 * TanStack Router prefers static routes, so `/login` still wins over this.
 *
 * `r` carries the request token after a booking, so a refresh or a bookmarked
 * link returns to the confirmation rather than the empty form.
 */
export const Route = createFileRoute("/$slug")({
  component: PublicBookingRoute,
  validateSearch: (search: Record<string, unknown>): { r?: string } => ({
    r: typeof search.r === "string" && search.r.length > 0 ? search.r : undefined,
  }),
});

function PublicBookingRoute() {
  const { slug } = Route.useParams();
  const { r } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <BookingPage
      slug={slug}
      token={r ?? null}
      onTokenChange={(token) =>
        navigate({
          search: token ? { r: token } : {},
          replace: true,
        })
      }
    />
  );
}
