/** Stable public facade for contacts. Logic lives in `domains/people/`; this
 * keeps `api.contacts.listContacts` fixed. */

import { query } from "./_generated/server";
import { listContactsHandler } from "./domains/people/queries";

export const listContacts = query({
  args: {},
  handler: (ctx) => listContactsHandler(ctx),
});
