import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** Shared chrome for the /privacy and /terms pages: the qali wordmark, a
 * readable measure, and consistent heading rhythm. Content is passed as
 * children so each policy owns its own copy. */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-svh bg-background text-foreground">
      <article className="legal-prose mx-auto max-w-3xl px-6 py-12 sm:py-16">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            focusable="false"
          >
            <path d="M19 12H5" />
            <path d="m12 19-7-7 7-7" />
          </svg>
          Back
        </Link>

        <h1 className="mt-8 font-display text-3xl font-medium tracking-tight sm:text-4xl">
          {title}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated {updated}</p>
        <div className="mt-10 space-y-8 text-[15px] leading-relaxed text-muted-foreground">
          {children}
        </div>
      </article>

      <footer className="border-t border-border/50 px-6 py-10">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 text-center text-sm text-muted-foreground sm:flex-row sm:justify-between sm:text-left">
          <nav className="flex items-center gap-6">
            <Link to="/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </Link>
            <Link to="/terms" className="transition-colors hover:text-foreground">
              Terms
            </Link>
          </nav>
          <span>© {new Date().getFullYear()} qali</span>
        </div>
      </footer>
    </main>
  );
}

/** A titled section within a policy. Headings share one style so the two
 * documents read as a set. */
export function LegalSection({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="font-display text-xl font-medium tracking-tight text-foreground">
        {heading}
      </h2>
      {children}
    </section>
  );
}
