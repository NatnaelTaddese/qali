import { useEffect, useState } from "react";

import { ChromaLoader } from "@qali/ui/components/chroma-loader";

/** Fonts the app renders in — wait for these before revealing it so headings
 * and the chroma "Q" never flash a fallback face. */
const FONTS_TO_LOAD = [
  '1em "Fraunces Variable"',
  '1em "Lexend Variable"',
] as const;

function preloadImage(src: string) {
  return new Promise<void>((resolve) => {
    const img = new Image();
    // Resolve on error too — a missing decorative asset shouldn't trap the app
    // behind the loading screen forever.
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = src;
  });
}

/** Resolves once the display/sans fonts and any given assets are ready, so the
 * loading screen can hand off to a fully-styled page. */
function useAssetsReady(preloadImages: readonly string[]) {
  const [ready, setReady] = useState(false);
  // Stable key so the effect doesn't re-run on a new array identity.
  const imagesKey = preloadImages.join("|");

  useEffect(() => {
    let cancelled = false;

    const fontsReady = document.fonts
      ? Promise.all([
          ...FONTS_TO_LOAD.map((font) => document.fonts.load(font)),
          document.fonts.ready,
        ])
      : Promise.resolve();

    const assetsReady = Promise.all([
      fontsReady,
      ...preloadImages.map(preloadImage),
    ]);

    // Safety valve: never leave the user staring at the loader if a resource
    // hangs. Reveal after 6s regardless.
    const timeout = setTimeout(() => {
      if (!cancelled) setReady(true);
    }, 6000);

    assetsReady.then(() => {
      if (!cancelled) setReady(true);
    });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagesKey]);

  return ready;
}

export interface LoadingScreenProps {
  /** Non-font assets to preload before revealing the app (e.g. a hero image).
   * Loading waits on these too; a missing one won't block past the timeout. */
  preloadImages?: readonly string[];
}

/**
 * Full-screen loading overlay: a single "Q" in the display font with the
 * chroma band looping across it, shown until fonts and assets are ready. Once
 * ready it dissolves (fade + scale + blur) and unmounts, revealing the app.
 */
export function LoadingScreen({ preloadImages = [] }: LoadingScreenProps) {
  const ready = useAssetsReady(preloadImages);
  const [mounted, setMounted] = useState(true);

  if (!mounted) return null;

  return (
    <ChromaLoader
      className="loading-screen z-100"
      data-hidden={ready}
      aria-hidden={ready}
      onTransitionEnd={() => {
        if (ready) setMounted(false);
      }}
    />
  );
}
