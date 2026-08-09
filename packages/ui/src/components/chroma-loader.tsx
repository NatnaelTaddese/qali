import { cn } from "@qali/ui/lib/utils";

/**
 * Full-screen brand loading indicator: a single "Q" in the display font with
 * the chroma band looping across it. Presentational only — it renders for as
 * long as it's mounted. `LoadingScreen` wraps this with fonts/assets readiness
 * and a dissolve exit; the auth-loading state renders it directly.
 */
export function ChromaLoader({
  className,
  ...props
}: React.ComponentProps<"div">) {
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
        className="chroma-loop font-display text-4xl font-extrabold leading-none tracking-tight select-none sm:text-[4vmin]"
        aria-hidden
      >
        Q
      </span>
    </div>
  );
}
