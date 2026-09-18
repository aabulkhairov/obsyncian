import { describe, expect, it } from "vitest";
import { TELEGRAM_CODE_RE, clampSyncInterval, parseExcludes } from "../src/settings";

describe("TELEGRAM_CODE_RE", () => {
  // The whole point: these are the values that used to be pasted into the
  // email flow's "Login code" box, where they turned into a 400 about a
  // missing email param.
  it("matches the codes the bot issues", () => {
    for (const code of ["K3-482910", "1Q-123456", "A-000000", "ZZZZZZ-999999", "1q-123456"]) {
      expect(TELEGRAM_CODE_RE.test(code)).toBe(true);
    }
  });

  it("leaves a bare email code alone", () => {
    for (const code of ["123456", "", "12345", "1234567"]) {
      expect(TELEGRAM_CODE_RE.test(code)).toBe(false);
    }
  });

  it("rejects near-misses rather than hijacking the email flow", () => {
    for (const code of ["K3-48291", "K3-4829100", "-123456", "K3_482910", "K3-12345a", "K3-123456-7"]) {
      expect(TELEGRAM_CODE_RE.test(code)).toBe(false);
    }
  });
});

describe("clampSyncInterval", () => {
  it("clamps to the supported range and rounds", () => {
    expect(clampSyncInterval(5)).toBe(15);
    expect(clampSyncInterval(10_000)).toBe(3600);
    expect(clampSyncInterval(42.4)).toBe(42);
  });

  it("falls back to the default when given a non-number", () => {
    expect(clampSyncInterval(Number.NaN)).toBe(300);
  });
});

describe("parseExcludes", () => {
  it("splits on newlines and commas, trimming blanks", () => {
    expect(parseExcludes(" a, b\n\n c ,")).toEqual(["a", "b", "c"]);
    expect(parseExcludes("")).toEqual([]);
  });
});
