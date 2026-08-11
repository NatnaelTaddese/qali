import { api } from "@qali/backend/convex/_generated/api";
import { HalftoneCmyk } from "@paper-design/shaders-react";
import { Button } from "@qali/ui/components/button";
import { Input } from "@qali/ui/components/input";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useState } from "react";
import type { CSSProperties } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { FeaturePreview } from "@/components/feature-preview";
import { Mascot } from "@/components/mascot";

export const Route = createFileRoute("/")({
  component: LandingPage,
});

function LandingPage() {
  return (
    <main className="min-h-svh bg-background text-foreground">
      <Hero />
      <FeaturePreview />
      <Waitlist />
      <Footer />
    </main>
  );
}

function Hero() {
  return (
    <section className="relative flex min-h-svh flex-col bg-background items-center justify-end overflow-hidden px-6 pt-16 pb-10 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 bg-background"
      >
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
      <Mascot className="relative z-10 mb-5 shrink-0 sm:mb-7" />
      <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center gap-4">
        <span
          className="hero-reveal rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground ring ring-black/10"
          style={{ "--hero-delay": "0.35s" } as CSSProperties}
        >
          Currently in beta
        </span>
        <h1 className="chroma-text chroma-text-animate font-display text-4xl font-medium tracking-tight text-balance sm:text-6xl">
          The calendar that runs itself
        </h1>
        <p
          className="hero-reveal-blur max-w-xl text-lg text-muted-foreground text-balance"
          style={{ "--hero-delay": "0.7s" } as CSSProperties}
        >
          Cursor for your daily schedules
        </p>
        <div
          className="hero-reveal-blur flex flex-wrap items-center justify-center gap-3"
          style={{ "--hero-delay": "0.9s" } as CSSProperties}
        >
          <Button size="lg" onClick={() => scrollToId("waitlist")}>
            Join the waitlist
          </Button>
        </div>
      </div>
    </section>
  );
}

const emailSchema = z.string().email();

function Waitlist() {
  const join = useMutation(api.waitlist.join);
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

  return (
    <section
      id="waitlist"
      className="relative flex flex-col items-center gap-6 overflow-hidden bg-background px-6 pb-16 pt-10 text-center sm:gap-8 sm:pb-24 sm:pt-14"
    >
      <div className="flex max-w-xl flex-col items-center gap-3">
        <h2 className="font-heading text-3xl font-medium tracking-tight sm:text-4xl">
          Get early access
        </h2>
        <p className="text-base text-muted-foreground text-balance sm:text-lg">
          Join the waitlist and be the first to know when qali is ready.
        </p>
      </div>
      {joined ? (
        <p className="text-sm font-medium text-foreground">
          Thanks — you're on the list. 🎉
        </p>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="flex w-full max-w-md flex-col gap-3 sm:flex-row"
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
