/** Stable public facade for the people directory. Logic lives in
 * `domains/people/`; this keeps `api.people.listPeople` fixed. */

import { query } from "./_generated/server";
import { listPeopleHandler } from "./domains/people/queries";

export const listPeople = query({
  args: {},
  handler: (ctx) => listPeopleHandler(ctx),
});
