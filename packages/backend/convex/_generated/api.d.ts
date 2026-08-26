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
import type * as crons from "../crons.js";
import type * as domains_assistant_data from "../domains/assistant/data.js";
import type * as domains_assistant_eventLogic from "../domains/assistant/eventLogic.js";
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
import type * as domains_calendar_connectionTables from "../domains/calendar/connectionTables.js";
import type * as domains_calendar_connections from "../domains/calendar/connections.js";
import type * as domains_calendar_model from "../domains/calendar/model.js";
import type * as domains_calendar_mutations from "../domains/calendar/mutations.js";
import type * as domains_calendar_operationIdentity from "../domains/calendar/operationIdentity.js";
import type * as domains_calendar_queries from "../domains/calendar/queries.js";
import type * as domains_calendar_recurrence from "../domains/calendar/recurrence.js";
import type * as domains_calendar_service from "../domains/calendar/service.js";
import type * as domains_calendar_sharedPublicCalendars from "../domains/calendar/sharedPublicCalendars.js";
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
import type * as domains_sync_tables from "../domains/sync/tables.js";
import type * as healthCheck from "../healthCheck.js";
import type * as http from "../http.js";
import type * as infrastructure_rateLimit from "../infrastructure/rateLimit.js";
import type * as infrastructure_tables from "../infrastructure/tables.js";
import type * as integrations_calendar_contacts from "../integrations/calendar/contacts.js";
import type * as integrations_calendar_errors from "../integrations/calendar/errors.js";
import type * as integrations_calendar_registry from "../integrations/calendar/registry.js";
import type * as integrations_calendar_service from "../integrations/calendar/service.js";
import type * as integrations_calendar_types from "../integrations/calendar/types.js";
import type * as integrations_google_adapter from "../integrations/google/adapter.js";
import type * as integrations_google_client from "../integrations/google/client.js";
import type * as integrations_google_contactsAdapter from "../integrations/google/contactsAdapter.js";
import type * as integrations_google_credentials from "../integrations/google/credentials.js";
import type * as integrations_google_eventHelpers from "../integrations/google/eventHelpers.js";
import type * as integrations_google_holidays from "../integrations/google/holidays.js";
import type * as integrations_google_mappers from "../integrations/google/mappers.js";
import type * as jobs_maintenance from "../jobs/maintenance.js";
import type * as migrations_scheduledJobs from "../migrations/scheduledJobs.js";
import type * as shared_eventReads from "../shared/eventReads.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  crons: typeof crons;
  "domains/assistant/data": typeof domains_assistant_data;
  "domains/assistant/eventLogic": typeof domains_assistant_eventLogic;
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
  "domains/calendar/connectionTables": typeof domains_calendar_connectionTables;
  "domains/calendar/connections": typeof domains_calendar_connections;
  "domains/calendar/model": typeof domains_calendar_model;
  "domains/calendar/mutations": typeof domains_calendar_mutations;
  "domains/calendar/operationIdentity": typeof domains_calendar_operationIdentity;
  "domains/calendar/queries": typeof domains_calendar_queries;
  "domains/calendar/recurrence": typeof domains_calendar_recurrence;
  "domains/calendar/service": typeof domains_calendar_service;
  "domains/calendar/sharedPublicCalendars": typeof domains_calendar_sharedPublicCalendars;
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
  "domains/sync/tables": typeof domains_sync_tables;
  healthCheck: typeof healthCheck;
  http: typeof http;
  "infrastructure/rateLimit": typeof infrastructure_rateLimit;
  "infrastructure/tables": typeof infrastructure_tables;
  "integrations/calendar/contacts": typeof integrations_calendar_contacts;
  "integrations/calendar/errors": typeof integrations_calendar_errors;
  "integrations/calendar/registry": typeof integrations_calendar_registry;
  "integrations/calendar/service": typeof integrations_calendar_service;
  "integrations/calendar/types": typeof integrations_calendar_types;
  "integrations/google/adapter": typeof integrations_google_adapter;
  "integrations/google/client": typeof integrations_google_client;
  "integrations/google/contactsAdapter": typeof integrations_google_contactsAdapter;
  "integrations/google/credentials": typeof integrations_google_credentials;
  "integrations/google/eventHelpers": typeof integrations_google_eventHelpers;
  "integrations/google/holidays": typeof integrations_google_holidays;
  "integrations/google/mappers": typeof integrations_google_mappers;
  "jobs/maintenance": typeof jobs_maintenance;
  "migrations/scheduledJobs": typeof migrations_scheduledJobs;
  "shared/eventReads": typeof shared_eventReads;
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
