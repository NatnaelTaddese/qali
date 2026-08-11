// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

process.env.SKIP_ENV_VALIDATION = "1";
const { ASSISTANT_TOOLS } = await import("./assistantTools");

function propertiesFor(name: string): Record<string, unknown> {
  const tool = ASSISTANT_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing assistant tool ${name}`);
  const properties = tool.parameters.properties;
  if (typeof properties !== "object" || properties === null) {
    throw new Error(`Missing properties for ${name}`);
  }
  return properties as Record<string, unknown>;
}

describe("assistant recurrence tool contract", () => {
  test("creation exposes structured repeat rather than raw recurrence lines", () => {
    const properties = propertiesFor("create_event");
    expect(properties.repeat).toBeDefined();
    expect(properties.recurrence).toBeUndefined();
  });

  test("updates can turn a one-off event into a structured repeat", () => {
    const properties = propertiesFor("update_event");
    expect(properties.repeat).toBeDefined();
    expect(properties.recurrence).toBeUndefined();
  });
});
