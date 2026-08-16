/**
 * In-app notifications for a host: the events worth surfacing (currently a new
 * booking request) write a row here, and the header notification bell reads it.
 *
 * This is the stable public facade — it keeps the `api.notifications.*` and
 * `internal.notifications.*` paths fixed while the logic lives in
 * `domains/notifications/`.
 */

import { v } from "convex/values";

import { internalMutation, mutation, query } from "./_generated/server";
import {
  clearAllHandler,
  continueClearAllHandler,
  continueMarkAllReadHandler,
  dismissHandler,
  markAllReadHandler,
  markReadHandler,
} from "./domains/notifications/mutations";
import { listHandler, unreadCountHandler } from "./domains/notifications/queries";

export const list = query({
  args: {},
  handler: (ctx) => listHandler(ctx),
});

export const unreadCount = query({
  args: {},
  handler: (ctx) => unreadCountHandler(ctx),
});

export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: (ctx, args) => markReadHandler(ctx, args.notificationId),
});

export const markAllRead = mutation({
  args: {},
  handler: (ctx) => markAllReadHandler(ctx),
});

export const continueMarkAllRead = internalMutation({
  args: { userId: v.string(), throughCreatedAt: v.number() },
  handler: (ctx, args) => continueMarkAllReadHandler(ctx, args),
});

export const dismiss = mutation({
  args: { notificationId: v.id("notifications") },
  handler: (ctx, args) => dismissHandler(ctx, args.notificationId),
});

export const clearAll = mutation({
  args: {},
  handler: (ctx) => clearAllHandler(ctx),
});

export const continueClearAll = internalMutation({
  args: { userId: v.string(), throughCreatedAt: v.number() },
  handler: (ctx, args) => continueClearAllHandler(ctx, args),
});
