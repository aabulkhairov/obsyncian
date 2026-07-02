import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, withTimeout } from "../src/api";

describe("withTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects a request that never settles once the timeout elapses", async () => {
    const neverSettles = new Promise(() => {});
    const result = withTimeout(neverSettles, 10_000);
    const assertion = expect(result).rejects.toBeInstanceOf(ApiError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("resolves normally when the request beats the timeout", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 10_000)).resolves.toBe("ok");
  });

  it("propagates the original rejection when the request fails before the timeout", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 10_000)).rejects.toThrow("boom");
  });

  it("does not fire the timeout after the request already settled", async () => {
    await withTimeout(Promise.resolve("ok"), 10_000);
    // If the timer weren't cleared, this would blow up as an unhandled rejection.
    await vi.advanceTimersByTimeAsync(10_000);
  });
});
