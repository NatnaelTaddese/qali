/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as booking from "../booking.js";
import type * as calendar from "../calendar.js";
import type * as contacts from "../contacts.js";
import type * as crons from "../crons.js";
import type * as googleSync from "../googleSync.js";
import type * as healthCheck from "../healthCheck.js";
import type * as http from "../http.js";
import type * as lib_availability from "../lib/availability.js";
import type * as lib_google from "../lib/google.js";
import type * as lib_notifications from "../lib/notifications.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as lib_slug from "../lib/slug.js";
import type * as notifications from "../notifications.js";
import type * as privateData from "../privateData.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  booking: typeof booking;
  calendar: typeof calendar;
  contacts: typeof contacts;
  crons: typeof crons;
  googleSync: typeof googleSync;
  healthCheck: typeof healthCheck;
  http: typeof http;
  "lib/availability": typeof lib_availability;
  "lib/google": typeof lib_google;
  "lib/notifications": typeof lib_notifications;
  "lib/permissions": typeof lib_permissions;
  "lib/slug": typeof lib_slug;
  notifications: typeof notifications;
  privateData: typeof privateData;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
