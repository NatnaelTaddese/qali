import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Table definitions owned by the people domain (the synced contacts feed and
 * the unified, email-keyed people directory it feeds). Composed into schema.ts. */
export const peopleTables = {
  // One row per synced provider contact (saved-contacts feed).
  contacts: defineTable({
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    providerContactId: v.string(),
    displayName: v.optional(v.string()),
    emails: v.array(v.string()),
    phones: v.array(v.string()),
    photoUrl: v.optional(v.string()),
    // Opaque provider change marker (Google etag / Graph version).
    providerVersion: v.optional(v.string()),
    // Full-resync reconcile marker (see connectionSyncState.contactsGeneration).
    syncGeneration: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_connection_and_providerContactId", [
      "connectionId",
      "providerContactId",
    ]),

  // A people row is user-scoped, but each provider connection owns its claim on
  // an email independently. Removing one account therefore cannot erase an
  // identical contact supplied by another account.
  personSourceClaims: defineTable({
    userId: v.string(),
    email: v.string(),
    connectionId: v.id("calendarConnections"),
    source: v.union(v.literal("connection"), v.literal("other")),
    // A provider contact may share an email with another contact. Claims are
    // therefore contact-scoped; absent only on rows written before this field.
    providerContactId: v.string(),
    syncGeneration: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_email_and_source", ["userId", "email", "source"])
    .index("by_connection_and_source_and_email", [
      "connectionId",
      "source",
      "email",
    ])
    .index("by_connection_and_source_and_providerContactId_and_email", [
      "connectionId",
      "source",
      "providerContactId",
      "email",
    ]),

  // Other Contacts has no durable app-domain row, so retain just enough source
  // identity to process tombstones and generation sweeps per connection.
  otherContactSources: defineTable({
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    providerContactId: v.string(),
    emails: v.array(v.string()),
    syncGeneration: v.optional(v.number()),
  })
    .index("by_connection_and_providerContactId", [
      "connectionId",
      "providerContactId",
    ])
    .index("by_user", ["userId"]),

  // A unified, email-keyed people directory: the union of three feeders —
  // saved Google connections ("connection"), auto-collected Other Contacts
  // ("other"), and people harvested from calendar events ("attendee"). One row
  // per (userId, lowercased email); `sources` records which feeders have seen it.
  people: defineTable({
    userId: v.string(),
    email: v.string(),
    displayName: v.optional(v.string()),
    photoUrl: v.optional(v.string()),
    sources: v.array(
      v.union(
        v.literal("connection"),
        v.literal("other"),
        v.literal("attendee"),
      ),
    ),
    // Engagement ranking, recomputed from the user's events on each sync (see
    // recomputeEngagement in googleSync.ts). A recency- + intimacy-weighted
    // frequency score orders the guest picker toward frequent, recent meeting
    // partners. The count/timestamps back tiebreaks and future UI hints. Absent
    // until the first recompute; treat missing as 0 / never.
    score: v.optional(v.number()),
    meetingCount: v.optional(v.number()),
    lastMetMs: v.optional(v.number()),
    nextMeetingMs: v.optional(v.number()),
    // Fences chunked ranking writes. A completed generation resets any person
    // not stamped by that generation, so removed event relationships do not
    // retain stale scores.
    engagementGeneration: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_email", ["userId", "email"])
    // Ranked reads for the guest picker: query descending to get top scorers
    // without loading and JS-sorting the whole directory per client.
    .index("by_user_and_score", ["userId", "score"]),
};
