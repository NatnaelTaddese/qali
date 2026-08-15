import { action } from "./_generated/server";
import { syncNowForCurrentUser } from "./googleSync";

/**
 * Provider-neutral sync facade. Today it triggers the signed-in user's Google
 * sync, but it is the name clients should call: when other providers can be
 * connected, "sync now" fans out across every active connection without a client
 * change. `googleSync.syncNow` stays as a compatibility alias for older clients.
 */
export const syncNow = action({
  args: {},
  handler: (ctx): Promise<null> => syncNowForCurrentUser(ctx),
});
