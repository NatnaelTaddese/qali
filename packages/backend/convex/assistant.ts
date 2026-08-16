/**
 * Stable facade for the assistant action loop. Logic in domains/assistant/loop.ts;
 * keeps api.assistant.* fixed.
 */

import { action } from "./_generated/server";
import * as definitions from "./domains/assistant/loop";

export const sendMessage = action(definitions.sendMessage);
export const confirmAction = action(definitions.confirmAction);
