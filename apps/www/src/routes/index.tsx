import { api } from "@qali/backend/convex/_generated/api";
import { HalftoneCmyk } from "@paper-design/shaders-react";
import { Button } from "@qali/ui/components/button";
import { Input } from "@qali/ui/components/input";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { Mascot } from "@/components/mascot";

export const Route = createFileRoute("/")({
  component: LandingPage,
});

function LandingPage() {
  return (
    <main className="min-h-svh bg-background text-foreground">
      <Hero />
      <Waitlist />
      <Footer />
    </main>
  );
}

function Hero() {
  return (
    <section className="relative flex min-h-svh flex-col bg-background items-center justify-end overflow-hidden px-6 py-16 text-center">
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
        <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground ring ring-black/10">
          Currently in beta
        </span>
        <h1 className="chroma-text chroma-text-animate font-display text-4xl font-medium tracking-tight text-balance sm:text-6xl">
          The calendar that runs itself
        </h1>
        <p className="max-w-xl text-lg text-muted-foreground text-balance">
          let us sort out your meetings for you
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
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
      className="relative flex flex-col bg-background items-center justify-end overflow-hidden px-6 py-16 text-center"
    >
      <div
        aria-hidden
        className="min-h-svh pointer-events-none absolute inset-0 z-0 bg-background rotate-180"
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
      <h2 className="font-heading text-3xl font-medium tracking-tight">
        Get early access
      </h2>
      <p className="text-muted-foreground text-balance">
        Join the waitlist and be the first to know when qali is ready.
      </p>
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
            className="h-10"
          />
          <Button
            type="submit"
            size="lg"
            disabled={submitting}
            className="shrink-0"
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
    <footer className="border-t border-border/50 px-6 py-8 text-center text-sm text-muted-foreground">
      © {new Date().getFullYear()} qali
    </footer>
  );
}

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}
