import { Button } from "@qali/ui/components/button";
import { Spinner } from "@qali/ui/components/spinner";
import { cn } from "@qali/ui/lib/utils";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { svg as googleSvg } from "thesvg/google";

import { CalendarBackdrop } from "@/components/booking/calendar-backdrop";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_auth/login")({
  component: LoginComponent,
});

const googleIconSrc = `data:image/svg+xml,${encodeURIComponent(googleSvg)}`;

const MARKETING_URL = "https://myqali.com";

function GoogleIcon() {
  return (
    <img
      src={googleIconSrc}
      alt=""
      aria-hidden
      draggable={false}
      className="size-4"
    />
  );
}

function LoginComponent() {
  const [isLoading, setIsLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    await authClient.signIn.social(
      {
        provider: "google",
        callbackURL: "/",
        errorCallbackURL: "/login",
      },
      {
        onError: (error) => {
          setIsLoading(false);
          toast.error(error.error.message || error.error.statusText);
        },
      },
    );
  };

  return (
    <div className="relative min-h-svh overflow-hidden bg-background">
      <CalendarBackdrop />

      <div className="relative z-10 flex min-h-svh flex-col items-center justify-center gap-3 px-4">
        <div
          className={cn(
            "relative w-full max-w-[400px] overflow-hidden rounded-xl shadow-lg",
            "ring-1 ring-border/60 inset-ring inset-ring-black/10 dark:inset-ring-white/10",
          )}
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--event-6) 22%, var(--card))",
          }}
        >
          <span
            aria-hidden
            className="absolute top-2 bottom-2 left-2 w-[3px] rounded-full"
            style={{ backgroundColor: "var(--event-6)" }}
          />
          <div className="flex flex-col gap-10 pt-6 pr-5 pb-5 pl-6">
            <div>
              <p className="font-display text-2xl font-bold leading-tight">
                Welcome to Qali
              </p>
              <p className="text-xs leading-tight text-muted-foreground">
                Sign in with Google to continue
              </p>
            </div>
            <Button
              variant="default"
              size="lg"
              className="w-full rounded-xl"
              disabled={isLoading}
              aria-busy={isLoading}
              onClick={handleGoogleSignIn}
            >
              {isLoading ? <Spinner /> : <GoogleIcon />}
              {isLoading ? "Redirecting…" : "Continue with Google"}
            </Button>
          </div>
        </div>

        <p className="max-w-[400px] text-center text-xs leading-snug text-balance text-muted-foreground">
          By signing in, you agree to our{" "}
          <a
            href={`${MARKETING_URL}/terms`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 transition-colors hover:text-link"
          >
            Terms of Service
          </a>{" "}
          and{" "}
          <a
            href={`${MARKETING_URL}/privacy`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 transition-colors hover:text-link"
          >
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </div>
  );
}
