import { describe, expect, test } from "bun:test";
import { isLayoutModeInput, normalizeLayoutModeInput } from "./commandInputs";

describe("layout mode inputs", () => {
  test.each(["auto", "smart", "split", "unified", "stack"])(
    "accepts %s and normalizes legacy input",
    (value) => {
      expect(isLayoutModeInput(value)).toBe(true);
      if (!isLayoutModeInput(value)) throw new Error("Expected a supported layout input.");
      expect(normalizeLayoutModeInput(value)).toBe(value === "stack" ? "unified" : value);
    },
  );

  test.each([undefined, null, 3, "Smart", "", "bogus"])("rejects unsupported input %s", (value) => {
    expect(isLayoutModeInput(value)).toBe(false);
  });
});
