import { useEffect, useState } from "react";

import { cn } from "@qali/ui/lib/utils";

/** Resolves once the display font is loaded, so the "Q" only paints in Fraunces
 * — never a flash of the fallback serif. The loader's background shows
 * immediately regardless; only the glyph waits. A timeout reveals it anyway so
 * a font that never arrives can't hide the loader forever. */
function useDisplayFontReady(timeoutMs = 3000) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!("fonts" in document)) {
      setReady(true);
      return;
    }

    let cancelled = false;
    const reveal = () => {
      if (!cancelled) setReady(true);
    };

    document.fonts.load('1em "Fraunces Variable"').then(reveal, reveal);
    const timeout = setTimeout(reveal, timeoutMs);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [timeoutMs]);

  return ready;
}

/**
 * Full-screen brand loading indicator: a single "Q" in the display font with
 * the chroma band looping across it. The background paints immediately so there
 * is never a blank screen; the "Q" fades in once Fraunces is ready so it never
 * flashes a fallback serif. It renders for as long as it's mounted —
 * `LoadingScreen` wraps this with fonts/assets readiness and a dissolve exit;
 * the auth-loading state renders it directly.
 */
export function ChromaLoader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const glyphReady = useDisplayFontReady();

  return (
    <div
      className={cn(
        "fixed inset-0 flex items-center justify-center bg-background",
        className,
      )}
      role="status"
      aria-label="Loading"
      {...props}
    >
      <span
        className="chroma-loop font-display text-4xl font-extrabold leading-none tracking-tight select-none transition-opacity duration-300 sm:text-[4vmin]"
        style={{ opacity: glyphReady ? 1 : 0 }}
        aria-hidden
      >
        Q
      </span>
    </div>
  );
}
