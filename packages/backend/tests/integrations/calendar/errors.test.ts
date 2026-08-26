// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import {
  ExternalWriteCommittedError,
  isDefinitiveProviderFailure,
  ProviderError,
} from "../../../convex/integrations/calendar/errors";

describe("provider-neutral failure semantics", () => {
  test("only conclusively rejected operations are definitive", () => {
    for (const kind of [
      "authentication",
      "permission",
      "validation",
      "not-found",
      "conflict",
      "cursor-expired",
    ] as const) {
      expect(isDefinitiveProviderFailure(new ProviderError(kind, kind))).toBe(true);
    }
    for (const kind of ["ambiguous", "transient", "rate-limited"] as const) {
      expect(isDefinitiveProviderFailure(new ProviderError(kind, kind))).toBe(false);
    }
    expect(isDefinitiveProviderFailure(new Error("unclassified"))).toBe(false);
  });

  test("external-write errors report success without naming a provider", () => {
    const error = new ExternalWriteCommittedError(
      "Event updated.",
      new Error("mirror unavailable"),
    );
    expect(error.successSummary).toBe("Event updated.");
    expect(error.message).toContain("calendar provider accepted");
    expect(error.message).not.toContain("Google");
  });
});
