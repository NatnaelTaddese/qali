/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as assistant from "../assistant.js";
import type * as assistantData from "../assistantData.js";
import type * as assistantMaintenance from "../assistantMaintenance.js";
import type * as auth from "../auth.js";
import type * as booking from "../booking.js";
import type * as calendar from "../calendar.js";
import type * as contacts from "../contacts.js";
import type * as crons from "../crons.js";
import type * as googleSync from "../googleSync.js";
import type * as healthCheck from "../healthCheck.js";
import type * as http from "../http.js";
import type * as lib_assistantHistory from "../lib/assistantHistory.js";
import type * as lib_assistantLogic from "../lib/assistantLogic.js";
import type * as lib_assistantTools from "../lib/assistantTools.js";
import type * as lib_availability from "../lib/availability.js";
import type * as lib_calendarOps from "../lib/calendarOps.js";
import type * as lib_calendars from "../lib/calendars.js";
import type * as lib_google from "../lib/google.js";
import type * as lib_notifications from "../lib/notifications.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as lib_slug from "../lib/slug.js";
import type * as maintenance from "../maintenance.js";
import type * as notifications from "../notifications.js";
import type * as people from "../people.js";
import type * as privateData from "../privateData.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  assistant: typeof assistant;
  assistantData: typeof assistantData;
  assistantMaintenance: typeof assistantMaintenance;
  auth: typeof auth;
  booking: typeof booking;
  calendar: typeof calendar;
  contacts: typeof contacts;
  crons: typeof crons;
  googleSync: typeof googleSync;
  healthCheck: typeof healthCheck;
  http: typeof http;
  "lib/assistantHistory": typeof lib_assistantHistory;
  "lib/assistantLogic": typeof lib_assistantLogic;
  "lib/assistantTools": typeof lib_assistantTools;
  "lib/availability": typeof lib_availability;
  "lib/calendarOps": typeof lib_calendarOps;
  "lib/calendars": typeof lib_calendars;
  "lib/google": typeof lib_google;
  "lib/notifications": typeof lib_notifications;
  "lib/permissions": typeof lib_permissions;
  "lib/slug": typeof lib_slug;
  maintenance: typeof maintenance;
  notifications: typeof notifications;
  people: typeof people;
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
