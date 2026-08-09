/**
 * Block the first render until the Fraunces display font is ready, so nothing —
 * including the loading screen's "Q" — ever paints in a fallback serif. The
 * @font-face is registered by the bundled CSS; in a production build that
 * stylesheet may still be in flight when this runs, so we poll until the face
 * is registered before asking the browser to load it. A timeout guards against
 * a font that never arrives.
 */
export async function waitForFraunces(timeoutMs = 3000): Promise<void> {
  const family = "Fraunces Variable";
  const deadline = Date.now() + timeoutMs;

  if (!("fonts" in document)) return;

  // Wait for the @font-face declaration to be registered (CSS loaded).
  while (Date.now() < deadline) {
    let registered = false;
    document.fonts.forEach((face) => {
      if (face.family === family) registered = true;
    });
    if (registered) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  try {
    await Promise.race([
      document.fonts.load(`1em "${family}"`),
      new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, deadline - Date.now())),
      ),
    ]);
  } catch {
    // Ignore — fall through and render with whatever is available.
  }
}
