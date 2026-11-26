import { describe, expect, it } from "vitest";
import { installIdOf, stateWrittenElsewhere } from "../src/settings";

describe("stateWrittenElsewhere", () => {
  it("is true only for another install's valid id", () => {
    expect(stateWrittenElsewhere("AB12", "CD34")).toBe(true);
    expect(stateWrittenElsewhere("AB12", "AB12")).toBe(false);
  });

  it("stays quiet for data written before the mark existed, or a mangled one", () => {
    expect(stateWrittenElsewhere(undefined, "AB12")).toBe(false);
    expect(stateWrittenElsewhere("", "AB12")).toBe(false);
    expect(stateWrittenElsewhere("not-an-id", "AB12")).toBe(false);
    expect(stateWrittenElsewhere(42, "AB12")).toBe(false);
  });
});

describe("installIdOf", () => {
  it("makes an id once and returns the same one afterwards", () => {
    const store = new Map<string, unknown>();
    const app = {
      loadLocalStorage: (k: string) => store.get(k) ?? null,
      saveLocalStorage: (k: string, v: unknown) => void store.set(k, v),
    } as never;
    const id = installIdOf(app);
    expect(id).toMatch(/^[0-9A-Z]{4}$/);
    expect(installIdOf(app)).toBe(id);
  });
});
