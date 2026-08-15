import { v } from "convex/values";

/** One piece of an assistant turn, in the order it happened. A turn is a list of
 * these rather than a string because a single reply can interleave prose with
 * tool activity. `tool_call`/`tool_result` also rebuild the next request's
 * history, so they hold exactly what the model needs verbatim; `proposal`
 * carries only the id of the `assistantActions` row the panel confirms.
 *
 * Owned by the assistant domain (moved out of schema.ts) so the messages table
 * and the assistant data layer share one definition. */
export const assistantBlockValidator = v.union(
  v.object({ type: v.literal("text"), text: v.string() }),
  v.object({
    type: v.literal("tool_call"),
    toolCallId: v.string(),
    name: v.string(),
    // The model's own JSON string. Kept verbatim: re-encoding it would change
    // the bytes the model sees when this turn is replayed as history.
    arguments: v.string(),
  }),
  v.object({
    type: v.literal("tool_result"),
    toolCallId: v.string(),
    content: v.string(),
    isError: v.optional(v.boolean()),
  }),
  v.object({
    type: v.literal("proposal"),
    toolCallId: v.string(),
    actionId: v.id("assistantActions"),
  }),
);
