// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import {
  newRowBudget,
  RANGE_DENSITY_LIMIT,
  RangeTooDenseError,
  spendRowBudget,
} from "../../convex/shared/eventReads";

describe("row budget", () => {
  test("depletes across successive reads and starts at the ceiling", () => {
    const budget = newRowBudget();
    expect(budget.remaining).toBe(RANGE_DENSITY_LIMIT);
    spendRowBudget(budget, 1000);
    spendRowBudget(budget, 4000);
    expect(budget.remaining).toBe(RANGE_DENSITY_LIMIT - 5000);
  });

  test("refuses the read that would exceed the ceiling", () => {
    const budget = newRowBudget();
    // A caller takes `remaining + 1`, so a page of that size proves the ceiling
    // was crossed and the whole range is rejected rather than silently truncated.
    expect(() => spendRowBudget(budget, RANGE_DENSITY_LIMIT + 1)).toThrow(
      RangeTooDenseError,
    );
  });

  test("spending exactly the remaining budget is allowed", () => {
    const budget = newRowBudget();
    spendRowBudget(budget, RANGE_DENSITY_LIMIT);
    expect(budget.remaining).toBe(0);
    // But one more row over any subsequent read now trips it.
    expect(() => spendRowBudget(budget, 1)).toThrow(RangeTooDenseError);
  });
});
