/**
 * Stable facade for the Google sync engine.
 *
 * The engine itself — the crown-jewels sync loop (generation-sweep, lease
 * mutual-exclusion, adaptive cadence, snapshot replacement) — lives in
 * `domains/sync/engine.ts`. It was relocated whole, byte-for-byte, rather than
 * hand-split, because a transcription slip in that file would be a silent sync
 * corruption. This re-export keeps every `api.googleSync.*` / `internal.googleSync.*`
 * path fixed, along with the helpers `calendarOps` and `calendarSync` import
 * (`syncOneCalendar`, `CALENDAR_HISTORY_MS`, `syncNowForCurrentUser`).
 */

export * from "./domains/sync/engine";
