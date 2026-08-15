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
import type * as calendarSync from "../calendarSync.js";
import type * as contacts from "../contacts.js";
import type * as crons from "../crons.js";
import type * as googleSync from "../googleSync.js";
import type * as healthCheck from "../healthCheck.js";
import type * as http from "../http.js";
import type * as integrations_calendar_errors from "../integrations/calendar/errors.js";
import type * as integrations_calendar_registry from "../integrations/calendar/registry.js";
import type * as integrations_calendar_service from "../integrations/calendar/service.js";
import type * as integrations_calendar_types from "../integrations/calendar/types.js";
import type * as integrations_google_adapter from "../integrations/google/adapter.js";
import type * as integrations_google_mappers from "../integrations/google/mappers.js";
import type * as lib_assistantHistory from "../lib/assistantHistory.js";
import type * as lib_assistantLogic from "../lib/assistantLogic.js";
import type * as lib_assistantTools from "../lib/assistantTools.js";
import type * as lib_calendarOps from "../lib/calendarOps.js";
import type * as lib_calendars from "../lib/calendars.js";
import type * as lib_eventReads from "../lib/eventReads.js";
import type * as lib_google from "../lib/google.js";
import type * as lib_googleCredentials from "../lib/googleCredentials.js";
import type * as lib_notifications from "../lib/notifications.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as maintenance from "../maintenance.js";
import type * as notifications from "../notifications.js";
import type * as people from "../people.js";
import type * as privateData from "../privateData.js";
import type * as waitlist from "../waitlist.js";

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
  calendarSync: typeof calendarSync;
  contacts: typeof contacts;
  crons: typeof crons;
  googleSync: typeof googleSync;
  healthCheck: typeof healthCheck;
  http: typeof http;
  "integrations/calendar/errors": typeof integrations_calendar_errors;
  "integrations/calendar/registry": typeof integrations_calendar_registry;
  "integrations/calendar/service": typeof integrations_calendar_service;
  "integrations/calendar/types": typeof integrations_calendar_types;
  "integrations/google/adapter": typeof integrations_google_adapter;
  "integrations/google/mappers": typeof integrations_google_mappers;
  "lib/assistantHistory": typeof lib_assistantHistory;
  "lib/assistantLogic": typeof lib_assistantLogic;
  "lib/assistantTools": typeof lib_assistantTools;
  "lib/calendarOps": typeof lib_calendarOps;
  "lib/calendars": typeof lib_calendars;
  "lib/eventReads": typeof lib_eventReads;
  "lib/google": typeof lib_google;
  "lib/googleCredentials": typeof lib_googleCredentials;
  "lib/notifications": typeof lib_notifications;
  "lib/rateLimit": typeof lib_rateLimit;
  maintenance: typeof maintenance;
  notifications: typeof notifications;
  people: typeof people;
  privateData: typeof privateData;
  waitlist: typeof waitlist;
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
