import { defineSchema } from "convex/server";

import { assistantTables } from "./domains/assistant/tables";
import { bookingTables } from "./domains/booking/tables";
import {
  calendarConnectionTables,
  calendarOperationTables,
} from "./domains/calendar/connectionTables";
import { calendarTables } from "./domains/calendar/tables";
import { marketingTables } from "./domains/marketing/tables";
import { notificationTables } from "./domains/notifications/tables";
import { peopleTables } from "./domains/people/tables";
import { connectionSyncTables, syncTables } from "./domains/sync/tables";
import { infrastructureTables } from "./infrastructure/tables";

export default defineSchema({
  ...syncTables,
  ...calendarTables,
  ...bookingTables,
  ...notificationTables,
  ...infrastructureTables,
  ...peopleTables,
  ...assistantTables,
  ...marketingTables,
  ...calendarConnectionTables,
  ...connectionSyncTables,
  ...calendarOperationTables,
});
