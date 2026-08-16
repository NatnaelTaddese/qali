/**
 * Stable facade for assistant maintenance (deleteThread, pruneAgedThreads).
 * Logic in domains/assistant/maintenance.ts; keeps those paths fixed.
 */

import { internalMutation, mutation } from "./_generated/server";
import * as definitions from "./domains/assistant/maintenance";

export const deleteThread = mutation(definitions.deleteThread);
export const pruneAgedThreads = internalMutation(definitions.pruneAgedThreads);
