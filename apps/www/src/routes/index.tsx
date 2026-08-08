import { api } from "@qali/backend/convex/_generated/api";
import { Button } from "@qali/ui/components/button";
import { Input } from "@qali/ui/components/input";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

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
    <section className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 pt-24 pb-16 text-center sm:pt-32">
      <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
        For Google Calendar
      </span>
      <h1 className="font-heading text-4xl font-medium tracking-tight text-balance sm:text-6xl">
        A fast, keyboard-friendly calendar
      </h1>
      <p className="max-w-xl text-lg text-muted-foreground text-balance">
        qali syncs your Google calendars and builds a unified people directory,
        then gets out of your way so you can schedule at the speed of thought.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button size="lg" onClick={() => scrollToId("waitlist")}>
          Join the waitlist
        </Button>
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
      className="mx-auto flex max-w-xl flex-col items-center gap-6 px-6 py-20 text-center"
    >
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
