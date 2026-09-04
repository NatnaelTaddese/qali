import { Skeleton } from "@qali/ui/components/skeleton";

import {
  DESKTOP_ONLY,
  MOBILE_ONLY,
  SECTIONS,
  SETTINGS_ACTIVE_ROW,
  SETTINGS_PANE,
} from "./settings-layout";

/** Bars sit on muted surfaces, so they need their own contrast rather than
 * the primitive's `bg-muted`. */
const BAR = "bg-foreground/10";

/** Placeholder the dock shows while the settings chunk loads. It mirrors the
 * real panel's frame — the same fixed pane, sidebar split and content inset
 * on desktop, the same stacked list on small screens — so the shell morphs
 * straight to its final size and the content fades in without a second
 * height change. Dimensions come from `settings-layout` so they cannot drift
 * from `SettingsPanel`. */
export function SettingsPanelSkeleton() {
  return (
    <div role="status" aria-label="Loading settings">
      <span className="sr-only">Loading</span>
      <div className={`${DESKTOP_ONLY} ${SETTINGS_PANE}`}>
        <div className="flex flex-col gap-1 border-r border-border bg-muted p-3">
          <p className="px-3 pt-1.5 pb-2.5 text-[11px] font-medium tracking-widest text-muted-foreground uppercase">
            Settings
          </p>
          {SECTIONS.map((entry, index) => (
            <div
              key={entry.id}
              className={
                index === 0
                  ? `flex items-center gap-2.5 rounded-lg px-3 py-2.5 ${SETTINGS_ACTIVE_ROW}`
                  : "flex items-center gap-2.5 rounded-lg px-3 py-2.5"
              }
            >
              <Skeleton className={`size-4 rounded-md ${BAR}`} />
              <Skeleton className={`h-3.5 w-20 rounded-md ${BAR}`} />
            </div>
          ))}
        </div>
        <div className="flex flex-col p-5 pl-6">
          <Skeleton className={`h-7 w-32 rounded-lg ${BAR}`} />
          <div className="mt-4 rounded-3xl bg-muted/50 px-4">
            <div className="space-y-3 py-4">
              <Skeleton className={`h-10 rounded-2xl ${BAR}`} />
              <Skeleton className={`h-10 rounded-2xl ${BAR}`} />
              <Skeleton className={`h-10 rounded-2xl ${BAR}`} />
            </div>
          </div>
        </div>
      </div>
      {/* Row boxes match the real text line heights (text-2xl, text-sm,
        * text-xs) so the mobile tree measures the same as the panel. */}
      <div className={`flex flex-col gap-3 p-4 ${MOBILE_ONLY}`}>
        <div className="flex h-8 items-center">
          <Skeleton className={`h-6 w-28 rounded-lg ${BAR}`} />
        </div>
        <div className="flex flex-col gap-1.5">
          {SECTIONS.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center gap-3 rounded-2xl bg-muted/60 px-3 py-2.5"
            >
              <Skeleton className={`size-5 rounded-md ${BAR}`} />
              <div className="flex flex-1 flex-col">
                <div className="flex h-5 items-center">
                  <Skeleton className={`h-3.5 w-24 rounded-md ${BAR}`} />
                </div>
                <div className="flex h-4 items-center">
                  <Skeleton className={`h-3 w-40 rounded-md ${BAR}`} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
