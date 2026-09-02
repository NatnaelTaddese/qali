import { api } from "@qali/backend/convex/_generated/api";
import { HalftoneCmyk } from "@paper-design/shaders-react";
import { Button } from "@qali/ui/components/button";
import { Input } from "@qali/ui/components/input";
import { cn } from "@qali/ui/lib/utils";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useState } from "react";
import type { CSSProperties } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { FeatureGrid } from "@/components/features/feature-grid";
import { useInViewOnce } from "@/components/features/lib";
import { Mascot } from "@/components/mascot";

const SITE_URL = "https://myqali.com";
const OG_TITLE = "qali — the AI-native calendar";
const OG_DESCRIPTION =
  "qali is an AI-native calendar for Google Calendar. Tell it what you need in plain language and it schedules, reschedules, and finds time for you.";
// Wire an absolute og:image now; drop the 1200×630 card at public/og.png later.
const OG_IMAGE = `${SITE_URL}/og.png`;

export const Route = createFileRoute("/")({
  component: LandingPage,
  head: () => ({
    meta: [
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "qali" },
      { property: "og:url", content: `${SITE_URL}/` },
      { property: "og:title", content: OG_TITLE },
      { property: "og:description", content: OG_DESCRIPTION },
      { property: "og:image", content: OG_IMAGE },
      {
        property: "og:image:alt",
        content: "qali — the AI-native calendar for Google Calendar",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: OG_TITLE },
      { name: "twitter:description", content: OG_DESCRIPTION },
      { name: "twitter:image", content: OG_IMAGE },
    ],
    links: [{ rel: "canonical", href: `${SITE_URL}/` }],
  }),
});

function LandingPage() {
  return (
    <main className="min-h-svh bg-background text-foreground">
      <Hero />
      <FeatureGrid />
      <Waitlist />
      <Footer />
    </main>
  );
}

function Hero() {
  return (
    // Content-sized rather than viewport-sized: a `min-h-svh` hero reflows
    // whenever a mobile browser's small and dynamic viewports disagree, which
    // reads as a flicker as the toolbar collapses. The sky is clipped inside a
    // rounded card that lines up with the feature grid below.
    <section className="bg-background px-4 pt-4 sm:px-6 sm:pt-6">
      <div className="relative mx-auto max-w-[96rem] overflow-hidden rounded-3xl ring-1 ring-border">
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
          <HalftoneCmyk
          speed={0}
          size={0.08}
          gridNoise={0.16}
          type="ink"
          softness={1}
          contrast={1}
          gainC={0.3}
          gainM={0}
          gainY={0.2}
          gainK={0}
          floodC={0.15}
          floodM={0}
          floodY={0}
          floodK={0}
          scale={1}
          image="/hero-halftone.png"
          grainSize={0.5}
          fit="cover"
          colorBack="#00000000"
          colorC="#00B4FF"
          colorM="#FC519F"
          colorY="#FFD800"
          colorK="#231F20"
          style={{ width: "100%", height: "100%", backgroundColor: "#FBFAF5" }}
          />
          <div className="hero-shader-fade absolute inset-0" />
        </div>
        {/* One column, one gap: the mascot, eyebrow, title, subline and
            button all sit the same distance apart. */}
        <div className="relative z-10 flex flex-col items-center gap-5 px-6 pt-32 pb-20 text-center sm:gap-6 sm:pt-48 sm:pb-32">
          <Mascot className="shrink-0" />
          <span
            className="hero-reveal rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground ring ring-black/10"
            style={{ "--hero-delay": "0.35s" } as CSSProperties}
          >
            Now in beta for Google Calendar
          </span>
          <h1 className="chroma-text chroma-text-animate max-w-3xl font-display text-4xl leading-[1.1] font-medium tracking-tight text-balance sm:text-6xl">
            Work and personal, one calendar
          </h1>
          <p
            className="hero-reveal-blur max-w-xl text-lg text-muted-foreground text-balance"
            style={{ "--hero-delay": "0.7s" } as CSSProperties}
          >
            Every Google account in a single week, with an assistant that
            asks before it acts.
          </p>
          <div
            className="hero-reveal-blur flex flex-wrap items-center justify-center gap-3"
            style={{ "--hero-delay": "0.9s" } as CSSProperties}
          >
            <Button size="lg" onClick={() => scrollToId("waitlist")}>
              Get early access
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

const emailSchema = z.string().email();

function Waitlist() {
  const join = useMutation(api.domains.marketing.mutations.join);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [joined, setJoined] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = emailSchema.safeParse(email.trim());
    if (!parsed.success) {
      toast.error("Enter a valid email address.");
      return;
    }
    setSubmitting(true);
    try {
      await join({ email: parsed.data, source: "www" });
      setJoined(true);
      toast.success("You're on the list — we'll be in touch.");
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Same header stack as the feature section: eyebrow, chroma display title
  // that sweeps in as it scrolls into view, muted subline.
  const title = useInViewOnce<HTMLHeadingElement>();

  return (
    <section
      id="waitlist"
      className="relative flex flex-col items-center overflow-hidden bg-background px-6 pb-14 pt-10 text-center sm:pb-20 sm:pt-14"
    >
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-4">
        <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground ring ring-black/10">
          Early access
        </span>
        <h2
          ref={title.ref}
          className={cn(
            "chroma-text font-display text-3xl font-medium tracking-tight text-balance pb-[0.12em] -mb-[0.12em] sm:text-5xl",
            title.inView && "chroma-text-reveal",
          )}
        >
          Get early access
        </h2>
        <p className="max-w-lg text-lg text-muted-foreground text-balance">
          Join the waitlist and be the first to know when qali is ready.
        </p>
      </div>
      {joined ? (
        <p className="mt-8 text-sm font-medium text-foreground">
          Thanks — you're on the list. 🎉
        </p>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="mt-8 flex w-full max-w-md flex-col gap-3 sm:flex-row"
        >
          <Input
            type="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-label="Email address"
            className="h-11 flex-1"
          />
          <Button
            type="submit"
            size="lg"
            disabled={submitting}
            className="h-11 shrink-0"
          >
            {submitting ? "Joining…" : "Join waitlist"}
          </Button>
        </form>
      )}
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border/50 px-6 py-10">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-4 text-center sm:flex-row sm:justify-between sm:text-left">
        <div className="flex items-center gap-2">
          <svg
            viewBox="0 0 236 236"
            className="size-6 shrink-0 text-foreground"
            fill="none"
            aria-hidden
            focusable="false"
          >
            <path
              d="M40 118 C36 66 74 30 122 32 C172 34 202 74 196 122 C193 147 181 158 176 176 C171 195 176 214 156 216 C141 217 137 201 128 199 C119 197 113 208 101 209 C86 210 80 197 73 180 C67 165 51 158 45 141 C41 129 40 124 40 118 Z"
              fill="currentColor"
            />
            <rect x="80" y="88" width="28" height="54" rx="14" fill="var(--background)" />
            <rect x="128" y="92" width="28" height="54" rx="14" fill="var(--background)" />
          </svg>
          <span className=" -ml-3 font-display text-xl font-bold tracking-tight text-foreground">
            ali
          </span>
        </div>
        <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground sm:flex-row sm:gap-6">
          <nav className="flex items-center gap-6">
            <a href="/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </a>
            <a href="/terms" className="transition-colors hover:text-foreground">
              Terms
            </a>
          </nav>
          <span>© {new Date().getFullYear()} qali</span>
        </div>
      </div>
    </footer>
  );
}

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}
