import { format } from "date-fns";

/** Whether to render times as 24-hour (`09:00`) or 12-hour (`9:00 AM`). The
 * visitor can flip this on the booking page; the choice is remembered so a
 * refresh or the confirmation view keeps it. */

const STORAGE_KEY = "qali-time-format";

/** The visitor's locale default: 24-hour unless their locale is a 12-hour one. */
export function localeUse24Hour(): boolean {
  try {
    return !new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions()
      .hour12;
  } catch {
    return true;
  }
}

/** The remembered choice, falling back to the locale default. */
export function storedUse24Hour(): boolean {
  if (typeof localStorage === "undefined") return localeUse24Hour();
  const value = localStorage.getItem(STORAGE_KEY);
  if (value === "24") return true;
  if (value === "12") return false;
  return localeUse24Hour();
}

export function storeUse24Hour(use24Hour: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, use24Hour ? "24" : "12");
  } catch {
    // A private-mode localStorage throw shouldn't break the toggle.
  }
}

/** Format an instant's clock time in the chosen convention. */
export function formatTime(ms: number, use24Hour: boolean): string {
  return format(ms, use24Hour ? "HH:mm" : "h:mm a");
}
