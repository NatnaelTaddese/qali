"use node";

/**
 * Web Push delivery. The only Node-runtime file in the backend: `web-push`
 * needs Node's crypto for VAPID (ES256) and the RFC 8291 payload encryption.
 * Nothing in the default runtime may import this module; the sweep reaches
 * it through the scheduler by function reference.
 */

import { env } from "@qali/env/server";
import { v } from "convex/values";
import webpush, { WebPushError } from "web-push";

import { internal } from "../../_generated/api";
import { internalAction } from "../../_generated/server";
import { pushPayloadValidator } from "../../domains/reminders/validators";

/** A reminder older than this is stale in the tray; let the push service
 * drop it rather than deliver it late. */
const TTL_SECONDS = 15 * 60;

function pushConfigured(): boolean {
  return Boolean(
    env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT,
  );
}

/** The push service's `Topic` header: ≤32 URL-safe chars; a later push with
 * the same topic replaces an undelivered earlier one. */
function topicFor(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
}

export const sendToUser = internalAction({
  args: {
    userId: v.string(),
    notifications: v.array(pushPayloadValidator),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    if (!pushConfigured()) return null;
    webpush.setVapidDetails(
      env.VAPID_SUBJECT!,
      env.VAPID_PUBLIC_KEY!,
      env.VAPID_PRIVATE_KEY!,
    );
    const subscriptions = await ctx.runQuery(
      internal.domains.push.queries.listSubscriptionsForUser,
      { userId: args.userId },
    );
    if (subscriptions.length === 0) return null;

    const delivered: string[] = [];
    const gone: string[] = [];
    const failed: string[] = [];
    for (const subscription of subscriptions) {
      for (const notification of args.notifications) {
        try {
          await webpush.sendNotification(
            { endpoint: subscription.endpoint, keys: subscription.keys },
            JSON.stringify(notification),
            {
              TTL: TTL_SECONDS,
              urgency: "high",
              topic: topicFor(notification.tag),
            },
          );
          delivered.push(subscription.endpoint);
        } catch (error) {
          const status =
            error instanceof WebPushError ? error.statusCode : undefined;
          // 404/410: the browser dropped it. 401/403: the push service
          // rejects our VAPID signature for it (a key rotation); the browser
          // re-subscribes under the current key on its next load.
          if (status === 404 || status === 410 || status === 401 || status === 403) {
            gone.push(subscription.endpoint);
            break;
          }
          console.error("[push] delivery failed", status ?? error);
          failed.push(subscription.endpoint);
          break;
        }
      }
    }
    await ctx.runMutation(internal.domains.push.mutations.recordPushResults, {
      userId: args.userId,
      delivered,
      gone,
      failed,
    });
    return null;
  },
});
