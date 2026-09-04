import { Skeleton } from "@qali/ui/components/skeleton";

/** Placeholder the dock shows while the settings chunk loads. It mirrors the
 * real panel's frame — the same fixed pane height, sidebar split and content
 * inset on desktop, the same stacked list on small screens — so the shell
 * morphs straight to its final size and the content fades in without a
 * second height change. Keep the dimensions in step with `SettingsPanel`;
 * the breakpoint is that panel's `DESKTOP_QUERY` (640px, not Tailwind's
 * rem-based `sm:`, which lands at 560px under the 14px root). */
export function SettingsPanelSkeleton() {
  return (
    <div aria-busy aria-label="Loading settings">
      <div className="hidden h-[min(34rem,78dvh)] grid-cols-[12.5rem_minmax(0,1fr)] min-[640px]:grid">
        <div className="flex flex-col gap-1 border-r border-border bg-muted p-3">
          <p className="px-3 pt-1.5 pb-2.5 text-[11px] font-medium tracking-widest text-muted-foreground uppercase">
            Settings
          </p>
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className={
                row === 0
                  ? "flex items-center gap-2.5 rounded-lg bg-background px-3 py-2.5 shadow-sm dark:border dark:border-white/10 dark:bg-accent dark:shadow-none"
                  : "flex items-center gap-2.5 rounded-lg px-3 py-2.5"
              }
            >
              <Skeleton className="size-4 rounded-md" />
              <Skeleton className="h-3.5 w-20 rounded-md" />
            </div>
          ))}
        </div>
        <div className="flex flex-col p-5 pl-6">
          <Skeleton className="h-7 w-32 rounded-lg" />
          <div className="mt-4 rounded-3xl bg-muted/50 px-4">
            <div className="space-y-3 py-4">
              <Skeleton className="h-10 rounded-2xl" />
              <Skeleton className="h-10 rounded-2xl" />
              <Skeleton className="h-10 rounded-2xl" />
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-3 p-4 min-[640px]:hidden">
        <Skeleton className="h-7 w-28 rounded-lg" />
        <div className="flex flex-col gap-1.5">
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="flex items-center gap-3 rounded-2xl bg-muted/60 px-3 py-2.5"
            >
              <Skeleton className="size-5 rounded-md" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-24 rounded-md" />
                <Skeleton className="h-3 w-40 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
