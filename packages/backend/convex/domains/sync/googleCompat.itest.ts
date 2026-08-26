/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
import schema from "../../schema";

import { modules } from "../../../testModules";

async function setupLegacySync(t: ReturnType<typeof convexTest>, userId: string) {
  await t.mutation(internal.googleSync.ensureSyncState, { userId });
  expect(
    await t.mutation(internal.googleSync.claimSyncLease, { userId }),
  ).not.toBeNull();
}

const contact = (resourceName: string, emails: string[]) => ({
  resourceName,
  deleted: false,
  emails,
  phones: [],
});

describe("pre-cutover Google contact compatibility", () => {
  test("releases changed and removed emails before replacing a saved contact", async () => {
    const t = convexTest(schema, modules);
    const userId = "compat-changed";
    await setupLegacySync(t, userId);

    await t.mutation(internal.googleSync.upsertContactsPage, {
      userId,
      contacts: [contact("people/one", ["old@example.com"])],
    });
    await t.mutation(internal.googleSync.upsertContactsPage, {
      userId,
      contacts: [contact("people/one", ["new@example.com"])],
    });
    await t.mutation(internal.googleSync.upsertContactsPage, {
      userId,
      contacts: [contact("people/one", [])],
    });

    const rows = await t.run(async (ctx) => ({
      contact: await ctx.db.query("contacts").unique(),
      people: await ctx.db.query("people").collect(),
      claims: await ctx.db.query("personSourceClaims").collect(),
    }));
    expect(rows.contact?.emails).toEqual([]);
    expect(rows.people).toEqual([]);
    expect(rows.claims).toEqual([]);
  });

  test("keeps an email claimed by a duplicate saved contact", async () => {
    const t = convexTest(schema, modules);
    const userId = "compat-duplicates";
    await setupLegacySync(t, userId);

    await t.mutation(internal.googleSync.upsertContactsPage, {
      userId,
      contacts: [
        contact("people/one", ["shared@example.com"]),
        contact("people/two", ["shared@example.com"]),
      ],
    });
    await t.mutation(internal.googleSync.upsertContactsPage, {
      userId,
      contacts: [contact("people/one", ["changed@example.com"])],
    });

    const rows = await t.run(async (ctx) => ({
      people: await ctx.db.query("people").collect(),
      claims: await ctx.db.query("personSourceClaims").collect(),
    }));
    expect(rows.people.map((row) => row.email).sort()).toEqual([
      "changed@example.com",
      "shared@example.com",
    ]);
    expect(
      rows.claims
        .map((row) => `${row.providerContactId}:${row.email}`)
        .sort(),
    ).toEqual([
      "people/one:changed@example.com",
      "people/two:shared@example.com",
    ]);
  });
});
