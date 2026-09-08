import { v } from "convex/values";

/** What one fired reminder carries to a device. Zone-free on purpose: the
 * body is phrased relative to the offset ("Starts in 10 min"), so no server
 * component has to know the reader's clock. Shared by the sweep, the push
 * action (Node runtime — this file must stay default-runtime-safe) and the
 * service worker. */
export const pushPayloadValidator = v.object({
  kind: v.literal("event_reminder"),
  eventId: v.id("events"),
  title: v.string(),
  body: v.string(),
  startMs: v.number(),
  allDay: v.boolean(),
  minutes: v.number(),
  /** In-app route to open the event: `/?event=<id>`. */
  url: v.string(),
  /** OS notification tag `reminder:<eventId>:<minutes>`; both delivery channels
   * use it so a rare double fire collapses into one notification. */
  tag: v.string(),
});
