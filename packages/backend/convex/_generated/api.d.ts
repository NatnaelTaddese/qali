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
import type * as backfillConnections from "../backfillConnections.js";
import type * as booking from "../booking.js";
import type * as calendar from "../calendar.js";
import type * as calendarSync from "../calendarSync.js";
import type * as contacts from "../contacts.js";
import type * as crons from "../crons.js";
import type * as domains_assistant_data from "../domains/assistant/data.js";
import type * as domains_assistant_history from "../domains/assistant/history.js";
import type * as domains_assistant_loop from "../domains/assistant/loop.js";
import type * as domains_assistant_maintenance from "../domains/assistant/maintenance.js";
import type * as domains_assistant_tables from "../domains/assistant/tables.js";
import type * as domains_assistant_tools from "../domains/assistant/tools.js";
import type * as domains_assistant_validators from "../domains/assistant/validators.js";
import type * as domains_booking_model from "../domains/booking/model.js";
import type * as domains_booking_mutations from "../domains/booking/mutations.js";
import type * as domains_booking_queries from "../domains/booking/queries.js";
import type * as domains_booking_service from "../domains/booking/service.js";
import type * as domains_booking_tables from "../domains/booking/tables.js";
import type * as domains_calendar_model from "../domains/calendar/model.js";
import type * as domains_calendar_mutations from "../domains/calendar/mutations.js";
import type * as domains_calendar_queries from "../domains/calendar/queries.js";
import type * as domains_calendar_service from "../domains/calendar/service.js";
import type * as domains_calendar_tables from "../domains/calendar/tables.js";
import type * as domains_calendar_validators from "../domains/calendar/validators.js";
import type * as domains_marketing_mutations from "../domains/marketing/mutations.js";
import type * as domains_marketing_tables from "../domains/marketing/tables.js";
import type * as domains_notifications_model from "../domains/notifications/model.js";
import type * as domains_notifications_mutations from "../domains/notifications/mutations.js";
import type * as domains_notifications_queries from "../domains/notifications/queries.js";
import type * as domains_notifications_tables from "../domains/notifications/tables.js";
import type * as domains_people_queries from "../domains/people/queries.js";
import type * as domains_people_tables from "../domains/people/tables.js";
import type * as domains_sync_engine from "../domains/sync/engine.js";
import type * as googleSync from "../googleSync.js";
import type * as healthCheck from "../healthCheck.js";
import type * as http from "../http.js";
import type * as infrastructure_rateLimit from "../infrastructure/rateLimit.js";
import type * as integrations_calendar_errors from "../integrations/calendar/errors.js";
import type * as integrations_calendar_registry from "../integrations/calendar/registry.js";
import type * as integrations_calendar_service from "../integrations/calendar/service.js";
import type * as integrations_calendar_types from "../integrations/calendar/types.js";
import type * as integrations_google_adapter from "../integrations/google/adapter.js";
import type * as integrations_google_mappers from "../integrations/google/mappers.js";
import type * as jobs_maintenance from "../jobs/maintenance.js";
import type * as lib_assistantLogic from "../lib/assistantLogic.js";
import type * as lib_calendars from "../lib/calendars.js";
import type * as lib_eventReads from "../lib/eventReads.js";
import type * as lib_google from "../lib/google.js";
import type * as lib_googleCredentials from "../lib/googleCredentials.js";
import type * as lib_notifications from "../lib/notifications.js";
import type * as maintenance from "../maintenance.js";
import type * as migrations_backfills from "../migrations/backfills.js";
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
  backfillConnections: typeof backfillConnections;
  booking: typeof booking;
  calendar: typeof calendar;
  calendarSync: typeof calendarSync;
  contacts: typeof contacts;
  crons: typeof crons;
  "domains/assistant/data": typeof domains_assistant_data;
  "domains/assistant/history": typeof domains_assistant_history;
  "domains/assistant/loop": typeof domains_assistant_loop;
  "domains/assistant/maintenance": typeof domains_assistant_maintenance;
  "domains/assistant/tables": typeof domains_assistant_tables;
  "domains/assistant/tools": typeof domains_assistant_tools;
  "domains/assistant/validators": typeof domains_assistant_validators;
  "domains/booking/model": typeof domains_booking_model;
  "domains/booking/mutations": typeof domains_booking_mutations;
  "domains/booking/queries": typeof domains_booking_queries;
  "domains/booking/service": typeof domains_booking_service;
  "domains/booking/tables": typeof domains_booking_tables;
  "domains/calendar/model": typeof domains_calendar_model;
  "domains/calendar/mutations": typeof domains_calendar_mutations;
  "domains/calendar/queries": typeof domains_calendar_queries;
  "domains/calendar/service": typeof domains_calendar_service;
  "domains/calendar/tables": typeof domains_calendar_tables;
  "domains/calendar/validators": typeof domains_calendar_validators;
  "domains/marketing/mutations": typeof domains_marketing_mutations;
  "domains/marketing/tables": typeof domains_marketing_tables;
  "domains/notifications/model": typeof domains_notifications_model;
  "domains/notifications/mutations": typeof domains_notifications_mutations;
  "domains/notifications/queries": typeof domains_notifications_queries;
  "domains/notifications/tables": typeof domains_notifications_tables;
  "domains/people/queries": typeof domains_people_queries;
  "domains/people/tables": typeof domains_people_tables;
  "domains/sync/engine": typeof domains_sync_engine;
  googleSync: typeof googleSync;
  healthCheck: typeof healthCheck;
  http: typeof http;
  "infrastructure/rateLimit": typeof infrastructure_rateLimit;
  "integrations/calendar/errors": typeof integrations_calendar_errors;
  "integrations/calendar/registry": typeof integrations_calendar_registry;
  "integrations/calendar/service": typeof integrations_calendar_service;
  "integrations/calendar/types": typeof integrations_calendar_types;
  "integrations/google/adapter": typeof integrations_google_adapter;
  "integrations/google/mappers": typeof integrations_google_mappers;
  "jobs/maintenance": typeof jobs_maintenance;
  "lib/assistantLogic": typeof lib_assistantLogic;
  "lib/calendars": typeof lib_calendars;
  "lib/eventReads": typeof lib_eventReads;
  "lib/google": typeof lib_google;
  "lib/googleCredentials": typeof lib_googleCredentials;
  "lib/notifications": typeof lib_notifications;
  maintenance: typeof maintenance;
  "migrations/backfills": typeof migrations_backfills;
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
