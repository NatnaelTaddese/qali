import {
  Calendar03Icon,
  Link01Icon,
  SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

/** Layout contract shared by `SettingsPanel` and its Suspense skeleton. The
 * panel is a lazy chunk, so the skeleton cannot import it; anything the two
 * must agree on lives here instead of being spelled twice. */

export type SettingsSection = "accounts" | "calendars" | "preferences";

export const SECTIONS: {
  id: SettingsSection;
  label: string;
  description: string;
  icon: IconSvgElement;
}[] = [
  {
    id: "accounts",
    label: "Accounts",
    description: "Connections and sync",
    icon: Link01Icon,
  },
  {
    id: "calendars",
    label: "Calendars",
    description: "Grouped by account",
    icon: Calendar03Icon,
  },
  {
    id: "preferences",
    label: "Preferences",
    description: "Time and display",
    icon: SlidersHorizontalIcon,
  },
];

/** The panel goes two-column at 640px. Tailwind's `sm:` is rem-based and
 * lands at 560px under the 14px root, so the class twins below use a pixel
 * variant; keep all three in step. */
export const DESKTOP_QUERY = "(min-width: 640px)";
export const DESKTOP_ONLY = "hidden min-[640px]:grid";
export const MOBILE_ONLY = "min-[640px]:hidden";

/** Fixed pane so switching sections never resizes the sheet, split into the
 * sidebar column and the content pane. */
export const SETTINGS_PANE =
  "h-[min(34rem,78dvh)] grid-cols-[12.5rem_minmax(0,1fr)]";

/** The selected sidebar row. Dark mode lifts to the accent token because
 * `bg-background` sits below `bg-muted` there. */
export const SETTINGS_ACTIVE_ROW =
  "bg-background shadow-sm dark:bg-accent dark:shadow-none dark:border dark:border-white/10";
